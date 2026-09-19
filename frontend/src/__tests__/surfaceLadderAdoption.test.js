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
/** Read a source file with comments removed — see the header note.
 *
 *  A block comment opens only after whitespace, `{` or `(`. The naive
 *  `/\/\*[\s\S]*?\*\//` swallowed `accept="image/*"` in DailyClosePage as a
 *  comment opener and ate everything up to the next genuine comment close —
 *  several hundred lines of source, including surfaces to inspect.
 */
const code = (rel) =>
  readFileSync(join(SRC, rel), "utf8")
    .replace(/(^|[\s{(])\/\*[\s\S]*?\*\//g, "$1")
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

/* ══════════════════════════════════════════════════════════════════════
   THE PAGES THE OWNER ACTUALLY LOOKS AT

   Everything above pins the ladder in the PRIMITIVES. That left the
   hand-rolled chrome on the job pages — which is most of what is on screen —
   free to keep painting the ground, and it did: walking Home in dark mode and
   asking getComputedStyle for the background of every card-like element
   returned rgb(17,24,39), the page ground itself, for seven of twenty-three
   surfaces. A card you cannot see the edge of is not a card.

   This guard reads each file the way the fix did — off LIGHT, which already
   says what every surface is meant to be. A `bg-white` container is a resting
   card, a `bg-gray-50` container is a well, a `shadow-xl` panel is floating.
   Whatever light says, the dark half may not resolve to the ground.

   It is a SOURCE scan, so it cannot see a runtime-composed class string. What
   it does catch is the thing that actually happened: somebody copying the
   neighbouring card's chrome, `dark:bg-gray-900` and all.
   ══════════════════════════════════════════════════════════════════════ */

/** Dark backgrounds that resolve to the page ground (alpha included — a wash
 *  of the ground over the ground measures rgb(17,24,39) either way). */
const GROUND_DARK_BG = /dark:bg-gray-900(\/\d{1,3})?(?![\w-])|dark:bg-\[rgb\(var\(--surface-ground\)\)\]/;
/** A neutral light background — status tints are out of scope by construction. */
const LIGHT_NEUTRAL_BG = /(^|\s)(bg-white(\/\d{1,3})?|bg-gray-50)(\s|$)/;
const SURFACE_CHROME = /(^|\s)(rounded-[a-z0-9]+|border)(\s|$)/;
/** An alpha wash of the ground, which is what a blurred sticky strip uses. */
const TRANSLUCENT_GROUND = /dark:bg-gray-900\/\d{1,3}(?![\w-])/;

/**
 * Class strings that are NOT surfaces. Each is a decision, not an oversight —
 * which is why they are listed rather than excluded by a looser predicate.
 */
const NOT_A_SURFACE = [
  // A switch thumb. It is the moving part of a control, and its job is to
  // contrast with the TRACK, which is gray-700.
  /rounded-full bg-white dark:bg-gray-900 (transition transform|shadow-sm transition-transform)/,
];

/**
 * A sticky, translucent table head or header strip: a step DOWN under a card,
 * mirroring light's gray-50 under white. This is the exception DataTable
 * documents for itself, and an opaque token would kill the blur.
 *
 * The exemption is narrowed to strings that are ACTUALLY translucent. It used
 * to be the bare substrings /sticky/ and /backdrop-blur/ tested against a whole
 * source line, which waved through any solid ground-painted card that happened
 * to sit on a line containing the word "sticky".
 */
const isBlurredStep = (s) =>
  /\b(sticky|backdrop-blur)/.test(s) && TRANSLUCENT_GROUND.test(s);

/**
 * Every class string in the file, with concatenation and line breaks resolved.
 *
 * THIS IS THE GUARD'S OWN BUG, fixed. It classified LINE BY LINE and demanded
 * the radius, the light fill and the dark fill on one line — but the house
 * idiom splits a card's chrome across two string literals:
 *
 *     "rounded-xl border border-gray-200 dark:border-gray-800 " +
 *     "bg-white dark:bg-gray-900 p-5 sm:p-6 "
 *
 * Neither half is a surface on its own, so the guard saw nothing. Replayed
 * against the tree it was written for, it reported CLEAN for five Home cards
 * that each carried a ground-painted card — including the two the founder was
 * looking at. A guard with a blind spot the shape of the codebase's dominant
 * idiom passes forever.
 */
const classStrings = (rel) => {
  const src = code(rel).replace(/"\s*\+\s*"/g, " ");
  return [...src.matchAll(/"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g)].map((m) =>
    m[0].slice(1, -1).replace(/\s+/g, " ").trim(),
  );
};

/** Does this class string declare a surface that resolves to the dark ground? */
const isGroundPainted = (s) => {
  if (!GROUND_DARK_BG.test(s)) return false;
  if (isBlurredStep(s)) return false;
  if (NOT_A_SURFACE.some((re) => re.test(s))) return false;
  // Read the element's OWN background: a `hover:bg-gray-50` is the hover
  // state of a white card, not the card.
  const resting = s.replace(/\b(hover|focus|focus-visible|active|group-hover):\S+/g, " ");
  return LIGHT_NEUTRAL_BG.test(resting) && SURFACE_CHROME.test(resting);
};

const LADDER_SWEPT = [
  "pages/DashboardPage.jsx",
  "pages/ReservationsPage.jsx",
  "pages/StaffSchedulePage.jsx",
  "pages/StaffHoursPage.jsx",
  // A tab BODY of /staff/hours, not a sidebar row of its own — the Løn tab's
  // three summary tiles sat on the ground behind a header that had been lifted.
  "pages/StaffPayrollPage.jsx",
  "pages/InventoryPage.jsx",
  "pages/ExpiryPage.jsx",
  "pages/WastePage.jsx",
  "pages/SalesPage.jsx",
  "pages/ExpensesPage.jsx",
  // Home is assembled from the card registry, not from DashboardPage's own
  // markup, so the page file alone would report clean and miss every surface
  // the founder was looking at.
  "components/dashboard/AlertsPanel.jsx",
  "components/dashboard/AllClearCard.jsx",
  "components/dashboard/BusinessHealthCard.jsx",
  "components/dashboard/ComplianceCountdownCard.jsx",
  "components/dashboard/FirstRunCollapsedDashboard.jsx",
  "components/dashboard/GoalTracker.jsx",
  "components/dashboard/GrowthLeverCard.jsx",
  "components/dashboard/InventoryPanel.jsx",
  "components/dashboard/OutstandingFakturaCard.jsx",
  "components/dashboard/PaymentBreakdownCard.jsx",
  "components/dashboard/ProfitAnswerCard.jsx",
  "components/dashboard/ProfitLossCard.jsx",
  "components/dashboard/RevenueTrendChart.jsx",
  "components/dashboard/TopSellersCard.jsx",
];

/** Every class string in `rel` that declares a surface resolving to the ground. */
function groundPaintedSurfaces(rel) {
  return classStrings(rel).filter(isGroundPainted);
}

describe("the guard can read the way the codebase is actually written", () => {
  // Verbatim shapes from the tree this sweep fixed. Without the fixture the
  // classifier's blind spot is invisible: it reports zero, the suite is green,
  // and "a newly added ground-painted card fails a test" is simply untrue.
  const CAUGHT = {
    "a single-line className": `<div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5" />`,
    // The dominant idiom on Home — every registry card builds chrome this way.
    "chrome concatenated across two literals": [
      '"rounded-xl border border-gray-200 dark:border-gray-800 " +',
      '"bg-white dark:bg-gray-900 p-5 sm:p-6 " +',
      "(className || \"\")",
    ].join("\n"),
    "a className wrapped across lines": [
      '<div className="rounded-2xl border border-gray-200 dark:border-gray-800',
      '     bg-white dark:bg-gray-900 shadow-sm" />',
    ].join("\n"),
    "a template literal split across lines": [
      "<div className={`rounded-xl border border-gray-200 dark:border-gray-800",
      "   bg-white dark:bg-gray-900 ${extra}`} />",
    ].join("\n"),
  };

  const scan = (src) =>
    [
      ...src.replace(/"\s*\+\s*"/g, " ").matchAll(/"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g),
    ]
      .map((m) => m[0].slice(1, -1).replace(/\s+/g, " ").trim())
      .filter(isGroundPainted);

  it.each(Object.entries(CAUGHT))("catches %s", (_label, src) => {
    expect(scan(src).length).toBeGreaterThan(0);
  });

  it("still exempts a blurred sticky strip, which must stay translucent", () => {
    expect(
      scan('<div className="sticky top-0 backdrop-blur border-b bg-white/80 dark:bg-gray-900/80" />'),
    ).toEqual([]);
  });

  it("but not a solid card that merely sits near the word sticky", () => {
    // The old exemption was the bare substring /sticky/ against a whole source
    // line, so this passed — a real ground-painted card, waved through by a
    // neighbouring utility.
    expect(
      scan('<div className="sticky top-0 rounded-xl border bg-white dark:bg-gray-900 p-4" />').length,
    ).toBe(1);
  });
});

describe("no surface on a job page paints the page ground", () => {
  it.each(LADDER_SWEPT)("%s", (rel) => {
    expect(groundPaintedSurfaces(rel)).toEqual([]);
  });

  it("the guard can still see a ground-painted card when there is one", () => {
    // A guard that matches nothing passes forever. DailyClosePage is outside
    // this sweep and still carries a handful — including an inline card inside
    // an amber panel — so it doubles as the positive control. If this ever
    // goes to zero, that page was swept too: move it into LADDER_SWEPT above
    // and pick a new control rather than deleting this test.
    expect(groundPaintedSurfaces("pages/DailyClosePage.jsx").length).toBeGreaterThan(0);
  });

  it("the swept files really do read the ladder now", () => {
    // The mirror assertion: absence of the ground is not the same as adoption
    // (a file with no surfaces at all would pass the check above).
    const adopting = LADDER_SWEPT.filter((rel) =>
      /dark:bg-\[rgb\(var\(--surface-(card|subtle|raised)\)\)\]/.test(code(rel)),
    );
    expect(adopting.length).toBe(LADDER_SWEPT.length);
  });
});

describe("lifting a card's fill without its hairline erases the card's edge", () => {
  // The sweep's own second-order defect, and the reason "no ground" is not the
  // whole rule. Seven Home cards were lifted to --surface-card and kept
  // `dark:border-gray-800` — which IS gray-800. Fill and border became one
  // colour, so a card that had a visible edge before the lift had none after,
  // on the exact screen the lift was performed to fix. Ten sibling cards in
  // the same sweep used the line token: one screen, two behaviours.
  const CARD_DARK = "#1f2937";

  it("gray-800 on the card rung is literally invisible", () => {
    expect(contrast("#1f2937", CARD_DARK)).toBe(1);
  });

  it("it WAS visible on the ground — which is what the lift took away", () => {
    expect(contrast("#1f2937", L.ground.dark)).toBeGreaterThan(1.2);
  });

  it("the line token separates from the card", () => {
    expect(contrast(L.line.dark, CARD_DARK)).toBeGreaterThan(1.2);
  });

  /** Class strings that paint the card rung AND outline themselves in their
   *  own fill. `divide-` included: a divider list has the same failure. */
  const selfColouredHairline = (rel) =>
    classStrings(rel).filter(
      (s) =>
        /dark:bg-\[rgb\(var\(--surface-card\)\)\]/.test(s) &&
        /dark:(border|divide)-gray-800(\/\d{1,3})?(?![\w-])/.test(s),
    );

  it.each(LADDER_SWEPT)("%s", (rel) => {
    expect(selfColouredHairline(rel)).toEqual([]);
  });

  it("the check can see the pairing it is looking for", () => {
    // Same positive-control discipline as the ground scan: a rule that matches
    // nothing is not a rule. This is BusinessHealthCard.jsx as the sweep left
    // it, before the hairline was repointed.
    const src =
      '"rounded-xl border border-gray-200 dark:border-gray-800 " +\n' +
      '"bg-white dark:bg-[rgb(var(--surface-card))] p-5 sm:p-6 "';
    const fused = [
      ...src.replace(/"\s*\+\s*"/g, " ").matchAll(/"([^"\\]|\\.)*"/g),
    ].map((m) => m[0].slice(1, -1).replace(/\s+/g, " "));
    expect(
      fused.filter(
        (s) =>
          /dark:bg-\[rgb\(var\(--surface-card\)\)\]/.test(s) &&
          /dark:border-gray-800/.test(s),
      ).length,
    ).toBe(1);
  });
});

describe("a well inside a Home card is not painted in the card's own colour", () => {
  // The other half of the same lift, and the one the file header already
  // warned about: `bg-gray-100 dark:bg-gray-800` is the app's icon-chip /
  // progress-track / skeleton idiom. It was a step DOWN from white in light
  // and a step UP from gray-900 in dark. Once the cards became gray-800 every
  // one of these became the card — the chips, the bars and the dividers on
  // Home all went flat while light kept separating.
  //
  // Scoped to the card registry because that is where the claim is provable
  // without reading the tree: each of these components IS a card, so anything
  // it paints is inside one. On a job page the same utility may legitimately
  // sit on the bare page ground, where gray-800 is the correct step up — which
  // is why this rule stops here rather than sweeping every file.
  const HOME_CARDS = LADDER_SWEPT.filter((rel) => rel.startsWith("components/dashboard/"));

  it("gray-800 is the card, so a well cannot be gray-800", () => {
    expect(contrast("#1f2937", L.card.dark)).toBe(1);
    expect(contrast(L.subtle.dark, L.card.dark)).toBeGreaterThan(1.05);
  });

  it.each(HOME_CARDS)("%s", (rel) => {
    const flat = classStrings(rel).filter((s) =>
      /dark:bg-gray-800(\/\d{1,3})?(?![\w-])/.test(s),
    );
    expect(flat).toEqual([]);
  });
});
