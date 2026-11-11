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

import { nextShiftChip, nextShiftCountdown } from "../utils/nextShiftCountdown";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";

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

// The home card's chip, in the owner's canvas words — read from the REAL
// da/en dictionaries, so a reworded key is caught here.
const dict = (table) => (key, vars) => {
  let out = table[key] ?? key;
  for (const [k, v] of Object.entries(vars || {})) out = out.replaceAll(`{${k}}`, v);
  return out;
};
const tda = dict(da);
const ten = dict(en);

describe("nextShiftChip (canvas copy)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("today, later: 'I dag · om 6 t 27 min' — lower-case 'om' mid-chip", () => {
    expect(nextShiftChip(shiftAt("2026-08-03T15:27"), tda, { today: true })).toBe("I dag · om 6 t 27 min");
    // English in the home's one chip style, as "In 6h 27m" beside it.
    expect(nextShiftChip(shiftAt("2026-08-03T15:27"), ten, { today: true })).toBe("Today · in 6h 27m");
  });

  it("under an hour away: 'Starter om 12 min' (the Stempl ind state), today or not", () => {
    expect(nextShiftChip(shiftAt("2026-08-03T09:12"), tda, { today: true })).toBe("Starter om 12 min");
    expect(nextShiftChip(shiftAt("2026-08-03T09:12"), ten, { today: true })).toBe("Starts in 12 min");
    expect(nextShiftChip(shiftAt("2026-08-03T09:59"), tda, { today: true })).toBe("Starter om 59 min");
  });

  it("never says 'om 0 min': the last minute rounds up", () => {
    vi.setSystemTime(new Date("2026-08-03T08:59:30"));
    expect(nextShiftChip(shiftAt("2026-08-03T09:00"), tda, { today: true })).toBe("Starter om 1 min");
  });

  it("today, started: 'I dag · i gang'", () => {
    expect(nextShiftChip(shiftAt("2026-08-03T08:00"), tda, { today: true })).toBe("I dag · i gang");
    expect(nextShiftChip(shiftAt("2026-08-03T08:00"), ten, { today: true })).toBe("Today · on now");
  });

  it("another day keeps the countdown first, then the date", () => {
    expect(nextShiftChip(shiftAt("2026-08-06T16:00"), tda, { today: false, dateLabel: "tor. 6. aug." }))
      .toBe("Om 3 dage · tor. 6. aug.");
  });

  it("no shift / an unreadable date: nothing", () => {
    expect(nextShiftChip(null, tda)).toBeNull();
    expect(nextShiftChip({ date: "x", start_time: "10:00" }, tda)).toBeNull();
  });
});
