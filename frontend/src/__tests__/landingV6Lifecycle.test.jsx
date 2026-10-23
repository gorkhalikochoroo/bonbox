/**
 * LANDING V6 — the page and its engine inside the app (PORT_PLAN 5.1 "landingV6Lifecycle", port step 10).
 *
 * landingV6Engine.test.jsx holds engine.js to the plan on a fixture DOM (zero listeners, timers, frames and observers
 * after destroy; the DOM restored). This file runs the REAL page (LandingV6Page with the real markup, the real
 * LanguageProvider, router and cookie banner) on the REAL engine, and pins how they meet:
 *   (a) StrictMode: the engine mounts twice and is destroyed once; the second mount starts from the pristine DOM;
 *       after unmount nothing the engine added is left (listeners on window / document / matchMedia / the page,
 *       observers, window.__lp6) and the root's DOM is exactly what React rendered;
 *   (b) a router link (Log ind) leaves the page: the engine is destroyed, the next page renders;
 *   (c) PublicOrDashboard keeping the one landing while /auth/me answers is pinned in landingPush9Speed.test.jsx
 *       ("keeps the one landing"), not repeated here;
 *   (d) a re-render through the language context (the provider re-rendering, a new value object) writes nothing to
 *       the DOM the engine has laid out;
 *   (e) DK → EN through the page's own switch re-keys the page: the old engine is destroyed, one new engine mounts on
 *       the English page, the tab title and <html lang> follow (Danish / English; a Turkish reader: the English page
 *       and its English headline in the tab, the Turkish app title once the page is left); and (fix round) the reader keeps their place: the switch keeps the focus (top bar or
 *       footer), open FAQ answers stay open, the sheet section on screen stays where it was;
 *   (f) with the cookie banner: no id appears twice in the document, and the open banner sits on the bottom bar
 *       (data-bb-consent-clear), never over its "Prøv gratis"; on the wide layouts it floats bottom-right (fix round);
 *   (g) "← Forrige": hidden at 1 / 7, shown from 2 / 7 to 7 / 7 on both steppers (the frame's and the bottom bar's),
 *       walked 1 → 7 → 1 with real clicks.
 *   (i) Simulator round (iOS Safari, 23 Oct): after a DK / EN switch the first tap on the bottom bar acts ("Prøv gratis",
 *       "Næste", "←"); a switch that was tapped (iOS Safari never focuses a tapped button) leaves no focus behind, one that
 *       had the focus gets it back; the re-keyed page's engine settles its first layout (engine.js note 22), a first load not.
 * Hardening round (23 Oct): window.__lp6 exists only in a dev build or with ?lp6debug in the address (engine.js note 9);
 * this file runs as a production build (import.meta.env.DEV stubbed false) and opts in through the address.
 * jsdom has no layout, so the geometry is the engine's own fall-backs; the maths is held to the prototype in a real
 * browser by the lab's port-build/tools scripts. Listeners and observers are attributed to the engine by the stack
 * that created them (engine.js), so the provider's and the banner's own listeners never blur the count.
 */
import { StrictMode, useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { LANDING_TITLES, SHELL_TITLES } from "../lib/shellTitles";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { tr } from "../i18n/tr.js";
import { primeLocales } from "../lib/localeStore";
import { NAVF, beatU } from "../components/landing/v6/nav";

// the real engine, counted: every mount, every destroy, the DOM each mount started from and each destroy left
const eng = vi.hoisted(() => ({ mounts: [], destroys: [] }));
vi.mock("../components/landing/v6/engine", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mountLanding: (root, opts) => {
      eng.mounts.push({ root, html: root.outerHTML, opts });
      const destroy = actual.mountLanding(root, opts);
      return () => { destroy(); eng.destroys.push({ root, html: root.outerHTML }); };
    },
  };
});
// no beacon from a test (a failed mount would show as an onError call below anyway)
const beacon = vi.hoisted(() => vi.fn());
vi.mock("../utils/reportClientError", () => ({ reportClientError: (o) => beacon(o) }));

