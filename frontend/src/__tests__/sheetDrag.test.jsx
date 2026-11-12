/**
 * Drag a sheet down to close (premium feel P5 / 1.5d, components/staff/sheetDrag.js).
 *
 *   • It starts on one finger, never on a control, and only where nothing
 *     between the finger and the sheet is scrolled — or on a sticky header
 *     marked data-sheet-handle.
 *   • Direction first: preventDefault only once the move is clearly down (a
 *     sideways strip inside a sheet still scrolls); engage at 8 px, then
 *     follow 1:1; up past the start is a rubber band (never 64 px or more).
 *   • Release: past 30 % of the height, or thrown faster than 0.5 px/ms after
 *     16 px, closes through the sheet's own close (data-dragged-out, a WAAPI
 *     throw with NO fill); otherwise a spring back. touchcancel never closes.
 *   • A re-render mid-drag keeps the gesture; a reopen starts clean; a sheet
 *     whose parent mounted first still drags; reduce motion never animates.
 *
 * jsdom has no TouchEvent and no layout: plain events carry `touches` and a
 * `timeStamp` (as the pull-to-refresh test does), the sheet is 400 px tall,
 * WAAPI is a spy and requestAnimationFrame is a queue the test flushes.
 */
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAG, releaseOf, releaseSpeed, rubber, scrimAt, stoppedAfter, useSheetDrag } from "../components/staff/sheetDrag";
import { springKeyframes } from "../components/staff/spring";

function motionPref({ reduce }) {
  window.matchMedia = (q) => ({
    matches: q === "(prefers-reduced-motion: reduce)" ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

// requestAnimationFrame as a queue: one write per frame, flushed on demand.
let frames = new Map();
let nextId = 1;
const realRaf = window.requestAnimationFrame;
const realCaf = window.cancelAnimationFrame;
const flush = () => { const f = [...frames.values()]; frames = new Map(); f.forEach((cb) => cb(0)); };

function Sheet({ onDismiss, enabled = true, mounted = true, scrolledList = false, children }) {
  const ref = useRef(null);
  useSheetDrag(ref, onDismiss, { enabled });
  return (
    <div data-vp-overlay="" data-testid="root">
      <div className="vp-scrim" data-testid="scrim" />
      {mounted && (
        <div ref={ref} data-testid="sheet" className="vp-sheet">
          <div data-sheet-handle="" data-testid="handle"><h2 data-testid="title">Title</h2></div>
          <p data-testid="gap">Space between cards</p>
          <div data-testid="list" data-scrolled={scrolledList ? "" : undefined}><p data-testid="item">An item</p></div>
          <button type="button" data-testid="btn">A row</button>
          <a href="/x" data-testid="link">A link</a>
          <input data-testid="input" />
          {children}
        </div>
      )}
    </div>
  );
}

let anims;
function prime() {
  const sheet = screen.getByTestId("sheet");
  const scrim = screen.getByTestId("scrim");
  Object.defineProperty(sheet, "offsetHeight", { configurable: true, value: 400 });
  for (const el of [sheet, scrim]) {
    el.animate = vi.fn((frames_, opts) => {
      const a = { el, frames: frames_, opts, finish: vi.fn(), cancel: vi.fn() };
      anims.push(a);
      return a;
    });
    el.getAnimations = () => [];
  }
  return { sheet, scrim, root: screen.getByTestId("root") };
}

let ts = 0;
function touch(el, type, x, y, dt = 16) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.touches = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }];
  ts += dt;
  Object.defineProperty(e, "timeStamp", { value: ts });
  act(() => { el.dispatchEvent(e); });
  return e;
}
const ty = (el) => el.style.transform;
const yOf = (el) => Number((ty(el).match(/^translateY\((-?[\d.e+-]+)px\)$/) || [])[1]);

/** Start at y=100 and engage (an 8 px move), so dy counts from the engage point. */
function grab(el, x = 50) {
  touch(el, "touchstart", x, 100, 0);
  touch(el, "touchmove", x, 108);
  flush();
}
/** Drag to dy (from the engage point at 108) in steps of `step` px every `every` ms. */
function dragTo(el, dy, { step = 10, every = 100, x = 50 } = {}) {
  for (let d = step; d <= dy; d += step) { touch(el, "touchmove", x, 108 + d, every); }
  if (dy % step) touch(el, "touchmove", x, 108 + dy, every);
  flush();
}

