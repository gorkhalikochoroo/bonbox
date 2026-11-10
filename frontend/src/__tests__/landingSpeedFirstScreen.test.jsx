/**
 * Landing speed, step 2 (10 Nov 2026): the landing's first screen is in the HTML.
 *
 * vite.config.js (build only): preloadLanding's head guard marks a prospect on "/" or "/v2" (window.__lp6First, with
 * the page language the app's own rule picks), except on an address that opens a scene (#…) and on a reload or a
 * back / forward step; landingFirstScreen writes the top bar and the hero into #root from scripts/landingFirstScreen.mjs,
 * styled by an inline copy of landingV6.css's /*<fs>*\/ ranges, and makes the app stylesheet a script-made, non-blocking
 * link on that path only (parser-made and blocking everywhere else; <noscript> without JavaScript).
 *
 * Held here: the markup is TopBar.jsx + Hero.jsx as React renders them; the guard equals landingFirstPaint (plus the
 * two new exclusions); every landingV6.css rule that can match a first-screen element is in a marker; the transformed
 * document's inline scripts parse and run; nothing of the first screen sits in the HTML outside a script; a build with
 * no landing chunk is byte-equal; ?ref= rides on the two real links; a tap before the takeover is replayed after it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import TopBar from "../components/landing/v6/TopBar";
import Hero from "../components/landing/v6/Hero";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { FROM_PRICE } from "../lib/planPrices";
import { landingFirstPaint, holdFirstScreen, replayFirstScreen, takeFirstScreen, controlIn } from "../lib/landingBoot";
import {
  FIRST_SCREEN_KEYS, STATE_CSS, firstScreenCss, firstScreenMarkup, firstScreenRanges, firstScreenScript, firstScreenTemplate,
} from "../../scripts/landingFirstScreen.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.join(SRC, "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const CSS = read("components/landing/v6/landingV6.css");
const DICTS = { da, en, price: FROM_PRICE };

afterEach(() => {
  document.body.innerHTML = "";
  delete window.__lp6First;
  takeFirstScreen();
  document.cookie = "bonbox_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  localStorage.clear();
  delete window.Capacitor;
  window.history.replaceState({}, "", "/");
});

// the app's t(): the language's dictionary, {var} substitution (hooks/useLanguage.jsx)
const tFor = (dict) => (key, vars) => {
  let v = dict[key] ?? key;
  if (vars && typeof v === "string") v = v.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return v;
};
// what React renders that the static copy leaves out on purpose: ids (React's tree owns them), the engine's data-go,
// and the night-side lockup (display:none until the engine adds .xing)
const normal = (html) => html
  .replace(/ id="[^"]*"/g, "")
  .replace(/ data-go="[^"]*"/g, "")
  .replace(/ data-discover="true"/g, "") // React Router's Link
  .replace(/<span class="lgB" aria-hidden="true">[\s\S]*?<\/svg><\/span>/, "");

describe("the static markup is TopBar.jsx + Hero.jsx as React renders them", () => {
  it.each(["da", "en"])("%s", (lang) => {
    const t = tFor(lang === "da" ? da : en);
    const react = renderToStaticMarkup(<MemoryRouter><TopBar t={t} lang={lang} onLang={() => {}} /><Hero t={t} /></MemoryRouter>);
    const stat = firstScreenMarkup(lang, DICTS);
    const header = stat.slice(stat.indexOf("<header"), stat.indexOf("</header>") + "</header>".length);
    const hero = stat.slice(stat.indexOf('<div class="hero">'), stat.indexOf("</div></section></main>") + "</div>".length);
    expect(header + hero).toBe(normal(react));
    expect(stat.startsWith(`<div id="lp6-first" class="lp6 lp6-boot js" lang="${lang}">`)).toBe(true);
    expect(stat).toContain(`<p class="sub">${lang === "da" ? da["landingV6.sub"] : en["landingV6.sub"]}</p>`);
  });

  it("every string is the dictionary's own text, escaped at build time", () => {
    for (const k of FIRST_SCREEN_KEYS) expect(typeof da[k] === "string" && typeof en[k] === "string", k).toBe(true);
    const evil = { ...da, "landingV6.sub": '<img src=x onerror="alert(1)">&' };
    const out = firstScreenMarkup("da", { da: evil, en, price: FROM_PRICE });
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
    expect(out).not.toContain("<img");
    expect(firstScreenTemplate()).not.toMatch(/\{[A-Z]\}.*\{[A-Z]\}.*\{[A-Z]\}.*\{[A-Z]\}/); // only L, A, B
  });

  it("the landing's own folders keep no HTML sink: the markup lives in scripts/", () => {
    const v6 = path.join(SRC, "components/landing/v6");
    for (const f of [...fs.readdirSync(v6).filter((x) => /\.jsx?$/.test(x)).map((x) => path.join(v6, x)), path.join(SRC, "pages/LandingV6Page.jsx")]) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/dangerouslySetInnerHTML|insertAdjacentHTML|\.innerHTML\s*=|document\.write/);
    }
  });
});

describe("landingV6.css: every rule that can match a first-screen element is inside a /*<fs>*/ marker", () => {
  // dynamic states and pseudo-elements do not change which element a rule is about
  const DYN = /::?(?:before|after|selection|placeholder|marker|-webkit-[\w-]+|hover|active|focus-visible|focus-within|focus|visited|target)(?![\w-])/g;
  const inMarker = (() => {
    const spans = [...CSS.matchAll(/\/\*<fs>\*\/([\s\S]*?)\/\*<\/fs>\*\//g)].map((m) => [m.index, m.index + m[0].length]);
    return (offset) => spans.some(([a, b]) => offset > a && offset < b);
  })();

  it("(both languages, html and body included)", () => {
    document.body.innerHTML = firstScreenMarkup("da", DICTS) + firstScreenMarkup("en", DICTS).replace('id="lp6-first"', 'id="lp6-first-en"');
    const els = [document.documentElement, document.body, ...document.body.querySelectorAll("*")];
    const missing = [];
    postcss.parse(CSS).walkRules((rule) => {
      if (rule.parent && rule.parent.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
      for (const raw of rule.selectors) {
        const sel = raw.replace(DYN, "").trim() || "*";
        let hit;
        try { hit = els.some((el) => el.matches(sel)); } catch { hit = "unparsed"; }
        if (hit === "unparsed") {
          // :has() on the root: true when the first screen's .lp6 is in the document
          const m = sel.match(/^:root:has\(\.lp6(\[[^\]]+\])?\)(\s+body)?$/);
          hit = m ? !m[1] : true;
        }
        if (hit && !inMarker(rule.source.start.offset)) missing.push(`${rule.source.start.line}: ${raw}`);
      }
    });
    expect(missing.join("\n")).toBe("");
  });

  it("the markers are balanced and the inline sheet carries them all, minified, with the state rules after them", () => {
    const parts = firstScreenRanges();
    expect(parts.length).toBe((CSS.match(/\/\*<fs>\*\//g) || []).length);
    const sheet = firstScreenCss();
    expect(sheet).not.toMatch(/\/\*/);
    expect(sheet).toContain(":root:has(#lp6-first)");
    expect(sheet).toContain("@font-face{font-family:Inter;src:local(");
    expect(sheet.length).toBeLessThan(16000);
    expect(STATE_CSS).toContain("#lp6-first .hero{visibility:hidden}");
    expect(() => firstScreenRanges(CSS.replace("/*</fs>*/", ""))).toThrow(/markers/);
  });
});

// ── the transformed document ──────────────────────────────────────────────────────────────────
const INDEX = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
// what Vite has made of index.html by the time the post hooks run: the entry, its preloads and the stylesheet in <head>
const BUILT = INDEX
  .replace('<script type="module" src="/src/main.jsx"></script>', "")
  .replace("</head>", '<script type="module" crossorigin src="/assets/index-1.js"></script>\n<link rel="modulepreload" crossorigin href="/assets/vendor-react-2.js">\n<link rel="stylesheet" crossorigin href="/assets/index-3.css">\n</head>');
const BUNDLE = {
  "assets/LandingV6Page-abc.js": {
    type: "chunk", fileName: "assets/LandingV6Page-abc.js", facadeModuleId: "/repo/frontend/src/pages/LandingV6Page.jsx",
    imports: ["assets/index-1.js"], viteMetadata: { importedCss: new Set(["assets/LandingV6Page-abc.css"]) },
  },
  "assets/index-1.js": { type: "chunk", fileName: "assets/index-1.js", facadeModuleId: "/repo/frontend/index.html", imports: [] },
  "assets/da-x.js": { type: "chunk", fileName: "assets/da-x.js", facadeModuleId: "/repo/frontend/src/i18n/da.js" },
  "assets/en-x.js": { type: "chunk", fileName: "assets/en-x.js", facadeModuleId: "/repo/frontend/src/i18n/en.js" },
};
async function transformed(html = BUILT, bundle = BUNDLE) {
  const { default: config } = await import("../../vite.config.js");
  const plugins = config.plugins.flat().filter((p) => p && p.transformIndexHtml && p.transformIndexHtml.order === "post");
  for (const p of plugins) html = await p.transformIndexHtml.handler(html, { bundle });
  return html;
}
const scriptsOf = (html) => [...html.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], code: m[2] }));
const guardOf = (html) => scriptsOf(html).find((s) => s.code.includes("__lp6First={lang"))?.code;

