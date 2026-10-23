/**
 * LANDING V6 — the engine's lifecycle (PORT_PLAN 1.4 items 3–9, port step 4).
 *
 * engine.js is the v6.3 prototype's script as a module: mountLanding(root, opts) → destroy(). These tests run it
 * in jsdom on a fixture with every element the engine queries (the real page markup is step 5) and check what
 * the plan asks of the port, not the layout maths (jsdom has no layout; the maths is held to the prototype in a
 * real browser by the lab's port-build/tools/engine_check.mjs, 0 differences at 8 sizes):
 *   - mount → destroy → mount → destroy leaves zero listeners, zero timers / frames, zero observers, no
 *     window.__lp6, and the root's DOM exactly as before the first mount (StrictMode, a language re-key);
 *   - the mode classes go on the root, never on <html>; queries stay inside the root;
 *   - theme-color is written through setThemeColor, compared with the live <meta>, and put back on destroy;
 *   - the stepper's 250 ms tap merge and the one-time re-assert of a jump iOS snapped back;
 *   - a mount that fails half-way leaves the static page and reports;
 *   - (Simulator round, 23 Oct; note 22) a mount that carries the reader's place (opts.settle: a language re-key) resolves
 *     its first layout's classes (the bar on …) with a layout read while .lp6-boot still holds every transition off, so taking
 *     it off changes nothing and starts nothing; a first load (no settle) keeps its entrance;
 *   - (hardening round, 23 Oct) the debug hooks: window.__lp6 and the window.__perf tick timer exist only in a dev build or
 *     with ?lp6debug in the address. This file runs as a production build does (import.meta.env.DEV stubbed false) and opts
 *     in with ?lp6debug, so every __lp6 read below also proves the opt-in; the debug-hook block turns each switch on and off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RoomSvg from "../components/landing/v6/RoomSvg";
import { mountLanding, LANDING_BAR, debugHooksOn } from "../components/landing/v6/engine";

const ROOM = renderToStaticMarkup(<RoomSvg />);

// every id, class and attribute engine.js reads, in the prototype's structure (step 5 renders the real thing)
function fixture() {
  const win = '<span class="scr"><span class="win"><img alt="" width="10" height="10"></span></span>';
  const fig = (id, cls, inner = win) => `<figure class="fig fx ${cls}" id="${id}">${inner}<figcaption class="demo sx f3">demo</figcaption></figure>`;
  const dg = (d) => `<span class="dg"><b class="sx f1">${d}</b><b class="sx f1"></b></span>`;
  const ix = (c, go, cur) => `<a href="#s${c}" data-go="${go}" data-c="${c}"><span class="n sx f3">0${c}</span><span class="w sx ${cur ? "f1" : "f3"}">w${c}</span><i class="ixr sbg h"></i></a>`;
  return `<a class="skip" href="#main">skip</a><div id="night" aria-hidden="true"></div>
<header class="top" id="top-bar"><div class="in"><a class="logo" href="#main"><span class="lgA">L</span></a><nav class="nav"><a class="navl prices-l sx f1" href="#pricing">p</a><a class="btn xb" href="/register"><span class="bt">t</span></a></nav></div><i class="hl sbg h"></i></header>
<main id="main"><section class="aften" id="aften">
<div class="hero" id="hero"><h1 class="h1"><a href="#s1" data-go="1a"><span>a</span></a> <a href="#s2" data-go="2a"><span>b</span></a> <a href="#s6" data-go="3a"><span>c</span></a></h1>
<div class="cta-row"><a class="btn btn-lg" id="hero-cta" href="/register">t</a></div></div>
<div class="track" id="track"><div class="frame" id="frame" data-beat="1a">
<h2 class="venue label sx f3" id="aften-h">v</h2><p class="date label sx f3" id="date">d</p>
<nav class="ix" id="ix">${ix(1, "1a", true)}${ix(2, "2a")}${ix(3, "3a")}</nav>
<div class="clock" id="clock" aria-hidden="true">${dg(1)}${dg(0)}<span class="dot sx f1">.</span>${dg(0)}${dg(0)}</div>
<div class="scene" id="scene"></div><div class="plate" id="plate"><i class="cm c1"></i><span class="demo pcap sx f3">demo</span></div><i class="zbl" id="zbline"></i>
<div class="copy sc" id="c1"><h3 class="label sx f3">l</h3><p class="line"><span class="s s1 sx">s1</span> <span class="s s2 sx">s2</span></p><div class="asides"><p class="aside" data-b="h 1a 1b A"><a class="tlink sx f1" href="https://apps.apple.com/dk/app/x/id1">app</a></p></div></div>
<div class="copy sc" id="c2"><h3 class="label sx f3">l</h3><p class="line"><span class="s s1 sx">s1</span></p><div class="asides"><p class="aside note sx f2" data-b="2a A2">n</p><p class="aside note sx f2" data-b="S">n</p><p class="aside note sx f2" data-b="B2">n</p><p class="aside note sx f2" data-b="2b C">n</p></div></div>
<div class="copy sc" id="c3"><h3 class="label sx f3">l</h3><p class="line"><span class="s s1 sx">s1</span></p><div class="asides"><p class="aside note sx f2" data-b="3a">n</p><p class="aside note sx f2" data-b="3b end">n</p></div></div>
<article class="ch" id="s1">${fig("roster", "roster on", '<div class="ro">r</div>')}${fig("uge", "card uge dk-only")}</article>
<article class="ch" id="s2">${fig("booking", "card booking ph-only", '<span class="scr"><img alt=""></span>')}${fig("bookw", "card bookw wd-only")}</article>
<article class="ch" id="s3">${fig("vagt", "card vagt ph-only", '<span class="scr"><img alt=""></span>')}${fig("vapp", "card vapp wd-only")}</article>
<div class="nb" id="nb">
<article class="ch" id="s4"><figure class="fig fx room-fig" id="room" aria-hidden="true"><div class="room-box" id="roombox"><span class="rl v2l" id="v2l">v2</span>${ROOM}</div><div class="room-foot" id="roomfoot"><span class="legend">l</span></div></figure></article>
<article class="ch" id="s5">${fig("tal", "card tal ph-only")}${fig("stand", "card stand ph-only")}${fig("standw", "card standw wd-only")}</article>
<article class="ch" id="s6">${fig("foto", "card foto hold ph-only", '<span class="scr"><img alt=""></span>')}${fig("fotow", "card fotow hold wd-only", '<span class="scr"><img alt=""></span>')}
<figure class="fig fx zb" id="zb"><div class="zb-in"><dl class="zb-rows"><div><dt>k</dt><dd data-v="640">640,00</dd></div><div><dt>c</dt><dd data-v="6610">6.610,00</dd></div><div class="tot"><dt>i</dt><dd data-v="8240">8.240,00</dd></div></dl></div></figure>
${fig("kasse", "card kasse hold")}</article></div>
<div class="story-nav" id="snav"><div class="sn-ev" id="snev"><span class="count sx f3" id="count">1 / 7</span><span class="prog sbg h"><i class="sbg k" id="prog"></i></span>
<button class="next prev" id="prev" type="button" hidden><span class="ar sx f1">←</span><span class="sx f1">f</span></button><button class="next" id="next" type="button"><span class="sx f1">n</span></button></div>
<div class="sn-end" id="snend" inert><a class="btn btn-lg xb" href="/register"><span class="bt">t</span></a><span class="sn-trial sx f2">t</span><button class="next prev" id="eprev" type="button"><span class="ar sx f1">←</span></button></div></div>
</div></div>
<div class="dock" id="dock"><i class="hl sbg h"></i><div class="dk-left"><div class="dk-nav"><button class="next prev off" id="dprev" type="button"><span class="ar sx f1">←</span></button><button class="next" id="dnext" type="button"><span class="sx f1">n</span></button><span class="count sx f3" id="dcount">1 / 7</span></div><p class="dk-trial sx f2">t</p></div><a class="btn xb" href="/register"><span class="bt">t</span></a><i class="dk-prog sbg k" id="dprog"></i></div>
</section>
<div class="sheet" id="sheet"><section id="mere"><ul class="rows"><li data-r>r</li></ul></section><section id="pricing"><a id="pcta" data-r href="/register">p</a></section></div>
</main><footer class="foot" id="foot">f</footer>
<div id="probe" aria-hidden="true"></div>`;
}

const FRAME = 32; // the fake clock runs a frame at the next 16 ms boundary: 32 ms always holds one

/* ── the browser around the engine: viewport, scroll, matchMedia, observers, and a count of everything added ── */
let env;
function setup({ w = 390, h = 844, reduced = false, meta = "#ffffff" } = {}) {
  teardown();
  // jsdom's two selector engines (nwsapi: one for querySelector / matches, one for getComputedStyle's own stylesheet) add
  // their own hover listeners to the document on first use: let them, before counting
  document.querySelector("*:hover"); document.documentElement.matches("*"); void getComputedStyle(document.documentElement).display;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  const live = new Map(); // key → count of listeners still attached (added by anyone after setup)
  const key = (t, type, fn, o) => [t, type, fn, typeof o === "boolean" ? o : !!(o && o.capture)];
  const keys = [];
  const find = (k) => keys.find((x) => x.every((v, i) => v === k[i])) || (keys.push(k), k);
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (type, fn, o) { const k = find(key(this, type, fn, o)); live.set(k, 1); return add.call(this, type, fn, o); });
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(function (type, fn, o) { const k = find(key(this, type, fn, o)); live.delete(k); return rem.call(this, type, fn, o); });
  // port step 10: in vitest's jsdom the global window carries its OWN addEventListener / removeEventListener (not the
  // prototype's), so the two spies above never saw the engine's window listeners (scroll, resize, load, pageshow). Count them too.
  const wAdd = window.addEventListener, wRem = window.removeEventListener;
  vi.spyOn(window, "addEventListener").mockImplementation(function (type, fn, o) { const k = find(key(window, type, fn, o)); live.set(k, 1); return wAdd.call(this, type, fn, o); });
  vi.spyOn(window, "removeEventListener").mockImplementation(function (type, fn, o) { const k = find(key(window, type, fn, o)); live.delete(k); return wRem.call(this, type, fn, o); });
  // matchMedia: phones answer TALLQ / height queries by the numbers; reduced motion on request; the lists count their listeners
  const mqls = [];
  const answer = (q) => {
    if (q.includes("prefers-reduced-motion")) return reduced;
    if (q.includes("min-aspect-ratio")) return w >= 1024 && w / h >= 1.25;
    let ok = true;
    for (const m of q.matchAll(/\((min|max)-(width|height):(\d+)px\)/g)) { const val = m[2] === "width" ? w : h; ok = ok && (m[1] === "min" ? val >= +m[3] : val <= +m[3]); }
    return ok;
  };
  window.matchMedia = vi.fn((q) => { const l = new EventTarget(); l.matches = answer(q); l.media = q; mqls.push(l); return l; });
  // observers
  const obs = [];
  class FakeObserver { constructor(cb) { this.cb = cb; this.targets = new Set(); this.live = true; obs.push(this); } observe(t) { this.targets.add(t); } unobserve(t) { this.targets.delete(t); } disconnect() { this.targets.clear(); this.live = false; } }
  window.ResizeObserver = FakeObserver;
  window.IntersectionObserver = FakeObserver;
  // viewport and scroll
  let Y = 0;
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
  Object.defineProperty(window, "scrollY", { get: () => Y, configurable: true });
  Object.defineProperty(document.documentElement, "scrollHeight", { value: 100000, configurable: true });
  const scrollTo = vi.fn((a, b) => { Y = typeof a === "object" ? a.top : b; });
  window.scrollTo = scrollTo;
  // the page
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  if (meta) { const m = document.createElement("meta"); m.name = "theme-color"; m.content = meta; document.head.appendChild(m); }
  const root = document.createElement("div");
  root.className = "lp6"; root.setAttribute("data-page", "landing"); root.setAttribute("lang", "da");
  root.innerHTML = fixture();
  document.body.appendChild(root);
  const htmlClass = document.documentElement.className;
  env = {
    root, scrollTo, mqls, obs, live, htmlClass,
    setY: (y) => { Y = y; },
    listeners: () => live.size,
    mqListeners: () => mqls.length && [...live.keys()].filter(([t]) => mqls.includes(t)).length,
    liveObservers: () => obs.filter((o) => o.live && o.targets.size).length,
    meta: () => document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
  };
  return env;
}