beforeEach(() => {
  anims = [];
  frames = new Map();
  nextId = 1;
  ts = 1000;
  window.requestAnimationFrame = (cb) => { const id = nextId++; frames.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  motionPref({ reduce: false });
});
afterEach(() => {
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCaf;
  delete window.matchMedia;
});

describe("the numbers and the pure parts", () => {
  it("slop 8, dismiss at 30 %, flick 0.5 px/ms after 16 px, rubber 64, 6 samples, a finger still for 40-100 ms has stopped, speed over the last 100 ms", () => {
    // Fix round (drag-stale-velocity / PLAT-1): STOPPED added, the others unchanged.
    // Device pass A (slow Android 14): STOPPED 40 → 100 and HORIZON added.
    // Fix round 3: STOPPED back to 40 on a fast phone; a slow one up to STOPPED_MAX.
    expect(DRAG).toEqual({ SLOP: 8, DISMISS: 0.3, FLICK: 0.5, FLICK_MIN: 16, RUBBER: 64, SAMPLES: 6, STOPPED: 40, STOPPED_MAX: 100, HORIZON: 100 });
  });

  it("stoppedAfter: twice the last gap, never under 40 ms, never over 100 ms", () => {
    expect(stoppedAfter([[0, 0], [8, 4]])).toBe(40);       // 120 Hz
    expect(stoppedAfter([[0, 0], [16, 8]])).toBe(40);      // 60 Hz: 32 → 40
    expect(stoppedAfter([[0, 0], [20, 8]])).toBe(40);
    expect(stoppedAfter([[0, 0], [21, 8]])).toBe(42);
    expect(stoppedAfter([[0, 0], [35, 8]])).toBe(70);      // a busy phone
    expect(stoppedAfter([[0, 0], [50, 8]])).toBe(100);
    expect(stoppedAfter([[0, 0], [300, 8]])).toBe(100);    // never more
  });

  it("releaseSpeed: a fast phone reads all six samples, as before; a slow one only the last 100 ms; a rest is 0", () => {
    // 60 Hz, 10 px a frame: all six (80 ms) → 0.625 px/ms, the old first-to-last.
    const fast = [0, 16, 32, 48, 64, 80].map((t, k) => [t, k * 10]);
    expect(releaseSpeed(fast, 90)).toBeCloseTo(50 / 80, 6);
    // A busy phone: a slow start, then a flick's moves 60 ms apart. Six
    // samples reach back 300 ms (0.5 px/ms, not over the line); the last 100 ms
    // read 1.5 px/ms.
    const slow = [[0, 0], [60, 4], [120, 10], [180, 30], [240, 60], [300, 150]];
    expect(releaseSpeed(slow, 370)).toBeCloseTo(90 / 60, 6);
    // Only one move inside the horizon: the two newest still give a speed.
    expect(releaseSpeed([[0, 0], [200, 40], [400, 160]], 410)).toBeCloseTo(120 / 200, 6);
    // Moves 60 ms apart: still for more than 100 ms before the lift is resting.
    expect(releaseSpeed(slow, 401)).toBe(0);
    expect(releaseSpeed(slow, 400)).toBeCloseTo(90 / 60, 6);
    // Moves 16 ms apart (a fast phone): 40 ms is enough (fix round 3, PLAT-1).
    expect(releaseSpeed(fast, 120)).toBeCloseTo(50 / 80, 6);
    expect(releaseSpeed(fast, 121)).toBe(0);
    expect(releaseSpeed(fast, 160)).toBe(0);
    expect(releaseSpeed([[0, 0]], 10)).toBe(0);
  });

  it("rubber: 40 → about 16 px, 200 → about 40.5 px, never 64 or more", () => {
    expect(rubber(40)).toBeCloseTo(16.37, 1);
    // (The spec rounds this one up to 41.)
    expect(rubber(200)).toBeGreaterThan(40);
    expect(rubber(200)).toBeLessThan(41);
    expect(rubber(100000)).toBeLessThan(64);
    expect(rubber(0)).toBe(0);
  });

  it("scrimAt: 1 at rest, fades with the pull, never below 0.2", () => {
    expect(scrimAt(0, 400)).toBe(1);
    expect(scrimAt(280, 400)).toBeCloseTo(0.5, 5);
    expect(scrimAt(4000, 400)).toBe(0.2);
  });

  it("releaseOf: distance, throw (clamped 120-240 ms, linear) or stay", () => {
    expect(releaseOf(119, 0.1, 400)).toEqual({ dismiss: false });
    expect(releaseOf(121, 0.1, 400)).toEqual({ dismiss: true, ms: 240, easing: "cubic-bezier(.4, 0, 1, 1)" });
    expect(releaseOf(15, 2, 400)).toEqual({ dismiss: false });                 // fast, but under 16 px
    expect(releaseOf(40, 0.8, 400)).toEqual({ dismiss: true, ms: 240, easing: "linear" });   // 450 → 240
    expect(releaseOf(40, 2, 400)).toEqual({ dismiss: true, ms: 180, easing: "linear" });     // (400 − 40) / 2
    expect(releaseOf(40, 4, 400)).toEqual({ dismiss: true, ms: 120, easing: "linear" });     // 90 → 120
  });
});

describe("following the finger", () => {
  it("a 7 px move does nothing; from 8 px it follows 1:1 (no jump); the scrim fades", () => {
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet, scrim } = prime();
    const gap = screen.getByTestId("gap");
    touch(gap, "touchstart", 50, 100, 0);
    touch(gap, "touchmove", 50, 107);
    flush();
    expect(ty(sheet)).toBe("");
    touch(gap, "touchmove", 50, 108);
    flush();
    expect(ty(sheet)).toBe("translateY(0px)");
    expect(sheet.style.willChange).toBe("transform");
    expect(scrim.style.willChange).toBe("opacity");
    touch(gap, "touchmove", 50, 148);
    flush();
    expect(ty(sheet)).toBe("translateY(40px)");
    expect(Number(scrim.style.opacity)).toBeCloseTo(scrimAt(40, 400), 5);
  });

  it("one transform write per frame, however many moves arrive", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    grab(sheet);
    touch(sheet, "touchmove", 50, 120);
    touch(sheet, "touchmove", 50, 130);
    touch(sheet, "touchmove", 50, 140);
    expect(frames.size).toBe(1);
    flush();
    expect(ty(sheet)).toBe("translateY(32px)");
  });

  it("up past the start: the rubber band (−40 → about −16 px)", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    grab(sheet);
    touch(sheet, "touchmove", 50, 68);
    flush();
    expect(yOf(sheet)).toBeCloseTo(-rubber(40), 5);
    expect(yOf(sheet)).toBeCloseTo(-16.37, 1);
  });
});

