/**
 * LANDING V6 — the first screen's two layout rules (first-screen round, 23 Oct; Manoj's screenshots).
 *
 * 1. The two-column page (landscape ≥ 1024, aspect ≥ 5/4). He circled the empty band between the top bar and the headline at
 *    1440 × 900 ("these gaps — anything we can do?"): the crop marks started 40 px under the bar, the headline 154 px under it,
 *    because layout() centred the hero on the stage's middle line. Now (heroFit.js) the hero hangs from the plate's top edge — the
 *    headline's visible cap top on the line of the top crop marks — and the column's air under it is shared in three equal bands
 *    (headline → subline, subline → button, trial line → screen bottom), the phone stage's own rule, so the room taken from the
 *    top never piles up as one band at the bottom. ≥ 1200 px the headline is capped so its widest word (DA "Vagterne." + 01) ends
 *    24 px short of the plate (with the first line on the crop marks' line, "01" sat on the top-left crop mark at 1920 and 2560).
 * 2. The one-column tablet stage (768–1199 px wide, not the two-column page). "whats with those gap on right" at 820 × 1180: each
 *    headline word was a block and the subline / trial line were capped at 34ch / 44ch. Now the words flow inline (inline-block:
 *    each still its own link with the stacked word's box) and the two lines run to 48ch / 52ch.
 * Phones (< 768) are untouched: their hero rules and tokens are pinned below exactly as at 86472ec8.
 *
 * The geometry below is RECORDED, not made up: the built branch in headless Chromium (the lab's
 * port-build/first-screen/ probe), read exactly as engine.js layout() reads it — the hero's four parts with both air rows at 0
 * (offsetTop from the hero's content top, offsetHeight, computed font-size and line-height), the frame's padding-top (the plate's
 * top edge) and the stage height — and the --hero-top / --hero-a1 / --hero-a2 the engine then set. In the same run the headline's
 * first ink row sat on the crop mark's row (1280, 1366, 1920, 2560) or 1 px above it (1024, 1440: the cap top falls between pixels).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postcss from "postcss";
import { heroFit, capTop, baseline, INTER } from "../components/landing/v6/heroFit";

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

// [plateTop, screenBottom, h1, sub, cta, trial (each [top, h, fs, lh])] → the engine's [--hero-top, --hero-a1, --hero-a2]
const REC = {
  "1024x768": { g: [92, 768, [0, 193, 65.536, 64.2253], [213, 52, 18, 26.1], [297, 52, 18, 27], [361, 44, 15, 21.75]], set: [84, 85, 81], before: 157 },
  "1280x800": { g: [100, 800, [0, 282, 96, 94.08], [310, 58, 20, 29], [404, 52, 19, 28.5], [468, 46, 16, 23.2]], set: [88, 51, 55], before: 119 },
  "1366x768": { g: [100, 768, [0, 282, 96, 94.08], [310, 58, 20, 29], [404, 52, 19, 28.5], [468, 46, 16, 23.2]], set: [88, 40, 44], before: 103 },
  "1440x900": { g: [112, 900, [0, 317, 108, 105.84], [345, 58, 20, 29], [439, 52, 19, 28.5], [503, 46, 16, 23.2]], set: [98, 68, 74], before: 154 },
  "1920x1080": { g: [112, 1080, [0, 359, 122, 119.56], [387, 64, 22, 31.9], [486, 52, 19, 28.5], [550, 46, 16, 23.2]], set: [97, 111, 120], before: 214 },
  "2560x1440": { g: [112, 1440, [0, 359, 122, 119.56], [387, 64, 22, 31.9], [486, 52, 19, 28.5], [550, 46, 16, 23.2]], set: [97, 231, 240], before: 389 },
};
const P = ([top, h, fs, lh]) => ({ top, h, fs, lh });
const input = ([plateTop, screenBottom, h1, sub, cta, trial]) => ({ plateTop, screenBottom, h1: P(h1), sub: P(sub), cta: P(cta), trial: P(trial) });

describe("heroFit.js — the two-column hero hangs from the plate's top edge and shares its air in equal bands", () => {
  it("Inter's metrics: ascent 1984, descent 494, cap height 1490 of 2048; at line-height .98 the capitals start .126 em under the line box", () => {
    expect(INTER).toEqual({ asc: 1984 / 2048, desc: 494 / 2048, cap: 1490 / 2048 });
    expect(capTop(100, 98)).toBeCloseTo(12.6, 1);
    expect(baseline(100, 98)).toBeCloseTo(85.4, 1);
    // a line-height equal to the content area puts the baseline at the ascent
    expect(baseline(100, ((1984 + 494) / 2048) * 100)).toBeCloseTo(96.875, 6);
  });

  for (const [size, r] of Object.entries(REC)) {
    it(`${size}: the cap top on the crop marks' line, three equal bands, each smaller than the old top band (${r.before} px), as the engine set them`, () => {
      const f = heroFit(input(r.g));
      const [plateTop, , h1] = r.g;
      // the headline's first cap top = the plate's top edge
      expect(f.top + h1[0] + capTop(h1[2], h1[3])).toBeCloseTo(plateTop, 6);
      // what layout() wrote, rounded, in the real browser
      expect([Math.round(f.top), Math.round(f.a1), Math.round(f.a2)]).toEqual(r.set);
      // equal bands (none was already over its share at these sizes) and every one under the band that was removed at the top
      expect(f.bands[0]).toBeCloseTo(f.bands[1], 6);
      expect(f.bands[1]).toBeCloseTo(f.bands[2], 6);
      for (const b of f.bands) { expect(b).toBeGreaterThan(0); expect(b).toBeLessThan(r.before); }
    });
  }

  it("a band already larger than its share keeps its size and the other two share the rest; a hero taller than the screen gets no air", () => {
    const g = input(REC["1440x900"].g);
    const down = (p) => ({ ...p, top: p.top + 200 });
    // headline → subline 200 px longer: it keeps its size, subline → button and the bottom band come out equal
    const f = heroFit({ ...g, sub: down(g.sub), cta: down(g.cta), trial: down(g.trial) });
    const z = heroFit(g);
    expect(f.a1).toBe(0);
    expect(f.a2).toBeGreaterThan(0);
    expect(f.bands[0]).toBeCloseTo(z.bands[0] - z.a1 + 200, 6);
    expect(f.bands[1]).toBeCloseTo(f.bands[2], 6);
    expect(f.bands[2]).toBeGreaterThan(0);
    // the trial line already under the screen's bottom edge: no air anywhere, the headline still on the crop marks' line
    const t = heroFit({ ...g, screenBottom: 500 });
    expect([t.a1, t.a2]).toEqual([0, 0]);
    expect(t.top).toBe(z.top);
  });

  it("no layout (a missing part or a non-number): null, so the engine keeps the hero on the plate's top edge without air", () => {
    const g = input(REC["1440x900"].g);
    expect(heroFit({ ...g, sub: null })).toBeNull();
    expect(heroFit({ ...g, h1: { ...g.h1, fs: NaN } })).toBeNull();
    expect(heroFit({ ...g, plateTop: NaN })).toBeNull();
  });

  it("engine.js asks heroFit() on the two-column page only, with the plate's top edge (OY) and the stage height, and writes the three properties", () => {
    const at = engine.indexOf("const hf = heroFit(");
    expect(at).toBeGreaterThan(0);
    expect(engine.match(/heroFit\(/g)).toHaveLength(1);
    expect(engine.slice(at, at + 220)).toContain("heroFit({ plateTop: OY, screenBottom: svh, h1: part(hq(\".h1\")), sub: part(hq(\".sub\")), cta: part(hq(\".cta-row\")), trial: part(hq(\".trial\")) })");
    // the call sits in layout()'s `if (desk) {` branch, the one that used to centre the hero; the other branch sets only --hero-pull
    const branch = engine.lastIndexOf("if (desk) {", at), els = engine.indexOf("} else {", at);
    expect(engine.slice(branch, at)).not.toContain("} else {");
    expect(engine.slice(els, engine.indexOf("}", els + 8))).toContain("--hero-pull");
    expect(engine).not.toMatch(/\(avail - hh\) \/ 2/); // the old centring is gone
  });
});

describe("landingV6.css — the two-column hero's rules live in the two-column page only", () => {
  it("--hero-top and the two air rows (--hero-a1 above the subline, --hero-a2 above the button row) are read only there", () => {
    const rowsRule = rules.filter((r) => /var\(--hero-a1/.test(decls(r)["grid-template-rows"] || ""));
    expect(rowsRule.map(chain)).toEqual([[DESK]]);
    expect(decls(rowsRule[0])["grid-template-rows"]).toBe("auto var(--hero-a1,0px) auto var(--hero-a2,0px) auto auto");
    const rows = { ".lp6.story .hero > .h1": "1", ".lp6.story .hero > .sub": "3", ".lp6.story .hero > .cta-row": "5", ".lp6.story .hero > .trial": "6" };
    for (const [sel, row] of Object.entries(rows)) expect(where(sel, "grid-row", row)).toEqual([[DESK]]);
    // nothing else reads the hero's three properties
    const readers = rules.filter((r) => Object.values(decls(r)).some((v) => /--hero-(top|a1|a2)\b/.test(v)));
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
