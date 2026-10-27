// useAutoHeight — an element eases between heights instead of jumping.
//
// The booking page sits inside a restaurant's own website (the embed iframe
// resizes itself from our `bonbox:height` messages). When a service switch, a
// closed-day message or the next step changed the page's height, the
// restaurant's page jumped by that amount in one frame. This morphs it:
//
//   ResizeObserver reports the new height after layout and before paint, so
//   the old height is put back for that first frame (FLIP), then the element
//   eases to the new one. `overflow-y: clip` hides content that is taller
//   than the box for those few frames; x stays visible (the phone's date rail
//   bleeds sideways). Inline styles are cleared when it settles, so at rest
//   the element is exactly what its classes say.
//
// Off under prefers-reduced-motion, and wherever ResizeObserver is missing.
// The height messages stay integers — the host just receives a few more of
// them while the morph runs.
import { useEffect } from "react";

export const AUTO_HEIGHT_MS = 280;
export const AUTO_HEIGHT_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

function reducedMotion() {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  } catch {
    return false;
  }
}

// `node` is the element itself (from a callback ref), so the morph starts the
// moment the element mounts — the booking page renders it only after its
// loading screen, and a ref object would have been read while still empty.
export function useAutoHeight(node, { enabled = true, duration = AUTO_HEIGHT_MS } = {}) {
  useEffect(() => {
    const el = node;
    if (!enabled || !el || typeof ResizeObserver === "undefined" || reducedMotion()) return undefined;
    // The height the element last rested at (or is easing towards).
    let rest = el.getBoundingClientRect().height;
    let animating = false;
    let timer = 0;
    const clear = () => {
      el.style.height = "";
      el.style.transition = "";
      el.style.overflowY = "";
    };
    const settle = () => {
      animating = false;
      // Back to its natural height. If the content changed again while it
      // eased, the observer sees the difference and eases once more from
      // `rest` (the target it just reached).
      clear();
    };
    const ro = new ResizeObserver(() => {
      if (animating) return; // our own height writes
      const to = el.getBoundingClientRect().height;
      const from = rest;
      rest = to;
      if (!from || Math.abs(to - from) < 2) return;
      el.style.overflowY = "clip";
      el.style.transition = "none";
      el.style.height = `${from}px`;
      void el.offsetHeight; // commit the start frame
      el.style.transition = `height ${duration}ms ${AUTO_HEIGHT_EASE}`;
      el.style.height = `${to}px`;
      animating = true;
      clearTimeout(timer);
      timer = setTimeout(settle, duration + 40);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
      clear();
    };
  }, [node, enabled, duration]);
}

export default useAutoHeight;
