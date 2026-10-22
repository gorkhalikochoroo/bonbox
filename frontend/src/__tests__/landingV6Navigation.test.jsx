/**
 * LANDING V6 — moving around the page by its links and its address (hardening round, 23 Oct 2026). Permanent: each
 * block was proven by a deliberate break that turned it red (the release notes list the breaks).
 *
 *   (a) a plain click on a headline word (hero) or an index link jumps to its scene, and the address bar then names that
 *       scene (#s1, #s2, #s6; nav.js SCENE_HASH) — written over the current history entry with the router's state kept, the
 *       query untouched, never pushed — so it never shows a stale #pricing; a merged tap (iOS double tap) changes nothing;
 *   (b) a click with a modifier key (Cmd, Ctrl, Shift, Alt) or another mouse button is the browser's own (a new tab or
 *       window): not prevented, no jump, the address untouched, and it does not use up the stepper's tap gate;
 *   (c) arrival: a cold load of /#s1, /#s2 or /#s6 opens on that scene (phone, tablet, desktop); any other fragment
 *       (the other scene ids, #pricing, near misses, encodings, hostile text) opens at the top; the stacked page leaves
 *       it to the browser; StrictMode jumps once; a language switch never sends the reader back to the arrival scene;
 *   (d) App.jsx's ScrollManager leaves a fragment inside the pinned day (data-bb-own-anchors, written by the engine) to
 *       the engine and scrolls every other one as before (#pricing on the landing, the stacked page's scenes, any page).
 * jsdom has no layout: the geometry is the engine's own fall-backs (pin 0, svh = the window's height; every box at the
 * document's top), the same ones the expected scroll positions are computed from (window.__lp6.geo(), opted in with
 * ?lp6debug). The positions themselves are checked in a real browser (release notes).
 */
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { SCN, NAVF, SCENE_HASH, beatU } from "../components/landing/v6/nav";

vi.mock("../services/api", () => {
  const ok = () => Promise.resolve({ data: {} });
  const none = { use() { return 0; }, eject() {} };
  return { default: { get: ok, post: ok, put: ok, patch: ok, delete: ok, request: ok, interceptors: { request: none, response: none }, defaults: { headers: { common: {} } } } };
});
vi.mock("../utils/reportClientError", () => ({ reportClientError: () => {} }));

const { default: LandingV6Page } = await import("../pages/LandingV6Page");
const { ScrollManager } = await import("../App");

const FRAME = 32;
const SIZES = { phone: { w: 390, h: 844 }, tablet: { w: 820, h: 1180 }, desktop: { w: 1440, h: 900 }, stacked: { w: 375, h: 667 } };

/* ── the browser around the page: viewport, scroll, matchMedia, observers; the fake clock drives performance.now too ── */
let env = null;
function setup({ w, h } = SIZES.phone, address = "/?lp6debug") {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  const answer = (q) => {
    if (q.includes("prefers-reduced-motion")) return false;
    if (q.includes("min-aspect-ratio")) return w >= 1024 && w / h >= 1.25;
    let ok = true;
    for (const m of q.matchAll(/\((min|max)-(width|height):\s*(\d+)px\)/g)) { const v = m[2] === "width" ? w : h; ok = ok && (m[1] === "min" ? v >= +m[3] : v <= +m[3]); }
    return ok;
  };
  window.matchMedia = vi.fn((q) => { const l = new EventTarget(); l.matches = answer(q); l.media = q; l.addListener = () => {}; l.removeListener = () => {}; return l; });
  class Obs { observe() {} unobserve() {} disconnect() {} }
  window.ResizeObserver = Obs;
  window.IntersectionObserver = Obs;
  let Y = 0;
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
  Object.defineProperty(window, "scrollY", { get: () => Y, configurable: true });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: 100000, configurable: true });
  const scrollTo = vi.fn((a, b) => { Y = typeof a === "object" ? a.top : b; });
  window.scrollTo = scrollTo;
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  // no layout, but a consistent page: every box sits at the document's top, so it moves up as the page scrolls (as in a
  // browser); without this jsdom's boxes stay at 0 and a re-layout would take the scroll position for the stage's top
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: -Y, top: -Y, bottom: -Y, left: 0, right: 0, width: 0, height: 0 }));
  window.history.replaceState(null, "", address);
  env = { scrollTo, scrollIntoView, setY: (y) => { Y = y; }, getY: () => Y };
  return env;
}
beforeEach(() => { delete window.__lp6; localStorage.setItem("lang", "da"); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.matchMedia; delete window.ResizeObserver; delete window.IntersectionObserver; delete Element.prototype.scrollIntoView;
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  document.documentElement.lang = "da";
  env = null;
});

