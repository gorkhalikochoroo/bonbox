/**
 * The readings this screen has not got a "saved" for yet — kept on this
 * device (localStorage) so they SURVIVE A RELOAD (R1b).
 *
 * Each item carries the EXACT body it was first sent with, client_id,
 * client_typed_at and client_business_date included. Every resend (the row's
 * "Prøv igen", "Prøv alle igen", the browser coming back online, the page
 * coming back after a reload) sends that same body, so the server answers
 * with the row it already stored (200, replayed) instead of making a second.
 *
 * States:
 *   sending       — on its way (never stored: a reload restores it as failed)
 *   failed        — network / timeout / 5xx / 429: "Ikke gemt endnu · prøv igen"
 *   needs_action  — the server refused the content (422 / 409): "Kræver handling"
 *   stale         — typed on an EARLIER business day and confirmed NOT stored
 *                   (the server's 409 business_day_changed): never sent again
 *                   (it would land on the wrong day). The kitchen says "skriv
 *                   den på papir"; the owner types it in as "Fra papir".
 *
 * After a reload the items show at once ("Ikke gemt endnu"), but NOTHING is
 * sent until this session has loaded /today (the caller passes its
 * business_date): then every failed item is sent once — one from another
 * business day too, because it may already be stored and only the server
 * knows (a replay answers 200 → saved; 409 business_day_changed → stale) —
 * and again on every "online" event.
 *
 * Storage key: the kitchen uses "bonbox_ek_queue_v1:k:" + a hash of the token
 * (never the token itself), the owner "bonbox_ek_queue_v1:o:" + the user id.
 * Every read and write is guarded: when storage is unavailable (private
 * mode, blocked site data, full) the queue works in memory as in R1a, and a
 * `beforeunload` warning asks before a reload drops it. With storage working
 * the warning is only raised for an unsent PHOTO (photos are never stored on
 * the device — only the fact that one was taken, `hadPhoto`).
 *
 * Nothing here logs a value, a name or a token.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { QUEUE_MAX_ITEMS, classifySaveError, fnv1a32hex } from "./ekLogic";

export const QUEUE_PREFIX = "bonbox_ek_queue_v1:";

/** The kitchen iPad's queue key: the token is hashed, never stored as a key. */
export function kitchenQueueKey(token) {
  return token ? `${QUEUE_PREFIX}k:${fnv1a32hex(token)}` : null;
}

/** The owner app's queue key, per user. */
export function ownerQueueKey(userId) {
  return userId ? `${QUEUE_PREFIX}o:${userId}` : null;
}

const STATES = new Set(["failed", "needs_action", "stale"]);

/** Read a stored queue → { items, ok }. Never throws. */
export function readQueue(key) {
  if (!key) return { items: [], ok: false };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { items: [], ok: true };
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return { items: [], ok: true };
    const items = list
      .filter((x) => x && x.v === 1 && typeof x.clientId === "string" && x.body && typeof x.body === "object")
      .map((x) => ({
        ...x,
        // "sending" is never stored; anything else unknown is a plain failure.
        state: STATES.has(x.state) ? x.state : "failed",
        missing: Array.isArray(x.missing) ? x.missing : [],
        restored: true,
      }));
    return { items, ok: true };
  } catch {
    return { items: [], ok: false };
  }
}

/** Store a queue (newest QUEUE_MAX_ITEMS). Returns false when storage failed. */
export function writeQueue(key, items) {
  if (!key) return false;
  try {
    const list = items.slice(-QUEUE_MAX_ITEMS).map((it) => ({
      v: 1,
      clientId: it.clientId,
      checkId: it.checkId,
      checkName: it.checkName ?? null,
      body: it.body,
      draft: it.draft ?? null,
      businessDate: it.businessDate ?? null,
      typedAt: it.typedAt ?? null,
      state: it.state === "sending" ? "failed" : it.state,
      code: it.code ?? null,
      missing: Array.isArray(it.missing) ? it.missing : [],
      hadPhoto: !!(it.hadPhoto || it.photo),
    }));
    if (list.length) window.localStorage.setItem(key, JSON.stringify(list));
    else window.localStorage.removeItem(key);
    return items.length <= QUEUE_MAX_ITEMS;
  } catch {
    return false;
  }
}

