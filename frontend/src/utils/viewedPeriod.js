/**
 * The period on screen, shared by the Hours hub's tabs through the URL
 * (?from=YYYY-MM-DD&to=YYYY-MM-DD).
 *
 * Timer and Løn each kept their own period. An owner who approved September
 * in Timer and tapped Løn landed on October — and the lønseddel, the CSV and
 * "Send til revisor" all use the window on screen. Now the window travels with
 * the owner between tabs. No params = the current pay period, which is what
 * every tab shows by default, so a plain link keeps meaning "now".
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
// A custom range can be a quarter; a span past this is a typo, not a period.
const MAX_DAYS = 400;

const realDay = (iso) => {
  const ms = Date.parse(`${iso}T12:00:00Z`);
  // 2026-02-31 parses in some engines — round-trip to refuse it.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso ? ms : null;
};

/** {from, to} from the URL, or null when absent or not a real window. */
export function readViewedPeriod(searchParams) {
  const from = searchParams?.get?.("from") || "";
  const to = searchParams?.get?.("to") || "";
  if (!ISO.test(from) || !ISO.test(to) || to < from) return null;
  const a = realDay(from);
  const b = realDay(to);
  if (a === null || b === null) return null;
  const days = Math.round((b - a) / 86400000) + 1;
  if (days < 1 || days > MAX_DAYS) return null;
  return { from, to };
}

/**
 * Put the window in the URL — or take it out when it IS the current period.
 * Replaces the history entry, never pushes: stepping through months must not
 * turn the back button into a month-by-month walk.
 */
export function writeViewedPeriod(searchParams, setSearchParams, period, current) {
  const before = new URLSearchParams(searchParams);
  const next = new URLSearchParams(searchParams);
  const isCurrent = !period || (!!current && period.from === current.from && period.to === current.to);
  if (isCurrent) {
    next.delete("from");
    next.delete("to");
  } else {
    next.set("from", period.from);
    next.set("to", period.to);
  }
  if (next.toString() !== before.toString()) setSearchParams(next, { replace: true });
}
