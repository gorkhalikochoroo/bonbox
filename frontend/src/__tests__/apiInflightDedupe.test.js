/**
 * B (speed push, 15 Oct): identical reads in flight are sent once.
 *
 * Home's cards ask some of the same questions at the same moment — /business
 * from tonight's-close check AND the connections card, /email/preferences from
 * the brief AND the connections card. The second caller now joins the request
 * already on its way. Pinned: one network request, every caller answered,
 * each with its own copy (a caller that edits its answer cannot change
 * another's), and nothing shared across time, params, credentials, writes or
 * non-JSON reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import api from "../services/api";

let sent = [];
let release = [];
const realAdapter = api.defaults.adapter;

beforeEach(() => {
  sent = [];
  release = [];
  api.defaults.adapter = (config) => {
    sent.push(`${config.method} ${config.url} ${JSON.stringify(config.params || {})}`);
    return new Promise((resolve) => {
      release.push(() => resolve({
        data: { shifts: [{ start_time: "18:00" }, { start_time: "10:00" }], n: sent.length },
        status: 200, statusText: "OK", headers: {}, config,
      }));
    });
  };
  localStorage.removeItem("token");
});

afterEach(() => {
  api.defaults.adapter = realAdapter;
  localStorage.removeItem("token");
});

// Axios runs its request interceptors asynchronously: the adapter (the
// "network") is reached a few microtasks after the call.
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { await tick(); release.splice(0).forEach((fn) => fn()); };

describe("identical GETs in flight", () => {
  it("are sent once, and every caller is answered", async () => {
    const a = api.get("/business");
    const b = api.get("/business");
    const c = api.get("/business");
    await tick();
    expect(sent).toEqual(["get /business {}"]);
    await flush();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.status).toBe(200);
    expect(rb.data).toEqual(ra.data);
    expect(rc.data).toEqual(ra.data);
  });

  it("each caller gets its own copy — editing one answer changes no other", async () => {
    const first = api.get("/staff/today").then((res) => {
      res.data.shifts.sort((x, y) => x.start_time.localeCompare(y.start_time)); // in place
      res.data.shifts.push({ start_time: "mine" });
      return res;
    });
    const joiner = api.get("/staff/today");
    await flush();
    const [f, j] = await Promise.all([first, joiner]);
    expect(f.data.shifts).toHaveLength(3);
    expect(j.data.shifts.map((s) => s.start_time)).toEqual(["18:00", "10:00"]);
  });

  it("the next call after the answer asks the server again (not a cache)", async () => {
    const a = api.get("/business");
    await flush();
    await a;
    const b = api.get("/business");
    await tick();
    expect(sent).toHaveLength(2);
    await flush();
    await b;
  });

  it("different params, a blob, custom headers or a write are never joined", async () => {
    const calls = [
      api.get("/daily-close", { params: { from: "2026-10-15" } }),
      api.get("/daily-close", { params: { from: "2026-10-16" } }),
      api.get("/reports/monthly/pdf", { responseType: "blob" }),
      api.get("/reports/monthly/pdf", { responseType: "blob" }),
      api.get("/business", { headers: { "X-Probe": "1" } }),
      api.get("/business", { headers: { "X-Probe": "1" } }),
      api.post("/sales", { amount: 1 }),
      api.post("/sales", { amount: 1 }),
    ];
    await tick();
    expect(sent).toHaveLength(8);
    await flush();
    await Promise.all(calls);
  });

  it("params that are not a plain object, or that differ only in type, are never joined", async () => {
    const calls = [
      api.get("/daily-close", { params: new URLSearchParams({ from: "a" }) }),
      api.get("/daily-close", { params: new URLSearchParams({ from: "b" }) }),
      api.get("/x", { params: { ids: [1, 2] } }),
      api.get("/x", { params: { ids: ["1,2"] } }),
    ];
    await tick();
    expect(sent).toHaveLength(4);
    await flush();
    await Promise.all(calls);
  });

  it("a different signed-in credential is never joined", async () => {
    localStorage.setItem("token", "aaa.eyJzdWIiOiJvd25lci1hIn0.sig");
    const a = api.get("/business");
    localStorage.setItem("token", "aaa.eyJzdWIiOiJvd25lci1iIn0.sig");
    const b = api.get("/business");
    await tick();
    expect(sent).toHaveLength(2);
    await flush();
    await Promise.all([a, b]);
  });

  it("a failure reaches every caller", async () => {
    api.defaults.adapter = () => Promise.reject(Object.assign(new Error("nope"), { response: { status: 404 } }));
    const a = api.get("/business", { _noRetry: true });
    const b = api.get("/business", { _noRetry: true });
    await expect(a).rejects.toThrow("nope");
    await expect(b).rejects.toThrow("nope");
  });
});
