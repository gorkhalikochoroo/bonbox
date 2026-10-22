/**
 * LANDING V6 — security pins (security fix round, 23 Oct 2026). Permanent: each block was proven by a deliberate
 * break that turned it red (the release notes list the breaks).
 *
 *   (a) no HTML / code sink in the landing's own code: dangerouslySetInnerHTML, innerHTML, outerHTML,
 *       insertAdjacentHTML, document.write, eval, new Function, a string setTimeout / setInterval — in
 *       components/landing/v6 (engine.js, nav.js, guard.js included) and pages/LandingV6Page.jsx. The raw source is
 *       read, comments included: a comment naming a sink trips it too (reword the comment);
 *   (b) every target="_blank" on the landing carries rel with noopener and noreferrer (source and rendered page), and
 *       the landing opens no window itself;
 *   (c) every href / src the landing has is relative, on the app's own origin, or on the allow-list (apps.apple.com,
 *       www.instagram.com, www.bonbox.dk over https; mailto:contact@bonbox.dk) — in the source, in the landing's
 *       dictionary values, in its stylesheet and on the rendered page (da, en, iPhone, Android);
 *   (d) the page rendered with hostile ?plan, ?lang and #hash (an <img onerror>, javascript:, //evil.example …), with
 *       the real language provider, the real engine and the cookie banner: nothing hostile renders (no on* attribute,
 *       no script scheme, no payload as markup or as text), the tab title is the landing's, and every register link's
 *       plan is starter, pro or absent;
 *   (e) frontend/vercel.json's security headers equal origin/main's or are stricter (both parsed; the baseline is
 *       fixtures/vercelHeaders.origin-main.json, a verbatim copy: CI has no origin/main); no CSP directive loosened;
 *   (f) before consent the landing sends no analytics or usage request (the app's analytics module and usage log, the
 *       api client, fetch, XHR, sendBeacon all watched; the app's page tracking mounted beside it), and — so the
 *       watch is not blind — after "Accept all" the usage log's request is seen.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { usePageTracking } from "../hooks/useEventLog";
import { LANDING_TITLE_VALUES } from "../lib/shellTitles";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";

/* ── every way a request can leave, recorded (f); nothing reaches a network ── */
const NET = vi.hoisted(() => ({ calls: [] }));
vi.mock("../services/api", () => {
  const rec = (method) => (url) => { NET.calls.push({ via: "api", method, url: String(url) }); return Promise.resolve({ data: {} }); };
  const none = { use() { return 0; }, eject() {} };
  return {
    default: {
      get: rec("get"), post: rec("post"), put: rec("put"), patch: rec("patch"), delete: rec("delete"),
      request: (cfg) => rec((cfg && cfg.method) || "request")(cfg && cfg.url),
      interceptors: { request: none, response: none }, defaults: { headers: { common: {} } },
    },
  };
});
// utils/analytics.track has no consent check of its own: any call before consent is a leak, whatever its mode
vi.mock("../utils/analytics", async (importOriginal) => {
  const a = await importOriginal();
  return { ...a, track: (...args) => { NET.calls.push({ via: "track", url: "/api/analytics", args }); return a.track(...args); } };
});

