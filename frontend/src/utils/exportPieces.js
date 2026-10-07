/**
 * A period longer than the plan's export window, offered as the pieces the
 * plan DOES allow — never a dead end or an upgrade wall with no way forward.
 * The plan limits themselves are unchanged (a pricing decision).
 *
 *   window ≥ 28 days (Starter, 31): one piece per calendar month, clipped to
 *     the chosen range — "Hent juli", "Hent august", "Hent september".
 *   shorter (Free, 7): the last {cap} days of the range; each day's own
 *     kasserapport (single-day PDF) is offered beside it by the page.
 *
 * Dates are ISO "YYYY-MM-DD" strings; the arithmetic is done in UTC so a
 * summer-time change never moves a day.
 */

const DAY = 86400000;

const toUtc = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Calendar days in [from, to], both included. */
export function spanDays(fromIso, toIso_) {
  return Math.round((toUtc(toIso_) - toUtc(fromIso)) / DAY) + 1;
}

/** The previous calendar quarter of the day `todayIso` falls in. */
export function previousQuarter(todayIso) {
  const [y, m] = String(todayIso).slice(0, 10).split("-").map(Number);
  const q = Math.floor((m - 1) / 3);
  const py = q === 0 ? y - 1 : y;
  const firstMonth = (q === 0 ? 3 : q - 1) * 3 + 1;
  const lastMonth = firstMonth + 2;
  const lastDay = new Date(Date.UTC(py, lastMonth, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, "0");
  return { from: `${py}-${p(firstMonth)}-01`, to: `${py}-${p(lastMonth)}-${p(lastDay)}` };
}

/**
 * { kind: "fits" | "months" | "tail", pieces: [{ from, to, wholeMonth }] }
 */
export function exportPieces(fromIso, toIso_, capDays) {
  const span = spanDays(fromIso, toIso_);
  if (!(capDays > 0) || span <= capDays) return { kind: "fits", pieces: [] };
  if (capDays >= 28) {
    const pieces = [];
    const end = toUtc(toIso_);
    let cur = toUtc(fromIso);
    while (cur <= end) {
      const d = new Date(cur);
      const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
      const pieceEnd = Math.min(monthEnd, end);
      pieces.push({
        from: toIso(cur),
        to: toIso(pieceEnd),
        wholeMonth: cur === monthStart && pieceEnd === monthEnd,
      });
      cur = monthEnd + DAY;
    }
    return { kind: "months", pieces };
  }
  const end = toUtc(toIso_);
  return {
    kind: "tail",
    pieces: [{ from: toIso(end - (capDays - 1) * DAY), to: toIso_.slice(0, 10), wholeMonth: false }],
  };
}
