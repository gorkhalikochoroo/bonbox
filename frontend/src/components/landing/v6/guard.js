/* The stage's last-line guard, as pure maths (PORT_PLAN 1.4 item 10). From the v6.3 prototype's guard() (v6.2 fix), logic unchanged.
 *
 * On a phone and on the one-column tablet stage, after placing, no screen may come closer than 20 px to the clock's bottom or
 * 24 px to the statement it shows with (+ its caption, where the plate carries one). engine.js measures the frame (offsetTop /
 * offsetHeight / style.scale, as laid out) and asks clearanceMisses(); a miss is logged (window.__lp6.warn with the debug hooks on), the layout runs once
 * more on fresh measures, and a miss that survives is repaired by repairMiss() (moved inside its band, or scaled to it).
 * The 22.50 tile + plan (tal, stand: one frame, the drawing lands on it) and the Z-bon (joined to the Kassen card's "I alt")
 * are never moved: logged only. */

export const CLOCK_AIR = 20;
export const COPY_AIR = 24;
export const NOFIX = Object.freeze(["tal", "stand", "zb"]);

/** A figure's visual box in frame coordinates. f = {offsetTop, h, scale (1 = none; about the centre), cap (px below it that
 *  belongs to it), zb: null | {k, dy} (the Z-bon's own transform: origin top left)}. */
export function figureBox(f) {
  let k = f.scale || 1, t = f.offsetTop + (f.h * (1 - k)) / 2;
  if (f.zb) { k = f.zb.k; t = f.offsetTop + f.zb.dy; }
  return { top: t, bottom: t + f.h * k + (f.cap || 0) };
}

/** Every figure that misses its air, as the engine logs it: {id, box, top, bottom (rounded), clock, copy, h, cap}.
 *  copyTops = the three statements' tops; a figure's copy is 0 | 1 | 2, or -1 for the highest one (the plate). */
export function clearanceMisses({ clockBottom, copyTops, figs }) {
  const bad = [];
  for (const f of figs) {
    const { top, bottom } = figureBox(f);
    const copy = f.copy < 0 ? Math.min(...copyTops) : copyTops[f.copy];
    if (top - clockBottom < CLOCK_AIR || copy - bottom < COPY_AIR)
      bad.push({ id: f.id, box: f.box || "", top: Math.round(top), bottom: Math.round(bottom), clock: clockBottom, copy, h: f.h, cap: f.cap || 0 });
  }
  return bad;
}

/** The second-pass repair of one logged miss x, for a figure now scaled k: inside its band (clock + 20 … statement − 24 − caption)
 *  if it fits, else scaled to the band (never under .5) at its top. Returns the figure's new style.top in px and its new scale
 *  (null = unchanged). */
export function repairMiss(x, k) {
  const lo = x.clock + CLOCK_AIR, hi = x.copy - COPY_AIR - x.cap, vh = x.bottom - x.cap - x.top;
  let top, scale = null;
  if (vh <= hi - lo) top = Math.max(lo, Math.min(hi - vh, x.top));
  else { k = Math.max(0.5, +((hi - lo) / x.h).toFixed(3)); scale = k; top = lo; }
  return { top: Math.round(top - (x.h * (1 - k)) / 2), scale };
}
