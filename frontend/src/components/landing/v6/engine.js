/* The v6 landing's scroll engine (PORT_PLAN 1.4): the v6.3 prototype's inline script, ported to a module that mounts on the
 * page's root and leaves nothing behind.
 *
 *   const destroy = mountLanding(root, { setThemeColor });   // in LandingV6Page's useLayoutEffect
 *   …
 *   destroy();                                                // unmount, StrictMode's second pass, a language re-key
 *
 * Source: bonbox-lab-state/landing-v4-2026-10-21/final/site/tools/src.html (v6.3, sha256 852247b0f613ecf1…; port-build/inputs.txt),
 * the <head> mode script and the <script> after the footer. Band maths, fit(), pair(), shrink(), the guard and its re-layout,
 * clock pacing, the edge split, the dock lift, the v6.2 re-layout triggers (#probe = 100svh, the clock's font size, the
 * height breakpoints, ResizeObserver, fonts.load + loadingdone, KEEP) and the v6.3 instant jumps, step queue and end-beat
 * bar rule are the prototype's, unchanged. What the port changes, and only this:
 *   1. Root: the mode classes (js motion story cramp xing cta-past dock-on), data-x, data-g and --e --trk --bt --bc --bm --slot
 *      go on root (the .lp6 div), every query is root-scoped (an app element with the same id is never picked up).
 *   2. The head script's mode test runs first, inside the layout effect, so the first paint is already the story layout.
 *   3. A ledger: every listener (on), timer (later), frame (frame), observer and animation is recorded; destroy() removes,
 *      clears, cancels and disconnects all of them.
 *   4. alive: promise callbacks (fonts.ready / fonts.load) and queued timers / frames do nothing after destroy().
 *   5. No expandos: el._on, el._t, d._c and room._rt live in per-mount Maps / variables.
 *   6. Snapshot / restore: the attributes the engine writes (class, style, hidden, inert, tabindex, aria-current, data-s,
 *      data-beat, data-x, data-g, data-st) on every element it writes to (SNAP_SEL, plus the root), and the text it writes
 *      (clock digits, counters, Z-bon amounts), are recorded before the first write and put back by destroy(), so a second
 *      mount (StrictMode, a language re-key) starts from the DOM React rendered. (Fix round: only those elements, not every
 *      element under root, the room's ~400 SVG nodes included; landingV6Engine.test.jsx walks every scene and compares.)
 *   7. Jumps use behavior 'instant' (the app's html has scroll-behavior: smooth; landingV6.css also turns it off on the page).
 *   8. The browser bar: edge() writes theme-color through opts.setThemeColor and compares with the live <meta> value, not a
 *      cached one (useThemeColorSync may write after the engine); a check 300 ms after mount puts it right if so.
 *   9. window.__aft → window.__lp6 = { warn, scn, geo } (frozen, removed by destroy). The opt-in window.__perf hook stays.
 *      Hardening round (23 Oct): both exist only where debugHooksOn() says so — a dev build, or an address with ?lp6debug
 *      (the lab's probes; the tests set it). A production bundle without it has no window.__lp6 and never times a tick;
 *      tick() pushes onto window.__perf only when it is a real array.
 *  10. NAV / SCN stepping (nav.js) and the guard's maths (guard.js) are pure modules.
 *  11. Renames from the CSS port (step 3): .end → .lp6-end; --bx --by --k --draw → --lp6-bx --lp6-by --lp6-k --lp6-draw.
 *  12. iOS Safari (Simulator, 22 Oct ~07:50): stepper taps < 250 ms after the previous accepted tap count as one; after a jump,
 *      a snap-back to the pre-jump place while no finger is down is undone once (nav.js jumpCheck). A passive touchstart
 *      listener on the document also lets iOS apply the :active tap feedback (landingV6.css).
 *  13. A mount that fails half-way (markup out of step with the engine) undoes what it did, so the page stays the static,
 *      readable no-JS layout React rendered, and hands the error to opts.onError (default: rethrown on a timer, so it shows
 *      as an uncaught error in the console without breaking the React tree).
 *  14. Fix round (gate, 22 Oct): the root renders with .lp6-boot (every transition off, landingV6.css). The prototype set its
 *      mode classes in a <head> script before the figures existed; here they are added to a laid-out tree, so without it
 *      every hidden stage picture faded out from full opacity for .22 s at load and after a language switch. The engine
 *      takes .lp6-boot off after its first layout (whose reads computed every figure's style in its final mode), before the
 *      first paint, so the first screen's own entrance (the 10.00 roster's fade-in) still plays as in the prototype.
 *  15. Fix round: the fonts.ready re-layout is queued only while fonts are still loading after the first layout (when they
 *      are already in, it was a second full layout before the first paint); fonts.load + loadingdone still follow any face.
 *  16. Fix round: the phone clock's first-screen size (--fs-clock0) is read once per layout (G.c0), not in every scroll
 *      frame (a getComputedStyle there forced a style pass over the whole page in each tick). Every change of that token
 *      (a width or a height breakpoint) already re-lays out.
 *  17. Fix round: the moving edge (--e) is written on the top bar, the bottom bar and the frame (the only elements whose
 *      colours split at it, landingV6.css), not on the root, so a crossing restyles those three subtrees, not the page.
 *  18. Hardening round (23 Oct): a click on a [data-go] link with a modifier key or another mouse button (new tab, new
 *      window) is left to the browser. A plain click jumps, and the address bar then names that scene (nav.js SCENE_HASH,
 *      written over the current history entry, not as a new one, so Back still leaves the page), never a stale #pricing.
 *  19. Hardening round: opts.arrive (LandingV6Page: the scene an allow-listed address fragment names, /#s1 /#s2 /#s6, on
 *      its first visit) opens the page on that scene after the first layout, while the reader is still at the top.
 *  20. Hardening round: in the pinned day the frame carries data-bb-own-anchors: the app's ScrollManager (App.jsx) leaves an
 *      address fragment that points inside it to this engine (its scene articles sit in a sticky frame, where the browser's
 *      own scroll-to-element lands nowhere useful); on the stacked page the browser's scroll is the right one.
 *  21. Simulator round (iOS Safari, 23 Oct): a scene's address reached inside the page already on screen (typed into the
 *      bar, a plain link to /#s2, another app opening it in this tab, Back / Forward between such entries) changes only the
 *      fragment, with no reload. The browser's fragment-change and history-traversal events both report it; the engine reads
 *      the fragment then, after the browser's own scroll (on the next frame, so the pair is one jump), and when it is exactly
 *      one of nav.js SCENE_HASH's three strings it steps there as the index links do (instant jump, step queue). Anything
 *      else (#pricing, #faq, #foot …) is left to the browser and ScrollManager, as before. The engine's own address write
 *      (18) fires neither event. Both listeners are in the ledger.
 *  22. Simulator round: a mount that carries the reader's place (a language switch re-keys the page mid-way) settles its
 *      first layout while transitions are still off, so taking .lp6-boot off starts no transition on the re-keyed page.
 *      Without it, whatever the first layout changed after the engine's last layout read was left to the next style pass,
 *      the one that turns transitions back on: which of those changes then animate depends on the browser (Chromium,
 *      measured: the top bar's hairline faded in again; per the CSS, the bottom bar could slide up again from below and its
 *      stepper fade in, as the bar did on first showing). A first load keeps its entrance (14).
 *  23. Back fix (23 Oct): 21 stepped on every arrival at a scene's address, Back / Forward included, so a reader who opened
 *      /#s2 (or tapped a word that named it), went on to 7 / 7, tapped Priser or the logo (a new entry) and pressed Back was
 *      sent to scene 2 instead of their place (measured in Chromium, real taps). The address and the scroll position cannot
 *      tell Back from a new /#s2; the entry's own history state can. Once the engine has handled an entry at a scene's
 *      address (named it: 18; opened on it or kept its place on it: 19; stepped to it as a new address: 21) it adds
 *      nav.js LP6_MARK = that address to the entry's state (the router's keys kept, the same address, written over the
 *      entry, never pushed). A fragment change to an entry carrying the mark for its address is a return: no jump, the
 *      browser's own scroll restore puts the reader back. A new entry (typed, a plain link, another app) carries no state,
 *      so it still steps, once. Chosen over keeping the address on the current scene: #s6 names 6 and 7, so Back to a #s6
 *      entry left at 7 / 7 would still jump to 6 (measured), and skipping a jump to the scene the reader is already in
 *      would also skip a typed /#s6 at 7 / 7; it would also write the address on every scene change while scrolling. */
import { FLOOR } from "./floor.js";
import { NSC, SCN, NAV, NAVF, SCENE_HASH, LP6_MARK, sceneOfHash, buildTrack, seg as segAt, beatU, scnOf as scnAt, curScn as curScnAt, createStepper, goNext as nextJump, goPrev as prevJump, jumpCheck } from "./nav.js";
import { clearanceMisses, repairMiss, NOFIX } from "./guard.js";

/** The two grounds' browser-bar colours (the app writes theme-color in lower case). */
export const LANDING_BAR = Object.freeze({ paper: "#f6f4ec", night: "#12281e" });

const SNAP_ATTRS = ["class", "style", "hidden", "inert", "tabindex", "aria-current", "data-s", "data-beat", "data-x", "data-g", "data-st", "data-bb-own-anchors"];
const SNAP_TEXT = ".dg b,#count,#dcount,.zb dd";
/* the elements whose colour splits at the night edge (each learns its resting top, --t) */
const SPLIT_SEL = ".top .sx,.top .xb,.top .bt,.top .logo,.top .sbg,.dock .sx,.dock .xb,.dock .bt,.dock .sbg,.frame .sx,.frame .sbg,.frame .cm,.frame .xb,.frame .bt";
/* 6. every element under root the engine writes an attribute on (the root itself is added): the room (svg, tables, box, foot,
   the Vindue 2 label), the reveal rows, both bars (+ the bar's stepper row) and every split element, the night, the hero, the
   frame, its figures and their windows, the Z-bon rule, the clock digits, the statements (asides, links), the index, the stage
   nav, the progress bars. A new write on another element must add it here (the engine test's all-scenes walk goes red). */
