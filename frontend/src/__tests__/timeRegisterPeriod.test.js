/**
 * The working-time register: how long, and over what window.
 *
 * TWO THINGS THIS PAGE GOT WRONG, both reported by the owner on 2026-09-22.
 *
 * 1. IT SPOKE HALF-DANISH. It printed "6.8 t" — the Danish unit `t` with an
 *    English decimal point — on an English screen, because it typed the unit
 *    itself instead of asking utils/hours.js. That is verbatim the hybrid
 *    hours.js was opened to end, and the guard that forbids it ran against a
 *    hardcoded list of two files that this page was not on.
 *
 *    The fix is not just "use the formatter". Decimal hours are right for a
 *    PAY figure (you multiply 6,8 t by a rate) and wrong for a REGISTER, which
 *    answers "how long was this person here" and is read under inspection.
 *    Nobody converts 6,8 t to 6 t 48 min in their head correctly while an
 *    inspector waits.
 *
 * 2. IT ONLY KNEW MONTHS. Arbejdstidsloven averages the weekly cap over four
 *    months, an accountant asks for a quarter, and an Arbejdstilsynet request
 *    names its own dates. A month stepper answers none of those.
 */
import { describe, it, expect } from "vitest";

import { formatHoursMinutes, formatHours, minutesUnit } from "../utils/hours";
import { periodBounds, stepCursor, TREG_MODES } from "../pages/TimeRegistrationPage";

describe("a duration reads the way a person says it", () => {
  it("Danish gets Danish units and no decimal point in sight", () => {
    expect(formatHoursMinutes(6.8, { lang: "da" })).toBe("6 t 48 min");
    expect(formatHoursMinutes(12.4, { lang: "da" })).toBe("12 t 24 min");
    expect(formatHoursMinutes(6.8, { lang: "da" })).not.toMatch(/[.]/);
  });

  it("English gets English units — never the Danish t", () => {
    expect(formatHoursMinutes(6.8, { lang: "en" })).toBe("6h 48m");
    expect(formatHoursMinutes(6.8, { lang: "en" })).not.toContain("t");
  });

  it("Turkish too, since it is an offered locale", () => {
    expect(formatHoursMinutes(6.8, { lang: "tr" })).toBe("6 sa 48 dk");
    expect(minutesUnit("tr")).toBe("dk");
  });

  it("a whole hour does not trail a pointless 0 min", () => {
    expect(formatHoursMinutes(6, { lang: "da" })).toBe("6 t");
    expect(formatHoursMinutes(6, { lang: "en" })).toBe("6h");
  });

  it("under an hour does not claim 0 t", () => {
    // The shift the owner actually clocked: 15:22-15:56.
    expect(formatHoursMinutes(0.57, { lang: "da" })).toBe("34 min");
    expect(formatHoursMinutes(0.57, { lang: "da" })).not.toMatch(/\bt\b/);
  });

  it("rounds to the minute as a whole, never producing 60 min", () => {
    expect(formatHoursMinutes(1.999, { lang: "da" })).toBe("2 t");
    expect(formatHoursMinutes(0.9999, { lang: "da" })).toBe("1 t");
  });

  it("not-known stays '—' and never becomes a confident zero", () => {
    for (const v of [null, undefined, "", NaN]) {
      expect(formatHoursMinutes(v, { lang: "da" })).toBe("—");
    }
    // A measured zero is a different fact and keeps its unit.
    expect(formatHoursMinutes(0, { lang: "da" })).toBe("0 min");
  });

  it("the decimal form is untouched — the weekly cap still reads like a cap", () => {
    // 48 t/uge is compared against a decimal average; that one stays decimal.
    expect(formatHours(4.04, { lang: "da" })).toBe("4 t");
    expect(formatHours(4.04, { lang: "da", decimals: 2 })).toBe("4,04 t");
    expect(formatHours(6.8, { lang: "en" })).toBe("6.8 h");
  });
});

describe("the register covers the window the question was asked about", () => {
  const JUL15 = new Date(2026, 6, 15);   // mid-Q3

  it("month is the calendar month", () => {
    expect(periodBounds("month", JUL15)).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("quarter snaps to the whole quarter, not three months from the cursor", () => {
    expect(periodBounds("quarter", JUL15)).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(periodBounds("quarter", new Date(2026, 0, 5))).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(periodBounds("quarter", new Date(2026, 11, 31))).toEqual({ from: "2026-10-01", to: "2026-12-31" });
  });

  it("year is the calendar year", () => {
    expect(periodBounds("year", JUL15)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("custom uses the owner's dates, and tolerates them backwards", () => {
    expect(periodBounds("custom", JUL15, "2026-03-01", "2026-05-31"))
      .toEqual({ from: "2026-03-01", to: "2026-05-31" });
    expect(periodBounds("custom", JUL15, "2026-05-31", "2026-03-01"))
      .toEqual({ from: "2026-03-01", to: "2026-05-31" });
  });

  it("a half-filled custom range falls back to the month, never a half-open query", () => {
    // An empty register reads as "nobody worked" — the one thing this page
    // must never imply by accident.
    expect(periodBounds("custom", JUL15, "2026-03-01", "")).toEqual(periodBounds("month", JUL15));
    expect(periodBounds("custom", JUL15, "", "")).toEqual(periodBounds("month", JUL15));
  });

  it("stepping moves a WHOLE period", () => {
    // Stepping a quarter by one month would land inside the same quarter and
    // look like the button did nothing.
    expect(periodBounds("quarter", stepCursor("quarter", JUL15, 1)))
      .toEqual({ from: "2026-10-01", to: "2026-12-31" });
    expect(periodBounds("quarter", stepCursor("quarter", JUL15, -1)))
      .toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(periodBounds("year", stepCursor("year", JUL15, 1)))
      .toEqual({ from: "2027-01-01", to: "2027-12-31" });
    expect(periodBounds("month", stepCursor("month", new Date(2026, 11, 10), 1)))
      .toEqual({ from: "2027-01-01", to: "2027-01-31" });
  });

  it("bounds are LOCAL dates, not UTC", () => {
    // toISOString() alone would hand a Copenhagen owner the previous day once
    // the clock passes 22:00 UTC+2.
    const lateEvening = new Date(2026, 6, 31, 23, 30);
    expect(periodBounds("month", lateEvening).to).toBe("2026-07-31");
  });

  it("every offered mode is covered by these tests", () => {
    expect(TREG_MODES).toEqual(["month", "quarter", "year", "custom"]);
  });
});
