/**
 * The shift sheet's pre-save rule checks. Mirrors of the server's rules
 * (routers/staff.py::_daily_rest_shortfalls and week-load's 48h / cap), so
 * the cases are the backend's own: tests/test_schedule_owner_review.py.
 */
import { describe, expect, it } from "vitest";
import {
  minutesToDayTime,
  netHours,
  preSaveWarnings,
  restShortfalls,
  shiftSpan,
} from "../utils/shiftRules";

const MON = "2026-06-01";
const TUE = "2026-06-02";

describe("restShortfalls — 11 consecutive hours in each 24-hour period", () => {
  it("lets a split day through (11–15 + 17–22 rests 22 → 11)", () => {
    const spans = [
      shiftSpan(MON, "11:00", "15:00"),
      shiftSpan(MON, "17:00", "22:00"),
      shiftSpan(TUE, "11:00", "15:00"),
    ];
    expect(restShortfalls(spans)).toEqual([]);
  });

  it("flags a close at 22:00 followed by an open at 06:00", () => {
    const out = restShortfalls([shiftSpan(MON, "14:00", "22:00"), shiftSpan(TUE, "06:00", "14:00")]);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe(MON);
    expect(out[0].restHours).toBeCloseTo(8);
    expect(minutesToDayTime(out[0].windowStart)).toEqual({ dateIso: MON, hhmm: "14:00" });
  });

  it("flags one 15-hour day — 24 − 15 leaves 9", () => {
    const out = restShortfalls([shiftSpan(MON, "08:00", "23:00")]);
    expect(out).toHaveLength(1);
    expect(out[0].restHours).toBeCloseTo(9);
  });

  it("handles an overnight shift", () => {
    // 18:00–02:00 then 10:00 the next morning: 8 hours.
    const out = restShortfalls([shiftSpan(MON, "18:00", "02:00"), shiftSpan(TUE, "10:00", "16:00")]);
    expect(out).toHaveLength(1);
    expect(out[0].restHours).toBeCloseTo(8);
  });
});

describe("preSaveWarnings — what the sheet says before saving", () => {
  const anna = { id: "a", name: "Anna", max_hours_week: null };
  const week = [
    { id: "s1", staff_id: "a", date: MON, start_time: "14:00", end_time: "22:00", break_minutes: 0 },
  ];

  it("warns about the rest the NEW shift breaks", () => {
    const w = preSaveWarnings({ member: anna, weekShifts: week, dateIso: TUE, start: "06:00", end: "14:00" });
    expect(w).toEqual([expect.objectContaining({ kind: "rest" })]);
    expect(w[0].restHours).toBeCloseTo(8);
  });

  it("stays quiet for a legal split shift", () => {
    const lunch = [{ id: "l", staff_id: "a", date: MON, start_time: "11:00", end_time: "15:00" }];
    expect(preSaveWarnings({ member: anna, weekShifts: lunch, dateIso: MON, start: "17:00", end: "22:00" })).toEqual([]);
  });

  it("ignores the shift being edited, so moving it is not judged against itself", () => {
    expect(
      preSaveWarnings({ member: anna, weekShifts: week, editingId: "s1", dateIso: MON, start: "14:00", end: "22:00" }),
    ).toEqual([]);
  });

  it("does not blame the new shift for a problem elsewhere in the week", () => {
    const bad = [
      { id: "x", staff_id: "a", date: MON, start_time: "14:00", end_time: "22:00" },
      { id: "y", staff_id: "a", date: TUE, start_time: "06:00", end_time: "14:00" },
    ];
    const sat = "2026-06-06";
    expect(preSaveWarnings({ member: anna, weekShifts: bad, dateIso: sat, start: "10:00", end: "16:00" })).toEqual([]);
  });

  it("names the 48-hour week", () => {
    const long = [0, 1, 2, 3, 4].map((i) => ({
      id: `d${i}`, staff_id: "a", date: `2026-06-0${i + 1}`, start_time: "08:00", end_time: "18:00", break_minutes: 0,
    })); // 50 h
    const w = preSaveWarnings({ member: anna, weekShifts: long, dateIso: "2026-06-06", start: "10:00", end: "12:00" });
    expect(w).toEqual([{ kind: "dk48", hours: 52 }]);
  });

  it("names a contract cap below 48", () => {
    const capped = { ...anna, max_hours_week: 10 };
    const w = preSaveWarnings({ member: capped, weekShifts: week, dateIso: "2026-06-04", start: "10:00", end: "14:00" });
    expect(w).toEqual([{ kind: "cap", hours: 12, cap: 10 }]);
  });

  it("respects a staffer whose hour-limit warnings are switched off — but never the rest rule", () => {
    const off = { ...anna, max_hours_week: 10, hour_limit_warn: false };
    const w = preSaveWarnings({ member: off, weekShifts: week, dateIso: TUE, start: "06:00", end: "14:00" });
    expect(w.map((x) => x.kind)).toEqual(["rest"]);
  });

  it("says nothing about a zero-length or unparseable shift", () => {
    expect(preSaveWarnings({ member: anna, weekShifts: week, dateIso: TUE, start: "10:00", end: "10:00" })).toEqual([]);
    expect(preSaveWarnings({ member: anna, weekShifts: week, dateIso: TUE, start: "x", end: "10:00" })).toEqual([]);
  });
});

describe("netHours", () => {
  it("rolls an overnight shift and takes the break off", () => {
    expect(netHours("22:00", "06:00", 30)).toBeCloseTo(7.5);
  });
});
