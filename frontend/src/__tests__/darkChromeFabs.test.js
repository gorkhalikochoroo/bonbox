/**
 * B4 — the app chrome's solid controls in dark: the phone bottom-nav "+", the
 * desktop AI FAB (BonBoxAgent) and the desktop QuickAdd "+".
 *
 * They inverted to `dark:bg-gray-100` (luminance ~0.90): on every phone page
 * the brightest thing on a night screen was the "+" disc. Dark now uses the
 * dark SOLID control (gray-600, white ink, gray-500 hover).
 *
 * This guard ships in the same commit as the change, because the change is
 * app-wide chrome that waits for the owner's nod — dropping the commit drops
 * this file with it and nothing else.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = (rel) =>
  readFileSync(join(SRC, rel), "utf8")
    .replace(/(^|[\s{(])\/\*[\s\S]*?\*\//g, "$1")
    .replace(/^\s*\/\/.*$/gm, "");
const classStrings = (rel) => {
  const src = code(rel).replace(/"\s*\+\s*"/g, " ");
  return [...src.matchAll(/"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g)].map((m) =>
    m[0].slice(1, -1).replace(/\s+/g, " ").trim(),
  );
};
const SLAB = /dark:(hover:|active:|focus:|focus-visible:)?bg-(white|gray-50|gray-100)(?![\w/.-])/;

describe("the chrome FABs are no near-white slab in dark", () => {
  it.each([
    "components/MobileBottomNav.jsx",
    "components/BonBoxAgent.jsx",
    "components/QuickAdd.jsx",
  ])("%s", (rel) => {
    expect(classStrings(rel).filter((s) => SLAB.test(s))).toEqual([]);
    expect(classStrings(rel).some((s) => /dark:bg-gray-600(?![\w/-])/.test(s) && /dark:text-white/.test(s))).toBe(true);
  });
});
