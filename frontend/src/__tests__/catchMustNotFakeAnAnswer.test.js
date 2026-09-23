/**
 * A `catch` may not invent data.
 *
 * THE PATTERN THIS FORBIDS, which this codebase has shipped repeatedly:
 *
 *     } catch {
 *       setData({ staff: [], totals: {} });   // or setRows([]), setItems([])
 *     }
 *
 * An empty array or an empty object is a MEASUREMENT — it says "we asked and
 * the answer is nothing". A failed request has not measured anything. Writing
 * one into state on failure makes the two indistinguishable downstream, and
 * every consumer then renders the reassuring one: an empty list reads as "no
 * staff", a `{}` of totals reads as zero problems, and a compliance tile whose
 * flag is `undefined` reads as "All compliant: No" in red.
 *
 * Real instances this guard is built from:
 *   • TimeRegistrationPage — `setData({ staff: [], totals: {} })` on failure,
 *     which rendered an Arbejdstidsloven verdict derived from a request that
 *     never arrived.
 *   • InventoryPage dead-stock — a venue with no demand signal was listed as
 *     having dead stock.
 *   • StaffHoursPage pickers — "No staff members yet" on a failed roster fetch.
 *
 * THE RULE: on failure, either keep the previous data, or set an explicit
 * failure flag and render a distinct state. Never synthesise an empty result.
 *
 * WHY THE SCAN STRIPS COMMENTS FIRST: a guard that forbids a code shape will
 * otherwise match the comment explaining why that shape was removed, and can
 * never go green. This file learned that the hard way twice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every .jsx/.js under src/, minus tests and the i18n catalogues. */
function sourceFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "i18n" || name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (/\.(jsx|js)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");

/** Catch blocks, as (whole match, body) pairs.
 *
 *  Braces are matched to three levels rather than lazily to the first `}`,
 *  because the very shape being hunted — `setData({ staff: [], totals: {} })`
 *  — contains nested braces, and a lazy match would cut the body in half and
 *  miss it. A newline-anchored close was also tried and silently skipped every
 *  single-line `} catch { setRows([]); }`, which is most of the real ones. */
const CATCH_BLOCK =
  /\}\s*catch\s*(?:\([^)]*\))?\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;

/** `.catch(() => …)` — the promise form, which is the DOMINANT shape here.
 *
 *  A statement-only guard reported this whole repo clean while
 *  `.catch(() => { if (alive) setLoad({}); })` — the exact line that motivated
 *  this rule — sat in ReservationsPage. A guard that returns all-clear next to
 *  its own counter-example is committing the defect it forbids, so it has to
 *  see both forms. */
const CATCH_ARROW = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{(?:[^{}]|\{[^{}]*\})*\}|[^)]*)\)/g;

/** A setter being handed a synthesised empty result.
 *
 *  `\{\s*\}` is listed FIRST and separately: a bare `{}` matched neither
 *  original alternative, because the object branch required at least one key.
 *  So `setLoad({})` was invisible twice over. */
const EMPTY_RESULT =
  /\bset[A-Z]\w*\(\s*(?:\[\s*\]|\{\s*\}|\{\s*(?:\w+\s*:\s*(?:\[\s*\]|\{\s*\})\s*,?\s*)+\})\s*\)/;

/** Something in the same block that RECORDS the failure.
 *
 *  This is the distinction that makes the rule usable. Clearing stale rows is
 *  fine — necessary, even — as long as the failure is also recorded, because
 *  then the UI can tell the two apart. ReservationPublicPage does exactly
 *  that: it clears the slots AND sets slotsError, so the guest is told the
 *  times could not be loaded rather than that the venue is full. A guard that
 *  flagged it would be teaching the wrong lesson. */
