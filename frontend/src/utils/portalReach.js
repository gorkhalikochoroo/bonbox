/**
 * portalReach — "has this week actually reached anybody?", as a THREE-outcome
 * answer.
 *
 * The schedule page used to state, unconditionally and for every owner, that
 * "your team sees these shifts in the BonBox Scheduler app". Across 51 venues
 * not one staff link had ever been opened, so for every one of them that
 * sentence was false — and it was the reason the failure stayed invisible: the
 * owner copied links out, read a line saying the team could see them, and had
 * no surface anywhere that said otherwise.
 *
 * GET /staff/schedules/share-links now returns `last_accessed` per staffer.
 * This module turns those rows into the only three answers a screen is allowed
 * to give:
 *
 *   null                    — we have not asked (or the call failed). Say
 *                             NOTHING. Not knowing is not the same as zero.
 *   { opened: 0, … }        — we asked, and genuinely nobody has ever opened
 *                             their link. This is the useful, actionable truth.
 *   { opened: n > 0, … }    — we asked, and n people have. Only here may a
 *                             screen say the team sees the week.
 *
 * Pure and dependency-free so it can be tested without mounting the 7k-line
 * schedule page.
 */

/**
 * Has this row ever been opened?
 *
 * A server row carries `last_accessed` as an ISO string (naive UTC) or null.
 * Anything that is not a usable timestamp counts as NOT opened — an
 * unparseable value must never be promoted into a read receipt.
 *
 * @param {{last_accessed?: string|null}} row
 * @returns {boolean}
 */
export function linkWasOpened(row) {
  const raw = row && row.last_accessed;
  if (!raw) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t);
}

/**
 * Roll share-link rows up into the page's reach model.
 *
 * @param {Array|null|undefined} rows Rows from GET /staff/schedules/share-links,
 *   or null/undefined when the call never ran or failed.
 * @returns {{staff: number, opened: number, neverOpened: number,
 *            lastOpenedAt: string|null}|null} null means "not known".
 */
export function summarizePortalReach(rows) {
  // Not an array → we never got an answer. The caller must render no claim at
  // all; it must NOT fall through to the zero case, which would put the words
  // "nobody has opened it" on screen off the back of a dropped request.
  if (!Array.isArray(rows)) return null;

  let opened = 0;
  let lastOpenedAt = null;
  let lastOpenedMs = -Infinity;
  for (const row of rows) {
    if (!linkWasOpened(row)) continue;
    opened += 1;
    const ms = Date.parse(row.last_accessed);
    if (ms > lastOpenedMs) {
      lastOpenedMs = ms;
      lastOpenedAt = row.last_accessed;
    }
  }
  return {
    staff: rows.length,
    opened,
    neverOpened: rows.length - opened,
    lastOpenedAt,
  };
}