const page = (entry = "/", { scroll = false } = {}) => (
  <MemoryRouter initialEntries={[entry]}>
    {scroll ? <ScrollManager /> : null}
    <LanguageProvider>
      <Routes>
        <Route path="/" element={<LandingV6Page />} />
        <Route path="/login" element={<p>login</p>} />
      </Routes>
    </LanguageProvider>
  </MemoryRouter>
);
const lp6 = () => document.querySelector(".lp6");
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const wait = (ms) => act(() => { vi.advanceTimersByTime(ms); });
const scrolled = () => act(() => { window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME); });
/** The page y of a scene's resting point, from the engine's own geometry (as engine.js beatY + stepTo compute it). */
const sceneY = (go) => { const g = window.__lp6.geo(); return Math.max(0, Math.round(g.pin + (beatU({ SEG: g.SEG, ACC: g.ACC }, go, NAVF[go]) * g.svh) / 100)); };
const click = (el, init = {}) => { const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(ev); return ev; };
const links = (go) => [lp6().querySelector(`#hero a[data-go="${go}"]`), lp6().querySelector(`.ix a[data-go="${go}"]`)];

/* ───────────────────────────── (a) ───────────────────────────── */
describe("(a) a plain click on a headline word or an index link: the jump, and the address names the scene", () => {
  it("from a stale #pricing: hero 02 → #s2, index 03 → #s6, hero 01 → #s1; replaced (not pushed), router state and query kept", async () => {
    const e = setup(SIZES.phone, "/?ref=r1-a-01#pricing");
    const state = { usr: null, key: "k7", idx: 3 };
    window.history.replaceState(state, "", "/?ref=r1-a-01#pricing");
    const len = window.history.length;
    render(page("/?ref=r1-a-01#pricing"));
    await flush();
    const push = vi.spyOn(window.history, "pushState");
    const repl = vi.spyOn(window.history, "replaceState");
    e.scrollTo.mockClear();
    for (const [el, go] of [[links("2a")[0], "2a"], [links("3a")[1], "3a"], [links("1a")[0], "1a"]]) {
      const ev = click(el);
      expect(ev.defaultPrevented).toBe(true); // the browser's own hash jump never happens
      expect(e.scrollTo).toHaveBeenLastCalledWith({ top: Math.max(0, Math.round(sceneY(go))), behavior: "instant" });
      expect(window.location.hash).toBe(SCENE_HASH[go]);
      expect(window.location.search).toBe("?ref=r1-a-01");
      expect(window.history.state).toEqual(state);
      wait(300);
    }
    expect(repl.mock.calls.map((c) => c[2])).toEqual(["#s2", "#s6", "#s1"]);
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(len);
  });

  it("every [data-go] link on the page names its own scene, and only those three fragments are ever written", async () => {
    setup();
    render(page());
    await flush();
    const repl = vi.spyOn(window.history, "replaceState");
    const all = [...lp6().querySelectorAll("[data-go]")];
    expect(all.length).toBe(6); // three hero words, three index links
    for (const a of all) {
      click(a);
      expect([a.dataset.go, window.location.hash]).toEqual([a.dataset.go, SCENE_HASH[a.dataset.go]]);
      expect(a.getAttribute("href")).toBe(SCENE_HASH[a.dataset.go]);
      wait(300);
    }
    expect(new Set(repl.mock.calls.map((c) => c[2]))).toEqual(new Set(["#s1", "#s2", "#s6"]));
  });

  it("a tap merged into the previous one (< 250 ms) neither jumps nor changes the address", async () => {
    const e = setup();
    render(page());
    await flush();
    click(links("2a")[0]);
    expect(window.location.hash).toBe("#s2");
    e.scrollTo.mockClear();
    wait(100);
    click(links("3a")[1]);
    expect(e.scrollTo).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#s2");
  });
});

