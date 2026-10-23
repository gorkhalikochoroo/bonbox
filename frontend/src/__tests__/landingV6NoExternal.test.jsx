/**
 * LANDING V6 — the page asks no other host for anything (PORT_PLAN 5.1 "landingV6NoExternal", port step 10).
 *
 * A logged-out first visit to www.bonbox.dk must not tell Google, Apple, Instagram or a font CDN that it happened:
 * the only requests are to the page's own origin (the chunk, its CSS, Inter 300, the pictures under /assets/) and the
 * app's own API. This is the static half and the jsdom half; the real-browser half (every request of a full load,
 * scroll, all steps and a language switch goes to the page origin or the API) is the lab's 5.3 "Requests" check.
 *   - source: the only absolute URLs in the tree are the two App Store links and the Instagram link, all plain <a>
 *     hrefs (a click, never a fetch, a preload or an embed); nothing in the tree fetches, beacons, opens a socket,
 *     builds a <script>/<link>/<img> or imports a URL; every import is relative or one of three packages;
 *   - styles: no remote url(), no @import; Inter 300 comes from @fontsource as relative files (CSP font-src 'self');
 *   - the rendered page (da, en, Android): every src / href / srcset is relative, a fragment, mailto: or one of
 *     those three links; no iframe, script, link, object, embed or form;
 *   - the real engine on the real page, scrolled, stepped 1 → 7 and switched DK → EN: no fetch, no XHR, no
 *     sendBeacon, no element with a remote src added.
 * The one network call the page can make is the app's own client-error beacon (reportClientError → the API origin)
 * when the engine fails to mount; it is not part of a normal visit and is pinned in landingV6Page.test.jsx.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { APP_STORE } from "../components/landing/v6/site";

const beacon = vi.hoisted(() => vi.fn());
vi.mock("../utils/reportClientError", () => ({ reportClientError: (o) => beacon(o) }));
const { default: LandingV6Page } = await import("../pages/LandingV6Page");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const V6 = "components/landing/v6";
const TREE = ["pages/LandingV6Page.jsx", ...fs.readdirSync(path.join(SRC, V6)).filter((f) => /\.(jsx?|css)$/.test(f)).map((f) => `${V6}/${f}`)];
const CODE = TREE.filter((f) => /\.jsx?$/.test(f));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const INSTAGRAM = "https://www.instagram.com/bonbox.dk/";
const ALLOWED = [APP_STORE.scheduler, APP_STORE.owner, INSTAGRAM];

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const ORIGINAL_UA = navigator.userAgent;
const setUA = (ua) => Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });

afterEach(() => { cleanup(); setUA(ORIGINAL_UA); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the source asks no other host", () => {
  it("the tree has files to check (the walk found them)", () => {
    expect(CODE.length).toBeGreaterThanOrEqual(15);
    expect(TREE).toContain(`${V6}/landingV6.css`);
    expect(TREE).toContain(`${V6}/engine.js`);
  });

  it("the only absolute URLs are the two App Store apps (the live ids) and Instagram", () => {
    const found = new Set();
    for (const f of TREE) for (const m of stripComments(read(f)).matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi)) found.add(m[0]);
    expect([...found].sort()).toEqual([...ALLOWED].sort());
    expect(APP_STORE).toEqual({
      scheduler: "https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793",
      owner: "https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960",
    });
  });

  it("nothing in the tree fetches, beacons, opens a socket, builds a <script> / <link> / <img>, or imports a URL", () => {
    const NET = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|new\s+Image\s*\(|createElement\s*\(\s*["'`](script|link|img|iframe)|\bimport\s*\(|\.src\s*=|srcset|rel\s*=\s*["'](preconnect|dns-prefetch|prefetch|preload)/;
    for (const f of CODE) expect([f, stripComments(read(f)).match(NET)?.[0] ?? null]).toEqual([f, null]);
  });

  it("every import is relative, or react / react-router-dom / @fontsource/inter's latin-300 stylesheet", () => {
    const specs = new Set();
    for (const f of CODE) for (const m of read(f).matchAll(/^\s*import\s+(?:[^"';]+\s+from\s+)?["']([^"']+)["']/gm)) specs.add(m[1]);
    expect(specs.size).toBeGreaterThan(20);
    expect([...specs].filter((s) => !s.startsWith(".") && !["react", "react-router-dom", "@fontsource/inter/latin-300.css"].includes(s))).toEqual([]);
    // the pictures are files in the tree, imported (hashed under /assets/ by Vite)
    for (const m of read(`${V6}/images.js`).matchAll(/from\s+["'](\.\/img\/[^"'?]+)(\?no-inline)?["']/g)) expect(fs.existsSync(path.join(SRC, V6, m[1]))).toBe(true);
  });

  it("the stylesheets: no remote url(), no @import; Inter 300 is two relative font files from @fontsource (font-src 'self')", () => {
    const css = read(`${V6}/landingV6.css`);
    expect(css).not.toMatch(/@import/);
    expect([...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]).filter((u) => /^(https?:)?\/\//.test(u))).toEqual([]);
    const inter = fs.readFileSync(path.join(SRC, "../node_modules/@fontsource/inter/latin-300.css"), "utf8");
    const urls = [...inter.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    expect(urls).toEqual(["./files/inter-latin-300-normal.woff2", "./files/inter-latin-300-normal.woff"]);
    expect(inter).not.toMatch(/@import|https?:/);
  });
});

describe("the rendered page points nowhere else", () => {
  function show(lang, ua) {
    localStorage.setItem("lang", lang);
    setUA(ua);
    return render(<MemoryRouter><LanguageProvider><LandingV6Page /></LanguageProvider></MemoryRouter>).container.querySelector(".lp6");
  }

  for (const [lang, ua, name] of [["da", IPHONE, "da, iPhone"], ["en", IPHONE, "en, iPhone"], ["da", ANDROID, "da, Android"]]) {
    it(`${name}: every src / href / srcset is relative, a fragment, mailto: or one of the three links; no embed of any kind`, () => {
      const root = show(lang, ua);
      const refs = [];
      for (const el of root.querySelectorAll("*")) {
        for (const a of ["src", "href", "srcset", "xlink:href", "action", "poster", "data", "formaction"]) {
          const v = el.getAttribute(a);
          if (v != null) refs.push(v);
        }
      }
      expect(refs.length).toBeGreaterThan(30);
      const outside = refs.filter((v) => /^(https?:)?\/\//i.test(v) || /^[a-z][a-z0-9+.-]*:/i.test(v) && !/^mailto:/i.test(v));
      expect(outside.filter((v) => !ALLOWED.includes(v))).toEqual([]);
      if (ua === ANDROID) expect(outside.filter((v) => v.includes("apps.apple.com"))).toEqual([]);
      expect(root.querySelectorAll("iframe, script, link, object, embed, form, video, audio")).toHaveLength(0);
      // the one <picture> (the 16.40 staff-app screen, a taller file on tall phones) offers a second file of the tree, never a remote one
      for (const s of root.querySelectorAll("picture source")) expect(s.getAttribute("srcset")).toMatch(/^[^:]+\.webp$/);
      // the external links are plain links in this tab (no target, nothing that opens a window by script)
      for (const a of root.querySelectorAll("a[href^='http']")) expect([a.getAttribute("href"), a.getAttribute("target")]).toEqual([a.getAttribute("href"), null]);
    });
  }
});

describe("the real engine on the real page makes no request", () => {
  it("load, scroll, Næste 1 → 7, Forrige, DK → EN: no fetch, no XHR, no sendBeacon, no remote src added", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in this test")));
    vi.stubGlobal("fetch", fetchSpy);
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
    class Obs { observe() {} unobserve() {} disconnect() {} }
    vi.stubGlobal("ResizeObserver", Obs);
    vi.stubGlobal("IntersectionObserver", Obs);
    vi.stubGlobal("matchMedia", (q) => Object.assign(new EventTarget(), { matches: false, media: q, addListener() {}, removeListener() {} }));
    let Y = 0;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    Object.defineProperty(window, "scrollY", { get: () => Y, configurable: true });
    vi.stubGlobal("scrollTo", (a, b) => { Y = typeof a === "object" ? a.top : b; });
    const added = [];
    const onRecs = (recs) => { for (const r of recs) { if (r.type === "attributes") added.push(`${r.attributeName}="${r.target.getAttribute(r.attributeName)}"`); else r.addedNodes.forEach((n) => n.nodeType === 1 && added.push(n.outerHTML)); } };
    const mo = new MutationObserver(onRecs);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "href"] });
    try {
      localStorage.setItem("lang", "da");
      setUA(IPHONE);
      render(<MemoryRouter><LanguageProvider><LandingV6Page /></LanguageProvider></MemoryRouter>);
      await act(async () => { await Promise.resolve(); });
      const step = (sel) => { fireEvent.click(document.querySelector(sel)); window.dispatchEvent(new Event("scroll")); act(() => { vi.advanceTimersByTime(700); }); };
      Y = 1500; window.dispatchEvent(new Event("scroll")); act(() => { vi.advanceTimersByTime(700); });
      for (let n = 0; n < 7; n++) step("#dnext");
      step("#dprev");
      fireEvent.click(document.querySelector(".lang button[lang='en']"));
      await act(async () => { await Promise.resolve(); });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(document.querySelector(".lp6").getAttribute("lang")).toBe("en");
      await act(async () => { await Promise.resolve(); });
      onRecs(mo.takeRecords());
      expect(added.length).toBeGreaterThan(0); // the English page's nodes were seen arriving
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrOpen).not.toHaveBeenCalled();
      expect(sendBeacon).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled(); // the engine mounted cleanly both times
      expect(added.join("\n")).not.toMatch(/(src|href)="(https?:)?\/\/(?!apps\.apple\.com\/dk\/app\/bonbox-|www\.instagram\.com\/bonbox\.dk\/)/);
    } finally {
      mo.disconnect();
      delete navigator.sendBeacon;
      vi.unstubAllGlobals();
    }
  });
});
