/**
 * countDraft — the optælling that survives the phone ringing.
 *
 * THE LOSS THIS MODULE EXISTS TO KILL: the owner is 90 items into a 120-item
 * count, walking the cold room with the phone in one hand. A call comes in,
 * iOS suspends the tab long enough for it to reload, and every counted line is
 * gone — with no warning, because the counts only ever lived in React state
 * and the one write happened at the very end (POST /inventory/count/reconcile).
 * Same outcome from a stray tap on the X, which is a 36px target beside a
 * scrolling list.
 *
 * So the in-progress counts are mirrored to the device on every keystroke, and
 * read back when the ritual reopens. Same storage the offline close queue uses
 * (localStorage, per-user key, everything in try/catch, never throws): a
 * blocked or corrupt store must degrade to "no draft", never to a white screen
 * over an owner's unfinished count.
 *
 * What is stored is deliberately small and boring — item ids, the numbers the
 * owner typed, and where they were in the queue. No names, no prices, nothing
 * that would matter if the device were lost. It is cleared the moment the
 * count is submitted or deliberately discarded.
 */

const KEY_PREFIX = "bonbox_count_draft_v1";

/* A draft older than this is stale rather than resumable: it describes a shelf
   as it was last week, and a "resume" that re-applies week-old numbers to
   today's stock is worse than starting over. 24h covers the real case (the
   count is interrupted and finished the same evening, or next morning). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Per-user key, so a shared iPad never resumes one owner's count as another's. */
function keyFor(userId) {
  return `${KEY_PREFIX}:${userId || "anon"}`;
}

/**
 * Save the in-progress count. Never throws.
 *
 * @param {string|number} userId
 * @param {object} draft  { counts: {itemId: number}, idx: number }
 */
export function saveCountDraft(userId, draft) {
  try {
    const counts = draft?.counts || {};
    // Nothing counted yet is not a draft — writing one would make the resume
    // prompt appear for an owner who opened the ritual and immediately closed it.
    if (Object.keys(counts).length === 0) {
      clearCountDraft(userId);
      return false;
    }
    localStorage.setItem(
      keyFor(userId),
      JSON.stringify({ counts, idx: Number(draft?.idx) || 0, saved_at: Date.now() }),
    );
    return true;
  } catch {
    // Private mode, quota, cleared site data. The count still works in memory;
    // it just loses the safety net. Silence is right here — an error toast
    // mid-count would be noise about a thing the owner cannot fix.
    return false;
  }
}

/**
 * Read back a resumable draft, or null.
 *
 * Returns null for anything we cannot fully trust: unparseable JSON, a missing
 * counts map, or a draft past MAX_AGE_MS. Callers get "there is nothing to
 * resume" — never a half-restored count.
 */
export function loadCountDraft(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const d = JSON.parse(raw);
    const counts = d?.counts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
    if (Object.keys(counts).length === 0) return null;
    if (!d.saved_at || Date.now() - d.saved_at > MAX_AGE_MS) {
      clearCountDraft(userId);
      return null;
    }
    return { counts, idx: Number(d.idx) || 0, savedAt: d.saved_at };
  } catch {
    return null;
  }
}

/** Drop the draft — on submit, and on a deliberate discard. Never throws. */
export function clearCountDraft(userId) {
  try {
    localStorage.removeItem(keyFor(userId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep only the lines whose item still exists.
 *
 * A draft outlives the list it was counted against: an item deleted between
 * the interruption and the resume would otherwise be POSTed to
 * /count/reconcile as a counted line for a row that is gone. Drop it here
 * rather than letting the server decide — the owner never counted a ghost.
 */
export function reconcileDraftCounts(counts, items) {
  const live = new Set((items || []).map((i) => String(i.id)));
  const out = {};
  for (const [id, qty] of Object.entries(counts || {})) {
    if (live.has(String(id))) out[id] = qty;
  }
  return out;
}
