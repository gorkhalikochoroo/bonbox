/**
 * Every text field in the staff portal stays visible above the keyboard in
 * the native Scheduler shell (round-2 C11: the Fravær note and its Send
 * button sat under the keyboard and nothing scrolled them up).
 *
 * jsdom has no layout, so the geometry is stubbed: an iPhone 844 px tall with
 * a 336 px keyboard leaves y < 508 visible.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let native = true;
let android = false;
let kb = 0;
let kbOpen = false;
vi.mock("../utils/platform", () => ({
  platform: {
    get isNative() { return native; },
    get isIOS() { return native && !android; },
    get isAndroid() { return android; },
    get isWeb() { return !native; },
  },
  isNativeApp: () => native,
}));
// Edited 12 Nov 2026: the hook now reads useKeyboardState (it needs `open`
// for Android, where the lift is 0 while the keyboard is up); the lift is the
// same number useKeyboardLift returned.
vi.mock("../hooks/useKeyboardLift", () => ({
  useKeyboardLift: () => kb,
  useKeyboardState: () => ({ lift: kb, open: kb > 0 || kbOpen }),
}));

const { revealAboveKeyboard, useKeyboardReveal, KB_LIFT_STYLE } = await import("../hooks/useKeyboardReveal");

const rect = (top, bottom) => ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top, x: 0, y: top });

/** A 100dvh-style scroller holding a small form whose note field sits low. */
function buildShell({ fieldTop = 552, blockTop = 400, blockBottom = 700, boxBottom = 508 } = {}) {
  document.body.innerHTML = `
    <div id="shell" style="overflow-y:auto">
      <div id="form" data-kb-block="">
        <input id="note" type="text" />
        <button>Send anmodning</button>
      </div>
    </div>
    <div data-kb-skip=""><textarea id="composer"></textarea></div>`;
  const shell = document.getElementById("shell");
  Object.defineProperty(shell, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(shell, "clientHeight", { configurable: true, value: boxBottom });
  shell.getBoundingClientRect = () => rect(0, boxBottom);
  shell.scrollBy = vi.fn();
  document.getElementById("form").getBoundingClientRect = () => rect(blockTop, blockBottom);
  document.getElementById("note").getBoundingClientRect = () => rect(fieldTop, fieldTop + 40);
  return shell;
}

beforeEach(() => {
  native = true;
  android = false;
  kb = 0;
  kbOpen = false;
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
});
afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--kb-h");
  vi.useRealTimers();
});

describe("revealAboveKeyboard", () => {
  it("lifts the whole Fravær form so the note AND Send sit above the keyboard", () => {
    const shell = buildShell();
    expect(revealAboveKeyboard(document.getElementById("note"), 336)).toBe(true);
    // Visible band ends at 508 − 12 = 496; the form ends at 700 → scroll 204.
    expect(shell.scrollBy).toHaveBeenCalledWith({ top: 204, behavior: "smooth" });
  });

  it("centres a lone field when its form is taller than what is left", () => {
    const shell = buildShell({ blockTop: 0, blockBottom: 1400 });
    revealAboveKeyboard(document.getElementById("note"), 336);
    // Field centre 572 → centre of 8..496 = 252 → scroll 320.
    expect(shell.scrollBy).toHaveBeenCalledWith({ top: 320, behavior: "smooth" });
  });

  it("leaves a field alone when it and its buttons are already in view", () => {
    const shell = buildShell({ fieldTop: 120, blockTop: 100, blockBottom: 300 });
    expect(revealAboveKeyboard(document.getElementById("note"), 336)).toBe(false);
    expect(shell.scrollBy).not.toHaveBeenCalled();
  });

  it("never moves a field that handles the keyboard itself (the chat composer)", () => {
    buildShell();
    expect(revealAboveKeyboard(document.getElementById("composer"), 336)).toBe(false);
  });

  it("ignores non-typing controls and a closed keyboard", () => {
    buildShell();
    expect(revealAboveKeyboard(document.querySelector("button"), 336)).toBe(false);
    expect(revealAboveKeyboard(document.getElementById("note"), 0)).toBe(false);
  });
});

function Harness() {
  const lift = useKeyboardReveal();
  return <div data-testid="lift" data-lift={lift} style={KB_LIFT_STYLE} />;
}