export default function usePendingEntries(send, { storageKey = null, businessDate = null, onAutoResults = null } = {}) {
  const [loaded, setLoaded] = useState(() => {
    const r = readQueue(storageKey);
    return { key: storageKey, items: r.items, ok: !!storageKey && r.ok };
  });
  const [items, setItems] = useState(loaded.items);
  const [storageOk, setStorageOk] = useState(loaded.ok);
  const itemsRef = useRef(items);
  const sendRef = useRef(send);
  const autoRef = useRef(onAutoResults);
  const dateRef = useRef(businessDate);
  const inFlight = useRef(new Set());

  // The key appeared or changed (the owner's user id arrived late): load it.
  useEffect(() => {
    if (loaded.key === storageKey) return;
    const r = readQueue(storageKey);
    setLoaded({ key: storageKey, items: r.items, ok: !!storageKey && r.ok });
    setItems((cur) => {
      const ids = new Set(r.items.map((x) => x.clientId));
      return [...r.items, ...cur.filter((x) => !ids.has(x.clientId))];
    });
    setStorageOk(!!storageKey && r.ok);
  }, [storageKey, loaded.key]);

  useEffect(() => {
    itemsRef.current = items;
    if (loaded.key !== storageKey || !storageKey) return;
    const ok = writeQueue(storageKey, items);
    setStorageOk((prev) => (prev === ok ? prev : ok));
  }, [items, storageKey, loaded.key]);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  useEffect(() => {
    autoRef.current = onAutoResults;
  }, [onAutoResults]);

  const patch = useCallback((clientId, fields) => {
    setItems((list) => list.map((it) => (it.clientId === clientId ? { ...it, ...fields } : it)));
  }, []);

  const run = useCallback(
    async (item) => {
      if (inFlight.current.has(item.clientId)) return { ok: false, kind: "sending", item };
      inFlight.current.add(item.clientId);
      try {
        const entry = await sendRef.current(item.body);
        setItems((list) => list.filter((it) => it.clientId !== item.clientId));
        return { ok: true, entry, item };
      } catch (err) {
        const c = classifySaveError(err);
        const state = c.kind === "needs_action" ? "needs_action" : c.kind === "stale" ? "stale" : "failed";
        patch(item.clientId, { state, code: c.code, missing: c.missing });
        return { ok: false, kind: c.kind, code: c.code, missing: c.missing, item };
      } finally {
        inFlight.current.delete(item.clientId);
      }
    },
    [patch],
  );

  /** First send of a new reading (or a corrected one: same clientId replaces). */
  const submit = useCallback(
    (item) => {
      const prev = itemsRef.current.find((it) => it.clientId === item.clientId);
      const next = {
        v: 1,
        businessDate: item.businessDate ?? item.body?.client_business_date ?? null,
        typedAt: item.typedAt ?? item.body?.client_typed_at ?? null,
        hadPhoto: !!(item.photo || prev?.hadPhoto),
        ...item,
        state: "sending",
        code: null,
        missing: [],
        restored: false,
      };
      setItems((list) => [...list.filter((it) => it.clientId !== item.clientId), next]);
      return run(next);
    },
    [run],
  );

  const retry = useCallback(
    (clientId) => {
      const it = itemsRef.current.find((x) => x.clientId === clientId);
      if (!it || it.state === "needs_action" || it.state === "stale") return Promise.resolve({ ok: false, kind: "none" });
      if (!dateRef.current) return Promise.resolve({ ok: false, kind: "none" });
      patch(clientId, { state: "sending" });
      return run(it);
    },
    [patch, run],
  );

  const retryAll = useCallback(async () => {
    if (!dateRef.current) return [];
    const failed = itemsRef.current.filter((x) => x.state === "failed");
    const out = [];
    for (const it of failed) {
      patch(it.clientId, { state: "sending" });
      out.push(await run(it));
    }
    return out;
  }, [patch, run]);

  const remove = useCallback((clientId) => {
    setItems((list) => list.filter((it) => it.clientId !== clientId));
  }, []);

  /** Forget every unsent reading on this device (after "Par igen"). */
  const clearAll = useCallback(() => {
    setItems([]);
    try {
      if (storageKey) window.localStorage.removeItem(storageKey);
    } catch {
      /* private mode */
    }
  }, [storageKey]);

  /** The page found out the server refused the content after all (a 404
   *  that was NOT a revoked device: a name no longer on the list). */
  const markNeedsAction = useCallback(
    (clientId, { code = null, missing = [] } = {}) => patch(clientId, { state: "needs_action", code, missing }),
    [patch],
  );

  // /today has loaded (or the business day turned): every failed reading is
  // sent once with its SAME body. A "failed" item from another business day
  // may already be stored (the Wi-Fi dropped after the server committed), so
  // the device never decides "not sent" on its own: the server answers a
  // replay first (200 → saved, dropped from the queue) and only a 409
  // business_day_changed (nothing stored) turns it stale. That is safe only
  // because its body carries client_business_date — an item without it, or
  // one the server already refused (needs_action), goes stale at once.
  useEffect(() => {
    dateRef.current = businessDate || null;
    if (!businessDate) return;
    const list = itemsRef.current;
    const otherDay = (x) => !!x.businessDate && x.businessDate !== businessDate;
    const askServer = (x) =>
      x.state === "failed" && !!x.body?.client_business_date && x.body.client_business_date !== businessDate;
    const stale = list.filter((x) => x.state !== "sending" && x.state !== "stale" && otherDay(x) && !askServer(x));
    if (stale.length) {
      const ids = new Set(stale.map((x) => x.clientId));
      setItems((cur) => cur.map((it) => (ids.has(it.clientId) ? { ...it, state: "stale" } : it)));
    }
    const due = list.filter((x) => x.state === "failed" && (!otherDay(x) || askServer(x)));
    if (!due.length) return;
    let alive = true;
    (async () => {
      const out = [];
      for (const it of due) {
        if (!alive) break;
        patch(it.clientId, { state: "sending" });
        out.push(await run(it));
      }
      if (out.length) autoRef.current?.(out);
    })();
    return () => {
      alive = false;
    };
  }, [businessDate, patch, run]);

  // The network came back: resend every failed reading (same client_id).
  const onlineHandler = useRef(null);
  useEffect(() => {
    onlineHandler.current = async () => {
      if (!dateRef.current) return;
      if (!itemsRef.current.some((x) => x.state === "failed")) return;
      const out = await retryAll();
      if (out.length) autoRef.current?.(out);
    };
  }, [retryAll]);
  useEffect(() => {
    const h = () => onlineHandler.current?.();
    window.addEventListener("online", h);
    return () => window.removeEventListener("online", h);
  }, []);

  // A reload drops what is not stored: an unsent photo (never stored), or
  // everything when storage does not work here. Warn only then.
  const unsentPhoto = items.some((x) => x.photo);
  const atRisk = unsentPhoto || (!storageOk && items.length > 0);
  useEffect(() => {
    if (!atRisk) return undefined;
    const h = (e) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [atRisk]);

  return {
    items,
    submit,
    retry,
    retryAll,
    remove,
    clearAll,
    markNeedsAction,
    storageOk,
    unsentCount: items.length,
    failedCount: items.filter((x) => x.state === "failed").length,
    staleCount: items.filter((x) => x.state === "stale").length,
  };
}

/**
 * Readings saved from THIS screen, per check, while their 2-minute undo window
 * is open. The deadline is fixed when the save comes back (an event, never
 * render): device now + the server's own recorded_at → undo_until span, so a
 * wrong device clock neither stretches nor cuts the window. A 1-second ticker
 * runs only while something can still be undone, and prunes what cannot.
 */
export function useRecentSaves() {
  const [recent, setRecent] = useState({});
  const [now, setNow] = useState(null);
  const count = Object.keys(recent).length;

  useEffect(() => {
    if (!count) return undefined;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      setRecent((r) => {
        const keep = Object.keys(r).filter((k) => r[k].deadline > at - 1000);
        if (keep.length === Object.keys(r).length) return r;
        return Object.fromEntries(keep.map((k) => [k, r[k]]));
      });
    };
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [count]);

  const add = useCallback((entry) => {
    if (!entry?.check_id || !entry.undo_until || entry.voided_at) return;
    const span = Date.parse(entry.undo_until) - Date.parse(entry.recorded_at);
    if (!Number.isFinite(span) || span <= 0) return;
    const deadline = Date.now() + span;
    setRecent((r) => ({ ...r, [entry.check_id]: { entry, deadline } }));
  }, []);

  const drop = useCallback((checkId) => {
    setRecent((r) => {
      if (!(checkId in r)) return r;
      const n = { ...r };
      delete n[checkId];
      return n;
    });
  }, []);

  return { recent, now, add, drop };
}
