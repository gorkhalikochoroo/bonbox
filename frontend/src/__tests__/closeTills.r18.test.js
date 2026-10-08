/**
 * closeTills — round 18.
 *
 * Blocking 4: a till whose total box the owner emptied is still a till with
 * a total of its own — the next till's Z-bon is asked about, never folded
 * in as a page of it.
 * Confusing: a retake of a bon already in the day can be thrown away
 * ("brug det ikke"); the card's total retyped unchanged is no correction.
 */
import { describe, expect, it } from "vitest";
import { MERGE_SUM } from "../utils/dailyCloseScanMerge";
import {
  addScan, cardView, chooseTerminal, createTills, dropPending, lastStep, loadDraft, momsOf, needsTerminalQuestion,
  savedTotal, sourceMetaOf, tillTotals, tillsReducer, typeIntoForm, undo,
} from "../utils/closeTills";

const L = "da-DK";
const BON_1500 = { revenue: {}, revenue_total: 1500, payments: { card: 1000, cash: 500 } };
const BON_4000 = { revenue: { food: 2400, drinks: 1600 }, revenue_total: 4000, payments: { card: 4000 } };
const BON_12000 = { revenue: { food: 7200, drinks: 4800 }, revenue_total: 12000, moms_total: 2400, payments: { card: 12000 } };
const PAGE = { revenue: { takeaway: 450 }, payments: { mobilepay: 450 } };

describe("closeTills r18 — an emptied total is still a till", () => {
  it("a total-only bon with its total emptied: the next bon with a total waits on the question", () => {
    let s = addScan(createTills(L), BON_1500, { photo: "a" });
    s = typeIntoForm(s, "revenue_total", "");
    expect(needsTerminalQuestion(s, BON_4000)).toBe(true);
    s = addScan(s, BON_4000, { photo: "b" });
    expect(s.pending).toHaveLength(1);
    s = chooseTerminal(s, MERGE_SUM);
    expect(tillTotals(s)).toHaveLength(2);
  });

  it("a split bon with its total emptied: asked, and summed it keeps both tills' money", () => {
    let s = addScan(createTills(L), BON_12000, { photo: "a" });
    s = typeIntoForm(s, "revenue_total", "");
    s = addScan(s, { ...BON_12000, revenue: { food: 12000 } }, { photo: "b" });
    expect(s.pending).toHaveLength(1);
    s = chooseTerminal(s, MERGE_SUM);
    expect(savedTotal(s)).toBe(24000);
  });

  it("a reopened draft whose saved total was emptied on the card is still the owner's till", () => {
    let s = loadDraft(createTills(L), { revenue: { food: "10.000" }, payments: { card: "17.030" }, total: 17030 });
    s = typeIntoForm(s, "revenue_total", "");
    s = addScan(s, BON_4000, { photo: "b" });
    expect(s.pending).toHaveLength(1);
  });

  it("a page with no total of its own still fills the till before it (unchanged)", () => {
    let s = addScan(createTills(L), PAGE, { photo: "p" });
    expect(needsTerminalQuestion(s, BON_4000)).toBe(false);
    s = addScan(s, BON_4000, { photo: "b" });
    expect(s.pending).toHaveLength(0);
    expect(tillTotals(s)).toHaveLength(1);
  });
});

describe("closeTills r18 — a retake of a bon already in the day: \"don't use it\"", () => {
  const TYPED = { revenue: { food: "14.000,50" }, payments: { card: "14.000,50" } };
  const BON_3000 = { revenue: { food: 2000, drinks: 1000 }, revenue_total: 3000, moms_total: 600, payments: { card: 3000 } };
  const summed = () => {
    let s = typeIntoForm(createTills(L), "revenue.food", "14.000,50", { form: TYPED, fromForm: true });
    s = addScan(s, BON_3000, { photo: "bon" });
    return chooseTerminal(s, MERGE_SUM);
  };

  it("typed 14.000,50 + bon 3.000 summed, the same bon photographed again: dropped, the day stays 17.000,50", () => {
    let s = summed();
    expect(savedTotal(s)).toBe(17000.5);
    s = addScan(s, BON_3000, { photo: "bon-again" });
    expect(s.pending).toHaveLength(1);
    s = dropPending(s);
    expect(s.pending).toHaveLength(0);
    expect(savedTotal(s)).toBe(17000.5);
    expect(tillTotals(s)).toEqual([14000.5, 3000]);
    expect(lastStep(s)).toBe("drop");
  });

  it("Fortryd brings the question back", () => {
    let s = addScan(summed(), BON_3000, { photo: "bon-again" });
    const asked = s;
    s = undo(dropPending(s));
    expect(s.pending).toHaveLength(1);
    expect(s.entries).toBe(asked.entries);
  });

  it("nothing waiting: nothing happens", () => {
    const s = summed();
    expect(dropPending(s)).toBe(s);
  });

  it("the reducer routes it", () => {
    const s = addScan(summed(), BON_3000, { photo: "x" });
    expect(tillsReducer(s, { type: "drop" }).pending).toHaveLength(0);
  });
});