describe("useKeyboardReveal", () => {
  it("native: publishes --kb-h and scrolls the focused field into view once the layout settles", () => {
    vi.useFakeTimers();
    const shell = buildShell();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { getByTestId, rerender } = render(<Harness />, { container: host });
    document.getElementById("note").focus();

    kb = 336;
    rerender(<Harness />);
    expect(getByTestId("lift").dataset.lift).toBe("336");
    expect(document.documentElement.style.getPropertyValue("--kb-h")).toBe("336px");
    expect(shell.scrollBy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(120); });
    expect(shell.scrollBy).toHaveBeenCalledTimes(1);

    kb = 0;
    rerender(<Harness />);
    expect(document.documentElement.style.getPropertyValue("--kb-h")).toBe("");
  });

  it("web: does nothing — Safari already pans the visual viewport", () => {
    native = false;
    kb = 336;
    const { getByTestId } = render(<Harness />);
    expect(getByTestId("lift").dataset.lift).toBe("0");
    expect(document.documentElement.style.getPropertyValue("--kb-h")).toBe("");
  });

  it("a fixed sheet rides on top of the keyboard via the shared style", () => {
    expect(KB_LIFT_STYLE).toEqual({ paddingBottom: "var(--kb-h, 0px)" });
  });
});

/**
 * Android 14 walk (12 Nov 2026), P4: in the profile sheet the postcode field
 * (571-609) sat 10 px under the keyboard of a window that had already shrunk
 * to 599 px; the old WebView's own scroll stopped short. On Android the
 * window ends at the keyboard (lift 0), so the reveal runs against the window
 * once it has resized. iOS is unchanged (the tests above).
 */
describe("Android app: the window already ends at the keyboard", () => {
  // The profile sheet: a scroller filling the shrunk window, the postcode low in a long form.
  function buildSheet({ fieldTop = 571 } = {}) {
    const shell = buildShell({ fieldTop, blockTop: 0, blockBottom: 1400, boxBottom: 599 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 599 });
    return shell;
  }

  it("revealAboveKeyboard with kb 0 does nothing, unless the window has resized for it", () => {
    const shell = buildSheet();
    expect(revealAboveKeyboard(document.getElementById("note"), 0)).toBe(false);
    expect(revealAboveKeyboard(document.getElementById("note"), 0, window, { resized: true })).toBe(true);
    // Band 8..587 (599 − 12), centre 297.5; the field's centre 591 → 293.5.
    expect(shell.scrollBy).toHaveBeenCalledWith({ top: 293.5, behavior: "smooth" });
  });

  it("keyboard up: once the window's resize settles, the focused field is scrolled fully into view; no --kb-h", () => {
    vi.useFakeTimers();
    native = true;
    android = true;
    const shell = buildSheet();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { rerender } = render(<Harness />, { container: host });
    document.getElementById("note").focus();
    kbOpen = true;
    rerender(<Harness />);
    expect(document.documentElement.style.getPropertyValue("--kb-h")).toBe("");
    act(() => { vi.advanceTimersByTime(100); });
    window.dispatchEvent(new Event("resize"));
    act(() => { vi.advanceTimersByTime(59); });
    expect(shell.scrollBy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(shell.scrollBy).toHaveBeenCalledTimes(1);
    expect(shell.scrollBy).toHaveBeenCalledWith({ top: 293.5, behavior: "smooth" });
    // The fallback it replaced never scrolls a second time.
    act(() => { vi.advanceTimersByTime(500); });
    expect(shell.scrollBy).toHaveBeenCalledTimes(1);
  });

  it("no resize event at all: the 300 ms fallback reveals it", () => {
    vi.useFakeTimers();
    android = true;
    const shell = buildSheet();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { rerender } = render(<Harness />, { container: host });
    document.getElementById("note").focus();
    kbOpen = true;
    rerender(<Harness />);
    act(() => { vi.advanceTimersByTime(299); });
    expect(shell.scrollBy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(shell.scrollBy).toHaveBeenCalledTimes(1);
  });

  it("a field already in view stays put; the keyboard down stops listening", () => {
    vi.useFakeTimers();
    android = true;
    const shell = buildShell({ fieldTop: 200, blockTop: 150, blockBottom: 400, boxBottom: 599 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 599 });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { rerender } = render(<Harness />, { container: host });
    document.getElementById("note").focus();
    kbOpen = true;
    rerender(<Harness />);
    window.dispatchEvent(new Event("resize"));
    act(() => { vi.advanceTimersByTime(400); });
    expect(shell.scrollBy).not.toHaveBeenCalled();
    kbOpen = false;
    rerender(<Harness />);
    window.dispatchEvent(new Event("resize"));
    act(() => { vi.advanceTimersByTime(400); });
    expect(shell.scrollBy).not.toHaveBeenCalled();
  });

  it("the iPhone never takes this path (its keyboard has a height: the tests above)", () => {
    vi.useFakeTimers();
    android = false;
    const shell = buildSheet();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { rerender } = render(<Harness />, { container: host });
    document.getElementById("note").focus();
    kbOpen = true;            // open but no height: on iOS nothing moves
    rerender(<Harness />);
    window.dispatchEvent(new Event("resize"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shell.scrollBy).not.toHaveBeenCalled();
  });
});