const RECORDS_FAILURE =
  /\bset\w*(?:Error|Err|Failed|Failure|Unavailable|Unknown)\w*\(|\bsetFailed\(|\bthrow\b|\bcaptureError\(|\bconsole\.(error|warn)\(/i;

function offendingCatch(code) {
  for (const re of [CATCH_BLOCK, CATCH_ARROW]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const body = m[1] || "";
      if (EMPTY_RESULT.test(body) && !RECORDS_FAILURE.test(body)) return body.trim();
    }
  }
  return null;
}

/**
 * Files that still do this, as of 2026-09-23.
 *
 * This list may only SHRINK. It is not permission — it is the debt, written
 * down so it cannot grow quietly while nobody is looking. A new file doing
 * this fails the first test below; a file cleaned up and not removed from here
 * fails the second.
 *
 * They are not equally bad, which is why they were not all fixed at once. A
 * search box that renders no matches on a failed query is a small lie; a bank
 * list that renders "not connected", a terminal list that renders empty on a
 * money screen, or a staff roster that renders nobody, are not. The four
 * highest-stakes ones were fixed first — the staffer's own absence record,
 * bank connections, and the compliance register — and the rest are ordinary
 * work, each needing its own honest failure state rather than a blanket
 * find-and-replace.
 */
const KNOWN_OFFENDERS = [
  "components/CloserPromptCard.jsx",
  "components/CustomerOutreachModal.jsx",
  "components/GodkendKo.jsx",
  "components/InventoryConsumptionModal.jsx",
  "components/NeedsYouQueue.jsx",
  "components/SickCallNotificationCard.jsx",
  "components/SmartDriftBanner.jsx",
  "components/SmartImportModal.jsx",
  "components/SwapRequestNotificationCard.jsx",
  "pages/AdminTrainingPage.jsx",
  "pages/CompetitorPage.jsx",
  "pages/ConnectionsPage.jsx",
  "pages/DailyClosePage.jsx",
  "pages/DoorScanPage.jsx",
  "pages/InsightsPage.jsx",
  "pages/JobCardPage.jsx",
  "pages/MultiTerminalClosePage.jsx",
  "pages/RegisterPage.jsx",
  "pages/ReservationPublicPage.jsx",
  "pages/ReservationsPage.jsx",
  "pages/StaffPayrollPage.jsx",
  "pages/StaffPortalPage.jsx",
  "pages/TerminalsPage.jsx",
  "pages/WineListPage.jsx",
];

describe("a catch may not invent data", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const code = stripComments(readFileSync(file, "utf8"));
    if (offendingCatch(code)) {
      offenders.push(file.slice(SRC.length + 1));
    }
  }

  it("no NEW file synthesises an empty result in a catch", () => {
    const fresh = offenders.filter((f) => !KNOWN_OFFENDERS.includes(f));
    expect(fresh).toEqual([]);
  });

  it("the debt list only shrinks — clean one up, delete its line", () => {
    const fixed = KNOWN_OFFENDERS.filter((f) => !offenders.includes(f));
    expect(fixed).toEqual([]);
  });

  it("the guard actually matches the shape it forbids", () => {
    // Without this, a broken regex would report a clean repo forever.
    const bad = `
      try { const r = await api.get("/x"); setData(r.data); }
      catch { setData({ staff: [], totals: {} }); }
    `;
    expect(offendingCatch(bad)).toBeTruthy();

    const badArray = `try { x(); }\ncatch (e) {\n  setRows([]);\n}`;
    expect(offendingCatch(badArray)).toBeTruthy();

    // The promise form — the dominant shape in this repo, and the one the
    // first version of this guard could not see at all.
    const badArrow = `p.then(ok).catch(() => { if (alive) setLoad({}); })`;
    expect(offendingCatch(badArrow)).toBeTruthy();

    // A bare {} — invisible to the original pattern, whose object branch
    // required at least one key.
    expect(offendingCatch(`try { x(); }\ncatch {\n  setLoad({});\n}`)).toBeTruthy();
  });

  it("the guard does not fire on the correct shapes", () => {
    // Keeping previous data.
    expect(offendingCatch(`try { x(); }\ncatch {\n  setFailed(true);\n}`)).toBeNull();
    // Setting null plus an explicit failure flag — what the fix looks like.
    expect(
      offendingCatch(`try { x(); }\ncatch {\n  setData(null);\n  setFailed(true);\n}`),
    ).toBeNull();
    // Clearing a list on PURPOSE outside a catch is fine.
    expect(offendingCatch(`const reset = () => setRows([]);`)).toBeNull();
    // THE IMPORTANT ONE: clearing stale rows is fine when the failure is also
    // recorded — that is ReservationPublicPage's shape, and it is correct.
    expect(
      offendingCatch(`try { x(); }\ncatch (e) {\n  setSlots([]);\n  setSlotsError("nope");\n}`),
    ).toBeNull();
  });

  it("the guard is not fooled by its own documentation", () => {
    const documented = `
      // We used to do: } catch { setRows([]); }
      try { x(); } catch { setFailed(true); }
    `;
    expect(offendingCatch(stripComments(documented))).toBeNull();
  });
});
