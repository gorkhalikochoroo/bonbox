/**
 * Landing v7, 12 Nov 2026, after the release went live. The founder: "put our original logo"; "why so big side bars?";
 * "why can't we auto detect screen and fit accordingly?"; then "mobile landing page looks good, just need to put our
 * original logo".
 *
 * Pins:
 *   - the logo is the kit's: BonBoxMark on the forest tile (paper b) and BonBoxWordmark; no typed "b" placeholder in the
 *     top bar, the HTML's first screen or the stylesheet; the first screen draws the same two SVGs as React, path for path;
 *   - from 720 px up every device screen takes its picture's own shape (the whole screenshot shows, no crop) and a phone's
 *     bezel is 3 % of the phone, in the hero, the duo and the trio; the hero's stage never outgrows the window's height;
 *   - under 720 px (the phone layout the founder approved) the stylesheet is the one of 63276802, the logo's rules aside;
 *   - the pictures with the official tile kept their sizes (every cut is its file's real width, the shape of the full one).
 * Review fixes (12 Nov 2026, on 52ef6489):
 *   - the share card is og-image-v8.png, v7's card with the official tile (v7 showed the placeholder "b");
 *   - on a wide window the stage keeps the live size and grows only as far as it still fits under the headline, so no
 *     window shows less of the devices on load than live (2560 x 1440 shows all of them again), and the hero's picture
 *     sizes follow the window's height;
 *   - the solo iPad keeps the live bezel on the wider column; the duo is as tall as its (now true-shape) phones need.
 * Short windows and the phone's phones (12 Nov 2026, on 0dff9d80). The founder: "make the headline adapt to the screen
 * height on short laptop screens" (the devices on the first screen, the headline big and his) and, on the phone layout,
 * "we can put slim bezel but looks really thick":
 *   - from 1024 px the headline and the two spaces around it follow the window's height too, and from 1100 px the stage is
 *     as wide as still fits under them, so at 1280 x 720, 1366 x 768, 1440 x 900, 1536 x 864 and 1920 x 1080 every device
 *     is on the first screen; tall windows (2560 x 1440 and up, every iPad upright) keep exactly what they had, and no
 *     window gets a bigger stage than before (the pictures' sizes stay true);
 *   - under 720 px a phone's bezel is 3 % of the phone and its screen its picture's shape, as from 720 px; everything else
 *     in the phone layout is 63276802's (the fingerprint, frames aside).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { FROM_PRICE } from "../lib/planPrices";
import TopBar from "../components/landing/v7/TopBar";
import BonBoxMark from "../components/BonBoxMark";
import BonBoxWordmark from "../components/BonBoxWordmark";
import { HERO_TABLET, IMG, PICS, SIZES } from "../components/landing/v7/assets";
import { HERO_IMG_V7, HERO_PHONE_FILE_V7, firstScreenMarkupV7, firstScreenRangeV7, logoV7 } from "../../scripts/landingFirstScreenV7.mjs";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CSS = fs.readFileSync(path.join(FRONTEND, "src/components/landing/v7/landingV7.css"), "utf8");
const tFor = (dict) => (key) => dict[key];
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

const topBar = (lang = "da") => render(
  <MemoryRouter><TopBar t={tFor(lang === "da" ? da : en)} lang={lang} onLang={() => {}} armed={false} /></MemoryRouter>,
).container;
const svgOf = (el) => { const { container } = render(el); return container.innerHTML; };

/** Every rule of the sheet as { media: [at-rule params…], selector, decl: {prop: value} }. */
function rulesOf(css) {
  const out = [];
  postcss.parse(css).walkRules((r) => {
    const media = [];
    for (let p = r.parent; p && p.type !== "root"; p = p.parent) if (p.type === "atrule") media.unshift(`@${p.name} ${p.params}`);
    const decl = {};
    r.each((n) => { if (n.type === "decl") decl[n.prop] = n.value + (n.important ? "!important" : ""); });
    out.push({ media, selector: r.selector.replace(/\s+/g, " "), decl });
  });
  return out;
}
const RULES = rulesOf(CSS);
/** The value a property gets from the rule with exactly this selector, in the given media (none: outside any). */
function valueOf(selector, prop, media = null) {
  const hits = RULES.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(selector) && r.decl[prop] !== undefined
    && (media === null ? r.media.length === 0 : r.media.join(" ") === media));
  expect(hits.length, `${selector} { ${prop} } in ${media || "no media"}`).toBeGreaterThan(0);
  return hits[hits.length - 1].decl[prop];
}
const TABLET_UP = "@media (min-width:720px)";
const PHONE = "@media (max-width:719px)";
const pct = (v) => { expect(v).toMatch(/^[\d.]+%$/); return parseFloat(v) / 100; };
const ratio = (v) => { const m = String(v).match(/^(\d+)\/(\d+)$/); expect(m, v).toBeTruthy(); return [+m[1], +m[2]]; };