function teardown() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  env?.root.remove();
  env = null;
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  delete window.matchMedia; delete window.ResizeObserver; delete window.IntersectionObserver;
}
/* a production build (DEV false) that opts in to the debug hooks through the address, as the lab's probes do */
const debugAddress = (on) => window.history.replaceState(null, "", on ? "/?lp6debug" : "/");
beforeEach(() => { delete window.__lp6; delete window.__perf; vi.stubEnv("DEV", false); debugAddress(true); });
afterEach(() => { teardown(); vi.unstubAllEnvs(); debugAddress(false); delete window.__perf; });

describe("engine.js — mount and destroy leave nothing behind", () => {
  for (const [name, size] of [["story (phone 390x844)", { w: 390, h: 844 }], ["story (tablet 820x1180)", { w: 820, h: 1180 }], ["story (desktop 1440x900)", { w: 1440, h: 900 }], ["stacked (375x667)", { w: 375, h: 667 }]]) {
    it(`${name}: mount → destroy → mount → destroy: zero listeners, timers, frames, observers; the DOM as React rendered it`, () => {
      const e = setup(size);
      const before = e.root.outerHTML;
      for (let n = 0; n < 2; n++) {
        const destroy = mountLanding(e.root);
        expect(e.root.classList.contains("js")).toBe(true);
        expect(e.listeners()).toBeGreaterThan(0);
        // a scroll with work queued: the frame, the clock pacing, the leave timers, the jump watch
        e.setY(1800); window.dispatchEvent(new Event("scroll"));
        e.root.querySelector("#dnext").click();
        vi.advanceTimersByTime(50);
        if (e.root.classList.contains("story")) expect(vi.getTimerCount()).toBeGreaterThan(0);
        destroy();
        destroy(); // a second call is a no-op
        expect(e.listeners()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(e.liveObservers()).toBe(0);
        expect(window.__lp6).toBeUndefined();
        expect(e.root.outerHTML).toBe(before);
      }
      expect(document.documentElement.className).toBe(e.htmlClass); // nothing on <html>
    });
  }

  it("StrictMode's second mount starts from the pristine DOM (the first mount's classes and styles are gone)", () => {
    const e = setup();
    const d1 = mountLanding(e.root);
    expect(e.root.className).toBe("lp6 js motion story");
    expect(e.root.style.getPropertyValue("--trk")).not.toBe("");
    d1();
    expect(e.root.className).toBe("lp6");
    expect(e.root.getAttribute("style")).toBeNull();
    expect(e.root.querySelector("#prev").hidden).toBe(true);
    expect(e.root.querySelector("#snend").hasAttribute("inert")).toBe(true);
    expect(e.root.querySelector("#count").textContent).toBe("1 / 7");
    const d2 = mountLanding(e.root);
    expect(e.root.className).toBe("lp6 js motion story");
    d2();
  });

  it("fix round: a root rendered with .lp6-boot (transitions off) loses it after the first layout and gets it back on destroy", () => {
    for (const [size, mode] of [[{ w: 390, h: 844 }, "story"], [{ w: 820, h: 1180 }, "story"], [{ w: 1440, h: 900 }, "story"], [{ w: 375, h: 667 }, "stacked"], [{ w: 390, h: 844, reduced: true }, "reduced"]]) {
      const e = setup(size);
      e.root.classList.add("lp6-boot");
      const before = e.root.outerHTML;
      const destroy = mountLanding(e.root);
      expect([mode, e.root.classList.contains("js"), e.root.classList.contains("lp6-boot")]).toEqual([mode, true, false]);
      destroy();
      expect([mode, e.root.outerHTML === before]).toEqual([mode, true]);
    }
  });

  it("fix round: the snapshot holds every element the engine writes — every scene walked, both steppers 1 → 7 → 1, a resize, then destroy: the DOM as rendered", () => {
    // jsdom has no layout, so most of the sizes the engine writes come out NaN and are dropped (a second pass with every box
    // 300 x 120 adds the writes that need a size); the geometric writes (the screens' windows, the Vindue 2 label …) are walked
    // in a real browser by the lab's port-build/fixround/tools/snapshot_walk.mjs (every scene at 6 sizes, then destroy: the DOM as rendered).
    const runs = [];
    for (const sized of [false, true]) for (const size of [{ w: 390, h: 844 }, { w: 390, h: 700 }, { w: 820, h: 1180 }, { w: 1440, h: 900 }, { w: 375, h: 667 }]) runs.push([size, sized]);
    for (const [size, sized] of runs) {
      const e = setup(size);
      if (sized) {
        vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
        vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
      }
      const before = e.root.outerHTML;
      const touched = new Set();
      const mo = new MutationObserver(() => {});
      mo.observe(e.root, { subtree: true, attributes: true, childList: true, characterData: true });
      const destroy = mountLanding(e.root);
      const story = e.root.classList.contains("story");
      const end = story ? ((window.__lp6.geo().TOT + 100) * size.h) / 100 : 4000;
      for (let y = 0; y <= end + size.h; y += size.h / 8) { e.setY(y); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME); }
      vi.advanceTimersByTime(1500);
      e.setY(0); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME);
      for (const id of ["#dnext", "#next"]) {
        for (let n = 0; n < 7; n++) { e.root.querySelector(id).click(); vi.advanceTimersByTime(400); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME); }
        for (let n = 0; n < 7; n++) { e.root.querySelector(id === "#next" ? "#prev" : "#dprev").click(); vi.advanceTimersByTime(400); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME); }
      }
      window.dispatchEvent(new Event("resize")); vi.advanceTimersByTime(1500);
      for (const r of mo.takeRecords()) if (r.type === "attributes") touched.add(r.target);
      mo.disconnect();
      destroy();
      // not vacuous: the walk made the engine write on many elements (the root, bars, figures, the clock, the room's tables …)
      expect([size, sized, touched.size > (story ? 60 : 15)]).toEqual([size, sized, true]);
      expect([size, sized, e.root.outerHTML === before]).toEqual([size, sized, true]);
    }
  });

  it("the mode goes on the root: story on a tall phone, the stacked page on a short one or under reduced motion", () => {
    let e = setup({ w: 390, h: 844 });
    let d = mountLanding(e.root);
    expect([...e.root.classList]).toEqual(["lp6", "js", "motion", "story"]);
    expect(window.__lp6 && Object.isFrozen(window.__lp6)).toBe(true);
    expect(window.__lp6.warn).toEqual([]);
    expect(window.__lp6.geo()).toMatchObject({ desk: false, wide: false, TOT: 534 });
    d();
    e = setup({ w: 375, h: 667 });
    d = mountLanding(e.root);
    expect([...e.root.classList]).toEqual(["lp6", "js", "motion"]);
    expect(e.root.querySelector(".dk-nav").hidden).toBe(true); // the stacked page's bar has no stepper
    expect(window.__lp6).toBeUndefined(); // as in the prototype: the handle belongs to the pinned day
    d();
    expect(e.root.querySelector(".dk-nav").hidden).toBe(false);
    e = setup({ w: 390, h: 844, reduced: true });
    d = mountLanding(e.root);
    expect([...e.root.classList]).toEqual(["lp6", "js"]);
    expect(e.root.querySelector("[data-r]").classList.contains("in")).toBe(true); // shown at once, no reveal
    d();
  });

  it("queries stay inside the root: an app element with the same id is never touched", () => {
    const e = setup();
    const stray = document.createElement("div");
    stray.id = "count"; stray.textContent = "app";
    document.body.insertBefore(stray, e.root);
    const d = mountLanding(e.root);
    e.setY(5000); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(100);
    expect(stray.textContent).toBe("app");
    expect(stray.getAttribute("class")).toBeNull();
    d(); stray.remove();
  });

  it("window listeners (scroll, resize, load, pageshow) are counted, attached while mounted and released on destroy", () => {
    const e = setup();
    const d = mountLanding(e.root);
    const onWindow = () => [...e.live.keys()].filter(([t]) => t === window).map(([, type]) => type).sort();
    expect(onWindow()).toEqual(expect.arrayContaining(["load", "pageshow", "resize", "scroll"]));
    d();
    expect(onWindow()).toEqual([]);
  });

  it("matchMedia listeners: the nine re-layout queries are followed while mounted and released on destroy", () => {
    const e = setup();
    const d = mountLanding(e.root);
    expect(e.mqListeners()).toBe(9);
    d();
    expect(e.mqListeners()).toBe(0);
  });
});

