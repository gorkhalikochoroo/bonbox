/**
 * The per-staff hours list is what an owner reads before paying.
 *
 * BonBox does not run payroll — it tracks time, and the owner takes this list
 * and pays from it. So the list IS the product, and its order is not cosmetic.
 *
 * THE BUG. /staff/hours/summary builds its rows from a set union
 * (`hours_staff_ids | tips_map | sched_map`), so they arrive in no order at
 * all. On the live account that meant sixteen staff in scrambled order, of
 * whom two had hours — the fourteen zero rows sat wherever Python's set
 * iteration put them, burying the two people about to be paid.
 *
 * WHAT THIS PINS:
 *   • anyone with hours sorts above anyone without;
 *   • within those, most hours first — the biggest number to check is the
 *     first one you read;
 *   • everyone else stays alphabetical, so the list does not reshuffle
 *     between loads (a table that reorders on refresh cannot be trusted to
 *     have been read);
 *   • NOBODY is filtered out. A rostered no-show is what the DIFF column is
 *     for, and hiding them would hide the shift that needs an answer.
 */
import { describe, it, expect } from "vitest";

// The REAL comparator, imported — not a copy that can drift from it.
import { orderForPaying } from "../pages/StaffHoursPage";

const names = (rows) => orderForPaying(rows).map((r) => r.staff_name);

describe("the list leads with the people you are about to pay", () => {
  it("anyone with hours sorts above anyone without", () => {
    // The live shape: two worked, the rest are rostered or idle.
    const rows = [
      { staff_name: "demo", actual_hours: 0 },
      { staff_name: "sangita", actual_hours: 0 },
      { staff_name: "Agnes", actual_hours: 6.85 },
      { staff_name: "Aksel", actual_hours: 0 },
      { staff_name: "Bo", actual_hours: 12.45 },
    ];
    expect(names(rows).slice(0, 2)).toEqual(["Bo", "Agnes"]);
  });

  it("most hours first — the biggest number to check is read first", () => {
    const rows = [
      { staff_name: "A", actual_hours: 2 },
      { staff_name: "B", actual_hours: 40 },
      { staff_name: "C", actual_hours: 12.5 },
    ];
    expect(names(rows)).toEqual(["B", "C", "A"]);
  });

  it("the zero rows stay alphabetical so the list does not reshuffle", () => {
    const rows = [
      { staff_name: "Clara", actual_hours: 0 },
      { staff_name: "Aksel", actual_hours: 0 },
      { staff_name: "Bo", actual_hours: 0 },
    ];
    expect(names(rows)).toEqual(["Aksel", "Bo", "Clara"]);
  });

  it("sorts Danish letters the Danish way", () => {
    // Æ Ø Å come AFTER z in Danish. A default sort buries Åse mid-list.
    const rows = [
      { staff_name: "Åse", actual_hours: 0 },
      { staff_name: "Bo", actual_hours: 0 },
      { staff_name: "Æble", actual_hours: 0 },
    ];
    expect(names(rows)).toEqual(["Bo", "Æble", "Åse"]);
  });

  it("nobody is dropped — a no-show still has to be answerable", () => {
    const rows = [
      { staff_name: "worked", actual_hours: 8 },
      { staff_name: "noshow", actual_hours: 0, scheduled_hours: 6.25, needs_answer_count: 1 },
    ];
    const out = orderForPaying(rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.staff_name === "noshow")).toBeTruthy();
  });

  it("is stable and total-preserving — sorting must not change what is owed", () => {
    const rows = [
      { staff_name: "A", actual_hours: 3, total: 435 },
      { staff_name: "B", actual_hours: 0, total: 0 },
      { staff_name: "C", actual_hours: 7.5, total: 1087.5 },
    ];
    const before = rows.reduce((s, r) => s + r.total, 0);
    const after = orderForPaying(rows).reduce((s, r) => s + r.total, 0);
    expect(after).toBe(before);
  });

  it("survives a missing or empty list", () => {
    expect(orderForPaying(undefined)).toEqual([]);
    expect(orderForPaying([])).toEqual([]);
    expect(names([{ actual_hours: 1 }, { actual_hours: 0 }])).toEqual([undefined, undefined]);
  });
});
