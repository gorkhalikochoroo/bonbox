/**
 * The readings this screen has not got a "saved" for yet — in memory only.
 *
 * Each item carries the EXACT body it was first sent with, client_id
 * included. Every retry (the row's "Prøv igen", "Prøv alle igen", the
 * browser coming back online) resends that same body, so the server answers
 * with the row it already stored (200, replayed) instead of making a second.
 *
 * States:
 *   sending       — on its way
 *   failed        — network / timeout / 5xx / 429: "Ikke gemt endnu · prøv igen"
 *   needs_action  — the server refused the content (422 / 409): "Kræver handling"
 *
 * R1a has no persistent queue: an unsent reading survives a dropped network
 * while the page stays open, but NOT a reload. So while anything is unsent a
 * `beforeunload` handler asks the browser to warn (no window.confirm), and the
 * page shows "skriv målingerne på papir" whenever an item has failed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { classifySaveError } from "./ekLogic";

export default function usePendingEntries(send) {
  const [items, setItems] = useState([]);
  const itemsRef = useRef(items);
  const sendRef = useRef(send);
  const inFlight = useRef(new Set());

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const patch = useCallback((clientId, fields) => {
    setItems((list) => list.map((it) => (it.clientId === clientId ? { ...it, ...fields } : it)));
  }, []);

  const run = useCallback(
    async (item) => {
      if (inFlight.current.has(item.clientId)) return { ok: false, kind: "sending" };
      inFlight.current.add(item.clientId);
      try {
        const entry = await sendRef.current(item.body);
        setItems((list) => list.filter((it) => it.clientId !== item.clientId));
        return { ok: true, entry, item };
      } catch (err) {
        const c = classifySaveError(err);
        const state = c.kind === "needs_action" ? "needs_action" : "failed";
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
      const next = { ...item, state: "sending", code: null, missing: [] };
      setItems((list) => [...list.filter((it) => it.clientId !== item.clientId), next]);
      return run(next);
    },
    [run],
  );

  const retry = useCallback(
    (clientId) => {
      const it = itemsRef.current.find((x) => x.clientId === clientId);
      if (!it || it.state === "needs_action") return Promise.resolve({ ok: false, kind: "none" });
      patch(clientId, { state: "sending" });
      return run(it);
    },
    [patch, run],
  );

  const retryAll = useCallback(async () => {
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

  /** The page found out the server refused the content after all (a 404
   *  that was NOT a revoked device: a name no longer on the list). */
  const markNeedsAction = useCallback(
    (clientId, { code = null, missing = [] } = {}) => patch(clientId, { state: "needs_action", code, missing }),
    [patch],
  );

  // The network came back: resend every failed reading (same client_id).
  const onlineHandler = useRef(null);
  useEffect(() => {
    onlineHandler.current = () => {
      if (itemsRef.current.some((x) => x.state === "failed")) retryAll();
    };
  }, [retryAll]);
  useEffect(() => {
    const h = () => onlineHandler.current?.();
    window.addEventListener("online", h);
    return () => window.removeEventListener("online", h);
  }, []);

  // Unsent readings live in this page only: warn before a reload drops them.
  const unsent = items.length;
  useEffect(() => {
    if (!unsent) return undefined;
    const h = (e) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [unsent]);

  return {
    items,
    submit,
    retry,
    retryAll,
    remove,
    markNeedsAction,
    unsentCount: unsent,
    failedCount: items.filter((x) => x.state === "failed").length,
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