describe("engine.js — the browser bar (theme-color)", () => {
  it("writes the stage's ground through setThemeColor, compares with the live <meta>, and puts the old value back on destroy", () => {
    const e = setup({ meta: "#ffffff" });
    const set = vi.fn((v) => document.querySelector('meta[name="theme-color"]').setAttribute("content", v));
    const d = mountLanding(e.root, { setThemeColor: set });
    expect(set).toHaveBeenLastCalledWith(LANDING_BAR.paper);
    expect(e.meta()).toBe("#f6f4ec");
    // the route's own sync writes over it after the layout effect (useThemeColorSync): the engine puts the stage's colour back
    document.querySelector('meta[name="theme-color"]').setAttribute("content", "#ffffff");
    vi.advanceTimersByTime(300);
    expect(e.meta()).toBe("#f6f4ec");
    // and on every tick it compares with the live value, not a cached one
    document.querySelector('meta[name="theme-color"]').setAttribute("content", "#ffffff");
    e.setY(10); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME);
    expect(e.meta()).toBe("#f6f4ec");
    const calls = set.mock.calls.length;
    e.setY(20); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME);
    expect(set.mock.calls.length).toBe(calls); // already right: no write
    d();
    expect(e.meta()).toBe("#ffffff");
    expect(LANDING_BAR).toEqual({ paper: "#f6f4ec", night: "#12281e" });
  });

  it("without a <meta> nothing breaks", () => {
    const e = setup({ meta: null });
    const d = mountLanding(e.root);
    d();
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
  });
});