// runs the head guard with stand-ins for the globals it reads; returns window.__lp6First and <html lang>
function runGuard(code, { at = "/", hash = "", cookie = "", token = null, native = false, storage = true, nav = "navigate", oldNav, langs = ["da-DK"], store = {} } = {}) {
  const win = native ? { Capacitor: {} } : {};
  const html = { lang: "da" };
  const doc = { cookie, head: { appendChild: () => {} }, createElement: () => ({}), documentElement: html };
  const ls = { getItem: (k) => { if (!storage) throw new Error("blocked"); return k === "token" ? token : (store[k] ?? null); } };
  const perf = { getEntriesByType: () => (nav ? [{ type: nav }] : []), navigation: oldNav === undefined ? undefined : { type: oldNav } };
  new Function("window", "location", "localStorage", "document", "navigator", "performance", code)(
    win, { pathname: at, hash, protocol: "https:" }, ls, doc, { languages: langs, language: langs[0] }, perf);
  return { first: win.__lp6First, htmlLang: html.lang };
}

describe("the head guard: the first screen exactly where the app paints the landing first, minus scenes and returns", () => {
  it("equals landingFirstPaint for a prospect, the session cookie, a stored token, the native shell, blocked storage, other paths", async () => {
    const guard = guardOf(await transformed());
    expect(guard).toBeTruthy();
    const cases = [
      { at: "/" }, { at: "/v2" }, { at: "/v2/" }, { at: "/", cookie: "a=1; bonbox_csrf=abc" }, { at: "/", token: "t" },
      { at: "/", native: true }, { at: "/", storage: false }, { at: "/login" }, { at: "/register" }, { at: "/r/cafe" }, { at: "/dashboard" },
    ];
    for (const c of cases) {
      window.history.replaceState({}, "", c.at);
      if (c.cookie) document.cookie = "bonbox_csrf=abc; path=/";
      if (c.token) localStorage.setItem("token", c.token);
      if (c.native) window.Capacitor = { isNativePlatform: () => true };
      const app = landingFirstPaint();
      expect(!!runGuard(guard, c).first, JSON.stringify(c)).toBe(app);
      document.cookie = "bonbox_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
      localStorage.clear();
      delete window.Capacitor;
    }
  });

  it("never on an address that opens a scene, a reload or a back / forward step (old and new navigation API)", async () => {
    const guard = guardOf(await transformed());
    for (const hash of ["#s1", "#s2", "#s6", "#pricing", "#x"]) expect(runGuard(guard, { hash }).first, hash).toBeUndefined();
    expect(runGuard(guard, { nav: "reload" }).first).toBeUndefined();
    expect(runGuard(guard, { nav: "back_forward" }).first).toBeUndefined();
    expect(runGuard(guard, { nav: null, oldNav: 1 }).first).toBeUndefined();
    expect(runGuard(guard, { nav: null, oldNav: 2 }).first).toBeUndefined();
    expect(runGuard(guard, { nav: null, oldNav: 0 }).first).toEqual({ lang: "da", app: "da" });
    expect(runGuard(guard, { nav: "navigate" }).first).toEqual({ lang: "da", app: "da" });
    expect(runGuard(guard, { nav: "prerender" }).first).toEqual({ lang: "da", app: "da" });
  });

  it("the page language: Danish for da, English for every other app language; <html lang> gets the app's language; storage is only read", async () => {
    const guard = guardOf(await transformed());
    expect(runGuard(guard, { langs: ["en-GB"] })).toEqual({ first: { lang: "en", app: "en" }, htmlLang: "en" });
    expect(runGuard(guard, { langs: ["tr-TR"] })).toEqual({ first: { lang: "en", app: "tr" }, htmlLang: "tr" });
    expect(runGuard(guard, { langs: ["en-US", "da"] })).toEqual({ first: { lang: "da", app: "da" }, htmlLang: "da" });
    expect(runGuard(guard, { langs: ["en-GB"], storage: false }).first).toEqual({ lang: "en", app: "en" });
    expect(guard).not.toMatch(/setItem|removeItem|localStorage\.clear/);
  });
});

