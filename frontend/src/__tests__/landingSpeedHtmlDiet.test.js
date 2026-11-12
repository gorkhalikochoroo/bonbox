// @vitest-environment node
/**
 * Landing speed, step 7 (10 Nov 2026): the built document ships without its comments.
 *
 * vite.config.js htmlDiet (build only, last post hook, only with a landing chunk): HTML comments go, each inline script
 * passes through esbuild with minifyWhitespace only, JSON-LD and src scripts stay byte-equal. Node environment: esbuild
 * does not start under jsdom (that is also why vite.config.js imports it inside the hook).
 * Held here, on the whole post-hook pipeline run over index.html as Vite has built it: the inline scripts still parse
 * and the ones that matter still run (the language label, the landing guard, the booking boot, the first screen), the
 * script order and JSON-LD are unchanged, the document is much smaller, and a build without a landing chunk is untouched.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { FROM_PRICE } from "../lib/planPrices";
import { firstScreenMarkupV7 } from "../../scripts/landingFirstScreenV7.mjs";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INDEX = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
const CONFIG = fs.readFileSync(path.join(FRONTEND, "vite.config.js"), "utf8");
const BUILT = INDEX
  .replace('<script type="module" src="/src/main.jsx"></script>', "")
  .replace("</head>", '<script type="module" crossorigin src="/assets/index-1.js"></script>\n<link rel="modulepreload" crossorigin href="/assets/vendor-react-2.js">\n<link rel="stylesheet" crossorigin href="/assets/index-3.css">\n</head>');
const BUNDLE = {
  "assets/LandingV7Page-abc.js": {
    type: "chunk", fileName: "assets/LandingV7Page-abc.js", facadeModuleId: "/repo/frontend/src/pages/LandingV7Page.jsx",
    imports: ["assets/index-1.js"], viteMetadata: { importedCss: new Set(["assets/LandingV7Page-abc.css"]) },
  },
  "assets/index-1.js": { type: "chunk", fileName: "assets/index-1.js", facadeModuleId: "/repo/frontend/index.html", imports: [] },
  "assets/da-x.js": { type: "chunk", fileName: "assets/da-x.js", facadeModuleId: "/repo/frontend/src/i18n/da.js" },
  "assets/en-x.js": { type: "chunk", fileName: "assets/en-x.js", facadeModuleId: "/repo/frontend/src/i18n/en.js" },
  "assets/ReservationPublicPage-r.js": { type: "chunk", fileName: "assets/ReservationPublicPage-r.js", facadeModuleId: "/repo/frontend/src/pages/ReservationPublicPage.jsx", imports: [] },
  f400: { type: "asset", fileName: "assets/inter-latin-400-normal-a.woff2" },
};
async function pipeline({ diet = true, bundle = BUNDLE, html = BUILT } = {}) {
  const { default: config } = await import("../../vite.config.js");
  const plugins = config.plugins.flat().filter((p) => p && p.transformIndexHtml && p.transformIndexHtml.order === "post" && (diet || p.name !== "bonbox-html-diet"));
  for (const p of plugins) html = await p.transformIndexHtml.handler(html, { bundle });
  return html;
}
const scriptsOf = (html) => [...html.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], code: m[2], whole: m[0] }));
const outsideScripts = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");

describe("the built document without its comments", () => {
  it("no HTML comment is left; the doctype, the head's tags and #root are", async () => {
    const out = await pipeline();
    expect(outsideScripts(out)).not.toMatch(/<!--|-->/);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    for (const tag of ['<meta charset="UTF-8" />', '<link rel="canonical" href="https://www.bonbox.dk/" />', '<div id="root">', "<noscript>"]) expect(out).toContain(tag);
  });

  it("is much smaller than without the diet", async () => {
    const [fat, lean] = [await pipeline({ diet: false }), await pipeline()];
    expect(lean.length).toBeLessThan(fat.length * 0.8);
  });

  it("keeps every script, in order; JSON-LD and src scripts byte-equal", async () => {
    const [fat, lean] = [scriptsOf(await pipeline({ diet: false })), scriptsOf(await pipeline())];
    expect(lean.map((s) => s.attrs)).toEqual(fat.map((s) => s.attrs));
    for (const [i, s] of lean.entries()) {
      if (/src=|ld\+json/.test(s.attrs)) expect(s.whole).toBe(fat[i].whole);
      else if (fat[i].code.trim()) expect(s.code.length).toBeLessThanOrEqual(fat[i].code.length + 2); // an already-minimal one may gain a ";"
    }
    const ld = (h) => h.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/)[0];
    expect(ld(await pipeline())).toBe(ld(INDEX));
  });

  it("every inline script still parses", async () => {
    for (const s of scriptsOf(await pipeline())) {
      if (/src=|ld\+json/.test(s.attrs) || !s.code.trim()) continue;
      expect(() => new Function(s.code), s.code.slice(0, 60)).not.toThrow();
    }
  });

  it("the language label, the landing guard, the booking boot and the first screen still run", async () => {
    const scripts = scriptsOf(await pipeline()).map((s) => s.code);
    // index.html's <html lang> fix: a Turkish browser
    const lang = scripts.find((x) => x.includes('localStorage.getItem("lang")') && x.includes("documentElement.lang") && !x.includes("__lp6First"));
    const html = { lang: "da" };
    new Function("localStorage", "navigator", "document", lang)({ getItem: () => null }, { languages: ["tr-TR"], language: "tr-TR" }, { documentElement: html });
    expect(html.lang).toBe("tr");
    // the landing guard
    const guard = scripts.find((x) => x.includes("__lp6First={lang"));
    const win = {};
    new Function("window", "location", "localStorage", "document", "navigator", "performance", guard)(
      win, { pathname: "/", hash: "", protocol: "https:" }, { getItem: () => null },
      { cookie: "", head: { appendChild: () => {} }, createElement: () => ({}), documentElement: {} },
      { languages: ["en-GB"], language: "en-GB" }, { getEntriesByType: () => [{ type: "navigate" }] });
    expect(win.__lp6First).toEqual({ lang: "en", app: "en", fonts: ["/assets/inter-latin-400-normal-a.woff2"], later: [] }); // landing v7: + the page's own fonts (none in this bundle)
    // the booking boot: a guest's booking page is marked at parse time
    const booking = scripts.find((x) => x.includes("__bbBooking=") || x.includes("__bbBooking ="));
    const bw = { matchMedia: () => ({ matches: false }), fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }), AbortController };
    bw.self = bw; bw.top = bw;
    new Function("window", "location", "document", "fetch", booking)(bw, { pathname: "/r/cafe", search: "", protocol: "https:", hostname: "www.bonbox.dk" },
      { createElement: () => ({}), head: { appendChild: () => {} }, documentElement: { classList: { add: () => {} } } }, bw.fetch);
    expect(bw.__bbBooking).toBeTruthy();
    // the first screen
    const first = scripts.find((x) => x.includes("lp6-first") && x.includes("insertAdjacentHTML"));
    let written = null;
    const fakeRoot = { querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {} };
    new Function("window", "document", "location", first)(
      { __lp6First: { lang: "da" } },
      { currentScript: { insertAdjacentHTML: (w, h) => { written = h; } }, getElementById: () => fakeRoot, head: { appendChild: () => {} }, createElement: () => ({}), addEventListener: () => {} },
      { search: "" });
    // landing v7 (12 Nov 2026): the first screen is the v7 page's (scripts/landingFirstScreenV7.mjs)
    expect(written).toBe(firstScreenMarkupV7("da", { da, en, price: FROM_PRICE }));
  });

  it("a build without a landing chunk (the Vagtplan app) is untouched by it", async () => {
    const { default: config } = await import("../../vite.config.js");
    const p = config.plugins.flat().find((x) => x && x.name === "bonbox-html-diet");
    expect(p.apply).toBe("build");
    expect(p.transformIndexHtml.order).toBe("post");
    expect(await p.transformIndexHtml.handler(BUILT, { bundle: { "assets/index-1.js": BUNDLE["assets/index-1.js"] } })).toBe(BUILT);
  });

  it("vite.config.js: last in the plugin list; esbuild is imported inside the hook only", () => {
    const plugins = CONFIG.match(/plugins: \[([^\]]*)\]/)[1].trim();
    expect(plugins.endsWith("htmlDiet(),")).toBe(true);
    expect(CONFIG).not.toMatch(/^import [^\n]*['"]esbuild['"]/m);
    expect(CONFIG).toContain("const { transform } = await import('esbuild')");
    expect(CONFIG).toContain("minifyWhitespace: true");
  });
});