describe("engine.js — the stepper on iOS: taps and jumps", () => {
  it("Næste taps < 250 ms after the last accepted one are merged; jumps are 'instant'", () => {
    const e = setup();
    const d = mountLanding(e.root);
    e.scrollTo.mockClear();
    const next = e.root.querySelector("#dnext");
    next.click();
    expect(e.scrollTo).toHaveBeenCalledTimes(1);
    expect(e.scrollTo.mock.calls[0][0]).toMatchObject({ behavior: "instant" });
    vi.advanceTimersByTime(60); next.click();
    vi.advanceTimersByTime(60); next.click();
    expect(e.scrollTo).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200); next.click(); // 320 ms after the first
    expect(e.scrollTo).toHaveBeenCalledTimes(2);
    d();
  });

  it("the h1 / index links jump without following the hash, through the same gate", () => {
    const e = setup();
    const d = mountLanding(e.root);
    e.scrollTo.mockClear();
    const a = e.root.querySelector("#hero a[data-go='2a']");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(e.scrollTo).toHaveBeenCalledTimes(1);
    const ev2 = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(true); // merged, and still no hash jump
    expect(e.scrollTo).toHaveBeenCalledTimes(1);
    d();
  });

  it("a jump Safari puts back (no finger down) is re-asserted once; a finger down waits for the touch to end", () => {
    const e = setup();
    const d = mountLanding(e.root);
    const next = e.root.querySelector("#dnext");
    // 1. no finger: the 150 ms check finds the page back at the start and jumps again, once
    e.setY(0); e.scrollTo.mockClear();
    next.click();
    const target = e.scrollTo.mock.calls[0][0].top;
    expect(target).toBeGreaterThan(0);
    vi.advanceTimersByTime(40); e.setY(0); // Safari's snap-back
    vi.advanceTimersByTime(200);
    expect(e.scrollTo).toHaveBeenCalledTimes(2);
    expect(e.scrollTo.mock.calls[1][0]).toEqual({ top: target, behavior: "instant" });
    vi.advanceTimersByTime(300); e.setY(0); vi.advanceTimersByTime(400);
    expect(e.scrollTo).toHaveBeenCalledTimes(2); // once only
    // 2. a finger down while it snaps back: nothing until the touch ends, then once
    vi.advanceTimersByTime(1000); e.setY(0); e.scrollTo.mockClear();
    next.click();
    vi.advanceTimersByTime(40);
    document.dispatchEvent(Object.assign(new Event("touchstart"), { touches: [{}] }));
    e.setY(0);
    vi.advanceTimersByTime(160);
    expect(e.scrollTo).toHaveBeenCalledTimes(1);
    document.dispatchEvent(Object.assign(new Event("touchend"), { touches: [] }));
    vi.advanceTimersByTime(FRAME);
    expect(e.scrollTo).toHaveBeenCalledTimes(2);
    // 3. a scroll by hand somewhere else is left alone
    vi.advanceTimersByTime(1000); e.setY(0); e.scrollTo.mockClear();
    next.click();
    vi.advanceTimersByTime(40); e.setY(300);
    vi.advanceTimersByTime(400);
    expect(e.scrollTo).toHaveBeenCalledTimes(1);
    d();
  });
});

