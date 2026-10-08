/**
 * closeTills — round 19.
 *
 * Confusing 2: after two Z-bons are summed and the owner corrects the day's
 * total by hand, the record names each till's own figure (the bon's read
 * total, or the typed till's) beside the till list, so the kasserapport can
 * print "Z-bon 1: 17.030 · Z-bon 2: 4.000 · rettet af ejeren til 21.500" —
 * never the correction as one till's ("4.470" for a bon that read 4.000).
 * The till list itself still adds up to what is saved (the server drops a
 * list that does not).
 *
 * Confusing 3: with no photo left in the day, a form that filed a photo's
 * source for the day earlier in the session (`restore`) says again what the
 * record is: the reopened draft's own source, or typed — never null, which
 * the server reads as "keep the Z-bon".
 *
 * Found by the extended sequences (seed 1508): a till whose total box was
 * emptied stays an empty (red) day total however many tills are summed —
 * folding a third one in turned it into the bons' "3.000" under a day that
 * saves 8.234,50.
 */
import { describe, expect, it } from "vitest";
import { MERGE_REPLACE, MERGE_SUM } from "../utils/dailyCloseScanMerge";
import {
  addScan, cardView, chooseTerminal, createTills, discardScans, loadDraft, readTotalsOf, savedTotal, sourceMetaOf,
  tillFromForm, tillTotals, typeIntoForm,
} from "../utils/closeTills";

const L = "da-DK";
const TOTAL_ONLY_17030 = { revenue: {}, revenue_total: 17030, payments: {} };
const BON_4000 = { revenue: { food: 3000 }, revenue_total: 4000, payments: { card: 4000 } };
const BON_3000 = { revenue: { food: 2000, drinks: 1000 }, revenue_total: 3000, moms_total: 600, payments: { card: 3000 } };
const PARTIAL_9876 = { revenue: {}, revenue_total: 9876.5, payments: {} };

/** Keystroke by keystroke, the way the box hands them over. */
const keyIn = (s, field, value) => {
  let out = typeIntoForm(s, field, "");
  for (let i = 1; i <= value.length; i++) out = typeIntoForm(out, field, value.slice(0, i));
  return out;
};
const typed14000 = () => {
  const form = tillFromForm({ revenue: { food: "9.000", drinks: "5.000" }, payments: { card: "14.000" }, locale: L });
  return { s: typeIntoForm(createTills(L), "revenue.food", "9.000", { form, fromForm: true }), form };
};

describe("closeTills r19 — the owner's correction of a summed total is never one till's", () => {
  it("17.030 + 4.000 summed, 21.500 typed: tills read 17.030 and 4.000, the list still adds up to 21.500", () => {
    let s = addScan(createTills(L), TOTAL_ONLY_17030, { photo: "a" });
    s = chooseTerminal(addScan(s, BON_4000, { photo: "b" }), MERGE_SUM);
    s = keyIn(s, "revenue_total", "21500");
    expect(savedTotal(s)).toBe(21500);
    const meta = sourceMetaOf(s);
    expect(meta.terminal_totals).toEqual([17030, 4470]);
    expect(meta.read_totals).toEqual([17030, 4000]);
    expect(meta.corrected).toContain("revenue_total");
    expect(readTotalsOf(s)).toEqual([17030, 4000]);
  });

  it("no correction: no read_totals (the list is what each bon read)", () => {
    let s = addScan(createTills(L), TOTAL_ONLY_17030, { photo: "a" });
    s = chooseTerminal(addScan(s, BON_4000, { photo: "b" }), MERGE_SUM);
    expect(sourceMetaOf(s).read_totals).toBeUndefined();
    // Retyped as the day's own figure: still no correction.
    s = keyIn(s, "revenue_total", "21030");
    expect(sourceMetaOf(s).read_totals).toBeUndefined();
  });

  it("a bon corrected before the sum (9.876,50 → 9.900): its read figure goes beside the list", () => {
    let s = addScan(createTills(L), PARTIAL_9876, { photo: "a" });
    s = keyIn(s, "revenue_total", "9900");
    s = chooseTerminal(addScan(s, { ...TOTAL_ONLY_17030, revenue_total: 17030 }, { photo: "b" }), MERGE_SUM);
    const meta = sourceMetaOf(s);
    expect(meta.terminal_totals).toEqual([9900, 17030]);
    expect(meta.read_totals).toEqual([9876.5, 17030]);
  });

  it("a typed close + a 3.000 bon, the total typed 17.500: the typed till's own 14.000 and the bon's 3.000", () => {
    const { s: typed, form } = typed14000();
    let s = chooseTerminal(addScan(typed, BON_3000, { photo: "b", form }), MERGE_SUM);
    s = keyIn(s, "revenue_total", "17500");
    const meta = sourceMetaOf(s, { revenue_breakdown: { food: 9000, drinks: 5000 } });
    expect(meta.terminal_totals).toEqual([14500, 3000]);
    expect(meta.read_totals).toEqual([14000, 3000]);
    expect(meta.typed_tills).toEqual([0]);
    expect(tillTotals(s)).toEqual([14500, 3000]);
  });
});

