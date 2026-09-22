/**
 * The tie-out has to reach the LOCK, not just the payments step.
 *
 * THE DEFECT: `balanceDiff = revenueTotal - paymentTotal` — the one line on
 * this surface that says "your day does not add up" — was computed once and
 * rendered in exactly one place: the payments step. But the path the product
 * PROMOTES after a Z-report scan is "Brug disse værdier — spring til
 * gennemgang", which calls `applyScanValues(true)` → `setStep(totalSteps)` and
 * drops the owner straight onto the review card. The payments step is never
 * walked. The review card then showed revenue and payments as two separate
 * totals in two separate cards with no difference between them, and the lock
 * button was disabled only for saving / zero-total / unreadable-amount.
 *
 * Net effect: the flow BonBox pushes owners into was the one flow in which a
 * kasserapport could be locked, signed, PDF'd and auto-emailed to the revisor
 * without a single word about the fact that it did not reconcile.
 *
 * The fix does NOT block the lock. An owner can be genuinely 200 kr short and
 * still has to file the day; the rule on this surface is say it plainly, not
 * prevent it. So these tests assert two things that pull in opposite
 * directions: the difference is STATED on the review card above Bekræft & lås,
 * and the lock's `disabled` expression is untouched by it.
 *
 * A SOURCE guard, for the same reason DailyClosePage.surfaceGuard.test.js is
 * one: the review step sits at the end of a five-step wizard behind a scan, a
 * prefill and a confirm dialog, so a render test for it pins the wizard's
 * navigation far harder than it pins the thing that was actually broken —
 * which is WHERE the number is rendered relative to the button.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "pages", "DailyClosePage.jsx"), "utf8");

/** The file with comments stripped, so a defect QUOTED in a WHY-comment (and
 *  this page is full of them) is never counted as the defect itself. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

const at = (needle) => CODE.indexOf(needle);

describe("the promoted scan path still lands on review", () => {
  it('"use these values" jumps to the last step', () => {
    // If this ever stops being true the defect changes shape, and the
    // placement assertions below stop describing the real risk.
    expect(CODE).toMatch(/setStep\(jumpToReview \? totalSteps : 1\)/);
  });
});

describe("the difference is stated on the review card", () => {
  it("the review branch renders the tie-out verdict", () => {
    expect(CODE).toMatch(/dcTieOutBalanced/);
    expect(CODE).toMatch(/dcTieOutOff/);
    expect(CODE).toMatch(/dcTieOutUnknown/);
  });

  it("it sits inside the review step and above Bekræft & lås", () => {
    const reviewStart = at('currentStepId === "review"');
    const lockButton = at('t("confirmAndLock"');
    const verdict = at('t("dcTieOutOff"');
    expect(reviewStart).toBeGreaterThan(-1);
    expect(lockButton).toBeGreaterThan(-1);
    expect(verdict).toBeGreaterThan(reviewStart);
    expect(verdict).toBeLessThan(lockButton);
  });

  it("it is the LAST thing on the card — nothing sits between it and the button", () => {
    // "Immediately above Bekræft & lås" is the whole requirement: an owner who
    // scrolls to the lock has to pass this line to reach it. Even the lock's
    // own failure banner renders above it, so the tie-out is never pushed off
    // the bottom of the card by something else appearing.
    const verdict = at('t("dcTieOutOff"');
    const errorBanner = at("{error && (");
    expect(errorBanner).toBeGreaterThan(-1);
    expect(verdict).toBeGreaterThan(errorBanner);
  });

  it("the figure goes through formatOwnerMoney with a sign, at ledger precision", () => {
    // A signed amount, because "differ by 1.200 kr" without a direction does
    // not tell the owner whether they are over or short. LEDGER_DECIMALS,
    // because every other figure on this card is at two decimals and a
    // difference that does not visibly reconcile the rows above it is worse
    // than no difference at all.
    expect(CODE).toMatch(
      /formatOwnerMoney\(tieOut\.diff, currency, \{ decimals: LEDGER_DECIMALS, sign: true \}\)/,
    );
  });
});

describe("the tie-out never blocks the lock", () => {
  it("the lock's disabled expression is still the original three gates", () => {
    expect(CODE).toMatch(
      /disabled=\{saving \|\| willSave === 0 \|\| moneyRejected\}/,
    );
  });

  it("nothing named tieOut appears in a disabled expression", () => {
    const disabledExprs = CODE.match(/disabled=\{[^}]*\}/g) || [];
    expect(disabledExprs.filter((e) => e.includes("tieOut"))).toEqual([]);
  });

  it("the off-by state says the lock is still available", () => {
    expect(CODE).toMatch(/dcTieOutOffHint/);
  });
});

describe("three outcomes, not two", () => {
  it('an unentered payments column is "unknown", not a difference', () => {
    // With payments untouched, revenue − payments equals the WHOLE revenue.
    // Printing that as "Difference: 17.030 kr" is a confident discrepancy
    // derived from a column nobody filled in — the same class of lie as a
    // not-known total rendered as a confident zero.
    expect(CODE).toMatch(
      /if \(!hasRevenueEntry \|\| !hasPaymentEntry\) return \{ state: "unknown", diff: null \}/,
    );
  });

  it("the payments step and the review card read ONE verdict", () => {
    // The old payments-step chip did its own `Math.abs(balanceDiff) < 1`
    // arithmetic. Two copies of the rule is two surfaces that can disagree
    // about whether the same day ties out.
    expect(CODE).not.toMatch(/Math\.abs\(balanceDiff\)/);
    expect(CODE).not.toMatch(/const balanceDiff\b/);
    const uses = CODE.match(/tieOut\.state/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });

  it("the verdict is computed in one place", () => {
    expect(CODE).toMatch(/const tieOut = useMemo\(/);
  });
});