describe("the transformed index.html", () => {
  it("every inline script parses; JSON-LD and src scripts untouched; one #root", async () => {
    const out = await transformed();
    for (const s of scriptsOf(out)) {
      if (/src=|ld\+json/.test(s.attrs)) continue;
      expect(() => new Function(s.code), s.code.slice(0, 80)).not.toThrow();
    }
    expect(out.split('<div id="root">')).toHaveLength(2);
    const ld = (h) => h.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/)[0];
    expect(ld(out)).toBe(ld(INDEX));
  });

  it("no first-screen text outside a script (it is script-written: no JavaScript, today's empty page)", async () => {
    const out = await transformed();
    // the body (the head's title and description carry the headline on purpose: seoHead.test.js)
    const body = out.slice(out.indexOf("<body"));
    const outside = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");
    for (const k of ["landingV6.h1.shifts", "landingV6.sub", "landingV6.seePrices"]) {
      expect(outside, k).not.toContain(da[k]);
      expect(outside, k).not.toContain(en[k]);
    }
    expect(outside).not.toContain("lp6-first");
  });

  it("the app stylesheet: a preload, then a script-made link on the first-screen path, the parser-made link everywhere else, <noscript> without JS", async () => {
    const out = await transformed();
    expect(out).not.toContain('<link rel="stylesheet" crossorigin href="/assets/index-3.css">\n');
    expect(out).toContain('<link rel="preload" as="style" crossorigin href="/assets/index-3.css"><style id="lp6-css">');
    expect(out).toContain('<noscript><link rel="stylesheet" crossorigin href="/assets/index-3.css"></noscript>');
    const loader = scriptsOf(out).find((s) => s.code.includes('getElementById("lp6-css")')).code;
    // the first-screen path: one script-made link, before the inline sheet, marked data-bb-css (main.jsx waits for it)
    document.head.innerHTML = '<style id="lp6-css"></style>';
    window.__lp6First = { lang: "da" };
    new Function(loader)();
    const made = document.head.querySelector("link[data-bb-css]");
    expect(made.rel).toBe("stylesheet");
    expect(made.getAttribute("href")).toBe("/assets/index-3.css");
    expect(made.crossOrigin).toBe(""); // = the preload's mode: one request
    expect(made.nextElementSibling.id).toBe("lp6-css");
    made.onload();
    expect(made.hasAttribute("data-done")).toBe(true);
    // every other visit: the parser-made, blocking link, written in place
    delete window.__lp6First;
    const written = [];
    new Function("document", "window", loader)({ write: (h) => written.push(h), getElementById: () => null, createElement: () => ({}) }, {});
    expect(written).toEqual(['<link rel="stylesheet" crossorigin href="/assets/index-3.css">']);
    document.head.innerHTML = "";
  });

  it("a build without a landing chunk (the Vagtplan app) leaves the document byte-equal", async () => {
    const { default: config } = await import("../../vite.config.js");
    const p = config.plugins.flat().find((x) => x && x.name === "bonbox-landing-first-screen");
    expect(p.apply).toBe("build");
    expect(p.transformIndexHtml.order).toBe("post");
    const bundle = { "assets/index-1.js": BUNDLE["assets/index-1.js"] };
    expect(await p.transformIndexHtml.handler(BUILT, { bundle })).toBe(BUILT);
    expect(await p.transformIndexHtml.handler(BUILT, {})).toBe(BUILT);
  });

  it("vite.config: after the booking script, before the dictionaries; the source index.html is untouched", () => {
    const cfg = fs.readFileSync(path.join(FRONTEND, "vite.config.js"), "utf8");
    const plugins = cfg.match(/plugins: \[([^\]]*)\]/)[1];
    expect(plugins.indexOf("bookingBoot()")).toBeLessThan(plugins.indexOf("landingFirstScreen()"));
    expect(INDEX).not.toContain("lp6-first");
    expect(INDEX).not.toContain("__lp6First");
  });
});