const { default: LandingV6Page } = await import("../pages/LandingV6Page");
const { default: CookieConsent } = await import("../components/CookieConsent");

const ENGINE = /landing[\\/]v6[\\/]engine\.js/;
const byEngine = () => {
  const lim = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const s = new Error().stack || "";
  Error.stackTraceLimit = lim;
  return ENGINE.test(s);
};

/* ── the browser around the page: viewport, scroll, matchMedia, observers; what the engine adds is tracked ── */
let env;
function setup({ w = 390, h = 844 } = {}) {
  // jsdom's selector engines add their own document listeners on first use: let them, before tracking
  document.querySelector("*:hover"); document.documentElement.matches("*"); void getComputedStyle(document.documentElement).display;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  const keys = [];
  const live = new Set();
  const keyOf = (t, type, fn, o) => {
    const k = [t, type, fn, typeof o === "boolean" ? o : !!(o && o.capture)];
    return keys.find((x) => x.every((v, i) => v === k[i])) || (keys.push(k), k);
  };
  // two doors: EventTarget.prototype (document, elements, matchMedia lists) and the window's own pair (in vitest's
  // jsdom the global window carries its own addEventListener, not the prototype's)
  for (const [target, self] of [[EventTarget.prototype, null], [window, window]]) {
    const add = target.addEventListener, rem = target.removeEventListener;
    vi.spyOn(target, "addEventListener").mockImplementation(function (type, fn, o) {
      if (byEngine()) live.add(keyOf(self || this, type, fn, o));
      return add.call(this, type, fn, o);
    });
    vi.spyOn(target, "removeEventListener").mockImplementation(function (type, fn, o) {
      live.delete(keyOf(self || this, type, fn, o));
      return rem.call(this, type, fn, o);
    });
  }
  const answer = (q) => {
    if (q.includes("prefers-reduced-motion")) return false;
    if (q.includes("min-aspect-ratio")) return w >= 1024 && w / h >= 1.25;
    let ok = true;
    for (const m of q.matchAll(/\((min|max)-(width|height):\s*(\d+)px\)/g)) { const v = m[2] === "width" ? w : h; ok = ok && (m[1] === "min" ? v >= +m[3] : v <= +m[3]); }
    return ok;
  };
  const mqls = [];
  window.matchMedia = vi.fn((q) => { const l = new EventTarget(); l.matches = answer(q); l.media = q; l.addListener = () => {}; l.removeListener = () => {}; mqls.push(l); return l; });
  const obs = [];
  class FakeObserver {
    constructor(cb) { this.cb = cb; this.targets = new Set(); this.live = true; this.engine = byEngine(); obs.push(this); }
    observe(t) { this.targets.add(t); } unobserve(t) { this.targets.delete(t); } disconnect() { this.targets.clear(); this.live = false; }
  }
  window.ResizeObserver = FakeObserver;
  window.IntersectionObserver = FakeObserver;
  let Y = 0;
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
  Object.defineProperty(window, "scrollY", { get: () => Y, configurable: true });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: 100000, configurable: true });
  window.scrollTo = vi.fn((a, b) => { Y = typeof a === "object" ? a.top : b; });
  document.title = LANDING_TITLES.da; // index.html's <title>
  env = {
    live, obs, mqls,
    setY: (y) => { Y = y; },
    getY: () => Y,
    engineListeners: () => live.size,
    engineObservers: () => obs.filter((o) => o.engine && o.live && o.targets.size).length,
  };
  return env;
}

function teardown() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.matchMedia; delete window.ResizeObserver; delete window.IntersectionObserver;
  env = null;
}

beforeEach(() => {
  eng.mounts.length = 0; eng.destroys.length = 0; beacon.mockClear();
  delete window.__lp6;
  vi.stubEnv("DEV", false);
  window.history.replaceState(null, "", "/?lp6debug"); // the debug handle, opted in (engine.js note 9)
  localStorage.setItem("lang", "da");
});
afterEach(() => { cleanup(); teardown(); vi.unstubAllEnvs(); window.history.replaceState(null, "", "/"); localStorage.clear(); document.documentElement.lang = "da"; });

