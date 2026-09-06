/**
 * The hero MOMS card must never name a date that has passed.
 *
 * It did: on 6 Sep 2026 the live page read "MOMS · H1 2026 · in 36 days"
 * beside "~88.777 kr. due 1 Sept 2026" — a frist five days gone, called 36 days
 * away, on the card that demonstrates the MOMS countdown to a Danish venue.
 *
 * Every case pins an explicit `now`, because a countdown test that depends on
 * the day CI runs is exactly the kind that goes green by luck.
 */
import { describe, expect, it } from "vitest";
import {
  formatFrist,
  formatPeriod,
  nextMomsDeadline,
  weeklySetAside,
} from "../utils/nextMomsDeadline";

const at = (iso) => new Date(`${iso}T09:00:00`);

describe("nextMomsDeadline", () => {
  it("never returns a date in the past — the whole bug, on the exact day", () => {
    const r = nextMomsDeadline(at("2026-09-06"));
    expect(r.date > at("2026-09-06")).toBe(true);
    expect(r.daysUntil).toBeGreaterThan(0);
    // Was: "1 Sept 2026", five days gone.
    expect(formatFrist(r.date)).toBe("1 Mar 2027");
  });

  it("counts the days correctly rather than restating a frozen number", () => {
    // 1 Sept is 36 days after 27 July — the copy's original, correct moment.
    expect(nextMomsDeadline(at("2026-07-27")).daysUntil).toBe(36);
    expect(nextMomsDeadline(at("2026-08-31")).daysUntil).toBe(1);
    expect(nextMomsDeadline(at("2026-02-28")).daysUntil).toBe(1);
  });

  it("rolls to the next frist ON the deadline day, never to zero", () => {
    // A mockup showing "0 days" beside an invented kroner figure reads as the
    // visitor's own overdue bill. Roll instead.
    const onFrist = nextMomsDeadline(at("2026-09-01"));
    expect(onFrist.daysUntil).toBeGreaterThan(0);
    expect(formatFrist(onFrist.date)).toBe("1 Mar 2027");
  });

  it("names the period the frist actually settles", () => {
    // 1 September settles H1 of the same year.
    const sep = nextMomsDeadline(at("2026-06-01"));
    expect(formatFrist(sep.date)).toBe("1 Sept 2026");
    expect(formatPeriod(sep)).toBe("H1 2026");

    // 1 March settles H2 of the PREVIOUS year — the off-by-one worth pinning.
    const mar = nextMomsDeadline(at("2026-12-01"));
    expect(formatFrist(mar.date)).toBe("1 Mar 2027");
    expect(formatPeriod(mar)).toBe("H2 2026");
  });

  it("crosses the year boundary without going backwards", () => {
    const r = nextMomsDeadline(at("2026-12-31"));
    expect(formatFrist(r.date)).toBe("1 Mar 2027");
    expect(r.daysUntil).toBe(60);
  });

  it("formats Danish the way the DK copy prints it", () => {
    const r = nextMomsDeadline(at("2026-06-01"));
    expect(formatFrist(r.date, "da")).toBe("1. september 2026");
    expect(formatPeriod(r, "da")).toBe("1. halvår 2026");
    expect(formatPeriod(nextMomsDeadline(at("2026-12-01")), "da")).toBe(
      "2. halvår 2026",
    );
  });

  it("keeps the card's own arithmetic consistent", () => {
    // The trap fixing the date alone would have created: the original copy was
    // coherent by accident of being written on one day — 88.777 kr over
    // ~17.800/week IS five weeks, which is the 36 days it claimed. Make the
    // date real without making the weekly figure real and the card says
    // 17.800 a week for 176 days, i.e. 445.000 kr against a stated 88.777.
    const KR = 88777;
    for (const now of ["2026-09-06", "2026-07-27", "2026-01-15", "2027-05-20"]) {
      const { daysUntil } = nextMomsDeadline(at(now));
      const weekly = Number(weeklySetAside(KR, daysUntil).replace(/\./g, ""));
      const implied = weekly * (daysUntil / 7);
      // Within the deliberate round-to-nearest-100, the advice must fund the bill.
      expect(Math.abs(implied - KR) / KR).toBeLessThan(0.05);
    }
  });

  it("prints the set-aside as DK advice, not an invoice", () => {
    expect(weeklySetAside(88777, 176)).toBe("3.500"); // period separator, round 100
    expect(weeklySetAside(88777, 36)).toBe("17.300");
    // Never zero, never negative, however close the frist gets.
    expect(weeklySetAside(88777, 1)).not.toMatch(/^0/);
    expect(weeklySetAside(50, 365)).toBe("100");
  });

  it("is stable for any day of any year — no past date, ever", () => {
    for (let y = 2026; y <= 2030; y++) {
      for (let m = 0; m < 12; m++) {
        const now = new Date(y, m, 15);
        const r = nextMomsDeadline(now);
        expect(r.date > now).toBe(true);
        expect(r.daysUntil).toBeGreaterThan(0);
        expect(r.daysUntil).toBeLessThanOrEqual(200);
      }
    }
  });
});
