/**
 * The live-alert clips are built while the browser is idle, not inside the
 * first tap after an app load (round 18 perf lane: that tap froze for
 * 0,3–0,7 s at 4x CPU while three WAVs were synthesised).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realCreate = URL.createObjectURL;
beforeEach(() => { URL.createObjectURL = () => "blob:http://localhost/clip"; });
afterEach(() => {
  URL.createObjectURL = realCreate;
  delete window.requestIdleCallback;
  delete window.cancelIdleCallback;
  document.querySelectorAll("audio").forEach((a) => a.remove());
  vi.resetModules();
});

describe("prepareSoundWhenIdle", () => {
  it("builds the three clips one idle slot at a time, and only once", async () => {
    const slots = [];
    window.requestIdleCallback = (fn) => { slots.push(fn); return slots.length; };
    window.cancelIdleCallback = () => {};
    const { prepareSoundWhenIdle } = await import("../utils/sound");
    prepareSoundWhenIdle();
    expect(document.querySelectorAll("audio")).toHaveLength(0);
    slots.shift()();
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    while (slots.length) slots.shift()();
    expect(document.querySelectorAll("audio")).toHaveLength(3);
    prepareSoundWhenIdle();
    expect(slots).toHaveLength(0);
  });

  it("cancelled before its slot, it builds nothing", async () => {
    const slots = [];
    window.requestIdleCallback = (fn) => { slots.push(fn); return 7; };
    const cancel = vi.fn();
    window.cancelIdleCallback = cancel;
    const { prepareSoundWhenIdle } = await import("../utils/sound");
    const stop = prepareSoundWhenIdle();
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
    slots.forEach((fn) => fn());
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });
});