describe("engine.js — a mount that fails half-way", () => {
  it("leaves the static page as rendered, removes what it added, and reports the error", () => {
    const e = setup();
    e.root.querySelector("#clock").remove();
    const before = e.root.outerHTML;
    const onError = vi.fn();
    const d = mountLanding(e.root, { onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(e.root.outerHTML).toBe(before);
    expect(e.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(window.__lp6).toBeUndefined();
    d();
  });
});

describe("engine.js — the debug hooks (hardening round): window.__lp6 and window.__perf only in a dev build or with ?lp6debug", () => {
  const scrollSome = (e) => { for (let y = 300; y <= 1500; y += 300) { e.setY(y); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME); } };

  it("a production build without ?lp6debug: no window.__lp6, and the ticks never touch window.__perf", () => {
    debugAddress(false);
    expect(import.meta.env.DEV).toBe(false);
    expect(debugHooksOn()).toBe(false);
    const e = setup();
    window.__perf = [];
    const d = mountLanding(e.root);
    expect(e.root.classList.contains("story")).toBe(true); // the pinned day, where the handle used to be set
    scrollSome(e);
    expect("__lp6" in window).toBe(false);
    expect(window.__perf).toEqual([]);
    d();
    expect("__lp6" in window).toBe(false);
  });

  it("?lp6debug turns them on in a production build: the frozen handle while mounted, one timing per tick on a real array", () => {
    expect(debugHooksOn()).toBe(true);
    const e = setup();
    window.__perf = [];
    const d = mountLanding(e.root);
    expect(window.__lp6 && Object.isFrozen(window.__lp6)).toBe(true);
    expect(Object.keys(window.__lp6).sort()).toEqual(["geo", "scn", "warn"]);
    const first = window.__perf.length;
    expect(first).toBeGreaterThanOrEqual(1); // the first layout's tick
    scrollSome(e);
    expect(window.__perf.length).toBeGreaterThan(first);
    expect(window.__perf.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
    d();
    expect(window.__lp6).toBeUndefined();
  });

  it("a dev build turns them on without the parameter", () => {
    debugAddress(false);
    vi.stubEnv("DEV", true);
    expect(debugHooksOn()).toBe(true);
    const e = setup();
    const d = mountLanding(e.root);
    expect(window.__lp6 && Object.isFrozen(window.__lp6)).toBe(true);
    d();
    expect(window.__lp6).toBeUndefined();
  });

  it("the parameter is looked up by name: ?lp6debug, ?lp6debug=1, ?x=1&lp6debug — not in a value, a fragment or a longer name", () => {
    for (const [address, on] of [["/?lp6debug", true], ["/?lp6debug=1", true], ["/?x=1&lp6debug", true], ["/?x=lp6debug", false], ["/#lp6debug", false], ["/?lp6debugger", false], ["/?LP6DEBUG", false], ["/", false]]) {
      window.history.replaceState(null, "", address);
      expect([address, debugHooksOn()]).toEqual([address, on]);
    }
  });

  it("tick() pushes only onto a real array: anything else in window.__perf is left alone and nothing throws", () => {
    for (const perf of [{ push: vi.fn() }, "not an array", 7, true, null, { length: 0 }]) {
      const e = setup();
      window.__perf = perf;
      const errors = [];
      const d = mountLanding(e.root, { onError: (err) => errors.push(err) });
      expect(() => scrollSome(e)).not.toThrow();
      expect(errors).toEqual([]);
      if (perf && typeof perf.push === "function") expect(perf.push).not.toHaveBeenCalled();
      expect(window.__perf).toBe(perf);
      d();
    }
  });
});

describe("note 22: a re-mount that carries the reader's place settles its first layout before transitions come back", () => {
  it("settle: the bar turned on in the first layout is resolved by a layout read while .lp6-boot is on, then the class comes off; a first load: no read in between", () => {
    for (const settle of [true, false]) {
      const e = setup();
      e.root.classList.add("lp6-boot"); // as React renders the root
      // mid-day, the bar up: every box moves up with the page, the footer far below
      e.setY(1800);
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () { const t = (this.id === "foot" ? 50000 : 0) - window.scrollY; return { x: 0, y: t, top: t, bottom: t, left: 0, right: 0, width: 0, height: 0 }; });
      const seq = [];
      const dockCl = e.root.querySelector("#dock").classList, rootCl = e.root.classList;
      const oh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () { if (this === e.root) seq.push("layout read"); return oh.get.call(this); });
      const tog = DOMTokenList.prototype.toggle, rem = DOMTokenList.prototype.remove;
      vi.spyOn(DOMTokenList.prototype, "toggle").mockImplementation(function (t, f) { const r = tog.call(this, t, f); if (this === dockCl && t === "on") seq.push(`bar on=${r}`); return r; });
      vi.spyOn(DOMTokenList.prototype, "remove").mockImplementation(function (...t) { if (this === rootCl && t.includes("lp6-boot")) seq.push("boot off"); return rem.apply(this, t); });
      const destroy = mountLanding(e.root, { settle });
      // the bar went up in the first layout; with settle a layout read follows it, and only then do transitions come back
      expect([settle, seq]).toEqual([settle, settle ? ["bar on=true", "layout read", "boot off"] : ["bar on=true", "boot off"]]);
      destroy();
    }
  });
});

describe("first-screen + hero-group rounds (23 Oct): layout() hangs the two-column hero from the plate's top edge and sits its block on the roster card, and only there", () => {
  // the hero's four parts as the built page lays them out at 1440 × 900 (recorded in headless Chromium; landingV6FirstScreen.test.js):
  // [offsetTop from the hero's content top, offsetHeight, font-size, line-height]; the frame's padding (the plate's top edge) 112 / 36;
  // the roster as placed in the plate (offsetTop 282 in the frame, 383 tall: the card is the whole figure) and --sec 128 px
  const PARTS = { ".h1": [0, 317, 108, 105.84], ".sub": [345, 58, 20, 29], ".cta-row": [439, 52, 19, 28.5], ".trial": [503, 46, 16, 23.2] };
  function laidOut(e) {
    const hero = e.root.querySelector("#hero");
    hero.insertAdjacentHTML("beforeend", '<p class="sub">s</p><p class="trial">t</p>');
    hero.append(hero.querySelector(".cta-row"), hero.querySelector(".trial")); // h1, sub, cta-row, trial, as Hero.jsx renders them
    const css = new Map([[e.root.querySelector("#frame"), { paddingTop: "112px", paddingBottom: "36px" }], [hero, { paddingTop: "0px" }]]);
    for (const [sel, [top, h, fs, lh]] of Object.entries(PARTS)) {
      const el = hero.querySelector(sel);
      Object.defineProperty(el, "offsetTop", { configurable: true, get: () => top });
      Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => h });
      css.set(el, { fontSize: fs + "px", lineHeight: lh + "px" });
    }
    const roster = e.root.querySelector("#roster"), card = roster.querySelector(".ro");
    for (const [el, top, h] of [[roster, 282, 383], [card, 0, 383]]) {
      Object.defineProperty(el, "offsetTop", { configurable: true, get: () => top });
      Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => h });
    }
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, p) => {
      const c = real(el, p), o = css.get(el);
      if (el === e.root) return new Proxy(c, { get: (t, k) => (k === "getPropertyValue" ? (n) => (n === "--sec" ? "128px" : t.getPropertyValue(n)) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
      return o ? new Proxy(c, { get: (t, k) => (k in o ? o[k] : typeof t[k] === "function" ? t[k].bind(t) : t[k]) }) : c;
    });
    return hero;
  }

  it("1440 × 900: --hero-top puts the headline's cap top on the crop marks' line; --hero-a1 puts the trial line's last baseline on the card's bottom edge", () => {
    const e = setup({ w: 1440, h: 900 });
    const hero = laidOut(e);
    const destroy = mountLanding(e.root);
    vi.advanceTimersByTime(FRAME);
    expect(e.root.classList.contains("story")).toBe(true);
    // the same values the built page wrote in Chromium at 1440 × 900 (98 = 112 − the cap's 13.6 px under the line box's top;
    // 23 = the card's bottom 665 − the trial line's last baseline 641.7 with no air), and no second air row
    expect(["--hero-top", "--hero-a1", "--hero-a2"].map((k) => hero.style.getPropertyValue(k))).toEqual(["98px", "23px", ""]);
    expect(hero.style.getPropertyValue("--hero-pull")).toBe("");
    destroy();
  });

  it("1440 × 900: the card's bottom edge is read where the engine placed the roster, with its scale (a card 100 px lower: 100 px more air)", () => {
    const e = setup({ w: 1440, h: 900 });
    const hero = laidOut(e);
    Object.defineProperty(e.root.querySelector("#roster"), "offsetTop", { configurable: true, get: () => 382 });
    const destroy = mountLanding(e.root);
    vi.advanceTimersByTime(FRAME);
    expect(hero.style.getPropertyValue("--hero-a1")).toBe("123px");
    destroy();
  });

  it("the one-column tablet (820 × 1180) and the phone: no --hero-top and no air rows, only the stage's pull", () => {
    for (const size of [{ w: 820, h: 1180 }, { w: 390, h: 844 }]) {
      const e = setup(size);
      const hero = laidOut(e);
      const destroy = mountLanding(e.root);
      vi.advanceTimersByTime(FRAME);
      expect(["--hero-top", "--hero-a1", "--hero-a2"].map((k) => hero.style.getPropertyValue(k))).toEqual(["", "", ""]);
      expect(hero.style.getPropertyValue("--hero-pull")).not.toBe("");
      destroy();
    }
  });
});