const page = (extra = null) => (
  <MemoryRouter initialEntries={["/"]}>
    <LanguageProvider>
      <Routes>
        <Route path="/" element={<LandingV6Page />} />
        <Route path="/login" element={<p data-testid="login-page">login</p>} />
        <Route path="/register" element={<p data-testid="register-page">register</p>} />
      </Routes>
      {extra}
    </LanguageProvider>
  </MemoryRouter>
);
const lp6 = () => document.querySelector(".lp6");
const flush = () => act(async () => { await Promise.resolve(); });

describe("(a) StrictMode: mount, destroy, mount; unmount leaves nothing", () => {
  it("the engine mounts twice and is destroyed once; the second mount starts from the DOM React rendered", async () => {
    const e = setup();
    const { unmount } = render(<StrictMode>{page()}</StrictMode>);
    await flush();
    expect(eng.mounts).toHaveLength(2);
    expect(eng.destroys).toHaveLength(1);
    const root = lp6();
    expect(eng.mounts[0].root).toBe(root);
    expect(eng.mounts[1].root).toBe(root);
    expect(eng.mounts[1].html).toBe(eng.mounts[0].html); // pristine: the first destroy put everything back
    expect(eng.destroys[0].html).toBe(eng.mounts[0].html);
    // the second mount is live: the story page on a 390 x 844 phone, its listeners and observers attached
    expect(root.classList.contains("story")).toBe(true);
    expect(e.engineListeners()).toBeGreaterThan(0);
    expect(e.engineObservers()).toBeGreaterThan(0);
    expect(window.__lp6).toBeTruthy();
    unmount();
    expect(eng.destroys).toHaveLength(2);
    expect(e.engineListeners()).toBe(0);
    expect(e.engineObservers()).toBe(0);
    expect(window.__lp6).toBeUndefined();
    expect(eng.destroys[1].html).toBe(eng.mounts[0].html);
    expect(beacon).not.toHaveBeenCalled();
  });

  it("the listeners the engine leaves after a scroll and a step are all removed too (window, document, matchMedia, the page)", async () => {
    const e = setup();
    const { unmount } = render(<StrictMode>{page()}</StrictMode>);
    await flush();
    const targets = () => new Set([...e.live].map(([t]) => (t === window ? "window" : t === document ? "document" : e.mqls.includes(t) ? "matchMedia" : lp6()?.contains(t) ? "page" : "other")));
    expect([...targets()].sort()).toEqual(["document", "matchMedia", "page", "window"]);
    e.setY(1800); window.dispatchEvent(new Event("scroll"));
    act(() => { vi.advanceTimersByTime(50); });
    fireEvent.click(document.querySelector("#dnext"));
    act(() => { vi.advanceTimersByTime(400); });
    unmount();
    expect(e.engineListeners()).toBe(0);
    expect(e.engineObservers()).toBe(0);
  });
});

describe("(b) a router link leaves the page", () => {
  it("Log ind: the landing unmounts, the engine is destroyed and leaves nothing, /login renders", async () => {
    const e = setup();
    const { getByTestId } = render(page());
    await flush();
    expect(eng.mounts).toHaveLength(1);
    const login = [...lp6().querySelectorAll("a")].find((a) => a.getAttribute("href") === "/login");
    expect(login.textContent).toBe(da["landingV6.nav.login"]);
    fireEvent.click(login);
    await flush();
    expect(getByTestId("login-page")).toBeTruthy();
    expect(lp6()).toBeNull();
    expect(eng.destroys).toHaveLength(1);
    expect(e.engineListeners()).toBe(0);
    expect(e.engineObservers()).toBe(0);
    expect(window.__lp6).toBeUndefined();
  });

  it("Prøv gratis in the bottom bar: the same, to /register", async () => {
    const e = setup();
    const { getByTestId } = render(page());
    await flush();
    fireEvent.click(document.querySelector("#dock a[href='/register']"));
    await flush();
    expect(getByTestId("register-page")).toBeTruthy();
    expect(eng.destroys).toHaveLength(1);
    expect(e.engineListeners()).toBe(0);
  });
});

