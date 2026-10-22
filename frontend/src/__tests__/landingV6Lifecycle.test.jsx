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
 *       the English page, the tab title and <html lang> follow (Danish / English / a Turkish reader's English);
 *   (f) with the cookie banner: no id appears twice in the document, and the open banner sits on the bottom bar
 *       (data-bb-consent-clear), never over its "Prøv gratis";
 *   (g) "← Forrige": hidden at 1 / 7, shown from 2 / 7 to 7 / 7 on both steppers (the frame's and the bottom bar's),
 *       walked 1 → 7 → 1 with real clicks.
 * jsdom has no layout, so the geometry is the engine's own fall-backs; the maths is held to the prototype in a real
 * browser by the lab's port-build/tools scripts. Listeners and observers are attributed to the engine by the stack
 * that created them (engine.js), so the provider's and the banner's own listeners never blur the count.
 */
import { StrictMode, useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { SHELL_TITLES } from "../lib/shellTitles";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { tr } from "../i18n/tr.js";
import { primeLocales } from "../lib/localeStore";

// the real engine, counted: every mount, every destroy, the DOM each mount started from and each destroy left
const eng = vi.hoisted(() => ({ mounts: [], destroys: [] }));
vi.mock("../components/landing/v6/engine", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mountLanding: (root, opts) => {
      eng.mounts.push({ root, html: root.outerHTML });
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
  document.title = SHELL_TITLES.da; // index.html's <title>
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
  localStorage.setItem("lang", "da");
});
afterEach(() => { cleanup(); teardown(); localStorage.clear(); document.documentElement.lang = "da"; });

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
    expect(document.title).toBe(SHELL_TITLES.da);
    expect(document.documentElement.lang).toBe("da");
    expect(daRoot.querySelector("h1").textContent).toContain(da["landingV6.h1.shifts"]);
    // the title is the headline, in each language
    expect(SHELL_TITLES.da).toBe(`BonBox · ${da["landingV6.h1.shifts"]} ${da["landingV6.h1.tables"]} ${da["landingV6.h1.till"]}`);
    expect(SHELL_TITLES.en).toBe(`BonBox · ${en["landingV6.h1.shifts"]} ${en["landingV6.h1.tables"]} ${en["landingV6.h1.till"]}`);

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
    expect(document.title).toBe(SHELL_TITLES.en);
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("lang")).toBe("en");

    fireEvent.click(enRoot.querySelector(".lang button[lang='da']"));
    await flush();
    expect(lp6().getAttribute("lang")).toBe("da");
    expect(eng.mounts).toHaveLength(3);
    expect(eng.destroys).toHaveLength(2);
    expect(e.engineListeners()).toBe(perMount);
    expect(document.title).toBe(SHELL_TITLES.da);
    expect(document.documentElement.lang).toBe("da");
  });

  it("a Turkish reader: the English page, the English tab title (no Turkish landing yet)", async () => {
    setup();
    primeLocales({ tr }); // the app loads the Turkish pack on demand; here it is in, as da / en are (test/setup.js)
    localStorage.setItem("lang", "tr");
    render(page());
    await flush();
    expect(lp6().getAttribute("lang")).toBe("en");
    expect(lp6().querySelector("h1").textContent).toContain(en["landingV6.h1.shifts"]);
    expect(document.documentElement.lang).toBe("tr");
    expect(document.title).toBe(SHELL_TITLES.tr);
    expect(SHELL_TITLES.tr).toBe(SHELL_TITLES.en);
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
