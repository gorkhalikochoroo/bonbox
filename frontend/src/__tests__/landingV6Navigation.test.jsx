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
 *       the engine and scrolls every other one as before (#pricing on the landing, the stacked page's scenes, any page);
 *   (e) Simulator round (iOS Safari, 23 Oct; engine.js note 21): the scene's address reached while the page is already on
 *       screen (typed into the bar, a plain link, another app, Back / Forward: the fragment changes, no reload, the browser
 *       fires its history-traversal and fragment-change events) steps to that scene from the top, from 7 / 7 and from the
 *       prices; the two events of one change are one jump; the step queue carries on from it; every other fragment is
 *       ignored; the engine's own address write fires neither event; both listeners leave with the page;
 *   (f) Back fix (23 Oct; engine.js note 23): a reader who opened /#s2 or tapped a word that named #s2 / #s6, went on to
 *       7 / 7 (by hand or with Næste), and left by Priser or the logo, is put back at 7 / 7 by Back (and again after
 *       Forward and Back): no jump, no entry added by the page, nothing pushed; a new /#s6 typed at 7 / 7 still steps, once,
 *       and so does the same /#s2 typed again; Back / Forward between two handled scene entries return to the reader's
 *       place on each; only the mark for the entry's own address counts; every other fragment is still ignored and unmarked.
 * jsdom has no layout: the geometry is the engine's own fall-backs (pin 0, svh = the window's height; every box at the
 * document's top), the same ones the expected scroll positions are computed from (window.__lp6.geo(), opted in with
 * ?lp6debug). The positions themselves are checked in a real browser (release notes).
 */
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { SCN, NAVF, SCENE_HASH, LP6_MARK, beatU } from "../components/landing/v6/nav";

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
      // the router's state kept, plus the engine's mark for the scene it named (engine.js note 23)
      expect(window.history.state).toEqual({ ...state, [LP6_MARK]: SCENE_HASH[go] });
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

/* ───────────────────────────── (e) ───────────────────────────── */
/** A same-document fragment navigation as the browser makes it: the address changes (a new entry), then the history-traversal
 *  event and the fragment-change event (in that order, unless told otherwise; the second can come a task later). */
