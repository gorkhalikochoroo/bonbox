/**
 * Landing v7 (12 Nov 2026): the first screen in the HTML (scripts/landingFirstScreenV7.mjs, vite.config.js).
 *
 * Pins:
 *   - the markup the inline script writes is React's first render of TopBar + Hero (before they are armed), in Danish
 *     and in English, so nothing moves at takeover; also as the landing's own document (dist/landing.html) draws it;
 *   - the three committed font cuts hold every character the first screen draws at their weight;
 *   - one first-screen part in landingV7.css, and every first-screen class is styled inside it;
 *   - the hero picture's strings (preload, first screen, page) and the rise query are one;
 *   - the script: writes the screen for the guard's language, marks it drawn, carries ?ref= on the real links, records a
 *     tap on the language button or an in-page link for the replay, and nothing without the guard's mark.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { FROM_PRICE } from "../lib/planPrices";
import { controlIn } from "../lib/landingBoot";
import { woff2Cmap } from "../test/woff2Cmap.js";
import TopBar from "../components/landing/v7/TopBar";
import Hero from "../components/landing/v7/Hero";
import { HERO_TABLET, RISE_QUERY } from "../components/landing/v7/assets";
import {
  FIRST_FACES_V7, HERO_IMG_V7, RISE_QUERY_V7, firstScreenCssV7, firstScreenMarkupV7, firstScreenRangeV7, firstScreenScriptV7,
  landingDocumentV7,
} from "../../scripts/landingFirstScreenV7.mjs";
import { FIRST_FONTS_V7, FIRST_FONT_FILE_V7, firstScreenCharsV7 } from "../../scripts/landingFirstFontsV7.mjs";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DICTS = { da, en, price: FROM_PRICE };
const tFor = (dict) => (key, vars) => {
  let v = dict[key];
  if (vars) v = v.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return v;
};
afterEach(() => { cleanup(); document.body.innerHTML = ""; delete window.__lp6First; });

/** React's first render of the top bar and the hero, as the DOM serialises it (the router's own marker aside). */
function reactFirst(lang) {
  const t = tFor(lang === "da" ? da : en);
  const { container } = render(
    <MemoryRouter>
      <TopBar t={t} lang={lang} onLang={() => {}} armed={false} />
      <main id="lp7-main"><Hero t={t} armed={false} refs={{ current: {} }} onReplay={() => {}} /></main>
    </MemoryRouter>,
  );
  return container.innerHTML.replace(/ data-discover="true"/g, "");
}
/** The first screen's markup as the browser parses it (same serialiser). */
function htmlFirst(lang) {
  const box = document.createElement("div");
  box.innerHTML = firstScreenMarkupV7(lang, DICTS);
  const first = box.firstElementChild;
  expect(first.id).toBe("lp6-first");
  expect(first.className).toBe("lp7");
  expect(first.getAttribute("lang")).toBe(lang);
  return first.innerHTML;
}

describe("the first screen is React's first render", () => {
  it.each(["da", "en"])("%s: the same top bar and hero, attribute for attribute", (lang) => {
    expect(htmlFirst(lang)).toBe(reactFirst(lang));
  });

  it("strings are escaped and come from the dictionaries", () => {
    const m = firstScreenMarkupV7("da", { da: { ...da, "landingV7.hero.lede": "<img src=x onerror=alert(1)> & \"q\"" }, en, price: FROM_PRICE });
    expect(m).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;");
    expect(m).not.toContain("<img src=x");
    expect(firstScreenMarkupV7("da", DICTS)).toContain(`fra ${FROM_PRICE} kr./md.`);
  });
});

/* Landing v7 speed (12 Nov 2026): "/" and "/v2" are served their own document (dist/landing.html: index.html plus the hero
 * picture's phone cut; vite.config.js landingDocument, landingV7Document.test.js). Its first screen, drawn by the script
 * the built document really carries, is React's first render too. The build's html hooks run here without htmlDiet
 * (esbuild does not start under jsdom; landingV7Document.test.js runs the dieted document in node). */
