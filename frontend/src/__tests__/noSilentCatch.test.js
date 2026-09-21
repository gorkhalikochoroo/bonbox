/**
 * A swallowed error is a lie the page tells on the author's behalf.
 *
 * `api.get(...).then(setRows).catch(() => {})` leaves the rows at `[]`, the
 * page falls through to its empty state, and the owner is told the comforting
 * thing instead of the true one. An audit found this on six of the seven
 * surfaces the product is built around:
 *
 *   • the kasserapport history said "Submit your first end-of-day close" to an
 *     owner with a year of them — and, because today's lock status came from
 *     that same empty array, re-offered a close it had locked ten minutes ago;
 *   • a failed week in Vagtplan looked like an empty week, and the page then
 *     labelled it "Published";
 *   • the Cash Book said the drawer had no transactions;
 *   • the bell said "All clear" when it had not managed to ask.
 *
 * The fix is hooks/useAsyncData.js — loading / failed / data — rendered as
 * <LoadFailed onRetry> INSTEAD of the empty state. This guard stops the old
 * shape coming back into the files that were converted.
 *
 * WHY A SOURCE GUARD AND NOT A RENDER TEST: these are 2,000–7,000-line pages
 * whose fetches sit behind tabs, entitlements and a branch selector. Mounting
 * one to prove a catch block is honest would pin the page's navigation far
 * more than the rule. The rule is "this shape is not allowed here", and that
 * is exactly what a source guard can say.
 *
 * An EMPTY catch is the target — `catch {}` or `catch (e) {}` with nothing in
 * it. A catch that sets a failure state, shows a toast, or re-throws is doing
 * its job and is not matched.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** The files this rollout converted. Add to this list, never remove from it. */
const CONVERTED = [
  "pages/CashBookPage.jsx",
  "pages/InventoryPage.jsx",
  "components/NotificationCenter.jsx",
  "pages/StaffHoursPage.jsx",
  "pages/StaffSchedulePage.jsx",
  "components/reservations/WaitlistSection.jsx",
  "pages/ExpensesPage.jsx",
  "pages/DailyClosePage.jsx",
];

/**
 * `.catch(() => {})` and `.catch(() => { })` — a promise tail that discards
 * the error and tells the caller nothing. Also the statement form with an
 * empty body.
 */
const SILENT_PROMISE_CATCH = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/g;
const SILENT_BLOCK_CATCH = /\bcatch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/g;

/**
 * Comments are REPLACED with a placeholder, not deleted.
 *
 * Deleting them was wrong in both directions, and the first run proved it:
 *
 *   catch {              →  stripping the // line leaves `catch { }`, which
 *     // best-effort         reads as empty. That flagged three catches in
 *   }                       DailyClosePage that already said why — punishing
 *                           the house comment style for being `//` rather
 *                           than a block comment.
 *
 *   // e.g. .catch(() => {})  →  a WHY-comment that QUOTES the shape would
 *                               match if comments were kept verbatim.
 *
 * Swapping each comment for a single token settles both: a block with a
 * reason in it is no longer empty, and a quoted example is no longer code.
 * So the rule this enforces is not "never swallow an error" — it is "if you
 * swallow one, say why", which is a thing a reviewer can check and a thing
 * the next reader actually benefits from.
 */
const codeOf = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "/*C*/")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1/*C*/");

describe("the converted surfaces do not swallow a load error", () => {
  it.each(CONVERTED)("%s", (rel) => {
    const code = codeOf(readFileSync(join(SRC, rel), "utf8"));
    const offenders = [
      ...(code.match(SILENT_PROMISE_CATCH) || []),
      ...(code.match(SILENT_BLOCK_CATCH) || []),
    ];
    expect(
      offenders,
      `${rel} still discards an error without telling the page.\n` +
        `An empty catch leaves the data at its initial value, so the EMPTY state\n` +
        `renders and the owner is told they have nothing — when the truth is that\n` +
        `we could not ask. Use useAsyncData + <LoadFailed onRetry>, or at minimum\n` +
        `set a failed state the render path checks BEFORE the empty state.\n` +
        `Found: ${offenders.join("  ")}`,
    ).toEqual([]);
  });
});

describe("the primitive itself keeps its contract", () => {
  it("useAsyncData does not clear data on failure", async () => {
    const src = readFileSync(join(SRC, "hooks", "useAsyncData.js"), "utf8");
    const catchBlock = src.slice(src.indexOf("} catch (e) {"), src.indexOf("} finally {"));
    // Blanking on failure replaces one lie with another: numbers that were
    // true a second ago vanish, and the owner cannot tell stale from gone.
    expect(catchBlock).not.toMatch(/setData\(/);
    expect(catchBlock).toMatch(/setFailed\(true\)/);
  });

  it("LoadFailed offers a way forward, not just a shrug", () => {
    const src = readFileSync(join(SRC, "components", "ui", "LoadFailed.jsx"), "utf8");
    expect(src).toMatch(/onRetry/);
    expect(src).toMatch(/t\("tryAgain"\)/);
    // Amber: nothing is lost and the owner has broken nothing. Red is for
    // money at risk.
    expect(src).toMatch(/severity="warn"/);
  });
});