describe("where a drag may start", () => {
  it("never on a button, a link or an input inside the sheet", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    for (const id of ["btn", "link", "input"]) {
      const el = screen.getByTestId(id);
      touch(el, "touchstart", 50, 100, 0);
      const e = touch(el, "touchmove", 50, 140);
      touch(el, "touchmove", 50, 200);
      flush();
      expect(e.defaultPrevented).toBe(false);
      expect(ty(sheet)).toBe("");
      touch(el, "touchend");
    }
  });

  it("below a scrolled child: no drag (the content scrolls back first)", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    Object.defineProperty(screen.getByTestId("list"), "scrollTop", { configurable: true, value: 30 });
    const item = screen.getByTestId("item");
    touch(item, "touchstart", 50, 100, 0);
    touch(item, "touchmove", 50, 140);
    flush();
    expect(ty(sheet)).toBe("");
  });

  it("a scrolled sheet drags from its data-sheet-handle (the sticky header), not from its content", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    Object.defineProperty(sheet, "scrollTop", { configurable: true, value: 120 });
    const gap = screen.getByTestId("gap");
    touch(gap, "touchstart", 50, 100, 0);
    touch(gap, "touchmove", 50, 140);
    flush();
    expect(ty(sheet)).toBe("");
    touch(gap, "touchend");
    const title = screen.getByTestId("title");
    touch(title, "touchstart", 50, 100, 0);
    touch(title, "touchmove", 50, 108);
    touch(title, "touchmove", 50, 128);
    flush();
    expect(ty(sheet)).toBe("translateY(20px)");
  });

  it("with nothing scrolled: from anywhere that is not a control", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    const item = screen.getByTestId("item");
    touch(item, "touchstart", 50, 100, 0);
    touch(item, "touchmove", 50, 108);
    touch(item, "touchmove", 50, 118);
    flush();
    expect(ty(sheet)).toBe("translateY(10px)");
  });

  it("two fingers: no drag", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    const e = new Event("touchstart", { bubbles: true, cancelable: true });
    e.touches = [{ clientX: 1, clientY: 100 }, { clientX: 90, clientY: 100 }];
    act(() => { sheet.dispatchEvent(e); });
    touch(sheet, "touchmove", 50, 140);
    flush();
    expect(ty(sheet)).toBe("");
  });
});

