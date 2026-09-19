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
 * The cutoff hour to use for a `day_cutoff_hour` value off the wire.
 *
 * THE BUG THIS FUNCTION EXISTS TO KILL: the prefill handler read
 * `res.data.day_cutoff_hour || 0`. `||` treats a MISSING field exactly like a
 * configured midnight, so a venue whose prefill response simply omits the key
 * (an older backend, a branch row with the column still null) silently moved
 * its business-day rollover from the page's own 06:00 default to 00:00 —
 * mid-load, after the header had already decided what "today" meant. A bar
 * closing at 01:30 then had the header saying yesterday and the wizard saying
 * today, and reconciled against the wrong day's sales. That is the exact defect
 * DEFAULT_CLOSE_CUTOFF_HOUR was introduced to prevent, re-entering through a
 * coercion.
 *
 * `??` is the whole fix: a real 0 from the server still means midnight (an
 * owner may genuinely close on the calendar day), and only null/undefined
 * falls back to the DK default. Non-numeric or out-of-range junk also falls
 * back rather than producing a NaN date.
 *
 * @param {unknown} raw — `day_cutoff_hour` as the server sent it
 * @param {number} fallback — the hour to use when `raw` says nothing
 */
export function resolveCutoffHour(raw, fallback = DEFAULT_CLOSE_CUTOFF_HOUR) {
  const n = raw ?? fallback;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  if (!Number.isInteger(n) || n < 0 || n > 23) return fallback;
  return n;
}

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
