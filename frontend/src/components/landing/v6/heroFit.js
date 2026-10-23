/* The hero on the two-column page, as pure maths (first-screen round, 23 Oct; Manoj circled the empty band between the top bar
 * and the headline at 1440 × 900: the crop marks start 40 px under the bar, the headline 154 px under it, because the hero was
 * centred on the stage's middle line).
 *
 * engine.js layout() measures the hero's four parts as laid out with no extra air (offsetTop / offsetHeight, font-size and
 * line-height as computed) and asks heroFit() for:
 *   top     the hero's padding-top: the headline hangs from the plate's top edge — its first line's visible cap top (not its line
 *           box: at line-height .98, Inter's capitals start ~.13 em under the line box's top) sits on the line of the top crop marks;
 *   a1, a2  the extra air above the subline and above the button row (landingV6.css: two spacer rows in the hero's grid). The column's
 *           air under the headline is shared in three equal bands — headline → subline, subline → button, trial line → the screen's
 *           bottom edge — the phone stage's own rule (equal visible bands), so the room the top gave up never piles up as one band at
 *           the bottom. A band already larger than its share keeps its size and the other two share the rest; the air only ever comes
 *           out of the bottom band, and only while that band is positive (a hero taller than the screen gets none).
 * Bands are measured on the type, as a reader sees them: from a line's baseline to the next text's cap top (or the button's top). */

/* Inter's vertical metrics in em (the hhea values of the Inter that @fontsource/inter ships, 2048 units per em): ascent 1984,
   descent 494, cap height 1490. A browser centres the glyphs' content area (ascent + descent) in each line box. */
export const INTER = Object.freeze({ asc: 1984 / 2048, desc: 494 / 2048, cap: 1490 / 2048 });

/** From a line box's top to that line's cap top (px), for font-size fs and line-height lh (px). */
export function capTop(fs, lh) { return (lh - (INTER.asc + INTER.desc) * fs) / 2 + (INTER.asc - INTER.cap) * fs; }

/** From a line box's top to that line's baseline (px). */
export function baseline(fs, lh) { return (lh - (INTER.asc + INTER.desc) * fs) / 2 + INTER.asc * fs; }

/** p = { plateTop, screenBottom, h1, sub, cta, trial }: plateTop and screenBottom in the hero's coordinates (the stage's top = 0),
 *  each part { top, h, fs, lh } as laid out with no extra air, its top measured from the hero's content top (the headline: 0).
 *  Returns { top, a1, a2, bands: [headline → subline, subline → button, trial line → screen bottom] } in px (unrounded),
 *  or null when a measure is missing (no layout: the engine then keeps the hero on the plate's top edge without air). */
export function heroFit({ plateTop, screenBottom, h1, sub, cta, trial }) {
  const nums = [plateTop, screenBottom];
  for (const p of [h1, sub, cta, trial]) { if (!p) return null; nums.push(p.top, p.h, p.fs, p.lh); }
  if (!nums.every((n) => Number.isFinite(n)) || !(h1.fs > 0)) return null;
  const lastBase = (p) => p.top + p.h - p.lh + baseline(p.fs, p.lh);
  const top = plateTop - (h1.top + capTop(h1.fs, h1.lh));
  const b1 = sub.top + capTop(sub.fs, sub.lh) - lastBase(h1);
  const b2 = cta.top - lastBase(sub);
  const b3 = screenBottom - (top + lastBase(trial));
  /* the air comes out of the bottom band only, and only while there is some: a band already over its share keeps its size and the
     other two share the rest */
  const T = b1 + b2 + b3;
  let L = T / 3;
  if (b1 > L) L = (T - b1) / 2;
  else if (b2 > L) L = (T - b2) / 2;
  const a1 = b3 > 0 ? Math.max(0, L - b1) : 0, a2 = b3 > 0 ? Math.max(0, L - b2) : 0;
  return { top, a1, a2, bands: [b1 + a1, b2 + a2, b3 - a1 - a2] };
}
