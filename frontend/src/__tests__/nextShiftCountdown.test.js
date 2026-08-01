/**
 * The next-shift countdown.
 *
 * This chip answers the only question the Schedule screen exists to answer, so
 * the bug that mattered was silence: it returned null past ~24h, meaning a
 * staffer opening the app on Monday for a Wednesday shift got nothing. The date
 * was on screen, but a date is arithmetic they have to do.
 *
 * The tests pin the boundaries, because an off-by-one here tells someone the
 * wrong day about their own working week.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextShiftCountdown } from "../utils/nextShiftCountdown";

// Mirrors the real t(): returns the template with {vars} substituted, so the
// assertions read the shipped copy rather than a key.
const t = (key, vars) => {
  const copy = {
    portalCountdownNow: "Now",
    portalCountdownSoonMin: "In {m}min",
    portalCountdownIn: "In {h}h {m}min",
    portalCountdownTomorrow: "Tomorrow",
    portalCountdownDays: "In {d} days",
  }[key] || key;
  let out = copy;
  for (const [k, v] of Object.entries(vars || {})) out = out.replaceAll(`{${k}}`, v);
  return out;
};

// A fixed "now" so the boundaries are exact rather than racing the clock.
const NOW = new Date("2026-08-03T09:00:00");
const shiftAt = (iso) => {
  const [date, time] = iso.split("T");
  return { date, start_time: time.slice(0, 5) };
};

describe("nextShiftCountdown", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("says nothing when there is no shift", () => {
    expect(nextShiftCountdown(null, t)).toBeNull();
    expect(nextShiftCountdown(undefined, t)).toBeNull();
  });

  it("says nothing for an unparseable date rather than guessing", () => {
    expect(nextShiftCountdown({ date: "not-a-date", start_time: "16:00" }, t)).toBeNull();
  });

  it("reads 'Now' once the shift has started", () => {
    expect(nextShiftCountdown(shiftAt("2026-08-03T09:00"), t)).toBe("Now");
    expect(nextShiftCountdown(shiftAt("2026-08-03T08:00"), t)).toBe("Now");
  });

  it("counts minutes under the hour", () => {
    expect(nextShiftCountdown(shiftAt("2026-08-03T09:45"), t)).toBe("In 45min");
  });

  it("counts hours and minutes under a day", () => {
    expect(nextShiftCountdown(shiftAt("2026-08-03T16:30"), t)).toBe("In 7h 30min");
  });

  it("still answers past 24 hours — the whole point of the change", () => {
    // Previously null: the staffer saw an empty space where the answer belongs.
    expect(nextShiftCountdown(shiftAt("2026-08-06T16:00"), t)).toBe("In 3 days");
  });

  it("says 'Tomorrow' rather than 'In 1 days'", () => {
    expect(nextShiftCountdown(shiftAt("2026-08-04T12:00"), t)).toBe("Tomorrow");
  });

  it("holds the 24-hour boundary exactly", () => {
    // 23h59m is still hours; 24h00m becomes a day. An off-by-one here tells
    // someone the wrong day about their own week.
    expect(nextShiftCountdown(shiftAt("2026-08-04T08:59"), t)).toBe("In 23h 59min");
    expect(nextShiftCountdown(shiftAt("2026-08-04T09:00"), t)).toBe("Tomorrow");
  });

  it("holds the 48-hour boundary exactly", () => {
    expect(nextShiftCountdown(shiftAt("2026-08-05T08:59"), t)).toBe("Tomorrow");
    expect(nextShiftCountdown(shiftAt("2026-08-05T09:00"), t)).toBe("In 2 days");
  });

  it("drops hours once nothing is imminent", () => {
    // "In 6 days 4h" is noise when the useful fact is "not soon".
    const out = nextShiftCountdown(shiftAt("2026-08-09T13:00"), t);
    expect(out).toBe("In 6 days");
    expect(out).not.toMatch(/h\b/);
  });

  it("defaults a missing start time to midnight rather than failing", () => {
    expect(nextShiftCountdown({ date: "2026-08-05" }, t)).toBe("Tomorrow");
  });
});
