/**
 * The close surface's four standing contracts, asserted against the source and
 * against the WCAG formula.
 *
 * Why a SOURCE guard and not only a render test: jsdom never loads Tailwind, so
 * a rendered test can assert that a class is present but nothing about whether
 * the class is the right one, and a screenshot is taken in one theme by one
 * person on one day. These four defects all shipped to production past a green
 * build, a clean eslint, a passing i18n check and a human look:
 *
 *   1. 56 bare `toLocaleString()` money renders — correct on a Danish browser,
 *      wrong by a factor of a thousand on an English one.
 *   2. Nine colour families on one instrument, including two whole families
 *      (indigo + violet) spent on a decorative gradient.
 *   3. ~13 accents written `text-emerald-* dark:text-gray-*`, so every one of
 *      them drained to grey at night and the page flattened.
 *   4. A three-stop emerald gradient whose white title measured 1.92:1.
 *
 * The contrast helper is the WCAG 2.1 relative-luminance formula written out —
 * the same eight lines chromeTokens.test.js uses, for the same reason: a colour
 * guard that depends on a transitive dependency's rounding is not a guard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "pages", "DailyClosePage.jsx"), "utf8");

/** The file with `//` and block comments stripped, so a defect QUOTED in a
 *  WHY-comment (this file's own subject matter) is never counted as one. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

// ── WCAG 2.1 contrast ───────────────────────────────────────────────────
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Tailwind v3 palette values used on this surface, as RGB.
const WHITE = [255, 255, 255];
const GRAY_100 = [243, 244, 246];
const GRAY_50 = [249, 250, 251];
const GRAY_600 = [75, 85, 99];
const GRAY_900 = [17, 24, 39]; // also `.dark body` in index.css
const GRAY_800 = [31, 41, 55];
const EMERALD_400 = [52, 211, 153]; // the old gradient's third stop, #34d399
const EMERALD_600 = [5, 150, 105];
const EMERALD_700 = [4, 120, 87];

describe("daily close — money never renders in the browser's locale", () => {
  it("has zero bare toLocaleString() money renders left", () => {
    // `toLocaleString()` with no locale argument formats in the BROWSER's
    // locale. On an EN-locale machine 17030 becomes "17,030" and a Dane reads
    // the comma as a decimal separator — seventeen kroner, on the page that
    // produces the revisor's number, while the PDF the same page generates is
    // correct. Every money render goes through <Amount> / formatOwnerMoney.
    const bare = CODE.match(/\.toLocaleString\(\)/g) || [];
    expect(bare).toHaveLength(0);
  });

  it("uses the money primitives instead", () => {
    expect(CODE).toMatch(/<Amount\b/);
    expect(CODE).toMatch(/formatOwnerMoney\(/);
  });

  it("keeps the two date/time toLocaleString calls that are NOT money", () => {
    // Dates legitimately take the owner's locale — dateLocale() supplies it.
    // This assertion exists so the guard above is understood as a MONEY rule
    // and nobody "fixes" the date formatting to satisfy it.
    expect(CODE).toMatch(/toLocaleDateString\(dateLocale\(\)/);
  });
});

describe("daily close — one accent, and status colours that carry data", () => {
  const FAMILIES = [
    "slate", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow",
    "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo",
    "violet", "purple", "fuchsia", "pink", "rose", "gray",
  ];

  it("spends exactly four colour families: the ground, the accent, warn, critical", () => {
    const found = new Set();
    const re = new RegExp(
      `(?:bg|text|border|ring|from|via|to|fill|stroke|divide)-(${FAMILIES.join("|")})-\\d+`,
      "g",
    );
    for (const m of CODE.matchAll(re)) found.add(m[1]);
    // gray = the ground. emerald = the ONE accent (the money moment, and the
    // heat map's revenue ramp). amber = warn, red = critical — both carry data.
    // The audit found nine: these four plus indigo, violet, blue, yellow,
    // orange and a literal `green-*`.
    expect([...found].sort()).toEqual(["amber", "emerald", "gray", "red"]);
  });

  it("has no gradient anywhere — the doctrine is premium via subtraction", () => {
    expect(CODE).not.toMatch(/gradient/i);
    expect(CODE).not.toMatch(/bg-gradient-to-/);
  });

  it("has no hardcoded hex or rgba colour in a style prop", () => {
    // The two MOMS cards carried `style={{ color: "#6366f1" }}` and an
    // rgba(99,102,241)→rgba(139,92,246) background — colour that no token owned
    // and no theme could follow.
    expect(CODE).not.toMatch(/style=\{\{[^}]*(?:color|background)[^}]*(?:#[0-9a-f]{3,8}|rgba?\()/i);
  });

  it("never writes literal green-*, which index.css remaps to the brand token", () => {
    expect(CODE).not.toMatch(/(?:bg|text|border|border-t)-green-\d+/);
  });
});

describe("daily close — the accent survives dark mode", () => {
  it("pairs no emerald light value with a grey dark value", () => {
    // `text-emerald-600 dark:text-gray-300` was written at ~13 sites, so every
    // accent on the page drained to grey at night and the whole surface
    // flattened into one tone. An accent either stays an accent in both themes
    // or is neutral in both — never one of each.
    const drained = CODE.match(/text-emerald-\d+\s+dark:text-gray-\d+/g) || [];
    expect(drained).toHaveLength(0);
  });

  it("never paints a heat-map bucket in the page's own dark ground", () => {
    // dark:bg-gray-900 IS `.dark body` (#111827). The p75 bucket used it, so a
    // GOOD day rendered as a hole in the grid — and so did the legend swatch
    // that was supposed to explain it.
    const rampBlock = SOURCE.slice(
      SOURCE.indexOf("const HEAT_NO_CLOSE"),
      SOURCE.indexOf("function heatCellClass"),
    );
    expect(rampBlock.length).toBeGreaterThan(0);
    expect(rampBlock).not.toMatch(/dark:bg-gray-900\b/);
  });

  it("gives the dark ramp four distinct steps, like the light one", () => {
    const rampBlock = SOURCE.slice(
      SOURCE.indexOf("const HEAT_REVENUE_RAMP"),
      SOURCE.indexOf("const HEAT_CASH_RAMP"),
    );
    const light = [...rampBlock.matchAll(/"(bg-[a-z]+-\d+)\s/g)].map((m) => m[1]);
    const dark = [...rampBlock.matchAll(/(dark:bg-[a-z]+-\d+)"/g)].map((m) => m[1]);
    expect(light).toHaveLength(4);
    expect(dark).toHaveLength(4);
    // The old dark ramp repeated dark:bg-gray-800 twice out of four.
    expect(new Set(light).size).toBe(4);
    expect(new Set(dark).size).toBe(4);
  });

  it("clears 4.5:1 for the emerald accent in BOTH themes", () => {
    // emerald-700 on white (light) and emerald-400 on the dark card.
    expect(ratio(EMERALD_700, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(EMERALD_400, GRAY_800)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(EMERALD_400, GRAY_900)).toBeGreaterThanOrEqual(4.5);
    // The value it replaced did NOT — this is why the badges moved a step.
    expect(ratio(EMERALD_600, WHITE)).toBeLessThan(4.5);
  });
});

describe("daily close — the scan step's instruction is legible", () => {
  it("measures the gradient it replaced, and the surface that replaced it", () => {
    // BEFORE: white title and gray-100 body over a three-stop emerald gradient
    // (#059669 → #10b981 → #34d399). At the light end — where a centred title
    // lands on a 135° gradient — the title measured 1.92:1 and the body 1.75:1,
    // against a 4.5:1 floor. This assertion is the RECORD of that measurement;
    // it fails if someone decides 1.9:1 was fine after all.
    expect(ratio(WHITE, EMERALD_400)).toBeLessThan(2);
    expect(ratio(GRAY_100, EMERALD_400)).toBeLessThan(2);

    // AFTER: gray-900 title and gray-600 body on the gray-50 card.
    expect(ratio(GRAY_900, GRAY_50)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(GRAY_600, GRAY_50)).toBeGreaterThanOrEqual(4.5);
    // …and comfortably clear on white too, for the dark-card inverse.
    expect(ratio(GRAY_900, WHITE)).toBeGreaterThan(15);
  });

  it("no longer renders white text on a coloured banner at the top of the step", () => {
    const scanBanner = SOURCE.slice(
      SOURCE.indexOf('{scanMode === "idle" && ('),
      SOURCE.indexOf("{/* ─── SCANNING SPINNER ─── */}"),
    );
    expect(scanBanner.length).toBeGreaterThan(0);
    expect(scanBanner).not.toMatch(/text-white/);
    expect(scanBanner).not.toMatch(/bg-white\/\d+/); // the /10 and /20 ghost pills
  });
});

describe("daily close — the type ramp", () => {
  it("uses no size below the 11px floor and none off the ramp", () => {
    const ALLOWED = new Set(["11", "12", "13", "14", "16", "21", "26", "30"]);
    const arbitrary = [...CODE.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => m[1]);
    const offRamp = [...new Set(arbitrary)].filter((v) => !ALLOWED.has(v));
    expect(offRamp).toEqual([]);
  });

  it("reserves weight 700 for a hero KPI — nowhere on this page", () => {
    // 5 font-bold headings and links became font-semibold; the only remaining
    // 700 on screen comes from the <Amount size="kpi"/> primitive itself.
    expect(CODE).not.toMatch(/font-bold/);
  });

  it("keeps the radius to two tiers plus the pill and the heat cell", () => {
    const radii = new Set(CODE.match(/rounded(?:-(?:\[[^\]]+\]|[a-z0-9]+))+/g) || []);
    for (const r of radii) {
      expect([
        "rounded-lg", "rounded-xl", "rounded-full", "rounded-[2px]",
        "rounded-l-lg", "rounded-r-lg",
      ]).toContain(r);
    }
  });
});
