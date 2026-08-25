/**
 * parseMoneyInput — the strict parser for money fields an owner TYPES.
 *
 * The bug this exists to end was reproduced on an iPhone simulator: the quick
 * entry amount field was `type="number"`, so typing "347,50" left the field
 * holding "34750". The comma was stripped, the digits kept, the submit button
 * stayed green. A 100× error, silent, on the primary way an owner logs money.
 *
 * The obvious fix — swap to type="text" and read it with the app's existing
 * parseLocaleAmount — would have been worse. That parser SALVAGES a number out
 * of noise, which is right for a speech transcript and catastrophic here. Its
 * measured behaviour is pinned at the bottom of this file as a guard: if
 * someone ever routes a keyed field through it, those tests explain why not.
 *
 * The rule this file defends: a REFUSED input is cheap and visible — the field
 * shows an error and the owner retypes. A WRONG NUMBER IN THE BOOKS is neither.
 * So every ambiguous case resolves to NaN rather than a guess.
 *
 * Run:
 *   cd frontend && npx vitest run src/__tests__/parseMoneyInput.test.js
 */
import { describe, it, expect } from "vitest";
import { parseMoneyInput, moneyLocale, parseLocaleAmount } from "../utils/currency";

const da = (s) => parseMoneyInput(s, "da-DK");
const en = (s) => parseMoneyInput(s, "en-US");

// ── 1. what a Danish owner actually types ──────────────────────────────
describe("Danish notation", () => {
  it.each([
    ["347,50", 347.5],
    ["1.234,56", 1234.56],
    ["1234,5", 1234.5],
    ["0,5", 0.5],
    ["347", 347],
    ["1 234,56", 1234.56],          // space is legal grouping in DK
    ["1 234 567,89", 1234567.89],
  ])("reads %s as %s", (input, expected) => {
    expect(da(input)).toBeCloseTo(expected, 9);
  });

  it.each([
    ["347,-", 347],                 // Danish shorthand for whole kroner
    ["347 kr", 347],
    ["kr. 347,50", 347.5],
    ["347,50 kr.", 347.5],
    ["1.234,56 DKK", 1234.56],
  ])("strips the currency token in %s", (input, expected) => {
    expect(da(input)).toBeCloseTo(expected, 9);
  });

  it("accepts a leading separator as øre — ,50 is fifty øre, not fifty kroner", () => {
    expect(da(",50")).toBeCloseTo(0.5, 9);
    expect(da(".50")).toBeCloseTo(0.5, 9);
    expect(da(",5")).toBeCloseTo(0.5, 9);
  });

  it("refuses a leading separator with 3+ digits rather than guessing", () => {
    // ",500" could be 0,50-ish or five hundred. Neither reading is safe.
    expect(da(",500")).toBeNaN();
  });
});

// ── 2. the typos that generate 100× errors ─────────────────────────────
describe("near-miss typos are refused, never salvaged", () => {
  it.each([
    ["1.234.56", "one character off 1.234,56 — parseLocaleAmount returns 123456"],
    ["347,50,25", "two decimal separators"],
    ["1,5,0", "separators scattered"],
    ["347-50", "dash where a comma was meant"],
    ["347,", "dangling separator"],
    ["1.", "dangling separator"],
    ["347,555", "three fraction digits — money has two"],
    ["1.2345", "four-digit tail"],
    ["1.234 567", "mixed grouping separators"],
    ["34o", "letter O for a zero"],
  ])("refuses %s (%s)", (input) => {
    expect(da(input)).toBeNaN();
  });

  it("refuses a grouped number with a leading-zero group", () => {
    expect(da("0.134")).toBeNaN();   // parseLocaleAmount returns 134
  });
});

// ── 3. the genuinely ambiguous 3-digit tail ────────────────────────────
describe("a 3-digit tail is decided by the MONEY locale", () => {
  it("da-DK reads 1.234 as grouping", () => {
    expect(da("1.234")).toBe(1234);
    expect(da("2.000")).toBe(2000);
    expect(da("10.000")).toBe(10000);
  });

  it("en-US reads 1,234 as grouping", () => {
    expect(en("1,234")).toBe(1234);
    expect(en("10,000")).toBe(10000);
  });

  it("refuses the reading that would mean a 3-digit fraction", () => {
    // Money has at most 2 fraction digits, so if the locale says this
    // separator is the decimal point, the string is not money.
    expect(da("1,234")).toBeNaN();
    expect(en("1.234")).toBeNaN();
  });
});

// ── 4. both separators present ─────────────────────────────────────────
describe("when both separators appear the rightmost is the decimal", () => {
  it.each([
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["1.234.567,89", 1234567.89],
    ["1,234,567.89", 1234567.89],
  ])("%s -> %s in either locale", (input, expected) => {
    expect(da(input)).toBeCloseTo(expected, 9);
    expect(en(input)).toBeCloseTo(expected, 9);
  });
});

