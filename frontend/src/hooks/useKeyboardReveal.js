import { useEffect } from "react";
import { platform } from "../utils/platform";
import { useKeyboardState } from "./useKeyboardLift";

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
 *
 * Android is different (see useKeyboardLift): the window itself shrinks to end
 * at the keyboard, so there is no height to lift by (lift 0) and the WebView
 * scrolls a focused field into view on its own. Old WebViews stop short: on
 * Android 14 (WebView 113) the profile sheet's postcode field stayed 10 px
 * under the keyboard (walk, 12 Nov 2026). So on Android, while the keyboard
 * is up, the same reveal runs once the window has resized (and when focus
 * moves), measured against the already-shortened window. iOS is unchanged.
 *
 * Device pass A (12 Nov 2026) found it still 10 px short on the first
 * keyboard of a session: the WebView's own scroll (the 10 px) lands 30-100 ms
 * after the resize, and when it landed after our smooth scroll had started it
 * cut that scroll off where it was. So the Android reveal waits 150 ms after
 * the last resize (past the WebView's own scroll), and one check 700 ms later
 * finishes a reveal that was still cut short, at once (a no-op when the field
 * is already in view).
 */
export const KB_LIFT_STYLE = { paddingBottom: "var(--kb-h, 0px)" };

// Android: wait this long after the last resize (the WebView's own scroll lands
// 30-100 ms after it), and check a reveal that scrolled this long afterwards.
const ANDROID_SETTLE_MS = 150;
const ANDROID_RECHECK_MS = 700;

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
export function revealAboveKeyboard(el, kb, win = window, { resized = false, behavior = "smooth" } = {}) {
  // `resized`: Android — the window already ends at the keyboard's top edge,
  // so kb is 0 and the visible band is simply the (shorter) window.
  if ((!kb && !resized) || !isKeyboardField(el)) return false;
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
  if (typeof box.scrollBy === "function") box.scrollBy({ top: delta, behavior });
  else box.scrollTop += delta;
  return true;
}

export function useKeyboardReveal() {
  const { lift: raw, open } = useKeyboardState();
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

  // Android app, keyboard up (the window has shrunk; lift stays 0): reveal the
  // focused field once the resize has settled, and again when focus moves. A
  // fallback runs if no resize event comes (the window shrank before this ran).
  // A reveal that scrolled is checked once more after its smooth scroll should
  // have ended: if the WebView's own late scroll cut it short, it finishes at
  // once (see the note at the top).
  const androidUp = platform.isNative && platform.isAndroid && !!open && !(lift > 0);
  useEffect(() => {
    if (!androidUp) return undefined;
    let next = null;
    let check = null;
    const reveal = (el, ms) => {
      clearTimeout(next);
      clearTimeout(check);
      next = setTimeout(() => {
        const field = el || document.activeElement;
        if (!revealAboveKeyboard(field, 0, window, { resized: true })) return;
        check = setTimeout(() => {
          if (document.activeElement === field) revealAboveKeyboard(field, 0, window, { resized: true, behavior: "auto" });
        }, ANDROID_RECHECK_MS);
      }, ms);
    };
    const onResize = () => reveal(null, ANDROID_SETTLE_MS);
    const onFocusIn = (e) => reveal(e.target, 40);
    window.addEventListener("resize", onResize);
    document.addEventListener("focusin", onFocusIn);
    reveal(null, 300);
    return () => {
      clearTimeout(next);
      clearTimeout(check);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [androidUp]);

  useEffect(() => () => document.documentElement.style.removeProperty("--kb-h"), []);

  return lift;
}