const { default: LandingV6Page } = await import("../pages/LandingV6Page");
const { default: CookieConsent } = await import("../components/CookieConsent");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.resolve(SRC, "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const V6 = "components/landing/v6";
const TREE = ["pages/LandingV6Page.jsx", ...fs.readdirSync(path.join(SRC, V6)).filter((f) => /\.jsx?$/.test(f)).map((f) => `${V6}/${f}`)];

/* ── the browser around the real engine (jsdom has no layout: the engine's own fall-backs) ── */
let restoreEnv = null;
function browser({ w = 390, h = 844, ua = null } = {}) {
  const saved = { matchMedia: window.matchMedia, RO: window.ResizeObserver, IO: window.IntersectionObserver, scrollTo: window.scrollTo, fetch: globalThis.fetch, ua: navigator.userAgent, beacon: navigator.sendBeacon };
  window.matchMedia = (q) => { const l = new EventTarget(); l.matches = false; l.media = q; l.addListener = () => {}; l.removeListener = () => {}; return l; };
  class Obs { observe() {} unobserve() {} disconnect() {} }
  window.ResizeObserver = Obs;
  window.IntersectionObserver = Obs;
  window.scrollTo = () => {};
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
  if (ua) Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  globalThis.fetch = (input) => { NET.calls.push({ via: "fetch", url: String((input && input.url) || input) }); return Promise.resolve(new Response("{}", { status: 200 })); };
  Object.defineProperty(window.navigator, "sendBeacon", { value: (url) => { NET.calls.push({ via: "beacon", url: String(url) }); return true; }, configurable: true, writable: true });
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(function (method, url) { NET.calls.push({ via: "xhr", method, url: String(url) }); });
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {});
  restoreEnv = () => {
    Object.assign(window, { matchMedia: saved.matchMedia, ResizeObserver: saved.RO, IntersectionObserver: saved.IO, scrollTo: saved.scrollTo });
    globalThis.fetch = saved.fetch;
    Object.defineProperty(window.navigator, "userAgent", { value: saved.ua, configurable: true });
    Object.defineProperty(window.navigator, "sendBeacon", { value: saved.beacon, configurable: true, writable: true });
  };
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";

function PageTracking() { usePageTracking(); return null; }

/** The landing as the app shows it: the real provider, router, page, engine, cookie banner, and the app's page
 *  tracking (Layout's) mounted beside it so the usage log sees every route. */
const app = (entry) => (
  <MemoryRouter initialEntries={[entry]}>
    <LanguageProvider>
      <PageTracking />
      <Routes>
        <Route path="/" element={<LandingV6Page />} />
        <Route path="/login" element={<p data-testid="login-page">login</p>} />
        <Route path="/register" element={<p data-testid="register-page">register</p>} />
      </Routes>
      <CookieConsent />
    </LanguageProvider>
  </MemoryRouter>
);
const lp6 = () => document.querySelector(".lp6");
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const tick = (ms) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  NET.calls.length = 0;
  localStorage.setItem("lang", "da");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (restoreEnv) { restoreEnv(); restoreEnv = null; }
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  document.documentElement.lang = "da";
});

