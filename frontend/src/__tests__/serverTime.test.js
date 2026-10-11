/**
 * parseServerTime — a naive server stamp is UTC, read on a Danish clock.
 *
 * Live defect (11 Oct): the admin list said "Last seen 2h ago" for an account
 * signed in a minute earlier. The backend sends naive UTC
 * ("2026-10-11T08:14:03.123456"); new Date() read it as LOCAL time, 2 h behind
 * in CEST. These tests run in Europe/Copenhagen and prove they did (a test that
 * ran in UTC would pass with or without the fix).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import process from "node:process";
import { parseServerTime } from "../utils/serverTime";

const PREV_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = "Europe/Copenhagen"; });
afterAll(() => {
  if (PREV_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREV_TZ;
});

describe("the test clock is Danish", () => {
  it("is CEST in October before the switch and CET after it", () => {
    expect(new Date(2026, 9, 11, 12).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 11, 1, 12).getTimezoneOffset()).toBe(-60);
  });
});

describe("parseServerTime", () => {
  it("reads an offset-less date-time as UTC — 08:14 UTC is 10:14 in CEST", () => {
    const d = parseServerTime("2026-10-11T08:14:03.123456");
    expect(d.toISOString()).toBe("2026-10-11T08:14:03.123Z");
    expect(d.getHours()).toBe(10);
    // The bug it replaces: the same string read as local is 2 h earlier.
    expect(new Date("2026-10-11T08:14:03.123456").getTime() - d.getTime()).toBe(-2 * 3600_000);
  });

  it("is 1 h in winter (CET), not a fixed 2 h shift", () => {
    expect(parseServerTime("2026-12-01T08:00:00").getHours()).toBe(9);
  });

  it("accepts a space separator and minute precision", () => {
    expect(parseServerTime("2026-10-11 08:14:03").toISOString()).toBe("2026-10-11T08:14:03.000Z");
    expect(parseServerTime("2026-10-11T08:14").toISOString()).toBe("2026-10-11T08:14:00.000Z");
  });

  it("leaves a string that states its zone exactly as it is", () => {
    for (const s of [
      "2026-10-11T08:14:03Z",
      "2026-10-11T08:14:03.5z",
      "2026-10-11T10:14:03+02:00",
      "2026-10-11T10:14:03+0200",
      "2026-10-11T03:14:03-05:00",
    ]) {
      expect(parseServerTime(s).getTime()).toBe(new Date(s).getTime());
    }
    expect(parseServerTime("2026-10-11T10:14:03+02:00").toISOString()).toBe("2026-10-11T08:14:03.000Z");
  });

  it("leaves a date-only string alone (a day, not an instant)", () => {
    expect(parseServerTime("2026-10-11").getTime()).toBe(new Date("2026-10-11").getTime());
  });

  it("is null-safe and never returns an Invalid Date", () => {
    for (const v of [null, undefined, "", "   ", "garbage", "2026-13-45T99:99:99", {}, NaN, new Date("x")]) {
      expect(parseServerTime(v)).toBeNull();
    }
  });

  it("passes a Date or an epoch through", () => {
    const d = new Date("2026-10-11T08:14:03Z");
    expect(parseServerTime(d)).toBe(d);
    expect(parseServerTime(d.getTime()).getTime()).toBe(d.getTime());
  });

  it("a stamp written a minute ago is a minute ago", () => {
    const naiveUtcMinuteAgo = new Date(Date.now() - 60_000).toISOString().replace("Z", "");
    const ageMs = Date.now() - parseServerTime(naiveUtcMinuteAgo).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(59_000);
    expect(ageMs).toBeLessThan(65_000);
  });
});
