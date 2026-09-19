/**
 * The close page's SEND path, held to the same money rule as its screen.
 *
 * The daily-close surface was migrated onto <Amount> / formatOwnerMoney, so
 * every figure an owner reads there carries the DK token `kr.`. buildShareMessage
 * was not in that file list — it lives in utils/ — and kept its own formatter:
 * `Math.round(n).toLocaleString("da-DK") + " " + currency`. So one job emitted
 * two conventions: the screen said "17.030 kr." and the message the owner
 * forwarded to their revisor about that same close said "17.030 DKK".
 *
 * Worth being precise about the severity, because it is NOT the browser-locale
 * defect the page had: "da-DK" was pinned here, so the grouping was always
 * right and no number could be misread. This is a token-consistency defect on
 * one owner-visible artifact, and the fix is to route it through the same
 * primitive as everything else rather than to keep a second formatter honest
 * by hand.
 *
 * These assert the MESSAGE, not the formatter — the formatter has its own
 * tests in currency; what was missing was anything checking that this caller
 * used it.
 */
import { describe, it, expect } from "vitest";
import { buildShareMessage } from "../utils/shareClose";

const aggregated = {
  closed_by: "Sara",
  cards_total: 17030,
  cash_closing: 4248,
  mobilepay_total: 1500,
  payments_total: 22778,
  sales_pos: 22778,
  cash_difference: 0,
};

const build = (over = {}) =>
  buildShareMessage(
    { ...aggregated, ...over },
    { businessName: "Sekuwa", dateLabel: "6.3.2026 (Onsdag)", currency: "DKK" },
  );

describe("the shared close speaks the same currency as the screen", () => {
  it("renders kroner with the DK token", () => {
    expect(build()).toContain("17.030 kr.");
  });

  it("never emits the bare currency CODE for a DKK owner", () => {
    // The exact mixing the whole-page money migration exists to prevent — one
    // owner, one close, two conventions.
    expect(build()).not.toContain("DKK");
  });

  it("keeps da-DK grouping, so no figure can be read as a decimal", () => {
    // 17030 as "17,030" is seventeen kroner and three øre to a Dane. This was
    // never broken here (da-DK was pinned) and must not become broken by the
    // move onto the primitive.
    const text = build();
    expect(text).not.toContain("17,030");
    expect(text).toContain("4.248 kr.");
  });

  it("renders a missing figure as '—', not as a zero it did not measure", () => {
    const text = build({ mobilepay_total: null, sales_pos: null });
    expect(text).toContain("POS-salg: —");
    // A null MobilePay line is dropped entirely rather than reported as 0.
    expect(text).not.toContain("MobilePay:");
  });

  it("still signs a positive cash difference and leaves the minus on a negative", () => {
    expect(build({ cash_difference: 120 })).toContain("Forskel: +120 kr.");
    expect(build({ cash_difference: -120 })).toContain("Forskel: -120 kr.");
  });

  it("returns an empty string with no aggregate, rather than a header with holes", () => {
    expect(buildShareMessage(null, { currency: "DKK" })).toBe("");
  });
});
