/**
 * dailyCloseQueue — the offline holding pen for a daily close.
 *
 * THE BUG THIS MODULE EXISTS TO KILL (shipped, verified by the lead):
 * the old inline loop in DailyClosePage pushed ONLY the failing item to
 * `remaining` and then `break`-ed, so every close still queued BEHIND the
 * failure was written out of existence by the localStorage.setItem that
 * followed. A cellar bar with three unsent closes came back online and lost
 * two of them. Worse, the loop treated ANY 2xx as "sent" — including the
 * `{requires_confirmation: true}` body the anomaly guard returns while saving
 * NOTHING (backend/app/routers/daily_close.py), so a close that tripped the
 * money guard was silently deleted instead of shown to the owner.
 *
 * The rules this module enforces, all four of them money rules:
 *   1. A network error keeps that item AND everything queued after it.
 *   2. A 2xx carrying requires_confirmation keeps the item, marked as
 *      needing the owner's eyes. We NEVER re-post it with
 *      acknowledge_anomaly — that walks past a guard the owner has not seen.
 *   3. A 4xx/5xx keeps the item with its error so the page can surface it.
 *      Only a real, empty-bodied 2xx removes a close from the device.
 *   4. Nothing here ever throws. A corrupt/blocked localStorage (Safari
 *      private mode, cleared site data) must degrade to "empty queue", never
 *      to a white screen on the flagship page.
 *   5. A sync NEVER writes a snapshot back over storage. See mergeBack() —
 *      the first version of this module fixed the loop and then re-created
 *      the same deletion one level up: it read the queue at the top, awaited
 *      N network round-trips, and overwrote storage with what it had decided
 *      about the OLD list. Any close the owner locked DURING that window (the
 *      "online" listener fires on exactly the marginal connectivity where a
 *      submit also fails) was erased without ever being POSTed.
 *
 * Deliberately dependency-free apart from errText: `post` is injected by the
 * caller so the whole queue is unit-testable without axios or a DOM.
 */
import { errText } from "./errText";

export const OQ_KEY = "bonbox_dc_offline_queue";

/* Item states. An item with no state has never been tried (it was queued
   while the device was offline) and is treated as waiting for the network. */
export const QUEUE_WAITING_NETWORK = "waiting_network";
export const QUEUE_NEEDS_CONFIRMATION = "needs_confirmation";
export const QUEUE_FAILED = "failed";
/* The server already holds a LOCKED kasserapport for this date, so this copy
   can never be sent — retrying it forever under a red "couldn't be saved"
   banner accuses the app of losing money that is in fact in the books. It
   gets its own state and its own one-tap "remove this copy". */
export const QUEUE_ALREADY_SAVED = "already_saved";

/* Machine-readable reasons. The queue must NOT bake an English sentence into
   the item: the page renders it, and DailyClosePage's whole audit-trail
   vocabulary is Danish. The raw server text is kept alongside as secondary
   detail, never as the headline. */
export const QUEUE_ERR_REJECTED = "rejected"; // 4xx — the close itself was refused
export const QUEUE_ERR_SERVER = "server";     // 5xx — BonBox's side broke

/** Classify an HTTP status into one of the reason codes above. */
function reasonForStatus(status) {
  return typeof status === "number" && status >= 500 ? QUEUE_ERR_SERVER : QUEUE_ERR_REJECTED;
}

