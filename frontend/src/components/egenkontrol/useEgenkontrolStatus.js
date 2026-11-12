/**
 * GET /egenkontrol/status — the cheap "what is missing now" for the sidebar
 * badge. ONE shared poll for every subscriber on the page (the sidebar can be
 * drawn twice: rail + phone drawer): every 60 s while the tab is visible, at
 * once when it becomes visible again, and on the app's freshness bus
 * (window "bonbox-data-changed", dispatched after a reading is saved).
 *
 * Quiet by design: an error, a 403 (an accountant view) or no answer yet is
 * just "no status" — the badge then draws nothing.
 */
import { useSyncExternalStore } from "react";
import api from "../../services/api";

const POLL_MS = 60000;
let snapshot = null;
const listeners = new Set();
let timer = null;
let inFlight = false;

function emit(next) {
  snapshot = next;
  for (const l of listeners) l();
}

function fetchNow() {
  if (inFlight) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  inFlight = true;
  api
    .get("/egenkontrol/status", { _noRetry: true })
    .then((r) => emit(r?.data && typeof r.data === "object" ? r.data : null))
    .catch(() => emit(null))
    .finally(() => {
      inFlight = false;
    });
}

const onVisible = () => {
  if (document.visibilityState === "visible") fetchNow();
};

function start() {
  fetchNow();
  timer = setInterval(fetchNow, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("bonbox-data-changed", fetchNow);
}

function stop() {
  clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("bonbox-data-changed", fetchNow);
}

function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => null;

export default function useEgenkontrolStatus() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Missing readings + open deviations — the number the badge shows. */
export function attentionCount(status) {
  if (!status) return 0;
  return Math.max(0, Number(status.missing_now || 0)) + Math.max(0, Number(status.open_deviations || 0));
}

/** Tests only: forget the shared snapshot between cases. */
export function __resetEgenkontrolStatus() {
  snapshot = null;
  inFlight = false;
}