/* ───────────── polish round (23 Oct; Manoj's iPhone, Safari and Brave) ───────────── */
const at = (e, id, f) => { const g = window.__lp6.geo(), i = g.SEG.findIndex((x) => x[0] === id); return g.pin + ((g.ACC[i] + g.SEG[i][1] * f) * g.svh) / 100; };
const scrollAt = (e, y) => { e.setY(Math.round(y)); window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME); };
/* the track as tall as the browser lays it out (jsdom has no layout: TOT + 100 svh), so the night and the morning sheet happen */
const tallTrack = (e, h, tot) => Object.defineProperty(e.root.querySelector("#track"), "offsetHeight", { configurable: true, get: () => Math.round(((tot + 100) * h) / 100) });

describe("polish round, item 1: 19.45 opens on the room — the 12.30 booking never shows again and never flies", () => {
  for (const size of [{ w: 390, h: 844 }, { w: 820, h: 1180 }, { w: 1440, h: 900 }]) {
    it(`${size.w} × ${size.h}: every moment of 19.45 is the room with Vindue 2 seated, ringed, named and online, and the seated aside; the counter says 4 / 7`, () => {
      const e = setup(size);
      const d = mountLanding(e.root);
      const $ = (s) => e.root.querySelector(s);
      const wide = size.w >= 768;
      // 12.30 still shows its card (the one the layout uses)
      scrollAt(e, at(e, "2a", 0.45));
      expect($(wide ? "#bookw" : "#booking").classList.contains("on")).toBe(true);
      for (const f of [0.002, 0.01, 0.05, 0.1, 0.2, 0.34, 0.5, 0.74, 0.99]) {
        scrollAt(e, at(e, "S", f));
        vi.advanceTimersByTime(700); // every leave timer has run
        const state = {
          f, beat: $("#frame").dataset.beat, count: $("#dcount").textContent, frameCount: $("#count").textContent,
          cards: ["#booking", "#bookw"].map((s) => $(s).className.split(" ").filter((c) => c === "on" || c === "out" || c === "fly")),
          room: ["on", "v2", "wait", "land"].filter((c) => $("#room").classList.contains(c)), st: $("#room").getAttribute("data-st"),
          v2: [$("#t-v2").getAttribute("data-s"), $("#t-v2").classList.contains("on")],
          asides: [...e.root.querySelectorAll("#c2 .aside.on")].map((a) => a.dataset.b),
        };
        expect(state).toEqual({ f, beat: "S", count: "4 / 7", frameCount: "4 / 7", cards: [[], []], room: ["on", "v2"], st: null, v2: ["seat", true], asides: ["S"] });
      }
      // nothing in the page carries the flight's classes or properties
      expect(e.root.querySelectorAll(".fly, .wait, .land, .booking-any")).toHaveLength(0);
      for (const s of ["#booking", "#bookw"]) expect($(s).style.getPropertyValue("--fly-x")).toBe("");
      // 21.15 still hands over to the tablet line, 22.50 is still the cut onto the stand
      scrollAt(e, at(e, "B", 0.9));
      expect([...e.root.querySelectorAll("#c2 .aside.on")].map((a) => a.dataset.b)).toEqual(["B2"]);
      expect($("#room").classList.contains("v2")).toBe(false);
      scrollAt(e, at(e, "2b", 0.6));
      expect($("#room").getAttribute("data-st")).toBe("cut");
      d();
    });
  }

  it("Næste from 3 / 7 lands on 4 / 7 = 19.45 with the room already on (NAV / SCN unchanged)", () => {
    const e = setup();
    const d = mountLanding(e.root);
    scrollAt(e, at(e, "1b", 0.5));
    expect(e.root.querySelector("#dcount").textContent).toBe("3 / 7");
    vi.advanceTimersByTime(400);
    e.root.querySelector("#dnext").click();
    vi.advanceTimersByTime(FRAME);
    window.dispatchEvent(new Event("scroll")); vi.advanceTimersByTime(FRAME);
    expect([e.root.querySelector("#frame").dataset.beat, e.root.querySelector("#dcount").textContent]).toEqual(["S", "4 / 7"]);
    expect(Math.abs(window.scrollY - Math.round(at(e, "S", 0.74)))).toBeLessThan(2);
    expect(e.root.querySelector("#booking").classList.contains("on")).toBe(false);
    expect(e.root.querySelector("#room").classList.contains("on")).toBe(true);
    d();
  });
});

