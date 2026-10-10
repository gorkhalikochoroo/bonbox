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
/* A deleted, LOCKED kasserapport holds the day's key under a branch (the
   server: 423, detail.code "deleted_locked_close"). It is kept by law and is
   never overwritten — so nothing of this day is in the books, and this copy
   is the only one: never "already saved", never offered as a spare. */
export const QUEUE_ERR_DELETED_LOCKED = "deleted_locked";

/** The server's code for a day held by a deleted, locked kasserapport. */
export const DELETED_LOCKED_CLOSE = "deleted_locked_close";
export function isDeletedLockedClose(err) {
  const d = err?.response?.data?.detail;
  return Boolean(d && typeof d === "object" && d.code === DELETED_LOCKED_CLOSE);
}

/* The day's draft was saved somewhere else (another phone or tab, or the
   page's own previous visit) after this copy was built: the server refused
   it (412, detail.code "draft_changed") and wrote nothing. Nothing of THIS
   copy is in the books, and the stored draft is newer — never "already
   saved", never sent over it in silence. It stays, failed, with the newer
   version's stamp (conflictStamp): "keep mine" sends it again on that. */
export const DRAFT_CHANGED = "draft_changed";
/** Said on the window when a copy is kept outside the page's own sync (the page shows it at once). */
export const QUEUE_CHANGED_EVENT = "bonbox-dc-queue-changed";
export const QUEUE_ERR_DRAFT_CHANGED = "draft_changed";
export function isDraftChanged(err) {
  const d = err?.response?.data?.detail;
  return Boolean(d && typeof d === "object" && d.code === DRAFT_CHANGED);
}
/** The stored draft's version from a draft_changed refusal (null when it gave none). */
export function draftChangedStamp(err) {
  const d = err?.response?.data?.detail;
  if (!d || typeof d !== "object") return null;
  return d.updated_at || d.current?.updated_at || null;
}

/* ─── A date move, queued as ONE item (R-c round 2) ──────────────────────
   A move is one request (POST /daily-close/move): the new day's figures
   saved and the old day's draft deleted together, on the server. A move the
   page could not finish (no answer — offline, a dead line, a reload or the
   app killed while it was on its way) is kept here as ONE queued move —
   never as a save plus a promised delete — and sent again with the same
   save_id: the server answers a move it already did with what it did, and
   deletes nothing a second time. The item is the new day's draft
   (`payload`, its base_updated_at the version of the new day the form held)
   with a `move` envelope:
     { from_date, from_branch_id, from_base_updated_at, from_base_save_id,
       also_from: [{ date, branch_id, base_updated_at, base_save_id }], save_id } */
export const isQueuedMove = (it) => Boolean(it && it.move && typeof it.move === "object" && it.move.save_id);
/** The request a queued move sends (`toBase`: the version of the new day to send it on — "keep mine"). */
export function moveRequestOf(item, { toBase } = {}) {
  const m = item?.move || {};
  const body = { ...(item?.payload || {}) };
  if (toBase !== undefined) body.base_updated_at = toBase;
  body.save_id = m.save_id;
  return {
    from_date: m.from_date,
    from_branch_id: m.from_branch_id ?? null,
    from_base_updated_at: m.from_base_updated_at ?? null,
    from_base_save_id: m.from_base_save_id ?? null,
    also_from: Array.isArray(m.also_from) ? m.also_from : [],
    to_date: body.date,
    to_base_updated_at: body.base_updated_at ?? null,
    body,
    save_id: m.save_id,
  };
}

/* Items a page that is still open is sending itself (its move on its way):
   held by that page, never sent by the sync beside it nor listed as waiting
   — the page says where its move is. A page that is gone (left, reloaded,
   the app killed) holds nothing: its items are the queue's to send. Kept in
   memory only, so a reload starts with no holders. */
const liveHolders = new Set();
export function registerQueueHolder() {
  const id = newId();
  liveHolders.add(id);
  return id;
}
export function releaseQueueHolder(id) {
  liveHolders.delete(id);
}
/** Held by a page still open (its own send is on its way). */
export const isHeldLive = (it) => Boolean(it?.heldBy) && liveHolders.has(it.heldBy);

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