describe("the logo is the kit's, everywhere on the landing's first screen", () => {
  it.each(["da", "en"])("%s: the top bar draws BonBoxMark on the tile and BonBoxWordmark, no typed letters", (lang) => {
    const brand = topBar(lang).querySelector(".brand");
    expect(brand.getAttribute("aria-label")).toBe("BonBox");
    expect(brand.getAttribute("href")).toBe("#top");
    expect(brand.textContent).toBe(""); // no "b" placeholder, no word typed in the page's font
    const mark = brand.querySelector(".mark");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.innerHTML).toBe(svgOf(<BonBoxMark size={26} />));
    expect(brand.lastElementChild.outerHTML).toBe(svgOf(<BonBoxWordmark height={19} title="" />));
  });

  it.each(["da", "en"])("%s: the first screen's logo is React's, path for path, read from the two components", (lang) => {
    const box = document.createElement("div");
    box.innerHTML = firstScreenMarkupV7(lang, { da, en, price: FROM_PRICE });
    const drawn = box.querySelector(".brand");
    expect(drawn.outerHTML).toBe(topBar(lang).querySelector(".brand").outerHTML);
    const logo = logoV7();
    expect(drawn.querySelector(".mark path").getAttribute("d")).toBe(logo.markPath);
    expect(svgOf(<BonBoxMark size={26} />)).toContain(`d="${logo.markPath}"`);
    expect(svgOf(<BonBoxWordmark height={19} />)).toContain(`d="${logo.wordPath}"`);
    // the kit's symbol file is the same b
    const kit = fs.readFileSync(path.join(FRONTEND, "..", "docs/brand/symbol/bonbox-symbol.svg"), "utf8");
    expect(kit).toContain(`d="${logo.markPath}"`);
    expect(box.innerHTML).not.toMatch(/<span class="mark"[^>]*>b</);
  });

  it("the tile is forest with a paper b in light and dark (never the ink tile or a typed glyph); the word turns paper at night", () => {
    expect(valueOf(".lp7 .mark", "background")).toBe("#093A26");
    expect(valueOf(".lp7 .mark", "color")).toBe("#F6F4EC");
    const mark = RULES.filter((r) => r.selector.split(",").map((s) => s.trim()).includes(".lp7 .mark"));
    for (const r of mark) {
      expect(r.decl.font, "a typed glyph's font").toBeUndefined();
      expect(r.decl.background || "").not.toMatch(/--ink/);
    }
    expect(valueOf(".lp7 .brand", "color")).toBe("#093A26");
    expect(valueOf(".lp7 .brand", "color", "@media (prefers-color-scheme:dark)")).toBe("#F6F4EC");
    // the logo's rules are in the first screen's part (the inline sheet draws it before the page's own)
    const part = firstScreenRangeV7(CSS);
    expect(part).toContain(".lp7 .mark{");
    expect(part).toContain(".lp7 .brand svg{display:block;flex:none}");
  });
});

