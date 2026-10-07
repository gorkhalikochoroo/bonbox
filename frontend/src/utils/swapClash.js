/**
 * Would a shift trade put either person on two shifts at once?
 *
 * The swap picker used to offer every colleague shift that was not the
 * staffer's own — including Jonas's Wednesday 11:30–15:00 to someone already
 * working Wednesday 11:00–20:00. An accept executes the trade immediately, so
 * that pick became a silent double booking. The server now refuses it (409,
 * shift_swap_service._refuse_double_booking); this mirrors the same rule so
 * the impossible option is never offered in the first place.
 *
 * Same math as the server: one absolute timeline (day × 1440 + minutes), an
 * end before the start rolls past midnight, strict `<` so back-to-back
 * (15:00 end, 15:00 start) is allowed. Both people are checked as they would
 * be AFTER the trade — the shift each hands over no longer counts.
 *
 * Only data the portal already holds is used: the staffer's own schedule and
 * the published team schedule. An unparseable time never blocks — the server
 * stays the real gate.
 */
const HHMM = /^(\d{1,2}):(\d{2})/;

function dayNumber(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

export function shiftSpan(date, start, end) {
  const day = dayNumber(date);
  const a = HHMM.exec(String(start || ""));
  const b = HHMM.exec(String(end || ""));
  if (day === null || !a || !b) return null;
  const s = Number(a[1]) * 60 + Number(a[2]);
  let e = Number(b[1]) * 60 + Number(b[2]);
  if (e < s) e += 24 * 60;
  return [day * 1440 + s, day * 1440 + e];
}

function clashes(span, shifts) {
  if (!span || span[1] <= span[0]) return false;
  return shifts.some((sh) => {
    const other = shiftSpan(sh.date, sh.start_time, sh.end_time);
    return !!other && span[0] < other[1] && other[0] < span[1];
  });
}

/**
 * @param fromShift  the staffer's shift they give up ({id, date, start_time, end_time})
 * @param toShift    the colleague's shift they would take (team-schedule row:
 *                   {shift_id, staff_id, date, start_time, end_time})
 * @param ownShifts  the staffer's own roster
 * @param teamShifts the published team schedule
 * @returns "self" | "colleague" | null — who would be double-booked
 */
export function swapDoubleBooks({ fromShift, toShift, ownShifts = [], teamShifts = [] }) {
  if (!fromShift || !toShift) return null;
  const fromId = String(fromShift.id ?? fromShift.shift_id ?? "");
  const toId = String(toShift.shift_id ?? toShift.id ?? "");

  const mineAfter = ownShifts.filter((s) => String(s.id ?? s.shift_id ?? "") !== fromId);
  if (clashes(shiftSpan(toShift.date, toShift.start_time, toShift.end_time), mineAfter)) return "self";

  const theirsAfter = teamShifts.filter(
    (s) => s.staff_id === toShift.staff_id && String(s.shift_id ?? s.id ?? "") !== toId,
  );
  if (clashes(shiftSpan(fromShift.date, fromShift.start_time, fromShift.end_time), theirsAfter)) return "colleague";

  return null;
}
