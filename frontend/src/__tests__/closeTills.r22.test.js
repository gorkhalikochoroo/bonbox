/**
 * closeTills — round 22, confusing item 3 (desktop lane, C4).
 *
 * Two Z-bons summed that carry no category lines (17.030 Kort 12.000; 5.000
 * Kontant 5.000), then the owner splits the day in the DAY's boxes: Mad
 * 14.000, Drikkevarer 5.000, Takeaway 3.030, and the MobilePay no bon had.
 * distribute() spreads each over the tills by room, so a later line lands
 * wholly on one till — and oneSidedLines named it "ikke lagt sammen" beside
 * a review that adds up ("Dine egne tal … er ikke lagt sammen: Drikkevarer,
 * Takeaway, MobilePay"). A line typed in the day's box after the sum that no
 * till carries of its own is the day's split, not a till's figure: never
 * named. A line a till does carry (Kontant read on one bon, retyped after the
 * sum) still is (DailyClosePage.r20Confusing / r16ReviewFixes).
 */
import { describe, expect, it } from "vitest";
import { MERGE_SUM } from "../utils/dailyCloseScanMerge";
import { addScan, chooseTerminal, createTills, oneSidedLines, savedTotal, typeIntoForm } from "../utils/closeTills";

const L = "da-DK";
const bon = (o) => ({ revenue: {}, payments: {}, ...o });
const T1 = bon({ revenue_total: 17030, moms_total: 3406, payments: { card: 12000 } });
const T2 = bon({ revenue_total: 5000, payments: { cash: 5000 } });

const keyIn = (s, field, value) => {
  let out = typeIntoForm(s, field, "");
  for (let i = 1; i <= value.length; i++) out = typeIntoForm(out, field, value.slice(0, i));
  return out;
};
const summed = (a = T1, b = T2) => chooseTerminal(addScan(addScan(createTills(L), a, { photo: "a" }), b, { photo: "b" }), MERGE_SUM);

describe("closeTills r22 — the day's own split after a sum is never \"ikke lagt sammen\"", () => {
  it("the reviewers' repro: Mad, Drikkevarer, Takeaway and MobilePay typed after the sum — nothing named", () => {
    let s = summed();
    expect(savedTotal(s)).toBe(22030);
    s = keyIn(s, "revenue.food", "14000");
    s = keyIn(s, "revenue.drinks", "5000");
    s = keyIn(s, "revenue.takeaway", "3030");
    s = keyIn(s, "payments.mobilepay", "5030");
    expect(savedTotal(s)).toBe(22030);
    expect(oneSidedLines(s).own).toEqual([]);
    // The bons' own one-sided lines (Kort on one, Kontant on the other) are
    // the read line's, as before.
    expect(oneSidedLines(s).read).toEqual(["payments.card", "payments.cash"]);
  });

  it("each line on its own, as the owner tabs through: never named at any point", () => {
    let s = summed();
    for (const [f, v] of [["revenue.food", "14000"], ["revenue.drinks", "5000"], ["revenue.takeaway", "3030"], ["payments.mobilepay", "5030"]]) {
      s = keyIn(s, f, v);
      expect(oneSidedLines(s).own).toEqual([]);
    }
  });

  it("a line one bon carries, retyped after the sum, is still named (Kontant)", () => {
    let s = summed();
    s = keyIn(s, "payments.cash", "500");
    expect(oneSidedLines(s).own).toContain("payments.cash");
  });

  it("a line read on one bon and not typed is still named as one bon's (read)", () => {
    const s = summed(bon({ revenue: { food: 9000 }, revenue_total: 17030, payments: { card: 12000 } }), T2);
    expect(oneSidedLines(s).read).toContain("revenue.food");
  });
});
