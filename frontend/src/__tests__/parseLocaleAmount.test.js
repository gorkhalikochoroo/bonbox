/**
 * parseLocaleAmount — reading Danish money back out of a string.
 *
 * Danish writes money the opposite way round from English:
 *   "1.234,56" = one thousand two hundred thirty-four kroner and 56 øre
 * so the English "strip the thousands commas" idiom
 *   parseFloat(s.replace(/,/g, ""))
 * silently turns 150,50 kr into 15.050 kr and 2.000 kr into 2 kr.
 *
 * That idiom was live on the voice-entry path, where recognition.lang is
 * da-DK for Danish owners — i.e. it mis-read the transcript it had just
 * asked for in Danish. These cases are the regression guard.
 */
import { describe, it, expect } from "vitest";
import { parseLocaleAmount } from "../utils/currency";

describe("parseLocaleAmount — Danish notation", () => {
  it.each([
    ["150,50", 150.5],
    ["45,00", 45],
    ["89,95", 89.95],
    ["0,05", 0.05],
    ["1.234,56", 1234.56],
    ["2.000", 2000],
    ["1.234.567", 1234567],
    ["12.500,75", 12500.75],
  ])("reads %s as %s", (input, expected) => {
    expect(parseLocaleAmount(input, "da-DK")).toBeCloseTo(expected, 9);
  });

  it.each([
    ["150,50 kroner kontant", 150.5],
    ["1.234,56 kr.", 1234.56],
    ["2.000 kr.", 2000],
    ["1.500,-", 1500],
    ["DKK 89,95", 89.95],
  ])("strips currency words and punctuation: %s", (input, expected) => {
    expect(parseLocaleAmount(input, "da-DK")).toBeCloseTo(expected, 9);
  });

  it("does not mangle a dot-decimal value from a type=number input", () => {
    // Browsers normalise type=number .value to dot form regardless of
    // locale, so the parser must pass those through untouched.
    expect(parseLocaleAmount("1234.56", "da-DK")).toBeCloseTo(1234.56, 9);
    expect(parseLocaleAmount("1000", "da-DK")).toBe(1000);
    expect(parseLocaleAmount("0.5", "da-DK")).toBeCloseTo(0.5, 9);
  });

  it("handles negatives", () => {
    expect(parseLocaleAmount("-99,50", "da-DK")).toBeCloseTo(-99.5, 9);
  });

  it("regression: the old comma-strip idiom was 100x wrong", () => {
    const oldWay = (t) => parseFloat(t.replace(/,/g, ""));
    expect(oldWay("150,50")).toBe(15050);            // the bug
    expect(parseLocaleAmount("150,50", "da-DK")).toBeCloseTo(150.5, 9);
  });

  it("regression: the old idiom read 2.000 kr as 2 kr", () => {
    expect(parseFloat("2.000".replace(/,/g, ""))).toBe(2);   // the bug
    expect(parseLocaleAmount("2.000", "da-DK")).toBe(2000);
  });
});

describe("parseLocaleAmount — English notation", () => {
  it.each([
    ["1,234.56", 1234.56],
    ["1,234", 1234],
    ["150.50", 150.5],
    ["2,000", 2000],
  ])("reads %s as %s", (input, expected) => {
    expect(parseLocaleAmount(input, "en-US")).toBeCloseTo(expected, 9);
  });

  it("resolves the ambiguous 3-digit tail by locale", () => {
    // "1.234" is 1234 to a Dane and 1.234 to an American. There is no
    // right answer from the string alone — the locale has to decide, and
    // guessing one way for both is how money quietly changes by 1000x.
    expect(parseLocaleAmount("1.234", "da-DK")).toBe(1234);
    expect(parseLocaleAmount("1.234", "en-US")).toBeCloseTo(1.234, 9);
    expect(parseLocaleAmount("1,234", "da-DK")).toBeCloseTo(1.234, 9);
    expect(parseLocaleAmount("1,234", "en-US")).toBe(1234);
  });
});

describe("parseLocaleAmount — refuses rather than guesses", () => {
  it.each([["", NaN], ["abc", NaN], [".", NaN], [",", NaN], [null, NaN], [undefined, NaN]])(
    "returns NaN for %s",
    (input) => {
      expect(parseLocaleAmount(input, "da-DK")).toBeNaN();
    },
  );

  it("passes finite numbers through and rejects non-finite", () => {
    expect(parseLocaleAmount(1234.56, "da-DK")).toBeCloseTo(1234.56, 9);
    expect(parseLocaleAmount(NaN, "da-DK")).toBeNaN();
    expect(parseLocaleAmount(Infinity, "da-DK")).toBeNaN();
  });
});

describe("parseLocaleAmount — the misapplication that bit us", () => {
  it("must NOT be used on <input type=number> values", () => {
    // The browser normalises type=number .value to canonical dot-decimal
    // regardless of locale. Routing that through the Danish text parser
    // reads a 3-digit tail as a thousands group: an FX rate of 0.134
    // became 134, so a 745,50 receipt booked as 99.897 instead of 99,90.
    expect(parseLocaleAmount("0.134", "da-DK")).toBe(134);   // correct for TEXT
    expect(parseFloat("0.134")).toBeCloseTo(0.134, 9);        // correct for INPUTS

    const receipt = 745.5;
    expect(receipt * parseFloat("0.134")).toBeCloseTo(99.9, 2);
    expect(receipt * parseLocaleAmount("0.134", "da-DK")).toBeCloseTo(99897, 0);
  });
});