describe("direction first", () => {
  it("a first move up 5 px drops the gesture, with no preventDefault", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    touch(sheet, "touchstart", 50, 100, 0);
    const up = touch(sheet, "touchmove", 50, 95);
    const down = touch(sheet, "touchmove", 50, 140);
    flush();
    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
    expect(ty(sheet)).toBe("");
  });

  it("dx 3 / dy 1: kept, not prevented; next dy 6: prevented (clearly down), not yet engaged", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    touch(sheet, "touchstart", 50, 100, 0);
    const a = touch(sheet, "touchmove", 53, 101);
    expect(a.defaultPrevented).toBe(false);
    const b = touch(sheet, "touchmove", 53, 106);
    expect(b.defaultPrevented).toBe(true);
    flush();
    expect(ty(sheet)).toBe("");
    touch(sheet, "touchmove", 53, 110);
    flush();
    expect(ty(sheet)).toBe("translateY(0px)");
  });

  it("dx 12 / dy 3: sideways — dropped, so a sideways strip inside the sheet scrolls", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    touch(sheet, "touchstart", 50, 100, 0);
    const e = touch(sheet, "touchmove", 62, 103);
    touch(sheet, "touchmove", 62, 160);
    flush();
    expect(e.defaultPrevented).toBe(false);
    expect(ty(sheet)).toBe("");
  });
});