describe("from 720 px up the devices are drawn at their true shape", () => {
  it("every screen takes its picture's shape (the whole screenshot shows) and the frame's height follows", () => {
    const phone = ratio(valueOf(".lp7 .phone .scr", "aspect-ratio", TABLET_UP));
    const tablet = ratio(valueOf(".lp7 .ipad .scr", "aspect-ratio", TABLET_UP));
    for (const k of ["staff", "week", "swap", "book", "bookEn", "bookPt"]) expect([IMG[k].width, IMG[k].height], k).toEqual(phone);
    for (const k of ["schedDraft", "schedPub", "host", "res", "close", "egen", "tips"]) expect([IMG[k].width, IMG[k].height], k).toEqual(tablet);
    expect([HERO_TABLET.width, HERO_TABLET.height]).toEqual(tablet);
    expect(valueOf(".lp7 .phone .scr", "height", TABLET_UP)).toBe("auto");
    expect(valueOf(".lp7 .ipad .scr", "height", TABLET_UP)).toBe("auto");
    expect(valueOf(".lp7 .phone", "aspect-ratio", TABLET_UP)).toBe("auto");
    expect(valueOf(".lp7 .ipad", "aspect-ratio", TABLET_UP)).toBe("auto");
    // so the picture's cover fit crops nothing: the box and the picture have one shape
    expect(valueOf(".lp7 .scr img", "object-fit")).toBe("cover");
  });

  it("a phone's bezel is 3 % of the phone: in the hero (24 % of the stage), the duo (44 %) and the trio (its column)", () => {
    const bezel = (width, padding) => padding / width;
    expect(bezel(pct(valueOf(".lp7 .phone", "width")), pct(valueOf(".lp7 .stage .phone", "padding", TABLET_UP)))).toBeCloseTo(0.03, 5);
    expect(bezel(pct(valueOf(".lp7 .duo .phone", "width")), pct(valueOf(".lp7 .duo .phone", "padding", TABLET_UP)))).toBeCloseTo(0.03, 5);
    expect(bezel(pct(valueOf(".lp7 .trio .phone", "width")), pct(valueOf(".lp7 .trio .phone", "padding", TABLET_UP)))).toBeCloseTo(0.03, 5);
    // the phone layout's phones the same (founder, 12 Nov 2026: "we can put slim bezel but looks really thick"): the hero's
    // phone is 40 % of the stage there, the duo's 44 % of the duo, the trio's their column
    expect(bezel(pct(valueOf(".lp7 .phone", "width", PHONE)), pct(valueOf(".lp7 .stage .phone", "padding", PHONE)))).toBeCloseTo(0.03, 5);
    expect(bezel(pct(valueOf(".lp7 .duo .phone", "width")), pct(valueOf(".lp7 .duo .phone", "padding", PHONE)))).toBeCloseTo(0.03, 5);
    expect(bezel(pct(valueOf(".lp7 .trio .phone", "width")), pct(valueOf(".lp7 .trio .phone", "padding", PHONE)))).toBeCloseTo(0.03, 5);
    // and the phone's screen, 94 % of the phone, is exactly its picture's shape: the frame is that plus the bezel
    const [w, h] = ratio(valueOf(".lp7 .phone .scr", "aspect-ratio", TABLET_UP));
    const frame = 1 / (0.94 * (h / w) + 0.06);
    expect(frame).toBeGreaterThan(0.47);
    expect(frame).toBeLessThan(0.48);
  });

  it("the stage fits the window's height under the top bar, and the page's column grows on wide screens", () => {
    expect(valueOf(".lp7 .stage-wrap", "width", TABLET_UP)).toBe("min(100%,max(480px,calc((100vh - 116px) * 1.6)))");
    expect(valueOf(".lp7 .stage", "aspect-ratio")).toBe("10/6.25"); // 1.6: the cap above is the stage's height ≤ 100vh - 116px
    expect(valueOf(".lp7 .wrap", "max-width", "@media (min-width:1280px)")).toBe("calc(clamp(1440px,62.5vw,1680px) + 2 * var(--gut))");
    expect(valueOf(".lp7 .wrap", "max-width")).toBe("1200px"); // below 1280 px, as it was
    // they live in the first screen's part (they shape the top bar and the hero), the short-window rules too
    const part = firstScreenRangeV7(CSS);
    for (const q of [720, 1024, 1100, 1280, 1366]) expect(part).toContain(`@media (min-width:${q}px){`);
    expect(part).toContain(`.lp7 .stage-wrap{width:${valueOf(".lp7 .stage-wrap", "width", "@media (min-width:1100px)")}}`);
    expect(part).toContain(`.lp7 .hero{--h1:${valueOf(".lp7 .hero", "--h1", "@media (min-width:1366px)")}}`);
  });

  it("the phone layout's phones too: the screen is its picture's shape and the frame follows (no stretch to the duo's foot)", () => {
    expect(valueOf(".lp7 .phone", "aspect-ratio", PHONE)).toBe("auto");
    expect(valueOf(".lp7 .phone .scr", "height", PHONE)).toBe("auto");
    expect(ratio(valueOf(".lp7 .phone .scr", "aspect-ratio", PHONE))).toEqual([IMG.staff.width, IMG.staff.height]);
    // the phone layout pins the hero's phone to the stage's foot (bottom:0); the duo's phones hang from their top, so with
    // no shape of their own a bottom:0 would stretch them to the duo's foot (it did: screens cut 15 % and 6 %)
    expect(valueOf(".lp7 .phone", "bottom", PHONE)).toBe("0");
    expect(valueOf(".lp7 .duo .phone", "bottom", PHONE)).toBe("auto");
    expect(valueOf(".lp7 .duo", "aspect-ratio", PHONE)).toBe(valueOf(".lp7 .duo", "aspect-ratio", TABLET_UP));
    // the iPad's frame on a phone is untouched
    expect(RULES.filter((r) => r.media.join(" ") === PHONE && /\.ipad\b/.test(r.selector)).map((r) => r.selector)).toEqual([".lp7 .ipad"]);
    expect(valueOf(".lp7 .ipad", "width", PHONE)).toBe("100%");
  });
});

/* The hero on a wide window, as a model of the stylesheet (review of 52ef6489, 12 Nov 2026: the stage followed the wider
 * column, so on a tall screen it ran past the window's foot; 2560 x 1440 showed 82 % of it on load, the live page 100 %).
 * Short windows (12 Nov 2026, on 0dff9d80; founder: "make the headline adapt to the screen height on short laptop
 * screens"): from 1024 px the headline and the spaces above the eyebrow and the stage follow the window's height, and from
 * 1100 px the stage is as wide as still fits under them. The model reads every size from the sheet; the stage's top is the
 * top bar (68 px and its 1 px rule), the space above the eyebrow, the hero's text row and the space above the stage. The
 * row is the headline's column (the eyebrow, 18.6 px, its 20 px and the headline's three lines at .92) unless the column
 * beside it is taller: that one is a browser fact, measured in Chromium in Danish and English (12 Nov 2026), 263-272 px up to
 * 1365 px wide (its two buttons wrap: in both languages under 1280 px, in English up to ~1310 px) and 212 px from 1366 px
 * (182.6 px in Danish from ~2560 px). The sheet keeps the headline at least as tall, so the row is the headline's. */
