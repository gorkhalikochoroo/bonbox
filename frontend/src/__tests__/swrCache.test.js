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

  it("the caller's own account key must match too (a second, independent check)", () => {
    signIn(OWNER_A);
    expect(writeDashboard(DAY, { summary: {} }, cacheGeneration(), Date.now(), "b|owner")).toBe(false);
    writeDashboard(DAY, { summary: { a: 1 } }, cacheGeneration(), Date.now(), "a|owner");
    expect(readDashboard(DAY, Date.now(), "b|owner")).toBeNull();
    expect(readDashboard(DAY, Date.now(), "a|owner").data.summary.a).toBe(1);
  });

  it("AuthProvider names the account during its render, before any child renders", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "useAuth.jsx"), "utf8");
    expect(src).toMatch(/\n  setCacheAccount\(cacheKey\);\n/);
    expect(src).not.toMatch(/useEffect\(\(\) => \{ setCacheAccount/);
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

  it("the Stock page's reorder plan (a read sent as a POST) keeps it; sending the order does not", () => {
    // rev-1, 16 Oct: /inventory/autopilot/suggest is read-only (an audit line
    // only) but emptied the copy on every visit to Lager.
    signIn(OWNER_A);
    writeDashboard(DAY, { summary: {} }, cacheGeneration());
    noteWrite("/inventory/autopilot/suggest");
    expect(readDashboard(DAY)).not.toBeNull();
    noteWrite("/inventory/autopilot/apply");
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

  it("keeps Home's close list, keyed by its window (rev-1/rev-2, 16 Oct)", () => {
    signIn(OWNER_A);
    const rows = [{ date: "2026-10-15", status: "confirmed", revenue_total: 20653 }];
    rememberGet("/daily-close", { from: "2026-10-15", to: "2026-10-16" }, rows, cacheGeneration());
    expect(peekGet("/daily-close", { to: "2026-10-16", from: "2026-10-15" })).toEqual(rows);
    // Another day's window is another request: no copy.
    expect(peekGet("/daily-close", { from: "2026-10-16", to: "2026-10-17" })).toBeUndefined();
    // Not one close (a sub-path), and gone after any write.
    rememberGet("/daily-close/abc", undefined, { id: "abc" }, cacheGeneration());
    expect(peekGet("/daily-close/abc")).toBeUndefined();
    noteWrite("/daily-close");
    expect(peekGet("/daily-close", { from: "2026-10-15", to: "2026-10-16" })).toBeUndefined();
  });

  it("params order does not matter, and an empty params object equals none", () => {
    signIn(OWNER_A);
    rememberGet("/demo/status", { scope: "has_demo", b: 1 }, { has_demo: true }, cacheGeneration());
    expect(peekGet("/demo/status", { b: 1, scope: "has_demo" })).toEqual({ has_demo: true });
    rememberGet("/staff/today", {}, { shifts: [] }, cacheGeneration());
    expect(peekGet("/staff/today")).toEqual({ shifts: [] });
  });
});