const SNAP_SEL = [
  ".room-svg", ".room-svg .t[id]", "#room", "#roombox", "#roomfoot", "#v2l", "[data-r]",
  "#top-bar", "#dock", ".dk-nav", SPLIT_SEL, "#night", "#hero",
  "#frame", "#frame .fx", "#frame .plate", ".fx .win", "#zbline", "#clock", ".dg b",
  "#c1", "#c2", "#c3", ".copy.sc .aside", ".copy.sc a", ".ix a", ".ix a .w",
  "#snav", "#snend", "#snev", "#prev", "#dprev", "#prog", "#dprog",
].join(",");

const metaEl = () => (typeof document === "undefined" ? null : document.querySelector('meta[name="theme-color"]'));
const liveThemeColor = () => {
  const m = metaEl();
  return m ? (m.getAttribute("content") || "").toLowerCase() : null;
};
const writeThemeColor = (v) => {
  const m = metaEl();
  if (m) m.setAttribute("content", v);
};
const mm = (q) => {
  try { return window.matchMedia(q); } catch { return { matches: false }; }
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 9. The debug hooks (window.__lp6, window.__perf) are on in a dev build, or when the address has ?lp6debug. Vite writes
 *  import.meta.env.DEV as false into a production bundle; the try covers a bundle made without Vite (the lab's tools). */
export function debugHooksOn() {
  try { if (import.meta.env.DEV) return true; } catch { /* no Vite env */ }
  try { return new URLSearchParams(window.location.search).has("lp6debug"); } catch { return false; }
}

export function mountLanding(root, opts) {
  opts = opts || {};
  const setThemeColor = opts.setThemeColor || writeThemeColor;

  /* ───── ledger ───── */
  let alive = true;
  const undo = [], timers = new Set(), frames = new Set();
  function on(t, type, fn, o) {
    if (!t || !t.addEventListener) return;
    t.addEventListener(type, fn, o);
    undo.push(() => t.removeEventListener(type, fn, o));
  }
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); if (alive) fn(); }, ms);
    timers.add(id);
    return id;
  }
  function unlater(id) {
    if (id == null) return;
    clearTimeout(id);
    timers.delete(id);
  }
  function frame(fn) {
    const id = requestAnimationFrame((ts) => { frames.delete(id); if (alive) fn(ts); });
    frames.add(id);
    return id;
  }
  function mqOn(q, fn) {
    try {
      const m = window.matchMedia(q);
      if (m.addEventListener) on(m, "change", fn);
      else if (m.addListener) { m.addListener(fn); undo.push(() => m.removeListener(fn)); }
    } catch { /* no matchMedia: nothing to follow */ }
  }

  /* ───── snapshot (before the first write) ───── */
  const snapEls = [root, ...root.querySelectorAll(SNAP_SEL)].map((el) => [el, SNAP_ATTRS.map((a) => el.getAttribute(a))]);
  const snapText = [...root.querySelectorAll(SNAP_TEXT)].map((el) => [el, el.textContent]);
  const barAtMount = liveThemeColor();
  let barWrote = null;
  const handle = { current: null };
  const DEBUG = debugHooksOn();

  function destroy() {
    if (!alive) return;
    alive = false;
    while (undo.length) { try { undo.pop()(); } catch { /* a listener target that is gone */ } }
    timers.forEach((id) => clearTimeout(id)); timers.clear();
    frames.forEach((id) => cancelAnimationFrame(id)); frames.clear();
    for (const [el, vals] of snapEls) {
      SNAP_ATTRS.forEach((a, i) => {
        const v = vals[i];
        if (el.getAttribute(a) !== v) { if (v === null) el.removeAttribute(a); else el.setAttribute(a, v); }
      });
    }
    for (const [el, t] of snapText) if (el.textContent !== t) el.textContent = t;
    if (barWrote && barAtMount && liveThemeColor() === barWrote) setThemeColor(barAtMount);
    if (handle.current && window.__lp6 === handle.current) delete window.__lp6;
    ON.clear(); TO.clear(); CUR.clear();
  }
  const ON = new Map(), TO = new Map(), CUR = new Map(), anims = new Set();
  undo.push(() => { anims.forEach((a) => { try { a.cancel(); } catch { /* gone */ } }); anims.clear(); });

  /* a mount that fails half-way (markup out of step with the engine) leaves the static page as React rendered it, and reports */
  const report = opts.onError || ((err) => setTimeout(() => { throw err; }, 0));
  try { run(); } catch (err) { destroy(); report(err); }
  return destroy;

  function run() {
    /* ───── the head script: the page's mode, before the first paint ─────
       Story = the pinned day (one engine on every size; the editorial two columns on landscape screens from 1024 px).
       Phones need a tall screen; short phones, reduced motion and no-JS get the stacked page (same order, same two grounds, settled). */
    const R = root;
    {
      let rm = false;
      try { rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* old browser */ }
      R.classList.add("js");
      if (!rm) {
        R.classList.add("motion");
        const w = window.innerWidth, h = window.innerHeight, sh = Math.max(h, (window.screen && window.screen.height) || 0);
        if (h >= 600 && (w >= 600 || sh >= 740)) R.classList.add("story");
      }
    }
    const story = R.classList.contains("story"), motion = R.classList.contains("motion");
    const $ = (i) => root.querySelector("#" + i);
    const BIG = 99999, DQ = "(min-width:1024px) and (min-aspect-ratio:5/4)";
    const clamp = (a, v, b) => Math.max(a, Math.min(b, v));
    const now = () => performance.now();
    /* 7. a jump never animates, whatever the page's scroll-behavior */
    const jumpTo = (y) => { try { window.scrollTo({ top: y, behavior: "instant" }); } catch { window.scrollTo(0, y); } };

    /* iOS: is a finger down? (the jump re-assert waits for it); the passive listener also turns on :active feedback on iOS */
    let touchN = 0;
    const touches = (e) => { touchN = e.touches ? e.touches.length : 0; };

    /* the evening's tables (run.db via floor.json) */
    const T = FLOOR, tEls = T.map((t) => $("t-" + t.id)), roomSvg = root.querySelector(".room-svg"), room = $("room");
    function inAny(l, m) { for (let i = 0; i < l.length; i++) if (m >= l[i][0] && m < l[i][1]) return true; return false; }
    function roomAt(m) {
      let late = false;
      for (let i = 0; i < T.length; i++) {
        const t = T[i], e = tEls[i], s = inAny(t.lit, m) ? "seat" : inAny(t.late, m) ? "late" : inAny(t.up, m) ? "up" : "free";
        if (s === "late") late = true;
        if (e.getAttribute("data-s") !== s) e.setAttribute("data-s", s);
        e.classList.toggle("on", inAny(t.on, m));
      }
      roomSvg.classList.toggle("open", m >= 1020 && m < 1440); room.classList.toggle("has-late", late);
    }
    roomAt(1185);
    {
      const lf = root.querySelector(".door .leaf"), d = lf && lf.getAttribute("d").match(/M([\d.]+) ([\d.]+)/);
      if (d) { roomSvg.style.setProperty("--hx", d[1] + "px"); roomSvg.style.setProperty("--hy", d[2] + "px"); }
    }

    /* reveal-once below the day */
    const rs = root.querySelectorAll("[data-r]");
    if (motion && "IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => { es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }); }, { threshold: 0.04, rootMargin: "0px 0px -2% 0px" });
      rs.forEach((el) => io.observe(el));
      undo.push(() => io.disconnect());
    } else rs.forEach((el) => el.classList.add("in"));

    /* ───── chrome: top bar, bottom bar, the edge ───── */
    const top = $("top-bar"), dock = $("dock"), frameEl = $("frame"), nightEl = $("night"), G = { dkb: 0 }, EDGE = [top, dock, frameEl].filter(Boolean);
    let S = {};
    function docTop(el) { return el.getBoundingClientRect().top + window.scrollY; }
    function relTop(el, rt) { let y = 0; while (el && el !== rt) { y += el.offsetTop; el = el.offsetParent; } return y; }
    const SPLIT = [...root.querySelectorAll(SPLIT_SEL)];
    /* every element that can meet the edge learns its own resting top (px from the viewport top) once per layout */
    function setT() {
      const vh = G.vh, dH = dock.offsetHeight, dt = vh - G.dkb - dH;
      dock.style.setProperty("--t", dt + "px");
      for (let i = 0; i < SPLIT.length; i++) {
        const el = SPLIT[i];
        let t;
        if (top.contains(el)) t = relTop(el, top); else if (dock.contains(el)) t = dt + relTop(el, dock); else if (story) t = relTop(el, frameEl); else continue;
        el.style.setProperty("--t", t + "px");
      }
    }
    /* x: 'pn' (paper above the edge, night below) or 'np'; e: the edge in px from the viewport top */
    function edge(x, e, gStage) {
      const vh = G.vh, xing = e > 0 && e < vh, top_ = x === "pn" ? (e <= 0 ? "night" : "paper") : (e <= 0 ? "paper" : "night");
      if (x !== S.x) { S.x = x; R.setAttribute("data-x", x); }
      if (xing !== S.xing) { S.xing = xing; R.classList.toggle("xing", xing); }
      /* 17. the edge goes on the three elements that split at it (top bar, bottom bar, frame), not on the root: a custom property
         written on the root every frame of a crossing restyled the whole page (sheet and footer included) in each frame */
      if (xing) { const ev = Math.round(e) + "px"; if (ev !== S.e) { S.e = ev; EDGE.forEach((el) => el.style.setProperty("--e", ev)); } }
      const g = gStage || top_;
      if (g !== S.g) { S.g = g; R.setAttribute("data-g", g); }
      /* 8. the live value, not a cached one */
      S.tc = top_;
      const want = LANDING_BAR[top_];
      if (liveThemeColor() !== want) { setThemeColor(want); barWrote = want; }
    }
    function measure() {
      const c = $("hero-cta"), p = $("pcta");
      G.cta = docTop(c) + c.offsetHeight; G.p0 = docTop(p); G.p1 = G.p0 + p.offsetHeight; G.foot = docTop($("foot")); G.hh = top.offsetHeight; G.vh = window.innerHeight;
      if (!story) { const nb = $("nb"); G.nb0 = docTop(nb); G.nb1 = G.nb0 + nb.offsetHeight; }
    }
    /* while the day runs the bar rides the stage's bottom: if Safari's bars collapse (innerHeight > svh), it lifts by the difference */
    function dockLift() { const x = story && G.ev ? Math.max(0, Math.round(window.innerHeight - (G.svh || window.innerHeight))) : 0; if (x !== G.dkb) { G.dkb = x; dock.style.setProperty("--dkb", x + "px"); setT(); } }
    /* "Prøv gratis" once the hero button has gone: under the header (or, on desktop, once the hero has lifted away).
       The bottom bar is then up, except over the price button and the footer. */
    function chrome(y, ev, past) {
      const vh = G.vh;
      if (past == null) past = y > G.cta - G.hh;
      if (past !== G.past) { G.past = past; R.classList.toggle("cta-past", past); }
      const onB = past && !(G.p0 < y + vh - 64 && G.p1 > y) && y + vh < G.foot + 40;
      if (onB !== G.on) { G.on = onB; dock.classList.toggle("on", onB); R.classList.toggle("dock-on", onB); }
      if (ev !== G.ev) { G.ev = ev; dock.classList.toggle("ev", ev); dockLift(); }
      top.classList.toggle("scrolled", y > 8);
    }
    function setU() { const w = roomSvg.getBoundingClientRect().width; if (w > 0) roomSvg.style.setProperty("--u", (1101 / w).toFixed(4)); }
    /* the bar's "Næste" belongs to the day: after it, the bar's left side is only the trial line */
    const dnext = $("dnext"), dprev = $("dprev");

    let PJ = null;
    on(document, "touchstart", touches, { passive: true });
    on(document, "touchend", (e) => { touches(e); if (!touchN && PJ) frame(checkJump); }, { passive: true });
    on(document, "touchcancel", touches, { passive: true });

    if (!story) {
      /* stacked page: the night band is a real section; its two edges pass the fixed bars exactly. 20: an address fragment
         is the browser's (and ScrollManager's) to scroll to here */
      dnext.closest(".dk-nav").hidden = true;
      const st = () => {
        const y = window.scrollY, vh = G.vh, a = G.nb0 - y, b = G.nb1 - y;
        if (a > 0 && a < vh) edge("pn", a); else if (b > 0 && b < vh) edge("np", b); else if (a <= 0 && b >= vh) edge("pn", -BIG); else if (a >= vh) edge("pn", BIG); else edge("np", -BIG);
        chrome(y, false);
      };
      const lay = () => { measure(); setT(); S = {}; setU(); st(); };
      lay(); R.classList.remove("lp6-boot"); /* 14 */
      on(window, "resize", lay); on(window, "scroll", st, { passive: true }); on(window, "load", lay);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (alive) lay(); });
      return;
    }

    /* ───── the pinned day ───── */
    frameEl.setAttribute("data-bb-own-anchors", ""); /* 20 */
    const hero = $("hero"), track = $("track"), scene = $("scene"), clock = $("clock"), plate = $("plate"), zbl = $("zbline"), roster = $("roster"), uge = $("uge"), vagt = $("vagt"), vapp = $("vapp"), rbox = $("roombox"), rfoot = $("roomfoot"),
      booking = $("booking"), bookw = $("bookw"), stand = $("stand"), tal = $("tal"), standw = $("standw"), foto = $("foto"), fotow = $("fotow"), zb = $("zb"), kasse = $("kasse"),
      c1 = $("c1"), c2 = $("c2"), c3 = $("c3"), snav = $("snav"), snev = $("snev"), snend = $("snend"), prev = $("prev"), eprev = $("eprev"), nextB = $("next"), ixa = [...root.querySelectorAll(".ix a")];
    const counts = [$("count"), $("dcount")], progs = [$("prog"), $("dprog")], digs = [...clock.querySelectorAll(".dg")], asides = [...root.querySelectorAll(".copy.sc .aside")],
      scLinks = [...root.querySelectorAll(".copy.sc a")], v2l = $("v2l"), TALLQ = "(max-width:767px) and (min-height:780px)";
    let TRACK, SEG, ACC, TOT, AI, svh, pin, trackH, desk, wide, fsClk = 64, LW = 0, LH = 0;
    const GEO = {};
    function build() { TRACK = buildTrack(desk); SEG = TRACK.SEG; ACC = TRACK.ACC; TOT = TRACK.TOT; AI = TRACK.AI; R.style.setProperty("--trk", TOT + 100); }
    const seg = (u) => segAt(TRACK, u);
    function ss(a, b, x) { const t = clamp(0, (x - a) / (b - a), 1); return t * t * (3 - 2 * t); }
    const N0 = 0.05, N1 = 0.38, FLY = 0.34, TV2 = (1275 - 1185) / 185; G.roomIn = 0.2; G.doors = 0.34; /* TV2: Vindue 2 frees at 21.15 (floor.json lit 19:45–21:15) */
    /* the clock: 10.00 · 12.30 · 16.40 held (also while night rises over the 16.40 card); then 16.40 → 17.00 while the room draws (the door opens at 17.00),
       → 19.40 while the room fills; 19.45 held while the guest arrives; → 22.50; 22.50 held; → 00.10 */
    function minutes(id, t) {
      if (id === "A") return t < G.roomIn ? 1000 : t < G.doors ? 1000 + 20 * ss(G.roomIn, G.doors, t) : 1020 + 160 * ss(G.doors, 1, t);
      if (id === "B") return 1185 + 185 * t;
      if (id === "C") return 1370 + 80 * t;
      return { h: 600, "1a": 600, "2a": 750, "1b": 1000, S: 1185, "2b": 1370 }[id] || 1450;
    }
    /* at most one change per 120 ms; no roll on a fast scroll (> 2 px/ms) */
    let clkAt = 0, clkTO = null, spd = 0, lastY = 0, lastT = 0;
    function setClock(m) {
      const t0 = now(); unlater(clkTO); clkTO = null;
      if (S.clk != null && t0 - clkAt < 120) { clkTO = later(() => setClock(m), 122 - (t0 - clkAt)); return; }
      const hh = Math.floor(m / 60) % 24, mi = m % 60, v = (hh < 10 ? "0" : "") + hh + (mi < 10 ? "0" : "") + mi;
      if (v === S.clk) return;
      clock.classList.toggle("now", S.clk == null || spd > 2); S.clk = v; clkAt = t0;
      digs.forEach((d, i) => {
        const c = v.charAt(i), cur = CUR.get(d) || d.children[0];
        if (cur.textContent === c) return;
        const nx = cur === d.children[0] ? d.children[1] : d.children[0];
        nx.textContent = c; CUR.set(d, nx); nx.className = "sx f1 in"; cur.className = "sx f1 out";
      });
    }
    function vis(el, onV) {
      if (!el) return;
      onV = !!onV;
      if (ON.get(el) === onV) return;
      ON.set(el, onV); unlater(TO.get(el)); TO.delete(el);
      if (onV) { el.classList.remove("out", "fly"); el.classList.add("on"); }
      else if (el.classList.contains("on")) {
        el.classList.remove("on");
        if (el.classList.contains("booking-any") && S.beat === "S") { el.classList.add("fly"); return; }
        /* .hold screens (00.10) wait until the incoming screen is past half; the stand leaves after the drawing is back on it */
        const long = el.classList.contains("hold") || el === stand || el === standw || el === tal;
        el.classList.add("out"); TO.set(el, later(() => { el.classList.remove("out"); TO.delete(el); }, long ? 640 : 240));
      }
    }
    function countUp() {
      const dds = zb.querySelectorAll("dd"), a = zb.animate ? zb.animate([], { duration: 600, delay: 300, fill: "both" }) : null;
      if (a) anims.add(a);
      function f(n) { const s = n.toFixed(2).split("."); return s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + s[1]; }
      (function step() {
        const p = !a || a.playState === "finished" ? 1 : (a.effect.getComputedTiming().progress || 0), e = 1 - Math.pow(1 - p, 3);
        dds.forEach((d) => { d.textContent = f(Math.round(+d.dataset.v * e)); });
        if (p < 1) frame(step); else if (a) anims.delete(a);
      })();
    }
    function setV(el, o) { for (const k in o) el.style.setProperty(k, o[k]); }
    const scnOf = (id, t) => scnAt(id, t, G.roomIn);
    function linkTabs() {
      scLinks.forEach((a) => {
        const c = a.closest(".copy"), as = a.closest(".aside"), onL = c.classList.contains("on") && (!as || as.classList.contains("on"));
        if (onL) a.removeAttribute("tabindex"); else a.setAttribute("tabindex", "-1");
      });
    }

    /* what the stage shows at (beat, progress) */
    let roomRT = null;
    function show(id, t) {
      const early = id === "A" && t < G.roomIn, roomOn = (id === "A" && t >= G.roomIn) || /^(S|B|2b|C)$/.test(id), card = id === "S" && t < FLY, v2free = id === "B" && t >= TV2;
      vis(roster, id === "h" || (id === "1a" && !desk)); vis(uge, desk && id === "1a");
      vis(booking, !wide && (id === "2a" || card)); vis(bookw, wide && (id === "2a" || card));
      vis(vagt, !wide && (id === "1b" || early)); vis(vapp, wide && (id === "1b" || early));
      vis(room, roomOn);
      vis(stand, !wide && id === "2b"); vis(tal, !wide && id === "2b"); vis(standw, wide && id === "2b");
      const close = /^(3a|3b|end)$/.test(id);
      vis(foto, !wide && id === "3a"); vis(fotow, wide && id === "3a");
      if (wide && close && !ON.get(zb)) frame(countUp);
      vis(zb, wide && close); vis(kasse, id === "3b" || id === "end");
      if (wide) { const a3 = id === "3a"; setV(zb, { "--zx": a3 ? GEO.zx0 : 0, "--zy": a3 ? GEO.zy0 : 0, "--zs": a3 ? GEO.zs0 : GEO.zs1 }); zbl.classList.toggle("on", close && !a3); }
      const st = card ? "card" : id === "2b" ? "cut" : "";
      if (st !== S.rst) {
        const was = S.rst; S.rst = st;
        if (st) room.setAttribute("data-st", st); else room.removeAttribute("data-st");
        /* leaving 22.50: snap home while invisible, then fade in */
        unlater(roomRT); roomRT = null;
        if (was === "cut" && !st) { room.classList.add("ret"); roomRT = later(() => room.classList.remove("ret"), 1200); } else room.classList.remove("ret");
        const b = (st === "cut" ? GEO.b2b : null) || { x: 0, y: 0, k: 1 };
        setV(rbox, { "--lp6-bx": b.x, "--lp6-by": b.y, "--lp6-k": b.k, "--clip": st === "cut" ? GEO.clip : "inset(-40px)" });
      }
      room.classList.toggle("wait", id === "A" || card); room.classList.toggle("land", id === "S");
      /* 19.45 → 21.15: the guest from 12.30 is at Vindue 2 — the table is named in the drawing and ringed while the copy says so */
      room.classList.toggle("v2", (id === "S" && !card) || (id === "B" && !v2free));
      /* copy: chapter, and which of its two sentences is ink */
      const ch = id === "A" ? (t < G.roomIn ? 1 : 2) : { h: 1, "1a": 1, "2a": 2, "1b": 1, S: 2, B: 2, "2b": 2, C: 2 }[id] || 3,
        b2 = id === "1b" || (id === "A" && t < G.roomIn) || /^(S|B|2b|C|3b|end)$/.test(id), ak = id === "A" ? (t < G.roomIn ? "A" : "A2") : card ? "S0" : id === "B" ? (v2free ? "B2" : "S") : id;
      const key = ch + (b2 ? "b" : "") + ak;
      if (key !== S.copy) {
        S.copy = key;
        [c1, c2, c3].forEach((c, i) => { const onC = ch === i + 1; c.classList.toggle("on", onC); c.classList.toggle("b2", onC && b2); });
        asides.forEach((a) => a.classList.toggle("on", a.dataset.b.split(" ").indexOf(ak) >= 0)); linkTabs();
        ixa.forEach((a) => {
          const cur = +a.dataset.c === ch, w = a.querySelector(".w");
          a.classList.toggle("cur", cur); w.classList.toggle("f1", cur); w.classList.toggle("f3", !cur);
          if (cur) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
        });
      }
      /* 7 / 7: the frame's own nav becomes the trial button (the two-column page; elsewhere the bottom bar carries the stepper) */
      const end = /^(3b|end)$/.test(id);
      if (end !== S.end) {
        S.end = end;
        const fb = !end && document.activeElement === eprev;
        snav.classList.toggle("lp6-end", end); snend.toggleAttribute("inert", !end); snev.toggleAttribute("inert", end);
        /* v6.2: stepping back from 7 / 7 with the keyboard keeps the focus on "← Forrige" (the one in the row that is now showing) */
        if (fb) { prev.hidden = false; prev.focus({ preventScroll: true }); }
      }
    }
    /* v6.2 "← Forrige" shows from 2 / 7 (the counter's own number, so never before the stage pins); a focus on it moves to "Næste" when it hides */
    function setBack(onB) {
      if (onB === S.bk) return;
      S.bk = onB;
      const a = document.activeElement;
      prev.hidden = !onB; dprev.classList.toggle("off", !onB);
      /* the edge split needs each span's resting top; a hidden button had none when setT() last ran */
      if (onB) prev.querySelectorAll(".sx").forEach((el) => el.style.setProperty("--t", relTop(el, frameEl) + "px"));
      if (!onB) { if (a === prev) nextB.focus({ preventScroll: true }); else if (a === dprev) dnext.focus({ preventScroll: true }); }
    }

    let OX = 0, OY = 0; /* figures live in the frame; every position is given in scene coordinates */
    function place(el, x, y, w, h) { el.style.left = Math.round(OX + x) + "px"; el.style.top = Math.round(OY + y) + "px"; if (w != null) el.style.width = Math.round(w) + "px"; if (h != null) el.style.height = Math.round(h) + "px"; }
    function win(el, h) { const w = el.querySelector(".win"); if (w) w.style.height = Math.round(h) + "px"; }
    /* the largest box of aspect a (w/h) inside Wb × Hb that keeps clear of the plate's corner marks (cl px on one axis) */
    function fit(a, Wb, Hb, cl, maxW) { maxW = maxW || 1e9; const w1 = Math.min(Wb, maxW, (Hb - 2 * cl) * a), w2 = Math.min(Wb - 2 * cl, maxW, Hb * a), w = Math.max(w1, w2); return { w, h: w / a }; }
    const TAG = 26, CLR = 24, CAP = 30, KS = [676, 978, 1511], SG = 107 / 757 + 682 / 1101, I_ALT = 1408.5, FA = 1083 / 924, FW = 1179 / 1880;
    const WARN = [];
    let FIXING = false, KEEP = null;
    function layout() {
      /* v6.2 fix: the scene the reader is in (beat + progress through it), so a re-layout keeps it whatever the new frame height */
      if (!FIXING) KEEP = (pin != null && svh && window.scrollY >= pin && window.scrollY <= pin + trackH - svh) ? seg(((window.scrollY - pin) / svh) * 100) : null;
      desk = mm(DQ).matches; wide = window.innerWidth >= 768; svh = $("probe").offsetHeight || window.innerHeight; G.svh = svh; G.vh = window.innerHeight; LW = window.innerWidth; LH = window.innerHeight; build();
      /* v6.2 fix: the load-time story test (height ≥ 600), repeated: under it the screens step aside (.cramp) and the guard does not run */
      const cramp = window.innerHeight < 600; R.classList.toggle("cramp", cramp);
      frameEl.querySelectorAll(".fx,.plate").forEach((el) => { el.style.scale = ""; });
      setV(R, { "--bt": "24px", "--bc": "24px", "--bm": "24px", "--slot": "300px" });
      const W = scene.offsetWidth, cs = getComputedStyle(frameEl), padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom), avail = svh - padT - padB;
      const headH = Math.max($("aften-h").offsetHeight, $("date").offsetHeight), clockH = clock.offsetHeight + parseFloat(getComputedStyle(clock).marginTop);
      const cps = [c1, c2, c3].map((c) => c.offsetHeight), copyH = Math.max.apply(0, cps), copyMin = Math.min.apply(0, cps);
      const navH = snav.offsetHeight ? snav.offsetHeight + parseFloat(getComputedStyle(snav).marginTop) : 0;
      fsClk = parseFloat(getComputedStyle(clock).fontSize);
      /* 16. the phone clock's size before the stage pins (a token that changes only with a breakpoint, which re-lays out) */
      G.c0 = parseFloat(getComputedStyle(R).getPropertyValue("--fs-clock0")) || 56;
      const rw0 = wide ? Math.min(W, 640) : W; roster.style.width = rw0 + "px"; const roH = roster.offsetHeight;
      room.classList.add("has-late"); room.style.width = W + "px"; let fh = rfoot.offsetHeight + 8;
      /* the widest room that fits h = 28 + w·690/1101 + foot (the foot wraps when narrow, so measure again) */
      /* v6.2 fix: the .6 W floor (keeps the foot from wrapping) only where that room still fits the plate; a short plate gets the room that fits */
      let P, H;
      const fl = () => (28 + (0.6 * W * 690) / 1101 + fh > P - 2 * CLR ? 0 : 0.6 * W);
      const roomFit = (f) => {
        let w = Math.max(f(fh), fl());
        for (let k = 0; k < 3; k++) { room.style.width = Math.round(w) + "px"; fh = rfoot.offsetHeight + 8; const w2 = Math.max(f(fh), fl()); if (Math.abs(w2 - w) < 1) break; w = Math.min(w, w2); }
        room.style.width = Math.round(w) + "px"; fh = rfoot.offsetHeight + 8; return w;
      };
      let rw, rt, rx, rbx = 0, bk, tTop = 24, pull = 24;
      if (!desk) { hero.style.opacity = ""; hero.style.transform = ""; hero.style.visibility = ""; frameEl.style.removeProperty("--hin"); setPre(false); }
      if (wide) clock.style.removeProperty("--ck");
      if (!wide) {
        /* ── phone: [head · clock] [media slot] [copy] with bands ≤ one section gap; the slack goes to the media, never below the minimum gaps
              (clock → media ≥ 20, caption/legend → eyebrow ≥ 24, copy → bar ≥ 20) */
        GEO.tallV = mm(TALLQ).matches; const VA = GEO.tallV ? 1170 / 1100 : 786 / 570;
        let vw = Math.min(W, 400), vagH = vw / VA + TAG, bw = Math.min(W, 400), bookH = (bw * 578) / 800 + TAG, roomH = 28 + (W * 690) / 1101 + fh, fw = Math.min(W, 400), fotoH = fw / FA + TAG;
        /* equal visible bands at the smallest screen and the shortest copy: band = (air) / 4; taller screens reach into the bands, never past the minimums */
        const R0 = avail - (headH + clockH + copyH), slack = copyH - copyMin, hmin = Math.min(roH, vagH, bookH, roomH, fotoH), band = (R0 - hmin + slack) / 4;
        let t, c, m, d;
        if (band >= 24) { t = c = m = band; d = Math.max(20, band - slack); } else { t = 16; c = 20; m = 24; d = 20; }
        let s = R0 - t - c - m - d;
        const reach = Math.max(0, Math.min(c - 20, m - 24));
        /* if a screen still cannot fit at its natural size, the top band and the band above the bar give first (down to 16 / 20) */
        const need = Math.max(roH, vagH, bookH, roomH, fotoH, 121 + (W * 176) / 584 + TAG, (W * 676) / 1095 + TAG) - (s + 2 * reach);
        if (need > 0) { const gT = Math.max(0, t - 16), gD = Math.max(0, d - 20), g = Math.min(need, gT + gD); let a1 = Math.min(gT, g / 2); const a2 = Math.min(gD, g - a1); a1 = Math.min(gT, g - a2); t -= a1; d -= a2; }
        t = Math.round(t); c = Math.round(c); m = Math.round(m); d = Math.round(d); s = Math.floor(R0 - t - c - m - d); tTop = t;
        setV(R, { "--bt": t + "px", "--bc": c + "px", "--bm": m + "px", "--slot": s + "px" });
        OX = scene.offsetLeft; OY = scene.offsetTop; const Hx = s + 2 * reach - 1, mid = (h) => Math.round((s - h) / 2);
        /* a shorter statement sits centred in the copy cell (off = its top offset there), so its screen moves down until the air
           clock → screen equals the air screen → statement; never under 20 above or 24 below */
        const midC = (h, ci) => { const off = (copyH - cps[ci]) / 2; return Math.round(clamp(20 - c, (s - h + m - c + off) / 2, s - h + m + off - 24)); };
        /* v6.2 fix: where the roster is taller than its band (clock + 20 … statement − 24, measured as the guard measures it; the 600–639 px phones)
           it is scaled to the band and sits at its top */
        const cb0 = clock.offsetTop + clock.offsetHeight - OY, rk = shrink(roster, roH, c1.offsetTop - OY - 24 - (cb0 + 20));
        place(roster, (W - rw0) / 2, rk < 1 ? cb0 + 21 - (roH * (1 - rk)) / 2 : midC(roH, 0), rw0);
        /* 16.40: the card crop, or on tall phones (TALLQ, the <picture> source) the whole app screen — one image either way */
        if (vagH > Hx) { vw = (Hx - TAG) * VA; vagH = Hx; } place(vagt, (W - vw) / 2, midC(vagH, 0), vw); GEO.vagW = Math.round(vw);
        /* the drawing narrows when the slot is short; its foot (caption, INDGANG, legend) keeps the full width, so it never wraps further */
        rw = Math.min(W, ((Hx - 28 - fh) * 1101) / 690); rbox.style.width = Math.round(rw) + "px"; rx = rbx = (W - rw) / 2; rfoot.style.setProperty("--ind", Math.round(rx + 0.055 * rw) + "px");
        roomH = 28 + (rw * 690) / 1101 + fh; rt = mid(roomH); place(room, 0, rt, W);
        if (bookH > Hx) { bw = ((Hx - TAG) * 800) / 578; bookH = Hx; } place(booking, (W - bw) / 2, mid(bookH), bw); bk = { el: booking, x: (W - bw) / 2, y: mid(bookH), w: bw, h: bookH - TAG };
        /* 22.50 — the "Sidder nu" tile at 1:1 (0.9 on short screens), then the floor plan's corner: both rows of tables (y 14–376),
           or only the window row (y 14–190) when the screen is short; the drawing lands on it */
        const tk = svh <= 720 ? 0.9 : 1, th = Math.round(107 * tk), tg = svh <= 720 ? 10 : 14, top_ = th + tg;
        let cyv = 362, sw = Math.min(W, ((Hx - top_ - TAG) * 584) / 362);
        if (sw < 0.68 * W) { cyv = 176; sw = Math.min(W, ((Hx - top_ - TAG) * 584) / 176); }
        const sh = (sw * cyv) / 584, gh = top_ + sh + TAG, gx = (W - sw) / 2, gt = mid(gh), kk = sw / 584, pw = 1101 * kk;
        tal.style.setProperty("--tk", tk); stand.style.setProperty("--cy", cyv); place(tal, gx, gt); place(stand, gx, gt + top_, sw);
        /* the landing target and the plan's window, in the plan's own box (layout() maps them to the room after the guard) */
        const kb = pw / rw; GEO.tg = { el: stand, x: -84 * kk, y: -14 * kk - 28 * kb, k: kb }; GEO.wn = [0, 0, sw, sh];
        /* 00.10 — the photo step (the real Kasserapport screen), then the Kassen card (a short window ends on a row line) */
        if (fotoH > Hx) { fw = (Hx - TAG) * FA; fotoH = Hx; } place(foto, (W - fw) / 2, midC(fotoH, 2), fw);
        const cw0 = Math.min(W, 400);
        let cw = cw0, stop = 0;
        for (let k = KS.length - 1; k >= 0; k--) { const cwk = Math.min(cw0, ((Hx - TAG) * 1095) / KS[k]); if (cwk >= 0.8 * cw0 || k === 0) { stop = KS[k]; cw = cwk; break; } }
        const wh = (cw * stop) / 1095, full = (cw * 1511) / 1095; place(kasse, (W - cw) / 2, midC(wh + TAG, 2), cw); win(kasse, wh); kasse.classList.toggle("cut", stop < 1511); kasse.style.setProperty("--k0", (wh - full).toFixed(1));
        pull = svh <= 720 ? 12 : 24;
      } else {
        if (!desk) {
          /* ── tablet / portrait: one column; the plate fills the room between clock and copy, sized to the largest screen */
          const cc = 32, mm2 = 32, Rr = avail - (headH + clockH + copyH + navH);
          zb.style.setProperty("--zb-w", "240px"); place(zb, 0, 0, 240); const zbBlock = zb.offsetHeight;
          const Pt = Math.max(roH, 28 + (W * 690) / 1101 + fh + 2 * CLR, fit(1179 / 860, W, 1e9, CLR, 640).h, W * SG + 14 + 2 * CLR, zbBlock + 2 * CLR);
          P = Math.min(Rr - 36 - cc - mm2 - CAP, Math.max(Pt, Rr - 2 * 96 - cc - mm2 - CAP));
          const rest = Rr - P - cc - mm2 - CAP; tTop = Math.round(rest / 2);
          setV(R, { "--bt": tTop + "px", "--bc": cc + "px", "--bm": mm2 + "px", "--slot": Math.floor(P + CAP) + "px" });
          OX = scene.offsetLeft; OY = scene.offsetTop; pull = parseFloat(getComputedStyle(R).getPropertyValue("--sec")) || 96;
        } else {
          /* ── landscape: the plate is the right column, full height */
          OX = scene.offsetLeft; OY = padT; H = avail; P = H - CAP;
        }
        place(plate, 0, 0, W, P);
        const mid2 = (h) => Math.round((P - h) / 2), cx = (w) => Math.round((W - w) / 2);
        /* v6.2 fix: a short one-column plate scales the roster to the plate (it never reaches past the corner marks into the clock or the statement) */
        const rk = shrink(roster, roH, rw0 <= W - 2 * CLR ? P : P - 2 * CLR); place(roster, cx(rw0), mid2(roH * rk) - (roH * (1 - rk)) / 2, rw0);
        const u1 = fit(962 / 1572, W, P, CLR); place(uge, cx(u1.w), mid2(u1.h), u1.w); win(uge, u1.h);
        const va = fit(1170 / 1100, W, P, CLR, 560); place(vapp, cx(va.w), mid2(va.h), va.w); win(vapp, va.h);
        rbox.style.width = ""; rfoot.style.removeProperty("--ind");
        const rcap = desk ? 720 : W, rf = (f) => Math.max(Math.min(W, rcap, ((P - 2 * CLR - 28 - f) * 1101) / 690), Math.min(W - 2 * CLR, rcap, ((P - 28 - f) * 1101) / 690));
        let roomW;
        if (!fl()) {
          /* v6.2 fix: a plate too short for the .6 W room (the one-column stage under ~810 px tall): the drawing narrows until the room fits the plate,
             its foot keeps .6 W so the legend does not wrap further (as on the phone, INDGANG stays under the door) */
          roomW = Math.round(0.6 * W); room.style.width = roomW + "px"; fh = rfoot.offsetHeight + 8; rw = Math.max(40, Math.min(roomW, rf(fh)));
          rbox.style.width = Math.round(rw) + "px"; rbx = (roomW - rw) / 2; rfoot.style.setProperty("--ind", Math.round(rbx + 0.055 * rw) + "px");
        } else { rw = roomFit(rf); roomW = rw; }
        /* v6.2 fix: under ~650 px tall even the 40 px drawing with its header and foot is taller than the plate: the room is then scaled to the plate */
        const roomH2 = 28 + (rw * 690) / 1101 + fh, rk2 = shrink(room, roomH2, P + 2); rx = cx(rw); rt = mid2(roomH2 * rk2) - (roomH2 * (1 - rk2)) / 2; place(room, cx(roomW), rt, roomW);
        const bf = fit(1179 / 860, W, P, CLR, 640); place(bookw, cx(bf.w), mid2(bf.h), bf.w); win(bookw, bf.h); bk = { el: bookw, x: cx(bf.w), y: mid2(bf.h), w: bf.w, h: bf.h };
        /* 22.50 — the two number tiles over the whole floor plan, one frame; the drawing lands on the plan */
        const sw2 = Math.max(Math.min(W, (P - 2 * CLR - 14) / SG), Math.min(W - 2 * CLR, (P - 14) / SG)), th = (sw2 * 107) / 757, ph = (sw2 * 682) / 1101, gh2 = th + 14 + ph, gx2 = cx(sw2), gt2 = mid2(gh2), kb2 = sw2 / rw;
        place(standw, gx2, gt2, sw2); GEO.tg = { el: standw, x: 0, y: th + 14 - (8 * sw2) / 1101 - 28 * kb2, k: kb2 }; GEO.wn = [0, th + 14, sw2, gh2];
        pair(W, P, mid2, cx);
      }
      /* v6.2 fix: the guard runs before the stage geometry below, and that geometry is taken from where the figures really are
         (box(): as laid out, with any scale), so a figure the guard moved or scaled keeps its flight, its landing and its clip on target */
      if (!cramp && guard()) return;
      const u = 1101 / rw; roomSvg.style.setProperty("--u", u.toFixed(4));
      /* the room-box sits rbx in from the room figure's left (centred in it; 0 where the figure is the box) */
      const rq = box(room), sq = box(GEO.tg.el), tgp = at(sq, GEO.tg.x, GEO.tg.y), o = from(rq, tgp[0], tgp[1]);
      GEO.b2b = { x: o[0] - rbx, y: o[1], k: (GEO.tg.k * sq.s) / rq.s };
      /* the clip that keeps the scaled drawing inside the screen's window while it lands (room-box local coordinates) */
      const bb = GEO.b2b, wa = at(sq, GEO.wn[0], GEO.wn[1]), wb = at(sq, GEO.wn[2], GEO.wn[3]), qa = from(rq, wa[0], wa[1]), qb = from(rq, wb[0], wb[1]),
        lx0 = (qa[0] - rbx - bb.x) / bb.k, ly0 = (qa[1] - bb.y) / bb.k, lx1 = (qb[0] - rbx - bb.x) / bb.k, ly1 = (qb[1] - bb.y) / bb.k, bh = 28 + (rw * 690) / 1101;
      GEO.clip = "inset(" + ly0.toFixed(1) + "px " + (rw - lx1).toFixed(1) + "px " + (bh - ly1).toFixed(1) + "px " + lx0.toFixed(1) + "px)";
      if (S.rst === "cut") rbox.style.setProperty("--clip", GEO.clip);
      /* the booking card's flight into Vindue 2 (centre to centre, down to the table's size) */
      const v2 = T[1], vv = at(rq, rbx + v2.cx / u, 28 + v2.cy / u), kq = box(bk.el), sc = at(kq, bk.w / 2, bk.h / 2);
      setV(bk.el, { "--fly-x": ((vv[0] - sc[0]) / kq.s).toFixed(1), "--fly-y": ((vv[1] - sc[1]) / kq.s).toFixed(1), "--fly-k": ((2.2 * v2.r) / u * rq.s / (bk.w * kq.s)).toFixed(4) });
      /* the "Vindue 2" label sits under the table, between the window row and the next row (room-box coordinates) */
      v2l.style.left = (v2.cx / u).toFixed(1) + "px"; v2l.style.top = (28 + (v2.cy + v2.r + 18) / u).toFixed(1) + "px";
      /* the 16.40 card hands over to the room the moment the rising edge reaches the room's bottom: the night rises over the card,
         the room starts drawing while the edge is still crossing it — the stage is never empty */
      const roomTopVp = OY + at(rq, 0, 0)[1], roomBotVp = OY + at(rq, 0, 28 + (rw * 690) / 1101)[1], pTouch = clamp(0, 1 - roomBotVp / svh, 1);
      G.roomIn = clamp(0.1, N0 + (N1 - N0) * pTouch, 0.36); G.doors = G.roomIn + 0.14; GEO.flipY = roomTopVp;
      if (desk) {
        /* the hero sits in the left column, centred on the stage's middle line; the roster waits in the plate */
        const hh = hero.offsetHeight - parseFloat(getComputedStyle(hero).paddingTop); hero.style.setProperty("--hero-top", Math.round(padT + (avail - hh) / 2) + "px");
      } else {
        /* before it pins, the stage label starts just under the hero (phone 24 px, tablet one section gap) */
        hero.style.setProperty("--hero-pull", Math.round(-(padT + tTop) + pull));
      }
      /* v6.2: 7 / 7 in the frame's own row — "← Forrige" keeps its label where the row and the trial line both stay on one line, else it is "←" alone */
      if (snav.offsetHeight) {
        snend.classList.remove("ic"); const trl = snend.querySelector(".sn-trial");
        if (snend.scrollWidth > snend.clientWidth + 1 || trl.offsetHeight > 1.5 * parseFloat(getComputedStyle(trl).lineHeight)) snend.classList.add("ic");
      }
      pin = docTop(track); trackH = track.offsetHeight; measure(); setT();
      /* v6.2 fix: back to the scene the reader was in (same beat, same progress), not the same pixel offset */
      if (KEEP && SEG.some((x) => x[0] === KEEP[0])) { const y2 = beatY(KEEP[0], KEEP[1]); if (Math.abs(y2 - window.scrollY) > 1) jumpTo(Math.round(y2)); }
      KEEP = null;
      GEO.sceneTop = OY;
      /* v6.3: the top of the 7 / 7 screen (the MOMS screen, as laid out, with any scale) from the stage's top; the frame is pinned at 0 while the sheet rises */
      GEO.k7 = OY + at(box(kasse), 0, 0)[1];
      const keepClk = S.clk; S = { clk: keepClk }; tick();
    }
    /* v6.2 fix: a figure's box in scene coordinates as laid out, with the scale shrink() or the guard gave it (about its centre); at() maps a point
       of the figure to the scene, from() maps a scene point back into the figure */
    function box(el) { return { x: el.offsetLeft - OX, y: el.offsetTop - OY, w: el.offsetWidth, h: el.offsetHeight, s: parseFloat(el.style.scale) || 1 }; }
    function at(b, x, y) { return [b.x + b.w / 2 + b.s * (x - b.w / 2), b.y + b.h / 2 + b.s * (y - b.h / 2)]; }
    function from(b, X, Y) { return [(X - b.x - b.w / 2) / b.s + b.w / 2, (Y - b.y - b.h / 2) / b.s + b.h / 2]; }
    /* v6.2 fix: a screen taller than its room is scaled down about its centre to fit it (2 px spare for rounding); returns the scale, the caller places
       by the visual height. (The guard's own fallback stops at half; this one fits whatever the room, so a 600–700 px tall tablet window shows a small roster, never an overlap) */
    function shrink(el, h, roomPx) { roomPx -= 2; const k = roomPx > 0 && h > roomPx ? Math.floor((roomPx / h) * 1000) / 1000 : 1; el.style.scale = k < 1 ? String(k) : ""; return k; }
    /* v6.2 last-line guard (phone, and the one-column tablet stage): the maths is guard.js. A miss is logged in WARN (window.__lp6.warn, 9); layout() then
       runs once more on fresh measures, and if the miss survives, that screen is moved inside its band, or, where it is taller than the band,
       scaled to it. A future regression can never silently cover the clock. The 22.50 tile + plan and the Z-bon are logged only. */
    function guard() {
      if (desk) return false;
      const cb = clock.offsetTop + clock.offsetHeight, ct = [c1, c2, c3].map((c) => c.offsetTop), figs = [];
      (wide ? [[plate, -1, 30], [roster, 0], [vapp, 0], [bookw, 1], [room, 1], [standw, 1], [fotow, 2], [zb, 2, 0, "3b"], [zb, 2, 0, "3a"], [kasse, 2]]
        : [[roster, 0], [vagt, 0], [booking, 1], [room, 1], [tal, 1], [stand, 1], [foto, 2], [kasse, 2]]).forEach((p) => {
        const el = p[0];
        if (!el || !el.offsetParent) return;
        figs.push({ id: el.id, box: p[3] || "", offsetTop: el.offsetTop, h: el.offsetHeight, scale: parseFloat(el.style.scale) || 1, cap: p[2] || 0, copy: p[1],
          zb: p[3] ? { k: p[3] === "3a" ? +GEO.zs0 : GEO.zs1, dy: p[3] === "3a" ? +GEO.zy0 : 0 } : null });
      });
      const bad = clearanceMisses({ clockBottom: cb, copyTops: ct, figs });
      if (!bad.length) return false;
      WARN.push({ at: Math.round(now()), w: window.innerWidth, h: window.innerHeight, svh, clockPx: fsClk, pass: FIXING ? 2 : 1, bad });
      if (!FIXING) { FIXING = true; try { layout(); } finally { FIXING = false; } return true; }
      bad.forEach((x) => {
        if (NOFIX.indexOf(x.id) >= 0) return;
        const el = $(x.id), r = repairMiss(x, parseFloat(el.style.scale) || 1);
        if (r.scale != null) el.style.scale = String(r.scale);
        el.style.top = r.top + "px";
      });
      return false;
    }
    function pair(W, P, mid2, cx) {
      /* 00.10 on wide screens. 3b: the Z-bon left, the Kassen card right, the two "I alt" rows joined by a 1 px rule.
         3a: the same Z-bon, larger, beside the real photo step — the paper and the phone that reads it */
      const zw = desk ? 220 : 240; zb.style.setProperty("--zb-w", zw + "px"); place(zb, 0, 0, zw); const zh = zb.offsetHeight;
      /* v6.2 fix: a plate shorter than the Z-bon (the one-column stage under ~810 px tall) scales it to the plate at 3b (z1; origin top left) */
      const z1 = Math.min(1, +(P / zh).toFixed(3)), zw1 = zw * z1; GEO.zs1 = z1;
      const KA = 1095 / 1511, gap = 40, kw = Math.max(Math.min(W - zw1 - gap, (P - 2 * CLR) * KA), Math.min(W - 2 * CLR - zw1 - gap, P * KA)), kh = kw / KA;
      const x0 = cx(zw1 + gap + kw), ky = mid2(kh);
      place(kasse, x0 + zw1 + gap, ky, kw); win(kasse, kh); kasse.classList.remove("cut"); kasse.style.setProperty("--k0", 0);
      const dd = zb.querySelector(".tot dd"), totC = (relTop(dd, zb) + dd.offsetHeight * 0.55) * z1, iy = ky + (I_ALT * kw) / 1095, zy = clamp(0, iy - totC, P - zh * z1);
      place(zb, x0, zy, zw); place(zbl, x0 + zw1 + 8, Math.round(iy), gap - 16);
      const g3 = 48, fh3 = Math.min(P - 2 * CLR, (W - g3 - zw * 1.15) / FW), fw3 = fh3 * FW;
      /* v6.2 fix: the enlarged 3a Z-bon is capped at the plate's height (it reached above the clock's bottom): the full height where the pair stays
         inside the corner marks sideways (as fit() allows), else inside them; on a short plate it is then the 3b size, never smaller */
      const zc = ((zw * P) / zh + g3 + fw3 <= W - 2 * CLR ? P : P - 2 * CLR) / zh;
      const zs = Math.min(clamp(1.15, Math.min((W - g3 - fw3) / zw, (P - 2 * CLR) / zh), desk ? 1.45 : 1.6), zc), bw3 = zw * zs, bh3 = zh * zs, gx = cx(bw3 + g3 + fw3);
      place(fotow, gx + bw3 + g3, mid2(fh3), fw3);
      GEO.zx0 = gx - x0; GEO.zy0 = Math.round(mid2(bh3) - zy); GEO.zs0 = zs.toFixed(4);
    }
    /* desktop hand-over: while the left column is still fading in, a keyboard focus on one of its controls (index, Næste) completes the hand-over at once,
       so focus never lands on something you cannot see; a focus back in the faded hero brings the hero back */
    function setPre(p) { S.pre = p; }
    on(frameEl, "focusin", () => { if (desk && S.pre) jumpTo(Math.round(pin + svh * 0.26)); });
    on(hero, "focusin", () => { if (desk && S.ho != null && +S.ho < 0.98) jumpTo(0); });
    /* v6.2 fix: a keyboard focus on the stage nav or the index after the frame has scrolled away under the prices (Shift+Tab back from #pricing)
       brings the 7 / 7 scene back, so the focused control ("Prøv gratis", "← Forrige") is never hidden */
    on(frameEl, "focusin", (e) => { if (e.target.closest && e.target.closest("#snav,.ix") && window.scrollY > pin + trackH - svh + 1) jumpTo(Math.round(beatY("3b", NAVF["3b"]))); });
    /* a link in a stage statement (Vagtplan i App Store) that the browser scrolled to while its statement was not showing: bring its scene back */
    on(frameEl, "focusin", (e) => {
      const c = e.target.closest && e.target.closest(".copy.sc");
      if (!c) return;
      frame(() => frame(() => {
        const as = e.target.closest(".aside");
        if (document.activeElement === e.target && !(c.classList.contains("on") && (!as || as.classList.contains("on")))) jumpTo(Math.round(beatY(c === c1 ? "1a" : c === c2 ? "2a" : "3a", 0.5)));
      }));
    });

    let ticking = false, SY = null;
    /* 9. the tick timer: only with the debug hooks on, and only onto a real array */
    function tick() {
      ticking = false;
      const perf = DEBUG && Array.isArray(window.__perf) ? window.__perf : null, t0 = perf ? now() : 0;
      tick2();
      if (perf) perf.push(now() - t0);
    }
    function tick2() {
      const y = SY !== null ? SY : window.scrollY; SY = null;
      const u = ((y - pin) / svh) * 100;
      if (u === S.u) return;
      S.u = u;
      const sg = seg(u), id = sg[0], t = sg[1], i = sg[2];
      if (id !== S.beat) { S.beat = id; frameEl.setAttribute("data-beat", id); }
      show(id, t);
      /* the two edges: night rises in passage A (.05 → .38); paper (the sheet) rises at the end */
      const pE = i < AI ? 0 : i > AI ? 1 : clamp(0, (t - N0) / (N1 - N0), 1), sheetTop = pin + trackH - svh - y;
      if (sheetTop < G.vh) edge("np", sheetTop, sheetTop <= 0 ? "paper" : "night");
      else { const e = pE <= 0 ? BIG : pE >= 1 ? -BIG : svh * (1 - pE); edge("pn", e, e < GEO.flipY + 1 ? "night" : "paper"); }
      const ny = S.x === "pn" ? (pE <= 0 ? BIG : Math.max(0, Math.round(svh * (1 - pE)))) : (sheetTop <= 0 ? BIG : 0);
      if (ny !== S.ny) { S.ny = ny; nightEl.style.transform = ny >= BIG ? "translate3d(0,100lvh,0)" : "translate3d(0," + ny + "px,0)"; nightEl.style.visibility = ny >= BIG ? "hidden" : "visible"; }
      const m = Math.round(minutes(id, t) / 5) * 5; setClock(m);
      /* 19.45: Vindue 2 waits ("Snart") until the guest's booking has landed on it */
      const mr = id === "S" && t < FLY ? 1184 : m; if (mr !== S.m) { S.m = mr; roomAt(mr); }
      /* the outline starts drawing just before the card hands over, so the room arrives with its walls already up */
      const dv = (id === "A" ? clamp(0, (t - G.roomIn + 0.05) / 0.25, 1) * 1.22 : (i > AI ? 1.22 : 0)).toFixed(3);
      if (dv !== S.draw) { roomSvg.classList.toggle("jd", S.draw != null && now() - (G.jt || -1e9) < 400); S.draw = dv; roomSvg.style.setProperty("--lp6-draw", dv); }
      const xr = !!S.xing && S.x === "pn"; if (xr !== S.xr) { S.xr = xr; room.classList.toggle("xr", xr); }
      let past;
      if (desk) {
        /* the hero lifts away (0 → 14 svh) while the left column rises in (10 → 24 svh): overlapping, never an empty moment */
        const ho = 1 - ss(0, svh * 0.14, y - pin), hin = ss(svh * 0.1, svh * 0.24, y - pin), hs = ho.toFixed(2);
        if (hs !== S.ho) { S.ho = hs; hero.style.opacity = hs === "1.00" ? "" : hs; hero.style.transform = hs === "1.00" ? "" : "translateY(" + ((1 - ho) * -48).toFixed(1) + "px)"; hero.style.visibility = hs === "0.00" ? "hidden" : ""; }
        const hi = hin.toFixed(2); if (hi !== S.hin) { S.hin = hi; frameEl.style.setProperty("--hin", hi); }
        setPre(id === "h" && hin < 0.5); past = ho < 0.5;
      } else if (!wide) {
        /* phone: before the stage pins, the clock is a quieter 56 px under the headline; it grows to its stage size as it pins */
        const c0 = G.c0, k0 = Math.min(1, c0 / fsClk), ck = (k0 + (1 - k0) * clamp(0, y / Math.max(1, pin), 1)).toFixed(3);
        if (ck !== S.ck) { S.ck = ck; clock.style.setProperty("--ck", ck); }
      }
      const pr = clamp(0, u / (TOT - 100), 1).toFixed(3); if (pr !== S.pr) { S.pr = pr; progs.forEach((e) => e.style.setProperty("--p", pr)); }
      const hc = scnOf(id, t); if (hc !== S.hc) { S.hc = hc; counts.forEach((e) => { e.textContent = hc + " / " + NSC; }); }
      setBack(hc >= 2 && u >= 0);
      /* v6.3: the bar keeps "← · Næste · n / 7" through the 'end' beat while the 7 / 7 screen shows; it becomes the trial line only once the morning
         sheet covers half the screen AND has covered the MOMS screen (GEO.k7: its top), so "←" is there at every moment that screen is visible */
      chrome(y, id !== "h" && (sheetTop >= G.vh * 0.5 || sheetTop >= GEO.k7), past);
    }
    const ST = createStepper();
    function onScroll() {
      const t = now(), y = window.scrollY;
      spd = Math.abs(y - lastY) / Math.max(1, t - lastT); lastY = y; lastT = t; SY = y;
      ST.scrolled(y);
      if (!ticking) { ticking = true; frame(tick); }
    }
    function beatY(id, f) { const u = beatU(TRACK, id, f); return u == null ? 0 : pin + (u * svh) / 100; }
    /* "Næste" always goes to the next scene the counter counts (from the first screen: 12.30 on phone, the week plan on desktop) */
    const curScn = () => curScnAt(window.scrollY, { pin, svh, desk, track: TRACK, roomIn: G.roomIn });
    /* v6.3: the stepper and the in-page jumps (Næste, Forrige, the index, the data-go links) move the page at once, on every device: in iOS Safari a tap
       that lands while a smooth scroll still runs only stops that scroll and its click is lost. The scene's own transitions still play: the jump does not
       count as a fast scroll (lastY = the target, so the clock rolls once), and G.jt lets tick2 draw the room (.jd).
       Port: the jump is watched (PJ) for iOS putting the page back where it was; checkJump() re-asserts it once (nav.js jumpCheck) */
    function goTo(y) {
      y = Math.max(0, Math.round(y));
      const y0 = window.scrollY;
      lastY = y; lastT = G.jt = now(); jumpTo(y);
      if (Math.abs(y0 - y) >= 2) { PJ = { y0, y, at: lastT, q: ST.queue }; frame(checkJump); later(checkJump, 150); later(checkJump, 300); }
    }
    function checkJump() {
      const p = PJ, r = jumpCheck(p, window.scrollY, now(), touchN > 0);
      if (r === "expired") PJ = null;
      else if (r === "reassert") {
        PJ = null; lastY = p.y; lastT = G.jt = now();
        if (p.q) { p.q.hit = false; ST.queue = p.q; }
        jumpTo(p.y);
      }
    }
    /* the page y a step lands on (inside the document) */
    const stepY = (y) => Math.max(0, Math.min(Math.round(y), document.documentElement.scrollHeight - window.innerHeight));
    /* v6.3 step queue (nav.js): three quick taps are three steps, a tap during a scroll never steps from a scene in between */
    function stepTo(k, y) {
      y = stepY(y);
      const q = ST.to(k, y, now()); goTo(y); if (Math.abs(window.scrollY - y) < 2) q.hit = true;
    }
    const jumpCtx = { cur: curScn, beatY, endY: () => pin + trackH - svh - G.hh };
    function goNext() { if (!ST.tap(now())) return; const j = nextJump(ST, now(), jumpCtx); stepTo(j.k, j.y); }
    /* v6.2 "Forrige": the mirror — the previous scene the counter counts, at the same resting point "Næste" uses (from 2 / 7 back to 1 / 7: the plan) */
    function goPrev() { if (!ST.tap(now())) return; const j = prevJump(ST, now(), jumpCtx); if (j) stepTo(j.k, j.y); }
    on(nextB, "click", goNext); on(dnext, "click", goNext);
    [prev, eprev, dprev].forEach((b) => on(b, "click", goPrev));
    /* 23. the current entry's history state with the engine's mark for scene address h added: every key the router wrote is
       kept, and a missing state stays what the router reads it as ({ idx: null }, react-router getIndex); null when the
       state is not a plain record the mark can join (then nothing is marked) */
    function markedState(h) {
      const s = window.history.state;
      if (s == null) return { idx: null, [LP6_MARK]: h };
      return typeof s === "object" && !Array.isArray(s) ? { ...s, [LP6_MARK]: h } : null;
    }
    /* 23. the engine has already handled this entry at scene address h (it named it, opened on it or stepped to it) */
    function handled(h) {
      let s = null;
      try { s = window.history.state; } catch { s = null; }
      return !!s && typeof s === "object" && own(s, LP6_MARK) && s[LP6_MARK] === h && window.location.hash === h;
    }
    /* 23. mark the current entry as handled, when its address is scene go's: the same address, written over this entry */
    function markEntry(go) {
      const h = own(SCENE_HASH, go) ? SCENE_HASH[go] : null;
      if (!h || window.location.hash !== h || handled(h)) return;
      try { const st = markedState(h); if (st) window.history.replaceState(st, ""); } catch { /* a sandboxed frame: unmarked, so Back to it steps as before */ }
    }
    /* 18. the address bar names the scene a link jumped to: one of nav.js SCENE_HASH's three strings, nothing else; 23. the
       entry is marked as handled at that address */
    function nameScene(go) {
      const h = own(SCENE_HASH, go) ? SCENE_HASH[go] : null;
      if (!h) return;
      if (window.location.hash === h) { markEntry(go); return; }
      try { window.history.replaceState(markedState(h) || window.history.state, "", h); } catch { /* a sandboxed frame: the address stays */ }
    }
    const goLinks = [...root.querySelectorAll("[data-go]")];
    /* 19, 21. a scene an address may name: one of SCENE_HASH's three, whose [data-go] link (with that very href) this page has */
    const linked = (go) => !!go && own(SCENE_HASH, go) && goLinks.some((a) => a.dataset.go === go && a.getAttribute("href") === SCENE_HASH[go]);
    /* the scene's resting point, the same jump the index links make (instant, into the step queue) */
    const goScene = (go) => stepTo(SCN[go], beatY(go, NAVF[go]));
    goLinks.forEach((a) => on(a, "click", (ev) => {
      /* 18. a new tab, a new window, a download: the browser's own */
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      if (!ST.tap(now())) return;
      const go = a.dataset.go;
      goScene(go);
      nameScene(go);
    }));
    /* 21. the fragment changed inside this page: read it on the next frame, after the browser's own scroll; a scene's own
       address steps there from wherever the page is, anything else is not ours. The two events of one change are one jump:
       the second finds the entry handled (23) or the page at that scene's resting point already (a browser that scrolled to
       the fragment after the first one finds it moved, and is put back).
       23. Only a new address steps: an entry the engine has handled (marked) is one the reader has been on, reached again by
       Back / Forward, and the reader goes back to their place on it (the browser's own scroll restore), as before note 21 */
    let addrQ = null;
    function addressChanged() {
      if (addrQ != null) return;
      addrQ = frame(() => {
        addrQ = null;
        let go = null;
        try { go = sceneOfHash(window.location.hash); } catch { go = null; }
        if (!linked(go) || handled(SCENE_HASH[go])) return;
        if (Math.abs(window.scrollY - stepY(beatY(go, NAVF[go]))) >= 2) goScene(go);
        markEntry(go);
      });
    }
    on(window, "hashchange", addressChanged); on(window, "popstate", addressChanged);
    if (DEBUG) {
      handle.current = Object.freeze({
        geo: () => ({ SEG, ACC, TOT, pin, svh, trackH, desk, wide, hh: G.hh, AI, roomIn: G.roomIn, doors: G.doors, N0, N1, FLY, TV2, NAV, tallV: GEO.tallV, k7: GEO.k7 }),
        scn: curScn, warn: WARN,
      });
      try { Object.defineProperty(window, "__lp6", { value: handle.current, configurable: true, writable: false }); } catch { /* a frozen window */ }
    }
    on(window, "scroll", onScroll, { passive: true });
    /* a width change or a real height change re-lays the stage; Safari's bars collapsing (< 140 px) only moves the bottom bar.
       v6.2: so does any change of the stage's real inputs: the small viewport (#probe = 100svh), the clock's computed size, a height breakpoint.
       Inside an iframe (the Claude app's viewer) svh IS the frame's height, so when the frame grows after load the clock and the bands follow
       the CSS and the figures must follow too. Safari's bars change innerHeight only (svh stays): that keeps the cheap path */
    let rz = null;
    const prb = $("probe");
    function relay() { unlater(rz); rz = later(layout, 120); }
    function stale() { return (prb.offsetHeight || window.innerHeight) !== svh || parseFloat(getComputedStyle(clock).fontSize) !== fsClk; }
    on(window, "resize", () => {
      const w = window.innerWidth, h = window.innerHeight;
      if (w !== LW || Math.abs(h - LH) > 140 || stale()) relay(); else { G.vh = h; dockLift(); setT(); S.u = null; tick(); }
    });
    if (window.ResizeObserver) {
      try { const rob = new ResizeObserver(() => { if (alive && stale()) relay(); }); rob.observe(prb); rob.observe(clock); undo.push(() => rob.disconnect()); } catch { /* no observer: the resize listener stays */ }
    }
    ["(max-height:720px)", "(min-height:780px)", "(min-height:800px)", "(min-height:900px)", "(min-height:1000px)", "(max-height:800px)", "(max-height:860px)", DQ, TALLQ].forEach((q) => mqOn(q, relay));
    on(window, "load", layout); on(window, "pageshow", () => { S.u = null; tick(); });
    layout();
    /* 22. a re-mount that keeps the reader's place: the first layout's classes (the bar on, its stepper, the scene's picture)
       are resolved now, while every transition is still off, so taking .lp6-boot off below changes no value and starts nothing */
    if (opts.settle) void R.offsetHeight;
    /* 14. the first layout is done: transitions back on (before the first paint) */
    R.classList.remove("lp6-boot");
    /* 19. an arrival on a scene's address opens on that scene: a scene nav.js SCENE_HASH names, whose [data-go] link this page
       has, while the page is still at the top (a StrictMode re-mount, or a page the browser has already scrolled, keeps its place) */
    const arrive = opts.arrive;
    if (linked(arrive) && window.scrollY < 2) goScene(arrive);
    /* 23. opened on it or kept its place on it: either way the entry is handled, so Back to it later is a return, not a jump */
    if (linked(arrive)) markEntry(arrive);
    /* 15. a face the first layout asked for: lay out again once it is in (not when every face was already loaded) */
    if (document.fonts && document.fonts.ready && document.fonts.status !== "loaded") document.fonts.ready.then(() => { if (alive) layout(); });
    /* v6.2: WebKit can resolve fonts.ready before lazily used data: faces have loaded. Ask for the stage's Inter faces by name (300 the clock,
       400 / 500 / 600 the statements and labels, at their sizes) and lay out again once they are in, and again after any later face */
    if (document.fonts) {
      try {
        const lf = getComputedStyle(c1.querySelector(".line")).fontSize;
        if (document.fonts.load) Promise.all(["300 " + fsClk + "px Inter", "400 " + lf + " Inter", "500 " + lf + " Inter", "600 " + lf + " Inter", "600 13px Inter"].map((f) => document.fonts.load(f).catch(() => {}))).then(() => { if (alive) relay(); });
        on(document.fonts, "loadingdone", relay);
      } catch { /* no font loading API */ }
    }
    /* 8. useThemeColorSync runs after this layout effect and may write the route's colour over the stage's: put the stage's back */
    later(() => { if (S.tc && liveThemeColor() !== LANDING_BAR[S.tc]) { setThemeColor(LANDING_BAR[S.tc]); barWrote = LANDING_BAR[S.tc]; } }, 300);
  }
}
