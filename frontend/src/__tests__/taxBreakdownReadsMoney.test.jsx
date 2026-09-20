/**
 * The live MOMS panel must read the amount the way the field does.
 *
 * The amount box is `type="text"` on purpose, so a Danish owner's own
 * notation survives to the parser (EntryCard.jsx). EntryCard reads it with
 * parseMoneyInput. TaxBreakdown — the panel that opens directly underneath,
 * inside EntryCard's own extras slot — read it with parseFloat.
 *
 * Two readers of one string, disagreeing by up to a thousandfold:
 *
 *     "1.250"     parseFloat 1.25     parseMoneyInput 1250
 *     "1.500,50"  parseFloat 1.5      parseMoneyInput 1500.5
 *     "347,50"    parseFloat 347      parseMoneyInput 347.5
 *
 * So the owner typed 1.250, the panel said "1,25 kr. · MOMS 0,25 kr.", and
 * the sale booked at 1.250 kr. The wrong number was the one shown at the
 * exact moment the owner was checking their work, on the most-used flow in
 * the product.
 *
 * This is the same defect class as the EntryCard fix and the 58-field sweep
 * that followed it — it survived because the sweep looked for INPUTS that
 * parse, and this is a read-only PREVIEW that parses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseMoneyInput, moneyLocale, calcTaxBreakdown } from "../utils/currency";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "components", "TaxBreakdown.jsx"), "utf8");

describe("TaxBreakdown parses money the way the field does", () => {
  it("does not use parseFloat on the amount", () => {
    expect(SOURCE).not.toMatch(/parseFloat\s*\(\s*amount\s*\)/);
  });

  it("reads it with parseMoneyInput under the account's locale", () => {
    expect(SOURCE).toMatch(/parseMoneyInput\(\s*amount\s*,\s*moneyLocale\(currencyCode\)\s*\)/);
  });

  it("renders nothing rather than a breakdown of a number it could not read", () => {
    expect(SOURCE).toMatch(/Number\.isFinite\(num\)/);
  });

  it("puts every figure through the owner-money formatter", () => {
    // A bare toLocaleString renders the BROWSER's locale, so a DK owner would
    // read "1,250.00" — comma as thousands, which in Danish is the decimal.
    expect(SOURCE).not.toMatch(/toLocaleString/);
    expect((SOURCE.match(/formatOwnerMoney\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe("the disagreement itself, on the real parsers", () => {
  const dk = moneyLocale("DKK");

  it.each([
    ["1.250", 1250],
    ["1.500,50", 1500.5],
    ["347,50", 347.5],
  ])("Danish %s reads as %s, not what parseFloat says", (typed, expected) => {
    expect(parseMoneyInput(typed, dk)).toBe(expected);
    expect(parseFloat(typed)).not.toBe(expected); // the bug, pinned
  });

  it("the MOMS a mis-parse would have quoted is the one the owner saw", () => {
    // 1.250 misread as 1.25 → the panel really did say 0,25 kr. of MOMS.
    expect(calcTaxBreakdown(1.25, "DKK").taxAmount).toBeCloseTo(0.25, 2);
    // Read correctly, it is 250 kr. — a thousandfold apart.
    expect(calcTaxBreakdown(1250, "DKK").taxAmount).toBeCloseTo(250, 2);
  });
});
