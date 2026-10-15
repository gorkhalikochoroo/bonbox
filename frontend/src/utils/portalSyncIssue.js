/**
 * What the portal header says about freshness — and when it says nothing.
 *
 * The header used to print a green "Live" after the venue name whenever the
 * realtime stream was open. Staff read it as a status of their shift, the
 * café or the manager ("is the café live?"), never as "the data is fresh" —
 * and a word that is always there carries no news. Now the line is silent
 * while everything is healthy and speaks only when the staffer should act:
 *
 *   "offline" — the phone says it has no connection (the existing
 *               "Offline" word);
 *   "stale"   — no open stream and no good schedule answer for 45 s, or the
 *               first load failed (the existing "Tap to refresh" word —
 *               tapping it re-reads).
 *   null      — healthy: the stream is open, or the poll answered recently,
 *               or the first load is still on its way (no flash of
 *               "Tap to refresh" on every launch).
 *
 * Same truth rules as before: "fresh" needs a real schedule answer
 * (lastSynced is only stamped on success), and offline always wins.
 */
export const PORTAL_SYNC_FRESH_MS = 45000;

export function portalSyncIssue({ isOnline, liveConnected, lastSynced, loading = false, now = Date.now() }) {
  if (!isOnline) return "offline";
  if (liveConnected) return null;
  if (lastSynced) return now - lastSynced.getTime() < PORTAL_SYNC_FRESH_MS ? null : "stale";
  return loading ? null : "stale";
}
