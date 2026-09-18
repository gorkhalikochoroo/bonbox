/**
 * dailyCloseDay — which day a close belongs to, and whether it is already done.
 *
 * THE BUG THIS MODULE EXISTS TO KILL:
 * the daily close is FILED against the business day (DK restaurants cut over
 * at 06:00 — see businessTodayIso / the backend's business_today_local), but
 * the "is today already closed?" check on the page asked
 * `new Date().toISOString().slice(0, 10)` — the UTC calendar date. Two
 * separate errors in one line: UTC instead of local (a Dane closing at 01:14
 * CEST is already "yesterday" in UTC) and calendar instead of business day. A
 * bar locking at 03:00 and reloading the page watched its own close disappear
 * from the top of the screen, and was invited to close the day a second time.
 */
import { businessTodayIso } from "./dateFormat";

/**
 * DK-first default cutoff. The owner's real day_cutoff_hour arrives with the
 * /daily-close/prefill response; until then this is what both the page header
 * and the wizard assume, so they never disagree about what "today" is.
 */
export const DEFAULT_CLOSE_CUTOFF_HOUR = 6;

/**
 * The confirmed close filed against `businessDateIso`, or null.
 * Compares on the close's own `date` (already a business date server-side),
 * so the only thing that has to be right is the day we ask for.
 *
 * @param {Array} history — rows from GET /daily-close
 * @param {string} businessDateIso — YYYY-MM-DD, from businessTodayIso()
 */
export function findConfirmedCloseFor(history, businessDateIso) {
  if (!Array.isArray(history) || !businessDateIso) return null;
  return (
    history.find(
      (dc) => String(dc?.date || "").slice(0, 10) === businessDateIso && dc?.status === "confirmed",
    ) || null
  );
}

/**
 * Convenience: today's confirmed close for a given cutoff hour. Keeps the
 * business-day rule and the lookup in one place so a caller cannot use one
 * without the other (which is precisely how the original bug happened).
 */
export function findTodaysConfirmedClose(history, cutoffHour = DEFAULT_CLOSE_CUTOFF_HOUR, now = new Date()) {
  return findConfirmedCloseFor(history, businessTodayIso(cutoffHour, now));
}
