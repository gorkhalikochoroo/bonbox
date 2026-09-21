/**
 * The nightly close does not go dead without a sentence.
 *
 * Confirm & Lock is disabled on three conditions — saving, nothing to save,
 * and an amount that could not be read — and said nothing about any of them.
 * The owner taps it at 22:30, nothing happens, nothing appears.
 *
 * The unreadable-amount case was the cruel one. revenueTotal scores an
 * unreadable box as 0, so the "Will save total" line directly under the dead
 * button still showed a plausible figure — and the red field that caused it
 * was two or three steps back, off-screen by the time the owner reached
 * review. Nothing on the screen connected the two.
 *
 * So the button now says which gate is closed, and for the unreadable one it
 * says WHERE: the wizard-ordered group (Revenue, Payments, Cash, Tips,
 * Gavekort, MOMS) that holds the offending box, so "go back" has a
 * destination.
 *
 * NOT FIXED, deliberately: a zero-revenue close is still refused. The money
 * layer's own rule is that "a counted drawer of 0 is a real answer, a sale of
 * 0 is not" (utils/currency.js), so the remedy there is to say why, not to
 * let it through.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isMoneyRejected, moneyLocale } from "../utils/currency";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "pages", "DailyClosePage.jsx"), "utf8");

/** Comments stripped, so a rule QUOTED in a WHY-comment is not mistaken for code. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

describe("a disabled Confirm & Lock explains itself", () => {
  it("the three gates are unchanged — this adds words, not permission", () => {
    expect(CODE).toMatch(/disabled=\{saving \|\| willSave === 0 \|\| moneyRejected\}/);
  });

  it("a sentence renders whenever the button is dead for a reason the owner can fix", () => {
    expect(CODE).toMatch(/!saving && \(moneyRejected \|\| willSave === 0\)/);
  });

  it("each gate gets its own words", () => {
    expect(CODE).toMatch(/dcLockBlockedAmountIn/);
    expect(CODE).toMatch(/dcLockBlockedAmount"/);
    expect(CODE).toMatch(/dcLockBlockedNoRevenue/);
  });

  it("the unreadable case names the group, so 'go back' has a destination", () => {
    const start = CODE.indexOf("const rejectedArea");
    expect(start).toBeGreaterThan(-1);
    const body = CODE.slice(start, start + 900);
    // Wizard order: the first hit is the EARLIEST step to return to.
    expect(body.indexOf('"revenue"')).toBeLessThan(body.indexOf('"payments"'));
    expect(body.indexOf('"payments"')).toBeLessThan(body.indexOf('"cash"'));
    expect(body).toMatch(/isMoneyRejected\(v, mLocale\)/);
  });

  it("a zero-revenue close is still refused, and says so", () => {
    // The rule lives in the money layer; this page must not quietly relax it.
    expect(CODE).toMatch(/willSave === 0/);
    expect(CODE).toMatch(/dcLockBlockedNoRevenue/);
  });
});

describe("the MOMS caption names where its number came from", () => {
  it("a scanned MOMS is not described as a calculation", () => {
    const start = CODE.indexOf("const momsSource");
    expect(start).toBeGreaterThan(-1);
    expect(CODE.slice(start, start + 500)).toMatch(/scannedMoms \? "scanned" : "computed"/);
    // The caption branches on it rather than asserting the multiplication.
    expect(CODE).toMatch(/momsSource === "scanned"[\s\S]{0,120}momsFromZReport/);
  });

  it("the scanned figure still wins — this changed the sentence, not the money", () => {
    // The till's own MOMS knows about split rates that revenue x 25/125
    // cannot, so what gets SAVED is deliberately untouched.
    const start = CODE.indexOf("const momsTotal");
    const body = CODE.slice(start, start + 700);
    expect(body).toMatch(/if \(scannedMoms\) return scannedMoms;/);
  });
});

describe("the parser the gate calls really does reject these", () => {
  const dk = moneyLocale("DKK");
  it.each(["3500,", "1.2.3", "abc", "12,,5"])("%s is refused", (typed) => {
    expect(isMoneyRejected(typed, dk)).toBe(true);
  });
  it.each(["3500", "3.500,50", "0"])("%s is accepted", (typed) => {
    expect(isMoneyRejected(typed, dk)).toBe(false);
  });
});
