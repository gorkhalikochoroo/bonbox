import { feel } from "./feel";

// The finger-driven press (premium feel P3; BeloBag's press controller,
// adapted). One document-level controller while the portal is mounted. Touch
// and pen: it puts data-pressed on the touched control, and the CSS presses
// from that, never from :active, so a scroll never flashes a press. Mouse and
// keyboard keep :active.
// A stand-alone card (.vp-row) or a grouped row (.vp-tint) presses 70 ms late,
// so a scroll that starts on it never shows; a tap shorter than that still
// presses, for 90 ms, at the release (UIKit does the same). Everything else
// presses at once. A move over 10 px, a scroll, pointercancel or a second
// finger clears it. It reads no layout: "big" is decided by class, never by
// offsetWidth/offsetHeight, which would force a layout right after the 1 s
// clock tick changed the DOM.
export const PRESS = { WAIT: 70, TAP: 90, SLOP: 10 };
const TARGET = ".vp-press, .vp-tint, .vp-dock-item, button, a[href], [role='button']";
const LATE = ".vp-row, .vp-tint";
const WARMS = '[role="tab"],[role="switch"],[role="radio"],[aria-pressed]';
let el = null;
let timer = 0;
let x0 = 0;
let y0 = 0;
const setModality = (m) => {
  const h = document.documentElement;
  if (h.dataset.modality !== m) h.dataset.modality = m;   // write only on a change: it restyles the page
};
const clear = () => { clearTimeout(timer); timer = 0; if (el) { delete el.dataset.pressed; el = null; } };
function down(e) {
  setModality(e.pointerType === "mouse" ? "mouse" : "touch");
  clear();
  if (e.pointerType === "mouse" || !e.isPrimary) return;
  const t = e.target?.closest?.(TARGET);
  // [inert] by attribute, so also on iOS 15.0-15.4 where inert itself does nothing.
  if (!t || t.disabled || t.getAttribute("aria-disabled") === "true" || t.closest("[inert],[data-closing]")) return;
  if (t.matches(WARMS)) feel.warm();
  x0 = e.clientX; y0 = e.clientY; el = t;
  if (t.matches(LATE)) timer = setTimeout(() => { timer = 0; if (el === t) t.dataset.pressed = ""; }, PRESS.WAIT);
  else t.dataset.pressed = "";
}
function move(e) {
  if (el && e.isPrimary && (Math.abs(e.clientX - x0) > PRESS.SLOP || Math.abs(e.clientY - y0) > PRESS.SLOP)) clear();
}
function up() {
  if (el && timer) {                      // a quick tap on a late card: press now, briefly
    const t = el;
    clearTimeout(timer); timer = 0; el = null;
    t.dataset.pressed = "";
    setTimeout(() => { delete t.dataset.pressed; }, PRESS.TAP);
    return;
  }
  clear();
}
const key = () => setModality("keyboard");

/** Install on mount; the return value uninstalls (listeners, any press, the modality). */
export function installPressFeel() {
  const o = { capture: true, passive: true };
  const on = [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", clear], ["scroll", clear], ["keydown", key]];
  on.forEach(([t, f]) => document.addEventListener(t, f, o));
  return () => {
    on.forEach(([t, f]) => document.removeEventListener(t, f, o));
    clear();
    delete document.documentElement.dataset.modality;
  };
}