describe("the hero on a wide window: every device on the first screen of a short laptop, tall windows as they were", () => {
  const WIDE = "@media (min-width:1100px)";
  const SHORT = "@media (min-width:1024px)";
  const TOP_BAR = 69;
  const EYEBROW = 18.6 + 20;
  const LINES = 3 * 0.92;
  const SIDE = (vw) => (vw < 1366 ? 272 : 212);
  // the iPad's foot under the stage's top: 3 % of the stage's height (0.625 of its width) and its frame, a 0.815-wide
  // screen of the picture's shape and a 1.25 % bezel; the phone's foot is higher (0.587)
  const DEVICES_FOOT = 0.03 * 0.625 + 0.815 * (1112 / 1600) + 2 * 0.0125;
  const LIVE_STAGE = 1200 - 2 * 24; // 63276802: the 1200 px column, 24 px gutters, the stage its full width
  const clamp = (lo, v, hi) => Math.max(lo, Math.min(v, hi));
  /** a length expression of this sheet as a function of { col, vw, vh, h1 } in px: 100% is the column, vw / vh the window,
   *  var(--h1) the headline (compiled once per expression) */
  const compiled = new Map();
  const evalCss = (expr, { col = 0, vw = 0, vh = 0, h1 = 0 } = {}) => {
    const key = String(expr);
    if (!compiled.has(key)) {
      compiled.set(key, Function("Math", "CL", "col", "vw", "vh", "h1", `return ${key
        .replace(/var\(--h1\)/g, "h1")
        .replace(/calc\(/g, "(").replace(/\bmin\(/g, "Math.min(").replace(/\bmax\(/g, "Math.max(").replace(/\bclamp\(/g, "CL(")
        .replace(/100%/g, "col")
        .replace(/([\d.]+)vh/g, "($1 * vh / 100)").replace(/([\d.]+)vw/g, "($1 * vw / 100)")
        .replace(/([\d.])px/g, "$1")}`));
    }
    return compiled.get(key)(Math, clamp, col, vw, vh, h1);
  };
  /** the sheet's rules, read once */
  const sheet = new Map();
  const rule = (selector, prop, media) => {
    const k = `${media}|${selector}|${prop}`;
    if (!sheet.has(k)) sheet.set(k, valueOf(selector, prop, media));
    return sheet.get(k);
  };
  const column = (vw) => {
    if (vw < 1280) return Math.min(vw - 48, LIVE_STAGE);
    const gut = clamp(32, 0.025 * vw, 64);
    return Math.min(clamp(1440, 0.625 * vw, 1680), vw - 2 * gut);
  };
  /** the hero's sizes on a window 1024 px wide or more: the space above the eyebrow, the headline, the space above the stage */
  const hero = (vw, vh) => ({
    pad: evalCss(rule(".lp7 .hero", "padding-top", SHORT), { vw, vh }),
    h1: vw >= 1100 ? evalCss(rule(".lp7 .hero", "--h1", vw >= 1366 ? "@media (min-width:1366px)" : WIDE), { vw, vh })
      : evalCss(rule(".lp7 .hero h1", "font-size", SHORT), { vw, vh }),
    gap: evalCss(rule(".lp7 .stage-wrap", "margin-top", SHORT), { vw, vh }),
  });
  const stage = (vw, vh) => vw >= 1100
    ? evalCss(rule(".lp7 .stage-wrap", "width", WIDE), { col: column(vw), vw, vh, h1: hero(vw, vh).h1 })
    : evalCss(rule(".lp7 .stage-wrap", "width", TABLET_UP), { col: column(vw), vw, vh });
  const stageTop = (vw, vh) => { const h = hero(vw, vh); return TOP_BAR + h.pad + Math.max(EYEBROW + LINES * h.h1, SIDE(vw)) + h.gap; };
  // 0dff9d80, the sheet before this change, and 63276802, the live page (its 1200 px column; the same headline and spaces)
  const before = (vw, vh) => Math.min(column(vw), Math.max(480, (vh - 116) * 1.6), ...(vw >= 1280 ? [Math.max(1152, (vh - 642) * 1.6)] : []));
  const beforeHero = (vw) => ({ pad: clamp(36, 0.05 * vw, 80), h1: vw >= 1100 ? clamp(54, 0.084 * vw, 124) : clamp(54, 0.11 * vw, 104), gap: clamp(48, 0.06 * vw, 88) });
  const liveTop = (vw) => { const h = beforeHero(vw); return TOP_BAR + h.pad + EYEBROW + LINES * h.h1 + h.gap; };
  const shown = (top, s, vh) => Math.max(0, Math.min(1, (vh - top) / (DEVICES_FOOT * s)));

  const TARGETS = [[1280, 720], [1366, 768], [1440, 900], [1536, 864], [1920, 1080]];
  const WINDOWS = [...TARGETS, [1680, 1050], [1920, 900], [1920, 1200], [2560, 1080], [2560, 1440], [2560, 1600], [2880, 1800],
    [3840, 2160], [1280, 1600], [1440, 2560], [1100, 700], [1180, 820], [1366, 1024]];
  const TALL = [[2560, 1440], [2560, 1600], [2880, 1800], [3840, 2160], [1280, 1600], [1440, 2560], [1024, 1366]];

  it("the sheet: the headline and the two spaces follow the height from 1024 px; the stage's sum from 1100 px, its old caps last", () => {
    expect(valueOf(".lp7 .hero", "padding-top", SHORT)).toBe("min(clamp(36px,5vw,80px),5.6vh)");
    expect(valueOf(".lp7 .stage-wrap", "margin-top", SHORT)).toBe("min(clamp(48px,6vw,88px),6.2vh)");
    expect(valueOf(".lp7 .hero h1", "font-size", SHORT)).toBe("clamp(54px,min(11vw,9.2vh),104px)");
    expect(valueOf(".lp7 .hero h1", "font-size", WIDE)).toBe("var(--h1)");
    expect(valueOf(".lp7 .hero", "--h1", WIDE)).toBe("clamp(85px,min(8.4vw,9.2vh),124px)");
    expect(valueOf(".lp7 .hero", "--h1", "@media (min-width:1366px)")).toBe("clamp(63px,min(8.4vw,9.2vh),124px)");
    expect(valueOf(".lp7 .stage-wrap", "width", WIDE)).toBe("min(100%,max(400px,calc((100vh - 69px - min(clamp(36px,5vw,80px),5.6vh) - 38.6px - "
      + "2.76 * var(--h1) - min(clamp(48px,6vw,88px),6.2vh) - 24px) * 1.6)),max(1152px,calc((100vh - 642px) * 1.6)))");
    // the sum's terms are the sheet's own: the hero's padding and the stage's margin above, the eyebrow and the headline's lines
    expect(valueOf(".lp7 .stage-wrap", "width", WIDE)).toContain(`- ${valueOf(".lp7 .hero", "padding-top", SHORT).replace(/\s/g, "")} -`);
    expect(valueOf(".lp7 .stage-wrap", "width", WIDE)).toContain(`- ${valueOf(".lp7 .stage-wrap", "margin-top", SHORT)} -`);
    expect(valueOf(".lp7 .eyebrow", "font-size")).toBe("12px"); // x 1.55, the page's line height: 18.6 px
    expect(valueOf(".lp7 .hero h1", "line-height")).toBe(".92");
    expect(valueOf(".lp7 .hero h1", "margin-top")).toBe("20px");
    expect(valueOf(".lp7 .top .wrap", "height")).toBe("68px");
    expect(valueOf(".lp7 .stage", "aspect-ratio")).toBe("10/6.25");
    expect(LIVE_STAGE).toBe(1152);
  });

  it("the headline is never shorter than the column beside it, so the hero's row is the headline's (the sum is exact)", () => {
    for (let vw = 1100; vw <= 3840; vw += 2) for (let vh = 400; vh <= 2200; vh += 25) {
      expect(EYEBROW + LINES * hero(vw, vh).h1, `${vw} x ${vh}`).toBeGreaterThanOrEqual(SIDE(vw));
    }
  });

  it.each(TARGETS)("%i x %i (a short laptop): every device is on the first screen, with room to spare", (vw, vh) => {
    const s = stage(vw, vh), top = stageTop(vw, vh);
    expect(top + DEVICES_FOOT * s, "the devices' foot").toBeLessThanOrEqual(vh - 16);
    expect(top + s / 1.6 + 24, "the stage and 24 px").toBeLessThanOrEqual(vh + 1e-6);
    expect(s).toBeGreaterThanOrEqual(400);
    expect(hero(vw, vh).h1, "the headline stays big").toBeGreaterThanOrEqual(63);
    expect(shown(liveTop(vw), Math.min(vw - 48, LIVE_STAGE), vh), "the live page cut it").toBeLessThan(0.7);
  });

  it.each(WINDOWS)("%i x %i: at least as much of the devices on load as live and as before, and all of the stage once scrolled to", (vw, vh) => {
    const s = stage(vw, vh), top = stageTop(vw, vh);
    const live = Math.min(vw - 48, LIVE_STAGE);
    expect(s).toBeLessThanOrEqual(column(vw) + 1e-6);
    expect(shown(top, s, vh)).toBeGreaterThanOrEqual(shown(liveTop(vw), live, vh) - 1e-9);
    expect(shown(top, s, vh)).toBeGreaterThanOrEqual(shown(liveTop(vw), before(vw, vh), vh) - 1e-9);
    expect(s / 1.6).toBeLessThanOrEqual(vh - TOP_BAR); // whole under the top bar once scrolled to
    // never smaller than live where the live stage was already whole on load, with the 24 px to spare
    if (liveTop(vw) + live / 1.6 + 24 <= vh) expect(s).toBeGreaterThanOrEqual(live - 1e-6);
  });

  it("no window gets a bigger stage than before (so the pictures' sizes stay true), and with room it is whole on load", () => {
    for (let vw = 1100; vw <= 3840; vw += 6) for (let vh = 500; vh <= 2200; vh += 10) {
      const s = stage(vw, vh);
      expect(s, `${vw} x ${vh}`).toBeLessThanOrEqual(before(vw, vh) + 1e-6);
      if (s > 400 + 1e-6) expect(stageTop(vw, vh) + s / 1.6 + 24, `${vw} x ${vh}`).toBeLessThanOrEqual(vh + 1e-6);
    }
  });

  it.each(TALL)("%i x %i (tall): the headline, the spaces and the stage are exactly what they were", (vw, vh) => {
    const h = hero(vw, vh), b = beforeHero(vw);
    expect(h.pad).toBeCloseTo(b.pad, 9);
    expect(h.h1).toBeCloseTo(b.h1, 9);
    expect(h.gap).toBeCloseTo(b.gap, 9);
    expect(stage(vw, vh)).toBeCloseTo(before(vw, vh), 9);
  });

  it("2560 x 1440 keeps its 1277 px stage, whole on load (798 px tall, its foot at 1416)", () => {
    expect(Math.round(stage(2560, 1440))).toBe(1277);
    expect(stageTop(2560, 1440) + stage(2560, 1440) / 1.6).toBeCloseTo(1416, 0);
  });

  /* The pictures' sizes (assets.js, the first screen's preload): never less than the screen is drawn (the 1100 / 320 px
   * files would be stretched), never more than the live page asked for on a window up to 1362 px tall (968 / 280 px). */
  const srcSize = (sizes, vw, vh) => {
    for (const entry of sizes.split(/,\s*(?=\(|calc|\d)/)) {
      const m = entry.match(/^\((max|min)-(width|height): (\d+)px\) (.+)$/);
      const [cond, len] = m ? [m, m[4]] : [null, entry];
      if (cond) {
        const v = cond[2] === "width" ? vw : vh;
        if (cond[1] === "max" ? v > +cond[3] : v < +cond[3]) continue;
      }
      return evalCss(len, { vw, vh });
    }
    throw new Error("no size");
  };
  const pick = (files, need) => files.find((w) => w >= need) || files[files.length - 1];
  it("the hero's picture sizes follow the stage on every wide window (iPad screen 0.815 x the stage, phone screen 0.2256 x)", () => {
    for (const vw of [1100, 1180, 1279, 1280, 1366, 1440, 1536, 1920, 2304, 2560, 2880, 3840]) {
      for (let vh = 600; vh <= 2200; vh += 50) {
        const s = stage(vw, vh);
        const tablet = srcSize(HERO_TABLET.sizes, vw, vh), phone = srcSize(SIZES.heroPhone, vw, vh);
        expect(tablet, `${vw} x ${vh} tablet`).toBeGreaterThanOrEqual(0.815 * s - 1);
        expect(phone, `${vw} x ${vh} phone`).toBeGreaterThanOrEqual(0.2256 * s - 1);
        if (vh <= 1362) { expect(tablet).toBeLessThanOrEqual(968); expect(phone).toBeLessThanOrEqual(280); }
        // taller: the height's share. On a landscape window the browser then picks the very file the drawn screen needs,
        // at 1x and 2x (on a tall portrait one the column caps the stage first: the sizes may pick the bigger file, never
        // a stretched one)
        else if (vw >= vh) {
          for (const dpr of [1, 2]) {
            expect(pick([700, 1100, 1600], tablet * dpr), `${vw} x ${vh} @${dpr}x tablet`).toBe(pick([700, 1100, 1600], 0.815 * s * dpr));
            expect(pick([320, 640], phone * dpr), `${vw} x ${vh} @${dpr}x phone`).toBe(pick([320, 640], 0.2256 * s * dpr));
          }
        }
      }
    }
    // the first screen's preload asks for the same picture (landingV7FirstScreen.test.jsx pins the equality)
    expect(HERO_IMG_V7.sizes).toBe(HERO_TABLET.sizes);
  });
});

describe("the section frames on a wide window", () => {
  it("the solo iPad keeps the live bezel: 14.4 px (1.25 % of the old 1152 px column), not a share of the wider column", () => {
    expect(valueOf(".lp7 .ipad.solo", "padding", "@media (min-width:1280px)")).toBe("14.4px");
    expect(0.0125 * 1152).toBeCloseTo(14.4, 6);
    expect(valueOf(".lp7 .wide-shot .ipad.solo", "max-width")).toBe("1040px");
    expect(pct(valueOf(".lp7 .ipad", "padding"))).toBe(0.0125); // under 1280 px, as it was
  });

  it("the duo is as tall as its phones need: ~1.2 % of it under the lower phone, as live", () => {
    const [aw, ah] = valueOf(".lp7 .duo", "aspect-ratio", TABLET_UP).split("/").map(Number);
    const k = ah / aw; // height per width
    const w = pct(valueOf(".lp7 .duo .phone", "width"));
    const pad = pct(valueOf(".lp7 .duo .phone", "padding", TABLET_UP));
    const [sw, sh] = ratio(valueOf(".lp7 .phone .scr", "aspect-ratio", TABLET_UP));
    const phoneH = (w - 2 * pad) * (sh / sw) + 2 * pad;
    const top2 = pct(valueOf(".lp7 .duo .phone + .phone", "top"));
    const under = k - (top2 * k + phoneH);
    const liveUnder = 1.06 - (0.09 * 1.06 + 0.44 * (844 / 390)); // 63276802: 10/10.6, phones 390/844
    expect(under).toBeGreaterThan(0);
    expect(Math.abs(under - liveUnder)).toBeLessThan(0.002);
    expect(valueOf(".lp7 .duo", "aspect-ratio")).toBe("10/10.6"); // under 720 px, as it was
  });
});

/* The share card (index.html's og:image and twitter:image): og-image-v8.png is v7's card with the official tile in the
 * iPad's sidebar (v7 showed the placeholder ink tile with a typed "b") and the phone at its true bezel; everything above
 * the devices is v7's, pixel for pixel. */
describe("the share card shows the official tile", () => {
  /** Decode an 8-bit RGB, non-interlaced PNG. */
  const decodeRgb = (file) => {
    const b = fs.readFileSync(file);
    let off = 8, width = 0, height = 0;
    const idat = [];
    while (off < b.length) {
      const len = b.readUInt32BE(off), type = b.toString("ascii", off + 4, off + 8), data = b.subarray(off + 8, off + 8 + len);
      if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); expect([data[8], data[9], data[12]]).toEqual([8, 2, 0]); }
      if (type === "IDAT") idat.push(data);
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * 3, px = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)];
      for (let x = 0; x < stride; x++) {
        const r = raw[y * (stride + 1) + 1 + x], a = x >= 3 ? px[y * stride + x - 3] : 0, up = y > 0 ? px[(y - 1) * stride + x] : 0;
        const c = x >= 3 && y > 0 ? px[(y - 1) * stride + x - 3] : 0;
        let v = r;
        if (f === 1) v = r + a; else if (f === 2) v = r + up; else if (f === 3) v = r + ((a + up) >> 1);
        else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
        px[y * stride + x] = v & 0xff;
      }
    }
    return { width, height, at: (x, y) => [px[(y * width + x) * 3], px[(y * width + x) * 3 + 1], px[(y * width + x) * 3 + 2]], row: (y) => px.subarray(y * stride, (y + 1) * stride) };
  };
  const v7 = decodeRgb(path.join(FRONTEND, "public", "og-image-v7.png"));
  const v8 = decodeRgb(path.join(FRONTEND, "public", "og-image-v8.png"));
  /** the sidebar's tile, x 45-94, y 488-535 on the 1200 x 630 card: forest (#093A26) and ink (the placeholder's) pixels */
  const tile = (img) => {
    let forest = 0, ink = 0;
    for (let y = 488; y < 536; y++) for (let x = 45; x < 95; x++) {
      const [r, g, b] = img.at(x, y);
      if (Math.max(Math.abs(r - 9), Math.abs(g - 58), Math.abs(b - 38)) <= 14) forest++;
      if (Math.max(r, g, b) < 45 && Math.abs(r - g) < 8) ink++;
    }
    return { forest, ink };
  };

  it("index.html shares v8; v8 is 1200 x 630 and above the devices (rows 0-466) it is v7's card exactly", () => {
    const html = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
    expect(html).toContain('<meta property="og:image" content="https://www.bonbox.dk/og-image-v8.png" />');
    expect(html).toContain('<meta name="twitter:image" content="https://www.bonbox.dk/og-image-v8.png" />');
    expect([v8.width, v8.height]).toEqual([1200, 630]);
    for (let y = 0; y < 467; y++) expect(Buffer.compare(v8.row(y), v7.row(y)), `row ${y}`).toBe(0);
  });

  it("the iPad's sidebar tile is forest with the b, no ink tile (v7's was the placeholder)", () => {
    const old = tile(v7), now = tile(v8);
    expect(old.ink).toBeGreaterThan(500); // the probe sees the placeholder where it was
    expect(old.forest).toBe(0);
    expect(now.ink).toBe(0);
    expect(now.forest).toBeGreaterThan(450);
  });
});

