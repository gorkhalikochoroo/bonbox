import { useEffect } from "react";
import { platform } from "../utils/platform";
import { useKeyboardLift } from "./useKeyboardLift";

/**
 * Keep whatever text field has focus visible above the on-screen keyboard —
 * for every field on a page, not one screen at a time.
 *
 * Why the native shell needs this at all: the Keyboard plugin runs with
 * `resize: "body"`. That shortens document.body and nothing else, and the
 * plugin also unhooks WKWebView's own keyboard observers, so WebKit never
 * scrolls a focused field into view. The staff portal does not scroll on body:
 * it scrolls inside one 100dvh shell, and its sheets are position:fixed. Both
 * keep their full height, so a field near the bottom (the Fravær note, its
 * Send button, a bank number in the profile sheet) stayed under the keyboard
 * and the staffer typed blind. Round 1 lifted only the chat composer.
 *
 * What this does, on native only (Safari already pans the visual viewport, so
 * doing it on the web would move the field twice):
 *   • publishes the keyboard height as the CSS variable `--kb-h` on <html>, so
 *     a fixed sheet can sit on top of the keyboard with
 *     `padding-bottom: var(--kb-h, 0px)` (see KB_LIFT_STYLE);
 *   • returns the height, so a full-height scroller can end at the keyboard's
 *     top edge instead of behind it;
 *   • once the layout has settled, scrolls the focused field — or the whole
 *     small form it sits in, when it is marked `data-kb-block` — into the
 *     part of its scroller the keyboard leaves visible. Moving focus to the
 *     next field while the keyboard stays up does the same.
 *
 * A field that already handles the keyboard itself (the chat composer rides on
 * top of it) opts out with `data-kb-skip`.
 */
export const KB_LIFT_STYLE = { paddingBottom: "var(--kb-h, 0px)" };

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "tel", "url", "number", "password"]);

export function isKeyboardField(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return TEXT_INPUT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
}

function scrollParent(el) {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/**
 * Scroll `el` (or its `data-kb-block` form) above a keyboard `kb` px tall.
 * Returns true when it had to scroll. Exported for the tests.
 */
export function revealAboveKeyboard(el, kb, win = window) {
  if (!kb || !isKeyboardField(el)) return false;
  if (el.closest?.("[data-kb-skip]")) return false;
  const box = scrollParent(el);
  if (!box) return false;

  const isRoot = box === document.scrollingElement || box === document.documentElement;
  const boxRect = isRoot ? { top: 0, bottom: win.innerHeight } : box.getBoundingClientRect();
  const top = Math.max(boxRect.top, 0) + 8;
  const bottom = Math.min(boxRect.bottom, win.innerHeight - kb) - 12;
  if (bottom <= top) return false;

  const field = el.getBoundingClientRect();
  const block = el.closest?.("[data-kb-block]");
  const blockRect = block ? block.getBoundingClientRect() : field;
  // Already readable, and so is the form's own Send button: leave it alone.
  if (field.top >= top && blockRect.bottom <= bottom) return false;

  let delta;
  if (block && blockRect.bottom - blockRect.top <= bottom - top) {
    // The whole form fits: put its last row (the buttons) just above the
    // keyboard, so the staffer sees what they type AND where to send it.
    delta = blockRect.bottom - bottom;
    if (field.top - delta < top) delta = field.top - top;
  } else {
    // Centre the field in what the keyboard leaves visible.
    delta = (field.top + field.bottom) / 2 - (top + bottom) / 2;
  }
  if (Math.abs(delta) < 1) return false;
  if (typeof box.scrollBy === "function") box.scrollBy({ top: delta, behavior: "smooth" });
  else box.scrollTop += delta;
  return true;
}

export function useKeyboardReveal() {
  const raw = useKeyboardLift();
  const lift = platform.isNative ? raw : 0;

  useEffect(() => {
    const root = document.documentElement;
    if (lift > 0) root.style.setProperty("--kb-h", `${lift}px`);
    else root.style.removeProperty("--kb-h");
    if (!(lift > 0)) return undefined;

    // After React has applied the shorter shell / lifted sheet for this
    // keyboard height — measuring before that would aim at the old layout.
    const first = setTimeout(() => revealAboveKeyboard(document.activeElement, lift), 90);
    let next = null;
    const onFocusIn = (e) => {
      clearTimeout(next);
      next = setTimeout(() => revealAboveKeyboard(e.target, lift), 40);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      clearTimeout(first);
      clearTimeout(next);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [lift]);

  useEffect(() => () => document.documentElement.style.removeProperty("--kb-h"), []);

  return lift;
}