/* ───────────────────────────── (b) ───────────────────────────── */
describe("(b) a click with a modifier key or another button is the browser's own", () => {
  const OWN = [["Cmd", { metaKey: true }], ["Ctrl", { ctrlKey: true }], ["Shift", { shiftKey: true }], ["Alt", { altKey: true }], ["middle button", { button: 1 }], ["right button", { button: 2 }]];
  for (const [name, init] of OWN) {
    it(`${name}-click on a hero word and an index link: not prevented, no jump, the address untouched`, async () => {
      const e = setup(SIZES.phone, "/?lp6debug#pricing");
      render(page("/#pricing"));
      await flush();
      const repl = vi.spyOn(window.history, "replaceState");
      e.scrollTo.mockClear();
      for (const el of links("2a")) {
        const ev = click(el, init);
        expect([name, ev.defaultPrevented]).toEqual([name, false]);
      }
      expect(e.scrollTo).not.toHaveBeenCalled();
      expect(repl).not.toHaveBeenCalled();
      expect(window.location.hash).toBe("#pricing");
      // the tap gate was not used up: a plain click at once still jumps
      const ev = click(links("2a")[0]);
      expect(ev.defaultPrevented).toBe(true);
      expect(e.scrollTo).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe("#s2");
    });
  }
});

/* ───────────────────────────── (c) ───────────────────────────── */
describe("(c) arrival: /#s1, /#s2, /#s6 open on that scene; nothing else moves the page", () => {
  for (const size of ["phone", "tablet", "desktop"]) {
    for (const [go, hash] of Object.entries(SCENE_HASH)) {
      it(`${size}: a cold load of /${hash} opens on scene ${SCN[go]} (${go})`, async () => {
        const e = setup(SIZES[size], `/?lp6debug${hash}`);
        render(page(`/${hash}`));
        await flush();
        expect(lp6().classList.contains("story")).toBe(true);
        const y = sceneY(go);
        expect(y).toBeGreaterThan(0);
        expect(e.scrollTo.mock.calls).toEqual([[{ top: y, behavior: "instant" }]]);
        expect(e.getY()).toBe(y);
        await scrolled();
        expect(window.__lp6.scn()).toBe(SCN[go]);
        expect(lp6().querySelector("#count").textContent).toBe(`${SCN[go]} / 7`);
        expect(lp6().querySelector("#frame").hasAttribute("data-bb-own-anchors")).toBe(true);
        expect(window.location.hash).toBe(hash); // the address already names it: left as it is
        // and it stays: the 150 / 300 ms jump checks and a late re-layout keep the scene
        wait(1500);
        window.dispatchEvent(new Event("resize")); wait(500);
        await scrolled();
        expect(window.__lp6.scn()).toBe(SCN[go]);
      });
    }
  }

  const NOT_ARRIVALS = ["", "#", "#s3", "#s4", "#s5", "#pricing", "#main", "#S2", "#s2x", "#s22", "#%73%32", "#s2%20", "#1a", "#2a", "#constructor", "#__proto__", "#<img src=x onerror=alert(1)>", "#javascript:alert(1)", "#//evil.example"];
  it(`any other fragment opens at the top: ${NOT_ARRIVALS.map((h) => JSON.stringify(h)).join(" ")}`, async () => {
    for (const hash of NOT_ARRIVALS) {
      const e = setup(SIZES.phone, `/?lp6debug${hash}`);
      const { unmount } = render(page("/"));
      await flush();
      wait(500);
      expect([hash, lp6().classList.contains("story"), e.scrollTo.mock.calls]).toEqual([hash, true, []]);
      expect([hash, e.getY()]).toEqual([hash, 0]);
      unmount();
      vi.useRealTimers();
    }
  });

  it("the stacked page (short phone) leaves /#s2 to the browser: no engine jump, no data-bb-own-anchors", async () => {
    const e = setup(SIZES.stacked, "/?lp6debug#s2");
    render(page("/#s2"));
    await flush();
    expect(lp6().classList.contains("story")).toBe(false);
    expect(e.scrollTo).not.toHaveBeenCalled();
    expect(lp6().querySelector("#frame").hasAttribute("data-bb-own-anchors")).toBe(false);
  });

  it("StrictMode (mount, destroy, mount): one jump; the second engine keeps the place", async () => {
    const e = setup(SIZES.phone, "/?lp6debug#s6");
    render(<StrictMode>{page("/#s6")}</StrictMode>);
    await flush();
    expect(e.scrollTo.mock.calls).toEqual([[{ top: sceneY("3a"), behavior: "instant" }]]);
    await scrolled();
    expect(window.__lp6.scn()).toBe(SCN["3a"]);
  });

  it("a language switch never sends the reader back to the arrival scene (at the top again, or anywhere else)", async () => {
    const e = setup(SIZES.phone, "/?lp6debug#s2");
    render(page("/#s2"));
    await flush();
    expect(e.scrollTo).toHaveBeenCalledTimes(1);
    wait(1000); // past the jump's 400 ms snap-back watch (a move back to the top inside it is undone as an iOS snap-back)
    for (const [y, to] of [[0, "en"], [5000, "da"]]) {
      e.setY(y); await scrolled(); // the reader has moved by hand
      e.scrollTo.mockClear();
      fireEvent.click(lp6().querySelector(`.top .lang button[lang='${to}']`));
      await flush();
      wait(500);
      expect([to, lp6().getAttribute("lang")]).toEqual([to, to]);
      expect([to, e.scrollTo.mock.calls.filter(([a]) => a && a.top === sceneY("2a"))]).toEqual([to, []]);
      expect([to, e.getY()]).toEqual([to, y]);
    }
  });
});

