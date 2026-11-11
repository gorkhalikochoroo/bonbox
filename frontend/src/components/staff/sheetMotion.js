import { useEffect, useState } from "react";

/**
 * Exit motion for the Vagtplan's sheets and dialogs (Nov 2026, the Orvexlo
 * motion kit: in 0.32s, out 0.24s).
 *
 * A sheet that is simply un-rendered cannot animate out, so an overlay stays
 * mounted for EXIT_MS with `data-closing` on it (vagtplan.css plays the exit
 * and stops it taking taps), then goes.
 *
 * Motion is opt-OUT by default-to-safety: when the browser cannot tell us the
 * motion preference (no matchMedia — e.g. an old WebView, or jsdom) or the
 * user asked for reduced motion, there is no exit at all and the sheet
 * unmounts in the same render, exactly as before.
 */
export const EXIT_MS = 240;
export const REDUCED_MOTION_Q = "(prefers-reduced-motion: reduce)";

/** True only when the browser can say, and says, that motion is welcome. */
export function motionAllowed() {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return !window.matchMedia(REDUCED_MOTION_Q)?.matches;
  } catch {
    return false;
  }
}

export function exitMs() {
  return motionAllowed() ? EXIT_MS : 0;
}

/**
 * usePresence(open) → { mounted, closing }.
 * Render the overlay while `mounted`; put `data-closing` on it while
 * `closing`. Reopening during the exit cancels it.
 */
export function usePresence(open) {
  const [st, setSt] = useState(() => ({ mounted: !!open, closing: false }));
  if (open && (!st.mounted || st.closing)) {
    setSt({ mounted: true, closing: false });
  } else if (!open && st.mounted && !st.closing) {
    setSt(exitMs() > 0 ? { mounted: true, closing: true } : { mounted: false, closing: false });
  }
  useEffect(() => {
    if (!st.closing) return undefined;
    const id = setTimeout(() => setSt((cur) => (cur.closing ? { mounted: false, closing: false } : cur)), EXIT_MS);
    return () => clearTimeout(id);
  }, [st.closing]);
  return st;
}

/**
 * useLastValue(v) — the last non-null value, for a sheet whose content comes
 * from the same state that opens it ({ wd } / null): during the exit the
 * state is already null, and the sheet still needs something to show.
 */
export function useLastValue(v) {
  const [last, setLast] = useState(v);
  if (v != null && v !== last) setLast(v);
  return v != null ? v : last;
}

/** Spread on an overlay root: `{...closingProps(closing)}`. */
export function closingProps(closing) {
  return closing ? { "data-closing": "", "aria-hidden": true, inert: true } : {};
}
