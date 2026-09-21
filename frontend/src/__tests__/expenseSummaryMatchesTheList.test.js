/**
 * The expense summary must describe the rows the table is showing.
 *
 * THE BUG. ExpensesPage renders a DataTable over `filtered` (search +
 * personal/business + category) and, directly beneath it, a one-line summary
 * reduced over `expenses` — the whole fetched array. Two numbers about two
 * different sets of rows, 200px apart.
 *
 * This was not an edge case. `showFilter` defaults to "business", so on a
 * plain page load the table already excludes personal expenses while the
 * total still included them. The damaging case is the one an owner builds for
 * their revisor: set "Business only", read a business-only table, and the
 * line underneath quietly adds their personal spending back in. The count was
 * the only tell — "23 expenses" printed under a table showing 12 rows.
 *
 * The sibling half of this (the date-range label saying "Denne måned" for a
 * filtered quarter) was fixed earlier; the total itself was not.
 *
 * SCOPE OF THIS GUARD: it is source-level. It pins that the summary is
 * computed from the filtered rows and re-runs when the filters change, which
 * is exactly the regression to fear — someone reaching for `expenses` because
 * it reads more naturally. It cannot prove the rendered count equals the
 * rendered row count; mounting ExpensesPage needs seven hooks, a router and
 * the api client mocked, and that test would break on unrelated changes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "pages", "ExpensesPage.jsx"), "utf8");

/** The body of the monthSummary useMemo, including its dependency array. */
function summaryMemo() {
  const start = SOURCE.indexOf("const monthSummary = useMemo(");
  expect(start, "monthSummary memo not found — test needs updating").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("filterTo]", start);
  expect(end, "monthSummary dependency array not found").toBeGreaterThan(start);
  return SOURCE.slice(start, end + "filterTo]".length);
}

describe("the expense summary and the expense table agree", () => {
  it("sums the filtered rows, not the whole fetched array", () => {
    const memo = summaryMemo();
    expect(
      /const rows = scoped \? filtered : filtered\.filter\(/.test(memo),
      "rows must come from `filtered` — the array the DataTable renders",
    ).toBe(true);
    // The specific regression: reducing over the unfiltered fetch.
    expect(
      /\bexpenses\.(filter|reduce)\(/.test(memo),
      "monthSummary must not read `expenses` directly; that is the defect",
    ).toBe(false);
  });

  it("recomputes when any filter the table honours changes", () => {
    const memo = summaryMemo();
    const deps = memo.slice(memo.lastIndexOf("}, ["));
    for (const dep of ["filtered", "search", "showFilter", "categoryFilter"]) {
      expect(deps, `missing dependency: ${dep} — summary would go stale`).toContain(dep);
    }
  });

  it("stops calling itself 'this month' once the owner narrows the view", () => {
    // showFilter's default is "business", so the default view is NOT narrowed
    // — flagging it would be noise on every load.
    expect(SOURCE).toMatch(/const \[showFilter, setShowFilter\] = useState\("business"\)/);
    const memo = summaryMemo();
    expect(memo).toMatch(/showFilter !== "business"/);
    expect(SOURCE).toMatch(/monthSummary\.narrowed\s*\?\s*t\("expFilteredSummary"/);
  });

  it("the empty case is judged on the filtered rows too", () => {
    const memo = summaryMemo();
    expect(
      /if \(filtered\.length === 0\)/.test(memo),
      "an empty FILTERED list is the empty case, not an empty fetch",
    ).toBe(true);
  });
});
