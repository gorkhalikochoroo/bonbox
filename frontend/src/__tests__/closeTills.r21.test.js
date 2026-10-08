/**
 * closeTills — round 21, item 5 (phone lane, C4).
 *
 * Two Z-bons summed (14.000 fully split Mad 9.000 + Drikke 5.000; 2.000 all
 * Mad) and the owner raises Mad from 11.000 to 11.500 on the card. The raise
 * lands on the last till carrying Mad (no till has unsplit room), so that
 * till saves 2.500 — but its bon printed 2.000. readTotalsOf kept that edit
 * (only a typed total was stripped), so read == terminal, no read_totals
 * went, and the revisor's line read "2 terminaler lagt sammen: 14.000 +
 * 2.500" — a till figure on no receipt and no screen.
 *
 * Now a scanned till's read figure is what its bon printed — every edit on
 * it is the owner's correction: read_totals [14.000, 2.000] beside
 * terminal_totals [14.000, 2.500], and the server prints "Z-bon 1: 14.000 ·
 * Z-bon 2: 2.000 · rettet af ejeren til 16.500" (backend
 * test_daily_close_r21::test_a_category_raised_on_a_summed_day…).
 */
import { describe, expect, it } from "vitest";
import { MERGE_SUM } from "../utils/dailyCloseScanMerge";
import {
  addScan, chooseTerminal, createTills, loadDraft, readTotalsOf, savedTotal, sourceMetaOf, tillFromForm, tillTotals, typeIntoForm,
} from "../utils/closeTills";

const L = "da-DK";
const BON_14000 = { revenue: { food: 9000, drinks: 5000 }, revenue_total: 14000, moms_total: 2800, payments: { card: 14000 } };
const BON_2000 = { revenue: { food: 2000 }, revenue_total: 2000, moms_total: 400, payments: { card: 2000 } };
// Bon 1 split only partly: 5.000 of it is unsplit room.
const BON_14000_ROOM = { revenue: { food: 9000 }, revenue_total: 14000, moms_total: 2800, payments: { card: 14000 } };

const keyIn = (s, field, value) => {
  let out = typeIntoForm(s, field, "");
  for (let i = 1; i <= value.length; i++) out = typeIntoForm(out, field, value.slice(0, i));
  return out;
};
const summed = (first = BON_14000) => {
  const s = addScan(createTills(L), first, { photo: "a" });
  return chooseTerminal(addScan(s, BON_2000, { photo: "b" }), MERGE_SUM);
};

describe("closeTills r21 — a category raised on a summed day is the owner's, never one bon's read", () => {
  it("Mad 11.000 → 11.500: read_totals [14.000, 2.000] beside terminal_totals [14.000, 2.500]", () => {
    let s = summed();
    expect(tillTotals(s)).toEqual([14000, 2000]);
    s = keyIn(s, "revenue.food", "11500");
    expect(savedTotal(s)).toBe(16500);
    // The raise sits on the last till carrying Mad (no unsplit room left).
    expect(tillTotals(s)).toEqual([14000, 2500]);
    // What each bon PRINTED.
    expect(readTotalsOf(s)).toEqual([14000, 2000]);
    const meta = sourceMetaOf(s, { revenue_breakdown: { food: 11500, drinks: 5000 }, payment_breakdown: { card: 16000 } });
    expect(meta.terminal_totals).toEqual([14000, 2500]);
    expect(meta.read_totals).toEqual([14000, 2000]);
    expect(meta.corrected).toContain("rev:food");
  });

  it("a raise that only fills a bon's unsplit room changes no till: no read_totals", () => {
    let s = summed(BON_14000_ROOM);
    s = keyIn(s, "revenue.food", "11500");
    expect(tillTotals(s)).toEqual([14000, 2000]);
    expect(readTotalsOf(s)).toEqual([14000, 2000]);
    const meta = sourceMetaOf(s, { revenue_breakdown: { food: 11500 }, payment_breakdown: { card: 16000 } });
    expect(meta.read_totals).toBeUndefined();
  });

  it("untouched: the tills are what the bons read, nothing beside them", () => {
    const s = summed();
    const meta = sourceMetaOf(s, { revenue_breakdown: { food: 11000, drinks: 5000 }, payment_breakdown: { card: 16000 } });
    expect(meta.terminal_totals).toEqual([14000, 2000]);
    expect(meta.read_totals).toBeUndefined();
  });

  it("the day's total typed (round 19) still names each bon's own figure", () => {
    let s = summed();
    s = keyIn(s, "revenue_total", "16500");
    expect(readTotalsOf(s)).toEqual([14000, 2000]);
    expect(sourceMetaOf(s).read_totals).toEqual([14000, 2000]);
  });

  it("a typed till keeps its own lines as its read figure", () => {
    const form = tillFromForm({ revenue: { food: "3.000" }, payments: { card: "3.000" }, locale: L });
    let s = typeIntoForm(createTills(L), "revenue.food", "3.000", { form, fromForm: true });
    s = chooseTerminal(addScan(s, BON_2000, { photo: "b", form }), MERGE_SUM);
    expect(tillTotals(s)).toEqual([3000, 2000]);
    expect(readTotalsOf(s)).toEqual([3000, 2000]);
  });

  it("a reopened draft's own till is untouched by the rule (its saved lines are its read)", () => {
    let s = loadDraft(createTills(L), { revenue: { food: 10000 }, payments: { card: 10000 }, total: 10000 });
    s = chooseTerminal(addScan(s, BON_2000, { photo: "b" }), MERGE_SUM);
    expect(readTotalsOf(s)).toEqual(tillTotals(s));
  });
});