describe("(d) a re-render through the language context writes nothing to the laid-out page", () => {
  it("the provider re-renders (a new context value): zero DOM mutations in the page, one engine", async () => {
    setup();
    let bump = null;
    function Harness() {
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return page(<span data-n={n} />);
    }
    render(<Harness />);
    await flush();
    const root = lp6();
    // the engine has laid the page out: mode classes on the root, the counter, the stepper state
    expect(root.className).toContain("story");
    const mo = new MutationObserver(() => {});
    mo.observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
    act(() => { bump(); });
    act(() => { bump(); });
    const records = mo.takeRecords();
    mo.disconnect();
    expect(document.querySelector("[data-n]").getAttribute("data-n")).toBe("2"); // the re-render happened
    expect(records).toEqual([]);
    expect(lp6()).toBe(root);
    expect(eng.mounts).toHaveLength(1);
    expect(eng.destroys).toHaveLength(0);
  });
});

describe("(e) DK → EN through the page's own switch", () => {
  it("re-keys: the Danish engine is destroyed, one English engine mounts; title and <html lang> follow; and back", async () => {
    const e = setup();
    render(page());
    await flush();
    const daRoot = lp6();
    const perMount = e.engineListeners();
    expect(document.title).toBe(LANDING_TITLES.da);
    expect(document.documentElement.lang).toBe("da");
    expect(daRoot.querySelector("h1").textContent).toContain(da["landingV6.h1.shifts"]);
    // the landing's title is its headline, in each language (security fix round: the landing's own, no longer the app's)
    expect(LANDING_TITLES.da).toBe(`BonBox · ${da["landingV6.h1.shifts"]} ${da["landingV6.h1.tables"]} ${da["landingV6.h1.till"]}`);
    expect(LANDING_TITLES.en).toBe(`BonBox · ${en["landingV6.h1.shifts"]} ${en["landingV6.h1.tables"]} ${en["landingV6.h1.till"]}`);

    fireEvent.click(daRoot.querySelector(".lang button[lang='en']"));
    await flush();
    const enRoot = lp6();
    expect(enRoot).not.toBe(daRoot);
    expect(daRoot.isConnected).toBe(false);
    expect(enRoot.getAttribute("lang")).toBe("en");
    expect(enRoot.querySelector("h1").textContent).toContain(en["landingV6.h1.shifts"]);
    expect(eng.mounts).toHaveLength(2);
    expect(eng.destroys).toHaveLength(1);
    expect(eng.destroys[0].root).toBe(daRoot);
    expect(eng.mounts[1].root).toBe(enRoot);
    expect(e.engineListeners()).toBe(perMount); // the Danish engine's are gone, the English one's are there
    expect(document.title).toBe(LANDING_TITLES.en);
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("lang")).toBe("en");

    fireEvent.click(enRoot.querySelector(".lang button[lang='da']"));
    await flush();
    expect(lp6().getAttribute("lang")).toBe("da");
    expect(eng.mounts).toHaveLength(3);
    expect(eng.destroys).toHaveLength(2);
    expect(e.engineListeners()).toBe(perMount);
    expect(document.title).toBe(LANDING_TITLES.da);
    expect(document.documentElement.lang).toBe("da");
  });

  it("a Turkish reader: the English page (no Turkish landing yet) with its English headline in the tab; the app's Turkish title once the page is left", async () => {
    setup();
    primeLocales({ tr }); // the app loads the Turkish pack on demand; here it is in, as da / en are (test/setup.js)
    localStorage.setItem("lang", "tr");
    const { getByTestId } = render(page());
    await flush();
    expect(lp6().getAttribute("lang")).toBe("en");
    expect(lp6().querySelector("h1").textContent).toContain(en["landingV6.h1.shifts"]);
    expect(document.documentElement.lang).toBe("tr");
    // security fix round (23 Oct): the landing names itself in the page's own language (it was the app's Turkish title
    // while the two shared one title)
    expect(document.title).toBe(LANDING_TITLES.en);
    // the app's default title is every signed-in app page's tab title, and the app is Turkish for a Turkish owner
    expect(SHELL_TITLES.tr).toBe("BonBox — İşletmenin gerçekten üzerinde döndüğü arka ofis");
    expect(SHELL_TITLES.tr).not.toBe(SHELL_TITLES.en);
    fireEvent.click([...lp6().querySelectorAll("a")].find((a) => a.getAttribute("href") === "/login"));
    await flush();
    expect(getByTestId("login-page")).toBeTruthy();
    expect(document.title).toBe(SHELL_TITLES.tr);
  });

  /* fix round: the reader's place across the switch (components/landing/v6/place.js). jsdom has no layout: the sheet's
     sections get their rects from here, Danish and English text differing in height (#faq 70 px from the top in Danish,
     145 px in English, as measured at 1280 x 800 in the gate) */
  const sheetRects = (where) => {
    const real = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
      const r = (top, h) => ({ top, bottom: top + h, height: h, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} });
      const lang = this.closest && this.closest(".lp6") && this.closest(".lp6").getAttribute("lang");
      if (where === "sheet") {
        if (["mere", "pricing", "tryghed"].includes(this.id)) return r(-900, 300);
        if (this.id === "faq") return lang === "en" ? r(145, 400) : r(70, 400);
      } else if (["mere", "pricing", "tryghed", "faq", "foot"].includes(this.id)) return r(1200, 300); // still in the day
      return real.call(this);
    });
  };

  it("keyboard on the top bar's switch, in the sheet with FAQ answer 2 open: focus stays on the switch, the answer stays open, #faq stays put", async () => {
    const e = setup();
    sheetRects("sheet");
    render(page());
    await flush();
    const daRoot = lp6();
    daRoot.querySelectorAll("details")[1].open = true;
    e.setY(6265);
    const sw = daRoot.querySelector(".top .lang button[lang='en']");
    sw.focus();
    expect(document.activeElement).toBe(sw);
    fireEvent.click(sw);
    await flush();
    const enRoot = lp6();
    expect(enRoot.getAttribute("lang")).toBe("en");
    // the focus is on the new page's switch, on the flag that was pressed (now the page's language), not on <body> (WCAG 2.4.3)
    expect(document.activeElement).toBe(enRoot.querySelector(".top .lang button[lang='en']"));
    expect(document.activeElement.getAttribute("aria-pressed")).toBe("true");
    expect([...enRoot.querySelectorAll("details")].map((d) => d.open)).toEqual([false, true, false]);
    // #faq was 70 px from the top; the English sheet puts it at 145: the page moves by 75 so it is at 70 again
    expect(e.getY()).toBe(6265 + 75);
  });

  it("the footer's switch keeps the focus in the footer; in the day nothing scrolls (the engine keeps the place)", async () => {
    const e = setup();
    sheetRects("day");
    render(page());
    await flush();
    e.setY(1800);
    const sw = lp6().querySelector(".foot .lang button[lang='en']");
    sw.focus();
    fireEvent.click(sw);
    await flush();
    const enRoot = lp6();
    expect(enRoot.getAttribute("lang")).toBe("en");
    expect(document.activeElement).toBe(enRoot.querySelector(".foot .lang button[lang='en']"));
    expect(e.getY()).toBe(1800);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});