describe("the landing's own document: its first screen is React's first render", () => {
  async function landingDoc() {
    const { default: config } = await import("../../vite.config.js");
    const src = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8")
      .replace('<script type="module" src="/src/main.jsx"></script>', "")
      .replace("</head>", '<script type="module" crossorigin src="/assets/index-1.js"></script>\n<link rel="stylesheet" crossorigin href="/assets/index-3.css">\n</head>');
    const bundle = {
      "assets/L.js": { type: "chunk", fileName: "assets/L.js", facadeModuleId: "/r/frontend/src/pages/LandingV7Page.jsx", imports: [], viteMetadata: { importedCss: new Set() } },
      "assets/da-x.js": { type: "chunk", fileName: "assets/da-x.js", facadeModuleId: "/r/frontend/src/i18n/da.js" },
      "assets/en-x.js": { type: "chunk", fileName: "assets/en-x.js", facadeModuleId: "/r/frontend/src/i18n/en.js" },
    };
    let html = src;
    for (const p of config.plugins.flat().filter((x) => x && x.transformIndexHtml && x.transformIndexHtml.order === "post" && x.name !== "bonbox-html-diet")) {
      html = await p.transformIndexHtml.handler(html, { bundle });
    }
    return landingDocumentV7(html);
  }
  function drawFrom(doc, lang) {
    const code = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((x) => x.includes("lp6-first") && x.includes("insertAdjacentHTML"));
    const root = document.createElement("div");
    root.id = "root";
    const anchor = document.createElement("i");
    root.appendChild(anchor);
    document.body.appendChild(root);
    window.__lp6First = { lang };
    const d = { currentScript: anchor, getElementById: (id) => document.getElementById(id), querySelector: (s) => document.querySelector(s), head: document.head, createElement: (t) => document.createElement(t), addEventListener: () => {} };
    new Function("window", "document", "location", code)(window, d, { search: "" });
    anchor.remove();
    const first = document.getElementById("lp6-first");
    const out = { lang: first.getAttribute("lang"), inner: first.innerHTML };
    root.remove();
    return out;
  }
  it.each(["da", "en"])("%s: the document's script draws React's top bar and hero, attribute for attribute", async (lang) => {
    const doc = await landingDoc();
    expect(doc).toContain('<style id="lp7-hero">');
    const drawn = drawFrom(doc, lang);
    expect(drawn.lang).toBe(lang);
    expect(drawn.inner).toBe(reactFirst(lang));
  });
});

