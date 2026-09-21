/**
 * A card with a hardcoded light background must not carry dark: text.
 *
 * THE BUG. The stand pairing code is rendered on a card whose background is an
 * inline style:
 *
 *     background: "linear-gradient(180deg,#ffffff,#f7f9fc)"
 *
 * An inline gradient is invisible to dark mode — it stays white in both
 * themes. The code itself was `text-gray-900 dark:text-gray-100`, so in dark
 * mode it painted #f3f4f6 on #ffffff: a contrast ratio of about 1.05:1. The
 * six-digit code an owner has to read aloud to pair a host stand was not
 * faint in dark mode, it was *gone*, and the surrounding card looked perfectly
 * normal — so it reads as "the code failed to generate", not "the code is
 * invisible".
 *
 * WHY NO GUARD CAUGHT IT: contrast linting compares a Tailwind text class
 * against a Tailwind background class. Here the background is not a class at
 * all. Any element that opts out of the theme system with an inline colour has
 * to opt its children out too, and nothing was checking that.
 *
 * WHAT THIS PINS: inside any element carrying a hardcoded light gradient
 * background, no descendant declares a dark: text colour.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

// Files known to paint a hardcoded light surface. Add to this list rather than
// loosening the rule.
const FILES = ["pages/ReservationsPage.jsx"];

// A light hardcoded gradient/colour: starts at #fff or #ffffff.
const LIGHT_BG = /background:\s*["'`]linear-gradient\([^"'`]*#f{3,6}[^"'`]*["'`]/gi;

/**
 * Strip comments before matching. A comment explaining *why* a class was
 * removed necessarily names that class, so scanning raw source makes the guard
 * fire on its own documentation. Replace with spaces to keep offsets stable.
 */
function stripComments(s) {
  return s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (m) => " ".repeat(m.length)) // {/* jsx */}
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)) // /* block */
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length)); // // line
}

/** Return the source slice of the JSX element that owns `style={{...}}` at idx. */
function elementBodyAfter(source, idx) {
  // Walk forward from the style block to the end of this element's children by
  // tracking the JSX tag depth from the opening tag that contains idx.
  const openTagEnd = source.indexOf(">", idx);
  if (openTagEnd < 0) return "";
  let depth = 1;
  let i = openTagEnd + 1;
  const start = i;
  while (i < source.length && depth > 0) {
    if (source.startsWith("</", i)) depth -= 1;
    else if (source[i] === "<" && /[A-Za-z]/.test(source[i + 1] || "")) depth += 1;
    i += 1;
    if (depth === 0) break;
    // Bound the scan so a malformed match cannot run to EOF.
    if (i - start > 4000) break;
  }
  return source.slice(start, i);
}

describe("hardcoded light cards do not carry dark: text", () => {
  for (const rel of FILES) {
    it(`${rel} keeps dark: text off its hardcoded light surfaces`, () => {
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      const offenders = [];

      for (const m of source.matchAll(LIGHT_BG)) {
        const body = elementBodyAfter(source, m.index);
        for (const d of body.matchAll(/dark:text-[a-z]+-\d+/g)) {
          const line = source.slice(0, m.index).split("\n").length;
          offenders.push(`${rel} (light card near line ${line}): ${d[0]}`);
        }
      }

      expect(
        offenders,
        `dark: text on a background dark mode cannot change — it will render ` +
          `near-white on near-white:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  it("finds the pairing-code card at all (guard is not scanning an empty set)", () => {
    const source = readFileSync(join(SRC, "pages/ReservationsPage.jsx"), "utf8");
    const hits = [...source.matchAll(LIGHT_BG)];
    expect(hits.length, "the hardcoded light gradient should still exist").toBeGreaterThan(0);
    // And the code itself must still be dark-on-light.
    expect(source).toMatch(/text-\[32px\][^"]*text-gray-900(?!\s+dark:)/);
  });
});
