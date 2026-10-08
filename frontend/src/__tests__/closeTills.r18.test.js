/**
 * closeTills — round 18.
 *
 * Blocking 4: a till whose total box the owner emptied is still a till with
 * a total of its own — the next till's Z-bon is asked about, never folded
 * in as a page of it.
 */
import { describe, expect, it } from "vitest";
import { MERGE_SUM } from "../utils/dailyCloseScanMerge";
import {
  addScan, chooseTerminal, createTills, loadDraft, needsTerminalQuestion, savedTotal, tillTotals, typeIntoForm,
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
