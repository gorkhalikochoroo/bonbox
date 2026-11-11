import { useEffect, useRef } from "react";
import { motionAllowed } from "./sheetMotion";
import { springKeyframes } from "./spring";

// Drag a sheet down to close (premium feel P5; BeloBag's values, with four
// review fixes: a handle instead of a fixed 76 px zone, no preventDefault
// before the direction is clear, no WAAPI fill that could outlive a reopen,
// and a system cancel never dismisses).
export const DRAG = { SLOP: 8, DISMISS: 0.3, FLICK: 0.5, FLICK_MIN: 16, RUBBER: 64, SAMPLES: 6 };
// BeloBag's rule: a control never starts a drag.
const CONTROL = 'input,textarea,select,button,a[href],label,[role="button"],[role="slider"],[role="switch"],[contenteditable="true"],[contenteditable=""]';
/** Past the top: a rubber band that never gives more than DRAG.RUBBER px. */
export const rubber = (x, d = DRAG.RUBBER) => d * (1 - 1 / ((x * 0.55) / d + 1));
/** The scrim's opacity while the sheet is pulled down dy px (never below 0.2). */
export const scrimAt = (dy, h) => Math.max(0.2, 1 - dy / (h * 1.4));
/** What a release does: dismiss (with time + easing) or spring back. */
export function releaseOf(dy, v, h) {
  if (!(dy > DRAG.DISMISS * h || (v > DRAG.FLICK && dy > DRAG.FLICK_MIN))) return { dismiss: false };
  const thrown = v > DRAG.FLICK;
  return {
    dismiss: true,
    ms: thrown ? Math.round(Math.min(240, Math.max(120, (h - dy) / v))) : 240,
    easing: thrown ? "linear" : "cubic-bezier(.4, 0, 1, 1)",   // keep the throw; or --ease-in
  };
}
// Anything between the finger and the sheet (the sheet included) scrolled down?
const scrolledBetween = (n, stop) => {
  for (; n && n !== stop; n = n.parentElement) if (n.scrollTop > 0) return true;
  return !!stop && stop.scrollTop > 0;
};

/** Attach to a sheet. onDismiss = the sheet's normal close (the same one ✕ and the scrim use).
    enabled must be false while the sheet is not mounted or is closing. */
export function useSheetDrag(sheetRef, onDismiss, { enabled = true } = {}) {
  // Held in a ref: a re-render mid-drag (the 1 s clock tick re-renders the ⋯ sheet's parent)
  // must never rebind the listeners and lose the gesture. Same lesson as pull-to-refresh.
  const close = useRef(onDismiss);
  useEffect(() => { close.current = onDismiss; });
  const live = useRef([]);   // this hook's own WAAPI animations
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!enabled || !sheet) return undefined;
    const root = sheet.closest("[data-vp-overlay]");
    const scrim = root?.querySelector(":scope > .vp-scrim") || null;
    // A reopen during the exit reuses the same nodes: start clean.
    live.current.forEach((a) => a.cancel()); live.current = [];
    if (root) delete root.dataset.draggedOut;
    let g = null;
    let raf = 0;
    const reset = () => {
      sheet.style.transform = ""; sheet.style.willChange = "";
      if (scrim) { scrim.style.opacity = ""; scrim.style.willChange = ""; }
    };
    const play = (el, frames, opts) => { if (el?.animate) live.current.push(el.animate(frames, opts)); };
    const draw = () => {
      raf = 0;
      if (!g) return;
      sheet.style.transform = `translateY(${g.dy >= 0 ? g.dy : -rubber(-g.dy)}px)`;
      if (scrim) scrim.style.opacity = String(scrimAt(Math.max(0, g.dy), g.h));
    };
    const start = (e) => {
      if (e.touches.length !== 1 || root?.hasAttribute("data-closing") || e.target.closest?.(CONTROL)) return;
      // A sheet's sticky header always grabs; elsewhere only when nothing above the finger is
      // scrolled (else the content scrolls back first).
      if (!e.target.closest?.("[data-sheet-handle]") && scrolledBetween(e.target, sheet)) return;
      const p = e.touches[0];
      g = { x0: p.clientX, y0: p.clientY, dy: 0, on: false, h: 0, s: [] };
    };
    const move = (e) => {
      if (!g) return;
      const p = e.touches[0];
      const dx = p.clientX - g.x0;
      const dy = p.clientY - g.y0;
      if (!g.on) {
        if (dy < -4 || Math.abs(dx) > Math.abs(dy) + 4) { g = null; return; }   // the content's scroll, or sideways
        if (dy <= 2 || dy <= Math.abs(dx)) return;          // not clearly down yet: decide on the next move
        if (e.cancelable) e.preventDefault();               // clearly down: iOS must not start the content's bounce
        if (dy < DRAG.SLOP) return;
        g.on = true; g.y0 = p.clientY; g.h = sheet.offsetHeight;   // no jump; one read
        sheet.getAnimations?.().forEach((a) => a.finish());
        scrim?.getAnimations?.().forEach((a) => a.finish());
        sheet.style.willChange = "transform";
        if (scrim) scrim.style.willChange = "opacity";
      }
      if (e.cancelable) e.preventDefault();
      g.dy = p.clientY - g.y0;
      g.s.push([e.timeStamp, g.dy]);
      if (g.s.length > DRAG.SAMPLES) g.s.shift();
      if (!raf) raf = requestAnimationFrame(draw);          // one write per frame
    };
    const finish = (cancelled) => {
      const was = g; g = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!was?.on) return;
      const s = was.s;
      const a = s[0];
      const b = s[s.length - 1];
      const v = s.length > 1 ? (b[1] - a[1]) / Math.max(1, b[0] - a[0]) : 0;
      const from = was.dy >= 0 ? was.dy : -rubber(-was.dy);
      const fade = scrimAt(Math.max(0, was.dy), was.h);
      const r = cancelled ? { dismiss: false } : releaseOf(was.dy, v, was.h);   // the system took the touch: never dismiss
      reset();
      if (r.dismiss) {
        if (root) root.dataset.draggedOut = "";        // the CSS exit must not play a second time
        if (motionAllowed()) {
          // No fill: [data-closing][data-dragged-out] holds the sheet at 100 % (1.5c) until unmount.
          const opts = { duration: r.ms, easing: r.easing };
          play(sheet, [{ transform: `translateY(${from}px)` }, { transform: "translateY(100%)" }], opts);
          play(scrim, [{ opacity: fade }, { opacity: 0 }], opts);
        }
        close.current?.();                             // same render task: data-closing lands before the throw ends
      } else if (motionAllowed()) {
        const sp = springKeyframes(from, 0, cancelled ? 0 : v);
        play(sheet, sp.keyframes, { duration: sp.duration, easing: "linear" });
        play(scrim, [{ opacity: fade }, { opacity: 1 }], { duration: 180, easing: "cubic-bezier(.2, .8, .2, 1)" });
      }
    };
    const end = () => finish(false);
    const cancel = () => finish(true);
    const passive = { passive: true };
    sheet.addEventListener("touchstart", start, passive);
    sheet.addEventListener("touchmove", move, { passive: false });
    sheet.addEventListener("touchend", end, passive);
    sheet.addEventListener("touchcancel", cancel, passive);
    return () => {
      sheet.removeEventListener("touchstart", start, passive);
      sheet.removeEventListener("touchmove", move, { passive: false });
      sheet.removeEventListener("touchend", end, passive);
      sheet.removeEventListener("touchcancel", cancel, passive);
      if (raf) cancelAnimationFrame(raf);
      g = null;
      reset();
    };
  }, [sheetRef, enabled]);
}