const navigate = (hash, order = ["popstate", "hashchange"]) => act(() => {
  const oldURL = window.location.href;
  window.history.pushState(null, "", window.location.pathname + window.location.search + hash);
  for (const t of order) window.dispatchEvent(t === "popstate" ? new PopStateEvent("popstate", { state: null }) : new HashChangeEvent("hashchange", { oldURL, newURL: window.location.href }));
});
/** The window's listeners for the two address events, live (added and not yet removed), whoever added them. */
function addressListeners() {
  const live = { hashchange: new Set(), popstate: new Set() }; // type → the (listener, capture) pairs still attached
  const keyOf = (fn, o) => [fn, typeof o === "boolean" ? o : !!(o && o.capture)];
  const find = (set, k) => [...set].find((x) => x[0] === k[0] && x[1] === k[1]);
  const add = window.addEventListener, rem = window.removeEventListener;
  vi.spyOn(window, "addEventListener").mockImplementation(function (type, fn, o) {
    if (live[type] && !find(live[type], keyOf(fn, o))) live[type].add(keyOf(fn, o));
    return add.call(this, type, fn, o);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation(function (type, fn, o) {
    if (live[type]) { const k = find(live[type], keyOf(fn, o)); if (k) live[type].delete(k); }
    return rem.call(this, type, fn, o);
  });
  return { count: () => live.hashchange.size + live.popstate.size, types: () => [...live.hashchange].map(() => "hashchange").concat([...live.popstate].map(() => "popstate")) };
}

describe("(e) the scene's address reached while the page is already on screen (no reload)", () => {
  const FROM = [
    ["the top", () => 0, 1],
    ["7 / 7", () => sceneY("3b"), 7],
    ["the prices (past the day)", () => 50000, 7],
  ];
  for (const [where, y0, scn0] of FROM) {
    for (const [go, hash] of [["2a", "#s2"], ["3a", "#s6"]]) {
      it(`from ${where}: ${hash} steps to scene ${SCN[go]} at its resting point, one instant jump, the address left as it is`, async () => {
        const e = setup(SIZES.phone, "/?lp6debug");
        render(page("/"));
        await flush();
        wait(1000);
        e.setY(y0()); await scrolled();
        expect([where, window.__lp6.scn()]).toEqual([where, scn0]);
        e.scrollTo.mockClear();
        const repl = vi.spyOn(window.history, "replaceState");
        navigate(hash);
        wait(FRAME);
        expect(e.scrollTo.mock.calls).toEqual([[{ top: sceneY(go), behavior: "instant" }]]);
        await scrolled();
        expect(window.__lp6.scn()).toBe(SCN[go]);
        expect(lp6().querySelector("#count").textContent).toBe(`${SCN[go]} / 7`);
        expect(window.location.hash).toBe(hash);
        // the one history write marks the entry as handled (engine.js note 23): no URL, so the address cannot change
        expect(repl.mock.calls).toEqual([[{ idx: null, [LP6_MARK]: hash }, ""]]);
        expect(window.history.state).toEqual({ idx: null, [LP6_MARK]: hash });
        // it stays: the jump's checks and a late re-layout keep the scene
        wait(1500);
        window.dispatchEvent(new Event("resize")); wait(500);
        await scrolled();
        expect(window.__lp6.scn()).toBe(SCN[go]);
      });
    }
  }

  it("desktop and tablet: #s1, #s2, #s6 from the top each land on their scene", async () => {
    for (const size of ["tablet", "desktop"]) {
      for (const [go, hash] of Object.entries(SCENE_HASH)) {
        const e = setup(SIZES[size], "/?lp6debug");
        const { unmount } = render(page("/"));
        await flush();
        wait(1000);
        e.scrollTo.mockClear();
        navigate(hash);
        wait(FRAME);
        expect([size, hash, e.scrollTo.mock.calls]).toEqual([size, hash, [[{ top: sceneY(go), behavior: "instant" }]]]);
        await scrolled();
        expect([size, hash, window.__lp6.scn()]).toEqual([size, hash, SCN[go]]);
        unmount();
        vi.useRealTimers();
        window.history.replaceState(null, "", "/");
      }
    }
  });

  it("the two events of one change are one jump, whichever comes first and when the second comes a frame later", async () => {
    for (const order of [["popstate", "hashchange"], ["hashchange", "popstate"], ["popstate"], ["hashchange"]]) {
      const e = setup(SIZES.phone, "/?lp6debug");
      const { unmount } = render(page("/"));
      await flush();
      wait(1000);
      e.scrollTo.mockClear();
      navigate("#s6", order.slice(0, 1));
      wait(FRAME);
      if (order[1]) { act(() => { window.dispatchEvent(order[1] === "popstate" ? new PopStateEvent("popstate") : new HashChangeEvent("hashchange")); }); wait(FRAME); }
      expect([order.join(" + "), e.scrollTo.mock.calls]).toEqual([order.join(" + "), [[{ top: sceneY("3a"), behavior: "instant" }]]]);
      unmount();
      vi.useRealTimers();
      window.history.replaceState(null, "", "/");
    }
  });

  it("the step queue carries on from it: Næste right after #s2 goes to scene 3; an unmarked #s2 entry after #s6 steps back to 2", async () => {
    const e = setup(SIZES.phone, "/?lp6debug");
    render(page("/"));
    await flush();
    wait(1000);
    navigate("#s2"); wait(FRAME);
    // a tap within the queue's 600 ms steps on from the jump's scene, not from where the page happens to be (here: the
    // page has not reported its new place yet, as on iOS while it applies the jump)
    e.setY(0);
    e.scrollTo.mockClear();
    fireEvent.click(lp6().querySelector("#dnext"));
    expect(e.scrollTo.mock.calls).toEqual([[{ top: sceneY("1b"), behavior: "instant" }]]);
    wait(1000);
    navigate("#s6"); wait(FRAME); await scrolled();
    expect(window.__lp6.scn()).toBe(6);
    // an earlier #s2 entry that carries no mark (one the engine never handled: say its mark could not be written) is made
    // current and the browser fires the two events: it steps as a new address does. Back to an entry the engine HAS
    // handled is a return to the reader's place (engine.js note 23, block (f))
    act(() => { window.history.replaceState(null, "", "/?lp6debug#s2"); window.dispatchEvent(new PopStateEvent("popstate")); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    wait(FRAME); await scrolled();
    expect(window.__lp6.scn()).toBe(2);
  });

  it(`every other fragment is ignored, from the top and from 7 / 7: ${["#", "#s3", "#s4", "#S2", "#s2x", "#s22", "#%73%32", "#s2%20", "#1a", "#2a", "#pricing", "#faq", "#foot", "#main", "#constructor", "#__proto__", "#<img src=x onerror=alert(1)>", "#javascript:alert(1)", "#//evil.example"].length} of them`, async () => {
    const OTHER = ["#", "#s3", "#s4", "#S2", "#s2x", "#s22", "#%73%32", "#s2%20", "#1a", "#2a", "#pricing", "#faq", "#foot", "#main", "#constructor", "#__proto__", "#<img src=x onerror=alert(1)>", "#javascript:alert(1)", "#//evil.example"];
    const e = setup(SIZES.phone, "/?lp6debug");
    render(page("/"));
    await flush();
    wait(1000);
    for (const y of [0, sceneY("3b")]) {
      e.setY(y); await scrolled();
      for (const hash of OTHER) {
        e.scrollTo.mockClear();
        navigate(hash);
        wait(FRAME);
        expect([y, hash, e.scrollTo.mock.calls]).toEqual([y, hash, []]);
        expect([y, hash, e.getY()]).toEqual([y, hash, y]);
      }
    }
  });

  it("the engine's own address write (a headline word, an index link) fires neither event: one jump per click", async () => {
    const e = setup(SIZES.phone, "/?lp6debug");
    render(page("/"));
    await flush();
    wait(1000);
    const seen = [];
    const note = (ev) => seen.push(ev.type);
    window.addEventListener("hashchange", note); window.addEventListener("popstate", note);
    try {
      for (const el of [links("2a")[0], links("3a")[1], links("1a")[0]]) {
        e.scrollTo.mockClear();
        click(el);
        wait(400);
        expect([el.dataset.go, e.scrollTo.mock.calls.length, window.location.hash]).toEqual([el.dataset.go, 1, SCENE_HASH[el.dataset.go]]);
      }
      expect(seen).toEqual([]);
    } finally { window.removeEventListener("hashchange", note); window.removeEventListener("popstate", note); }
  });

  it("the stacked page (short phone) leaves a fragment change to the browser: no engine jump, no listener", async () => {
    const L = addressListeners();
    const e = setup(SIZES.stacked, "/?lp6debug");
    render(page("/"));
    await flush();
    expect(lp6().classList.contains("story")).toBe(false);
    expect(L.count()).toBe(0);
    navigate("#s2"); wait(FRAME);
    expect(e.scrollTo).not.toHaveBeenCalled();
  });

  it("both listeners are the engine's (in its ledger): one of each while the page is on screen, still one after DK → EN, none after unmount", async () => {
    const L = addressListeners();
    setup(SIZES.phone, "/?lp6debug");
    const { unmount } = render(page("/"));
    await flush();
    expect(L.types()).toEqual(["hashchange", "popstate"]);
    fireEvent.click(lp6().querySelector(".top .lang button[lang='en']"));
    await flush();
    expect(lp6().getAttribute("lang")).toBe("en");
    expect(L.types()).toEqual(["hashchange", "popstate"]);
    unmount();
    expect(L.count()).toBe(0);
  });
});

/* ───────────────────────────── (f) ───────────────────────────── */
/* Back fix (23 Oct, engine.js note 23). The regression: a reader who opened /#s2 (or tapped a word that named it), went on to
 * 7 / 7, tapped Priser or the logo (a plain fragment link: the browser makes a new entry) and pressed Back was sent to scene 2.
 * Here the browser's own history does the walking (jsdom's: the link click makes the entry, history.back() / forward()
 * traverse and fire popstate + hashchange with the entry's real state); what jsdom does not do is scroll, so the test does
 * what the browser does: scroll to the fragment the link names, and on Back / Forward put back the entry's saved place. */
const PRICES_Y = 50000;
const y7 = () => sceneY("3b");
/** Back or Forward through the browser's own history; restore = the entry's saved place, put back before the engine's frame. */
const traverse = (dir, restore) => {
  act(() => { window.history[dir](); vi.advanceTimersByTime(0); });
  if (restore != null) env.setY(restore);
  wait(FRAME);
};
/** The reader moves on to 7 / 7: by hand (a scroll) or with Næste, one tap at a time. */
async function toSeven(how, size) {
  if (how === "scroll") { env.setY(y7()); await scrolled(); return; }
  const next = lp6().querySelector(size === "desktop" ? "#next" : "#dnext");
  for (let i = 0; i < 8 && window.__lp6.scn() < 7; i++) { fireEvent.click(next); wait(700); await scrolled(); }
}
/** A plain fragment link: the browser's own navigation (a new entry, popstate + hashchange), then its scroll to the target. */
async function follow(sel, y) {
  const a = lp6().querySelector(sel);
  expect(a.hasAttribute("data-go")).toBe(false); // not the engine's: the browser follows it
  act(() => { a.click(); vi.advanceTimersByTime(0); });
  env.setY(y); await scrolled();
  wait(FRAME);
}

describe("(f) Back after moving on from a scene the address names: the reader is put back where they were", () => {
  // [how the address came to name the scene, that address, the page's address and router entry, the word tapped (if any)]
  const NAMED = [
    ["a cold load of /#s2", "#s2", "/?lp6debug#s2", "/#s2", null],
    ["the hero word 02 (names #s2)", "#s2", "/?lp6debug", "/", "#hero a[data-go='2a']"],
    ["the hero word 03 (names #s6, which covers 6 and 7)", "#s6", "/?lp6debug", "/", "#hero a[data-go='3a']"],
  ];
  const LEAVE = [["Priser (#pricing)", ".top .prices-l", "#pricing", () => PRICES_Y], ["the logo (#main)", ".top .logo", "#main", () => 0]];
  for (const size of ["phone", "desktop"]) {
    for (const [named, hash, address, entry, word] of NAMED) {
      for (const how of ["scroll", "Næste"]) {
        for (const [leave, sel, to, yTo] of LEAVE) {
          it(`${size}: ${named} → ${how === "scroll" ? "scrolls" : "Næste"} to 7 / 7 → ${leave} → Back: still 7 / 7, no jump, no new entry from the page`, async () => {
            setup(SIZES[size], address);
            render(page(entry));
            await flush();
            wait(1000);
            const push = vi.spyOn(window.history, "pushState");
            const len0 = window.history.length;
            if (word) { click(lp6().querySelector(word)); wait(1000); await scrolled(); }
            expect(window.history.length).toBe(len0); // naming the scene wrote over this entry
            expect(window.location.hash).toBe(hash);
            await toSeven(how === "scroll" ? "scroll" : "next", size);
            expect(window.__lp6.scn()).toBe(7);
            const at7 = env.getY();
            expect(window.location.hash).toBe(hash); // the address still names the scene the reader left
            expect(window.history.length).toBe(len0);
            await follow(sel, yTo());
            expect(window.location.hash).toBe(to);
            const len1 = window.history.length; // with the browser's own entry for the link (any forward entries dropped)
            env.scrollTo.mockClear();
            traverse("back", at7);
            await scrolled();
            expect([named, how, leave, env.scrollTo.mock.calls]).toEqual([named, how, leave, []]);
            expect(env.getY()).toBe(at7);
            expect(window.__lp6.scn()).toBe(7);
            expect(lp6().querySelector("#count").textContent).toBe("7 / 7");
            expect(window.location.hash).toBe(hash);
            // and it stays: the jump checks and a late re-layout leave the place alone
            wait(1500);
            window.dispatchEvent(new Event("resize")); wait(500);
            await scrolled();
            expect(window.__lp6.scn()).toBe(7);
            // Forward to the link's entry and Back again: the same
            traverse("forward", yTo());
            await scrolled();
            traverse("back", at7);
            await scrolled();
            expect(env.scrollTo).not.toHaveBeenCalled();
            expect(window.__lp6.scn()).toBe(7);
            expect(window.history.length).toBe(len1); // the page added no entry
            expect(push).not.toHaveBeenCalled();
            // how: the arrival or the word marked the entry as handled at its address (engine.js note 23)
            expect(window.history.state).toEqual({ idx: null, [LP6_MARK]: hash });
          });
        }
      }
    }
  }

  it("a new /#s6 typed at 7 / 7 (on the entry the page marked #s2) still steps to scene 6, once; that entry is then a return too", async () => {
    const e = setup(SIZES.phone, "/?lp6debug#s2");
    render(page("/#s2"));
    await flush();
    wait(1000);
    const push = vi.spyOn(window.history, "pushState");
    await toSeven("scroll");
    e.scrollTo.mockClear();
    navigate("#s6"); // a new entry, no state: as the browser makes it for a typed address
    const len0 = window.history.length;
    wait(FRAME);
    expect(e.scrollTo.mock.calls).toEqual([[{ top: sceneY("3a"), behavior: "instant" }]]);
    await scrolled();
    expect(window.__lp6.scn()).toBe(6);
    push.mockClear(); // navigate() itself stands in for the browser's push
    // the reader moves on to 7 / 7, taps Priser, comes Back: still 7 / 7
    await toSeven("scroll");
    expect(window.history.length).toBe(len0); // stepping and marking wrote over the typed entry
    await follow(".top .prices-l", PRICES_Y);
    const len1 = window.history.length;
    e.scrollTo.mockClear();
    traverse("back", y7());
    await scrolled();
    expect(e.scrollTo).not.toHaveBeenCalled();
    expect(window.__lp6.scn()).toBe(7);
    // Back once more, to the #s2 entry (left at 7 / 7): a return as well
    traverse("back", y7());
    await scrolled();
    expect(window.location.hash).toBe("#s2");
    expect(e.scrollTo).not.toHaveBeenCalled();
    expect(window.__lp6.scn()).toBe(7);
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(len1); // the typed address and the link: the browser's own entries, none from the page
    // how: the step marked the typed entry as handled at its address (engine.js note 23)
    traverse("forward", y7());
    expect([window.location.hash, window.history.state]).toEqual(["#s6", { idx: null, [LP6_MARK]: "#s6" }]);
  });

  it("the same /#s2 typed again on the marked /#s2 entry (the browser puts a fresh entry, no state, in its place) steps to scene 2", async () => {
    const e = setup(SIZES.phone, "/?lp6debug#s2");
    render(page("/#s2"));
    await flush();
    wait(1000);
    const len0 = window.history.length;
    await toSeven("scroll");
    e.scrollTo.mockClear();
    act(() => { window.history.replaceState(null, "", window.location.href); window.dispatchEvent(new PopStateEvent("popstate", { state: null })); });
    wait(FRAME);
    expect(e.scrollTo.mock.calls).toEqual([[{ top: sceneY("2a"), behavior: "instant" }]]);
    await scrolled();
    expect(window.__lp6.scn()).toBe(2);
    expect(window.history.state).toEqual({ idx: null, [LP6_MARK]: "#s2" });
    expect(window.history.length).toBe(len0);
  });

  it("Back / Forward between two scene entries the page has handled: each returns to the reader's place on it, never a jump", async () => {
    const e = setup(SIZES.tablet, "/?lp6debug");
    render(page("/"));
    await flush();
    wait(1000);
    navigate("#s2"); wait(FRAME); await scrolled();
    expect(window.__lp6.scn()).toBe(2);
    wait(1000);
    const y4 = sceneY("S");
    e.setY(y4); await scrolled(); // the reader reads on to 4 / 7 on the #s2 entry
    expect(window.__lp6.scn()).toBe(4);
    navigate("#s6"); wait(FRAME); await scrolled();
    expect(window.__lp6.scn()).toBe(6);
    wait(1000);
    const y6 = e.getY();
    e.scrollTo.mockClear();
    traverse("back", y4); await scrolled();
    expect([window.location.hash, window.__lp6.scn(), e.scrollTo.mock.calls]).toEqual(["#s2", 4, []]);
    traverse("forward", y6); await scrolled();
    expect([window.location.hash, window.__lp6.scn(), e.scrollTo.mock.calls]).toEqual(["#s6", 6, []]);
  });

  it("only the mark for the entry's own address counts: another scene's mark, an inherited one, a non-record state each step as new", async () => {
    const proto = Object.create({ [LP6_MARK]: "#s2" });
    const STATES = [
      ["another scene's mark", { idx: 4, [LP6_MARK]: "#s6" }],
      ["an inherited mark (not the state's own)", proto],
      ["a mark that is not a string", { [LP6_MARK]: ["#s2"] }],
      ["a state that is a string", "#s2"],
      ["a state that is a list", ["#s2"]],
      ["the mark under another key", { lp: "#s2", LP6: "#s2" }],
    ];
    for (const [what, state] of STATES) {
      const e = setup(SIZES.phone, "/?lp6debug");
      const { unmount } = render(page("/"));
      await flush();
      wait(1000);
      await toSeven("scroll");
      e.scrollTo.mockClear();
      act(() => { window.history.pushState(state, "", "/?lp6debug#s2"); window.dispatchEvent(new PopStateEvent("popstate", { state })); window.dispatchEvent(new HashChangeEvent("hashchange")); });
      wait(FRAME);
      expect([what, e.scrollTo.mock.calls]).toEqual([what, [[{ top: sceneY("2a"), behavior: "instant" }]]]);
      unmount();
      vi.useRealTimers();
      window.history.replaceState(null, "", "/");
    }
  });

  it("other fragments are still ignored, marked or not, and leave no mark: Back / Forward to them, or a mark on a hostile address", async () => {
    const OTHER = ["#pricing", "#main", "#faq", "#foot", "#s3", "#S2", "#s2x", "#%73%32", "#constructor", "#__proto__", "#<img src=x onerror=alert(1)>", "#javascript:alert(1)", "#//evil.example"];
    const e = setup(SIZES.phone, "/?lp6debug");
    render(page("/"));
    await flush();
    wait(1000);
    const repl = vi.spyOn(window.history, "replaceState");
    await toSeven("scroll");
    const y = e.getY();
    for (const hash of OTHER) {
      for (const state of [null, { [LP6_MARK]: hash }, { [LP6_MARK]: "#s2" }]) {
        e.scrollTo.mockClear();
        act(() => { window.history.pushState(state, "", "/?lp6debug" + hash); window.dispatchEvent(new PopStateEvent("popstate", { state })); window.dispatchEvent(new HashChangeEvent("hashchange")); });
        wait(FRAME);
        expect([hash, state, e.scrollTo.mock.calls, e.getY()]).toEqual([hash, state, [], y]);
      }
      traverse("back", y); traverse("forward", y);
      expect([hash, e.scrollTo.mock.calls, e.getY()]).toEqual([hash, [], y]);
    }
    expect(repl).not.toHaveBeenCalled(); // the engine wrote nothing for any of them
  });
});