describe("(f) with the cookie banner", () => {
  const rect = (top, height, width = 390) => () => ({ top, height, width, bottom: top + height, left: 0, right: width, x: 0, y: top, toJSON() {} });

  it("no id appears twice in the document (the page's ids and the app's never meet)", async () => {
    setup();
    render(page(<CookieConsent />));
    await flush();
    act(() => { vi.advanceTimersByTime(700); });
    expect(document.querySelector('[data-cookie-consent="banner"]')).not.toBeNull();
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
    expect(ids.length).toBeGreaterThan(50);
  });

  it("the open banner sits on the bottom bar, never over its Prøv gratis; with the bar hidden (two-column page) it takes the edge", async () => {
    setup();
    render(page(<CookieConsent />));
    await flush();
    const dock = document.querySelector("#dock");
    expect(dock.hasAttribute("data-bb-consent-clear")).toBe(true);
    expect(dock.querySelector("a[href='/register']").textContent).toBe(da["landingV6.cta"]);
    dock.getBoundingClientRect = rect(window.innerHeight - 64, 64);
    act(() => { vi.advanceTimersByTime(700); });
    const banner = document.querySelector('[data-cookie-consent="banner"]');
    expect(banner.style.bottom).toBe("64px");
    cleanup();
    teardown();
    setup();
    render(page(<CookieConsent />));
    await flush();
    document.querySelector("#dock").getBoundingClientRect = rect(window.innerHeight, 0, 0); // display:none at ≥ 1024 wide
    act(() => { vi.advanceTimersByTime(700); });
    expect(document.querySelector('[data-cookie-consent="banner"]').style.bottom).toBe("0px");
  });
});

