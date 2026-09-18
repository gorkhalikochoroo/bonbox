/**
 * Two Z-bon scans, one kasserapport.
 *
 * THE BUG: every incoming field overwrote, so a café with a bar till and a
 * counter till scanned both and locked ONE till's revenue into a signed
 * kasserapport. Below the anomaly threshold nothing warned them. The copy
 * around the flow promised the opposite ("tilføj flere sider, så samler vi
 * tallene").
 *
 * The rule pinned here: we only ASK when both scans carry a headline total,
 * and a summed result must be honest about what it could not add.
 */
import { describe, expect, it } from "vitest";

import {
  headlineTotal,
  mergeScans,
  needsTerminalChoice,
  MERGE_FILL,
  MERGE_REPLACE,
  MERGE_SUM,
} from "../utils/dailyCloseScanMerge";

/** Bar till — 17.030 kr, card-heavy. */
const barTill = {
  revenue: { food: 4200, drinks: 12830 },
  payments: { card: 14000, cash: 3030 },
  revenue_total: 17030,
  moms_total: 3406,
  tips: 400,
  raw_text: "BAR KASSE 1\nTOTAL 17030",
  confidence: "high",
};

/** Counter till — 4.210 kr, no MOMS line printed. */
const counterTill = {
  revenue: { food: 4210 },
  payments: { card: 4210 },
  revenue_total: 4210,
  raw_text: "DISK KASSE 2\nTOTAL 4210",
  confidence: "medium",
};

describe("headlineTotal", () => {
  it("reads revenue_total", () => {
    expect(headlineTotal(barTill)).toBe(17030);
  });

  it("falls back to a total inside revenue / payments", () => {
    expect(headlineTotal({ revenue: { total: 900 } })).toBe(900);
    expect(headlineTotal({ payments: { grand_total: 750 } })).toBe(750);
  });

  it("is null when there is no headline number to compare", () => {
    expect(headlineTotal({ revenue: { food: 120 } })).toBeNull();
    expect(headlineTotal({ revenue_total: 0 })).toBeNull();
    expect(headlineTotal(null)).toBeNull();
  });
});

describe("needsTerminalChoice", () => {
  it("asks when both scans claim a total — that is the ambiguous case", () => {
    expect(needsTerminalChoice(barTill, counterTill)).toBe(true);
  });

  it("does not ask for a genuine second page (only one total between them)", () => {
    const page2 = { payments: { mobilepay: 2100 }, raw_text: "side 2" };
    expect(needsTerminalChoice(barTill, page2)).toBe(false);
  });

  it("does not ask on the first scan", () => {
    expect(needsTerminalChoice(null, barTill)).toBe(false);
  });
});

