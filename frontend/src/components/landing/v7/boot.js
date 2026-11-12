/* How the v7 landing starts (pages/LandingV7Page.jsx), read once at its first render. */
import { RISE_QUERY } from "./assets";

/** Did the HTML draw the first screen on this load (window.__lp6First.drawn, set by its script)? Read once. */
export function firstScreenDrawn() {
  try { return !!(window.__lp6First && window.__lp6First.drawn); } catch { return false; }
}

const RISE_MS = 1900; // the stage's 3D rise: .2 s delay + 1.7 s (landingV7.css lp7-rise3d)

/** How the page starts, read once at its first render: over the HTML's first screen ("calm") the arrival carries on where
 *  that screen has got to (elapsed ms since it was drawn), and the 3D rise only runs if it is not over yet. */
export function bootState() {
  const calm = firstScreenDrawn();
  let elapsed = 0;
  if (calm) {
    try { elapsed = Math.max(0, Math.round(performance.now() - (window.__lp6First.at || 0))); } catch { elapsed = RISE_MS; }
  }
  let rise = false;
  try { rise = !!window.matchMedia && !window.matchMedia("(prefers-reduced-motion: reduce)").matches && window.matchMedia(RISE_QUERY).matches; } catch { rise = false; }
  return { calm, elapsed, enter: rise && elapsed < RISE_MS };
}