// ── 5. pasted junk ─────────────────────────────────────────────────────
describe("pasted content is refused, not mined for digits", () => {
  it.each([
    "18-08 347,50",              // a receipt line — parseLocaleAmount: 1808347.5
    "Tomater 347,50",
    "347,50 stk",
    "(347,50)",                  // accounting negative
    "$347.50",
    "€347,50",
  ])("refuses %s", (input) => {
    expect(da(input)).toBeNaN();
  });

  it("tolerates the space characters a paste carries", () => {
    expect(da("1 234,56")).toBeCloseTo(1234.56, 9);   // NBSP
    expect(da("1 234,56")).toBeCloseTo(1234.56, 9);   // narrow NBSP
    expect(da("  347,50  ")).toBeCloseTo(347.5, 9);
  });
});

// ── 6. boundaries ──────────────────────────────────────────────────────
describe("boundaries", () => {
  it.each(["", "   ", ",", ".", "-", "+", "-,", "kr."])(
    "refuses %s",
    (input) => expect(da(input)).toBeNaN(),
  );

  it("reads zero", () => {
    expect(da("0")).toBe(0);
    expect(da("0,00")).toBe(0);
  });

  it("carries a sign", () => {
    expect(da("-99,50")).toBeCloseTo(-99.5, 9);
    expect(da("+99,50")).toBeCloseTo(99.5, 9);
  });

  it("passes a real number through unchanged", () => {
    expect(da(347.5)).toBe(347.5);
  });

  it.each([null, undefined, NaN, Infinity, {}, [], true])(
    "refuses the non-string %s",
    (input) => expect(parseMoneyInput(input, "da-DK")).toBeNaN(),
  );
});

// ── 7. never throws, never returns non-finite ──────────────────────────
describe("it never throws and never returns a non-finite number", () => {
  const hostile = [
    "1e5", "0x10", "Infinity", "NaN", "=1+1", "١٢٣", "１２３",
    "​347", "347​", "<b>347</b>", "🙂", "9".repeat(400),
    "1,,2", "..", ",,", "1 2 3", "- 347",
  ];
  it.each(hostile)("handles %s", (input) => {
    let out;
    expect(() => { out = da(input); }).not.toThrow();
    expect(typeof out).toBe("number");
    if (!Number.isNaN(out)) expect(Number.isFinite(out)).toBe(true);
  });
});

// ── 8. the locale comes from the MONEY, not the UI chrome ──────────────
describe("moneyLocale", () => {
  it.each(["DKK", "EUR", "SEK", "NOK", "PLN", undefined, null, ""])(
    "%s parses as da-DK",
    (c) => expect(moneyLocale(c)).toBe("da-DK"),
  );

  it.each(["USD", "GBP", "NPR", "INR", "JPY", "usd"])(
    "%s parses as en-US",
    (c) => expect(moneyLocale(c)).toBe("en-US"),
  );

  it("does not depend on the interface language", () => {
    // A DKK café that flips the UI to English must still have "1.234" mean
    // 1234 kr. Keying the parser on the chrome language would silently change
    // what the same keystrokes book.
    expect(parseMoneyInput("1.234", moneyLocale("DKK"))).toBe(1234);
  });
});

// ── 9. why parseLocaleAmount must never be used on a keyed field ───────
//
// Not aspirational — this pins the SALVAGE behaviour so the difference stays
// documented in the test suite. If someone routes a typed money field through
// parseLocaleAmount, these are the numbers that reach the ledger.
describe("guard: parseLocaleAmount salvages and must stay off keyed fields", () => {
  // The claim is that the strict parser never AGREES with the salvaged value.
  // Refusing is one way to satisfy that; parsing it correctly is another —
  // ",50" is the case where the salvager's answer (50 kr) and the right answer
  // (0,50 kr) differ by 100× and both are numbers.
  it.each([
    ["1.234.56", 123456],
    [",50", 50],
    ["347-50", 34750],
    ["18-08 347,50", 1808347.5],
    ["347,50,25", 3475025],
    ["0.134", 134],
  ])("parseLocaleAmount(%s) = %s — parseMoneyInput never returns that", (input, salvaged) => {
    expect(parseLocaleAmount(input, "da-DK")).toBeCloseTo(salvaged, 9);
    const strict = da(input);
    if (!Number.isNaN(strict)) expect(strict).not.toBeCloseTo(salvaged, 9);
  });

  it("the ,50 case specifically: salvager says 50 kr, strict says 0,50 kr", () => {
    expect(parseLocaleAmount(",50", "da-DK")).toBe(50);
    expect(da(",50")).toBeCloseTo(0.5, 9);
  });
});