describe("the phone layout (under 720 px) is the one the founder approved", () => {
  /* The stylesheet a phone gets: every rule outside a min-width query, the logo's (.brand / .mark) aside. A change to the
   * phone layout fails here: make it on purpose, with the founder's yes, and put the new fingerprint in.
   * 12 Nov 2026 (on 0dff9d80), changed on purpose: the founder asked for a slim phone bezel on the phone layout too ("we can
   * put slim bezel but looks really thick"): the phones' frames (the hero's, the duo's and the trio's) take the true shape
   * they have from 720 px, a 3 % bezel and the picture's own screen shape, and nothing else moves. So the full sheet has a
   * new fingerprint (321 rules, was 316), and with the phones' frame rules of the phone layout set aside it is still,
   * exactly, the one of 63276802's landingV7.css (the release that went live on 12 Nov 2026). */
  const PHONE_SHEET = "dc700716ab48e1309fb23fc555e1af31867c6eddbc03c883a3500c4d0c1c1cfd";
  const PHONE_SHEET_63276802_FRAMES_ASIDE = "09675989967d719429952498aee028aca6b7b06f4e2212763564e79c9ec8ac39";
  const phoneLines = () => RULES
    .filter((r) => !r.media.some((m) => /min-width/.test(m)) && !/\.(brand|mark)\b/.test(r.selector))
    .map((r) => `${r.media.join(" ")}|${r.selector}|${Object.entries(r.decl).map(([k, v]) => `${k}:${v}`).join(";")}`);
  const sha = (lines) => crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
  it("its stylesheet is the approved one, the logo aside (the slim bezel of 12 Nov 2026 in)", () => {
    const lines = phoneLines();
    expect(lines.length).toBe(321);
    expect(sha(lines)).toBe(PHONE_SHEET);
  });

  it("with the phones' frames of the phone layout aside, it is 63276802's exactly: the bezel is the only change", () => {
    const frames = (l) => l.startsWith(`${PHONE}|`) && /\.(phone|duo|trio)\b/.test(l.split("|")[1]);
    const aside = phoneLines().filter((l) => !frames(l));
    expect(aside.length).toBe(314);
    expect(sha(aside)).toBe(PHONE_SHEET_63276802_FRAMES_ASIDE);
    // and the frame rules set aside are these (the hero's phone keeps its place: 40 % wide, at the stage's foot, 3 % in)
    expect(phoneLines().filter(frames)).toEqual([
      `${PHONE}|.lp7 .phone|width:40%;top:auto;bottom:0;right:3%;aspect-ratio:auto`,
      `${PHONE}|.lp7 .phone .scr|height:auto;aspect-ratio:640/1385`,
      `${PHONE}|.lp7 .stage .phone|padding:1.2%`,
      `${PHONE}|.lp7 .duo|aspect-ratio:10/10.26`,
      `${PHONE}|.lp7 .duo .phone|padding:1.32%;bottom:auto`,
      `${PHONE}|.lp7 .trio .phone|padding:3%`,
      `${PHONE}|.lp7 .trio .phone:nth-child(2)|transform:translateY(-6%)`,
    ]);
  });

  it("every new rule for the frames and the fit sits behind a min-width query (720, 1280; the short-window ones 1024, 1100, 1366)", () => {
    for (const r of RULES.filter((x) => x.media.some((m) => /min-width/.test(m)))) {
      expect(r.media.join(" "), r.selector).toMatch(/^@media \(min-width:(720|1024|1100|1280|1366)px\)$/);
    }
  });

  it("the phone's picture sizes are the ones it had (the hero's first branch)", () => {
    expect(HERO_TABLET.sizes.startsWith("(max-width: 719px) calc(100vw - 40px), (max-width: 1099px) calc(84vw - 40px), ")).toBe(true);
  });
});

