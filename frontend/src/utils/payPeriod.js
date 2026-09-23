/**
 * The pay period, computed the same way everywhere.
 *
 * WHY THIS IS A SHARED MODULE AND NOT A LOCAL HELPER. It used to live inside
 * StaffHoursPage, and StaffPayrollPage — the tab RIGHT NEXT TO IT, on the same
 * screen, reading the same /staff/pay-period/current config — stepped its
 * period by a raw day count instead:
 *
 *     const len = (period_end - period_start) + 1;
 *     setPeriod({ start: addDays(start, -len), end: addDays(end, -len) });
 *
 * So on a calendar-month venue standing on 1.–31. marts, the word "Previous"
 * meant two different things on two tabs of one screen:
 *
 *     Timer  ←   1. feb – 28. feb      (snapped to the month)
 *     Løn    ←   28. jan – 27. feb     (shifted 31 days)
 *
 * Four days of January pulled into "February", and 28. februar dropped. The
 * Løn window is what feeds /staff/payroll/estimate, the revisor CSV and the
 * LØNSEDDEL PDF — and the filename prints those wrong dates as though somebody
 * chose them. The owner tapping ← to fetch last month's payslips gets a signed
 * document covering days that are not the month it names, with nothing on
 * screen to contradict it. The frame selector directly below still reads
 * "Calendar month (1st → end)".
 *
 * One definition, imported by both. A second implementation of a money
 * boundary is not a duplication smell, it is a payout waiting to be wrong.
 *
 * This mirrors the BACKEND's _compute_pay_period (routers/staff.py). The
 * backend remains the authority — this exists only so prev/next can step
 * without a round trip. If you change one, change the other; the weekly frame
 * has a test that walks 400 days through both and asserts they agree.
 */

/** Frames anchored to a calendar date, which must SNAP rather than shift. */
export const CALENDAR_FRAMES = ["monthly_1st", "monthly_15th", "custom"];

export function isoDate(d) {
  const offsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offsetMs).toISOString().split("T")[0];
}

export function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/**
 * The period containing `refIso`, for the given frame.
 *
 * @param {string} type      monthly_1st | monthly_15th | custom | weekly | biweekly
 * @param {number} startDay  day-of-month anchor, `custom` only
 * @param {string} refIso    any date inside the wanted period
 */
export function computePayPeriod(type, startDay, refIso) {
  const ref = new Date(refIso + "T00:00:00");
  const y = ref.getFullYear();
  const m = ref.getMonth();
  const day = ref.getDate();
  const isoOf = (yy, mm, dd) => isoDate(new Date(yy, mm, dd)); // JS normalizes over/underflow

  if (type === "monthly_15th") {
    if (day >= 15) return { from: isoOf(y, m, 15), to: isoOf(y, m + 1, 14) };
    return { from: isoOf(y, m - 1, 15), to: isoOf(y, m, 14) };
  }
  if (type === "weekly") {
    // Monday–Sunday. JS getDay() is 0=Sunday, so shift to 0=Monday first or
    // every Sunday lands in the following week and gets paid twice.
    const dow = (ref.getDay() + 6) % 7;
    return { from: isoOf(y, m, day - dow), to: isoOf(y, m, day - dow + 6) };
  }
  if (type === "biweekly") {
    // Every 2 weeks from epoch Monday 2024-01-01, matching the backend.
    const epoch = new Date(2024, 0, 1);
    const days = Math.round((ref - epoch) / 86_400_000);
    const start = new Date(epoch);
    start.setDate(start.getDate() + Math.floor(days / 14) * 14);
    const end = new Date(start);
    end.setDate(end.getDate() + 13);
    return { from: isoDate(start), to: isoDate(end) };
  }
  if (type === "custom") {
    const csd = Math.min(28, Math.max(1, parseInt(startDay, 10) || 1));
    if (day >= csd) return { from: isoOf(y, m, csd), to: isoOf(y, m + 1, csd - 1) };
    return { from: isoOf(y, m - 1, csd), to: isoOf(y, m, csd - 1) };
  }
  // monthly_1st + fallback
  const lastDay = new Date(y, m + 1, 0).getDate();
  return { from: isoOf(y, m, 1), to: isoOf(y, m, lastDay) };
}

/**
 * Step one whole period. THE function both tabs must use, so "Previous" means
 * one thing on one screen.
 *
 * Calendar-anchored frames re-derive from the day just outside the current
 * window, so they land on the real boundary. Span-based frames (weekly,
 * biweekly, an ad-hoc range) shift by their own length, which for them IS the
 * boundary.
 */
export function stepPayPeriod(type, startDay, from, to, direction) {
  const back = direction === "prev";
  if (CALENDAR_FRAMES.includes(type)) {
    const ref = back ? addDays(from, -1) : addDays(to, 1);
    return computePayPeriod(type, startDay, ref);
  }
  const len = Math.round(
    (new Date(to + "T00:00:00") - new Date(from + "T00:00:00")) / 86_400_000,
  ) + 1;
  const offset = back ? -len : len;
  return { from: addDays(from, offset), to: addDays(to, offset) };
}
