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

/**
 * How recently counts as "active" for one staffer's way in. A week: a café
 * staffer who looks at their shifts once a week is using it.
 */
export const ACTIVE_WITHIN_DAYS = 7;

/**
 * The server sends `last_accessed` as NAIVE UTC ("2026-10-11T23:32:03").
 * Date.parse reads a zone-less ISO string as LOCAL time, which moves a late
 * evening visit onto the next day for a Dane. Read it as UTC unless it
 * already carries a zone.
 *
 * @param {string|null|undefined} raw
 * @returns {number} epoch ms, or NaN when there is no usable timestamp.
 */
export function parseServerUtc(raw) {
  if (!raw || typeof raw !== "string") return NaN;
  const iso = raw.trim().replace(" ", "T");
  const hasZone = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(iso);
  return Date.parse(hasZone ? iso : `${iso}Z`);
}

const localDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * One staffer's way-in status, from the `shareOpened` map the schedule page
 * keeps (staffId → ISO | null, key absent = not asked). Four outcomes, and the
 * first one is the reason this returns an object instead of a boolean:
 *
 *   "unknown" — the key is absent: we never asked the server. Render NOTHING.
 *   "none"    — asked, and this person has never opened their link (or app).
 *   "active"  — opened within ACTIVE_WITHIN_DAYS calendar days.
 *   "joined"  — opened once, but not lately.
 *
 * @param {string|null|undefined} lastAccessed
 * @param {number} [now] epoch ms (tests pin it)
 * @returns {{state: "unknown"|"none"|"active"|"joined", lastSeen: string|null, daysAgo: number|null}}
 */
export function staffReachState(lastAccessed, now = Date.now()) {
  if (lastAccessed === undefined) return { state: "unknown", lastSeen: null, daysAgo: null };
  const ms = parseServerUtc(lastAccessed);
  if (!Number.isFinite(ms)) return { state: "none", lastSeen: null, daysAgo: null };
  // Calendar days in the owner's own zone; Math.round absorbs a DST hour.
  const daysAgo = Math.max(0, Math.round((localDay(now) - localDay(ms)) / 86400000));
  return {
    state: daysAgo < ACTIVE_WITHIN_DAYS ? "active" : "joined",
    lastSeen: lastAccessed,
    daysAgo,
  };
}

/**
 * The team-level rollup for the people the owner actually schedules: only
 * ACTIVE staff, and only those the server answered for. null = not known yet,
 * which (as above) must render nothing.
 *
 * @param {Array<{id: string}>} activeStaff
 * @param {Object<string, string|null>} openedMap staffId → ISO | null
 * @returns {{total: number, joined: number, notYet: number}|null}
 */
export function teamReach(activeStaff, openedMap) {
  if (!Array.isArray(activeStaff) || !openedMap) return null;
  const known = activeStaff.filter((s) => Object.prototype.hasOwnProperty.call(openedMap, s.id));
  if (known.length === 0) return null;
  const notYet = known.filter((s) => !Number.isFinite(parseServerUtc(openedMap[s.id]))).length;
  return { total: known.length, joined: known.length - notYet, notYet };
}
