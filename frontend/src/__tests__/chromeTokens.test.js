/**
 * The two colour CONTRACTS in index.css — the brand accent and the surface
 * ladder — asserted as numbers and as text.
 *
 * Why both halves matter:
 *
 *   • The RATIOS are the thing that was actually broken. A fixed emerald-500
 *     rail measured 2.30:1 against the active row it sits on, and a resting
 *     card measured 1.00:1 against the dark page — both invisible to a build,
 *     an eslint pass, an i18n check and a screenshot taken in one theme. So
 *     they are pinned against the mirrors in config/navChrome.js.
 *
 *   • The mirrors are only honest if they still match the stylesheet, so the
 *     second half READS index.css and asserts the declarations agree. That is
 *     what stops this file from passing on a lie after someone edits the CSS:
 *     jsdom never loads the real stylesheet, so a token test that only asserts
 *     against JS constants asserts nothing about what ships.
 *
 * The contrast helper is the WCAG 2.1 relative-luminance formula written out
 * (same as navChrome.test.js) rather than pulled from a package — it is eight
 * lines, and a colour guard that depends on a transitive dependency's rounding
 * is not a guard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BRAND_ACCENT_HEX,
  BRAND_MARK_HEX,
  BRAND_MARK_INK_HEX,
  NAV_ACTIVE_ROW_HEX,
  NAV_MUTED_HEX,
  SURFACE_LADDER_HEX,
} from "../config/navChrome";

// ── WCAG 2.1 contrast ───────────────────────────────────────────────────
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (fg, bg) => {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

/** WCAG 2.1 1.4.11 — non-text contrast (indicators, borders-that-mean-something). */
const AA_NON_TEXT = 3;
/** WCAG 2.1 1.4.3 — normal-size text. */
const AA_TEXT = 4.5;

const CSS_RAW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.css"),
  "utf8",
);
// Comments out FIRST. This file's own WHY-comments quote the values they
// replaced (#0f172a, gray-950) — matching prose instead of declarations is how
// a stylesheet guard reports a defect that isn't there, or misses one that is.
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, "");

/** `--name: 1 2 3;` → "#010203", scoped to the LAST block that matches
 *  `selector`, which is how the cascade resolves it for that selector. */
function tokenIn(selector, name) {
  const blocks = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].trim().split("\n").pop().trim() === selector);
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const hit = blocks[i][2].match(new RegExp(`${name}\\s*:\\s*([0-9]+)\\s+([0-9]+)\\s+([0-9]+)\\s*;`));
    if (hit) {
      return "#" + [1, 2, 3].map((n) => Number(hit[n]).toString(16).padStart(2, "0")).join("");
    }
  }
  return null;
}

