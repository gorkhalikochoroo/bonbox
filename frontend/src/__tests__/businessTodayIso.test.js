/**
 * businessTodayIso — the client twin of the backend's business_today_local().
 *
 * This exists because two screens disagreed about "today". The Sales page
 * filtered on the wall-clock date and reported "TODAY 0 kr. · 0 sales" at
 * 00:30, while the dashboard asked the server for the business day and
 * correctly showed the evening's takings. A café closing at 02:00 counts that
 * service against the day it STARTED, which is the whole point of the cutoff.
 *
 * The rule is one line — `hour < cutoff ? yesterday : today` — but it is a
 * money rule, and getting it wrong moves revenue between days, so it is
 * pinned here including the boundary and the date-rollover cases.
 */
import { describe, expect, it } from "vitest";

import { businessTodayIso, localIso } from "../utils/dateFormat";

/** A local-time Date, so the test reads in the same frame the helper works in. */
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

describe("businessTodayIso", () => {
  describe("with a DK restaurant cutoff of 06:00", () => {
    it("counts 02:00 against the day the service started", () => {
      // The case that started this: a sale rung up after midnight.
      expect(businessTodayIso(6, at(2026, 8, 29, 2, 0))).toBe("2026-08-28");
    });

    it("counts 00:30 against yesterday", () => {
      expect(businessTodayIso(6, at(2026, 8, 29, 0, 30))).toBe("2026-08-28");
    });

    it("flips to the new day exactly AT the cutoff, not before", () => {
      expect(businessTodayIso(6, at(2026, 8, 29, 5, 59))).toBe("2026-08-28");
      expect(businessTodayIso(6, at(2026, 8, 29, 6, 0))).toBe("2026-08-29");
    });

    it("is an ordinary today during service", () => {
      expect(businessTodayIso(6, at(2026, 8, 29, 19, 0))).toBe("2026-08-29");
    });
  });

  describe("rollovers", () => {
    it("crosses a month boundary backwards", () => {
      expect(businessTodayIso(6, at(2026, 9, 1, 3, 0))).toBe("2026-08-31");
    });

    it("crosses a year boundary backwards", () => {
      expect(businessTodayIso(6, at(2026, 1, 1, 3, 0))).toBe("2025-12-31");
    });

    it("handles a leap day", () => {
      expect(businessTodayIso(6, at(2028, 3, 1, 3, 0))).toBe("2028-02-29");
    });
  });

  describe("cutoff 0 — a shop with midnight rollover", () => {
    it("never shifts the date", () => {
      expect(businessTodayIso(0, at(2026, 8, 29, 0, 1))).toBe("2026-08-29");
      expect(businessTodayIso(0, at(2026, 8, 29, 23, 59))).toBe("2026-08-29");
    });

    it("is what an absent cutoff falls back to", () => {
      // Never silently invent a 6-hour shift for an account that has none.
      const d = at(2026, 8, 29, 1, 0);
      expect(businessTodayIso(undefined, d)).toBe(localIso(d));
      expect(businessTodayIso(null, d)).toBe(localIso(d));
      expect(businessTodayIso(NaN, d)).toBe(localIso(d));
    });
  });

  describe("a bad stored value cannot move money", () => {
    it("clamps out-of-range hours instead of shifting by days", () => {
      const d = at(2026, 8, 29, 1, 0);
      // 26 clamps to 23 — still a valid same-or-previous-day answer.
      expect(businessTodayIso(26, d)).toBe("2026-08-28");
      // Negative clamps to 0 — no shift.
      expect(businessTodayIso(-5, d)).toBe("2026-08-29");
    });

    it("truncates a fractional hour rather than rounding up past the cutoff", () => {
      expect(businessTodayIso(6.9, at(2026, 8, 29, 6, 30))).toBe("2026-08-29");
    });

    it("accepts the numeric string an API might return", () => {
      expect(businessTodayIso("6", at(2026, 8, 29, 2, 0))).toBe("2026-08-28");
    });
  });

  it("does not mutate the Date it was given", () => {
    const d = at(2026, 8, 29, 2, 0);
    const before = d.getTime();
    businessTodayIso(6, d);
    expect(d.getTime()).toBe(before);
  });
});
