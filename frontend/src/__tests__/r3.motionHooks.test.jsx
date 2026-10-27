/**
 * Booking R3 — the motion pieces of the booking box:
 *   useDelayedFlag  the time grid dims only for a slow answer (judge change 1)
 *   useAutoHeight   the step area eases between heights (judge change 11)
 *   EarnedText      the bar's words move only when they change (change 10a)
 */
import { act, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import { AUTO_HEIGHT_MS, useAutoHeight } from "../hooks/useAutoHeight";
import EarnedText, { EARNED_ANIM } from "../components/booking/EarnedText";

describe("useDelayedFlag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a fast answer never turns it on", () => {
    const { result, rerender } = renderHook(({ f }) => useDelayedFlag(f, 180), { initialProps: { f: false } });
    expect(result.current).toBe(false);
    rerender({ f: true });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(120); });
    expect(result.current).toBe(false);
    rerender({ f: false });
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe(false);
  });

  it("a slow answer turns it on after the delay, and off the moment the flag drops", () => {
    const { result, rerender } = renderHook(({ f }) => useDelayedFlag(f, 180), { initialProps: { f: true } });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(179); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(2); });
    expect(result.current).toBe(true);
    rerender({ f: false });
    expect(result.current).toBe(false);
  });

  it("a second slow answer waits the full delay again", () => {
    const { result, rerender } = renderHook(({ f }) => useDelayedFlag(f, 180), { initialProps: { f: true } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toBe(true);
    rerender({ f: false });
    rerender({ f: true });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe(true);
  });
});

describe("useAutoHeight", () => {
  let observers;
  let height;
  const realRO = globalThis.ResizeObserver;
  const realMM = window.matchMedia;
  beforeEach(() => {
    vi.useFakeTimers();
    observers = [];
    height = 300;
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe(el) { this.el = el; }
      unobserve() {}
      disconnect() { this.gone = true; }
    };
    window.matchMedia = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.ResizeObserver = realRO;
    window.matchMedia = realMM;
  });

  function Box({ enabled = true }) {
    const [el, setEl] = useState(null);
    useAutoHeight(el, { enabled });
    return (
      <div
        data-testid="box"
        ref={(node) => {
          if (node) node.getBoundingClientRect = () => ({ height, width: 400, top: 0, left: 0, right: 400, bottom: height });
          setEl(node);
        }}
      />
    );
  }

  it("eases from the old height to the new one, clipping only y, then lets go", () => {
    render(<Box />);
    const box = screen.getByTestId("box");
    expect(observers).toHaveLength(1);
    // The first report (the observe itself) is the resting height: no morph.
    act(() => observers[0].cb([]));
    expect(box.style.height).toBe("");
    height = 420;
    act(() => observers[0].cb([]));
    expect(box.style.height).toBe("420px");
    expect(box.style.overflowY).toBe("clip");
    expect(box.style.overflowX).toBe("");
    expect(box.style.transition).toContain(`height ${AUTO_HEIGHT_MS}ms`);
    expect(box.style.transition).toContain("cubic-bezier(0.22, 1, 0.36, 1)");
    act(() => { vi.advanceTimersByTime(AUTO_HEIGHT_MS + 50); });
    expect(box.style.height).toBe("");
    expect(box.style.overflowY).toBe("");
    expect(box.style.transition).toBe("");
  });

  it("ignores a change under 2 px", () => {
    render(<Box />);
    const box = screen.getByTestId("box");
    height = 301;
    act(() => observers[0].cb([]));
    expect(box.style.height).toBe("");
  });

  it("does nothing under prefers-reduced-motion", () => {
    window.matchMedia = (q) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} });
    render(<Box />);
    expect(observers).toHaveLength(0);
  });

  it("does nothing when switched off, and cleans up on unmount", () => {
    const off = render(<Box enabled={false} />);
    expect(observers).toHaveLength(0);
    off.unmount();
    const on = render(<Box />);
    on.unmount();
    expect(observers[0].gone).toBe(true);
  });
});

describe("EarnedText", () => {
  it("still on first paint; a CHANGED text arrives; an unchanged one stays the same node", async () => {
    function Bar({ text }) {
      return <EarnedText as="p" text={text} className="x" />;
    }
    const { rerender } = render(<Bar text="Lør 31" />);
    const first = screen.getByText("Lør 31");
    expect(first.getAttribute("data-earned")).toBe("still");
    expect(first.className).not.toContain("bbLabel");
    // Armed one frame after the first paint — the first node never starts
    // an animation late.
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r())); });
    expect(screen.getByText("Lør 31")).toBe(first);
    expect(first.className).not.toContain("bbLabel");
    rerender(<Bar text="Lør 31" />);
    expect(screen.getByText("Lør 31")).toBe(first);
    rerender(<Bar text="Lør 31 · 19:30" />);
    const next = screen.getByText("Lør 31 · 19:30");
    expect(next).not.toBe(first);
    expect(next.getAttribute("data-earned")).toBe("arrive");
    expect(next.className).toContain(EARNED_ANIM);
    expect(EARNED_ANIM).toBe("motion-safe:animate-[bbLabel_260ms_cubic-bezier(0.22,1,0.36,1)]");
  });
});