describe("release", () => {
  it("past 30 %, slowly: onDismiss once, data-dragged-out, a 240 ms throw with NO fill", () => {
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet, scrim, root } = prime();
    grab(sheet);
    dragTo(sheet, 124);                 // 0.31 × 400, at 0.1 px/ms
    touch(sheet, "touchend");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(root.hasAttribute("data-dragged-out")).toBe(true);
    const throwSheet = anims.find((a) => a.el === sheet);
    expect(throwSheet.opts).toEqual({ duration: 240, easing: "cubic-bezier(.4, 0, 1, 1)" });
    expect(throwSheet.opts).not.toHaveProperty("fill");
    expect(throwSheet.frames).toEqual([{ transform: "translateY(124px)" }, { transform: "translateY(100%)" }]);
    const fade = anims.find((a) => a.el === scrim);
    expect(fade.opts).not.toHaveProperty("fill");
    expect(fade.frames.at(-1)).toEqual({ opacity: 0 });
    // The inline drag styles are gone; CSS holds the sheet below the edge.
    expect(ty(sheet)).toBe("");
    expect(sheet.style.willChange).toBe("");
    expect(scrim.style.opacity).toBe("");
  });

  it("at 40 px moving 0.8 px/ms: a throw — linear, clamp((h − dy) / v, 120, 240) ms", () => {
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet } = prime();
    grab(sheet);
    dragTo(sheet, 40, { step: 8, every: 10 });   // 0.8 px/ms
    touch(sheet, "touchend");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    const a = anims.find((x) => x.el === sheet);
    expect(a.opts).toEqual({ duration: Math.round(Math.min(240, Math.max(120, (400 - 40) / 0.8))), easing: "linear" });
  });

  it("a hard throw is quicker (2 px/ms → 180 ms), still linear", () => {
    render(<Sheet onDismiss={vi.fn()} />);
    const { sheet } = prime();
    grab(sheet);
    dragTo(sheet, 40, { step: 20, every: 10 });  // 2 px/ms
    touch(sheet, "touchend");
    expect(anims.find((x) => x.el === sheet).opts).toEqual({ duration: 180, easing: "linear" });
  });

  it("at 20 %, slowly: no dismiss; a spring back that ends at translateY(0px); the scrim returns in 180 ms", () => {
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet, scrim, root } = prime();
    grab(sheet);
    dragTo(sheet, 80);
    touch(sheet, "touchend");
    expect(onDismiss).not.toHaveBeenCalled();
    expect(root.hasAttribute("data-dragged-out")).toBe(false);
    const spring = anims.find((a) => a.el === sheet);
    expect(spring.frames[0].transform).toBe("translateY(80px)");
    expect(spring.frames.at(-1)).toEqual({ transform: "translateY(0px)", offset: 1 });
    expect(spring.opts.easing).toBe("linear");
    expect(spring.opts.duration).toBeLessThanOrEqual(1200);
    const back = anims.find((a) => a.el === scrim);
    expect(back.opts).toEqual({ duration: 180, easing: "cubic-bezier(.2, .8, .2, 1)" });
    expect(back.frames.at(-1)).toEqual({ opacity: 1 });
  });

  // Fix round (drag-stale-velocity / PLAT-1): a resting finger sends no
  // touchmove, so the last samples still read as a throw. The lift's own time
  // now counts: still for longer than stoppedAfter (40 ms on a fast phone, up
  // to 100 on a slow one) before it lifted = speed 0.
  it("a fast pull, then held still, then lifted (100 px in 100 ms, the lift 400 ms later): no dismiss, a spring back from rest", () => {
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet, root } = prime();
    grab(sheet);
    dragTo(sheet, 100, { step: 20, every: 20 });  // 1 px/ms: a throw if it lifted now
    touch(sheet, "touchend", 0, 0, 400);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(root.hasAttribute("data-dragged-out")).toBe(false);
    const spring = anims.find((a) => a.el === sheet);
    expect(spring.frames[0].transform).toBe("translateY(100px)");
    expect(spring.frames.at(-1)).toEqual({ transform: "translateY(0px)", offset: 1 });
    // It starts from rest: the same keyframes as a release at speed 0.
    expect(spring.frames).toEqual(springKeyframes(100, 0, 0).keyframes);
  });

  it("the review's numbers: 60 px in about 50 ms, held 800 ms, lifted: it springs back (60 px is short of 30 %)", () => {
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet } = prime();
    grab(sheet);
    dragTo(sheet, 60, { step: 12, every: 10 });   // 1.2 px/ms
    touch(sheet, "touchend", 0, 0, 800);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(anims.find((a) => a.el === sheet).frames.at(-1).transform).toBe("translateY(0px)");
  });

  it("a fast phone (moves 10 ms apart): lifted 40 ms after the last move still throws; 41 ms is a stop (fix round 3)", () => {
    const first = vi.fn();
    const { unmount } = render(<Sheet onDismiss={first} />);
    let { sheet } = prime();
    grab(sheet);
    dragTo(sheet, 40, { step: 8, every: 10 });    // 0.8 px/ms
    touch(sheet, "touchend", 0, 0, 40);
    expect(first).toHaveBeenCalledTimes(1);
    unmount();
    anims = [];
    const second = vi.fn();
    render(<Sheet onDismiss={second} />);
    ({ sheet } = prime());
    grab(sheet);
    dragTo(sheet, 40, { step: 8, every: 10 });
    touch(sheet, "touchend", 0, 0, 41);
    expect(second).not.toHaveBeenCalled();
  });

  it("a slow phone (moves 50 ms apart): lifted 100 ms after the last move still throws; 101 ms is a stop", () => {
    const first = vi.fn();
    const { unmount } = render(<Sheet onDismiss={first} />);
    let { sheet } = prime();
    grab(sheet);
    dragTo(sheet, 90, { step: 30, every: 50 });   // 0.6 px/ms
    touch(sheet, "touchend", 0, 0, 100);
    expect(first).toHaveBeenCalledTimes(1);
    unmount();
    anims = [];
    const second = vi.fn();
    render(<Sheet onDismiss={second} />);
    ({ sheet } = prime());
    grab(sheet);
    dragTo(sheet, 90, { step: 30, every: 50 });
    touch(sheet, "touchend", 0, 0, 101);
    expect(second).not.toHaveBeenCalled();
  });

  it("a slow Android flick (moves 50 ms apart, the lift 70 ms after the last): it throws (device pass A: 2 in 5 sprang back at 40 ms)", () => {
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet, root } = prime();
    grab(sheet);
    dragTo(sheet, 90, { step: 30, every: 50 });    // 0.6 px/ms, 90 px: short of 30 % (120)
    touch(sheet, "touchend", 0, 0, 70);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(root.hasAttribute("data-dragged-out")).toBe(true);
  });

  it("touchcancel at 50 % (the system took the touch): never a dismiss, a spring back", () => {
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet, root } = prime();
    grab(sheet);
    dragTo(sheet, 200, { step: 50, every: 10 });  // far and fast
    touch(sheet, "touchcancel");
    expect(onDismiss).not.toHaveBeenCalled();
    expect(root.hasAttribute("data-dragged-out")).toBe(false);
    expect(anims.find((a) => a.el === sheet).frames.at(-1).transform).toBe("translateY(0px)");
  });

  it("reduce motion: past 30 % closes at once and never animates; short of it snaps back", () => {
    motionPref({ reduce: true });
    const onDismiss = vi.fn();
    render(<Sheet onDismiss={onDismiss} />);
    const { sheet } = prime();
    grab(sheet);
    dragTo(sheet, 80);
    flush();
    expect(ty(sheet)).toBe("translateY(80px)");    // the drag still follows the finger
    touch(sheet, "touchend");
    expect(ty(sheet)).toBe("");
    expect(onDismiss).not.toHaveBeenCalled();
    grab(sheet);
    dragTo(sheet, 140);
    touch(sheet, "touchend");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet.animate).not.toHaveBeenCalled();
    expect(screen.getByTestId("scrim").animate).not.toHaveBeenCalled();
  });
});

