// Day-selection rules for the public booking page.

/**
 * Keep the chosen day unless the 14-day open/closed summary says it is closed.
 * A date outside the summary (picked in the calendar, or a ?d= link further
 * out) is unknown, not closed — it stays, and the time list says whether the
 * place is open that day.
 */
export function rescueDay(cur, map, nextOpen) {
  if (cur && (!(cur in (map || {})) || map[cur])) return cur;
  return nextOpen || cur;
}
