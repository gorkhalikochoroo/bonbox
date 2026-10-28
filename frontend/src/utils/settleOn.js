// Keep an anchor at the top while the page settles (booking R13 fix,
// "Tilføj logo" → /profile#brand). App.jsx's ScrollManager scrolls to the
// anchor as soon as it exists — while the cards ABOVE it are still loading
// their own data; as they grow they pushed #brand 700–1,500 px down and the
// owner arrived somewhere in the middle of Profil. So: every time the page's
// height changes, scroll the anchor back to the top — and stop for good the
// moment the owner scrolls, taps or types (never fight them), once the page
// has not moved for SETTLED_MS, or after SETTLE_MAX_MS whatever happens.

export const SETTLED_MS = 2500;
export const SETTLE_MAX_MS = 12000;
const USER = ["wheel", "touchstart", "keydown", "mousedown"];

/** Start settling on `el` (already scrolled to once); returns stop(). */
export function settleOn(el) {
  if (typeof window === "undefined" || typeof ResizeObserver === "undefined" || !el) return () => {};
  let stopped = false;
  let quiet = 0;
  let max = 0;
  let ro = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(quiet);
    clearTimeout(max);
    try {
      ro?.disconnect();
    } catch {
      /* noop */
    }
    for (const t of USER) window.removeEventListener(t, stop, true);
  };
  const again = () => {
    if (stopped) return;
    if (!el.isConnected) {
      stop();
      return;
    }
    const want = parseFloat(window.getComputedStyle(el).scrollMarginTop) || 0;
    if (Math.abs(el.getBoundingClientRect().top - want) > 2) el.scrollIntoView({ block: "start" });
    clearTimeout(quiet);
    quiet = setTimeout(stop, SETTLED_MS);
  };
  for (const t of USER) window.addEventListener(t, stop, { capture: true, passive: true });
  quiet = setTimeout(stop, SETTLED_MS);
  max = setTimeout(stop, SETTLE_MAX_MS);
  ro = new ResizeObserver(again);
  ro.observe(document.body);
  return stop;
}