/* ───────────────────────────── (d) ───────────────────────────── */
describe("(d) ScrollManager: the pinned day's anchors are the engine's; every other one is scrolled to as before", () => {
  const at = (entry, dom) => render(
    <MemoryRouter initialEntries={[entry]}>
      <ScrollManager />
      {dom}
    </MemoryRouter>,
  );

  it("a fragment inside [data-bb-own-anchors] is left alone; the same id outside it, and #pricing, are scrolled into view", async () => {
    const e = setup();
    const r1 = at("/#s2", <div data-bb-own-anchors=""><article id="s2" /></div>);
    wait(1000);
    expect(e.scrollIntoView).not.toHaveBeenCalled();
    r1.unmount();
    const r2 = at("/#s2", <div><article id="s2" /></div>);
    expect(e.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(e.scrollIntoView.mock.contexts[0].id).toBe("s2");
    r2.unmount();
    e.scrollIntoView.mockClear();
    at("/#pricing", <div><div data-bb-own-anchors=""><article id="s2" /></div><section id="pricing" /></div>);
    expect(e.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(e.scrollIntoView.mock.contexts[0].id).toBe("pricing");
  });

  it("the real landing at /#s2 (story): the engine opens scene 2, ScrollManager never scrolls the article into view", async () => {
    const e = setup(SIZES.phone, "/?lp6debug#s2");
    render(page("/#s2", { scroll: true }));
    await flush();
    wait(1000);
    expect(e.scrollIntoView).not.toHaveBeenCalled();
    expect(e.scrollTo.mock.calls).toEqual([[{ top: sceneY("2a"), behavior: "instant" }]]);
    await scrolled();
    expect(window.__lp6.scn()).toBe(2);
  });

  it("the real landing at /#pricing: ScrollManager scrolls to the prices, the engine does not jump", async () => {
    const e = setup(SIZES.phone, "/?lp6debug#pricing");
    render(page("/#pricing", { scroll: true }));
    await flush();
    wait(1000);
    expect(e.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(e.scrollIntoView.mock.contexts[0]).toBe(lp6().querySelector("#pricing"));
    expect(e.scrollTo).not.toHaveBeenCalled();
  });

  it("the real stacked landing at /#s2: ScrollManager scrolls to the scene's article (the static layout's own anchor)", async () => {
    const e = setup(SIZES.stacked, "/?lp6debug#s2");
    render(page("/#s2", { scroll: true }));
    await flush();
    wait(1000);
    expect(e.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(e.scrollIntoView.mock.contexts[0]).toBe(lp6().querySelector("#s2"));
  });
});
