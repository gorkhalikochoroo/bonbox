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
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { FROM_PRICE } from "../lib/planPrices";
import TopBar from "../components/landing/v7/TopBar";
import BonBoxMark from "../components/BonBoxMark";
import BonBoxWordmark from "../components/BonBoxWordmark";
import { HERO_TABLET, IMG, PICS } from "../components/landing/v7/assets";
import { HERO_PHONE_FILE_V7, firstScreenMarkupV7, firstScreenRangeV7, logoV7 } from "../../scripts/landingFirstScreenV7.mjs";

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
    // both live in the first screen's part (they shape the top bar and the hero)
    const part = firstScreenRangeV7(CSS);
    expect(part).toContain("@media (min-width:720px){");
    expect(part).toContain("@media (min-width:1280px){");
  });
});

describe("the phone layout (under 720 px) is the one the founder approved", () => {
  /* The stylesheet a phone gets: every rule outside a min-width query, the logo's (.brand / .mark) aside. Its fingerprint
   * is the one of 63276802's landingV7.css (the release that went live on 12 Nov 2026), taken the same way. A change to
   * the phone layout fails here: make it on purpose, with the founder's yes, and put the new fingerprint in. */
  const PHONE_SHEET_63276802 = "d2b6bad6cb12c83036e4d488d8793e106d43a5fe4249a48d66dcb6ad75d05818";
  it("its stylesheet is unchanged, the logo aside", () => {
    const lines = RULES
      .filter((r) => !r.media.some((m) => /min-width/.test(m)) && !/\.(brand|mark)\b/.test(r.selector))
      .map((r) => `${r.media.join(" ")}|${r.selector}|${Object.entries(r.decl).map(([k, v]) => `${k}:${v}`).join(";")}`);
    expect(lines.length).toBe(316);
    expect(crypto.createHash("sha256").update(lines.join("\n")).digest("hex")).toBe(PHONE_SHEET_63276802);
  });

  it("every new rule for the frames and the fit sits behind a min-width of 720 or 1280 px", () => {
    for (const r of RULES.filter((x) => x.media.some((m) => /min-width/.test(m)))) {
      expect(r.media.join(" "), r.selector).toMatch(/^@media \(min-width:(720|1280)px\)$/);
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
