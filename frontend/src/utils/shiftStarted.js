/**
 * Has a shift started? The Byt pickers (swap and give-away) leave those out:
 * a shift that is already being worked cannot be handed to a colleague.
 *
 * Local wall-clock time, like every other shift time in the portal
 * (nextShiftChip, liveShiftOf). An overnight shift counts from its start, so
 * last night's 22:00–06:00 has started. A start of exactly now counts as
 * started. No start time: the old day rule (only a past date has started).
 * Unreadable date: false — never hide a shift on a guess; the server decides.
 */
const ISO = /^(\d{4})-(\d{2})-(\d{2})/;
const HHMM = /^(\d{1,2}):(\d{2})/;

export function shiftHasStarted(shift, now = new Date()) {
  const d = ISO.exec(String(shift?.date || ""));
  if (!d) return false;
  const tm = HHMM.exec(String(shift?.start_time || ""));
  if (!tm) {
    const day = new Date(+d[1], +d[2] - 1, +d[3]).getTime();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return day < today;
  }
  return new Date(+d[1], +d[2] - 1, +d[3], +tm[1], +tm[2]).getTime() <= now.getTime();
}

/** The own shifts a picker may offer: a real date, not started, and not the
    one being worked (`liveShiftId` — an early clock-in starts work before the
    planned start). Order is kept. */
export function pickableOwnShifts(shifts, { now = new Date(), liveShiftId = null } = {}) {
  return (shifts || []).filter((s) => s
    && ISO.test(String(s.date || ""))
    && !shiftHasStarted(s, now)
    && (liveShiftId == null || String(s.id) !== String(liveShiftId)));
}
