// Which bookings freed a table between two reads of the same day's book
// (R11, rubric B10) — pure, so the door screen can tell when a table opened
// on ANOTHER screen (the owner's phone, a guest cancelling online) and ask
// the server who on the Venteliste fits it.
//
// Freed = it held a table (a live status AND a table or a joined set) and now
// either reached cancelled / no-show — the server's own "a table just freed"
// rule (update_status → waitlist_matches) — or is still live with no table
// left (the table was cleared, assign_table → waitlist_matches). A party that
// finished (completed) is not counted: the server does not surface matches
// for it either, and a finished table is usually the next booking's.

const LIVE = new Set(["requested", "confirmed", "seated"]);
const FREED = new Set(["cancelled", "no_show"]);

/** The tables a booking holds: its joined set, or its one table. */
export function tablesHeld(r) {
  if (!r) return [];
  if (Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length) {
    return r.combined_resource_ids.filter(Boolean).map(String);
  }
  return r.resource_id ? [String(r.resource_id)] : [];
}

/**
 * Ids of bookings in `rows` that freed a table since `prevRows`.
 * `skip`: ids whose change this screen made itself (their matches already
 * came with the server's answer). At most `limit`, in book order.
 */
export function freedSince(prevRows, rows, skip = null, limit = 2) {
  if (!Array.isArray(prevRows) || !Array.isArray(rows)) return [];
  const before = new Map(prevRows.filter(Boolean).map((r) => [r.id, r]));
  const out = [];
  for (const r of rows) {
    if (!r || (skip && skip.has(r.id))) continue;
    const was = before.get(r.id);
    if (!was || !LIVE.has(was.status) || tablesHeld(was).length === 0) continue;
    const freed = FREED.has(r.status) || (LIVE.has(r.status) && tablesHeld(r).length === 0);
    if (freed) out.push(r.id);
    if (out.length >= limit) break;
  }
  return out;
}

export default freedSince;
