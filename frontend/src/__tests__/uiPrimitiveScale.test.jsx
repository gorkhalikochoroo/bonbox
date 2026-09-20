/**
 * Three craft invariants of the PRIMITIVE layer, pinned as values.
 *
 * Why the primitives and not the pages: a page ships its own mistake once,
 * a primitive ships it everywhere that composes it. All three defects below
 * were found by measuring the live DOM, and all three are invisible to a
 * build, to eslint and to the i18n checks — the only thing that can hold
 * them is an assertion.
 *
 *   1. THE 8px CURRENCY TOKEN. Amount renders "kr." at 0.62em, which is
 *      lovely at a 30px hero (18.6px) and illegible in 13px body text
 *      (8.06px — measured on /inventory, 23 nodes). The doctrine's floor is
 *      11px. Pinned as the class the component renders AND as the arithmetic
 *      that class produces — the arithmetic row parses its floor and its ratio
 *      back out of the RENDERED class, so it cannot pass on a component that
 *      no longer floors anything.
 *
 *      What it does NOT pin: that Tailwind still compiles the utility. That is
 *      a built-stylesheet fact, verified by hand
 *      (.text-\[length\:max\(11px\,0\.62em\)\]{font-size:max(11px,.62em)} is
 *      present in dist/assets/index-*.css) and it would take a CI step that
 *      builds before it tests to hold it. Said plainly rather than implied.
 *
 *      The class must keep the `length:` type hint. Without it Tailwind
 *      cannot tell an arbitrary max() from a colour and emits NO utility at
 *      all — the failure is silent and the token falls back to inheriting,
 *      which looks fine in review and is wrong on screen. Verified in the
 *      built stylesheet, not just in source:
 *        .text-\[length\:max\(11px\,0\.62em\)\]{font-size:max(11px,.62em)}
 *      and measured in Chrome: hero 18.6px and kpi 16.12px unchanged, every
 *      body-text context floored from 8.06px to 11px.
 *
 *   2. TWO RADIUS TIERS. The live DOM showed four to seven radii per page.
 *      The doctrine allows three shapes and no more: surfaces rounded-xl,
 *      controls rounded-lg, pills rounded-full. A private 4px or 6px inside
 *      a primitive is a tier every composing page pays for.
 *
 *   3. WEIGHT DISCIPLINE. 400/500/600 only, with 700 reserved for a figure
 *      that genuinely is the loudest thing on the screen: Amount's hero and
 *      StatCard's value slot. A font-bold anywhere else in this layer makes
 *      every page that composes it shout.
 *
 * (2) and (3) read SOURCE rather than rendering, because they are about what
 * the file is allowed to contain, not about one render path — a variant
 * nobody renders in a test is exactly where drift hides. Comments are
 * stripped first: these files document their own class choices in prose, and
 * a guard that trips on its own explanation teaches people to delete the
 * explanation.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Amount from "../components/ui/Amount";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../components/ui");

/** The doctrine's small-type floor (index.css type ramp: 11/12/13/14/16/21/26-30). */
const TYPE_FLOOR_PX = 11;
/** The ratio that makes the currency token whisper beside the number. */
const TOKEN_RATIO = 0.62;

const FLOOR_CLASS = `text-[length:max(${TYPE_FLOOR_PX}px,${TOKEN_RATIO}em)]`;

const read = (file) => readFileSync(join(UI_DIR, file), "utf8");

/**
 * Strip block and line comments so a prose mention of a banned class does not
 * trip a guard. Deliberately dumb: these are JSX files whose strings are class
 * lists, not code containing "//" or "/*".
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

/**
 * The primitive layer this guard owns — READ FROM DISK, never hand-listed.
 *
 * A hand-written list is a guard with a hole in exactly the shape of whatever
 * nobody thought about: the first version of this file named eleven of the
 * nineteen files in components/ui, and every off-tier radius that survived the
 * pass was sitting in one of the eight it left out. Deriving the list means a
 * primitive added tomorrow is guarded the day it lands, and a primitive that
 * quietly grows a 6px corner cannot hide by not being on a list.
 */
const PRIMITIVES = readdirSync(UI_DIR)
  .filter((f) => f.endsWith(".jsx"))
  .sort();