/* ───────────────────────────── (a) ───────────────────────────── */
describe("(a) no HTML or code sink in the landing's code", () => {
  const SINKS = [
    ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
    ["innerHTML", /\binnerHTML\b/],
    ["outerHTML", /\bouterHTML\b/],
    ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
    ["createContextualFragment", /\bcreateContextualFragment\b/],
    ["srcdoc", /\bsrcdoc\b/i],
    ["document.write", /\bdocument\s*\.\s*write(?:ln)?\b/],
    ["eval", /\beval\s*\(|\[\s*["'`]eval["'`]\s*\]/],
    ["new Function / Function(", /\bnew\s+Function\b|(?<![\w.$])Function\s*\(/],
    ["string setTimeout / setInterval", /\bset(?:Timeout|Interval)\s*\(\s*["'`]/],
  ];

  it("the scanned tree is the whole landing: the page, every component, engine.js, nav.js, guard.js", () => {
    for (const f of ["pages/LandingV6Page.jsx", `${V6}/engine.js`, `${V6}/nav.js`, `${V6}/guard.js`, `${V6}/Sheet.jsx`, `${V6}/Stage.jsx`, `${V6}/rich.jsx`]) expect(TREE).toContain(f);
    expect(TREE.length).toBeGreaterThanOrEqual(20);
  });

  it("no file in it uses one (raw source, comments included)", () => {
    const hits = [];
    for (const f of TREE) {
      read(f).split("\n").forEach((line, i) => {
        for (const [name, re] of SINKS) if (re.test(line)) hits.push(`${f}:${i + 1} ${name}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the patterns catch what they are for (each one on a sample line)", () => {
    const samples = {
      "dangerouslySetInnerHTML": "<p dangerouslySetInnerHTML={{ __html: x }} />",
      "innerHTML": "el.innerHTML = x;",
      "outerHTML": "const s = el.outerHTML;",
      "insertAdjacentHTML": "el.insertAdjacentHTML('beforeend', x)",
      "createContextualFragment": "range.createContextualFragment(x)",
      "srcdoc": "<iframe srcDoc={x} />",
      "document.write": "document.write(x)",
      "eval": "eval(x)",
      "new Function / Function(": "const f = new Function('a', x);",
      "string setTimeout / setInterval": "setTimeout('go()', 10)",
    };
    for (const [name, re] of SINKS) expect([name, re.test(samples[name])]).toEqual([name, true]);
    // and not on what the landing does use
    for (const ok of ["setTimeout(() => { throw err; }, 0)", "el.textContent = t", "nx.className = 'sx f1 in'"]) for (const [name, re] of SINKS) expect([name, ok, re.test(ok)]).toEqual([name, ok, false]);
  });
});

/* ───────────────────────────── (b) ───────────────────────────── */
/** The opening JSX / HTML tag around index i of src (from its "<" to its ">", braces and quotes skipped). */
function tagAround(src, i) {
  let s = i;
  while (s > 0 && !(src[s] === "<" && /[A-Za-z]/.test(src[s + 1] || ""))) s--;
  let depth = 0, q = null;
  for (let j = s + 1; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === q && src[j - 1] !== "\\") q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[j - 1] !== "=") return src.slice(s, j + 1);
  }
  return src.slice(s);
}
const relOk = (rel) => /\bnoopener\b/i.test(rel || "") && /\bnoreferrer\b/i.test(rel || "");

describe("(b) target=_blank always with rel=noopener noreferrer", () => {
  it("source: every _blank sits in a tag whose rel names noopener and noreferrer; no window.open", () => {
    const bad = [];
    for (const f of TREE) {
      const src = read(f);
      for (const m of src.matchAll(/_blank/g)) {
        const tag = tagAround(src, m.index);
        const rel = (tag.match(/\brel\s*=\s*(?:\{\s*)?["'`]([^"'`]*)["'`]/) || [])[1];
        if (!relOk(rel)) bad.push(`${f}: ${tag.replace(/\s+/g, " ").slice(0, 160)}`);
      }
      if (/\bwindow\s*\.\s*open\s*\(|(?<![\w.$])open\s*\(\s*["'`]http/.test(src)) bad.push(`${f}: window.open`);
    }
    expect(bad).toEqual([]);
  });

  it("the tag reader finds the whole tag, arrow functions and all", () => {
    const src = '<a className="x" onClick={() => go(1)} target="_blank" rel="noopener noreferrer" href="/y">';
    expect(tagAround(src, src.indexOf("_blank"))).toBe(src);
  });

  for (const [name, lang, ua] of [["da, iPhone", "da", IPHONE], ["en, Android", "en", ANDROID]]) {
    it(`rendered page (${name}): every element with target=_blank has both rels`, async () => {
      browser({ ua });
      localStorage.setItem("lang", lang);
      render(app("/"));
      await flush();
      tick(700); // the cookie banner opens after its beat
      await flush();
      expect(lp6()).not.toBeNull();
      const blank = [...document.querySelectorAll("[target]")].filter((el) => /^_blank$/i.test(el.getAttribute("target")));
      expect(blank.filter((el) => !relOk(el.getAttribute("rel"))).map((el) => el.outerHTML.slice(0, 160))).toEqual([]);
    });
  }
});

/* ───────────────────────────── (c) ───────────────────────────── */
const ALLOWED_HOSTS = ["apps.apple.com", "www.instagram.com", "www.bonbox.dk"];
const ALLOWED_MAIL = "mailto:contact@bonbox.dk";
/** Why a URL value is not allowed, or null when it is: relative, on the page's origin, an allowed https host, the
 *  contact address; for a picture also an inlined data:image (Vite inlines files under 4 KB). */
function urlProblem(raw, { image = false } = {}) {
  const v = String(raw).trim();
  if (v === "") return null;
  if (v === ALLOWED_MAIL) return null;
  if (image && /^data:image\/(?:webp|png|jpeg|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(v)) return null;
  if (/^[\w+.-]+:/.test(v)) {
    let u;
    try { u = new URL(v); } catch { return `unparseable ${v}`; }
    if (u.origin === window.location.origin) return null;
    if (u.protocol === "https:" && ALLOWED_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.port) return null;
    return `off the allow-list: ${v}`;
  }
  if (v.startsWith("//") || v.startsWith("\\\\") || v.startsWith("/\\")) return `protocol-relative: ${v}`;
  return null; // relative: "/x", "#x", "x" resolve on this origin
}
const URL_ATTRS = ["href", "src", "srcset", "xlink:href", "action", "formaction", "poster", "data", "background", "cite", "ping"];
function renderedUrlProblems(scope) {
  const bad = [];
  for (const el of scope.querySelectorAll("*")) {
    for (const a of URL_ATTRS) {
      const v = el.getAttribute(a);
      if (v == null) continue;
      const parts = a === "srcset" ? v.split(",").map((s) => s.trim().split(/\s+/)[0]) : a === "ping" ? v.split(/\s+/) : [v];
      for (const p of parts) {
        const why = urlProblem(p, { image: /^(img|source|picture|image)$/i.test(el.tagName) });
        if (why) bad.push(`<${el.tagName.toLowerCase()} ${a}> ${why}`);
      }
    }
  }
  return bad;
}

describe("(c) every link and picture: relative, this origin, or the allow-list", () => {
  it("the URL rule itself (both ways)", () => {
    for (const ok of ["/register?plan=pro", "#pricing", "/privacy", "https://apps.apple.com/dk/app/x/id1", "https://www.instagram.com/bonbox.dk/", "https://www.bonbox.dk/", "mailto:contact@bonbox.dk", `${window.location.origin}/terms`]) expect([ok, urlProblem(ok)]).toEqual([ok, null]);
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "//evil.example", "https://evil.example/", "http://www.bonbox.dk/", "https://apps.apple.com.evil.example/", "https://x@www.bonbox.dk/", "mailto:someone@evil.example", "data:text/html,<script>alert(1)</script>", "vbscript:x"]) expect([bad, urlProblem(bad)]).not.toEqual([bad, null]);
    expect(urlProblem("data:image/webp;base64,UklGRg==", { image: true })).toBeNull();
    expect(urlProblem("data:image/webp;base64,UklGRg==")).not.toBeNull();
  });

  it("source: every absolute or scheme URL written in the landing's code is on the allow-list", () => {
    const bad = [];
    for (const f of TREE) {
      const src = read(f);
      for (const m of src.matchAll(/\bhttps?:\/\/[^\s"'`)<>\\]+/gi)) { const why = urlProblem(m[0]); if (why) bad.push(`${f}: ${why}`); }
      for (const m of src.matchAll(/["'`](\/\/[^\s"'`]*)/g)) bad.push(`${f}: protocol-relative ${m[1]}`);
      for (const m of src.matchAll(/\b(?:javascript|vbscript|blob|file|ftp|tel|sms):[^\s"'`)<>,;}.][^\s"'`)<>,;}]*|\bdata:[a-z]+\/[\w.+-]+/gi)) bad.push(`${f}: scheme ${m[0]}`);
      for (const m of src.matchAll(/\bmailto:([^\s"'`)<>]*)/gi)) if (m[1] !== "${CONTACT_EMAIL}" && m[0] !== ALLOWED_MAIL) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
    expect(read(`${V6}/site.js`)).toMatch(/export const CONTACT_EMAIL = "contact@bonbox\.dk";/);
  });

  it("the landing's dictionary values carry no URL at all (da + en); its stylesheet loads nothing from elsewhere", () => {
    for (const d of [da, en]) {
      const keys = Object.keys(d).filter((k) => k.startsWith("landingV6."));
      expect(keys.length).toBeGreaterThan(80);
      const bad = keys.filter((k) => /(?:https?:|\/\/|javascript:|data:|mailto:|www\.)/i.test(String(d[k])));
      expect(bad).toEqual([]);
    }
    const css = read(`${V6}/landingV6.css`);
    expect(css).not.toMatch(/@import/i);
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((m) => m[1]);
    expect(urls.filter((u) => /^[\w+.-]+:/.test(u) && !/^data:/.test(u) || u.startsWith("//"))).toEqual([]);
  });

  for (const [name, lang, ua] of [["da, iPhone", "da", IPHONE], ["en, iPhone", "en", IPHONE], ["da, Android", "da", ANDROID], ["en, Android", "en", ANDROID]]) {
    it(`rendered page (${name}): every href / src / srcset in the document passes`, async () => {
      browser({ ua });
      localStorage.setItem("lang", lang);
      render(app("/"));
      await flush();
      tick(700);
      await flush();
      const root = lp6();
      expect(root).not.toBeNull();
      // not vacuous: the page has its links and pictures
      expect(root.querySelectorAll("a[href]").length).toBeGreaterThan(15);
      expect(root.querySelectorAll("img[src]").length).toBeGreaterThan(8);
      expect(renderedUrlProblems(document)).toEqual([]);
      const abs = [...root.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).filter((h) => /^[\w+.-]+:/.test(h));
      expect(abs.length).toBeGreaterThanOrEqual(ua === ANDROID ? 3 : 5); // mail ×2, Instagram (+ the two App Store links off Android)
    });
  }
});

/* ───────────────────────────── (d) ───────────────────────────── */
const PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  '"><img src=x onerror=alert(1)>',
  "javascript:alert(1)",
  "//evil.example",
  "https://evil.example/x",
  'starter"><script>alert(1)</script>',
  "pro&plan=<svg onload=alert(1)>",
];
const HOSTILE_TEXT = [/onerror/i, /onload/i, /<script/i, /javascript:/i, /evil\.example/i, /alert\(1\)/, /&lt;img/i, /&lt;svg/i, /&lt;script/i, /%3Cimg/i, /%3Csvg/i, /%3Cscript/i, /<img[^>]*src="?x"?[\s>]/i];

function assertNothingHostile() {
  const html = document.documentElement.outerHTML;
  expect(HOSTILE_TEXT.filter((re) => re.test(html)).map(String)).toEqual([]);
  const onAttrs = [...document.querySelectorAll("*")].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `<${el.tagName.toLowerCase()} ${a.name}>`));
  expect(onAttrs).toEqual([]);
  expect(document.querySelectorAll("script, iframe, object, embed, base, meta[http-equiv]").length).toBe(0);
  const schemes = [...document.querySelectorAll("[href], [src], [action], [formaction], [xlink\\:href]")]
    .flatMap((el) => ["href", "src", "action", "formaction", "xlink:href"].map((a) => el.getAttribute(a)).filter((v) => v != null))
    .filter((v) => /^(?:javascript|vbscript|data:text|data:application)/i.test([...v].filter((ch) => ch.charCodeAt(0) > 32).join("")));
  expect(schemes).toEqual([]);
  expect(renderedUrlProblems(document)).toEqual([]);
}

function assertRegisterLinks() {
  const regs = [...document.querySelectorAll("a[href]")].filter((a) => {
    try { return new URL(a.getAttribute("href"), window.location.origin).pathname.replace(/\/+$/, "") === "/register"; } catch { return false; }
  });
  expect(regs.length).toBeGreaterThanOrEqual(5); // top bar, hero, end of the day, bottom bar, prices + the two plan picks
  const plans = [];
  for (const a of regs) {
    const u = new URL(a.getAttribute("href"), window.location.origin);
    expect(u.origin).toBe(window.location.origin);
    expect(u.hash).toBe("");
    expect([...u.searchParams.keys()].filter((k) => k !== "plan")).toEqual([]);
    const all = u.searchParams.getAll("plan");
    expect(all.length).toBeLessThanOrEqual(1);
    if (all.length) { expect(["starter", "pro"]).toContain(all[0]); plans.push(all[0]); }
  }
  expect(plans.sort()).toEqual(["pro", "starter"]);
}

describe("(d) hostile ?plan, ?lang and #hash: nothing hostile renders", () => {
  for (const p of PAYLOADS) {
    for (const enc of [true, false]) {
      it(`${enc ? "encoded" : "raw"} ${JSON.stringify(p)} in ?plan, ?lang and the hash`, async () => {
        browser({ ua: IPHONE });
        const q = enc ? encodeURIComponent(p) : p;
        const entry = `/?plan=${q}&lang=${q}&ref=${q}#${q}`;
        try { window.history.replaceState(null, "", entry); } catch { window.history.replaceState(null, "", `/?plan=${encodeURIComponent(p)}&lang=${encodeURIComponent(p)}#${encodeURIComponent(p)}`); }
        localStorage.setItem("lang", "da");
        render(app(entry));
        await flush();
        tick(700);
        await flush();
        expect(lp6()).not.toBeNull();
        expect(["da", "en"]).toContain(lp6().getAttribute("lang"));
        expect(LANDING_TITLE_VALUES).toContain(document.title);
        assertNothingHostile();
        assertRegisterLinks();
        // a step and a language switch on the hostile URL change nothing of that
        fireEvent.click(document.querySelector("#dnext"));
        tick(500);
        fireEvent.click(lp6().querySelector(".top .lang button[lang='en']"));
        await flush();
        expect(lp6().getAttribute("lang")).toBe("en");
        assertNothingHostile();
        assertRegisterLinks();
      });
    }
  }

  it("a hostile stored language falls back to a real one: the page is Danish or English, <html lang> a plain code", async () => {
    browser({ ua: IPHONE });
    localStorage.setItem("lang", "<img src=x onerror=alert(1)>");
    render(app("/?lang=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"));
    await flush();
    tick(700);
    await flush();
    expect(["da", "en"]).toContain(lp6().getAttribute("lang"));
    expect(document.documentElement.lang).toMatch(/^[a-z]{2}$/);
    assertNothingHostile();
    assertRegisterLinks();
  });
});

/* ───────────────────────────── (e) ───────────────────────────── */
const SECURITY_KEYS = ["Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy", "Strict-Transport-Security"];
const REFERRER_STRICTNESS = ["unsafe-url", "no-referrer-when-downgrade", "origin-when-cross-origin", "origin", "strict-origin-when-cross-origin", "strict-origin", "same-origin", "no-referrer"];
const FETCH_DIRECTIVES = ["child-src", "connect-src", "font-src", "frame-src", "img-src", "manifest-src", "media-src", "object-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "worker-src"];

const parseCsp = (v) => Object.fromEntries(String(v).split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...src] = d.split(/\s+/); return [name.toLowerCase(), src]; }));
const parsePermissions = (v) => Object.fromEntries(String(v).split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [k, list] = s.split("="); return [k.trim(), (list || "").replace(/[()]/g, "").trim().split(/\s+/).filter(Boolean)]; }));
const parseHsts = (v) => { const s = String(v); return { maxAge: +(s.match(/max-age=(\d+)/i) || [0, -1])[1], sub: /includeSubDomains/i.test(s), preload: /preload/i.test(s) }; };
const headerOf = (rule, key) => (rule && rule.headers.find((h) => h.key.toLowerCase() === key.toLowerCase()) || {}).value;

/** Why `cur` is looser than `base` for one header (null = equal or stricter). */
function looser(key, base, cur) {
  if (base == null) return null;
  if (cur == null) return `${key} dropped`;
  if (key === "X-Content-Type-Options") return /^nosniff$/i.test(cur.trim()) ? null : `${key}: ${cur}`;
  if (key === "X-Frame-Options") {
    const rank = (v) => (/^deny$/i.test(v.trim()) ? 2 : /^sameorigin$/i.test(v.trim()) ? 1 : 0);
    return rank(cur) >= rank(base) ? null : `${key}: ${base} → ${cur}`;
  }
  if (key === "Referrer-Policy") {
    const rank = (v) => REFERRER_STRICTNESS.indexOf(v.split(",").pop().trim().toLowerCase());
    return rank(cur) >= rank(base) && rank(cur) >= 0 ? null : `${key}: ${base} → ${cur}`;
  }
  if (key === "Strict-Transport-Security") {
    const b = parseHsts(base), c = parseHsts(cur);
    if (c.maxAge < b.maxAge) return `${key}: max-age ${b.maxAge} → ${c.maxAge}`;
    if (b.sub && !c.sub) return `${key}: includeSubDomains dropped`;
    if (b.preload && !c.preload) return `${key}: preload dropped`;
    return null;
  }
  if (key === "Permissions-Policy") {
    const b = parsePermissions(base), c = parsePermissions(cur);
    const bad = Object.keys(b).filter((f) => !c[f] || c[f].some((o) => !b[f].includes(o)));
    return bad.length ? `${key}: loosened ${bad.join(", ")}` : null;
  }
  if (key === "Content-Security-Policy") {
    const b = parseCsp(base), c = parseCsp(cur);
    const bad = [];
    const strictest = (list) => list.length === 1 && list[0] === "'none'";
    for (const [d, bSrc] of Object.entries(b)) {
      const cSrc = c[d];
      if (!cSrc) { bad.push(`${d} dropped`); continue; }
      if (strictest(cSrc)) continue;
      const added = cSrc.filter((s) => !bSrc.includes(s));
      if (added.length) bad.push(`${d} + ${added.join(" ")}`);
    }
    // a fetch directive the baseline left to default-src may not allow more than default-src did
    for (const [d, cSrc] of Object.entries(c)) {
      if (b[d] || !FETCH_DIRECTIVES.includes(d) || strictest(cSrc)) continue;
      const added = cSrc.filter((s) => !(b["default-src"] || []).includes(s));
      if (added.length) bad.push(`${d} (new) + ${added.join(" ")}`);
    }
    return bad.length ? `${key}: ${bad.join("; ")}` : null;
  }
  return cur.trim() === base.trim() ? null : `${key}: ${base} → ${cur}`;
}

/** Every loosening of the live headers against the baseline's. */
function headerLoosenings(baseRules, curRules) {
  const bad = [];
  for (const b of baseRules) {
    if (!SECURITY_KEYS.some((k) => headerOf(b, k) != null)) continue;
    const c = curRules.find((r) => r.source === b.source);
    if (!c) { bad.push(`rule ${b.source} dropped`); continue; }
    for (const k of SECURITY_KEYS) { const why = looser(k, headerOf(b, k), headerOf(c, k)); if (why) bad.push(`${b.source} ${why}`); }
  }
  // a new rule (or a later one: the last matching rule wins per key) must not weaken what the site-wide rule sets
  const site = baseRules.find((r) => r.source === "/(.*)");
  for (const c of curRules) {
    if (baseRules.some((b) => b.source === c.source)) continue;
    for (const k of SECURITY_KEYS) { const v = headerOf(c, k); if (v != null) { const why = looser(k, headerOf(site, k), v); if (why) bad.push(`new rule ${c.source} ${why}`); } }
  }
  return bad;
}

describe("(e) vercel.json security headers: origin/main's or stricter", () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(SRC, "__tests__/fixtures/vercelHeaders.origin-main.json"), "utf8"));
  const live = JSON.parse(fs.readFileSync(path.join(FRONTEND, "vercel.json"), "utf8"));

  it("the baseline is origin/main's: the site-wide rule with all six security headers, the booking rule's CSP", () => {
    expect(baseline._about).toMatch(/origin\/main 5924fb4e/);
    const site = baseline.headers.find((r) => r.source === "/(.*)");
    for (const k of SECURITY_KEYS) expect([k, typeof headerOf(site, k)]).toEqual([k, "string"]);
    expect(parseCsp(headerOf(site, "Content-Security-Policy"))["frame-ancestors"]).toEqual(["'none'"]);
    expect(headerOf(baseline.headers.find((r) => r.source === "/r/(.*)"), "Content-Security-Policy")).toBeTruthy();
  });

  it("no security header is dropped or loosened, no CSP directive allows more", () => {
    expect(headerLoosenings(baseline.headers, live.headers)).toEqual([]);
  });

  it("the comparison catches a loosening (both ways)", () => {
    const loosen = (fn) => { const c = JSON.parse(JSON.stringify(live.headers)); fn(c.find((r) => r.source === "/(.*)").headers); return headerLoosenings(baseline.headers, c); };
    const set = (k, f) => (hs) => { const h = hs.find((x) => x.key === k); h.value = f(h.value); };
    expect(loosen(set("Content-Security-Policy", (v) => v.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")))).toHaveLength(1);
    expect(loosen(set("Content-Security-Policy", (v) => v.replace("connect-src 'self'", "connect-src 'self' https://evil.example")))).toHaveLength(1);
    expect(loosen(set("Content-Security-Policy", (v) => v.replace(" object-src 'none';", "")))).toHaveLength(1);
    expect(loosen(set("Content-Security-Policy", (v) => v.replace("frame-ancestors 'none'", "frame-ancestors https:")))).toHaveLength(1);
    expect(loosen(set("Content-Security-Policy", (v) => `${v}; script-src-elem *`))).toHaveLength(1);
    expect(loosen(set("X-Frame-Options", () => "SAMEORIGIN"))).toHaveLength(1);
    expect(loosen(set("Referrer-Policy", () => "unsafe-url"))).toHaveLength(1);
    expect(loosen(set("Strict-Transport-Security", () => "max-age=300"))).toHaveLength(1);
    expect(loosen(set("Permissions-Policy", (v) => v.replace("microphone=()", "microphone=(self)")))).toHaveLength(1);
    expect(loosen((hs) => hs.splice(hs.findIndex((x) => x.key === "X-Content-Type-Options"), 1))).toHaveLength(1);
    // stricter passes
    expect(loosen(set("Content-Security-Policy", (v) => v.replace(" https://bonbox-api.onrender.com", "")))).toEqual([]);
    expect(loosen(set("Referrer-Policy", () => "no-referrer"))).toEqual([]);
    expect(loosen(set("Permissions-Policy", (v) => v.replace("camera=(self)", "camera=()")))).toEqual([]);
    // a new rule may not undo the site-wide one
    const extra = JSON.parse(JSON.stringify(live.headers));
    extra.push({ source: "/(.*)\\.html", headers: [{ key: "Content-Security-Policy", value: "default-src *" }] });
    expect(headerLoosenings(baseline.headers, extra).length).toBeGreaterThan(0);
  });
});

/* ───────────────────────────── (f) ───────────────────────────── */
const ANALYTICS = /\/api\/analytics|event-log|\/events?\b|track|collect|telemetry|beacon|pixel|gtag|google-analytics|googletagmanager|posthog|plausible|segment|mixpanel|hotjar|clarity|sentry/i;

async function visitLanding() {
  browser({ ua: IPHONE });
  const r = render(app("/"));
  await flush();
  tick(700); // the banner opens
  await flush();
  expect(lp6()).not.toBeNull();
  // the reader moves through the day: scroll, Næste, a headline word, a FAQ answer, a language switch
  window.dispatchEvent(new Event("scroll"));
  fireEvent.click(document.querySelector("#dnext"));
  tick(500);
  fireEvent.click(lp6().querySelector("[data-go]"));
  tick(500);
  fireEvent.click(lp6().querySelector(".qa summary"));
  fireEvent.click(lp6().querySelector(".top .lang button[lang='en']"));
  await flush();
  tick(6000); // past the usage log's 5 s flush
  await flush();
  return r;
}

describe("(f) no analytics or usage request before consent", () => {
  it("first visit (no answer yet): nothing leaves — not the analytics module, the usage log, the api, fetch, XHR or a beacon", async () => {
    await visitLanding();
    expect(document.querySelector('[data-cookie-consent="banner"]')).not.toBeNull(); // still unanswered
    expect(NET.calls.filter((c) => c.via === "track" || ANALYTICS.test(c.url))).toEqual([]);
    expect(NET.calls).toEqual([]); // and today the landing sends nothing at all
  });

  it("after declining the optional cookies (an explicit no): still nothing", async () => {
    await visitLanding();
    const banner = document.querySelector('[data-cookie-consent="banner"]');
    const decline = [...banner.querySelectorAll("button")].find((b) => b.textContent === da.cookieDeclineNonEssential || b.textContent === en.cookieDeclineNonEssential);
    expect(decline).toBeTruthy();
    fireEvent.click(decline);
    fireEvent.click([...lp6().querySelectorAll("a")].find((a) => a.getAttribute("href") === "/login"));
    await flush();
    tick(6000);
    await flush();
    expect(NET.calls).toEqual([]);
  });

  it("the watch is not blind: after 'Accept all' the usage log's page view is seen leaving", async () => {
    await visitLanding();
    expect(NET.calls).toEqual([]);
    const banner = document.querySelector('[data-cookie-consent="banner"]');
    const accept = [...banner.querySelectorAll("button")].find((b) => b.textContent === da.cookieAcceptAll || b.textContent === en.cookieAcceptAll);
    expect(accept).toBeTruthy();
    fireEvent.click(accept);
    fireEvent.click([...lp6().querySelectorAll("a")].find((a) => a.getAttribute("href") === "/login"));
    await flush();
    tick(6000);
    await flush();
    expect(NET.calls.map((c) => [c.via, c.method, c.url])).toEqual([["api", "post", "/event-log/batch"]]);
  });
});
