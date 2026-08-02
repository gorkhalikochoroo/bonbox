/**
 * Does an offered shift collide with one the staffer already works?
 *
 * v2's best idea, and the one thing its Swaps screen does that ours did not:
 * answer BEFORE the tap. Without it a staffer takes a shift, the server
 * refuses the overlap, and they learn they wasted the attempt — the offer
 * looked available right up until it wasn't.
 *
 * Deliberately CONSERVATIVE about what it will call a clash:
 *   • only same-date comparisons — no timezone or midnight-crossing guesses;
 *   • an unparseable time on either side returns false, so a shift is never
 *     blocked on a string we did not understand.
 * The server's own check stays the real gate. This only ever removes a wasted
 * tap; it must never invent a refusal the server would not make.
 */
export function overlapsOwnShift(offerDate, offerTime, ownShifts) {
  if (!offerDate || !offerTime || !Array.isArray(ownShifts)) return false;
  // "16:00–23:00" (en dash) or "16:00-23:00"
  const m = String(offerTime).match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
  if (!m) return false;
  const toMin = (h, mi) => Number(h) * 60 + Number(mi);
  const aStart = toMin(m[1], m[2]);
  const aEnd = toMin(m[3], m[4]);
  if (!(aEnd > aStart)) return false;   // overnight span — do not guess

  return ownShifts.some((sh) => {
    if (!sh || sh.date !== offerDate || !sh.start_time || !sh.end_time) return false;
    const sm = String(sh.start_time).match(/(\d{1,2}):(\d{2})/);
    const em = String(sh.end_time).match(/(\d{1,2}):(\d{2})/);
    if (!sm || !em) return false;
    const bStart = toMin(sm[1], sm[2]);
    const bEnd = toMin(em[1], em[2]);
    if (!(bEnd > bStart)) return false;
    // Touching end-to-start is NOT an overlap: finishing at 15:00 and starting
    // at 15:00 is a real back-to-back the roster already allows.
    return aStart < bEnd && bStart < aEnd;
  });
}
