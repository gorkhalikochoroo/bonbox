/**
 * LANDING V6 — the first screen's layout rules (first-screen round and hero-group round, 23 Oct).
 *
 * 1. The two-column page (landscape ≥ 1024, aspect ≥ 5/4).
 *    First-screen round (Manoj at 1440 × 900, "these gaps — anything we can do?"): the crop marks started 40 px under the bar, the
 *    headline 154 px under it, because layout() centred the hero on the stage's middle line. Now the hero hangs from the plate's
 *    top edge — the headline's visible cap top on the line of the top crop marks. ≥ 1200 px the headline is capped so its widest
 *    word (DA "Vagterne." + 01) ends 24 px short of the plate.
 *    Hero-group round (Claude's review of those screenshots): sharing the column's air in three equal bands made the headline, the
 *    subline and the buttons float apart at 1920 × 1080 and 2560 × 1440 (157–277 px between each). Now (heroFit.js heroBlock())
 *    the subline, the button row and the trial line are ONE block with their own margins, its last baseline on the roster card's
 *    bottom edge as the engine placed it; the headline → block gap is clamped to 40 px … 2 × the section gap, the block never goes
 *    under the bottom crop marks, and never overlapping the headline wins over the crop marks.
 * 2. The one-column tablet stage (768–1199 px wide, not the two-column page). "whats with those gap on right" at 820 × 1180: the
 *    headline words flow inline (inline-block: each still its own link with the stacked word's box) and the two lines run to
 *    48ch / 52ch.
 * Phones (< 768) are untouched: their hero rules and tokens are pinned below exactly as at 86472ec8.
 *
 * The geometry below is RECORDED, not made up: the built branch in headless Chromium (the lab's port-build/hero-group/ probe,
 * record.json), read exactly as engine.js layout() reads it — the hero's parts with the air row at 0 (offsetTop from the hero's
 * content top, offsetHeight, computed font-size and line-height), the frame's padding-top (the plate's top edge), the plate's
 * bottom edge, the roster card's bottom edge (the roster's box, scaled about its centre, + the card inside it) and 2 × --sec —
 * and the --hero-top / --hero-a1 the engine then set. DA and EN laid out the same at every size. In the same run the trial line's
 * last baseline sat within 0.6 px of the card's bottom edge (the air is rounded to whole px), except 2560 × 1440 (the 2 × section
 * gap clamp: 42 px above it).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postcss from "postcss";
import { heroFit, heroBlock, capTop, baseline, INTER, MIN_GAP } from "../components/landing/v6/heroFit";

const HERE = dirname(fileURLToPath(import.meta.url));
const V6 = join(HERE, "..", "components", "landing", "v6");
const css = readFileSync(join(V6, "landingV6.css"), "utf8");
const engine = readFileSync(join(V6, "engine.js"), "utf8");
const root = postcss.parse(css);

const DESK = "(min-width:1024px) and (min-aspect-ratio:5/4)";
const DESK1200 = "(min-width:1200px) and (min-aspect-ratio:5/4)";
const ONECOL = "not all and (min-width:1024px) and (min-aspect-ratio:5/4)";
const TABLET = "(min-width:768px) and (max-width:1199px)";

// every @media around a rule, outermost first
const chain = (n) => { const c = []; for (let p = n.parent; p; p = p.parent) if (p.type === "atrule" && p.name === "media") c.unshift(p.params); return c; };
const rules = [];
root.walkRules((r) => { if (!(r.parent.type === "atrule" && /keyframes$/i.test(r.parent.name))) rules.push(r); });
const decls = (r) => { const o = {}; r.each((x) => { if (x.type === "decl") o[x.prop] = x.value + (x.important ? " !important" : ""); }); return o; };
const withSel = (sel) => rules.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(sel));
const where = (sel, prop, value) => withSel(sel).filter((r) => decls(r)[prop] === value).map(chain);
// a media chain can apply under 768 px unless one of its queries (every comma branch of it) requires min-width ≥ 768
const partPhone = (q) => q.trim().startsWith("not ") || !(/\(min-width:(\d+)px\)/.test(q) && +q.match(/\(min-width:(\d+)px\)/)[1] >= 768);
const reachesPhone = (ch) => ch.every((q) => q.split(",").some(partPhone));

// [plateTop, plateBottom, cardBottom, maxGap, h1, sub, trial (each [top, h, fs, lh])] → the engine's [--hero-top, --hero-a1], the
// edge that placed the block, and the air 7cc077c7 put above the subline at the same size (the equal-band rule; its button row had
// its own air on top of that, 44–240 px)
const REC = {
  "1024x768": { g: [92, 710, 566, 192, [0, 193, 65.536, 64.2253], [213, 52, 18, 26.1], [361, 44, 15, 21.75]], set: [84, 83], edge: "card", before: 85 },
  "1280x800": { g: [100, 742, 613, 256, [0, 282, 96, 94.08], [310, 58, 20, 29], [468, 46, 16, 23.2]], set: [88, 17], edge: "card", before: 51 },
  "1366x768": { g: [100, 710, 597, 256, [0, 282, 96, 94.08], [310, 58, 20, 29], [468, 46, 16, 23.2]], set: [88, 1], edge: "card", before: 40 },
  "1440x900": { g: [112, 834, 665, 256, [0, 317, 108, 105.84], [345, 58, 20, 29], [503, 46, 16, 23.2]], set: [98, 23], edge: "card", before: 68 },
  "1536x864": { g: [112, 798, 647, 256, [0, 305, 103.68, 101.606], [333, 58, 20, 29], [491, 46, 16, 23.2]], set: [99, 17], edge: "card", before: 60 },
  "1920x1080": { g: [112, 1014, 755, 256, [0, 359, 122, 119.56], [387, 64, 22, 31.9], [550, 46, 16, 23.2]], set: [97, 68], edge: "card", before: 111 },
  "2560x1440": { g: [112, 1374, 935, 256, [0, 359, 122, 119.56], [387, 64, 22, 31.9], [550, 46, 16, 23.2]], set: [97, 205], edge: "max", before: 231 },
};
const P = ([top, h, fs, lh]) => ({ top, h, fs, lh });
const input = ([plateTop, plateBottom, cardBottom, maxGap, h1, sub, trial]) => ({ plateTop, plateBottom, cardBottom, maxGap, h1: P(h1), sub: P(sub), trial: P(trial) });
const lastBase = ([top, h, fs, lh]) => top + h - lh + baseline(fs, lh);

describe("heroFit.js — the two-column hero hangs from the plate's top edge; the subline, buttons and trial line sit on the roster card as one block", () => {
  it("Inter's metrics: ascent 1984, descent 494, cap height 1490 of 2048; at line-height .98 the capitals start .126 em under the line box", () => {
    expect(INTER).toEqual({ asc: 1984 / 2048, desc: 494 / 2048, cap: 1490 / 2048 });
    expect(capTop(100, 98)).toBeCloseTo(12.6, 1);
    expect(baseline(100, 98)).toBeCloseTo(85.4, 1);
    // a line-height equal to the content area puts the baseline at the ascent
    expect(baseline(100, ((1984 + 494) / 2048) * 100)).toBeCloseTo(96.875, 6);
    expect(MIN_GAP).toBe(40);
  });

  for (const [size, r] of Object.entries(REC)) {
    it(`${size}: the cap top on the crop marks' line; the block ${r.edge === "card" ? "ends on the card's bottom edge" : "stops at 2 × the section gap"}, as the engine set it`, () => {
      const f = heroFit(input(r.g));
      const [plateTop, plateBottom, cardBottom, maxGap, h1, sub, trial] = r.g;
      // the headline's first cap top = the plate's top edge
      expect(f.top + h1[0] + capTop(h1[2], h1[3])).toBeCloseTo(plateTop, 6);
      // what layout() wrote, rounded, in the real browser
      expect([Math.round(f.top), Math.round(f.a1)]).toEqual(r.set);
      expect(f.block.edge).toBe(r.edge);
      // one block: the subline, the buttons and the trial line move together by the same air (their own margins stay)
      expect(f.block.top - (f.top + sub[0] + capTop(sub[2], sub[3]))).toBeCloseTo(f.a1, 6);
      expect(f.block.bottom - (f.top + lastBase(trial))).toBeCloseTo(f.a1, 6);
      // the block's last baseline on the card's bottom edge, or (2560) the gap at its ceiling and the block above the card
      if (r.edge === "card") expect(f.block.bottom).toBeCloseTo(cardBottom, 6);
      else { expect(f.block.gap).toBeCloseTo(maxGap, 6); expect(f.block.bottom).toBeLessThan(cardBottom); }
      // the gap from the headline's last baseline to the subline's cap top, inside the clamp; the subline closer to the headline
      // than at 7cc077c7 (less air above it, the same measures under it)
      expect(f.block.gap).toBeCloseTo(f.block.top - (f.top + lastBase(h1)), 6);
      expect(f.block.gap).toBeGreaterThanOrEqual(MIN_GAP);
      expect(f.block.gap).toBeLessThanOrEqual(maxGap);
      expect(f.a1).toBeLessThan(r.before);
      // never under the bottom crop marks (the trial line's box)
      expect(f.top + trial[0] + trial[1] + f.a1).toBeLessThanOrEqual(plateBottom);
    });
  }

  // heroBlock() on its own: a 200 px block whose natural gap under the headline is 48 px (1440 × 900's own figures, rounded)
  const B = { headBase: 400, blockTop: 448, blockBase: 640, blockBox: 646, plateBottom: 834, maxGap: 256 };
  it("the block's last baseline goes on the card's bottom edge: air = card bottom − block bottom", () => {
    expect(heroBlock({ ...B, cardBottom: 665 })).toEqual({ air: 25, top: 473, bottom: 665, gap: 73, edge: "card" });
  });

  it("the gap is at least 40 px: a card that ends higher puts the block 40 px under the headline (or at its own margin where that is more), never closer", () => {
    // natural gap 30 (a tight headline): the card asks for −20, the block goes to 40 px under the headline
    const tight = { ...B, blockTop: 430, blockBase: 622, blockBox: 628 };
    expect(heroBlock({ ...tight, cardBottom: 602 })).toEqual({ air: 10, top: 440, bottom: 632, gap: 40, edge: "min" });
    // natural gap 48 (already over 40): a card that ends 30 px higher than the block leaves the block where it is, no negative air
    expect(heroBlock({ ...B, cardBottom: 610 })).toEqual({ air: 0, top: 448, bottom: 640, gap: 48, edge: "min" });
    // exactly on the floor is the card's own answer
    expect(heroBlock({ ...tight, cardBottom: 632 }).edge).toBe("card");
  });

  it("the gap is at most 2 × the section gap: a card that ends lower leaves the block there, above the card", () => {
    const f = heroBlock({ ...B, cardBottom: 900, plateBottom: 1374 });
    expect(f).toEqual({ air: 208, top: 656, bottom: 848, gap: 256, edge: "max" });
    // the ceiling follows the section gap the engine passes (2 × 96 on the 1024–1199 two-column page)
    expect(heroBlock({ ...B, cardBottom: 900, plateBottom: 1374, maxGap: 192 }).gap).toBe(192);
  });

  it("the block never goes under the bottom crop marks (its box on their line); never overlapping the headline wins over the crop marks", () => {
    expect(heroBlock({ ...B, cardBottom: 800, plateBottom: 760 })).toEqual({ air: 114, top: 562, bottom: 754, gap: 162, edge: "plate" });
    // a plate so short the block's box is already under it: the block stays at its floor under the headline
    expect(heroBlock({ ...B, cardBottom: 800, plateBottom: 600 })).toEqual({ air: 0, top: 448, bottom: 640, gap: 48, edge: "min" });
  });

  it("a measure that is not a number: null (heroBlock) — heroFit keeps the headline on the crop marks with no air; a missing part: heroFit null", () => {
    expect(heroBlock({ ...B, cardBottom: NaN })).toBeNull();
    expect(heroBlock({ ...B, cardBottom: 665, maxGap: NaN })).toBeNull();
    const g = input(REC["1440x900"].g), z = heroFit(g);
    const noCard = heroFit({ ...g, cardBottom: NaN });
    expect(noCard.block).toBeNull();
    expect(noCard.a1).toBe(0);
    expect(noCard.top).toBe(z.top);
    expect(heroFit({ ...g, sub: null })).toBeNull();
    expect(heroFit({ ...g, h1: { ...g.h1, fs: NaN } })).toBeNull();
    expect(heroFit({ ...g, plateTop: NaN })).toBeNull();
  });

  it("engine.js asks heroFit() on the two-column page only, with the plate's edges, the card's bottom edge and 2 × --sec, and writes two properties", () => {
    const at = engine.indexOf("const hf = heroFit(");
    expect(at).toBeGreaterThan(0);
    expect(engine.match(/heroFit\(/g)).toHaveLength(1);
    expect(engine.slice(at, at + 260)).toContain("heroFit({ plateTop: OY, plateBottom: OY + P, cardBottom, maxGap: 2 * parseFloat(getComputedStyle(R).getPropertyValue(\"--sec\")), h1: part(hq(\".h1\")), sub: part(hq(\".sub\")), trial: part(hq(\".trial\")) })");
    // the card's bottom edge: the roster's box as placed (box(): with any scale) + the card's bottom inside the figure
    expect(engine).toContain("const card = roster.querySelector(\".ro\"), cardBottom = card ? OY + at(box(roster), 0, relTop(card, roster) + card.offsetHeight)[1] : NaN;");
    expect(engine.slice(at, engine.indexOf("\n", engine.indexOf("\n", at) + 1))).toContain("{ \"--hero-top\": Math.round(hf.top) + \"px\", \"--hero-a1\": Math.round(hf.a1) + \"px\" }");
    expect(engine).not.toContain("--hero-a2");
    // the call sits in layout()'s `if (desk) {` branch, the one that used to centre the hero; the other branch sets only --hero-pull
    const branch = engine.lastIndexOf("if (desk) {", at), els = engine.indexOf("} else {", at);
    expect(engine.slice(branch, at)).not.toContain("} else {");
    expect(engine.slice(els, engine.indexOf("}", els + 8))).toContain("--hero-pull");
    expect(engine).not.toMatch(/\(avail - hh\) \/ 2/); // the old centring is gone
  });
});


describe("landingV6.css — the two-column hero's rules live in the two-column page only", () => {
  it("--hero-top and the one air row (--hero-a1, above the subline: the block's rows follow it with no air between) are read only there", () => {
    const rowsRule = rules.filter((r) => /var\(--hero-a1/.test(decls(r)["grid-template-rows"] || ""));
    expect(rowsRule.map(chain)).toEqual([[DESK]]);
    expect(decls(rowsRule[0])["grid-template-rows"]).toBe("auto var(--hero-a1,0px) auto auto auto");
    const rows = { ".lp6.story .hero > .h1": "1", ".lp6.story .hero > .sub": "3", ".lp6.story .hero > .cta-row": "4", ".lp6.story .hero > .trial": "5" };
    for (const [sel, row] of Object.entries(rows)) expect(where(sel, "grid-row", row)).toEqual([[DESK]]);
    // the block's own margins at ≥ 1200 (the parent's compact hero): subline 28 px, button row 36 px, trial line 12 px
    expect(where(".lp6 .sub", "margin-top", "28px")).toEqual([["(min-width:1200px)"]]);
    expect(where(".lp6 .cta-row", "margin-top", "36px")).toEqual([["(min-width:1200px)"]]);
    expect(where(".lp6 .trial", "margin-top", "12px")).toEqual([[]]);
    // nothing reads a second air row any more, and nothing else reads the hero's two properties
    expect(css).not.toContain("--hero-a2");
    const readers = rules.filter((r) => Object.values(decls(r)).some((v) => /--hero-(top|a1)\b/.test(v)));
    expect(readers.map((r) => [r.selector, chain(r)])).toEqual([
      [".lp6.story .hero", [DESK]], [".lp6.story .hero", [DESK]],
    ]);
  });

  it("≥ 1200 px the headline stops 24 px short of the plate: 9.35vw − 12 px, at most 122 px (12svh still rules where smaller)", () => {
    const capRule = rules.filter((r) => r.selector === ".lp6" && /min\(12svh/.test(decls(r)["--fs-h1"] || ""));
    expect(capRule.map(chain)).toEqual([[DESK1200]]);
    expect(decls(capRule[0])["--fs-h1"]).toBe("clamp(96px,min(12svh,9.35vw - 12px),122px)");
    // the widest first line, DA "Vagterne." + 01 (recorded: 4.3739 em + .08 em + 17.4 px), against the plate's left edge
    // (left column + gap = (min(vw,1440) − 200) · 5 / 12 + 72) less the stage's corner clearance, across the two-column sizes
    const fs = (vw, vh) => Math.min(122, Math.max(96, Math.min(0.12 * vh, 0.0935 * vw - 12)));
    for (const vw of [1200, 1280, 1300, 1366, 1440, 1680, 1920, 2560]) for (const vh of [800, 900, 1080, 1200, 1440]) {
      if (vw / vh < 1.25) continue;
      const line = 4.4539 * fs(vw, vh) + 17.4, plateLeft = ((Math.min(vw, 1440) - 200) * 5) / 12 + 72;
      expect(plateLeft - line).toBeGreaterThanOrEqual(24);
    }
  });
});

describe("landingV6.css — the one-column tablet stage: the headline flows, the two lines run to ~50ch", () => {
  it("the inline headline and the wider lines exist only inside [not the two-column page] → [768–1199 px]", () => {
    expect(where(".lp6 .h1 a", "display", "inline-block")).toEqual([["(max-width:767px) and (max-height:720px)"], [ONECOL, TABLET]]);
    expect(where(".lp6 .sub", "max-width", "48ch")).toEqual([[ONECOL, TABLET]]);
    expect(where(".lp6 .trial", "max-width", "52ch")).toEqual([[ONECOL, TABLET]]);
    // the tablet block holds exactly these three rules, and none of them can reach a phone or the two-column page
    const inTablet = rules.filter((r) => chain(r).join(" | ") === `${ONECOL} | ${TABLET}`);
    expect(inTablet.map((r) => [r.selector, decls(r)])).toEqual([
      [".lp6 .h1 a", { display: "inline-block" }], [".lp6 .sub", { "max-width": "48ch" }], [".lp6 .trial", { "max-width": "52ch" }],
    ]);
    expect(reachesPhone([ONECOL, TABLET])).toBe(false);
  });

  it("each word stays its own link with the stacked word's box: fit-content wide, one line high (inline-block, not inline)", () => {
    expect(where(".lp6 .h1 a", "width", "fit-content")).toEqual([[]]);
    expect(withSel(".lp6 .h1 a").some((r) => decls(r).display === "inline")).toBe(false);
  });
});

describe("landingV6.css — phones (< 768) keep every hero rule and token they had at 86472ec8", () => {
  const HERO = /(^|[\s>])(\.hero|#hero|\.h1|\.sub|\.cta-row|\.trial)(?![\w-])/;
  const phoneHero = () => rules.filter((r) => r.selector.split(",").some((s) => HERO.test(s.trim())) && reachesPhone(chain(r)))
    .map((r) => `${chain(r).join(" | ") || "-"} :: ${r.selector} { ${Object.entries(decls(r)).map(([k, v]) => `${k}:${v}`).join(";")} }`);
  const phoneTokens = () => {
    const out = [];
    for (const r of rules) if (r.selector === ".lp6" && reachesPhone(chain(r))) for (const [k, v] of Object.entries(decls(r))) if (/^--(fs-h1|fs-sub|fs-ui|hh|gut)$/.test(k)) out.push(`${chain(r).join(" | ") || "-"} :: ${k}:${v}`);
    return out;
  };

  it("the hero rules a phone can match, exactly", () => {
    expect(phoneHero()).toEqual([
      "- :: .lp6 .hero { position:relative;z-index:3;max-width:calc(1312px + 2*var(--gut));margin:0 auto;padding:calc(var(--hh) + 20px) var(--gut) 0 }",
      "- :: .lp6 .h1 { font-size:var(--fs-h1);line-height:.98;font-weight:600;letter-spacing:-.04em;color:var(--ink) }",
      "- :: .lp6 .h1 a { display:block;width:fit-content;text-decoration:none;color:inherit }",
      "- :: .lp6 .h1 sup { display:none;font-size:13px;font-weight:500;letter-spacing:.02em;line-height:1;vertical-align:top;position:relative;top:calc(var(--fs-h1)*.13);margin-left:calc(var(--fs-h1)*.08);color:var(--ink-3);font-variant-numeric:tabular-nums }",
      "(hover:hover) :: .lp6 .h1 a:hover > span { text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:.12em;text-decoration-color:var(--line) }",
      "- :: .lp6 .sub { margin-top:14px;font-size:var(--fs-sub);line-height:1.45;color:var(--ink-2);max-width:34ch;text-wrap:pretty }",
      "- :: .lp6 .cta-row { margin-top:20px;display:flex;align-items:center;gap:24px;flex-wrap:wrap }",
      "- :: .lp6 .cta-row .tlink { font-size:var(--fs-ui);font-weight:500;color:var(--ink) }",
      "- :: .lp6 .trial { margin-top:12px;font-size:15px;line-height:1.45;color:var(--ink-2);max-width:44ch }",
      "(max-width:359px) :: .lp6 .trial .nw { white-space:normal }",
      "(max-width:767px) and (max-height:720px) :: .lp6 .hero { padding-top:calc(var(--hh) + 10px) }",
      "(max-width:767px) and (max-height:720px) :: .lp6 .h1 { line-height:1 }",
      "(max-width:767px) and (max-height:720px) :: .lp6 .h1 a { display:inline-block }",
      "(max-width:767px) and (max-height:720px) :: .lp6 .sub { margin-top:8px;font-size:16px }",
      "(max-width:767px) and (max-height:720px) :: .lp6 .cta-row { margin-top:14px }",
      "(max-width:767px) and (max-height:720px) :: .lp6 .trial { margin-top:8px }",
      "not all and (min-width:1024px) and (min-aspect-ratio:5/4) :: .lp6.story .hero { margin-bottom:calc(var(--hero-pull,0) * 1px) }",
    ]);
  });

  it("the hero's tokens a phone can match, exactly", () => {
    expect(phoneTokens()).toEqual([
      "- :: --fs-h1:44px", "- :: --fs-sub:17px", "- :: --fs-ui:15px", "- :: --gut:20px", "- :: --hh:56px",
      "(max-width:380px) :: --fs-h1:40px", "(max-width:380px) :: --gut:16px", "(max-width:767px) and (max-height:720px) :: --fs-h1:36px",
    ]);
  });
});
