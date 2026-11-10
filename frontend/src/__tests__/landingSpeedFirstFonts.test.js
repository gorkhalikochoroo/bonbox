/**
 * Landing speed, step 3 (10 Nov 2026): the first screen brings its own Inter.
 *
 * Three cuts of Inter 400 / 500 / 600 (scripts/landingFirstFonts.mjs, committed under components/landing/v6/fonts/)
 * ride in the HTML's first-screen sheet as data: faces of the family "Inter First" (font-display:block), and one
 * landingV6.css rule draws the top bar and the hero in it, before and after the app takes over. So the first text is
 * Inter from its first frame and never changes face.
 *
 * Held here: every character the first screen draws, in both languages, is in the committed cut of the weight it is
 * drawn at (read from the font's own cmap); the faces are never named Inter (the app sheet's later face of that name
 * would replace them and swap); landingV6.css still carries no @font-face; the cuts stay small.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { FROM_PRICE } from "../lib/planPrices";
import { FIRST_FONT_FILE, WEIGHTS, firstScreenChars } from "../../scripts/landingFirstFonts.mjs";
import { FIRST_FONT_WEIGHTS, firstScreenCss, firstScreenFaces } from "../../scripts/landingFirstScreen.mjs";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CSS = fs.readFileSync(path.join(FRONTEND, "src/components/landing/v6/landingV6.css"), "utf8");

// ── the characters a WOFF2 file maps (its cmap), read without any font library ──
const KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB"];
function woff2Cmap(buf) {
  expect(buf.toString("latin1", 0, 4)).toBe("wOF2");
  const numTables = buf.readUInt16BE(12);
  let p = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buf[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error("bad UIntBase128"); };
  const tables = [];
  for (let t = 0; t < numTables; t++) {
    const flags = buf[p++];
    let tag = KNOWN[flags & 0x3f];
    if ((flags & 0x3f) === 63) { tag = buf.toString("latin1", p, p + 4); p += 4; }
    const version = flags >> 6;
    const orig = base128();
    const transformed = (tag === "glyf" || tag === "loca") ? version === 0 : version !== 0;
    const length = transformed ? base128() : orig;
    tables.push({ tag, length });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)));
  let off = 0;
  const at = {};
  for (const t of tables) { at[t.tag] = data.subarray(off, off + t.length); off += t.length; }
  const cmap = at.cmap;
  const chars = new Set();
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const sub = cmap.subarray(cmap.readUInt32BE(4 + i * 8 + 4));
    const format = sub.readUInt16BE(0);
    if (format === 4) {
      const seg = sub.readUInt16BE(6) / 2;
      const end = 14, start = end + seg * 2 + 2, delta = start + seg * 2, ro = delta + seg * 2;
      for (let s = 0; s < seg; s++) {
        const e = sub.readUInt16BE(end + s * 2), b = sub.readUInt16BE(start + s * 2), d = sub.readInt16BE(delta + s * 2), r = sub.readUInt16BE(ro + s * 2);
        for (let c = b; c <= e && c !== 0xffff; c++) {
          let g;
          if (!r) g = (c + d) & 0xffff;
          else { const gi = sub.readUInt16BE(ro + s * 2 + r + (c - b) * 2); g = gi ? (gi + d) & 0xffff : 0; }
          if (g) chars.add(String.fromCodePoint(c));
        }
      }
    } else if (format === 12) {
      const groups = sub.readUInt32BE(12);
      for (let g = 0; g < groups; g++) {
        const s0 = sub.readUInt32BE(16 + g * 12), e0 = sub.readUInt32BE(20 + g * 12);
        for (let c = s0; c <= e0; c++) chars.add(String.fromCodePoint(c));
      }
    }
  }
  return chars;
}

describe("the committed cuts hold every character the first screen draws at their weight", () => {
  it.each(FIRST_FONT_WEIGHTS)("Inter First %i", (w) => {
    const file = path.join(FRONTEND, FIRST_FONT_FILE(w));
    const buf = fs.readFileSync(file);
    expect(buf.length).toBeLessThan(8000); // a few KB each: they ride in every page's HTML
    const has = woff2Cmap(buf);
    const need = firstScreenChars(w, [da, en]);
    const missing = [...need].filter((c) => !has.has(c));
    expect(missing, `run: node scripts/landingFirstFonts.mjs`).toEqual([]);
  });

  it("the price and the headline's small numbers are covered: the trial line's digits at 400, 01 02 03 at 500", () => {
    expect(firstScreenChars(400, [da, en])).toContain(String(FROM_PRICE)[0]);
    for (const d of String(FROM_PRICE)) expect(firstScreenChars(400, [da, en])).toContain(d);
    for (const d of "0123") expect(firstScreenChars(500, [da, en])).toContain(d);
    expect(firstScreenChars(400, [da, en])).toContain(" ");
  });

  it("the weights follow landingV6.css: subline, trial line and the top bar's links 400; Se priser and the small numbers 500; headline words and buttons 600", () => {
    expect(WEIGHTS[400].keys).toEqual(["sub", "trial", "nav.prices", "nav.login"]);
    expect(WEIGHTS[500].keys).toEqual(["seePrices"]);
    expect(WEIGHTS[600].keys).toEqual(["h1.shifts", "h1.tables", "h1.till", "cta"]);
    expect(CSS).toMatch(/\.lp6 \.h1\{[^}]*font-weight:600/);
    expect(CSS).toMatch(/\.lp6 \.h1 sup\{[^}]*font-weight:500/);
  });
});

describe("the faces", () => {
  it("are data: faces of the family \"Inter First\", font-display:block, never named Inter", () => {
    const faces = firstScreenFaces();
    const all = [...faces.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]);
    expect(all).toHaveLength(3);
    for (const [i, f] of all.entries()) {
      expect(f).toContain('font-family:"Inter First"');
      expect(f).toContain(`font-weight:${FIRST_FONT_WEIGHTS[i]}`);
      expect(f).toContain("font-display:block");
      expect(f).toMatch(/src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\("woff2"\)/);
    }
    // the inline sheet: these three, then the one Inter face that covers no character (no local copy draws the screen)
    const sheet = firstScreenCss(faces);
    const families = [...sheet.matchAll(/@font-face\{font-family:([^;]+);/g)].map((m) => m[1]);
    expect(families).toEqual(['"Inter First"', '"Inter First"', '"Inter First"', "Inter"]);
    expect(sheet).toMatch(/@font-face\{font-family:Inter;src:local\("?Helvetica"?\),local\("?Arial"?\),local\("?Roboto"?\);unicode-range:U\+F8FF\}/);
  });

  it("landingV6.css draws the top bar and the hero in it, with the full Inter behind, in a first-screen marker; no @font-face there", () => {
    const rule = '.lp6 .top,.lp6 .hero{font-family:"Inter First",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}';
    expect(CSS.split(rule)).toHaveLength(2);
    expect(CSS).toContain(`/*<fs>*/\n${rule}\n/*</fs>*/`);
    expect(CSS).not.toMatch(/@font-face/);
    expect(firstScreenCss()).toMatch(/\.lp6 \.top,\.lp6 \.hero\{font-family:"?Inter First"?,Inter,/);
  });
});
