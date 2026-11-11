/**
 * The keyboard lift per platform (Android walk 11 Nov 2026).
 *
 * Android: Capacitor 8's SystemBars pads the window by the keyboard, so the
 * WebView itself shrinks (914 → 578 css px). Lifting fixed bars by the
 * plugin's keyboardHeight on top of that lifted them twice: the chat composer
 * jumped over the thread title, the messages vanished, forms were cut. There
 * the lift is 0 (what the visual viewport still reports) and `open` is true.
 *
 * iOS (the WebView keeps its height, `resize: "body"`) and the web keep the
 * exact old numbers.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ native: true, android: false }));
vi.mock("../utils/platform", () => ({
  platform: {
    get isNative() { return env.native; },
    get isAndroid() { return env.native && env.android; },
    get isIOS() { return env.native && !env.android; },
    get isWeb() { return !env.native; },
  },
  isNativeApp: () => env.native,
}));
const kbd = vi.hoisted(() => ({ show: null, hide: null }));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    addListener: (name, fn) => {
      if (name === "keyboardWillShow") kbd.show = fn;
      if (name === "keyboardWillHide") kbd.hide = fn;
      return Promise.resolve({ remove: () => {} });
    },
  },
}));

const { useKeyboardState, useKeyboardLift } = await import("../hooks/useKeyboardLift");

/** A visual viewport that reports `covered` px under the keyboard. */
function stubViewport(covered = 0) {
  const listeners = new Set();
  const vv = {
    scale: 1,
    offsetTop: 0,
    get height() { return window.innerHeight - covered; },
    addEventListener: (_t, f) => listeners.add(f),
    removeEventListener: (_t, f) => listeners.delete(f),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  return {
    set(px) { covered = px; act(() => listeners.forEach((f) => f())); },
  };
}

beforeEach(() => {
  env.native = true;
  env.android = false;
  kbd.show = null;
  kbd.hide = null;
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 914 });
});
afterEach(() => {
  delete window.visualViewport;
});

describe("useKeyboardState", () => {
  it("Android: the WebView already shrank — keyboard open, lift 0 (no second lift)", () => {
    env.android = true;
    stubViewport(0); // innerHeight and the visual viewport shrink together
    const { result } = renderHook(() => useKeyboardState());
    expect(result.current).toEqual({ lift: 0, open: false });
    act(() => kbd.show({ keyboardHeight: 336 }));
    expect(result.current).toEqual({ lift: 0, open: true });
    act(() => kbd.hide());
    expect(result.current).toEqual({ lift: 0, open: false });
  });

  it("Android: if the visual viewport ever does report a covered band, that (not the plugin height) is the lift", () => {
    env.android = true;
    const vv = stubViewport(0);
    const { result } = renderHook(() => useKeyboardState());
    act(() => kbd.show({ keyboardHeight: 336 }));
    vv.set(120);
    expect(result.current).toEqual({ lift: 120, open: true });
  });

  it("iOS: unchanged — the plugin's height, or the visual viewport's when WebKit reports one", () => {
    const vv = stubViewport(0);
    const { result } = renderHook(() => useKeyboardState());
    act(() => kbd.show({ keyboardHeight: 336 }));
    expect(result.current).toEqual({ lift: 336, open: true });
    vv.set(300);
    expect(result.current).toEqual({ lift: 300, open: true });
    act(() => kbd.hide());
    expect(result.current).toEqual({ lift: 0, open: false });
  });

  it("web: unchanged — the visual viewport only", () => {
    env.native = false;
    const vv = stubViewport(0);
    const { result } = renderHook(() => useKeyboardState());
    expect(result.current).toEqual({ lift: 0, open: false });
    vv.set(300);
    expect(result.current).toEqual({ lift: 300, open: true });
  });

  it("useKeyboardLift stays the number it always was", () => {
    stubViewport(0);
    const { result } = renderHook(() => useKeyboardLift());
    act(() => kbd.show({ keyboardHeight: 336 }));
    expect(result.current).toBe(336);
  });
});
