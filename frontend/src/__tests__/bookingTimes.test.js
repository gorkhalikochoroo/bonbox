/**
 * The owner's time pickers offer only starts whose whole sitting ends by
 * closing. 21:45 used to be offered for a 22:00 close and was then always
 * refused, which read as "full" to a host with an empty room.
 */
import { describe, it, expect } from "vitest";
import { sittingMinutes, openTimesFor, overrunsClose } from "../utils/bookingTimes";

const RULES = {
  turn_time_tiers: [
    { up_to: 2, minutes: 90 },
    { up_to: 4, minutes: 105 },
    { up_to: 8, minutes: 120 },
  ],
  default_duration_min: 90,
};
// 2026-10-01 is a Thursday.
const THU = "2026-10-01";
const HOURS = { thu: [["11:30", "22:00"]], fri: [["17:00", "01:00"]], sun: [] };

describe("sittingMinutes — the server's turn-time rule", () => {
  it("takes the smallest tier that fits", () => {
    expect(sittingMinutes(2, RULES)).toBe(90);
    expect(sittingMinutes(3, RULES)).toBe(105);
    expect(sittingMinutes(8, RULES)).toBe(120);
  });
  it("a party above every tier sits at least as long as the largest", () => {
    expect(sittingMinutes(12, RULES)).toBe(120);
  });
  it("no tiers → the default; nothing loaded → 90", () => {
    expect(sittingMinutes(4, { default_duration_min: 75 })).toBe(75);
    expect(sittingMinutes(4, null)).toBe(90);
  });
});

describe("openTimesFor", () => {
  it("ends the list where the sitting still ends by closing", () => {
    const two = openTimesFor(THU, HOURS, 90).times;
    expect(two[0]).toBe("11:30");
    expect(two[two.length - 1]).toBe("20:30");
    const eight = openTimesFor(THU, HOURS, 120).times;
    expect(eight[eight.length - 1]).toBe("20:00");
  });
  it("handles a window past midnight", () => {
    const fri = openTimesFor("2026-10-02", HOURS, 90).times;
    expect(fri[0]).toBe("17:00");
    expect(fri).toContain("23:15");
    expect(fri).not.toContain("23:45");
  });
  it("a closed day says so; unknown hours offer every quarter", () => {
    expect(openTimesFor("2026-10-04", HOURS, 90).closed).toBe(true);
    const unknown = openTimesFor("2026-10-05", HOURS, 90);
    expect(unknown.known).toBe(false);
    expect(unknown.times[0]).toBe("06:00");
  });
});

describe("overrunsClose — why an empty room refuses a time", () => {
  it("true inside the window when the sitting runs past close", () => {
    expect(overrunsClose(HOURS.thu, "21:00", 90)).toBe(true);
    expect(overrunsClose(HOURS.thu, "20:30", 90)).toBe(false);
  });
  it("false outside the window — that is a different message", () => {
    expect(overrunsClose(HOURS.thu, "22:30", 90)).toBe(false);
  });
});