describe("the first-screen script inside #root", () => {
  // runs the script in this document: `anchor` stands for the script element, the screen is inserted before it
  function runScreen({ lang = "da", search = "" } = {}) {
    const code = firstScreenScript(DICTS).replace(/^<script>|<\/script>$/g, "");
    const root = document.createElement("div");
    root.id = "root";
    const anchor = document.createElement("i");
    root.appendChild(anchor);
    document.body.appendChild(root);
    window.__lp6First = { lang };
    const doc = { currentScript: anchor, getElementById: (id) => document.getElementById(id), head: document.head, createElement: (t) => document.createElement(t), addEventListener: () => {} };
    new Function("window", "document", "location", code)(window, doc, { search });
    anchor.remove();
    return document.getElementById("lp6-first");
  }

  it("writes the first screen in the guard's language, and nothing without the guard's mark", () => {
    expect(runScreen({ lang: "da" }).outerHTML).toBe(firstScreenMarkup("da", DICTS));
    document.body.innerHTML = "";
    expect(runScreen({ lang: "en" }).outerHTML).toBe(firstScreenMarkup("en", DICTS));
    document.body.innerHTML = "";
    const code = firstScreenScript(DICTS).replace(/^<script>|<\/script>$/g, "");
    const anchor = document.createElement("i");
    document.body.appendChild(anchor);
    new Function("window", "document", code)({}, { currentScript: anchor });
    expect(document.body.innerHTML).toBe("<i></i>");
  });

  it("?ref= rides on the two real links (Prøv gratis twice, Log ind), URL-encoded, set through the DOM", () => {
    const screen = runScreen({ search: '?ref=r1-a-03&x=1' });
    const hrefs = [...screen.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/login?ref=r1-a-03", "/register?ref=r1-a-03", "/register?ref=r1-a-03"]);
    document.body.innerHTML = "";
    const odd = runScreen({ search: '?ref="><img src=x>' });
    expect(odd.querySelector("a.login").getAttribute("href")).toBe('/login?ref=%22%3E%3Cimg%20src%3Dx%3E');
    expect(odd.querySelector("img")).toBeNull();
    document.body.innerHTML = "";
    expect(runScreen({ search: "" }).querySelector("a.login").getAttribute("href")).toBe("/login");
  });

  it("a tap on a flag, Priser, Se priser, a headline word or the logo is remembered (anchors do not jump); the real links stay links", () => {
    const screen = runScreen();
    const click = (el, init = {}) => { const e = new MouseEvent("click", { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e; };
    click(screen.querySelector('.top button[lang="en"] svg'));
    expect(window.__lp6First.tap).toEqual({ r: "top", s: 'button[lang="en"]', i: 0 });
    expect(click(screen.querySelector(".hero .tlink")).defaultPrevented).toBe(true);
    expect(window.__lp6First.tap).toEqual({ r: "hero", s: 'a[href="#pricing"]', i: 0 });
    expect(click(screen.querySelector('.hero .h1 a[href="#s2"] span')).defaultPrevented).toBe(true);
    expect(window.__lp6First.tap).toEqual({ r: "hero", s: 'a[href="#s2"]', i: 0 });
    click(screen.querySelector(".top .prices-l"));
    expect(window.__lp6First.tap).toEqual({ r: "top", s: 'a[href="#pricing"]', i: 0 });
    click(screen.querySelector(".top .logo"));
    expect(window.__lp6First.tap).toEqual({ r: "top", s: 'a[href="#main"]', i: 0 });
    // a real link: no record, no prevented default; a modified click (new tab) is the browser's
    expect(click(screen.querySelector(".hero .btn")).defaultPrevented).toBe(false);
    expect(click(screen.querySelector(".top .login")).defaultPrevented).toBe(false);
    expect(click(screen.querySelector(".hero .tlink"), { metaKey: true }).defaultPrevented).toBe(false);
    expect(window.__lp6First.tap).toEqual({ r: "top", s: 'a[href="#main"]', i: 0 });
    screen.querySelector(".hero .tlink").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(window.__lp6First.focus).toEqual({ r: "hero", s: 'a[href="#pricing"]', i: 0 });
  });

  it("at takeover the tap is replayed on the same control of the real page, and focus moves there", () => {
    const screen = runScreen();
    screen.querySelector('.hero .h1 a[href="#s6"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const tlink = screen.querySelector(".hero .tlink");
    tlink.focus();
    tlink.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    holdFirstScreen(); // main.jsx, right before the mount: the focus is still on the static control
    screen.remove(); // React's first commit
    const t = tFor(da);
    const page = document.createElement("div");
    page.className = "lp6";
    page.setAttribute("data-page", "landing");
    page.innerHTML = renderToStaticMarkup(<MemoryRouter><TopBar t={t} lang="da" onLang={() => {}} /><Hero t={t} /></MemoryRouter>);
    document.body.appendChild(page);
    const clicked = vi.fn();
    page.addEventListener("click", (e) => { clicked(e.target.closest("a,button").getAttribute("href")); e.preventDefault(); });
    replayFirstScreen(page);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledWith("#s6");
    expect(document.activeElement).toBe(page.querySelector(".hero .tlink"));
    // once only
    replayFirstScreen(page);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("controlIn accepts only the first screen's own controls", () => {
    const page = document.createElement("div");
    page.innerHTML = '<header class="top"><a href="#pricing">P</a><a href="/x">X</a></header>';
    expect(controlIn(page, { r: "top", s: 'a[href="#pricing"]', i: 0 })).toBe(page.querySelector("a"));
    expect(controlIn(page, { r: "top", s: 'a[href="/x"]', i: 0 })).toBeNull();
    expect(controlIn(page, { r: "foot", s: 'a[href="#pricing"]', i: 0 })).toBeNull();
    expect(controlIn(page, { r: "top", s: "a", i: 0 })).toBeNull();
    expect(controlIn(page, null)).toBeNull();
  });
});

describe("main.jsx waits for the app stylesheet and, for another language, its dictionary", () => {
  it("source", () => {
    const main = read("main.jsx");
    expect(main).toContain("document.querySelector('link[data-bb-css]')");
    expect(main).toMatch(/link\.addEventListener\('load', resolve, \{ once: true \}\)/);
    expect(main).toMatch(/link\.addEventListener\('error', resolve, \{ once: true \}\)/);
    expect(main).toMatch(/if \(code !== 'da' && code !== 'en'\) \{\s*waits\.push\(Promise\.all\(localesFor\(code\)\.map\(\(c\) => loadLocale\(c\)\)\)\)\s*cap = 15000/);
    expect(main).toContain("let cap = 4000");
  });
});
