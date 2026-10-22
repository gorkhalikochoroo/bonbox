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
 *   - a mount that fails half-way leaves the static page and reports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RoomSvg from "../components/landing/v6/RoomSvg";
import { mountLanding, LANDING_BAR } from "../components/landing/v6/engine";

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
<div class="copy sc" id="c2"><h3 class="label sx f3">l</h3><p class="line"><span class="s s1 sx">s1</span></p><div class="asides"><p class="aside note sx f2" data-b="2a A2 S0">n</p><p class="aside note sx f2" data-b="S">n</p><p class="aside note sx f2" data-b="B2">n</p><p class="aside note sx f2" data-b="2b C">n</p></div></div>
<div class="copy sc" id="c3"><h3 class="label sx f3">l</h3><p class="line"><span class="s s1 sx">s1</span></p><div class="asides"><p class="aside note sx f2" data-b="3a">n</p><p class="aside note sx f2" data-b="3b end">n</p></div></div>
<article class="ch" id="s1">${fig("roster", "roster on", '<div class="ro">r</div>')}${fig("uge", "card uge dk-only")}</article>
<article class="ch" id="s2">${fig("booking", "card booking booking-any ph-only", '<span class="scr"><img alt=""></span>')}${fig("bookw", "card bookw booking-any wd-only")}</article>
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
beforeEach(() => { delete window.__lp6; });
afterEach(teardown);

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
