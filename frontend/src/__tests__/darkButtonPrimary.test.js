/**
 * B3 — the shared <Button variant="primary"> in dark.
 *
 * It inverted to `dark:bg-gray-100` (luminance 0.90): on the first-run
 * dashboard the "Tag din første kasserapport" hero CTA was the brightest slab
 * on a night screen. Dark is now the dark SOLID control (gray-600, white ink,
 * gray-500 hover). Disabled RECEDES to line-only (no fill, a line-strong
 * hairline, gray-400 ink): a gray-700 disabled fill sat only 1.36:1 from the
 * gray-600 enabled one, so "Registrer" on /sales went live with a small lift.
 *
 * This guard ships in the same commit as the change. The change touches every
 * primary Button in dark (43 files, guest pages included) and waits for the
 * owner's nod — dropping the commit drops this file with it and nothing else.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SURFACE_LADDER_HEX as L } from "../config/navChrome";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = (rel) =>
  readFileSync(join(SRC, rel), "utf8")
    .replace(/(^|[\s{(])\/\*[\s\S]*?\*\//g, "$1")
    .replace(/^\s*\/\/.*$/gm, "");

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const h = hex.replace("#", "");
  return (
    0.2126 * channel(parseInt(h.slice(0, 2), 16)) +
    0.7152 * channel(parseInt(h.slice(2, 4), 16)) +
    0.0722 * channel(parseInt(h.slice(4, 6), 16))
  );
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Tailwind 4 stops as the browser resolves them (oklch -> sRGB).
// index.css :root.dark --surface-line-strong (75 85 99), the hairline the disabled state draws.
const LINE_STRONG_DARK = "#4b5563";
const TW = { white: "#ffffff", gray100: "#f3f4f6", gray400: "#99a1af", gray600: "#4a5565", gray700: "#364153" };

describe("Button primary in dark", () => {
  const src = code("components/ui/Button.jsx").replace(/"\s*\+\s*"/g, " ");
  const primary = src.match(/primary:\s*FADE_WHEN_DISABLED \+\s*"([^"]*)"/);

  it("is the dark solid control, not a near-white slab", () => {
    expect(primary).not.toBeNull();
    expect(primary[1]).toContain("dark:bg-gray-600 dark:text-white dark:hover:bg-gray-500");
    expect(primary[1]).not.toMatch(/dark:(hover:)?bg-(white|gray-50|gray-100)(?![\w/.-])/);
    expect(primary[1]).toContain("dark:focus-visible:ring-gray-100");
    expect(luminance(TW.gray600)).toBeLessThan(0.2);
    expect(contrast(TW.white, TW.gray600)).toBeGreaterThanOrEqual(4.5);
  });

  it("disabled recedes to line-only: no fill, a line-strong hairline, gray-400 ink", () => {
    expect(primary[1]).toContain("dark:disabled:bg-transparent");
    expect(primary[1]).toContain("dark:disabled:text-gray-400");
    expect(primary[1]).toContain("dark:disabled:shadow-[inset_0_0_0_1px_rgb(var(--surface-line-strong))]");
    expect(primary[1]).not.toContain("dark:disabled:bg-gray-700");
    // the old pair, as numbers: a 1.36:1 fill step was the whole difference
    expect(contrast(TW.gray600, TW.gray700)).toBeLessThan(1.5);
    // now: enabled is a solid fill, disabled shows the card — a 1.94:1 fill
    // step, plus white -> gray-400 ink, plus a visible edge on the card
    expect(contrast(TW.gray600, L.card.dark)).toBeGreaterThan(1.9);
    expect(contrast(LINE_STRONG_DARK, L.card.dark)).toBeGreaterThanOrEqual(1.3);
    expect(contrast(TW.gray400, L.card.dark)).toBeGreaterThanOrEqual(4.5);
  });
});
