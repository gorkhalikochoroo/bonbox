/**
 * A caller may hide or show a StatCard, but never change how it lays out.
 *
 * THE DEFECT THIS GUARDS. To keep quiet tiles off a phone, ReservationsPage
 * passed `className="hidden sm:flex"` to three of its six KPI tiles. StatCard
 * stacks its label, value and helper in plain block flow, so `sm:flex` did not
 * just re-show those tiles from sm: up — it turned each into a ROW. On every
 * desktop the three read "AWAITING 0to confirm", "OCCUPANCY 0%of 28 seats",
 * "ON WAITLIST 0Waiting", next to three tiles that looked right.
 *
 * WHY A GREP AND NOT A RENDER TEST. jsdom applies no Tailwind and evaluates no
 * breakpoints; a rendered StatCard with `sm:flex` has the same DOM as a correct
 * one. The defect only exists in a real browser above 640px — which is where it
 * shipped from, unseen, until the owner photographed it.
 *
 * THE RULE. A className on <StatCard> may carry `hidden` / `block` (with any
 * breakpoint prefix), spacing and sizing — but no display utility that changes
 * the flow: flex, inline-flex, grid, inline-grid, inline, inline-block, table.
 *
 *     className={quiet ? "hidden sm:block" : ""}     ✅
 *     className={quiet ? "hidden sm:flex" : ""}      ❌
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

/** Comments out, newlines kept — so a reported line number is the real one. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every <StatCard …> opening tag, up to its closing `>` or `/>`. */
function statCardTags(src) {
  const tags = [];
  const re = /<StatCard\b/g;
  let m;
  while ((m = re.exec(src))) {
    // Walk to the tag's end, skipping `>` inside {…} expressions (arrow fns).
    let depth = 0;
    let i = m.index;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push({ at: m.index, text: src.slice(m.index, i + 1) });
  }
  return tags;
}

/** A display utility that changes flow, with or without a breakpoint prefix. */
const FLOW_CHANGER =
  /(?:^|[\s"'`{])(?:[a-z0-9[\]()]+:)*(?:flex|inline-flex|grid|inline-grid|inline|inline-block|table)(?=[\s"'`}]|$)/;

describe("StatCard keeps its own layout", () => {
  const files = sourceFiles(SRC);

  it("scans a real number of files", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("finds the StatCards it is meant to guard", () => {
    // If the tag walker broke, every file would look clean.
    const total = files.reduce(
      (n, f) => n + statCardTags(stripComments(readFileSync(f, "utf8"))).length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it("no caller passes a display utility that turns the tile into a row", () => {
    const offenders = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const tag of statCardTags(src)) {
        const cls = tag.text.match(/className=(\{[\s\S]*?\}|"[^"]*")/);
        if (!cls) continue;
        if (FLOW_CHANGER.test(cls[1])) {
          const line = src.slice(0, tag.at).split("\n").length;
          offenders.push(`${relative(SRC, file)}:${line}  ${cls[1].replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(
      offenders,
      "A StatCard className changes its display. StatCard stacks label, value " +
        "and helper in block flow; `flex`/`grid`/`inline` turns it into a row. " +
        "To re-show a hidden tile at a breakpoint use `sm:block`, not `sm:flex`.",
    ).toEqual([]);
  });
});