describe("lifetime", () => {
  it("a re-render with a new onDismiss mid-drag keeps the gesture (listeners not rebound)", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Sheet onDismiss={first} />);
    const { sheet } = prime();
    const add = vi.spyOn(sheet, "addEventListener");
    grab(sheet);
    dragTo(sheet, 60);
    rerender(<Sheet onDismiss={second} />);      // the 1 s clock tick re-renders the parent
    expect(add).not.toHaveBeenCalled();
    dragTo(sheet, 160);                          // continues from where it was
    expect(ty(sheet)).toBe("translateY(160px)");
    touch(sheet, "touchend");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("enabled false → true on the same node (a reopen right after a flick): data-dragged-out removed, earlier animations cancelled", () => {
    const { rerender } = render(<Sheet onDismiss={vi.fn()} />);
    const { sheet, root } = prime();
    grab(sheet);
    dragTo(sheet, 140);
    touch(sheet, "touchend");
    expect(root.hasAttribute("data-dragged-out")).toBe(true);
    const played = [...anims];
    expect(played.length).toBeGreaterThan(0);
    rerender(<Sheet onDismiss={vi.fn()} enabled={false} />);   // closing
    rerender(<Sheet onDismiss={vi.fn()} enabled />);           // reopened within the exit
    expect(root.hasAttribute("data-dragged-out")).toBe(false);
    for (const a of played) expect(a.cancel).toHaveBeenCalled();
  });

  it("a sheet whose parent mounted first (enabled false, then the sheet mounts and enabled turns true): the drag works", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Sheet onDismiss={onDismiss} enabled={false} mounted={false} />);
    rerender(<Sheet onDismiss={onDismiss} enabled mounted />);
    const { sheet } = prime();
    grab(sheet);
    dragTo(sheet, 200);
    touch(sheet, "touchend");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("disabling mid-drag (BACK pressed) clears the inline transform so the CSS exit plays", () => {
    const { rerender } = render(<Sheet onDismiss={vi.fn()} />);
    const { sheet, scrim } = prime();
    grab(sheet);
    dragTo(sheet, 60);
    expect(ty(sheet)).toBe("translateY(60px)");
    rerender(<Sheet onDismiss={vi.fn()} enabled={false} />);
    expect(ty(sheet)).toBe("");
    expect(sheet.style.willChange).toBe("");
    expect(scrim.style.opacity).toBe("");
  });
});
