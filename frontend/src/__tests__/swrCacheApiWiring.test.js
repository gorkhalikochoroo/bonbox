/**
 * Home's in-memory copy (lib/swrCache, K — speed push 15 Oct) through the real
 * API client: an allow-listed GET's answer is remembered for Home's cards; a
 * successful write throws the whole copy away; a telemetry ping does not.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import api from "../services/api";
import {
  __resetSwrCacheForTests,
  accountKeyFor,
  cacheGeneration,
  peekGet,
  readDashboard,
  setCacheAccount,
  setSharedDevice,
  writeDashboard,
} from "../lib/swrCache";

const realAdapter = api.defaults.adapter;

beforeEach(() => {
  api.defaults.adapter = (config) =>
    Promise.resolve({ data: { ok: true, findings: ["x"] }, status: 200, statusText: "OK", headers: {}, config });
  __resetSwrCacheForTests();
});

afterEach(() => {
  api.defaults.adapter = realAdapter;
});

describe("Home's in-memory copy (lib/swrCache) through the API client", () => {
  const signIn = () => { setCacheAccount(accountKeyFor({ id: "o1", role: "owner" })); setSharedDevice(false); };

  it("remembers an allow-listed GET's answer", async () => {
    signIn();
    await api.get("/diagnostics/needs-you", { params: {} });
    expect(peekGet("/diagnostics/needs-you", {})).toEqual({ ok: true, findings: ["x"] });
  });

  it("a successful write throws the copy away", async () => {
    signIn();
    writeDashboard("2026-10-16", { summary: {} }, cacheGeneration());
    await api.get("/staff/today");
    await api.post("/expenses", { amount: 5 });
    expect(readDashboard("2026-10-16")).toBeNull();
    expect(peekGet("/staff/today")).toBeUndefined();
  });

  it("a telemetry ping does not", async () => {
    signIn();
    writeDashboard("2026-10-16", { summary: {} }, cacheGeneration());
    await api.post("/event-log/batch", { events: [] });
    expect(readDashboard("2026-10-16")).not.toBeNull();
  });
});