describe("BRAND GREEN — the identity accent clears the non-text floor", () => {
  it("the active-nav rail passes 3:1 on its own row, in BOTH themes", () => {
    // The defect this replaced: a fixed emerald-500 on the light active row
    // (#f3f4f6) measured 2.30:1 — the "you are here" marker was the least
    // visible mark on the rail, and only in the theme most owners use.
    expect(contrast(BRAND_ACCENT_HEX.light, NAV_ACTIVE_ROW_HEX.light))
      .toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrast(BRAND_ACCENT_HEX.dark, NAV_ACTIVE_ROW_HEX.dark))
      .toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("the collapsed-group dot passes 3:1 on the shell, in BOTH themes", () => {
    expect(contrast(BRAND_ACCENT_HEX.light, SURFACE_LADDER_HEX.card.light))
      .toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrast(BRAND_ACCENT_HEX.dark, SURFACE_LADDER_HEX.card.dark))
      .toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("a focus ring on a card passes 3:1, in BOTH themes", () => {
    // Card's interactive variant draws the ring on the accent with the card as
    // its offset, so the card is the ground the ring must be seen against.
    expect(contrast(BRAND_ACCENT_HEX.light, SURFACE_LADDER_HEX.card.light))
      .toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrast(BRAND_ACCENT_HEX.dark, SURFACE_LADDER_HEX.card.dark))
      .toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("the logo glyph passes 3:1 on the mark", () => {
    expect(contrast(BRAND_MARK_INK_HEX, BRAND_MARK_HEX)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("the accent FLIPS by theme — one fixed green cannot do this", () => {
    // Guard against a well-meaning "simplify" that collapses the two stops:
    // the light stop fails on the dark row and vice versa.
    expect(BRAND_ACCENT_HEX.light).not.toBe(BRAND_ACCENT_HEX.dark);
    expect(contrast(BRAND_ACCENT_HEX.dark, NAV_ACTIVE_ROW_HEX.light)).toBeLessThan(AA_NON_TEXT);
  });

  it("the MARK does not flip — a logo that changes hue is a different logo", () => {
    expect(tokenIn(":root.dark", "--brand-green")).toBeNull();
  });
});

describe("SURFACE LADDER — a resting card separates from the ground", () => {
  it("is not the ground colour any more, in either theme", () => {
    // The whole defect in one assertion: ui/Card.jsx painted dark:bg-gray-900,
    // the exact page ground, so a card was a 1.00:1 rectangle.
    expect(SURFACE_LADDER_HEX.card.dark).not.toBe(SURFACE_LADDER_HEX.ground.dark);
    expect(SURFACE_LADDER_HEX.card.light).not.toBe(SURFACE_LADDER_HEX.ground.light);
    expect(contrast(SURFACE_LADDER_HEX.card.dark, SURFACE_LADDER_HEX.ground.dark))
      .toBeGreaterThan(1.1);
  });

  it("lifts in the SAME direction in both themes", () => {
    // Light cards are lighter than the light ground; dark cards must also be
    // lighter than the dark ground, or elevation inverts between themes and
    // "above" stops meaning anything.
    expect(luminance(SURFACE_LADDER_HEX.card.light))
      .toBeGreaterThan(luminance(SURFACE_LADDER_HEX.ground.light));
    expect(luminance(SURFACE_LADDER_HEX.card.dark))
      .toBeGreaterThan(luminance(SURFACE_LADDER_HEX.ground.dark));
    expect(luminance(SURFACE_LADDER_HEX.raised.dark))
      .toBeGreaterThan(luminance(SURFACE_LADDER_HEX.card.dark));
  });

  it("keeps the `subtle` rung visible against BOTH the ground and a card", () => {
    // Card variant="subtle" is used nested AND standing on the bare page (19
    // call sites). Pinning it away from the ground is what stops the fix from
    // re-creating the original "card is the page" defect one variant over.
    const { subtle, ground, card } = SURFACE_LADDER_HEX;
    expect(contrast(subtle.dark, ground.dark)).toBeGreaterThan(1.05);
    expect(contrast(subtle.dark, card.dark)).toBeGreaterThan(1.05);
    // …and it stays BETWEEN them, so it never reads as the louder surface.
    expect(luminance(subtle.dark)).toBeGreaterThan(luminance(ground.dark));
    expect(luminance(subtle.dark)).toBeLessThan(luminance(card.dark));
  });

  it("draws the hairline as an EDGE — lighter than the card in dark", () => {
    // The old pair (card gray-900 + border gray-800) had the border lighter
    // than the card and the card equal to the page: an outline around nothing.
    expect(luminance(SURFACE_LADDER_HEX.line.dark))
      .toBeGreaterThan(luminance(SURFACE_LADDER_HEX.card.dark));
    expect(luminance(SURFACE_LADDER_HEX.line.light))
      .toBeLessThan(luminance(SURFACE_LADDER_HEX.card.light));
  });

  it("keeps muted text AA on the NEW card surface", () => {
    // Lifting the card moves the ground under every muted label on it. The
    // dark muted tier is gray-400; it must still clear AA on gray-800.
    expect(contrast(NAV_MUTED_HEX.dark, SURFACE_LADDER_HEX.card.dark))
      .toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(NAV_MUTED_HEX.light, SURFACE_LADDER_HEX.card.light))
      .toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("index.css agrees with the mirrors it is measured through", () => {
  it.each([
    ["--surface-ground", "ground"],
    ["--surface-subtle", "subtle"],
    ["--surface-card", "card"],
    ["--surface-raised", "raised"],
    ["--surface-line", "line"],
  ])("%s matches SURFACE_LADDER_HEX.%s in both themes", (token, key) => {
    expect(tokenIn(":root", token)).toBe(SURFACE_LADDER_HEX[key].light);
    expect(tokenIn(":root.dark", token)).toBe(SURFACE_LADDER_HEX[key].dark);
  });

  it("--brand-green-accent matches BRAND_ACCENT_HEX in both themes", () => {
    expect(tokenIn(":root", "--brand-green-accent")).toBe(BRAND_ACCENT_HEX.light);
    expect(tokenIn(":root.dark", "--brand-green-accent")).toBe(BRAND_ACCENT_HEX.dark);
  });

  it("--brand-green matches the mark", () => {
    expect(tokenIn(":root", "--brand-green")).toBe(BRAND_MARK_HEX);
  });

  it("has ONE dark near-black — the slate-900 body override is gone", () => {
    // #0f172a under gray-tinted cards was the third near-black; gray-950 in a
    // StatCard ring offset was the fourth. Neither may come back.
    //
    // SCOPED TO CHROME, because this file is about the two colour contracts of
    // the app SHELL — the brand accent and the surface ladder. The reservations
    // room plan (`.bb-room-*`) also draws in #0f172a, and that is not a third
    // surface: it is the ink of a drawing, the same ink the marketing floor
    // plan uses, and it sits inside a bordered canvas rather than under a card.
    // The old assertion was a blanket regex over the whole file, so it read
    // that as the regression it was written to stop.
    //
    // The exception is narrow and checked: near-blacks are allowed ONLY inside
    // the room block, and the surface half of the file must still be clean.
    const roomStart = CSS.indexOf(".bb-room-wall");
    expect(roomStart).toBeGreaterThan(-1); // the block must still exist
    const chrome = CSS.slice(0, roomStart);
    const room = CSS.slice(roomStart);

    expect(chrome).not.toMatch(/#0f172a/i);
    expect(CSS).not.toMatch(/\.dark body\s*\{/);
    // ...and the room block may not quietly become a chrome rule: nothing in
    // it may paint `body`, a card or the page ground.
    expect(room).not.toMatch(/\bbody\s*\{/);
    expect(room).not.toMatch(/--surface-/);
  });

  it("declares the dark ladder AFTER the [data-theme] blocks", () => {
    // Equal specificity (0,2,0): only source order keeps a venue theme from
    // repainting the dark ground. This is the kind of thing that "works on my
    // machine" until someone tidies the file.
    expect(CSS.indexOf(':root.dark {')).toBeGreaterThan(CSS.indexOf(':root[data-theme="focus"]'));
  });
});

describe("the green-* footgun stays disarmed in chrome", () => {
  const files = [
    "components/Layout.jsx",
    "components/ResumeRow.jsx",
    "components/PillarDiscovery.jsx",
    "components/ui/Card.jsx",
    "components/ui/StatCard.jsx",
  ];
  it.each(files)("%s uses no bg-green-* / text-green-* utility", (rel) => {
    // index.css remaps those to the VENUE accent for every non-`tech` theme, so
    // a green-* class in chrome is a class that silently becomes blue.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", rel),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(bg|text|border|ring)-green-\d/);
  });
});
