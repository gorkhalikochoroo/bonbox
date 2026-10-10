/**
 * R-c round 2 fix-up (review, attacker lens) — a request belongs to the
 * session it was first sent on.
 *
 *  1. axios re-sends a request that met a 503 after a back-off (2, 4, 8,
 *     12 s), and the request interceptor attached whatever token was stored
 *     THEN: owner A's queued close, retried after A signed out and B signed
 *     in, went with B's credential (into B's books). A retry now goes on the
 *     credential the request was first sent with, or not at all.
 *  2. A late answer to A's request carrying X-New-Token (the sliding
 *     refresh) was written over B's stored token: every later request went
 *     as A. It is now adopted only while the session it answers is the one
 *     stored.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxiosError } from "axios";

import api, { tokenSubject } from "../services/api";

const tok = (sub, n = 1) => {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, n })}.signature-${n}`;
};
const sent = [];
let reply = null;
const origAdapter = api.defaults.adapter;

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  api.defaults.adapter = async (config) => {
    const auth = config.headers?.get ? config.headers.get("Authorization") : config.headers?.Authorization;
    sent.push({ url: config.url, auth: auth || null, data: config.data ? JSON.parse(config.data) : null });
    return reply(config, sent.length);
  };
});
afterEach(() => {
  api.defaults.adapter = origAdapter;
  localStorage.clear();
});

const ok = (config, headers = {}) => ({ data: { ok: true }, status: 200, statusText: "OK", headers, config, request: {} });
const unavailable = (config) => {
  const response = { data: { detail: "cold start" }, status: 503, statusText: "Service Unavailable", headers: {}, config, request: {} };
  throw new AxiosError("Request failed with status code 503", "ERR_BAD_RESPONSE", config, {}, response);
};

describe("a retry goes on the credential the request was first sent with", () => {
  it("A's close met a 503, B signed in during the back-off: it is never sent again on B's token", async () => {
    const A = tok("user-a");
    const B = tok("user-b");
    localStorage.setItem("token", A);
    reply = (config, n) => {
      if (n === 1) { localStorage.setItem("token", B); return unavailable(config); }
      return ok(config);
    };
    await expect(api.post("/daily-close", { date: "2026-10-09", revenue_breakdown: { food: 5000 } })).rejects.toMatchObject({ response: { status: 503 } });
    expect(sent.map((s) => s.auth)).toEqual([`Bearer ${A}`]);
  }, 10000);

  it("the same account's token refreshed meanwhile: retried as before", async () => {
    const A1 = tok("user-a", 1);
    const A2 = tok("user-a", 2);
    localStorage.setItem("token", A1);
    reply = (config, n) => {
      if (n === 1) { localStorage.setItem("token", A2); return unavailable(config); }
      return ok(config);
    };
    const res = await api.post("/daily-close", { date: "2026-10-09" });
    expect(res.status).toBe(200);
    expect(sent.map((s) => s.auth)).toEqual([`Bearer ${A1}`, `Bearer ${A2}`]);
  }, 10000);

  it("tokenSubject tells accounts apart and reads no token as a cookie session", () => {
    expect(tokenSubject(tok("u1", 1))).toBe(tokenSubject(tok("u1", 2)));
    expect(tokenSubject(tok("u1"))).not.toBe(tokenSubject(tok("u2")));
    expect(tokenSubject(null)).toBeNull();
    expect(tokenSubject("not-a-jwt")).toBe("not-a-jwt");
  });
});

describe("X-New-Token is adopted only for the session still stored", () => {
  it("a late answer to A's request does not sign the phone in as A over B", async () => {
    const A = tok("user-a");
    const B = tok("user-b");
    const refreshedA = `${tok("user-a", 9)}-refreshed`;
    localStorage.setItem("token", A);
    let release;
    const gate = new Promise((r) => { release = r; });
    reply = async (config) => { await gate; return ok(config, { "x-new-token": refreshedA }); };
    const pending = api.get("/dashboard");
    await new Promise((r) => setTimeout(r, 0));
    localStorage.setItem("token", B);   // A signed out, B signed in
    release();
    await pending;
    expect(localStorage.getItem("token")).toBe(B);
  });

  it("the stored session's own refresh is adopted as before", async () => {
    const A = tok("user-a");
    const refreshedA = `${tok("user-a", 9)}-refreshed`;
    localStorage.setItem("token", A);
    reply = (config) => ok(config, { "x-new-token": refreshedA });
    await api.get("/dashboard");
    expect(localStorage.getItem("token")).toBe(refreshedA);
  });
});
