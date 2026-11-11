/**
 * The Vagtplan's Orvexlo type + motion kit (Nov 2026), below the page:
 *
 *   • Fonts: Sora + DM Sans are imported ONLY by the staff portal's entry
 *     (pages/StaffPortalPage.jsx and its vagtplan.css) — never by main.jsx,
 *     so no other page pays — and Manrope is gone. Latin files per weight;
 *     latin-ext only through unicode-range rules.
 *   • vagtplan.css: the kit's tokens, the dock's geometry, and ONE
 *     prefers-reduced-motion block that turns every vp- animation and
 *     transition off.
 *   • Figures: Sora's woff2 really has tabular digits (`tnum`, ten digits
 *     one width) and DM Sans's does not — read from the shipped font files,
 *     which is why figures that must keep their width are drawn in Sora.
 *   • RollingDigits: the right value, nothing rolls on the first paint, only
 *     changed digits roll (the old digit out, the new one in; up when the
 *     value grew, down when it shrank), a screen reader reads the value once
 *     (never digit by digit), plain text again after the roll, and a plain
 *     single text node where motion is reduced or cannot be asked.
 *   • usePresence: an exit window with motion, none without.
 *   • useConfirm on the portal: the answer is instant, the dialog lingers
 *     for its exit; everywhere else it unmounts at once (owner app unchanged).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RollingDigits, { ROLL_MS } from "../components/staff/RollingDigits";
import { usePresence, useLastValue, EXIT_MS, exitMs } from "../components/staff/sheetMotion";
import { LanguageProvider } from "../hooks/useLanguage";
import { ConfirmProvider, useConfirm } from "../hooks/useConfirm";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const CSS = read("components/staff/vagtplan.css");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

function motionPref({ reduce }) {
  window.matchMedia = (q) => ({
    matches: q === "(prefers-reduced-motion: reduce)" ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

afterEach(() => {
  delete window.matchMedia;
  document.body.classList.remove("portal-shell");
  vi.useRealTimers();
});

describe("Fonts: Sora + DM Sans, self-hosted, loaded by the staff portal only", () => {
  const files = walk(SRC);
  const importers = (pkg) => files
    .filter((f) => read(path.relative(SRC, f)).includes(pkg))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .sort();

  it("only the portal entry (the page + its vagtplan.css) references them; main.jsx does not", () => {
    expect(importers("@fontsource/sora")).toEqual(["components/staff/vagtplan.css", "pages/StaffPortalPage.jsx"]);
    expect(importers("@fontsource/dm-sans")).toEqual(["components/staff/vagtplan.css", "pages/StaffPortalPage.jsx"]);
    expect(read("main.jsx")).not.toMatch(/sora|dm-sans/i);
    // The stylesheet itself is imported by the portal page and nowhere else.
    expect(importers("staff/vagtplan.css")).toEqual(["pages/StaffPortalPage.jsx"]);
  });

  it("the weights asked for, latin per weight, and vagtplan.css after them (its latin-ext rules must follow)", () => {
    const page = read("pages/StaffPortalPage.jsx");
    const imports = [...page.matchAll(/^import "(@fontsource\/[^"]+|\.\.\/components\/staff\/vagtplan\.css)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual([
      "@fontsource/sora/latin-600.css",
      "@fontsource/sora/latin-700.css",
      "@fontsource/dm-sans/latin-400.css",
      "@fontsource/dm-sans/latin-500.css",
      "@fontsource/dm-sans/latin-600.css",
      "@fontsource/dm-sans/latin-700.css",
      "../components/staff/vagtplan.css",
    ]);
  });

  it("latin-ext comes only through unicode-range rules (never fontsource's range-less latin-ext css)", () => {
    const faces = CSS.match(/@font-face\s*\{[^}]*\}/g) || [];
    expect(faces).toHaveLength(6);   // Sora 600/700 + DM Sans 400/500/600/700
    for (const f of faces) {
      expect(f).toMatch(/latin-ext-\d00-normal\.woff2/);
      expect(f).toMatch(/unicode-range: U\+0100-0130,/);
      // Never a range the latin file already draws (æ ø å are U+00E6 U+00F8 U+00E5).
      expect(f).not.toMatch(/U\+0000-00FF/);
    }
    for (const f of walk(SRC)) expect(read(path.relative(SRC, f))).not.toMatch(/@fontsource\/(sora|dm-sans)\/latin-ext/);
  });

  it("Manrope is gone: no import, no dependency", () => {
    for (const f of walk(SRC)) expect(read(path.relative(SRC, f))).not.toMatch(/@fontsource\/manrope/);
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
    expect(pkg.dependencies["@fontsource/manrope"]).toBeUndefined();
    expect(pkg.dependencies["@fontsource/sora"]).toBeTruthy();
    expect(pkg.dependencies["@fontsource/dm-sans"]).toBeTruthy();
  });

  it("on the portal, the text and display faces ARE DM Sans and Sora, with system fallbacks, smoothed, no tap flash", () => {
    const block = CSS.match(/body\.portal-shell \{[^}]*\}/)[0];
    expect(block).toMatch(/--font-display: 'Sora', 'DM Sans', ui-sans-serif, system-ui/);
    expect(block).toMatch(/--font-text: 'DM Sans', ui-sans-serif, system-ui/);
    expect(block).toContain("font-family: var(--font-text);");
    expect(block).toContain("-webkit-font-smoothing: antialiased;");
    expect(block).toContain("-webkit-tap-highlight-color: transparent;");
  });
});

// ── A tiny WOFF2 reader: enough to ask a shipped font file, not a stub,
// whether it has tabular digits and how wide its digits are. WOFF2 = a
// header, a table directory, then ONE brotli stream of the tables in
// directory order (no padding). GSUB/cmap/hhea/hmtx are read as in TrueType.
const NM = path.join(SRC, "..", "node_modules");
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB"];
function woff2Tables(rel) {
  const b = fs.readFileSync(path.join(NM, rel));
  expect(b.toString("latin1", 0, 4)).toBe("wOF2");
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i += 1) { const x = b[p++]; v = v * 128 + (x & 0x7f); if (!(x & 0x80)) return v; }
    throw new Error("bad UIntBase128");
  };
  const dir = [];
  for (let i = 0, n = b.readUInt16BE(12); i < n; i += 1) {
    const flags = b[p++];
    const tag = (flags & 0x3f) === 63 ? b.toString("latin1", p, (p += 4)) : (WOFF2_TAGS[flags & 0x3f] || `#${flags & 0x3f}`);
    const v = flags >> 6;
    const orig = base128();
    const transformed = tag === "glyf" || tag === "loca" ? v === 0 : v !== 0;
    dir.push({ tag, len: transformed ? base128() : orig, transformed });
  }
  const data = zlib.brotliDecompressSync(b.subarray(p, p + b.readUInt32BE(20)));
  const out = {};
  let off = 0;
  for (const t of dir) { out[t.tag] = { d: data.subarray(off, off + t.len), transformed: t.transformed }; off += t.len; }
  return out;
}
function gsubFeature(t, tag) {
  const g = t.GSUB.d;
  const fl = g.readUInt16BE(6);
  const lookups = [];
  for (let i = 0, n = g.readUInt16BE(fl); i < n; i += 1) {
    if (g.toString("latin1", fl + 2 + i * 6, fl + 6 + i * 6) !== tag) continue;
    const fo = fl + g.readUInt16BE(fl + 6 + i * 6);
    for (let j = 0, c = g.readUInt16BE(fo + 2); j < c; j += 1) lookups.push(g.readUInt16BE(fo + 4 + j * 2));
  }
  return lookups.length ? lookups : null;
}
function glyphOf(t, ch) {   // cmap format 4 (Windows Unicode BMP)
  const c = t.cmap.d;
  const cp = ch.charCodeAt(0);
  for (let i = 0, n = c.readUInt16BE(2); i < n; i += 1) {
    const so = c.readUInt32BE(8 + i * 8);
    if (c.readUInt16BE(so) !== 4) continue;
    const seg2 = c.readUInt16BE(so + 6);
    const ends = so + 14; const starts = ends + seg2 + 2; const deltas = starts + seg2; const ros = deltas + seg2;
    for (let s = 0; s < seg2 / 2; s += 1) {
      const start = c.readUInt16BE(starts + s * 2);
      if (cp < start || cp > c.readUInt16BE(ends + s * 2)) continue;
      const delta = c.readInt16BE(deltas + s * 2); const ro = c.readUInt16BE(ros + s * 2);
      if (ro === 0) return (cp + delta) & 0xffff;
      const gi = c.readUInt16BE(ros + s * 2 + ro + (cp - start) * 2);
      return gi === 0 ? 0 : (gi + delta) & 0xffff;
    }
  }
  throw new Error(`no glyph for ${ch}`);
}
function substituted(t, lookups, gid) {   // single substitution (type 1, or via extension 7)
  const g = t.GSUB.d;
  const ll = g.readUInt16BE(8);
  for (const li of lookups) {
    const lo = ll + g.readUInt16BE(ll + 2 + li * 2);
    for (let s = 0, n = g.readUInt16BE(lo + 4); s < n; s += 1) {
      let st = lo + g.readUInt16BE(lo + 6 + s * 2);
      let type = g.readUInt16BE(lo);
      if (type === 7) { type = g.readUInt16BE(st + 2); st += g.readUInt32BE(st + 4); }
      if (type !== 1) continue;
      const co = st + g.readUInt16BE(st + 2);
      let ci = -1;
      for (let k = 0, m = g.readUInt16BE(co + 2); k < m && ci < 0; k += 1) {
        if (g.readUInt16BE(co) === 1) { if (g.readUInt16BE(co + 4 + k * 2) === gid) ci = k; } else {
          const a = g.readUInt16BE(co + 4 + k * 6); const z = g.readUInt16BE(co + 6 + k * 6);
          if (gid >= a && gid <= z) ci = g.readUInt16BE(co + 8 + k * 6) + gid - a;
        }
      }
      if (ci >= 0) return g.readUInt16BE(st) === 1 ? (gid + g.readInt16BE(st + 4)) & 0xffff : g.readUInt16BE(st + 6 + ci * 2);
    }
  }
  return gid;
}
function advance(t, gid) {
  const nh = t.hhea.d.readUInt16BE(34);
  // A transformed hmtx is a flags byte, then the advance widths alone.
  return t.hmtx.transformed ? t.hmtx.d.readUInt16BE(1 + Math.min(gid, nh - 1) * 2) : t.hmtx.d.readUInt16BE(Math.min(gid, nh - 1) * 4);
}
const DIGITS = [..."0123456789"];

describe("Figures: tabular digits come from Sora (read from the shipped woff2 files)", () => {
  for (const w of [600, 700]) {
    it(`Sora ${w} has tnum: with it, all ten digits are ONE width (a ticking number keeps its width)`, () => {
      const t = woff2Tables(`@fontsource/sora/files/sora-latin-${w}-normal.woff2`);
      const tnum = gsubFeature(t, "tnum");
      expect(tnum).not.toBeNull();
      const plain = new Set(DIGITS.map((d) => advance(t, glyphOf(t, d))));
      const tab = new Set(DIGITS.map((d) => advance(t, substituted(t, tnum, glyphOf(t, d)))));
      expect(plain.size).toBeGreaterThan(1);   // proportional by default…
      expect(tab.size).toBe(1);                // …tabular with tnum
    });
  }

  for (const w of [400, 500, 600, 700]) {
    it(`DM Sans ${w}, as shipped, has NO tnum and proportional digits — so tabular-nums on it does nothing`, () => {
      const t = woff2Tables(`@fontsource/dm-sans/files/dm-sans-latin-${w}-normal.woff2`);
      expect(gsubFeature(t, "tnum")).toBeNull();
      const widths = DIGITS.map((d) => advance(t, glyphOf(t, d)));
      // '1' is about half as wide as '0'. (If a DM Sans update ever adds
      // tnum, this fails — and .vp-figures can go back to DM Sans.)
      expect(widths[1] / widths[0]).toBeLessThan(0.6);
    });
  }

  it(".vp-figures draws a figure in the display face (Sora on the portal) with tabular digits", () => {
    const rule = CSS.match(/body\.portal-shell \.vp-figures \{[^}]*\}/)[0];
    expect(rule).toContain("font-family: var(--font-display);");
    expect(rule).toContain("font-variant-numeric: tabular-nums;");
    expect(CSS.match(/body\.portal-shell \{[^}]*\}/)[0]).toMatch(/--font-display: 'Sora',/);
  });

  it("the figures that tick or stand in a column are drawn in Sora, never DM Sans", () => {
    const page = read("pages/StaffPortalPage.jsx");
    const line = (testid) => page.split("\n").find((l) => l.includes(`data-testid="${testid}"`)) || "";
    // Right-aligned hours columns and the holiday count: .vp-figures.
    for (const id of ["portal-hours-entry-total", "portal-hours-recent-total", "holiday-remaining"]) {
      expect(line(id)).toContain("vp-figures");
    }
    // The ticking ones (RollingDigits) sit inside Sora: the ring and Timer's total.
    expect(page).toMatch(/data-testid="portal-live-elapsed"\s*\n\s*style=\{\{ fontFamily: SORA,/);
    expect(line("portal-hours-total")).toContain("var(--font-display)");
  });
});

describe("vagtplan.css: the kit's tokens and the dock", () => {
  it("timing and easing tokens, springs as linear() with a cubic-bezier fallback", () => {
    for (const tok of [
      "--dur-press: 0.11s", "--dur-fast: 0.18s", "--dur-base: 0.32s", "--dur-exit: 0.24s",
      "--dur-slow: 0.64s", "--dur-nav: 0.42s", "--dur-nav-back: 0.36s", "--dur-spring: 0.5s",
      "--ease-nav: cubic-bezier(.32, .72, 0, 1)", "--ease-out: cubic-bezier(.2, .8, .2, 1)",
      "--spring: cubic-bezier(.34, 1.4, .64, 1)", "--spring-soft: cubic-bezier(.3, 1.15, .5, 1)",
    ]) expect(CSS).toContain(tok);
    expect(CSS).toMatch(/@supports \(transition-timing-function: linear\(0, 1\)\) \{\s*body\.portal-shell \{\s*--spring: linear\(/);
  });

  it("the dock: light warm bar, 52 tall (48 under 360), radius h/2, 12 px in, 8 over the safe area, max 560", () => {
    const dock = CSS.match(/\.vp-dock \{[^}]*\}/)[0];
    expect(dock).toContain("position: fixed;");
    expect(dock).toContain("height: 52px;");
    expect(dock).toContain("border-radius: 26px;");
    expect(dock).toContain("max-width: 560px;");
    expect(dock).toContain("left: max(12px, env(safe-area-inset-left, 0px));");
    expect(dock).toContain("bottom: calc(env(safe-area-inset-bottom, 0px) + 8px);");
    expect(dock).toContain("background: rgba(255, 253, 249, 0.97);");
    expect(dock).toContain("inset 0 1px 0 #ffffffb3");
    expect(dock).not.toMatch(/position: sticky|backdrop-filter/);
    expect(CSS).toMatch(/@media \(max-width: 359px\) \{\s*\.vp-dock \{ height: 48px; border-radius: 24px; \}/);
  });

  it("ONE indicator a column wide, moved by transform only, on the soft spring", () => {
    const ind = CSS.match(/\.vp-dock-ind \{[^}]*\}/)[0];
    expect(ind).toContain("width: calc((100% - 10px) / var(--n, 5));");
    expect(ind).toContain("transform: translateX(calc(var(--i, 0) * 100%));");
    expect(ind).toContain("transition: transform var(--dur-spring) var(--spring-soft), opacity var(--dur-fast) var(--ease-out);");
    expect(CSS).toMatch(/@keyframes vp-label-in \{ from \{ opacity: \.15; transform: scale\(\.55\); \} \}/);
    expect(CSS).toMatch(/\.vp-label-in \{ animation: vp-label-in 560ms var\(--spring\) backwards; \}/);
  });

  it("the indicator rides a clipping track the dock's shape; the dock itself never clips", () => {
    const track = CSS.match(/\.vp-dock-track \{[^}]*\}/)[0];
    expect(track).toContain("position: absolute;");
    expect(track).toContain("inset: 0;");
    expect(track).toContain("border-radius: inherit;");
    expect(track).toContain("overflow: hidden;");
    expect(track).toContain("pointer-events: none;");
    // Clipping the dock would cut the focus ring and the Beskeder count.
    expect(CSS.match(/\.vp-dock \{[^}]*\}/)[0]).not.toMatch(/overflow/);
  });

  it("press: down 0.96 in 0.11 s, back up on the spring; no double-tap delay, no callout", () => {
    const item = CSS.match(/\.vp-dock-item \{[^}]*\}/)[0];
    expect(item).toContain("transform var(--dur-spring) var(--spring)");
    expect(item).toContain("touch-action: manipulation;");
    expect(item).toContain("-webkit-touch-callout: none;");
    const down = CSS.match(/\.vp-dock-item:active \{[^}]*\}/)[0];
    expect(down).toContain("transform: scale(.96);");
    expect(down).toContain("transition-duration: var(--dur-fast), var(--dur-press);");
    const press = CSS.match(/\.vp-press \{[^}]*\}/)[0];
    expect(press).toMatch(/transition:\s*scale var\(--dur-spring\) var\(--spring\),/);
    expect(press).toContain("touch-action: manipulation;");
    expect(press).toContain("user-select: none;");
    const pressDown = CSS.match(/\.vp-press:active:not\(:disabled\) \{[^}]*\}/)[0];
    expect(pressDown).toContain("scale: .97;");
    expect(pressDown).toMatch(/transition-duration: var\(--dur-press\),/);
  });

  it("the three deliberate departures from the kit are written down for design", () => {
    for (const note of ["z-index 20, not the kit's 40", "inset 4px 3px, not 10px 3px", "not up to 2 lines"]) {
      expect(CSS).toContain(note);
    }
    expect(CSS.match(/\.vp-dock \{[^}]*\}/)[0]).toContain("z-index: 20;");
    expect(CSS.match(/\.vp-dock-pill \{[^}]*\}/)[0]).toContain("inset: 4px 3px;");
  });

  it("motion is transform + opacity only: no keyframe animates a layout property", () => {
    const frames = CSS.match(/@keyframes [\w-]+ \{[\s\S]*?\}\s*\}/g) || [];
    expect(frames.length).toBeGreaterThan(8);
    for (const k of frames) {
      const props = [...k.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      // Edited for the clock beat (CLOCK-MOTION-SPEC.md 2.8, reviewed): the
      // allow-list gains exactly one property, stroke-dashoffset — the clock
      // ring's draw; paint, not layout. Everything else stays banned.
      for (const p of props) expect(["opacity", "transform", "stroke-dashoffset"]).toContain(p);
    }
    // And only the ring's own keyframe uses it.
    const dash = frames.filter((k) => k.includes("stroke-dashoffset")).map((k) => k.match(/@keyframes ([\w-]+)/)[1]);
    expect(dash).toEqual(["vp-ring-draw"]);
  });
});

describe("Reduced motion: ONE block turns all of it off", () => {
  const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\)/g) || [];
  const start = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  const body = CSS.slice(start);

  it("there is exactly one", () => {
    expect(blocks).toHaveLength(1);
  });

  it("every vp- class that animates or transitions is in it", () => {
    const animated = new Set();
    for (const m of CSS.slice(0, start).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\b(animation|transition)\s*:/.test(m[2])) continue;
      if (/@keyframes|from|to\b|%/.test(m[1].trim().split("\n").pop())) continue;
      for (const c of m[1].matchAll(/\.(vp-[\w-]+)/g)) animated.add(c[1]);
    }
    expect([...animated].sort()).toEqual(expect.arrayContaining(["vp-breathe", "vp-dock-ind", "vp-dock-item", "vp-label-in", "vp-map-in", "vp-pop", "vp-press", "vp-roll-down", "vp-roll-in", "vp-roll-out", "vp-roll-up", "vp-scrim", "vp-screen-in", "vp-sheet", "vp-shimmer"]));
    for (const c of animated) expect(body).toContain(`.${c}`);
    expect(body).toMatch(/animation: none;/);
    expect(body).toMatch(/transition: none;/);
    // The shared confirm's portal motion too — its entrance AND its exit, so
    // CSS alone turns it all off (not only confirmExitMs() skipping the exit).
    expect(body).toContain("body.portal-shell [data-bb-confirm] > [data-bb-confirm-panel]");
    expect(body).toContain("body.portal-shell [data-bb-confirm][data-closing] > [data-bb-confirm-scrim]");
    expect(body).toContain("body.portal-shell [data-bb-confirm][data-closing] > [data-bb-confirm-panel]");
    // And every selector outside the block that animates the confirm is in it.
    for (const m of CSS.slice(0, start).matchAll(/^(body\.portal-shell \[data-bb-confirm\][^{]*)\{ animation/gm)) {
      expect(body).toContain(m[1].trim());
    }
    // The clock beat (CLOCK-MOTION-SPEC.md): every rule outside the block whose
    // selector names data-beat or the arc ghost and sets an animation is in
    // it with the SAME selector text. A media query adds no specificity, so a
    // shorter selector there (e.g. `[data-beat-phase] > .vp-hero > *`) would
    // lose to these attribute rules and turn nothing off.
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
    const plainBody = strip(body);
    let beatRules = 0;
    for (const m of strip(CSS.slice(0, start)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\banimation\s*:/.test(m[2])) continue;
      for (const sel of m[1].trim().split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!/data-beat|vp-arc-ghost/.test(sel)) continue;
        beatRules += 1;
        expect(plainBody).toContain(sel);
      }
    }
    expect(beatRules).toBe(13);
  });

  it("the clock beat: no infinite, filter, will-change, height, width or top in an animated rule; its two keyframes; the header names the one paint exception", () => {
    const from = CSS.indexOf("/* ── The clock beat");
    expect(from).toBeGreaterThan(0);
    const section = CSS.slice(from, start).replace(/\/\*[\s\S]*?\*\//g, "");
    let animated = 0;
    for (const m of section.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\banimation\s*:/.test(m[2])) continue;
      animated += 1;
      expect(m[2]).not.toMatch(/infinite|filter|will-change|(^|[\s;])(height|width|top)\s*:/);
    }
    expect(animated).toBeGreaterThanOrEqual(11);
    expect(CSS).toContain("@keyframes vp-ring-draw { from { stroke-dashoffset: 553; } }");
    expect(CSS).toContain("@keyframes vp-knob-lap { from { transform: rotate(-360deg); } }");
    expect(CSS.slice(0, CSS.indexOf("*/"))).toContain("plus the\n * clock ring's one stroke-dashoffset draw (paint, not layout); no layout\n * property animates");
    // Under reduce, the drawn track is a plain ring and the ghost is gone.
    expect(body).toContain('[data-beat-phase="enter"][data-beat-lap] .vp-lc-track { stroke-dasharray: none; }');
    expect(body).toMatch(/\.vp-arc-ghost \{ display: none; \}/);
  });

  it("the JS side reads the same query: no exit window under reduced motion, nor without matchMedia", () => {
    delete window.matchMedia;
    expect(exitMs()).toBe(0);
    motionPref({ reduce: true });
    expect(exitMs()).toBe(0);
    motionPref({ reduce: false });
    expect(exitMs()).toBe(EXIT_MS);
    expect(EXIT_MS).toBe(240);
  });
});