describe("the first screen's fonts", () => {
  it.each(Object.keys(FIRST_FONTS_V7))("%s holds every character it draws, in both languages", (cut) => {
    const buf = fs.readFileSync(path.join(FRONTEND, FIRST_FONT_FILE_V7(cut)));
    expect(buf.length).toBeLessThan(8000); // they ride in every page's HTML
    const has = woff2Cmap(buf);
    const missing = [...firstScreenCharsV7(cut, [da, en])].filter((c) => !has.has(c));
    expect(missing, "run: node scripts/landingFirstFontsV7.mjs").toEqual([]);
  });

  it("the faces are never named Sora or DM Sans, and the top bar and the hero ask for them first", () => {
    for (const f of FIRST_FACES_V7) expect(f.family).toMatch(/ First$/);
    const sheet = firstScreenCssV7();
    expect(sheet).toMatch(/\.lp7 \.top,\.lp7 \.hero\{--f-text:"DM Sans First","DM Sans"/);
    expect(sheet).toMatch(/--f-head:"Sora First","Sora"/);
  });
});

describe("landingV7.css's first-screen part", () => {
  const css = fs.readFileSync(path.join(FRONTEND, "src/components/landing/v7/landingV7.css"), "utf8");
  it("is one marked part; every class the first screen draws with is styled inside it", () => {
    const part = firstScreenRangeV7(css);
    const inPart = new Set();
    postcss.parse(part).walkRules((r) => { for (const m of r.selector.matchAll(/\.([\w-]+)/g)) inPart.add(m[1]); });
    const box = document.createElement("div");
    box.innerHTML = firstScreenMarkupV7("da", DICTS);
    const used = new Set([...box.querySelectorAll("[class]")].flatMap((e) => [...e.classList]));
    // classes that only carry meaning for the motion or a test hook
    for (const c of ["d1", "d2", "d3", "d4"]) used.delete(c);
    // the kit wordmark's own classes (BonBoxWordmark: the app's utilities); on the landing the part styles the logo's
    // svgs itself (.lp7 .brand svg), so the first screen never waits for the app's sheet to place them
    for (const c of ["block", "shrink-0"]) used.delete(c);
    expect(part).toMatch(/\.lp7 \.brand svg\{display:block;flex:none\}/);
    expect([...used].filter((c) => !inPart.has(c))).toEqual([]);
    // and nothing after the part can reach a first-screen element's look: the rest names none of the first screen's
    // own blocks (top bar, hero, stage)
    const rest = css.slice(css.indexOf("/*</fs>*/"));
    expect(rest).not.toMatch(/\.lp7 \.(top|hero|hero-grid|hero-side|ctas|fine|stage-wrap|lang-btn|login|brand|mark)\b[^-]/);
  });

  it("the minified sheet keeps the scrollbar rule for the screen's life", () => {
    expect(firstScreenCssV7()).toContain(":root:has(#lp6-first){overflow-y:scroll}");
  });
});

describe("one picture, one rise rule", () => {
  it("the head preload, the first screen and the page use the same hero strings", () => {
    expect(HERO_IMG_V7).toEqual({ src: HERO_TABLET.src, srcset: HERO_TABLET.srcSet, sizes: HERO_TABLET.sizes });
    expect(RISE_QUERY_V7).toBe(RISE_QUERY);
    const cfg = fs.readFileSync(path.join(FRONTEND, "vite.config.js"), "utf8");
    expect(cfg).toContain('if("imageSrcset" in k){k.rel="preload";k.as="image"');
    expect(cfg).toContain('k.fetchPriority="high"');
  });

  it("the preload guard adds the picture with its srcset and sizes, at high priority, only where imagesrcset is read", async () => {
    const { default: config } = await import("../../vite.config.js");
    const p = config.plugins.flat().find((x) => x && x.name === "bonbox-preload-landing");
    const bundle = {
      "assets/L.js": { type: "chunk", fileName: "assets/L.js", facadeModuleId: "/r/frontend/src/pages/LandingV7Page.jsx", imports: [], viteMetadata: { importedCss: new Set() } },
    };
    const out = await p.transformIndexHtml.handler('<head><meta charset="UTF-8" /></head>', { bundle });
    const code = out.match(/<script>([\s\S]*?)<\/script>/)[1];
    const run = (withSrcset) => {
      const links = [];
      const doc = { cookie: "", head: { appendChild: (l) => links.push(l) }, createElement: () => (withSrcset ? { imageSrcset: "" } : {}), documentElement: {} };
      new Function("window", "location", "localStorage", "document", "navigator", "performance", code)(
        {}, { pathname: "/", hash: "", protocol: "https:" }, { getItem: () => null }, doc,
        { languages: ["da-DK"], language: "da-DK" }, { getEntriesByType: () => [{ type: "navigate" }] });
      return links;
    };
    const img = run(true).find((l) => l.as === "image");
    expect(img).toMatchObject({ rel: "preload", href: HERO_IMG_V7.src, imageSrcset: HERO_IMG_V7.srcset, imageSizes: HERO_IMG_V7.sizes, fetchPriority: "high" });
    expect(run(false).find((l) => l.as === "image")).toBeUndefined();
  });
});

describe("the first-screen script inside #root", () => {
  function runScreen({ lang = "da", search = "", mark = true } = {}) {
    const code = firstScreenScriptV7(DICTS).replace(/^<script>|<\/script>$/g, "");
    const root = document.createElement("div");
    root.id = "root";
    const anchor = document.createElement("i");
    root.appendChild(anchor);
    document.body.appendChild(root);
    if (mark) window.__lp6First = { lang };
    const doc = { currentScript: anchor, getElementById: (id) => document.getElementById(id), querySelector: (s) => document.querySelector(s), head: document.head, createElement: (t) => document.createElement(t), addEventListener: () => {} };
    new Function("window", "document", "location", code)(window, doc, { search });
    anchor.remove();
    return document.getElementById("lp6-first");
  }

  // the markup as the DOM serialises it (a no-break space comes back as &nbsp;)
  const parsed = (html) => { const b = document.createElement("div"); b.innerHTML = html; return b.innerHTML; };
  it("writes the screen in the guard's language and marks it drawn; nothing without the mark", () => {
    expect(runScreen({ lang: "da" }).outerHTML).toBe(parsed(firstScreenMarkupV7("da", DICTS)));
    expect(window.__lp6First.drawn).toBe(true);
    expect(typeof window.__lp6First.at).toBe("number");
    document.body.innerHTML = "";
    expect(runScreen({ lang: "en" }).outerHTML).toBe(parsed(firstScreenMarkupV7("en", DICTS)));
    document.body.innerHTML = "";
    delete window.__lp6First;
    expect(runScreen({ mark: false })).toBeNull();
  });

  it("?ref= rides on the real links (Prøv gratis, Log ind), URL-encoded, through the DOM", () => {
    const first = runScreen({ search: "?ref=r1-a%2003%22%3E" });
    const real = [...first.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute("href"));
    expect(real).toEqual(["/login?ref=r1-a%2003%22%3E", "/register?ref=r1-a%2003%22%3E", "/register?ref=r1-a%2003%22%3E"]);
  });

  it("a tap on the language button or an in-page link is kept for the replay; a real link is left alone", () => {
    const first = runScreen();
    const click = (el) => { const e = new MouseEvent("click", { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
    expect(click(first.querySelector(".lang-btn"))).toBe(true);
    expect(window.__lp6First.tap).toEqual({ r: "top", s: "button.lang-btn", i: 0 });
    expect(click(first.querySelector('.hero a[href="#dag"]'))).toBe(true);
    expect(window.__lp6First.tap).toEqual({ r: "hero", s: 'a[href="#dag"]', i: 0 });
    expect(click(first.querySelector('.nav a[href="#priser"]'))).toBe(true);
    expect(window.__lp6First.tap).toEqual({ r: "top", s: 'a[href="#priser"]', i: 0 });
    window.__lp6First.tap = null;
    expect(click(first.querySelector('.hero a[href^="/register"]'))).toBe(false);
    expect(window.__lp6First.tap).toBeNull();
    // the replay finds the same control on the real page
    for (const c of [{ r: "top", s: "button.lang-btn", i: 0 }, { r: "hero", s: 'a[href="#dag"]', i: 0 }, { r: "top", s: 'a[href="#priser"]', i: 0 }]) {
      expect(controlIn(first, c), c.s).not.toBeNull();
    }
    expect(controlIn(first, { r: "top", s: 'a[href="/register"]', i: 0 })).toBeNull();
  });
});