describe("closeTills r18 — the card's total retyped unchanged is no correction", () => {
  const TILL1 = {
    revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
    payments: { card: 12000, cash: 4030, mobilepay: 1000 },
  };
  const keyIn = (s, field, value) => {
    let out = typeIntoForm(s, field, "");
    for (let i = 1; i <= value.length; i++) out = typeIntoForm(out, field, value.slice(0, i));
    return out;
  };

  it("one till: emptied and retyped as 17.030 — no edit, the bon's MOMS, nothing corrected", () => {
    const s0 = addScan(createTills(L), TILL1, { photo: "t1" });
    const s = keyIn(s0, "revenue_total", "17.030");
    expect(s.entries[0].edits).toEqual({});
    expect(cardView(s).revenue_total_text).toBeUndefined();
    expect(momsOf(s)).toMatchObject({ source: "zbon", value: 3406 });
    expect(sourceMetaOf(s, { revenue_breakdown: { food: 9000 } }).corrected).toEqual([]);
  });

  it("then Mad raised to 10.000: the day saves 18.030 — no \"corrected down by hand\"", () => {
    let s = keyIn(addScan(createTills(L), TILL1, { photo: "t1" }), "revenue_total", "17.030");
    s = typeIntoForm(s, "revenue.food", "10.000", { fromForm: true });
    expect(savedTotal(s)).toBe(18030);
    expect(sourceMetaOf(s, { revenue_breakdown: { food: 10000, drinks: 6000, takeaway: 2030 } }).corrected).toEqual(["rev:food"]);
  });

  it("a stray 0 typed and taken back is no correction either", () => {
    let s = addScan(createTills(L), TILL1, { photo: "t1" });
    s = typeIntoForm(s, "revenue_total", "17.0300");
    s = typeIntoForm(s, "revenue_total", "17.030");
    expect(s.entries[0].edits).toEqual({});
  });

  it("lines past the bon: the bon's own 17.030 typed over them IS a correction, and stays one", () => {
    let s = addScan(createTills(L), { ...TILL1, revenue: { ...TILL1.revenue, food: 10000 } }, { photo: "t1" });
    expect(savedTotal(s)).toBe(18030);
    s = keyIn(s, "revenue_total", "17.030");
    expect(savedTotal(s)).toBe(17030);
    expect(s.entries[0].edits).toHaveProperty("revenue_total");
    expect(sourceMetaOf(s, { revenue_breakdown: { food: 10000 } }).corrected).toEqual(["revenue_total"]);
  });

  it("two tills: the day's total retyped unchanged leaves no typed total on the card", () => {
    let s = addScan(createTills(L), TILL1, { photo: "t1" });
    s = addScan(s, BON_4000, { photo: "t2" });
    s = chooseTerminal(s, MERGE_SUM);
    s = keyIn(s, "revenue_total", "21.030");
    expect(savedTotal(s)).toBe(21030);
    expect(cardView(s).revenue_total_text).toBeUndefined();
    expect(s.entries.every((e) => !Object.prototype.hasOwnProperty.call(e.edits, "revenue_total"))).toBe(true);
  });

  it("two tills: a real correction still lands (21.530)", () => {
    let s = addScan(createTills(L), TILL1, { photo: "t1" });
    s = addScan(s, BON_4000, { photo: "t2" });
    s = chooseTerminal(s, MERGE_SUM);
    s = keyIn(s, "revenue_total", "21.530");
    expect(savedTotal(s)).toBe(21530);
    expect(cardView(s).revenue_total_text).toBe("21.530");
  });
});
