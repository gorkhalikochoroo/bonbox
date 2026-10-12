/**
 * The keyboard's "next" key and the keyboard closing on a valid submit
 * (mobile walk, 12 Oct 2026).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissKeyboard, enterToNext } from "./phoneForm";

afterEach(() => { document.body.innerHTML = ""; });

const field = (id) => {
  const el = document.createElement("input");
  el.id = id;
  document.body.appendChild(el);
  return el;
};
const keyEvent = (over = {}) => ({ key: "Enter", keyCode: 13, preventDefault: vi.fn(), nativeEvent: {}, ...over });

describe("enterToNext", () => {
  it("Enter moves the focus to the next field and stops the form being sent", () => {
    field("a");
    const b = field("b");
    const e = keyEvent();
    enterToNext({ current: b })(e);
    expect(document.activeElement).toBe(b);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("takes a function for the next field too", () => {
    const b = field("b");
    enterToNext(() => b)(keyEvent());
    expect(document.activeElement).toBe(b);
  });

  it.each([
    ["another key", { key: "a", keyCode: 65 }],
    ["Enter that confirms an IME composition (keyCode 229)", { keyCode: 229 }],
    ["Enter while composing", { nativeEvent: { isComposing: true } }],
    ["Shift+Enter", { shiftKey: true }],
    ["Ctrl+Enter", { ctrlKey: true }],
    ["Cmd+Enter", { metaKey: true }],
  ])("%s is left alone", (_name, over) => {
    const a = field("a");
    const b = field("b");
    a.focus();
    const e = keyEvent(over);
    enterToNext({ current: b })(e);
    expect(document.activeElement).toBe(a);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("no next field (not rendered): the form's own Enter is kept", () => {
    const e = keyEvent();
    enterToNext({ current: null })(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("dismissKeyboard", () => {
  it("a focused text field lets go (a phone closes its keyboard)", () => {
    const a = field("a");
    a.focus();
    expect(dismissKeyboard()).toBe(true);
    expect(document.activeElement).not.toBe(a);
  });

  it("a focused button keeps its focus (no keyboard there)", () => {
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.focus();
    expect(dismissKeyboard()).toBe(false);
    expect(document.activeElement).toBe(btn);
  });
});
