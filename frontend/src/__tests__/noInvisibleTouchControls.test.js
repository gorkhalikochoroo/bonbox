/**
 * A control may not be invisible on a touch device while still being tappable.
 *
 * THE DEFECT THIS GUARDS. StaffSchedulePage's shift-template chip carried a
 * remove button classed `opacity-0 group-hover:opacity-100`. On a phone
 * `group-hover` never matches, so its computed opacity stayed 0 — and
 * `opacity: 0` does NOT remove an element from hit-testing. Combined with the
 * coarse-pointer `min-height: 44px` floor in index.css, every template chip
 * carried a 12 x 44px INVISIBLE strip on its right edge wired to a delete that
 * writes straight to localStorage with no confirm and no undo. Reaching for
 * the chip destroyed the template instead of arming it.
 *
 * WHY A GREP AND NOT A RENDER TEST. jsdom does not evaluate media queries or
 * `:hover`, so no amount of rendering reproduces it — the bug is invisible to
 * every tool the repo already runs, which is exactly how it shipped. The
 * correct pattern was ALREADY in the same file, ~150 lines below
 * (OpenShiftChip), which is the real lesson: one author got it right and the
 * next did not, and nothing caught the difference.
 *
 * THE RULE. If an element hides itself with `opacity-0` and reveals on hover,
 * the hide must be gated on hover actually existing:
 *
 *     [@media(hover:hover)]:opacity-0 group-hover:opacity-100      ✅
 *     opacity-0 group-hover:opacity-100                            ❌
 *
 * `group-hover:opacity-0` (hide ON hover) is fine — it is visible at rest.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(jsx?|tsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

/** A class list that hides at rest and reveals on hover, with no hover guard. */
const OFFENDER = /(?<![\w:[])opacity-0\b(?![\w-])/;
const HOVER_REVEAL = /group-hover:opacity-(?:100|1\b)/;
const HOVER_GUARD = /\[@media\(hover:hover\)\]:opacity-0/;
/** An overlay that cannot be tapped is not an invisible CONTROL. */
const NOT_A_TARGET = /pointer-events-none/;

/**
 * Comments out first — and the first version of this guard did not, which is
 * why its very first run reported four offenders of which TWO were prose:
 * a fixed file whose comment quotes the old broken class list, and this
 * guard's own motivating comment. A stylesheet or class-name guard that
 * matches English instead of code reports defects that are not there, and a
 * guard that cries wolf is one somebody deletes.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block + JSX {/* … */} bodies
    .replace(/^\s*\/\/.*$/gm, "");      // whole-line //
}

describe("no control is invisible-but-tappable on touch", () => {
  const files = sourceFiles(SRC);

  it("scans a real number of files (the guard itself must not silently pass)", () => {
    // A guard that walks an empty tree reports every codebase clean.
    expect(files.length).toBeGreaterThan(150);
  });

  it("every hover-revealed control guards its hidden state on hover capability", () => {
    const offenders = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      if (!HOVER_REVEAL.test(src)) continue;
      src.split("\n").forEach((line, i) => {
        if (!HOVER_REVEAL.test(line)) return;
        if (!OFFENDER.test(line)) return;      // not hidden at rest
        if (HOVER_GUARD.test(line)) return;    // correctly guarded
        if (NOT_A_TARGET.test(line)) return;   // invisible, but not tappable
        offenders.push(`${relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "Hidden at rest + revealed on hover, with no [@media(hover:hover)] guard. " +
        "On a touch device this stays at opacity 0 and is STILL tappable — an " +
        "invisible control. Gate the hide: `[@media(hover:hover)]:opacity-0`.",
    ).toEqual([]);
  });
});