// Premium feel, Release A Step 1 (Nov 2026): the shared primitives' CSS —
// the press tint token and the busy → done look (BusyLabel.jsx, .vp-ring).
describe("Premium feel primitives (P1, P6)", () => {
  const start = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const outside = strip(CSS.slice(0, start));
  const body = strip(CSS.slice(start));
  // Every rule outside the block: [selectors[], declarations].
  const rules = [...outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => [m[1].trim().split(",").map((s) => s.trim()).filter(Boolean), m[2]])
    .filter(([sel]) => sel.length && !/^(@|from$|to$|\d+%)/.test(sel[0]));

  it("the grouped-row tint is a token in the portal's token block", () => {
    const block = CSS.match(/body\.portal-shell \{[^}]*\}/)[0];
    expect(block).toContain("--press-tint: rgba(14, 59, 46, .06);");
    expect(block.indexOf("--press-tint")).toBeGreaterThan(block.indexOf("--dur-spring"));
  });

  it("the busy look: one grid cell, the ring after the wait, the check pops on the spring", () => {
    expect(CSS).toMatch(/\.vp-busy \{ display: inline-grid; place-items: center;/);
    expect(CSS).toMatch(/\.vp-busy > \* \{ grid-area: 1 \/ 1;/);
    expect(CSS).toMatch(/\.vp-ring \{[^}]*animation: vp-spin 800ms linear infinite;/);
    expect(CSS).toMatch(/\.vp-busy\[data-state="busy"\] > \.vp-busy-spin \{ opacity: 1; animation: vp-spin 800ms linear infinite; \}/);
    expect(CSS).toMatch(/\.vp-busy\[data-state="done"\] > \.vp-busy-check \{ opacity: 1; animation: vp-pop var\(--dur-spring\) var\(--spring\) backwards; \}/);
    expect(CSS).toMatch(/@keyframes vp-spin \{ to \{ transform: rotate\(360deg\); \} \}/);
  });

  it(".vp-ring, .vp-busy, .vp-busy-label, .vp-busy-spin and .vp-busy-check are in the reduce block", () => {
    for (const c of [".vp-ring", ".vp-busy", ".vp-busy-label", ".vp-busy-spin", ".vp-busy-check"]) expect(body).toContain(c);
  });

  it("every rule keyed on data-pressed / data-state / data-dragged-out / data-sheet-dialog / data-closing that animates or transitions is mirrored with the SAME selector text", () => {
    // A media query adds no specificity: a shorter selector in the block would turn nothing off.
    const keyed = /data-(pressed|state|dragged-out|sheet-dialog|closing)/;
    let checked = 0;
    for (const [sels, decl] of rules) {
      if (!/\b(animation|transition)\s*:/.test(decl)) continue;
      for (const s of sels) {
        if (!keyed.test(s)) continue;
        checked += 1;
        expect(body).toContain(s);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6);   // the busy rules + the sheets' and confirm's exits
  });

  it("the only infinite animations: the live dot, the shimmer and the ring (also inside a busy label)", () => {
    const infinite = rules.filter(([, decl]) => /infinite/.test(decl)).flatMap(([sels]) => sels).sort();
    expect(infinite).toEqual([".vp-breathe", ".vp-busy[data-state=\"busy\"] > .vp-busy-spin", ".vp-ring", ".vp-shimmer::after"].sort());
  });
});

describe("RollingDigits", () => {
  // The digits that roll in, with their direction.
  const rolled = (el) => [...el.querySelectorAll(".vp-roll-up, .vp-roll-down")]
    .map((s) => `${s.querySelector(".vp-roll-in").textContent}${s.className.includes("down") ? "↓" : "↑"}`);
  // What a screen reader gets: every text node outside an aria-hidden subtree.
  const spoken = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute("aria-hidden") === "true") return "";
    return [...node.childNodes].map(spoken).join("");
  };
  // What the eye gets: the aria-hidden live copy without the outgoing digits
  // (the sr-only copy is invisible).
  const seen = (el) => {
    const live = el.querySelector(".vp-roll-live");
    if (!live) return el.textContent;
    const c = live.cloneNode(true);
    c.querySelectorAll(".vp-roll-out").forEach((o) => o.remove());
    return c.textContent;
  };

  it("renders the value as plain text; nothing rolls on the first paint", () => {
    motionPref({ reduce: false });
    const { container } = render(<RollingDigits value="2:16" />);
    const el = container.firstChild;
    expect(el.textContent).toBe("2:16");
    expect(el.childNodes).toHaveLength(1);
    expect(rolled(el)).toEqual([]);
  });

  it("only the digits that changed roll — up when the value grew", () => {
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value="2:16" />);
    rerender(<RollingDigits value="2:17" />);
    expect(seen(container.firstChild)).toBe("2:17");
    expect(rolled(container.firstChild)).toEqual(["7↑"]);
    rerender(<RollingDigits value="2:20" />);
    expect(seen(container.firstChild)).toBe("2:20");
    expect(rolled(container.firstChild)).toEqual(["2↑", "0↑"]);
    // A carry across the colon and a new column: still one direction, right text.
    rerender(<RollingDigits value="9:59" />);
    rerender(<RollingDigits value="10:00" />);
    expect(seen(container.firstChild)).toBe("10:00");
    expect(rolled(container.firstChild)).toEqual(["1↑", "0↑", "0↑", "0↑"]);
  });

  it("the old digit is there during the roll, laid over the new one, on its way out", () => {
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value="2:16" />);
    rerender(<RollingDigits value="2:17" />);
    const cell = container.querySelector(".vp-roll-cell");
    expect(cell.className).toContain("vp-roll-up");
    expect([...cell.children].map((c) => [c.className, c.textContent])).toEqual([["vp-roll-out", "6"], ["vp-roll-in", "7"]]);
    // A brand-new column has nothing to roll out.
    rerender(<RollingDigits value="9:59" />);
    rerender(<RollingDigits value="10:00" />);
    const first = container.querySelector(".vp-roll-cell");
    expect(first.querySelector(".vp-roll-out")).toBeNull();
    expect(first.querySelector(".vp-roll-in").textContent).toBe("1");
    // The CSS behind it: out on ease-in in 0.3 s, in on the soft spring in
    // 0.46 s, 80 ms behind — and in the other direction when counting down.
    expect(CSS).toContain(".vp-roll-up > .vp-roll-out { animation: vp-roll-out-up 300ms var(--ease-in) forwards; }");
    expect(CSS).toContain(".vp-roll-up > .vp-roll-in { animation: vp-roll-in-up 460ms var(--spring-soft) 80ms backwards; }");
    expect(CSS).toContain("@keyframes vp-roll-out-up { to { opacity: 0; transform: translateY(-.6em); } }");
    expect(CSS).toContain("@keyframes vp-roll-out-down { to { opacity: 0; transform: translateY(.6em); } }");
    expect(CSS.match(/\.vp-roll-out \{[^}]*\}/)[0]).toContain("position: absolute;");
    expect(CSS.match(/\.vp-roll-cell \{[^}]*\}/)[0]).toContain("position: relative;");
  });

  it("a screen reader reads the value once, at rest and mid-roll — never digit by digit", () => {
    vi.useFakeTimers();
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value="1:04" />);
    const el = container.firstChild;
    expect(spoken(el)).toBe("1:04");
    rerender(<RollingDigits value="1:05" />);
    // Mid-roll: the cells are hidden from it; a visually hidden copy speaks.
    expect(spoken(el)).toBe("1:05");
    expect(el.querySelector(".vp-roll-live").getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector(".sr-only").textContent).toBe("1:05");
    expect(el.querySelectorAll(".vp-roll-cell").length).toBe(1);
    // After the roll: one plain text node again (no hidden duplicate at rest).
    act(() => { vi.advanceTimersByTime(ROLL_MS); });
    expect(el.childNodes).toHaveLength(1);
    expect(el.firstChild.nodeType).toBe(Node.TEXT_NODE);
    expect(el.textContent).toBe("1:05");
    expect(spoken(el)).toBe("1:05");
  });

  it("a change mid-roll starts a fresh roll from what was showing", () => {
    vi.useFakeTimers();
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value="1:04" />);
    rerender(<RollingDigits value="1:05" />);
    act(() => { vi.advanceTimersByTime(ROLL_MS - 100); });
    rerender(<RollingDigits value="1:06" />);
    expect(rolled(container.firstChild)).toEqual(["6↑"]);
    expect(container.querySelector(".vp-roll-out").textContent).toBe("5");
    // The first roll's timer does not cut the second one short.
    act(() => { vi.advanceTimersByTime(100); });
    expect(container.querySelector(".vp-roll-cell")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(ROLL_MS); });
    expect(container.firstChild.textContent).toBe("1:06");
    expect(container.querySelector(".vp-roll-cell")).toBeNull();
  });

  it("rolls down when the value shrank (a shorter period), and a re-render with the same value replays nothing", () => {
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value="37,5" />);
    rerender(<RollingDigits value="31,5" />);
    expect(seen(container.firstChild)).toBe("31,5");
    expect(rolled(container.firstChild)).toEqual(["1↓"]);
    expect(container.querySelector(".vp-roll-down > .vp-roll-out").textContent).toBe("7");
    const digit = container.querySelector(".vp-roll-down");
    rerender(<RollingDigits value="31,5" />);
    // Same element: its animation is not restarted.
    expect(container.querySelector(".vp-roll-down")).toBe(digit);
  });

  it("numbers as well as strings", () => {
    motionPref({ reduce: false });
    const { container, rerender } = render(<RollingDigits value={4} />);
    rerender(<RollingDigits value={5} />);
    expect(seen(container.firstChild)).toBe("5");
    expect(spoken(container.firstChild)).toBe("5");
    expect(rolled(container.firstChild)).toEqual(["5↑"]);
  });

  it("reduced motion (or no matchMedia): ONE plain text node, like the span it replaced", () => {
    for (const setup of [() => motionPref({ reduce: true }), () => { delete window.matchMedia; }]) {
      setup();
      const { container, rerender, unmount } = render(<RollingDigits value="1:05" />);
      rerender(<RollingDigits value="1:06" />);
      const el = container.firstChild;
      expect(el.childNodes).toHaveLength(1);
      expect(el.firstChild.nodeType).toBe(Node.TEXT_NODE);
      expect(el.textContent).toBe("1:06");
      unmount();
    }
  });
});