describe("(f) fix round: on the wide layouts the banner floats bottom-right on the landing only", () => {
  it("1440 x 900: the card takes the right corner (the hero's trial line and button sit bottom-left); /login keeps the left", async () => {
    setup({ w: 1440, h: 900 });
    render(page(<CookieConsent />));
    await flush();
    act(() => { vi.advanceTimersByTime(700); });
    let banner = document.querySelector('[data-cookie-consent="banner"]');
    expect(banner.className).toMatch(/(^|\s)md:right-6(\s|$)/);
    expect(banner.className).not.toMatch(/md:left-6/);
    expect(banner.style.bottom).toBe("24px");
    fireEvent.click([...lp6().querySelectorAll("a")].find((a) => a.getAttribute("href") === "/login"));
    await flush();
    act(() => { vi.advanceTimersByTime(50); });
    banner = document.querySelector('[data-cookie-consent="banner"]');
    expect(document.querySelector(".lp6")).toBeNull();
    expect(banner.className).toMatch(/(^|\s)md:left-6(\s|$)/);
    expect(banner.className).not.toMatch(/md:right-6/);
  });

  it("a phone keeps the full-width sheet on the bar (the side marker changes nothing under 768 px)", async () => {
    setup();
    render(page(<CookieConsent />));
    await flush();
    act(() => { vi.advanceTimersByTime(700); });
    const banner = document.querySelector('[data-cookie-consent="banner"]');
    expect(banner.className).toMatch(/inset-x-0/);
    expect(banner.className).toMatch(/md:left-6/); // the md: classes do not apply under 768 px; the default stays as before
  });
});

describe("(g) ← Forrige: hidden at 1 / 7, shown from 2 / 7 to 7 / 7", () => {
  it("Næste 1 → 7 then Forrige 7 → 1 with real clicks on the bottom bar: the counter and both back buttons follow", async () => {
    const e = setup();
    render(page());
    await flush();
    const $ = (s) => document.querySelector(s);
    const state = () => ({ count: $("#dcount").textContent, frameCount: $("#count").textContent, prevHidden: $("#prev").hidden, dprevOff: $("#dprev").classList.contains("off") });
    const settle = () => { window.dispatchEvent(new Event("scroll")); act(() => { vi.advanceTimersByTime(700); }); };
    // before the stage pins (top of the page): the counter reads 1 / 7, no way back
    settle();
    expect(state()).toEqual({ count: "1 / 7", frameCount: "1 / 7", prevHidden: true, dprevOff: true });
    const seen = [];
    for (let n = 0; n < 6; n++) { fireEvent.click($("#dnext")); settle(); seen.push(state()); }
    expect(seen.map((s) => s.count)).toEqual(["2 / 7", "3 / 7", "4 / 7", "5 / 7", "6 / 7", "7 / 7"]);
    for (const s of seen) expect(s).toMatchObject({ prevHidden: false, dprevOff: false });
    expect(seen.every((s) => s.frameCount === s.count)).toBe(true);
    const back = [];
    for (let n = 0; n < 6; n++) { fireEvent.click($("#dprev")); settle(); back.push(state()); }
    expect(back.map((s) => s.count)).toEqual(["6 / 7", "5 / 7", "4 / 7", "3 / 7", "2 / 7", "1 / 7"]);
    expect(back.slice(0, 5).every((s) => !s.prevHidden && !s.dprevOff)).toBe(true);
    expect(back[5]).toMatchObject({ prevHidden: true, dprevOff: true });
    // at 1 / 7 Forrige has nowhere to go: a click does not move the page
    const y = e.getY();
    fireEvent.click($("#dprev")); settle();
    expect(e.getY()).toBe(y);
    expect(state().count).toBe("1 / 7");
  });
});

