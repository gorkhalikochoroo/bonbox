/**
 * The surface ladder, asserted where it is CONSUMED rather than where it is
 * declared.
 *
 * chromeTokens.test.js pins the token VALUES (a card is one rung above the
 * ground, the accent clears 3:1 in both themes). That is necessary and not
 * sufficient: the ladder shipped adopted in two primitives out of eighteen, so
 * on one screen a StatCard sat a rung above the page while a DataTable beside
 * it still painted the page ground and outlined itself with a hairline lighter
 * than its own fill. "Same screen, two behaviours" had been relocated, not
 * removed.
 *
 * Two further collapses came from the lift itself and are the reason this file
 * exists at all — a token can be correct and still break the thing above it:
 *
 *   1. NESTED WELLS. `bg-gray-100 dark:bg-gray-800` is the app's standard
 *      icon-chip / well idiom. It was a step DOWN from a white card in light
 *      and a step down from a gray-900 card in dark. Once cards became
 *      gray-800, every such well drawn INSIDE a card became the card. Light
 *      kept separating and dark stopped — exactly the asymmetry the ladder
 *      exists to remove.
 *
 *   2. RING OFFSETS. The offset gap is painted in the colour of the surface
 *      BEHIND the control. Four primitives hard-coded gray-900 — the page
 *      ground — so a focused control on a lifted card drew a dark halo.
 *
 * Everything here is measured against the mirrors in config/navChrome.js, and
 * the source guards strip comments first: several of the files below quote the
 * literals they replaced in their own WHY-comments, and matching prose instead
 * of code is how a guard reports a defect that is not there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SURFACE_LADDER_HEX } from "../config/navChrome";

// ── WCAG 2.1 contrast, written out (see chromeTokens.test.js for why) ──
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
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Read a source file with comments removed — see the header note. */
const code = (rel) =>
  readFileSync(join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CSS = readFileSync(join(SRC, "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const L = SURFACE_LADDER_HEX;

describe("a nested well is visible on BOTH the surfaces it is used on", () => {
  // The half-rung is the only value that survives both positions, which is the
  // whole reason Card's `subtle` variant is a half-rung and not an inset.
  it("`subtle` separates from a card in dark", () => {
    expect(contrast(L.subtle.dark, L.card.dark)).toBeGreaterThan(1.05);
  });

  it("`subtle` separates from the bare page ground in dark", () => {
    expect(contrast(L.subtle.dark, L.ground.dark)).toBeGreaterThan(1.05);
  });

  it("gray-800 — the value these wells used to carry — is now the CARD", () => {
    // This is the defect stated as an assertion: if someone re-introduces
    // `dark:bg-gray-800` on a well inside a Card, this is the number they get.
    expect(contrast("#1f2937", L.card.dark)).toBe(1);
  });

  it("the dark ground is NOT a safe well value either", () => {
    // The obvious "just use gray-900" fix trades one invisible position for
    // another: it vanishes on any Empty/DataTable rendered on the bare page.
    expect(contrast(L.ground.dark, L.ground.dark)).toBe(1);
  });
});

describe("the primitives that share a screen with Card read the same ladder", () => {
  // These four are the ones that render BESIDE a Card or a StatCard on a job
  // page (/sales, /expenses, /insights), so a divergence between them is
  // visible in a single glance rather than across two routes.
  const CARD_SURFACE = "bg-[rgb(var(--surface-card))]";

  it.each([
    ["components/ui/DataTable.jsx", CARD_SURFACE],
    ["components/ui/SuggestionCard.jsx", CARD_SURFACE],
    ["components/ui/UpgradeNudge.jsx", CARD_SURFACE],
  ])("%s paints its container on the ladder", (rel, token) => {
    expect(code(rel)).toContain(token);
  });

  it("DataTable no longer paints the dark page ground as a card", () => {
    const src = code("components/ui/DataTable.jsx");
    // The container, the dividers, the selected row and the skeleton bars all
    // resolved to the same colour as the surface behind them. The thead is the
    // deliberate exception — a translucent step DOWN, mirroring light's gray-50
    // under a white card, and an opaque token would kill its backdrop-blur.
    expect(src).not.toMatch(/bg-white dark:bg-gray-900/);
    expect(src).not.toMatch(/dark:divide-gray-800/);
    expect(src).not.toMatch(/dark:bg-gray-800 animate-pulse/);
  });

  it("Empty's icon chip is not the colour of the card it sits in", () => {
    const src = code("components/ui/Empty.jsx");
    expect(src).toContain("dark:bg-[rgb(var(--surface-subtle))]");
    expect(src).not.toMatch(/bg-gray-100 dark:bg-gray-800/);
  });
});

describe("focus affordances clear the 3:1 non-text floor in both themes", () => {
  // emerald-500 on a white card is 2.54:1 and emerald-400 is 1.86:1 — both
  // below WCAG 1.4.11, and both look fine in a dark screenshot, which is how
  // they survived. Only the 600/700 stops pass on a light ground, so the rule
  // is stop-specific rather than a blanket ban on emerald.
  it("emerald-500 fails on white — the reason the token exists", () => {
    expect(contrast("#10b981", "#ffffff")).toBeLessThan(3);
  });

  it("emerald-600 passes on white", () => {
    expect(contrast("#059669", "#ffffff")).toBeGreaterThan(3);
  });

  const UI_FILES = [
    "components/ui/Button.jsx",
    "components/ui/Card.jsx",
    "components/ui/Chip.jsx",
    "components/ui/DataTable.jsx",
    "components/ui/Empty.jsx",
    "components/ui/EntryCard.jsx",
    "components/ui/FilterBar.jsx",
    "components/ui/Input.jsx",
    "components/ui/PageHeader.jsx",
    "components/ui/PageShell.jsx",
    "components/ui/SectionBanner.jsx",
    "components/ui/Sheet.jsx",
    "components/ui/StatCard.jsx",
    "components/ui/SuggestionCard.jsx",
    "components/ui/TabPills.jsx",
    "components/ui/UpgradeNudge.jsx",
  ];

  it.each(UI_FILES)("%s uses no failing emerald stop on a focus ring", (rel) => {
    expect(code(rel)).not.toMatch(/focus-visible:ring-emerald-[45]\d\d/);
  });

  it.each(UI_FILES)("%s uses no bg-green-* / text-green-* utility", (rel) => {
    // index.css remaps green-* to the VENUE accent for every non-`tech` theme,
    // so a green-* class in a primitive silently becomes blue on most accounts.
    expect(code(rel)).not.toMatch(/\b(bg|text|border|ring)-green-\d/);
  });

  it.each(UI_FILES)("%s does not hard-code the page ground as a ring offset", (rel) => {
    // The gap belongs to the surface BEHIND the control, which is a card on
    // nearly every screen. StatCard documents this fix for itself; the rule is
    // pinned here so the other primitives cannot drift back.
    expect(code(rel)).not.toMatch(/ring-offset-gray-9\d0/);
  });
});

describe("the shell sits on one rung in both themes", () => {
  it(".glass reads the card token, not a literal near-black", () => {
    // The phone's top bar and bottom nav were `rgb(17 24 39 / .85)` — literally
    // --surface-ground painted over the ground — while the desktop sidebar had
    // just been lifted to the card rung. Light and dark agreed about the rail
    // and disagreed about the phone.
    const glassRules = CSS.match(/\.dark \.glass(-static)?\s*\{[^}]*\}/g) || [];
    expect(glassRules.length).toBe(4); // .glass + .glass-static, each with its @supports fallback
    for (const rule of glassRules) {
      expect(rule).toContain("var(--surface-card)");
      expect(rule).not.toMatch(/17\s+24\s+39/);
    }
  });

  it("the ground is still the founder's #111827, untouched by any of this", () => {
    expect(L.ground.dark).toBe("#111827");
  });
});
