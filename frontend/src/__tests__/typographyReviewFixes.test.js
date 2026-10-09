/**
 * Guards for the 8 Oct 2026 typography review fixes. Each one closed a
 * regression the four typography fixes had introduced:
 *
 *   1. Fix 1 imported only the latin font files, so Turkish UI text (tr is an
 *      offered language) and names like Łukasz or Nguyễn drew ş / Ł / ễ in
 *      the system font, mid-word. fonts-ext-subsets.css brings latin-ext and
 *      Vietnamese back as ON-DEMAND faces: every rule has a unicode-range that
 *      shares no code point with the latin file, so a Danish page fetches
 *      nothing new.
 *   2. Fix 3 darkened Amount's "kr." for light cards. On an inverted surface
 *      (Tax countdown hero, Pricing simulator, Waste selected chip) that made
 *      it worse, down to 1.0:1 on the red hero. Those containers now set the
 *      token themselves through data-amount-token.
 *   3. Fix 2 (Inter is wider than Inter Tight) squeezed the landing hero's
 *      "on shift" name to ~113px at 390 and split "16:00–" / "23:00".
 *
 * Source guards strip comments first, so prose that quotes a class is never
 * mistaken for the class.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const FE = join(SRC, "..");
const read = (p) => readFileSync(join(SRC, p), "utf8");
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const parseRanges = (s) => {
  const out = new Set();
  for (const part of s.split(",")) {
    const m = part.trim().match(/^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i);
    if (!m) throw new Error(`bad range ${part}`);
    const a = parseInt(m[1], 16), b = parseInt(m[2] || m[1], 16);
    for (let c = a; c <= b; c++) out.add(c);
  }
  return out;
};
// fontsource's latin subset range (inter/400.css and hanken-grotesk/400.css).
const LATIN = parseRanges("U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD");

describe("on-demand extended-Latin and Vietnamese faces", () => {
  const css = readFileSync(join(SRC, "fonts-ext-subsets.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];

  it("declares latin-ext and vietnamese for every Inter and Hanken weight in use", () => {
    const got = faces.map((f) => {
      const fam = f.match(/font-family:\s*'([^']+)'/)[1];
      const w = f.match(/font-weight:\s*(\d+)/)[1];
      const sub = f.match(/-(latin-ext|vietnamese)-\d+-normal\.woff2/)[1];
      return `${fam}|${w}|${sub}`;
    }).sort();
    const want = [];
    for (const fam of ["Inter", "Hanken Grotesk"]) for (const w of [400, 500, 600, 700, 800]) for (const sub of ["latin-ext", "vietnamese"]) want.push(`${fam}|${w}|${sub}`);
    expect(got).toEqual(want.sort());
  });

  it("every face is gated by a unicode-range that never overlaps the latin file", () => {
    for (const f of faces) {
      const m = f.match(/unicode-range:\s*([^;]+);/);
      expect(m, f).toBeTruthy();
      const r = parseRanges(m[1]);
      const overlap = [...r].filter((c) => LATIN.has(c));
      expect(overlap, f).toEqual([]);
      // Danish letters and the money/punctuation the app draws stay on latin.
      for (const ch of "æøåÆØÅé–—−€") expect(r.has(ch.codePointAt(0)), ch).toBe(false);
    }
  });

  it("covers the letters that fell back to the system font", () => {
    const ext = faces.filter((f) => /latin-ext-400/.test(f) && /'Inter'/.test(f))[0];
    const vi = faces.filter((f) => /vietnamese-400/.test(f) && /'Inter'/.test(f))[0];
    const r = new Set([...parseRanges(ext.match(/unicode-range:\s*([^;]+);/)[1]), ...parseRanges(vi.match(/unicode-range:\s*([^;]+);/)[1])]);
    for (const ch of "şğİŞŁłčřșțăơưđễ") expect(r.has(ch.codePointAt(0)), ch).toBe(true);
  });

  it("points at woff2 files that exist in @fontsource", () => {
    for (const f of faces) {
      const url = f.match(/url\('([^']+)'\)/)[1];
      expect(url.startsWith("@fontsource/"), url).toBe(true);
      expect(existsSync(join(FE, "node_modules", url)), url).toBe(true);
    }
  });

  it("main.jsx imports it after every latin file, and never fontsource's range-less latin-ext css", () => {
    // Not comment-stripped: a line comment there mentions "/assets/*", which
    // a naive block-comment strip would read as an opener. `^import` already
    // skips commented-out imports.
    const main = read("main.jsx");
    const imports = [...main.matchAll(/^import\s+'([^']+)'/gm)].map((m) => m[1]);
    const ext = imports.indexOf("./fonts-ext-subsets.css");
    expect(ext).toBeGreaterThan(-1);
    const latin = imports.map((p, i) => [p, i]).filter(([p]) => /^@fontsource\/[^/]+\/latin-\d+\.css$/.test(p));
    expect(latin.length).toBe(10);
    for (const [, i] of latin) expect(i).toBeLessThan(ext);
    expect(imports.some((p) => /@fontsource\/[^/]+\/(latin-ext|vietnamese)-\d+\.css$/.test(p))).toBe(false);
  });
});

describe('Amount "kr." on inverted surfaces sets its own colour', () => {
  it("Tax countdown hero: token follows the hero's white", () => {
    const src = stripJsComments(read("pages/TaxAutopilotPage.jsx"));
    const hero = src.match(/<div className=\{`(rounded-xl p-6 text-white border[^$`]*)\$\{\s*nextDeadline\.status === "overdue"/);
    expect(hero).toBeTruthy();
    expect(hero[1]).toContain("[&_[data-amount-token]]:text-current");
  });

  it("Pricing simulator: token follows the card's white", () => {
    const src = stripJsComments(read("pages/PricingPage.jsx"));
    const sim = src.match(/<div className="(bg-gradient-to-br from-blue-600[^"]*)">/);
    expect(sim).toBeTruthy();
    expect(sim[1]).toContain("[&_[data-amount-token]]:text-current");
  });

  it("Waste selected quick-cost chip: mirrored whisper in both themes", () => {
    const src = stripJsComments(read("pages/WastePage.jsx"));
    const sel = src.match(/\? "(border-gray-900 dark:border-gray-100 bg-gray-900[^"]*)"/);
    expect(sel).toBeTruthy();
    expect(sel[1]).toContain("[&_[data-amount-token]]:text-gray-300");
    expect(sel[1]).toContain("dark:[&_[data-amount-token]]:text-gray-600");
  });
});

describe("landing hero: on-shift row at phone width", () => {
  const src = stripJsComments(read("components/landing/v2/HeroV2.jsx"));
  const block = src.slice(src.indexOf('"landingV2HeroCardOnShift"') - 400, src.indexOf('"landingV2HeroCardScheduleAction"'));

  it("the eyebrow takes its own line below sm and sits beside the name from sm up", () => {
    expect(block).toMatch(/className="[^"]*\bflex-wrap\b[^"]*\bsm:flex-nowrap\b[^"]*"/);
    expect(block).toMatch(/\$\{eyebrow\} flex-none basis-full sm:basis-auto/);
  });

  it("the name fills the line beside the link and the shift time never splits", () => {
    expect(block).toMatch(/<span className="min-w-0 flex-1 text-\[14\.5px\] text-slate-900">/);
    expect(block).toMatch(/<span className="whitespace-nowrap text-slate-500">\s*\{t\("landingV2HeroCardOnShiftRole"/);
  });
});