/* (h) security fix round (23 Oct; step_13 open item 9): the landing and the app each keep their own tab title. The port
 * had made the landing's headline the app's default title too, so every signed-in page that does not name itself (the
 * dashboard and the other Layout pages) read "BonBox · Vagterne. Bordene. Kassen.". The app's default is origin/main's
 * line again; the landing sets its headline while it is on screen; index.html still ships the Danish headline (what
 * crawlers read for "/"), and the language provider swaps it for the app's on any page the landing is not on. */
describe("(h) tab titles: the landing's own headline, the app's default title everywhere else", () => {
  // origin/main's lib/shellTitles.js and index.html <title>, word for word
  const MAIN = {
    da: "BonBox — Bagkontoret din virksomhed faktisk kører på",
    en: "BonBox — The back office your business actually runs on",
  };
  const routes = (path) => (
    <MemoryRouter initialEntries={[path]}>
      <LanguageProvider>
        <Routes>
          <Route path="/" element={<LandingV6Page />} />
          <Route path="/dashboard" element={<p data-testid="dashboard">dashboard</p>} />
          <Route path="/login" element={<p data-testid="login-page">login</p>} />
        </Routes>
      </LanguageProvider>
    </MemoryRouter>
  );

  it("the app's default title is origin/main's again (da, en) and differs from the landing's headline", () => {
    expect(SHELL_TITLES.da).toBe(MAIN.da);
    expect(SHELL_TITLES.en).toBe(MAIN.en);
    for (const l of ["da", "en"]) expect(SHELL_TITLES[l]).not.toBe(LANDING_TITLES[l]);
  });

  for (const l of ["da", "en"]) {
    it(`${l}: an app page opened cold (index.html's landing title in the tab) gets the app's default title, not the headline`, async () => {
      setup();
      localStorage.setItem("lang", l);
      document.title = LANDING_TITLES.da; // index.html's static <title>
      const { getByTestId } = render(routes("/dashboard"));
      await flush();
      expect(getByTestId("dashboard")).toBeTruthy();
      expect(lp6()).toBeNull();
      expect(document.title).toBe(MAIN[l]);
    });

    it(`${l}: the landing shows its headline; leaving it for an app page without a title of its own hands back the app's title`, async () => {
      setup();
      localStorage.setItem("lang", l);
      document.title = LANDING_TITLES.da;
      const { getByTestId } = render(routes("/"));
      await flush();
      expect(lp6()).not.toBeNull();
      expect(document.title).toBe(LANDING_TITLES[l]);
      fireEvent.click([...lp6().querySelectorAll("a")].find((a) => a.getAttribute("href") === "/login"));
      await flush();
      expect(getByTestId("login-page")).toBeTruthy();
      expect(document.title).toBe(MAIN[l]);
    });
  }

  it("a DK → EN switch on the landing keeps the landing's headline (the provider leaves a held title alone); a page's own title is never stomped", async () => {
    setup();
    render(routes("/"));
    await flush();
    expect(document.title).toBe(LANDING_TITLES.da);
    fireEvent.click(lp6().querySelector(".lang button[lang='en']"));
    await flush();
    expect(document.title).toBe(LANDING_TITLES.en);
    cleanup();
    // a page that names itself keeps its name through a language change
    document.title = "Book bord · Bistro";
    localStorage.setItem("lang", "en");
    render(routes("/dashboard"));
    await flush();
    expect(document.title).toBe("Book bord · Bistro");
  });
});