/* ─── Whose queue (R-c round 2, CMS-1) ───────────────────────────────────
   The queue was ONE list for the whole device: a close owner A queued
   offline was shown to — and filed (locked) into the books of — whoever
   signed in next on the same phone. Every item now names the account that
   queued it (`account`), and the queue reads and writes only the signed-in
   account's items: B never sees, sends or removes A's; A's wait, untouched,
   for A's next sign-in. A sync stops the moment the account changes under
   it (nothing of A's goes out on B's session).
   The account is set by the Daily close page from the signed-in user
   (setQueueAccount). `undefined` — never set (unit tests, no page) — is the
   whole device's list, as before; `null` — signed out — is nothing at all.
   An item from before this release names no account: it is the next
   signed-in account's (there is no way to tell whose it was), and it is
   stamped with that account the first time the queue is written. */
let currentAccount;
/** The signed-in account whose queue this is (a user id); null when signed out. */
export function setQueueAccount(account) {
  currentAccount = account === undefined ? undefined : (account === null ? null : String(account));
}
export function queueAccount() {
  return currentAccount;
}
const ownedBy = (account) => (it) => account === undefined || it.account == null || it.account === account;

/** Every item on the device, every account's (never shown or sent as such). */
function readAll() {
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
function readFor(account) {
  if (account === null) return [];
  return readAll().filter(ownedBy(account));
}
function writeFor(account, items) {
  if (account === null) return false;
  const mine = (Array.isArray(items) ? items : []).map((it) => (account === undefined || !it || typeof it !== "object" ? it : { ...it, account }));
  // (Everyone else's items stay exactly as they are.)
  const others = account === undefined ? [] : readAll().filter((it) => !ownedBy(account)(it));
  try {
    localStorage.setItem(OQ_KEY, JSON.stringify([...others, ...mine]));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the queue — the signed-in account's items. Returns [] for every
 * failure mode — missing key, blocked storage, invalid JSON, JSON that isn't
 * an array, signed out — and drops entries that carry no payload, because an
 * item we cannot POST is not a close.
 */
export function getOfflineQueue() {
  return readFor(currentAccount);
}

/** Persist the signed-in account's queue (others' items untouched). Returns false when storage refused (quota / private mode) or no one is signed in. */
export function writeOfflineQueue(items) {
  return writeFor(currentAccount, items);
}

/** Queue a close for later. Returns the stored item (or null if storage refused). `extra`: a queued move's envelope (`move`) and holder (`heldBy`). */
export function addToOfflineQueue(payload, extra = {}) {
  const item = {
    ...extra,
    ...(currentAccount ? { account: currentAccount } : {}),
    payload,
    ts: Date.now(),
    id: newId(),
    state: QUEUE_WAITING_NETWORK,
  };
  const q = getOfflineQueue();
  q.push(item);
  return writeOfflineQueue(q) ? item : null;
}

/**
 * Keep a copy the server refused as a FAILED item straight away — a draft
 * save that met draft_changed after its form was gone (the page was left):
 * the owner's last change exists only here now. Returns the item, or null
 * when storage refused.
 */
export function addFailedToOfflineQueue(payload, patch = {}) {
  const item = {
    ...(currentAccount ? { account: currentAccount } : {}),
    payload,
    ts: Date.now(),
    id: newId(),
    state: QUEUE_FAILED,
    lastTriedTs: Date.now(),
    ...patch,
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
  // `rev`: changed since a sync read it — that sync's verdict on the older
  // copy is never written over this one (mergeBack).
  const next = getOfflineQueue().map((it) => (it.id === id ? { ...it, ...patch, rev: (it.rev || 0) + 1 } : it));
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
function mergeBack(snapshot, remaining, account = currentAccount) {
  const handled = new Set(snapshot.map((it) => it.id));
  const kept = new Map(remaining.map((it) => [it.id, it]));
  const out = [];
  const walked = new Map(snapshot.map((it) => [it.id, it]));
  // (The queue of the account the sync was for — never the one signed in
  // since, CMS-1.)
  for (const live of readFor(account)) {
    if (!handled.has(live.id)) { out.push(live); continue; } // arrived mid-sync
    // Changed while the sync was on the network (the page put newer figures
    // in it — R-c round 2): the sync decided about the copy it read, not
    // this one. Kept as it is now — sent next time, on its own version.
    if ((live.rev || 0) !== (walked.get(live.id)?.rev || 0)) { out.push(live); continue; }
    const decided = kept.get(live.id);
    if (decided) out.push(decided);                          // still queued
    // else: it synced for real — this is the only way a close leaves the device
  }
  writeFor(account, out);
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
export async function syncOfflineQueue(post, { postMove = null, onSent = null } = {}) {
  // The account whose queue this sync sends (CMS-1): read once, and never
  // another's — signed out (or another account signed in) while it is on the
  // network, it stops: nothing of this account's goes out on that session.
  const account = currentAccount;
  const queue = readFor(account);
  if (!queue.length) {
    return { remaining: [], synced: 0, stoppedOnNetwork: false, ...queueSummary([]) };
  }

  const remaining = [];
  let synced = 0;
  let stoppedOnNetwork = false;
  let stoppedOnAccount = false;

  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    if (currentAccount !== account) {
      remaining.push(...queue.slice(i));
      stoppedOnAccount = true;
      break;
    }

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
    // A copy refused as draft_changed waits for the OWNER, never the network
    // (round 21 review): it goes only on their "Behold mine tal" (the page's
    // keepQueuedCopy, on the newer version it met). Re-posted here as it was,
    // it re-created a day whose newer draft had been deleted on the other
    // phone since (no row → no version to check), with nobody asked.
    if (item.state === QUEUE_FAILED && item.errorCode === QUEUE_ERR_DRAFT_CHANGED) {
      remaining.push(item);
      continue;
    }
    // A page still open is sending this one itself (its move on its way —
    // R-c round 2): never a second send beside it.
    if (isHeldLive(item)) {
      remaining.push(item);
      continue;
    }
    // A queued move goes as the move (one request, the same save_id) — never
    // as a plain save of the new day that leaves the old day's draft behind.
    // (A caller that cannot send moves keeps it.)
    const asMove = isQueuedMove(item);
    if (asMove && typeof postMove !== "function") {
      remaining.push(item);
      continue;
    }

    let resp;
    try {
      resp = asMove ? await postMove(moveRequestOf(item)) : await post(item.payload);
    } catch (err) {
      if (!err?.response) {
        // Rule 1 — the network is still down. Keep THIS item and every item
        // behind it (they were never even attempted) and stop trying.
        remaining.push(...queue.slice(i));
        stoppedOnNetwork = true;
        break;
      }
      const status = err.response?.status ?? null;
      // A deleted, locked kasserapport holds the day (423, or a 409 from a
      // server that said it that way): nothing is in the books and this copy
      // is the only one. It stays, failed, with the server's own words.
      if (isDeletedLockedClose(err)) {
        remaining.push({
          ...item,
          state: QUEUE_FAILED,
          errorCode: QUEUE_ERR_DELETED_LOCKED,
          errorDetail: errText(err, ""),
          httpStatus: status,
          lastTriedTs: Date.now(),
        });
        continue;
      }
      // The day's draft changed since this copy was made (another phone, the
      // wizard): nothing was written, and the stored draft is the newer one.
      // Never "already saved" (that would offer to throw away the only copy
      // of this version) — failed, with the newer version's stamp, so the
      // owner can keep theirs or remove it.
      if (isDraftChanged(err)) {
        remaining.push({
          ...item,
          state: QUEUE_FAILED,
          errorCode: QUEUE_ERR_DRAFT_CHANGED,
          conflictStamp: draftChangedStamp(err),
          errorDetail: null,
          httpStatus: status,
          lastTriedTs: Date.now(),
        });
        continue;
      }
      // 409 is the ONE conflict POST /daily-close raises: a confirmed close
      // already exists for this date. Either the owner re-entered it in the
      // wizard, or our own POST committed and the response was lost on flaky
      // 4G. Both mean the money is saved and this copy is a duplicate — so we
      // stop retrying and offer to remove it, instead of alarming the owner
      // about a close that is already in the books.
      // A move whose NEW day is locked (409): nothing moved — the figures
      // are on no server but this copy (and, maybe, the old day's draft).
      // Never "already saved".
      if (status === 409 && asMove) {
        remaining.push({
          ...item,
          state: QUEUE_FAILED,
          errorCode: QUEUE_ERR_REJECTED,
          errorDetail: errText(err, ""),
          httpStatus: status,
          lastTriedTs: Date.now(),
        });
        continue;
      }
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
    if (typeof onSent === "function") {
      try { onSent(item, resp?.data); } catch { /* the caller's note only */ }
    }
  }

  const merged = mergeBack(queue, remaining, account);
  // (Stopped for another account: nothing of this one's is that account's to see.)
  if (stoppedOnAccount) return { remaining: [], synced, stoppedOnNetwork: true, stoppedOnAccount, ...queueSummary([]) };
  return { remaining: merged, synced, stoppedOnNetwork, ...queueSummary(merged) };
}