describe("polish round, item 4: the bottom bar sits on the real bottom edge; what shows past the page is the ground", () => {
  /* Safari / Brave collapse their bars: innerHeight grows, the small viewport (#probe) stays — the engine's cheap path */
  function collapse(e, h0, h1) {
    Object.defineProperty(window, "innerHeight", { value: h1, configurable: true });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(FRAME);
  }
  function smallViewport(e, h0) {
    Object.defineProperty(e.root.querySelector("#probe"), "offsetHeight", { configurable: true, get: () => h0 });
    e.root.querySelector("#clock").style.fontSize = "64px"; // a real size, so the clock is not "changed" by the resize
  }

  it("402 × 780 → 874 (bars collapse) at 1 / 7, 4 / 7 and 7 / 7: no lift (no --dkb), the bar's resting top is the new innerHeight's bottom", () => {
    for (const place of [["1a", 0.5], ["S", 0.74], ["3b", 0.62]]) {
      const e = setup({ w: 402, h: 780 });
      smallViewport(e, 780); tallTrack(e, 780, 534);
      const d = mountLanding(e.root);
      const dock = e.root.querySelector("#dock");
      scrollAt(e, at(e, ...place));
      expect(dock.style.getPropertyValue("--t")).toBe("780px");
      collapse(e, 780, 874);
      expect([place[0], dock.style.getPropertyValue("--dkb"), dock.style.getPropertyValue("--t")]).toEqual([place[0], "", "874px"]); // the bar's own height is 0 in jsdom
      expect(window.__lp6.geo().svh).toBe(780); // no re-layout: the stage stays laid out in the small viewport
      d();
    }
  });

  it("data-gb follows the ground at the viewport's bottom edge: paper, night once the edge has risen past it, paper again under the morning sheet", () => {
    const e = setup({ w: 390, h: 844 });
    tallTrack(e, 844, 534);
    const d = mountLanding(e.root);
    const gb = () => e.root.getAttribute("data-gb");
    scrollAt(e, at(e, "1a", 0.5));
    expect(gb()).toBe("paper");
    scrollAt(e, at(e, "A", 0.06)); // the edge has just come up from the bottom: the bottom is night, the top still paper
    expect([gb(), e.root.getAttribute("data-g"), e.root.classList.contains("xing")]).toEqual(["night", "paper", true]);
    scrollAt(e, at(e, "S", 0.74));
    expect([gb(), e.root.getAttribute("data-g")]).toEqual(["night", "night"]);
    scrollAt(e, at(e, "end", 0.6)); // the sheet has risen past the bottom
    expect(gb()).toBe("paper");
    d();
    expect(e.root.hasAttribute("data-gb")).toBe(false); // restored on destroy
  });
});

describe("polish round, item 3: no per-frame work the scroll does not need", () => {
  const LAYOUT_READS = [["Element", "getBoundingClientRect"], ["Element", "getClientRects"]];
  const LAYOUT_GETTERS = ["offsetTop", "offsetLeft", "offsetWidth", "offsetHeight", "offsetParent"];
  const ELEMENT_GETTERS = ["scrollWidth", "scrollHeight", "clientWidth", "clientHeight", "scrollTop"];

  for (const size of [{ w: 390, h: 844 }, { w: 820, h: 1180 }, { w: 1440, h: 900 }]) {
    it(`${size.w} × ${size.h}: a scroll by hand through the whole day and back reads no layout in the tick (getBoundingClientRect, offset*, client*, scroll*, getComputedStyle)`, () => {
      const e = setup(size);
      tallTrack(e, size.h, size.w >= 1024 ? 564 : 534);
      const d = mountLanding(e.root);
      vi.advanceTimersByTime(400);
      const reads = [];
      for (const [, m] of LAYOUT_READS) vi.spyOn(Element.prototype, m).mockImplementation(function () { reads.push(m); return { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, length: 0 }; });
      for (const g of LAYOUT_GETTERS) { const o = Object.getOwnPropertyDescriptor(HTMLElement.prototype, g); vi.spyOn(HTMLElement.prototype, g, "get").mockImplementation(function () { reads.push(g); return o.get.call(this); }); }
      for (const g of ELEMENT_GETTERS) { const o = Object.getOwnPropertyDescriptor(Element.prototype, g); vi.spyOn(Element.prototype, g, "get").mockImplementation(function () { reads.push(g); return o.get.call(this); }); }
      const gcs = window.getComputedStyle;
      vi.spyOn(window, "getComputedStyle").mockImplementation((...a) => { reads.push("getComputedStyle"); return gcs(...a); });
      const end = window.__lp6.geo().pin + ((window.__lp6.geo().TOT + 100) * size.h) / 100;
      for (let y = 0; y <= end; y += size.h / 23) scrollAt(e, y); // ~2 % of a screen per frame: every beat, both edges, 1 → 7 / 7
      for (let y = end; y >= 0; y -= size.h / 23) scrollAt(e, y);
      vi.advanceTimersByTime(1500); // the clock pacing and the leave timers, too
      expect(reads).toEqual([]);
      vi.restoreAllMocks();
      d();
    });
  }

  const SPLIT_FRAME = ".frame .sx,.frame .sbg,.frame .cm,.frame .xb,.frame .bt";
  /* a laid-out stage (jsdom has none): every split element has its own box, 24 px tall, one under the other from 100 px */
  function laidOutSplit(e) {
    const els = [...e.root.querySelectorAll(SPLIT_FRAME)], top = new Map(els.map((el, i) => [el, 100 + i * 8]));
    const op = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent"), ot = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop"), oh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function () { return top.has(this) ? e.root.querySelector("#frame") : op.get.call(this); });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function () { return top.has(this) ? top.get(this) : ot.get.call(this); });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () { return top.has(this) ? 24 : oh.get.call(this); });
    return { els, top };
  }
  it("the night edge rising over the stage is written only on the stage's elements it runs through, never on the frame (390 × 844)", () => {
    const e = setup({ w: 390, h: 844 });
    tallTrack(e, 844, 534);
    const { els, top } = laidOutSplit(e);
    const d = mountLanding(e.root);
    const frameEl = e.root.querySelector("#frame");
    const writes = [];
    const sp = CSSStyleDeclaration.prototype.setProperty;
    // which element a declaration belongs to: every split element's style object, the frame's and the two bars'
    const owner = new Map([...els, frameEl, e.root.querySelector("#top-bar"), e.root.querySelector("#dock")].map((el) => [el.style, el]));
    vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (p, v, pr) { if (p === "--e" && owner.has(this)) writes.push([owner.get(this), v]); return sp.call(this, p, v, pr); });
    const perFrame = [];
    for (let f = 0.04; f <= 0.4; f += 0.004) { writes.length = 0; scrollAt(e, at(e, "A", f)); perFrame.push(writes.filter(([el]) => el !== frameEl && els.includes(el)).length); expect(writes.some(([el]) => el === frameEl)).toBe(false); }
    // the crossing happened (the bars got the edge), the stage's split elements were written, and after the first frame
    // of the crossing (every element below the edge, once) at most a few per frame: those it runs through
    expect(perFrame.some((n) => n > 0)).toBe(true);
    expect(Math.max(...perFrame.slice(perFrame.findIndex((n) => n > 0) + 1))).toBeLessThanOrEqual(8);
    // slot a above the edge, slot b below it, the edge itself on an element it runs through
    scrollAt(e, at(e, "A", 0.2));
    const eNow = parseFloat(e.root.querySelector("#top-bar").style.getPropertyValue("--e"));
    for (const el of els) {
      const t = top.get(el), v = el.style.getPropertyValue("--e");
      expect([t, v]).toEqual([t, eNow >= t + 24 ? "99999px" : eNow <= t ? "-99999px" : Math.round(eNow) + "px"]);
    }
    vi.restoreAllMocks();
    d();
  });

  it("the paper edge rising at the end (the morning sheet) writes nothing on the stage: the sheet covers it below the edge", () => {
    const e = setup({ w: 390, h: 844 });
    tallTrack(e, 844, 534);
    const { els } = laidOutSplit(e);
    const d = mountLanding(e.root);
    scrollAt(e, at(e, "A", 0.2)); // the night's own crossing wrote the stage (so the stage is not simply never written)
    expect(els.some((el) => el.style.getPropertyValue("--e") !== "")).toBe(true);
    scrollAt(e, at(e, "3b", 0.62));
    const before = els.map((el) => el.style.getPropertyValue("--e"));
    let crossed = false;
    for (let f = 0.02; f <= 1; f += 0.02) { scrollAt(e, at(e, "end", f)); crossed = crossed || (e.root.classList.contains("xing") && e.root.getAttribute("data-x") === "np"); }
    expect(crossed).toBe(true);
    expect(els.map((el) => el.style.getPropertyValue("--e"))).toEqual(before);
    expect(e.root.querySelector("#frame").style.getPropertyValue("--e")).toBe("");
    vi.restoreAllMocks();
    d();
  });

  it("the desktop hand-over writes --lp6-hin on the left column's eight parts, never on the frame; the drawing's --lp6-draw goes on its drawn groups, never on the svg", () => {
    const e = setup({ w: 1440, h: 900 });
    tallTrack(e, 900, 564);
    const d = mountLanding(e.root);
    const frameEl = e.root.querySelector("#frame"), svg = e.root.querySelector(".room-svg");
    scrollAt(e, at(e, "h", 0.6));
    expect(frameEl.style.getPropertyValue("--hin") + frameEl.style.getPropertyValue("--lp6-hin")).toBe("");
    const parts = ["#aften-h", "#ix", "#date", "#clock", "#snav", "#c1", "#c2", "#c3"].map((s) => e.root.querySelector(s).style.getPropertyValue("--lp6-hin"));
    expect(new Set(parts).size).toBe(1);
    expect(+parts[0]).toBeGreaterThan(0);
    for (const f of [0.1, 0.2, 0.3, 0.4]) {
      scrollAt(e, at(e, "A", f));
      expect(svg.style.getPropertyValue("--lp6-draw")).toBe("");
    }
    scrollAt(e, at(e, "S", 0.5)); // past the passage: drawn (jsdom has no room geometry, so the passage's own values are NaN here)
    const groups = [...svg.querySelectorAll(".shell, .t .base")];
    expect(groups.length).toBe(13);
    expect(new Set(groups.map((g) => g.style.getPropertyValue("--lp6-draw")))).toEqual(new Set(["1.220"]));
    d();
  });

  it("the 22.50 flight is the room-box's own transform (a compositor animation), with the strokes' scale beside it", () => {
    const e = setup({ w: 390, h: 844 });
    const d = mountLanding(e.root);
    const rbox = e.root.querySelector("#roombox");
    scrollAt(e, at(e, "S", 0.5));
    expect(rbox.style.transform).toBe("translate(0px,0px) scale(1)");
    scrollAt(e, at(e, "2b", 0.6));
    expect(rbox.style.transform).toMatch(/^translate\(.+px,.+px\) scale\(.+\)$/);
    expect(rbox.style.getPropertyValue("--lp6-k")).not.toBe("");
    expect(rbox.style.getPropertyValue("--lp6-bx") + rbox.style.getPropertyValue("--lp6-by")).toBe("");
    d();
  });

  it("a scroll frame inside a resting scene writes nothing but what moved (unchanged values are skipped)", () => {
    for (const size of [{ w: 390, h: 844 }, { w: 1440, h: 900 }]) {
      const e = setup(size);
      tallTrack(e, size.h, size.w >= 1024 ? 564 : 534);
      const d = mountLanding(e.root);
      for (const [id, f] of [["1a", 0.5], ["S", 0.5], ["B", 0.1], ["3b", 0.5]]) {
        scrollAt(e, at(e, id, f)); vi.advanceTimersByTime(1000);
        const mo = new MutationObserver(() => {});
        mo.observe(e.root, { subtree: true, attributes: true, characterData: true, childList: true });
        for (let k = 1; k <= 3; k++) scrollAt(e, at(e, id, f) + k); // 1 px a frame
        vi.advanceTimersByTime(1000);
        // at most the two progress lines (--p, written only when its 3-decimal value moves)
        const touched = [...new Set(mo.takeRecords().map((r) => r.target.id || r.target.className))];
        expect([size.w, id, touched.filter((t) => t !== "prog" && t !== "dprog")]).toEqual([size.w, id, []]);
        mo.disconnect();
      }
      d();
    }
  });
});

