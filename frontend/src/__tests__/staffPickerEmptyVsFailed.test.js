/**
 * "No staff members yet" must mean we ASKED and the answer was nobody.
 *
 * THE DEFECT. Both staff pickers on Hours › Log labelled their placeholder
 * option from the array length:
 *
 *     {staffList.length === 0
 *       ? t("shpNoStaffYetOption", "No staff members yet")
 *       : t("shpSelectStaff", "Select staff...")}
 *
 * `staffList` is `[]` in three different situations — the roster is genuinely
 * empty, the request is still in flight, or the request FAILED — and the
 * length can tell them apart in none of them. So an owner with nine staff
 * whose roster call 500'd was told, in the form they came to use, that they
 * had no staff. That is the comforting-and-false answer this page has spent
 * its whole history removing; StaffHoursPage already computes `rosterEmpty`
 * for exactly this reason and says so in a comment above it, but the two
 * pickers never received it.
 *
 * WHY IT MATTERS BEYOND THE WORDING. The two readings send the owner to
 * different places. "No staff yet" is a prerequisite — go add someone. "Could
 * not load staff" is a fault — retry, or come back. Printing the first when
 * the second is true costs the owner a trip to a Staff page that already has
 * their whole team on it, and teaches them the product lies about state.
 *
 * WHAT THIS PINS. The label is keyed off the three-outcome flags, never off
 * the length, in BOTH pickers, and the props that carry those flags survive
 * the whole chain: staffQ.failed → LoggingSection → each form.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "pages", "StaffHoursPage.jsx"), "utf8");
const LANG = readFileSync(join(HERE, "..", "hooks", "useLanguage.jsx"), "utf8");

/** Source with comments stripped — a guard that matches the prose explaining
 *  the bug it forbids is a guard that can never go green. */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

describe("the picker placeholder distinguishes empty from failed", () => {
  it("never decides the label from the array length", () => {
    // The exact shape of the old bug. If this reappears in either picker the
    // failed-fetch case silently becomes "you have no staff" again.
    expect(CODE).not.toMatch(/staffList\.length === 0\s*\n?\s*\?\s*t\("shpNoStaffYetOption"/);
  });

  it('claims "no staff yet" only from rosterEmpty', () => {
    const claims = CODE.match(/t\("shpNoStaffYetOption"/g) || [];
    expect(claims.length).toBe(2); // both pickers, neither dropped

    // Every occurrence is guarded by rosterEmpty on the line above it.
    const guarded = CODE.match(/rosterEmpty\s*\n?\s*\?\s*t\("shpNoStaffYetOption"/g) || [];
    expect(guarded.length).toBe(2);
  });

  it("gives the failure its own sentence, not a shrug", () => {
    // Without this branch an owner whose roster failed would fall through to
    // "Select staff…" over an empty list — the very thing the original
    // comment in this file calls "a list that failed to render".
    const failedBranch = CODE.match(/staffFailed\s*\n?\s*\?\s*t\("shpStaffLoadFailedOption"/g) || [];
    expect(failedBranch.length).toBe(2);
  });
});

describe("the flags actually reach the pickers", () => {
  it("both forms declare the props", () => {
    expect(CODE).toMatch(
      /function QuickLogForm\(\{[^}]*rosterEmpty[^}]*staffFailed[^}]*\}\)/,
    );
    expect(CODE).toMatch(
      /function ClockInOutForm\(\{[^}]*rosterEmpty[^}]*staffFailed[^}]*\}\)/,
    );
  });

  it("both call sites pass them", () => {
    expect(CODE).toMatch(/<QuickLogForm[^>]*rosterEmpty=\{rosterEmpty\}[^>]*staffFailed=\{staffFailed\}/);
    expect(CODE).toMatch(/<ClockInOutForm[^>]*rosterEmpty=\{rosterEmpty\}[^>]*staffFailed=\{staffFailed\}/);
  });

  it("LoggingSection receives the live failure flag, not a literal", () => {
    // staffQ.failed is the query's own state. A hardcoded `false` here would
    // make every branch above unreachable while still reading as correct —
    // the same defect class as the dashboard's hardcoded dailyCloseRanToday.
    expect(CODE).toMatch(/staffFailed=\{staffQ\.failed\}/);
    expect(CODE).not.toMatch(/staffFailed=\{false\}/);
  });

  it("rosterEmpty still means asked-and-answered", () => {
    // If this ever collapses back to `staffList.length === 0`, every guard
    // above keeps passing while the bug returns underneath them.
    expect(CODE).toMatch(
      /const rosterEmpty\s*=\s*\n?\s*!staffQ\.loading && !staffQ\.failed && staffList\.length === 0/,
    );
  });
});

describe("the new string is real in both shipped languages", () => {
  // `t(key, fallback)` returns the fallback for a missing key, so a picker
  // with no Danish entry would render English to a Danish owner and no test
  // that only exercises behaviour would notice.
  it("has an English entry", () => {
    expect(LANG).toMatch(/shpStaffLoadFailedOption:\s*"Could not load staff"/);
  });

  it("has a Danish entry, and it is not the English one", () => {
    const all = LANG.match(/shpStaffLoadFailedOption:\s*"([^"]+)"/g) || [];
    expect(all.length).toBe(2);
    expect(LANG).toMatch(/shpStaffLoadFailedOption:\s*"Kunne ikke hente medarbejdere"/);
  });
});