describe("Amount — the currency token has a floor", () => {
  // Every size variant, plus the unset case where Amount inherits whatever
  // text it is dropped into. The unset case is the one that was broken: it is
  // how Amount is used inside table cells, rows and helper lines.
  const VARIANTS = [undefined, "body", "kpi", "hero"];

  it.each(VARIANTS)("renders the floored token class at size=%s", (size) => {
    const { unmount } = render(<Amount value={1234} size={size} />);
    const token = screen.getByText("kr.");
    expect(token.className).toContain(FLOOR_CLASS);
    // The unfloored original must be gone, not merely joined: two font-size
    // utilities on one element resolve by stylesheet order, not by intent.
    expect(token.className).not.toContain(`text-[${TOKEN_RATIO}em]`);
    unmount();
  });

  it("floors small contexts and leaves the display sizes alone", () => {
    // The floor and the ratio are read back OUT of the class the component
    // actually renders — not out of this file's own constants. The earlier
    // version of this test defined `resolve` from TYPE_FLOOR_PX and
    // TOKEN_RATIO one line above and then asserted against them, so it was a
    // tautology: reverting Amount to text-[0.62em] left it green while the
    // product shipped an 8.06px "kr." again. Parsing the rendered class means
    // that revert fails here too, because there is no max() to parse.
    render(<Amount value={1234} />);
    const rendered = screen.getByText("kr.").className;
    const m = rendered.match(/text-\[length:max\(([\d.]+)px,([\d.]+)em\)\]/);
    expect(m, `no floored font-size class on the rendered token: ${rendered}`).not.toBeNull();
    const [floorPx, ratio] = [parseFloat(m[1]), parseFloat(m[2])];
    // The component's own numbers are the doctrine's numbers.
    expect(floorPx).toBe(TYPE_FLOOR_PX);
    expect(ratio).toBe(TOKEN_RATIO);

    // max(floor, ratio × parent), one row per real context. Chrome agrees with
    // every row (measured 2026-09-20).
    const resolve = (parentPx) => Math.max(floorPx, ratio * parentPx);

    // Display sizes: the em relationship survives untouched.
    expect(resolve(30)).toBeCloseTo(18.6, 2); // hero, sm+
    expect(resolve(24)).toBeCloseTo(14.88, 2); // hero, phone
    expect(resolve(26)).toBeCloseTo(16.12, 2); // kpi, sm+
    expect(resolve(20)).toBeCloseTo(12.4, 2); // kpi, phone

    // Body contexts: all floored. 13px is this app's body text, where the
    // token used to compute to 8.06px.
    for (const parentPx of [16, 14, 13, 12, 11]) {
      expect(resolve(parentPx)).toBe(floorPx);
      expect(ratio * parentPx).toBeLessThan(floorPx);
    }
  });

  it("keeps the `length:` hint Tailwind needs to emit the utility", () => {
    // Without the hint the class compiles to nothing and the regression is
    // invisible everywhere except on a screen.
    expect(FLOOR_CLASS).toContain("length:");
    expect(read("Amount.jsx")).toContain(FLOOR_CLASS);
  });

  it("still renders an honest em-dash with no token on missing data", () => {
    render(<Amount value={null} size="hero" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("kr.")).not.toBeInTheDocument();
  });
});

describe("Primitives — three radius tiers and no others", () => {
  // The tiers, by the size token rather than by the whole class: a corner is
  // the same tier whether it is applied to all four (`rounded-xl`), to one
  // edge (`rounded-t-xl`, the bottom-sheet top) or behind a breakpoint
  // (`sm:rounded-xl`). `none` is allowed because "no corner at all" is a
  // deliberate shape, not a fourth radius — the desktop drawer sits flush to
  // the window edge. Everything else — bare `rounded` (4px), `-sm`, `-md`,
  // `-2xl`, `-3xl`, `rounded-[7px]` — is a tier the composing pages pay for.
  const ALLOWED_TIERS = new Set(["xl", "lg", "full", "none"]);
  // Matches `rounded`, `rounded-md`, `rounded-t-2xl`, `rounded-[7px]` alike.
  const RADIUS = /\brounded(?:-(?:[trblse]|[tb][lr]))?(?:-(?:[a-z0-9]+|\[[^\]]*\]))?\b/g;
  const tierOf = (cls) => {
    const rest = cls.slice("rounded".length).replace(/^-(?:[trblse]|[tb][lr])(?=-|$)/, "");
    return rest.startsWith("-") ? rest.slice(1) : "base"; // bare `rounded` = 4px
  };

  it.each(PRIMITIVES)("%s uses only the doctrine tiers", (file) => {
    const found = stripComments(read(file)).match(RADIUS) || [];
    const offenders = [...new Set(found)].filter((c) => !ALLOWED_TIERS.has(tierOf(c)));
    expect(offenders).toEqual([]);
  });
});

describe("Primitives — 400/500/600, with 700 only on a hero figure", () => {
  const WEIGHT = /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g;
  const ALLOWED = new Set(["font-normal", "font-medium", "font-semibold"]);

  // The two slots where a 700 is the point: the money hero, and the number a
  // StatCard exists to show. Anything else in this layer shouts by proxy.
  const BOLD_BUDGET = { "Amount.jsx": 1, "StatCard.jsx": 1 };

  it.each(PRIMITIVES)("%s stays within the weight budget", (file) => {
    const found = stripComments(read(file)).match(WEIGHT) || [];
    const heavy = found.filter((c) => !ALLOWED.has(c));
    // Nothing above 700 is ever justified here.
    expect(heavy.filter((c) => c !== "font-bold")).toEqual([]);
    expect(heavy.length).toBe(BOLD_BUDGET[file] || 0);
  });
});
