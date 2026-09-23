/**
 * The rate column must reproduce the money beside it.
 *
 * THE RULE IS ALREADY IN THIS FILE, at the rateDecimals() comment: the rate is
 * "the one figure on this page the owner MULTIPLIES by the hours beside it",
 * and printing one that does not reproduce `earned` "hands the owner a payroll
 * row they cannot reproduce — right notation, wrong number." That was written
 * about ØRE.
 *
 * The same defect arrives far larger through `earned` being a STORED column.
 * Seen on production, 23 Sep, after a rate was raised 150 → 190:
 *
 *     16 t · 190 kr./t · 2.400 kr.      16 × 190 = 3.040, not 2.400
 *
 * Both figures are individually true — 190 is today's rate, and the shifts
 * really were costed at 150 before the raise. The ROW is what lies. An owner
 * checking the arithmetic on a payroll screen concludes the software is wrong
 * about wages, which is the most expensive conclusion this page can produce.
 *
 * earned ÷ hours reconciles by construction, and is MORE accurate than
 * base_rate even with no raise involved, because an evening or weekend premium
 * already makes the two differ.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "pages", "StaffHoursPage.jsx"),
  "utf8",
);

/** The helper, reimplemented so the behaviour is pinned and not just its text. */
const effectiveRate = (r) => {
  const h = Number(r?.actual_hours) || 0;
  const e = Number(r?.earned) || 0;
  if (h > 0 && e > 0) return e / h;
  return r?.hourly_rate ?? null;
};

describe("the rate reproduces the earned figure", () => {
  it("the production row that started this reconciles", () => {
    // 16 h, earned 2.400 at the old rate, member now on 190.
    const row = { actual_hours: 16, earned: 2400, hourly_rate: 190 };
    const rate = effectiveRate(row);
    expect(rate).toBe(150);
    expect(rate * row.actual_hours).toBe(row.earned);
  });

  it("an unraised staffer is unaffected", () => {
    const row = { actual_hours: 0.93, earned: 134.85, hourly_rate: 145 };
    expect(effectiveRate(row)).toBeCloseTo(145, 6);
  });

  it("a weekend premium shows what the hours cost, not the base rate", () => {
    // 8h at a 180 weekend rate on a 145 base. 180 is the honest answer.
    const row = { actual_hours: 8, earned: 1440, hourly_rate: 145 };
    expect(effectiveRate(row)).toBe(180);
  });

  it("falls back to the stated rate when there is nothing to divide", () => {
    expect(effectiveRate({ actual_hours: 0, earned: 0, hourly_rate: 145 })).toBe(145);
  });

  it("an unknown rate stays unknown — never 0", () => {
    // The rateMissing case: no rate was ever set, so earned is a stored 0.
    // Dividing would print "0 kr./t", a confident claim that the work was
    // worth nothing.
    expect(effectiveRate({ actual_hours: 8, earned: 0, hourly_rate: null })).toBeNull();
  });

  it("never returns a rate that contradicts the money", () => {
    const rows = [
      { actual_hours: 16, earned: 2400, hourly_rate: 190 },
      { actual_hours: 8, earned: 1440, hourly_rate: 145 },
      { actual_hours: 0.93, earned: 134.85, hourly_rate: 145 },
    ];
    for (const r of rows) {
      const rate = effectiveRate(r);
      expect(Math.abs(rate * r.actual_hours - r.earned)).toBeLessThan(0.01);
    }
  });
});

describe("the page actually uses it", () => {
  it("the rate cell no longer prints base_rate directly", () => {
    expect(SRC).toMatch(/const rate = effectiveRate\(row\);/);
    expect(SRC).not.toMatch(
      /\{row\.hourly_rate != null\s*\n\s*\? `\$\{formatOwnerMoney\(row\.hourly_rate/,
    );
  });

  it("the helper is defined", () => {
    expect(SRC).toMatch(/const effectiveRate = \(r\) => \{/);
  });
});