describe("polish round: the frame meter (?lp6debug=fps), for measuring on a device or the Simulator", () => {
  it("?lp6debug=fps: a corner box on the body that counts frames; gone on destroy, with nothing left behind", () => {
    window.history.replaceState(null, "", "/?lp6debug=fps");
    const e = setup();
    const d = mountLanding(e.root);
    const box = document.querySelector("[data-lp6-fps]");
    expect(box && box.parentElement).toBe(document.body);
    expect(box.getAttribute("aria-hidden")).toBe("true");
    for (let y = 0; y < 3000; y += 60) scrollAt(e, y);
    vi.advanceTimersByTime(600);
    expect(box.textContent).toMatch(/^frames \d+\/2s {2}p95 [\d.]+ ms\ndropped 2s \d+ {2}all \d+\/\d+$/);
    expect(+box.textContent.match(/all \d+\/(\d+)/)[1]).toBeGreaterThan(0); // frames painted while scrolling were counted
    d();
    expect(document.querySelector("[data-lp6-fps]")).toBeNull();
    expect(e.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("not without it: ?lp6debug alone, another value, no parameter, or a production build without the debug switch", () => {
    for (const [address, dev] of [["/?lp6debug", false], ["/?lp6debug=1", false], ["/?fps", false], ["/", false], ["/", true], ["/?x=fps", true]]) {
      window.history.replaceState(null, "", address);
      vi.stubEnv("DEV", dev);
      const e = setup();
      const d = mountLanding(e.root);
      expect([address, dev, document.querySelector("[data-lp6-fps]")]).toEqual([address, dev, null]);
      d();
    }
    vi.stubEnv("DEV", false);
  });

  it("a dev build turns it on with the parameter", () => {
    window.history.replaceState(null, "", "/?lp6debug=fps");
    vi.stubEnv("DEV", true);
    const e = setup();
    const d = mountLanding(e.root);
    expect(document.querySelector("[data-lp6-fps]")).not.toBeNull();
    d();
    expect(document.querySelector("[data-lp6-fps]")).toBeNull();
  });
});