/* ───────────────────────────── (i) ───────────────────────────── */
describe("(i) after a DK / EN switch the first tap on the bottom bar acts", () => {
  const FRAME = 32;
  /** The page y of a scene's resting point, from the engine's own geometry (window.__lp6, opted in with ?lp6debug). */
  const sceneY = (go) => { const g = window.__lp6.geo(); return Math.max(0, Math.round(g.pin + (beatU({ SEG: g.SEG, ACC: g.ACC }, go, NAVF[go]) * g.svh) / 100)); };
  const scrolled = () => act(() => { window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME); });
  /** The Danish page at 4 / 7, then a TAP on the top bar's switch: in iOS Safari a tapped button never takes the focus, so
   *  nothing on the page has it (document.body) as the click runs. */
  async function switchedAt4(e) {
    // no layout in jsdom, but a consistent page: every box sits at the document's top and moves up as the page scrolls (as in
    // a browser), so the re-keyed engine measures the same stage, not one that starts where the reader is
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: -window.scrollY, top: -window.scrollY, bottom: -window.scrollY, left: 0, right: 0, width: 0, height: 0 }));
    const r = render(page());
    await flush();
    act(() => { vi.advanceTimersByTime(1000); });
    e.setY(sceneY("S")); await scrolled();
    expect(lp6().querySelector("#dcount").textContent).toBe("4 / 7");
    const sw = lp6().querySelector(".top .lang button[lang='en']");
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(sw);
    await flush();
    expect(lp6().getAttribute("lang")).toBe("en");
    act(() => { vi.advanceTimersByTime(1000); });
    await scrolled();
    expect(lp6().querySelector("#dcount").textContent).toBe("4 / 7"); // the engine kept the place
    return r;
  }

  it("a tapped switch leaves no focus behind (as on a page that was never switched); the bar's \"Try free\" goes to /register on the first tap", async () => {
    const e = setup();
    const { getByTestId } = await switchedAt4(e);
    expect(document.activeElement).toBe(document.body);
    const cta = lp6().querySelector("#dock a[href='/register']");
    expect(cta.textContent).toBe(en["landingV6.cta"]);
    fireEvent.click(cta);
    await flush();
    expect(getByTestId("register-page")).toBeTruthy();
  });

  it("\"Next\" acts on the first tap: 4 / 7 → 5 / 7", async () => {
    const e = setup();
    await switchedAt4(e);
    window.scrollTo.mockClear();
    fireEvent.click(lp6().querySelector("#dnext"));
    expect(window.scrollTo.mock.calls).toEqual([[{ top: sceneY("2b"), behavior: "instant" }]]);
    await scrolled();
    expect(lp6().querySelector("#dcount").textContent).toBe("5 / 7");
  });

  it("\"←\" acts on the first tap: 4 / 7 → 3 / 7", async () => {
    const e = setup();
    await switchedAt4(e);
    window.scrollTo.mockClear();
    fireEvent.click(lp6().querySelector("#dprev"));
    expect(window.scrollTo.mock.calls).toEqual([[{ top: sceneY("1b"), behavior: "instant" }]]);
    await scrolled();
    expect(lp6().querySelector("#dcount").textContent).toBe("3 / 7");
  });

  it("a switch that had the focus (keyboard, assistive tech, a browser that focuses a clicked button) gets it back; the footer's too", async () => {
    for (const where of [".top", ".foot"]) {
      localStorage.setItem("lang", "da");
      setup();
      const { unmount } = render(page());
      await flush();
      const sw = lp6().querySelector(`${where} .lang button[lang='en']`);
      sw.focus();
      fireEvent.click(sw);
      await flush();
      // flags round (23 Oct): both flags are buttons, so the focus comes back on the one that was pressed, now aria-pressed
      expect([where, document.activeElement]).toEqual([where, lp6().querySelector(`${where} .lang button[lang='en'][aria-pressed='true']`)]);
      unmount(); teardown();
    }
  });

  it("the re-keyed page's engine settles its first layout (nothing replays); a first load keeps its entrance", async () => {
    const e = setup();
    await switchedAt4(e);
    expect(eng.mounts.map((m) => !!(m.opts && m.opts.settle))).toEqual([false, true]);
  });
});
