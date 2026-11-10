/**
 * Landing speed, step 6 (10 Nov 2026): the stage's fonts ride with the first wave; Inter 300 is a digits cut.
 *
 *  - preloadLanding's head guard puts the hashed inter-latin-400/500/600 files on window.__lp6First.fonts; the first
 *    screen's script preloads them right after its first frame (a font preload known before the first paint holds
 *    that paint in Chromium), no later than DOMContentLoaded (a preload added after the load event is not matched),
 *    1.5 s at the latest, with crossorigin (or each file loads twice). The app's first commit is then already in
 *    Inter: no swap, no second layout.
 *  - styles.js imports our own 3 KB cut of Inter 300 (fonts/inter-300-digits.css) instead of @fontsource's 24 KB
 *    latin-300 file. It must hold the space (a line's metrics come from the first font covering U+0020) and every
 *    character drawn at weight 300 (the clock's digits and separator, the stacked page's times).
 *  - The engine still lays out again when a face arrives.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { DIGITS_300, DIGITS_300_FILE } from "../../scripts/landingFirstFonts.mjs";
import { firstScreenScript } from "../../scripts/landingFirstScreen.mjs";
import { FROM_PRICE } from "../lib/planPrices";
import { woff2Cmap } from "../test/woff2Cmap.js";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const V6 = path.join(FRONTEND, "src/components/landing/v6");
const read = (f) => fs.readFileSync(f, "utf8");
const CSS = read(path.join(V6, "landingV6.css"));

afterEach(() => {
  document.head.querySelectorAll('link[rel="preload"][as="font"]').forEach((l) => l.remove());
  document.body.innerHTML = "";
  delete window.__lp6First;
  vi.useRealTimers();
});

describe("Inter 300: our own digits cut", () => {
  // what landingV6.css draws at weight 300: the stage clock (.clock, .clock .dg b) and the stacked page's <time>s
  const at300 = () => {
    const sels = [];
    postcss.parse(CSS).walkDecls("font-weight", (d) => { if (d.value === "300") sels.push(d.parent.selector); });
    return sels;
  };

  it("landingV6.css draws at 300 exactly the clock and the stacked page's times", () => {
    expect(at300()).toEqual([".lp6:not(.story) .copy time", ".lp6.story .clock", ".lp6.story .clock .dg b"]);
  });

  it("the cut holds the space and every character drawn at 300, in both languages", () => {
    const has = woff2Cmap(fs.readFileSync(path.join(FRONTEND, DIGITS_300_FILE)));
    let drawn = " 0123456789";
    for (const d of [da, en]) {
      drawn += d["landingV6.clock.sep"];
      for (let i = 1; i <= 6; i++) drawn += d[`landingV6.time.s${i}`];
    }
    const need = [...new Set(drawn)];
    expect(need.filter((c) => !has.has(c))).toEqual([]);
    expect(need.every((c) => DIGITS_300.includes(c))).toBe(true);
    expect(fs.statSync(path.join(FRONTEND, DIGITS_300_FILE)).size).toBeLessThan(4096); // Vite inlines it (assetsInlineLimit)
  });

  it("its face: Inter 300, font-display:block, the one relative file, a unicode-range that covers the space, '.', ':' and the digits", () => {
    const css = read(path.join(V6, "fonts/inter-300-digits.css"));
    const faces = [];
    postcss.parse(css).walkAtRules("font-face", (a) => { const o = {}; a.walkDecls((d) => { o[d.prop] = d.value; }); faces.push(o); });
    expect(faces).toEqual([{
      "font-family": "Inter", "font-style": "normal", "font-display": "block", "font-weight": "300",
      src: 'url(./inter-300-digits.woff2) format("woff2")', "unicode-range": "U+20,U+2E,U+30-3A",
    }]);
    const range = (c) => { const n = c.codePointAt(0); return n === 0x20 || n === 0x2e || (n >= 0x30 && n <= 0x3a); };
    expect([...DIGITS_300].every(range)).toBe(true);
    expect([..." .:0123456789"].every(range)).toBe(true);
  });

  it("styles.js imports it beside the page's stylesheet; @fontsource's latin-300 is no longer loaded", () => {
    const s = read(path.join(V6, "styles.js"));
    const imports = [...s.matchAll(/^import\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./fonts/inter-300-digits.css", "./landingV6.css"]);
  });
});

describe("the stage's Inter files ride with the first wave", () => {
  async function guard() {
    const { default: config } = await import("../../vite.config.js");
    const p = config.plugins.flat().find((x) => x && x.name === "bonbox-preload-landing");
    const bundle = {
      "assets/L.js": { type: "chunk", fileName: "assets/L.js", facadeModuleId: "/r/frontend/src/pages/LandingV6Page.jsx", imports: [], viteMetadata: { importedCss: new Set() } },
      a: { type: "asset", fileName: "assets/inter-latin-600-normal-c.woff2" },
      b: { type: "asset", fileName: "assets/inter-latin-400-normal-a.woff2" },
      c: { type: "asset", fileName: "assets/inter-latin-500-normal-b.woff2" },
      d: { type: "asset", fileName: "assets/inter-latin-400-normal-a.woff" },
      e: { type: "asset", fileName: "assets/inter-latin-700-normal-d.woff2" },
      f: { type: "asset", fileName: "assets/inter-latin-ext-400-normal-e.woff2" },
    };
    const out = await p.transformIndexHtml.handler('<head><meta charset="UTF-8" /></head>', { bundle });
    expect(out).not.toMatch(/as="?font/); // never a font preload in the head: it would hold the first paint
    return out.match(/<script>([\s\S]*?)<\/script>/)[1];
  }
  const run = (code, { hash = "" } = {}) => {
    const win = {};
    new Function("window", "location", "localStorage", "document", "navigator", "performance", code)(
      win, { pathname: "/", hash, protocol: "https:" }, { getItem: () => null },
      { cookie: "", head: { appendChild: () => {} }, createElement: () => ({}), documentElement: {} },
      { languages: ["da-DK"], language: "da-DK" }, { getEntriesByType: () => [{ type: "navigate" }] });
    return win.__lp6First;
  };

  it("the guard lists the three latin woff2 files 400 / 500 / 600 for the first-screen visitor only", async () => {
    const code = await guard();
    expect(run(code).fonts).toEqual(["/assets/inter-latin-400-normal-a.woff2", "/assets/inter-latin-500-normal-b.woff2", "/assets/inter-latin-600-normal-c.woff2"]);
    expect(run(code, { hash: "#s1" })).toBeUndefined();
  });

  function screen({ fonts }) {
    const code = firstScreenScript({ da, en, price: FROM_PRICE }).replace(/^<script>|<\/script>$/g, "");
    const anchor = document.createElement("i");
    document.body.appendChild(anchor);
    window.__lp6First = { lang: "da", fonts };
    const listeners = {};
    const doc = { currentScript: anchor, getElementById: (id) => document.getElementById(id), head: document.head, createElement: (t) => document.createElement(t), addEventListener: (t, f) => { listeners[t] = f; } };
    let frame = null;
    const win = { __lp6First: window.__lp6First, requestAnimationFrame: (f) => { frame = f; } };
    new Function("window", "document", "location", "requestAnimationFrame", code)(win, doc, { search: "" }, win.requestAnimationFrame);
    const links = () => [...document.head.querySelectorAll('link[rel="preload"][as="font"]')];
    return { links, frame: () => frame && frame(), dcl: () => listeners.DOMContentLoaded && listeners.DOMContentLoaded() };
  }
  const FONTS = ["/assets/inter-latin-400-normal-a.woff2", "/assets/inter-latin-500-normal-b.woff2"];

  it("preloads them after the first frame (not before it), as fonts, with crossorigin, once", () => {
    vi.useFakeTimers();
    const s = screen({ fonts: FONTS });
    expect(s.links()).toHaveLength(0); // nothing before the first paint
    s.frame();
    expect(s.links()).toHaveLength(0);
    vi.advanceTimersByTime(0);
    expect(s.links().map((l) => [l.getAttribute("href"), l.getAttribute("type"), l.getAttribute("crossorigin")])).toEqual(FONTS.map((f) => [f, "font/woff2", ""]));
    s.dcl();
    vi.advanceTimersByTime(2000);
    expect(s.links()).toHaveLength(2);
  });

  it("no later than DOMContentLoaded, and at 1.5 s when no frame comes (a hidden tab)", () => {
    vi.useFakeTimers();
    const a = screen({ fonts: FONTS });
    a.dcl();
    expect(a.links()).toHaveLength(2);
    document.head.querySelectorAll('link[rel="preload"][as="font"]').forEach((l) => l.remove());
    document.body.innerHTML = "";
    const b = screen({ fonts: FONTS });
    vi.advanceTimersByTime(1499);
    expect(b.links()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(b.links()).toHaveLength(2);
  });

  it("nothing when the list is empty", () => {
    vi.useFakeTimers();
    const s = screen({ fonts: [] });
    s.frame(); s.dcl();
    vi.advanceTimersByTime(2000);
    expect(s.links()).toHaveLength(0);
  });

  it("the engine still lays out again when a face arrives (fonts.ready while loading, fonts.load by name, loadingdone)", () => {
    const engine = read(path.join(V6, "engine.js"));
    expect(engine).toContain('if (document.fonts && document.fonts.ready && document.fonts.status !== "loaded") document.fonts.ready.then(() => { if (alive) layout(); });');
    expect(engine).toContain('on(document.fonts, "loadingdone", relay);');
    expect(engine).toMatch(/"300 " \+ fsClk \+ "px Inter"/);
  });
});
