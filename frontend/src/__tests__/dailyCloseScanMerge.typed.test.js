/**
 * Round 16: a line nobody read off a photo stays the owner's through a sum.
 *
 * The form (a reopened draft, a typed close) can now be the first side of a
 * two-till sum. A sum turns every line into a number, and a number is what the
 * card calls "aflæst" — so the form's lines (and anything typed on the card)
 * are listed in merge_info.typedFields instead, and a later page that reads
 * the line makes it a read again.
 */
import { describe, expect, it } from "vitest";
import { MERGE_FILL, MERGE_REPLACE, MERGE_SUM, mergeScans, scanBonTotal } from "../utils/dailyCloseScanMerge";

const FORM = {
  revenue: { food: "9.600", drinks: "5.500", takeaway: "2.030" },
  payments: { card: "12.000", cash: "5.130" },
  revenue_total: 17130,
  from_draft: true,
};
const TILL2 = { revenue: {}, revenue_total: 4000, moms_total: 800, payments: { card: 4000 } };

describe("mergeScans — typed lines", () => {
  it("a form summed with a till keeps every form line typed; the till's own MOMS stays one-sided", () => {
    const m = mergeScans(FORM, TILL2, MERGE_SUM);
    expect(m.revenue_total).toBe(21130);
    expect(m.payments).toEqual({ card: 16000, cash: 5130 });
    expect(new Set(m.merge_info.typedFields)).toEqual(new Set([
      "revenue.food", "revenue.drinks", "revenue.takeaway", "payments.card", "payments.cash",
    ]));
    expect(m.merge_info.incompleteFields).toContain("moms_total");
    // The form's total is no bon's.
    expect(scanBonTotal(m)).toBeNull();
    expect(m.from_draft).toBeUndefined();
  });

  it("two read tills have no typed lines; a card correction on one is typed", () => {
    const t1 = { revenue: { food: 9000 }, revenue_total: 17030, payments: { card: 12000, cash: "5.130" } };
    const m = mergeScans(t1, TILL2, MERGE_SUM);
    expect(m.merge_info.typedFields).toEqual(["payments.cash"]);
    const both = mergeScans({ revenue: { food: 9000 }, revenue_total: 17030, payments: { card: 12000 } }, TILL2, MERGE_SUM);
    expect(both.merge_info.typedFields).toBeUndefined();
  });

  it("typed lines carry through a third till, and a page that reads the line makes it a read", () => {
    const two = mergeScans(FORM, TILL2, MERGE_SUM);
    const three = mergeScans(two, { revenue: {}, revenue_total: 1000, payments: { mobilepay: 1000 } }, MERGE_SUM);
    expect(three.merge_info.typedFields).toEqual(expect.arrayContaining(["revenue.food", "payments.card"]));
    expect(three.merge_info.typedFields).not.toContain("payments.mobilepay");

    const page = mergeScans(two, { revenue: { food: 9700 } }, MERGE_FILL);
    expect(page.revenue.food).toBe(9700);
    expect(page.merge_info.typedFields).not.toContain("revenue.food");
    expect(page.merge_info.typedFields).toContain("revenue.drinks");
  });

  it("\"same till\" starts over from the photo: nothing typed", () => {
    const two = mergeScans(FORM, TILL2, MERGE_SUM);
    const replaced = mergeScans(two, TILL2, MERGE_REPLACE);
    expect(replaced.merge_info.typedFields).toBeUndefined();
  });
});
