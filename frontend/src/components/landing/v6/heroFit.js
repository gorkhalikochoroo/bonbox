/* The hero on the two-column page, as pure maths.
 *
 * First-screen round (23 Oct; Manoj circled the empty band between the top bar and the headline at 1440 × 900: the crop marks
 * started 40 px under the bar, the headline 154 px under it, because the hero was centred on the stage's middle line): the
 * headline hangs from the plate's top edge.
 * Hero-group round (23 Oct; Claude's review of the first-screen screenshots: at 1920 × 1080 and 2560 × 1440 the headline, the
 * subline and the buttons floated apart, 157–277 px between each, because the column's air was shared in three equal bands): the
 * subline, the button row and the trial line are now ONE block with their own margins (sub 28 px, buttons 36 px, trial 12 px at
 * ≥ 1200), and the block sits on the roster card: its last baseline on the card's bottom edge, the way the headline's first cap
 * top sits on the top crop marks. The page then reads as two aligned edges, top and bottom, across both columns.
 *
 * engine.js layout() measures the hero's parts as laid out with no extra air (offsetTop / offsetHeight, font-size and line-height
 * as computed), the roster card's bottom edge as it placed it in the plate (same coordinates: the stage's top = 0), the plate's
 * bottom edge (the bottom crop marks' line) and the section gap, and asks heroFit() for:
 *   top   the hero's padding-top: the headline's first line's visible cap top (not its line box: at line-height .98, Inter's capitals
 *         start ~.13 em under the line box's top) on the line of the top crop marks;
 *   a1    the air above the subline (landingV6.css: one spacer row in the hero's grid), so that the block's bottom lands on the
 *         card's bottom edge — clamped (heroBlock()): the gap from the headline to the block is at least 40 px and at most 2 × the
 *         section gap, and the block never goes below the plate's bottom crop marks; where a clamp holds, the block sits on its edge.
 * Gaps and edges are measured on the type, as a reader sees them: the headline's bottom is its last baseline, the block's top the
 * subline's first cap top, the block's bottom the trial line's last baseline (the crop-mark clamp uses the trial line's box). */

/* Inter's vertical metrics in em (the hhea values of the Inter that @fontsource/inter ships, 2048 units per em): ascent 1984,
   descent 494, cap height 1490. A browser centres the glyphs' content area (ascent + descent) in each line box. */
export const INTER = Object.freeze({ asc: 1984 / 2048, desc: 494 / 2048, cap: 1490 / 2048 });

/** The smallest gap from the headline's last baseline to the block's first cap top (px). */
export const MIN_GAP = 40;

/** From a line box's top to that line's cap top (px), for font-size fs and line-height lh (px). */
export function capTop(fs, lh) { return (lh - (INTER.asc + INTER.desc) * fs) / 2 + (INTER.asc - INTER.cap) * fs; }

/** From a line box's top to that line's baseline (px). */
export function baseline(fs, lh) { return (lh - (INTER.asc + INTER.desc) * fs) / 2 + INTER.asc * fs; }

/** The block's place, the rule itself. Every measure in one set of coordinates, taken with no extra air:
 *    headBase     the headline's last baseline (the headline's bottom)
 *    blockTop     the block's top (the subline's first cap top)
 *    blockBase    the block's bottom (the trial line's last baseline)
 *    blockBox     the block's box bottom (the trial line's box: its descenders' room)
 *    cardBottom   the roster card's bottom edge as the engine placed it in the plate
 *    plateBottom  the plate's bottom edge (the line of the bottom crop marks)
 *    maxGap       the largest headline → block gap (2 × the section gap); minGap the smallest (40 px)
 *  Returns { air, top, bottom, gap, edge } — air: what goes above the subline (never negative: the block never comes closer to the
 *  headline than its own margin); top / bottom / gap: the block as placed; edge: what placed it — "card" (its bottom on the card's
 *  bottom edge), "max" (2 × the section gap under the headline), "plate" (its box on the bottom crop marks' line), "min" (40 px
 *  under the headline, or its own margin where that is more). Never overlapping the headline wins over the crop marks.
 *  null when a measure is not a number. */
export function heroBlock({ headBase, blockTop, blockBase, blockBox, cardBottom, plateBottom, maxGap, minGap = MIN_GAP }) {
  if (![headBase, blockTop, blockBase, blockBox, cardBottom, plateBottom, maxGap, minGap].every((n) => Number.isFinite(n))) return null;
  const g0 = blockTop - headBase;
  let air = cardBottom - blockBase, edge = "card";
  if (g0 + air > maxGap) { air = maxGap - g0; edge = "max"; }
  if (blockBox + air > plateBottom) { air = plateBottom - blockBox; edge = "plate"; }
  const lo = Math.max(0, minGap - g0);
  if (air < lo) { air = lo; edge = "min"; }
  return { air, top: blockTop + air, bottom: blockBase + air, gap: g0 + air, edge };
}

/** p = { plateTop, plateBottom, cardBottom, maxGap, h1, sub, trial }: plateTop, plateBottom and cardBottom in the hero's coordinates
 *  (the stage's top = 0); each part { top, h, fs, lh } as laid out with no extra air, its top measured from the hero's content top
 *  (the headline: 0). Returns { top, a1, block } (px, unrounded; block = heroBlock()'s answer in the hero's coordinates; without a
 *  card or plate measure it is null and a1 is 0: the block keeps its own margins), or null when a part's measure is missing (no
 *  layout: the engine then keeps the hero on the plate's top edge without air). */
export function heroFit({ plateTop, plateBottom, cardBottom, maxGap, h1, sub, trial }) {
  const nums = [plateTop];
  for (const p of [h1, sub, trial]) { if (!p) return null; nums.push(p.top, p.h, p.fs, p.lh); }
  if (!nums.every((n) => Number.isFinite(n)) || !(h1.fs > 0)) return null;
  const lastBase = (p) => p.top + p.h - p.lh + baseline(p.fs, p.lh);
  const top = plateTop - (h1.top + capTop(h1.fs, h1.lh));
  const block = heroBlock({
    headBase: top + lastBase(h1), blockTop: top + sub.top + capTop(sub.fs, sub.lh), blockBase: top + lastBase(trial), blockBox: top + trial.top + trial.h,
    cardBottom, plateBottom, maxGap,
  });
  return { top, a1: block ? block.air : 0, block };
}
