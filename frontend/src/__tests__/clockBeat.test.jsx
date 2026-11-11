/**
 * The clock beat (components/staff/clockBeat.js) below the page —
 * CLOCK-MOTION-SPEC.md 2.8 (approved 11 Nov 2026).
 *
 *   • beatFor decides from what the screen showed and the server's REAL
 *     answers (fixtures/liveBreaksContract.json, written by the endpoints),
 *     so the fields it reads are proven to exist.
 *   • useHeroBeat: idle → leave → enter → idle on its own timers, armed only
 *     when the new buttons are in, never replays on mount, a pause never
 *     touches the hero, a server that disagrees or a hidden page ends it.
 *   • The FLIP: measured fakes (not a stub of the hook) — the pine middle
 *     scales, the bottom cap moves, each block below glides by its OWN
 *     distance; nothing for a block that did not move, is off screen both
 *     times, or only exists after the swap; nothing under reduced motion.
 *   • useBeatWindow: on for the pause window, for its kind only.
 *   • The constants are the CSS tokens.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, renderHook, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARM_MS, BREAK_MS, CAP, FRESH_SEC, LEAVE_MS, MOVE_EASE, MOVE_MS, SETTLE_MS,
  beatFor, useBeatWindow, useHeroBeat,
} from "../components/staff/clockBeat";

const HERE = dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(readFileSync(join(HERE, "fixtures", "liveBreaksContract.json"), "utf8"));
const STEP = Object.fromEntries(C.steps.map((s) => [s.name, s]));
const body = (name) => structuredClone(STEP[name].body);
const CSS = readFileSync(join(HERE, "..", "components", "staff", "vagtplan.css"), "utf8");
const PAGE = readFileSync(join(HERE, "..", "pages", "StaffPortalPage.jsx"), "utf8");

function motionPref({ reduce }) {
  window.matchMedia = (q) => ({
    matches: q === "(prefers-reduced-motion: reduce)" ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

afterEach(() => {
  delete window.matchMedia;
  vi.useRealTimers();
});

describe("beatFor: what a confirmed answer changed on this screen", () => {
  it("fed the real answers", () => {
    expect(beatFor("in", body("clock_before"), body("clock_in"))).toEqual({ kind: "in", fresh: true });
    // The screen already showed in (a poll got there first): nothing to play.
    expect(beatFor("in", body("clock_live"), body("clock_in"))).toBeNull();
    expect(beatFor("break", body("clock_live"), body("break_start"))).toEqual({ kind: "break", from: "brass" });
    expect(beatFor("break", body("clock_on_break"), body("break_end"))).toEqual({ kind: "break", from: "sage" });
    expect(beatFor("out", body("clock_on_forgotten_pause"), body("clock_out"))).toEqual({ kind: "out", discarded: false });
  });

  it("hand cases: a stale screen's idempotent clock-in is not fresh; discarded; out from out; non-objects; an unchanged pause", () => {
    expect(beatFor("in", body("clock_before"), { ...body("clock_in"), elapsed_sec: 5400 })).toEqual({ kind: "in", fresh: false });
    expect(beatFor("in", null, { ...body("clock_in"), elapsed_sec: FRESH_SEC - 1 }).fresh).toBe(true);
    expect(beatFor("in", null, { ...body("clock_in"), elapsed_sec: FRESH_SEC }).fresh).toBe(false);
    expect(beatFor("out", body("clock_live"), { ...body("clock_out"), discarded: true })).toEqual({ kind: "out", discarded: true });
    expect(beatFor("out", body("clock_after_out"), body("clock_out"))).toBeNull();
    expect(beatFor("in", body("clock_before"), "ok")).toBeNull();
    expect(beatFor("in", body("clock_before"), null)).toBeNull();
    expect(beatFor("break", body("clock_on_break"), body("break_start_again"))).toBeNull();
    expect(beatFor("nope", body("clock_before"), body("clock_in"))).toBeNull();
  });
});

describe("useHeroBeat: the phases", () => {
  beforeEach(() => vi.useFakeTimers());
  const hook = (initialProps) => {
    const heroRef = { current: null };
    return renderHook(({ clockedIn, beat }) => useHeroBeat(clockedIn, beat, heroRef), { initialProps });
  };
  const IN = { kind: "in", fresh: true, n: 1 };
  const OUT = { kind: "out", discarded: false, snap: { st: { clocked_in: true } }, n: 1 };

  it("no beat: idle, and the home shows the server's state", () => {
    const { result, rerender } = hook({ clockedIn: false, beat: null });
    expect(result.current.phase).toBe("idle");
    expect(result.current.shownIn).toBe(false);
    expect(result.current.armed).toBe(true);
    rerender({ clockedIn: true, beat: null });
    expect(result.current.phase).toBe("idle");
    expect(result.current.shownIn).toBe(true);
  });

  it("clock-in: leave (old card, not armed) → +180 enter → +480 armed → +1060 idle", () => {
    const { result, rerender } = hook({ clockedIn: false, beat: null });
    rerender({ clockedIn: true, beat: IN });
    expect(result.current).toMatchObject({ phase: "leave", kind: "in", fresh: true, armed: false, shownIn: false });
    act(() => { vi.advanceTimersByTime(LEAVE_MS.in - 1); });
    expect(result.current.phase).toBe("leave");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toMatchObject({ phase: "enter", shownIn: true, armed: false });
    act(() => { vi.advanceTimersByTime(ARM_MS.in - 1); });
    expect(result.current.armed).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toMatchObject({ phase: "enter", armed: true });
    act(() => { vi.advanceTimersByTime(SETTLE_MS.in - ARM_MS.in); });
    expect(result.current).toMatchObject({ phase: "idle", armed: true, shownIn: true });
  });

  it("clock-out: leave 240 (the snapshot handed over), arm 440, settle 480", () => {
    const { result, rerender } = hook({ clockedIn: true, beat: null });
    rerender({ clockedIn: false, beat: OUT });
    expect(result.current).toMatchObject({ phase: "leave", kind: "out", shownIn: true, armed: false });
    expect(result.current.snap).toBe(OUT.snap);
    act(() => { vi.advanceTimersByTime(239); });
    expect(result.current.phase).toBe("leave");
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toMatchObject({ phase: "enter", shownIn: false });
    act(() => { vi.advanceTimersByTime(440); });
    expect(result.current.armed).toBe(true);
    expect(result.current.phase).toBe("enter");
    act(() => { vi.advanceTimersByTime(40); });
    expect(result.current.phase).toBe("idle");
  });

  it("a re-render with the same beat does not restart it", () => {
    const { result, rerender } = hook({ clockedIn: false, beat: null });
    rerender({ clockedIn: true, beat: IN });
    act(() => { vi.advanceTimersByTime(100); });
    rerender({ clockedIn: true, beat: IN });
    act(() => { vi.advanceTimersByTime(80); });
    expect(result.current.phase).toBe("enter");
    act(() => { vi.advanceTimersByTime(SETTLE_MS.in); });
    rerender({ clockedIn: true, beat: IN });
    expect(result.current.phase).toBe("idle");
  });

  it("the server flips back mid-beat (a newer poll says the opposite): idle at once, the truth shows", () => {
    const { result, rerender } = hook({ clockedIn: false, beat: null });
    rerender({ clockedIn: true, beat: IN });
    act(() => { vi.advanceTimersByTime(LEAVE_MS.in); });
    expect(result.current.phase).toBe("enter");
    rerender({ clockedIn: false, beat: IN });
    expect(result.current).toMatchObject({ phase: "idle", armed: true, shownIn: false });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.phase).toBe("idle");
  });

  it("mounting with a beat already there never replays it (a tab switch remounts the home)", () => {
    const { result } = hook({ clockedIn: true, beat: IN });
    expect(result.current).toMatchObject({ phase: "idle", shownIn: true, armed: true });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.phase).toBe("idle");
  });

  it("a pause beat never touches the hero", () => {
    const { result, rerender } = hook({ clockedIn: true, beat: null });
    rerender({ clockedIn: true, beat: { kind: "break", from: "brass", n: 1 } });
    expect(result.current).toMatchObject({ phase: "idle", armed: true, shownIn: true });
  });

  it("hidden mid-beat (home button, lock): idle at once, so the rest never plays on resume", () => {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try {
      const { result, rerender } = hook({ clockedIn: false, beat: null });
      rerender({ clockedIn: true, beat: IN });
      expect(result.current.phase).toBe("leave");
      hidden = true;
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(result.current).toMatchObject({ phase: "idle", armed: true, shownIn: true });
      hidden = false;
      act(() => { vi.advanceTimersByTime(2000); });
      expect(result.current.phase).toBe("idle");
    } finally {
      delete document.hidden;
      if (desc) Object.defineProperty(Document.prototype, "hidden", desc);
    }
  });
});

// A home as the page draws it: the hero (with the beat's surface while one
// runs), then the blocks below it. Geometry is faked per side of the swap,
// read from what the DOM shows (data-shown), exactly as layout would be.
function Home({ clockedIn, beat }) {
  const heroRef = useRef(null);
  const ui = useHeroBeat(clockedIn, beat, heroRef);
  return (
    <div data-testid="root">
      <section ref={heroRef} data-testid="hero" data-shown={ui.shownIn ? "in" : "out"}>
        {ui.phase !== "idle" ? (
          <div className="vp-hero-surface">
            <div className="vp-hs-top" data-testid="top" /><div className="vp-hs-mid" data-testid="mid" /><div className="vp-hs-bot" data-testid="bot" />
          </div>
        ) : null}
      </section>
      <div data-testid="moves" />
      {ui.shownIn ? <div data-testid="new" /> : null}
      <div data-testid="still" />
      <div data-testid="far" />
    </div>
  );
}

describe("The FLIP: measured, every block by its own distance", () => {
  const H = { out: 380, in: 420 };
  // Tops in the viewport per side (the root sits at 100).
  const TOPS = {
    out: { root: 100, moves: 500, still: 700, far: 1200 },
    in: { root: 100, moves: 690, still: 700, far: 1400 },
  };
  let calls;
  const origAnimate = Element.prototype.animate;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    Element.prototype.animate = vi.fn(function animate(frames, opts) {
      calls.push({ el: this, frames, opts });
      return { cancel: vi.fn() };
    });
  });
  afterEach(() => {
    if (origAnimate) Element.prototype.animate = origAnimate;
    else delete Element.prototype.animate;
  });

  function mountHome() {
    const view = render(<Home clockedIn={false} beat={null} />);
    const hero = screen.getByTestId("hero");
    const side = () => hero.dataset.shown;
    Object.defineProperty(hero, "offsetHeight", { configurable: true, get: () => H[side()] });
    const rect = (top) => ({ top, bottom: top + 10, left: 0, right: 0, width: 0, height: 10, x: 0, y: top });
    screen.getByTestId("root").getBoundingClientRect = () => rect(TOPS[side()].root);
    for (const id of ["moves", "still", "far"]) screen.getByTestId(id).getBoundingClientRect = () => rect(TOPS[side()][id]);
    return view;
  }
  const IN = { kind: "in", fresh: true, n: 1 };

  it("middle scaleY((H0−48)/(H1−48)), bottom cap translateY(H0−H1), a moved block by its own Δ; nothing else", () => {
    motionPref({ reduce: false });
    const { rerender } = mountHome();
    rerender(<Home clockedIn beat={IN} />);
    expect(calls).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(LEAVE_MS.in); });
    const by = (id) => calls.filter((c) => c.el === screen.queryByTestId(id));
    expect(by("mid")).toHaveLength(1);
    expect(by("mid")[0].frames).toEqual([{ transform: `scaleY(${(H.out - 2 * CAP) / (H.in - 2 * CAP)})` }, { transform: "none" }]);
    expect(by("bot")[0].frames).toEqual([{ transform: `translateY(${H.out - H.in}px)` }, { transform: "none" }]);
    expect(by("moves")[0].frames).toEqual([{ transform: `translateY(${500 - 690}px)` }, { transform: "none" }]);
    expect(by("still")).toHaveLength(0);   // did not move
    expect(by("far")).toHaveLength(0);     // off screen both times (jsdom's innerHeight is 768)
    expect(by("new")).toHaveLength(0);     // only exists after: its own CSS fade
    expect(by("top")).toHaveLength(0);     // the top cap never moves
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.opts).toEqual({ duration: MOVE_MS, easing: MOVE_EASE });
  });

  it("a pause beat during the enter: no second move, the phase and its timers unchanged", () => {
    motionPref({ reduce: false });
    const { rerender } = mountHome();
    rerender(<Home clockedIn beat={IN} />);
    // One advance per phase: under act() a phase's effect (and its timers)
    // commits at the end of the advance that reached it.
    act(() => { vi.advanceTimersByTime(LEAVE_MS.in); });
    act(() => { vi.advanceTimersByTime(ARM_MS.in); });
    expect(calls).toHaveLength(3);
    rerender(<Home clockedIn beat={{ kind: "break", from: "brass", n: 2 }} />);
    expect(calls).toHaveLength(3);
    expect(screen.getByTestId("mid")).toBeInTheDocument();
    // Settles exactly when the clock-in's own timer says, not later.
    act(() => { vi.advanceTimersByTime(SETTLE_MS.in - ARM_MS.in - 1); });
    expect(screen.queryByTestId("mid")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByTestId("mid")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("reduced motion: no animate call at all", () => {
    motionPref({ reduce: true });
    const { rerender } = mountHome();
    rerender(<Home clockedIn beat={IN} />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(calls).toHaveLength(0);
  });

  it("plain jsdom (no animate, zero rects, no matchMedia): nothing throws", () => {
    delete Element.prototype.animate;
    const { rerender } = render(<Home clockedIn={false} beat={null} />);
    expect(() => {
      rerender(<Home clockedIn beat={IN} />);
      act(() => { vi.advanceTimersByTime(2000); });
    }).not.toThrow();
    motionPref({ reduce: false });
    rerender(<Home clockedIn={false} beat={{ kind: "out", n: 2 }} />);
    expect(() => act(() => { vi.advanceTimersByTime(2000); })).not.toThrow();
  });
});

describe("useBeatWindow: the pause's ghost window", () => {
  beforeEach(() => vi.useFakeTimers());

  it("on for BREAK_MS for kind 'break' only; never for a hero beat", () => {
    const { result, rerender } = renderHook(({ beat }) => useBeatWindow(beat, "break", BREAK_MS), { initialProps: { beat: null } });
    expect(result.current).toBeNull();
    const b = { kind: "break", from: "brass", n: 1 };
    rerender({ beat: b });
    expect(result.current).toBe(b);
    act(() => { vi.advanceTimersByTime(BREAK_MS - 1); });
    expect(result.current).toBe(b);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBeNull();
    rerender({ beat: { kind: "in", fresh: true, n: 2 } });
    expect(result.current).toBeNull();
  });

  it("mounting with a beat already there: null (a remount never replays the ghost)", () => {
    const { result } = renderHook(() => useBeatWindow({ kind: "break", from: "sage", n: 4 }, "break", BREAK_MS));
    expect(result.current).toBeNull();
  });
});

describe("The constants are the CSS tokens", () => {
  const tok = (name) => CSS.match(new RegExp(`${name}: ([^;]+);`))[1].trim();
  const sec = (v) => Math.round(parseFloat(v) * 1000);

  it("MOVE_EASE = --ease-nav; MOVE_MS = --dur-nav-back; LEAVE_MS = --dur-fast / --dur-exit; BREAK_MS = --dur-slow + 40", () => {
    expect(MOVE_EASE).toBe(tok("--ease-nav"));
    expect(MOVE_MS).toBe(sec(tok("--dur-nav-back")));
    expect(LEAVE_MS.in).toBe(sec(tok("--dur-fast")));
    expect(LEAVE_MS.out).toBe(sec(tok("--dur-exit")));
    expect(BREAK_MS).toBe(sec(tok("--dur-slow")) + 40);
  });

  it("CAP = the surface caps' radius = the pine card's borderRadius (24)", () => {
    expect(CAP).toBe(24);
    expect(CSS).toMatch(/\.vp-hs-top \{[^}]*border-radius: 24px 24px 0 0;/);
    expect(CSS).toMatch(/\.vp-hs-bot \{[^}]*border-radius: 0 0 24px 24px;/);
    expect(PAGE).toMatch(/const pineCard = \{\s*borderRadius: 24,/);
  });
});