describe("closeTills r19 — no photo left: the record is told again what it is", () => {
  it("a reopened typed draft + a summed bon, then Start forfra: null as before, its own source with restore", () => {
    let s = loadDraft(createTills(L), {
      revenue: { food: "9.000", drinks: "5.000" }, payments: { card: "14.000" }, total: 14000, meta: { kind: "typed" },
    });
    s = chooseTerminal(addScan(s, BON_3000, { photo: "b", form: tillFromForm({ revenue: { food: "9.000", drinks: "5.000" }, payments: { card: "14.000" }, locale: L }) }), MERGE_SUM);
    expect(sourceMetaOf(s).kind).toBe("zbon");
    s = discardScans(s);
    // Nothing filed since it was opened: the server keeps what it knows.
    expect(sourceMetaOf(s)).toBeNull();
    // A Z-bon's source was filed for the day this session: said again.
    expect(sourceMetaOf(s, { restore: true })).toEqual({ kind: "typed" });
  });

  it("a reopened Z-bon draft keeps its own read on restore; a typed close is typed either way", () => {
    const zbonMeta = { kind: "zbon", scans: 1, corrected: [] };
    let z = loadDraft(createTills(L), { revenue: { food: "17.030" }, payments: { card: "17.030" }, total: 17030, meta: zbonMeta });
    z = discardScans(chooseTerminal(addScan(z, BON_3000, { photo: "b", form: tillFromForm({ revenue: { food: "17.030" }, payments: { card: "17.030" }, locale: L }) }), MERGE_SUM));
    expect(sourceMetaOf(z, { restore: true })).toEqual(zbonMeta);
    const { s: typed } = typed14000();
    expect(sourceMetaOf(typed, { restore: true })).toEqual({ kind: "typed" });
    expect(sourceMetaOf(typed)).toEqual({ kind: "typed" });
  });

  it("restore never relabels a day that still has a photo in it", () => {
    let s = addScan(createTills(L), BON_3000, { photo: "a" });
    expect(sourceMetaOf(s, { restore: true }).kind).toBe("zbon");
    s = discardScans(s);
    // Nothing left: no source to file (the page files nothing for an empty day).
    expect(sourceMetaOf(s, { restore: true })).toEqual({ kind: "typed" });
  });
});

describe("closeTills r19 — an emptied till total stays empty in a sum of three", () => {
  const T1500 = { revenue_total: 1500, payments: { card: 1000, cash: 500 } };
  it("a reopened draft's total emptied, Start forfra, two 1.500 bons summed: the day's box stays empty (red), never \"3.000\"", () => {
    let d = loadDraft(createTills(L), {
      revenue: { food: "4.000", drinks: "1.234,50" }, payments: { card: "13.264,50" }, total: 13264.5, moms: "2.652,90", meta: { kind: "typed" },
    });
    d = typeIntoForm(d, "revenue_total", "");
    d = discardScans(chooseTerminal(addScan(d, { revenue_total: 4000, payments: { card: 4000 } }, { photo: "p1" }), MERGE_REPLACE));
    d = chooseTerminal(addScan(d, T1500, { photo: "p2" }), MERGE_SUM);
    expect(cardView(d).revenue_total_text).toBe("");
    d = chooseTerminal(addScan(d, T1500, { photo: "p3" }), MERGE_SUM);
    expect(tillTotals(d)).toEqual([5234.5, 1500, 1500]);
    expect(cardView(d).revenue_total_text).toBe("");
  });

  it("a total typed on the first till still becomes the sum's figure (unchanged)", () => {
    let s = addScan(createTills(L), { revenue_total: 16450, payments: { card: 16450 } }, { photo: "a" });
    s = typeIntoForm(s, "revenue_total", "16.500");
    s = chooseTerminal(addScan(s, { revenue_total: 5000, payments: { card: 5000 } }, { photo: "b" }), MERGE_SUM);
    s = chooseTerminal(addScan(s, T1500, { photo: "c" }), MERGE_SUM);
    expect(savedTotal(s)).toBe(23000);
    expect(cardView(s).revenue_total_text).toBe("23.000");
  });
});
