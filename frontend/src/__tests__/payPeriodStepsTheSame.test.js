/**
 * "Previous" must mean one thing on one screen.
 *
 * THE DEFECT, found by walking the pay-my-staff journey rather than reading
 * code. StaffHoursPage and StaffPayrollPage are two TABS OF THE SAME SCREEN
 * (/staff/hours), reading the same /staff/pay-period/current config — and they
 * stepped the period differently.
 *
 *   Hours   snapped calendar frames to the real boundary via computePayPeriod
 *   Payroll shifted both ends by a raw day count: (end - start) + 1
 *
 * On a calendar-month venue standing on 1.-31. marts:
 *
 *   Timer  ←   1. feb  – 28. feb      correct
 *   Løn    ←   28. jan – 27. feb      four January days in, 28. feb dropped
 *
 * And the Løn window is the one that builds /staff/payroll/estimate, the
 * revisor CSV and the LØNSEDDEL PDF — whose filename then prints those wrong
 * dates as though somebody chose them. The owner tapping ← to pull last
 * month's payslips gets a signed, five-year-retained document covering days
 * that are not the month it names. The frame selector directly beneath it
 * still read "Calendar month (1st → end)".
 *
 * Nothing on screen contradicted it, and no test caught it, because each tab's
 * own arithmetic was internally consistent. The bug lived in the GAP.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computePayPeriod, stepPayPeriod, CALENDAR_FRAMES, addDays } from "../utils/payPeriod";

const back = (type, from, to, startDay) => stepPayPeriod(type, startDay, from, to, "prev");
const fwd = (type, from, to, startDay) => stepPayPeriod(type, startDay, from, to, "next");

describe("stepping back from March lands on February, not on January", () => {
  it("the exact production case", () => {
    expect(back("monthly_1st", "2026-03-01", "2026-03-31")).toEqual({
      from: "2026-02-01", to: "2026-02-28",
    });
  });

  it("the old day-count arithmetic is what it must NOT do", () => {
    // 31 days back from 1 March is 28 January — the defect, pinned so the
    // regression is recognisable if it returns. addDays (the module's own,
    // timezone-safe) rather than toISOString, which shifts the date.
    const naive = addDays("2026-03-01", -31);
    expect(naive).toBe("2026-01-29");
    expect(back("monthly_1st", "2026-03-01", "2026-03-31").from).not.toBe(naive);
  });

  it("no January days are pulled into February", () => {
    // The drifted window was 29. jan - 28. feb: three January days inside a
    // document headed February, on a payslip retained five years.
    const p = back("monthly_1st", "2026-03-01", "2026-03-31");
    expect(p.from).toBe("2026-02-01");
    expect(p.to).toBe("2026-02-28");
  });

  it("a leap February is whole", () => {
    expect(back("monthly_1st", "2028-03-01", "2028-03-31")).toEqual({
      from: "2028-02-01", to: "2028-02-29",
    });
  });
});

describe("every frame steps onto a real boundary", () => {
  it("monthly_15th keeps its 15th→14th shape", () => {
    expect(back("monthly_15th", "2026-03-15", "2026-04-14")).toEqual({
      from: "2026-02-15", to: "2026-03-14",
    });
  });

  it("custom keeps its anchor day", () => {
    const p = back("custom", "2026-03-16", "2026-04-15", 16);
    expect(p.from).toBe("2026-02-16");
    expect(p.to).toBe("2026-03-15");
  });

  it("weekly steps exactly one week", () => {
    expect(back("weekly", "2026-09-21", "2026-09-27")).toEqual({
      from: "2026-09-14", to: "2026-09-20",
    });
  });

  it("biweekly steps exactly a fortnight", () => {
    const p = back("biweekly", "2026-09-21", "2026-10-04");
    expect(p.from).toBe("2026-09-07");
    expect(p.to).toBe("2026-09-20");
  });
});

describe("periods tile — no gap, no overlap", () => {
  it("back then forward returns to where you were", () => {
    for (const [type, from, to, sd] of [
      ["monthly_1st", "2026-03-01", "2026-03-31", null],
      ["monthly_15th", "2026-03-15", "2026-04-14", null],
      ["weekly", "2026-09-21", "2026-09-27", null],
      ["biweekly", "2026-09-21", "2026-10-04", null],
      ["custom", "2026-03-16", "2026-04-15", 16],
    ]) {
      const b = back(type, from, to, sd);
      const round = fwd(type, b.from, b.to, sd);
      expect({ type, ...round }).toEqual({ type, from, to });
    }
  });

  it("consecutive months abut exactly — nobody's shift falls in the gap", () => {
    let cur = { from: "2026-01-01", to: "2026-01-31" };
    for (let i = 0; i < 24; i++) {
      const next = fwd("monthly_1st", cur.from, cur.to);
      expect(next.from).toBe(addDays(cur.to, 1));
      cur = next;
    }
  });
});

describe("the definition is shared, not copied", () => {
  it("calendar frames are the ones that snap", () => {
    expect(CALENDAR_FRAMES).toContain("monthly_1st");
    expect(CALENDAR_FRAMES).toContain("monthly_15th");
    expect(CALENDAR_FRAMES).toContain("custom");
    // weekly/biweekly are span-based: shifting by their own length IS correct.
    expect(CALENDAR_FRAMES).not.toContain("weekly");
    expect(CALENDAR_FRAMES).not.toContain("biweekly");
  });

  it("computePayPeriod agrees with what stepping produces", () => {
    const stepped = back("monthly_1st", "2026-03-01", "2026-03-31");
    const direct = computePayPeriod("monthly_1st", null, "2026-02-14");
    expect(stepped).toEqual(direct);
  });
});


/** The page source, comments stripped — a guard must not match the comment
 *  explaining the bug it forbids. */
const PAYROLL = (() => {
  const raw = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "pages", "StaffPayrollPage.jsx"),
    "utf8",
  );
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
})();

describe("the Løn tab actually uses the shared stepper", () => {
  // Testing the util alone was VACUOUS: reverting the page to its own
  // day-count arithmetic left all twelve util tests green. The regression
  // lives in whether the page CALLS this, so that is what gets asserted.

  it("navigatePeriod calls stepPayPeriod", () => {
    expect(PAYROLL).toMatch(/stepPayPeriod\(/);
    expect(PAYROLL).toMatch(/import \{ stepPayPeriod \} from "\.\.\/utils\/payPeriod"/);
  });

  it("it passes the FRAME, not just the dates", () => {
    // Without period_type the stepper cannot know whether to snap or shift,
    // and silently falls back to shifting — the original bug, restored.
    expect(PAYROLL).toMatch(/stepPayPeriod\(\s*\n?\s*periodCfg\.period_type/);
  });

  it("the day-count arithmetic is gone", () => {
    expect(PAYROLL).not.toMatch(
      /const len = Math\.round\(\s*\n?\s*\(new Date\(period\.period_end\)/,
    );
  });
});