describe("the pictures with the official tile kept their sizes", () => {
  const webpSize = (file) => {
    const buf = fs.readFileSync(file);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 15)).toBe("WEBPVP8");
    const vp8 = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
    return { w: buf.readUInt16LE(vp8 + 3) & 0x3fff, h: buf.readUInt16LE(vp8 + 5) & 0x3fff, bytes: buf.length };
  };
  it.each(["schedDraft", "schedPub", "res", "close", "tips"])("%s: the full file and every cut are their stated widths, one shape", (k) => {
    const img = IMG[k];
    const full = webpSize(path.join(FRONTEND, "public", img.src));
    expect([full.w, full.h]).toEqual([img.width, img.height]);
    for (const c of img.srcSet.split(",").map((s) => s.trim().split(" "))) {
      expect(c[0].startsWith(PICS)).toBe(true);
      const cut = webpSize(path.join(FRONTEND, "public", c[0]));
      expect(cut.w + "w").toBe(c[1]);
      expect(Math.abs(cut.w / cut.h - img.width / img.height)).toBeLessThan(0.01);
    }
  });
  it("the hero's phone cut stays the 700 px cut, under 16 KB", () => {
    const cut = webpSize(path.join(FRONTEND, "src", HERO_PHONE_FILE_V7));
    expect([cut.w, cut.h]).toEqual([700, 487]);
    expect(cut.bytes).toBeLessThan(16 * 1024);
  });
});
