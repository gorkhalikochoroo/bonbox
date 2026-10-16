/**
 * lib/swrCache — Home's in-memory copy (K, speed push 15 Oct).
 *
 * The rules that make "instant back to Home" safe:
 *   • one account at a time — a different account (or none) empties it;
 *   • owners only — never an invited seat or a revisor login;
 *   • never on a shared device, nor before the device is known;
 *   • any write (bar telemetry), the freshness bus, or a new business day
 *     means the copy is not drawn;
 *   • an answer requested before a throw-away is never stored after it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetSwrCacheForTests,
  accountKeyFor,
  cacheGeneration,
  invalidateCache,
  MAX_AGE_MS,
  noteWrite,
  peekGet,
  readDashboard,
  rememberGet,
  setCacheAccount,
  setSharedDevice,
  writeDashboard,
} from "../lib/swrCache";

const OWNER_A = { id: "a", role: "owner" };
const OWNER_B = { id: "b", role: "owner" };
const DAY = "2026-10-16";

function signIn(user) {
  setCacheAccount(accountKeyFor(user));
  setSharedDevice(false);
}

beforeEach(() => __resetSwrCacheForTests());

describe("who may have a copy", () => {
  it("owners and super admins get a key; seats and revisors do not", () => {
    expect(accountKeyFor(OWNER_A)).toBe("a|owner");
    expect(accountKeyFor({ id: "s", role: "super_admin" })).toBe("s|super_admin");
    expect(accountKeyFor({ id: "x" })).toBe("x|owner");
    for (const role of ["manager", "cashier", "viewer", "accountant", "Manager"]) {
      expect(accountKeyFor({ id: "m", role })).toBeNull();
    }
    expect(accountKeyFor(null)).toBeNull();
  });

  it("stores and draws nothing until the device is known not to be shared", () => {
    setCacheAccount(accountKeyFor(OWNER_A)); // device still unknown
    expect(writeDashboard(DAY, { summary: { month_revenue: 1 } }, cacheGeneration())).toBe(false);
    setSharedDevice(false);
    expect(readDashboard(DAY)).toBeNull();
    expect(writeDashboard(DAY, { summary: { month_revenue: 1 } }, cacheGeneration())).toBe(true);
    expect(readDashboard(DAY).data.summary.month_revenue).toBe(1);
  });

  it("a shared device gets no copy, and turning sharing on empties the one there was", () => {
    signIn(OWNER_A);
    writeDashboard(DAY, { summary: { month_revenue: 9 } }, cacheGeneration());
    setSharedDevice(true);
    expect(readDashboard(DAY)).toBeNull();
    setSharedDevice(false);
    expect(readDashboard(DAY)).toBeNull(); // thrown away, not merely hidden
  });
});

describe("never another account's figures", () => {
  it("a different account empties the copy before anything is drawn", () => {
    signIn(OWNER_A);
    writeDashboard(DAY, { summary: { month_revenue: 111 } }, cacheGeneration());
    rememberGet("/staff/today", undefined, { shifts: [1] }, cacheGeneration());
    signIn(OWNER_B);
    expect(readDashboard(DAY)).toBeNull();
    expect(peekGet("/staff/today")).toBeUndefined();
  });

  it("sign-out empties it", () => {
    signIn(OWNER_A);
    writeDashboard(DAY, { summary: {} }, cacheGeneration());
    setCacheAccount(null);
    expect(readDashboard(DAY)).toBeNull();
    signIn(OWNER_A);
    expect(readDashboard(DAY)).toBeNull();
  });

  it("a seat signing in on the same device gets nothing", () => {
    signIn(OWNER_A);
    writeDashboard(DAY, { summary: {} }, cacheGeneration());
    setCacheAccount(accountKeyFor({ id: "a", role: "cashier" }));
    expect(readDashboard(DAY)).toBeNull();
  });
});

describe("when the copy is not the truth any more", () => {
  it("any write throws it away; telemetry pings do not", () => {
    signIn(OWNER_A);
    writeDashboard(DAY, { summary: {} }, cacheGeneration());
    noteWrite("/event-log/batch");
    noteWrite("/diagnostics/client-error");
    expect(readDashboard(DAY)).not.toBeNull();
    noteWrite("/expenses");
    expect(readDashboard(DAY)).toBeNull();
  });

  it("the freshness bus throws it away", () => {
    signIn(OWNER_A);
    writeDashboard(DAY, { summary: {} }, cacheGeneration());
    window.dispatchEvent(new Event("bonbox-data-changed"));
    expect(readDashboard(DAY)).toBeNull();
  });

  it("an answer requested before a write is not stored after it", () => {
    signIn(OWNER_A);
    const before = cacheGeneration();
    noteWrite("/daily-close");
    expect(writeDashboard(DAY, { summary: { stale: true } }, before)).toBe(false);
    rememberGet("/staff/today", undefined, { shifts: ["stale"] }, before);
    expect(readDashboard(DAY)).toBeNull();
    expect(peekGet("/staff/today")).toBeUndefined();
  });

  it("another business day, or older than the max age, is not drawn", () => {
    signIn(OWNER_A);
    const t0 = 1_000_000;
    writeDashboard(DAY, { summary: {} }, cacheGeneration(), t0);
    expect(readDashboard("2026-10-17", t0 + 1000)).toBeNull();
    expect(readDashboard(DAY, t0 + MAX_AGE_MS - 1)).not.toBeNull();
    expect(readDashboard(DAY, t0 + MAX_AGE_MS + 1)).toBeNull();
  });

  it("invalidateCache (a 401) empties everything", () => {
    signIn(OWNER_A);
    writeDashboard(DAY, { summary: {} }, cacheGeneration());
    invalidateCache();
    expect(readDashboard(DAY)).toBeNull();
  });
});

describe("the cards' GETs", () => {
  it("keeps only the allow-listed read paths, keyed by their params", () => {
    signIn(OWNER_A);
    const g = cacheGeneration();
    rememberGet("/diagnostics/needs-you", { skip: "x" }, { findings: [1] }, g);
    rememberGet("/sales", undefined, [1, 2, 3], g);
    expect(peekGet("/diagnostics/needs-you", { skip: "x" })).toEqual({ findings: [1] });
    expect(peekGet("/diagnostics/needs-you", {})).toBeUndefined();
    expect(peekGet("/sales")).toBeUndefined();
  });

  it("params order does not matter, and an empty params object equals none", () => {
    signIn(OWNER_A);
    rememberGet("/demo/status", { scope: "has_demo", b: 1 }, { has_demo: true }, cacheGeneration());
    expect(peekGet("/demo/status", { b: 1, scope: "has_demo" })).toEqual({ has_demo: true });
    rememberGet("/staff/today", {}, { shifts: [] }, cacheGeneration());
    expect(peekGet("/staff/today")).toEqual({ shifts: [] });
  });
});
