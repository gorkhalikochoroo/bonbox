/**
 * The day the Meld syg form starts on: the day you would actually miss.
 *
 *   • a shift today            → today
 *   • no shift today           → the date of your next shift, if it falls
 *                                inside the form's window (today … maxIso)
 *   • no shift in that window  → today (the form's old default)
 *
 * Dates are local YYYY-MM-DD strings, so plain string order is date order.
 * Only the default: the staffer can still pick any day the form allows.
 *
 * @param shifts   the staffer's shifts ({ date: "YYYY-MM-DD", … }), any order
 * @param todayIso today, local YYYY-MM-DD
 * @param maxIso   the last day the form accepts, local YYYY-MM-DD
 */
export function sickCallDefaultDate(shifts, todayIso, maxIso) {
  const next = (shifts || [])
    .map((s) => String(s?.date || "").slice(0, 10))
    .filter((d) => d >= todayIso && (!maxIso || d <= maxIso))
    .sort()[0];
  return next || todayIso;
}