describe("usePresence / useLastValue", () => {
  function Harness({ open, value }) {
    const p = usePresence(open);
    const v = useLastValue(value);
    return p.mounted ? <div data-testid="sheet" data-closing={p.closing ? "" : undefined}>{v}</div> : null;
  }

  it("with motion: closing for EXIT_MS (still showing the last value), then unmounted", () => {
    vi.useFakeTimers();
    motionPref({ reduce: false });
    const { rerender } = render(<Harness open value="tir." />);
    rerender(<Harness open={false} value={null} />);
    const el = screen.getByTestId("sheet");
    expect(el.hasAttribute("data-closing")).toBe(true);
    expect(el.textContent).toBe("tir.");
    act(() => { vi.advanceTimersByTime(EXIT_MS - 1); });
    expect(screen.getByTestId("sheet")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("reduced motion: unmounted in the same render", () => {
    motionPref({ reduce: true });
    const { rerender } = render(<Harness open value="x" />);
    rerender(<Harness open={false} value={null} />);
    expect(screen.queryByTestId("sheet")).toBeNull();
  });
});

describe("useConfirm: the answer is instant; the exit plays only on the portal", () => {
  function Asker({ onAnswer }) {
    const confirm = useConfirm();
    return <button type="button" onClick={async () => onAnswer(await confirm({ title: "Stempl ud?", message: "m" }))}>ask</button>;
  }
  const mountAsker = (onAnswer) => {
    localStorage.setItem("lang", "da");
    return render(
      <LanguageProvider><ConfirmProvider><Asker onAnswer={onAnswer} /></ConfirmProvider></LanguageProvider>,
    );
  };

  it("on the portal with motion: resolves at the tap, lingers inert with data-closing, then goes", async () => {
    vi.useFakeTimers();
    motionPref({ reduce: false });
    document.body.classList.add("portal-shell");
    const onAnswer = vi.fn();
    mountAsker(onAnswer);
    fireEvent.click(screen.getByText("ask"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.hasAttribute("data-bb-confirm")).toBe(true);
    expect(dialog.hasAttribute("data-closing")).toBe(false);
    await act(async () => { fireEvent.click(screen.getByText("Annuller")); });
    expect(onAnswer).toHaveBeenCalledWith(false);
    const leaving = document.querySelector("[data-bb-confirm]");
    expect(leaving.hasAttribute("data-closing")).toBe(true);
    expect(leaving.hasAttribute("inert")).toBe(true);
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(document.querySelector("[data-bb-confirm]")).toBeNull();
  });

  it("outside the portal (the owner app): unmounts at once, exactly as before", async () => {
    motionPref({ reduce: false });
    const onAnswer = vi.fn();
    mountAsker(onAnswer);
    fireEvent.click(screen.getByText("ask"));
    await act(async () => { fireEvent.click(screen.getByText("Annuller")); });
    expect(onAnswer).toHaveBeenCalledWith(false);
    expect(document.querySelector("[data-bb-confirm]")).toBeNull();
  });
});
