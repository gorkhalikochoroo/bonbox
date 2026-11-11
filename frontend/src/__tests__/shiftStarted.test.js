/**
 * Byt pickers (Android walk, 11 Nov 2026): a shift that has started — or is
 * being worked — is never offered for a swap or a give-away. Pure rules,
 * with `now` passed in.
 */
import { describe, expect, it } from "vitest";
import { shiftHasStarted, pickableOwnShifts } from "../utils/shiftStarted";

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0);

describe("shiftHasStarted", () => {
  it("today 13:00 has not started at 12:59, has at 13:00 and after", () => {
    const s = { date: "2026-11-11", start_time: "13:00", end_time: "19:00" };
    expect(shiftHasStarted(s, at(2026, 11, 11, 12, 59))).toBe(false);
    expect(shiftHasStarted(s, at(2026, 11, 11, 13, 0))).toBe(true);
    expect(shiftHasStarted(s, at(2026, 11, 11, 14, 0))).toBe(true);
  });

  it("last night's 22:00–06:00 has started at 01:00 the next day", () => {
    expect(shiftHasStarted({ date: "2026-11-10", start_time: "22:00", end_time: "06:00" }, at(2026, 11, 11, 1, 0))).toBe(true);
  });

  it("tomorrow 10:00 has not started; HH:MM:SS start times read the same", () => {
    expect(shiftHasStarted({ date: "2026-11-12", start_time: "10:00" }, at(2026, 11, 11, 23, 59))).toBe(false);
    expect(shiftHasStarted({ date: "2026-11-11", start_time: "09:30:00" }, at(2026, 11, 11, 9, 30))).toBe(true);
  });

  it("no start time: only a past day has started", () => {
    expect(shiftHasStarted({ date: "2026-11-10" }, at(2026, 11, 11, 0, 5))).toBe(true);
    expect(shiftHasStarted({ date: "2026-11-11" }, at(2026, 11, 11, 23, 0))).toBe(false);
  });

  it("an unreadable date is never hidden on a guess", () => {
    expect(shiftHasStarted({ date: "", start_time: "10:00" }, at(2026, 11, 11, 12))).toBe(false);
    expect(shiftHasStarted({ date: "soon", start_time: "10:00" }, at(2026, 11, 11, 12))).toBe(false);
    expect(shiftHasStarted(null, at(2026, 11, 11, 12))).toBe(false);
  });
});

describe("pickableOwnShifts", () => {
  const now = at(2026, 11, 11, 12, 58);
  const shifts = [
    { id: 7, date: "2026-11-11", start_time: "13:00", end_time: "19:00" },     // the live one (early clock-in)
    { id: "night", date: "2026-11-10", start_time: "22:00", end_time: "06:00" },
    { id: "eve", date: "2026-11-11", start_time: "19:30", end_time: "23:00" },
    { id: "nodate", start_time: "10:00" },
    { id: "tmrw", date: "2026-11-12", start_time: "10:00", end_time: "16:00" },
  ];

  it("drops started shifts, a missing date and the shift being worked (string or number id); keeps order", () => {
    expect(pickableOwnShifts(shifts, { now }).map((s) => s.id)).toEqual([7, "eve", "tmrw"]);
    expect(pickableOwnShifts(shifts, { now, liveShiftId: "7" }).map((s) => s.id)).toEqual(["eve", "tmrw"]);
    expect(pickableOwnShifts(shifts, { now, liveShiftId: 7 }).map((s) => s.id)).toEqual(["eve", "tmrw"]);
  });

  it("no shifts is an empty list", () => {
    expect(pickableOwnShifts(null, { now })).toEqual([]);
    expect(pickableOwnShifts(undefined)).toEqual([]);
  });
});