/** crypto.randomUUID is missing in older WKWebViews — never let an id crash a save. */
function newId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the timestamp id */
  }
  return `dcq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read the queue. Returns [] for every failure mode — missing key, blocked
 * storage, invalid JSON, JSON that isn't an array — and drops entries that
 * carry no payload, because an item we cannot POST is not a close.
 */
export function getOfflineQueue() {
  let raw;
  try {
    raw = localStorage.getItem(OQ_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((it) => it && typeof it === "object" && it.payload);
}

/** Persist the queue. Returns false when storage refused (quota / private mode). */
export function writeOfflineQueue(items) {
  try {
    localStorage.setItem(OQ_KEY, JSON.stringify(Array.isArray(items) ? items : []));
    return true;
  } catch {
    return false;
  }
}

/** Queue a close for later. Returns the stored item (or null if storage refused). */
export function addToOfflineQueue(payload) {
  const item = {
    payload,
    ts: Date.now(),
    id: newId(),
    state: QUEUE_WAITING_NETWORK,
  };
  const q = getOfflineQueue();
  q.push(item);
  return writeOfflineQueue(q) ? item : null;
}

/** Drop one item by id — used after the owner acknowledges an anomaly and it locks. */
export function removeFromOfflineQueue(id) {
  const next = getOfflineQueue().filter((it) => it.id !== id);
  writeOfflineQueue(next);
  return next;
}

/** Merge fields into one item by id (e.g. re-flagging it after a manual retry). */
export function updateQueueItem(id, patch) {
  const next = getOfflineQueue().map((it) => (it.id === id ? { ...it, ...patch } : it));
  writeOfflineQueue(next);
  return next;
}

/**
 * Counts the chip needs. "Waiting for the network" and "waiting for YOUR
 * confirmation" are different promises to the owner and must never be
 * collapsed into one number — that is what made a blocked close look like a
 * slow one.
 */
export function queueSummary(items) {
  const list = Array.isArray(items) ? items : [];
  let needsConfirmation = 0;
  let failed = 0;
  let alreadySaved = 0;
  for (const it of list) {
    if (it?.state === QUEUE_NEEDS_CONFIRMATION) needsConfirmation += 1;
    else if (it?.state === QUEUE_FAILED) failed += 1;
    else if (it?.state === QUEUE_ALREADY_SAVED) alreadySaved += 1;
  }
  return {
    total: list.length,
    waitingNetwork: list.length - needsConfirmation - failed - alreadySaved,
    needsConfirmation,
    failed,
    alreadySaved,
  };
}

/**
 * Write the outcome of a sync back WITHOUT clobbering concurrent writers.
 *
 * `snapshot` is the list the loop actually walked; `remaining` is what it
 * decided to keep. Anything in storage that is not in the snapshot arrived
 * while we were on the network (the owner locked a close mid-sync, or another
 * tab queued one) and must survive untouched. Anything the snapshot held that
 * storage no longer has was deliberately removed by somebody else and is NOT
 * resurrected. Storage order is preserved, so a mid-sync arrival stays behind
 * the closes that were already waiting.
 */
function mergeBack(snapshot, remaining) {
  const handled = new Set(snapshot.map((it) => it.id));
  const kept = new Map(remaining.map((it) => [it.id, it]));
  const out = [];
  for (const live of getOfflineQueue()) {
    if (!handled.has(live.id)) { out.push(live); continue; } // arrived mid-sync
    const decided = kept.get(live.id);
    if (decided) out.push(decided);                          // still queued
    // else: it synced for real — this is the only way a close leaves the device
  }
  writeOfflineQueue(out);
  return out;
}

/** The first item blocked on the owner's confirmation, or null. */
export function firstNeedingConfirmation(items) {
  const list = Array.isArray(items) ? items : [];
  return list.find((it) => it?.state === QUEUE_NEEDS_CONFIRMATION) || null;
}

/**
 * Try to send everything in the queue.
 *
 * @param {(payload: object) => Promise<{data?: any}>} post — injected poster,
 *        normally `(p) => api.post("/daily-close", p)`.
 * @returns {Promise<{remaining, synced, stoppedOnNetwork, total, waitingNetwork,
 *                    needsConfirmation, failed, alreadySaved}>}
 *          `remaining` is what is ACTUALLY on the device afterwards, which can
 *          include closes queued during the run — see mergeBack.
 */
export async function syncOfflineQueue(post) {
  const queue = getOfflineQueue();
  if (!queue.length) {
    return { remaining: [], synced: 0, stoppedOnNetwork: false, ...queueSummary([]) };
  }

  const remaining = [];
  let synced = 0;
  let stoppedOnNetwork = false;

  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];

    // Rule 2 — an item the owner has not yet confirmed is never re-posted.
    // Re-posting would either trip the same guard again (noise) or, if the
    // caller ever added acknowledge_anomaly, walk past a money guard nobody
    // has read. It waits here until the owner opens the dialog.
    if (item.state === QUEUE_NEEDS_CONFIRMATION) {
      remaining.push(item);
      continue;
    }
    // Likewise: a date the server has already locked can never be sent. Re-
    // posting it just 409s again on every reconnect, which is how a close
    // that IS in the books sat under a red "couldn't be saved" banner.
    if (item.state === QUEUE_ALREADY_SAVED) {
      remaining.push(item);
      continue;
    }

    let resp;
    try {
      resp = await post(item.payload);
    } catch (err) {
      if (!err?.response) {
        // Rule 1 — the network is still down. Keep THIS item and every item
        // behind it (they were never even attempted) and stop trying.
        remaining.push(...queue.slice(i));
        stoppedOnNetwork = true;
        break;
      }
      const status = err.response?.status ?? null;
      // 409 is the ONE conflict POST /daily-close raises: a confirmed close
      // already exists for this date. Either the owner re-entered it in the
      // wizard, or our own POST committed and the response was lost on flaky
      // 4G. Both mean the money is saved and this copy is a duplicate — so we
      // stop retrying and offer to remove it, instead of alarming the owner
      // about a close that is already in the books.
      if (status === 409) {
        remaining.push({
          ...item,
          state: QUEUE_ALREADY_SAVED,
          errorCode: null,
          errorDetail: errText(err, ""),
          httpStatus: status,
          lastTriedTs: Date.now(),
        });
        continue;
      }
      // Rule 3 — the server said no. Keep the close, keep the reason. The
      // reason is a CODE plus the raw server text, never a baked English
      // sentence: the page owns the words the owner reads.
      remaining.push({
        ...item,
        state: QUEUE_FAILED,
        errorCode: reasonForStatus(status),
        errorDetail: errText(err, ""),
        httpStatus: status,
        lastTriedTs: Date.now(),
      });
      continue;
    }

    // A 200 with requires_confirmation means the anomaly guard tripped and
    // the server saved NOTHING. Treating it as "sent" is how closes vanished.
    if (resp?.data?.requires_confirmation) {
      remaining.push({
        ...item,
        state: QUEUE_NEEDS_CONFIRMATION,
        anomaly: resp.data.anomaly || {},
        errorCode: null,
        errorDetail: null,
        httpStatus: null,
        lastTriedTs: Date.now(),
      });
      continue;
    }

    synced += 1;
  }

  const merged = mergeBack(queue, remaining);
  return { remaining: merged, synced, stoppedOnNetwork, ...queueSummary(merged) };
}