describe("mergeScans — another terminal (sum)", () => {
  const merged = mergeScans(barTill, counterTill, MERGE_SUM);

  it("adds the headline totals", () => {
    expect(merged.revenue_total).toBe(21240);
  });

  it("adds a category both tills rang up, and keeps one only one of them has", () => {
    expect(merged.revenue.food).toBe(8410);   // 4200 + 4210
    expect(merged.revenue.drinks).toBe(12830); // bar till only
  });

  it("adds payments", () => {
    expect(merged.payments.card).toBe(18210); // 14000 + 4210
    expect(merged.payments.cash).toBe(3030);
  });

  it("never turns a missing field into 0", () => {
    // The counter till printed no MOMS and no tips. Zero-filling either would
    // under-declare MOMS on a signed kasserapport.
    expect(merged.moms_total).toBe(3406);
    expect(merged.tips).toBe(400);
    const noTips = mergeScans(
      { revenue_total: 100, raw_text: "a" },
      { revenue_total: 50, raw_text: "b" },
      MERGE_SUM,
    );
    expect(noTips.tips).toBeUndefined();
    expect(noTips.moms_total).toBeUndefined();
  });

  it("says which lines it could NOT add up rather than inventing a number", () => {
    expect(merged.merge_info.incompleteFields).toContain("moms_total");
    expect(merged.merge_info.incompleteFields).toContain("tips");
    expect(merged.merge_info.incompleteFields).toContain("revenue.drinks");
    expect(merged.merge_info.incompleteFields).not.toContain("revenue_total");
    expect(merged.merge_info.incompleteFields).not.toContain("revenue.food");
  });

  it("records the per-till totals so a wrong tap is visible before it locks", () => {
    expect(merged.merge_info.mode).toBe(MERGE_SUM);
    expect(merged.merge_info.scans).toBe(2);
    expect(merged.merge_info.terminalTotals).toEqual([17030, 4210]);
  });

  it("keeps each till's raw_text — the audit trail behind a summed number", () => {
    expect(merged.terminal_raw_texts).toEqual([
      "BAR KASSE 1\nTOTAL 17030",
      "DISK KASSE 2\nTOTAL 4210",
    ]);
  });

  it("reflects the merge in the confidence — an incomplete sum is not 'high'", () => {
    // Plenty of fields found (would score "high"), but MOMS and tips cover
    // only one of the two tills, so the result is honestly one notch down.
    expect(merged.confidence).toBe("medium");
  });

  it("stays 'high' when nothing was left un-added", () => {
    const a = { revenue: { food: 10 }, payments: { card: 10 }, revenue_total: 10, moms_total: 2, tips: 1 };
    const b = { revenue: { food: 5 }, payments: { card: 5 }, revenue_total: 5, moms_total: 1, tips: 1 };
    const clean = mergeScans(a, b, MERGE_SUM);
    expect(clean.merge_info.incompleteFields).toEqual([]);
    expect(clean.confidence).toBe("high");
    expect(clean.moms_total).toBe(3);
  });

  it("keeps the first till's per-terminal detail and flags it rather than fusing it", () => {
    const withDetail = mergeScans(
      { ...barTill, payments_view: { card_breakdown: { dankort: 14000 } } },
      { ...counterTill, payments_view: { card_breakdown: { visa: 4210 } } },
      MERGE_SUM,
    );
    expect(withDetail.payments_view.card_breakdown).toEqual({ dankort: 14000 });
    expect(withDetail.merge_info.incompleteFields).toContain("payments_view");
  });

  it("accumulates across a third till", () => {
    const third = { revenue_total: 1000, revenue: { food: 1000 }, raw_text: "KASSE 3" };
    const threeTills = mergeScans(merged, third, MERGE_SUM);
    expect(threeTills.revenue_total).toBe(22240);
    expect(threeTills.merge_info.scans).toBe(3);
    expect(threeTills.merge_info.terminalTotals).toEqual([17030, 4210, 1000]);
    expect(threeTills.terminal_raw_texts).toHaveLength(3);
  });
});

describe("mergeScans — same terminal (replace)", () => {
  it("lets the new photo win, exactly as a retake should", () => {
    const sharper = { ...counterTill, revenue_total: 17030, revenue: { food: 4200, drinks: 12830 } };
    const merged = mergeScans(barTill, sharper, MERGE_REPLACE);
    expect(merged.revenue_total).toBe(17030);
    expect(merged.revenue.drinks).toBe(12830);
  });

  it("does not leave a stale 'tills added together' chip over single-till numbers", () => {
    const summed = mergeScans(barTill, counterTill, MERGE_SUM);
    expect(summed.merge_info.mode).toBe(MERGE_SUM);
    const corrected = mergeScans(summed, { ...barTill, raw_text: "BEDRE FOTO" }, MERGE_REPLACE);
    expect(corrected.merge_info.mode).toBe(MERGE_REPLACE);
    expect(corrected.merge_info.scans).toBe(1);
    expect(corrected.revenue_total).toBe(17030);
  });
});

describe("mergeScans — multi-page (no competing total)", () => {
  it("still fills in the blanks exactly as it did before", () => {
    const page2 = {
      payments: { mobilepay: 2100 },
      tips: 550,
      raw_text: "side 2",
    };
    const merged = mergeScans(barTill, page2, MERGE_FILL);
    expect(merged.revenue_total).toBe(17030);        // untouched
    expect(merged.revenue.drinks).toBe(12830);       // untouched
    expect(merged.payments.mobilepay).toBe(2100);    // added
    expect(merged.payments.card).toBe(14000);        // untouched
    expect(merged.tips).toBe(550);                   // last scan wins
    expect(merged.raw_text).toContain("side 2");
    expect(merged.merge_info).toBeUndefined();       // no question was asked
  });

  it("defaults to the fill merge when no mode is passed", () => {
    const merged = mergeScans(barTill, { payments: { mobilepay: 2100 } });
    expect(merged.payments.mobilepay).toBe(2100);
    expect(merged.revenue_total).toBe(17030);
  });

  it("returns the incoming scan untouched when there is nothing to merge into", () => {
    expect(mergeScans(null, barTill)).toBe(barTill);
  });
});
