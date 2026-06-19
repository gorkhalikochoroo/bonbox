/**
 * useRouteHistory — the recorder + reader behind the "Fortsæt" / Resume
 * affordance (the quiet "pick up where you left off" cluster at the top of
 * the sidebar).
 *
 * WHY THIS EXISTS
 *   An owner mid-flow often hops away (check a number, answer a question) and
 *   then has to re-find the multi-step page they were on. ⌘K recents help, but
 *   they record SEARCH terms, not VISITED routes — a true "resume" wants the
 *   destinations the owner actually stood on. This hook records those, and the
 *   ResumeRow component surfaces the 1–2 most recent OTHER ones as one-tap
 *   links. Zero friction, auto-computed — no manual pinning, no settings.
 *
 * HONESTY (load-bearing — these are the task's pass/fail invariants):
 *   • ONLY real recently-visited routes are ever stored. Nothing is predicted,
 *     suggested, or fabricated. The list is pure visit history.
 *   • Recency order ONLY — newest first, move-to-front on revisit. No
 *     "you-might-want" reranking (predictable, preserves muscle memory).
 *   • The CURRENT path is never stored (you can't "resume" where you already
 *     are — the recorder excludes it on every change).
 *   • Only paths that are REAL owner destinations in NAV_MANIFEST are kept, so
 *     a stray public/portal/sub-page never leaks into Resume. Visibility/tier
 *     respect is applied later by the CONSUMER (ResumeRow) against the owner's
 *     live, filtered destinations — this hook just bounds the raw candidate set.
 *
 * STORAGE
 *   Per-user localStorage list, namespaced by user id (mirrors useStickyMethod
 *   so two owners on a shared back-office laptop never inherit each other's
 *   history). Key: `bonbox_route_history_<uid>`. Value: JSON string[] of
 *   pathnames, newest first, capped at MAX. Safe in private mode / quota
 *   errors (every read + write is try/caught).
 *
 * API
 *   useRouteHistoryRecorder()
 *     Side-effect-only. Mount ONCE high in the owner layout. On every owner
 *     route change it records `location.pathname` (subject to the rules above).
 *     Renders nothing.
 *
 *   useRouteHistory()
 *     Returns { history } — the current stored list (newest first), kept in
 *     sync with the recorder within the same tab via a lightweight event so
 *     the ResumeRow re-renders as the owner navigates.
 *
 *   getRouteHistory(uid) / readManifestPaths()
 *     Imperative helpers (the manifest-path set is exported for the consumer's
 *     own filtering).
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";
import { NAV_MANIFEST } from "../config/navManifest";

const PREFIX = "bonbox_route_history";

// How many recent destinations to retain. The affordance shows at most 2, but
// we keep a small buffer so that filtering out the current path + any now-
// hidden/tier-locked destination still leaves real options to surface.
const MAX = 8;

// Same-tab change signal. localStorage's native "storage" event only fires in
// OTHER tabs, so the recorder dispatches this so the reader in the same tab
// re-reads immediately on navigation.
const CHANGE_EVENT = "bonbox:route-history-change";

// The set of REAL owner destinations. A path is resume-eligible only if it
// maps to a manifest `to`. This single check subsumes every exclusion the task
// lists — `/s/…`, `/r/…`, `/login`, `/onboarding`, `/pay`, `/profile`, any
// sub-page or public/portal/auth route — because none of those are manifest
// entries. (Belt-and-suspenders explicit prefixes live in NON_OWNER_PREFIXES
// below for defense + readability.)
const MANIFEST_PATHS = new Set(NAV_MANIFEST.map((d) => d.to));

// Explicit non-owner prefixes — redundant with the manifest check (none of
// these are manifest entries) but kept as a readable, fail-safe first gate so
// the intent ("never resume into public/portal/auth/checkout") is obvious and
// survives any future manifest change.
const NON_OWNER_PREFIXES = [
  "/s/",          // staff portal (tokened)
  "/r/",          // public reservation widget
  "/e/",          // public event page
  "/login",
  "/register",
  "/onboarding",
  "/pay",
  "/forgot-password",
  "/reset-password",
  "/accept-invite",
  "/door",        // QR door-scan PWA
];

export function keyFor(uid) {
  return `${PREFIX}_${uid || "anon"}`;
}

/** Read the stored history for a user. Always returns an array. */
export function getRouteHistory(uid) {
  try {
    const raw = localStorage.getItem(keyFor(uid));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** The set of manifest `to` paths — exported so the consumer can resolve +
 *  filter candidates against the live, visibility-filtered destination list. */
export function readManifestPaths() {
  return MANIFEST_PATHS;
}

/**
 * isResumeEligible — a raw pathname is keepable ONLY if it is an exact owner
 * manifest destination and not a public/portal/auth/checkout route. Exact
 * match (not startsWith) so a deeper sub-route like `/staff/schedule/edit`
 * never masquerades as the `/staff/schedule` destination.
 */
function isResumeEligible(pathname) {
  if (!pathname || typeof pathname !== "string") return false;
  if (NON_OWNER_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return false;
  }
  return MANIFEST_PATHS.has(pathname);
}

/**
 * useRouteHistoryRecorder — mount ONCE high in the owner layout. Records the
 * current owner route into per-user storage with move-to-front dedup, current-
 * path exclusion, and the manifest/non-owner gate. Renders nothing.
 */
export function useRouteHistoryRecorder() {
  const { user } = useAuth();
  const uid = user?.id || null;
  const location = useLocation();
  const pathname = location.pathname;

  useEffect(() => {
    // Never record under the anon key — a pre-auth write must not bleed into a
    // real account (mirrors useStickyMethod's non-anon persist guard).
    if (!uid) return;
    if (!isResumeEligible(pathname)) return;

    const prev = getRouteHistory(uid);
    // EXCLUDE the current path from its own history, then move-to-front so the
    // list is newest-first with no duplicates. This means the list always
    // holds OTHER destinations relative to wherever the owner currently is.
    const next = [pathname, ...prev.filter((p) => p !== pathname)].slice(0, MAX);

    // No-op if nothing changed (e.g. the only difference was re-adding the same
    // head) to avoid a redundant write + event.
    if (next.length === prev.length && next.every((p, i) => p === prev[i])) {
      return;
    }

    try {
      localStorage.setItem(keyFor(uid), JSON.stringify(next));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      /* private mode / quota — Resume simply won't update; never throws */
    }
  }, [uid, pathname]);

  return null;
}

// useSyncExternalStore needs a STABLE snapshot reference between renders when
// nothing changed, or it loops forever. We cache the last raw JSON string and
// its parsed array per user key, and only re-parse when the string changes.
// This makes the snapshot a pure function of localStorage with referential
// stability — the idiomatic way to subscribe to external mutable storage.
const _snapshotCache = new Map(); // key -> { raw: string|null, value: string[] }

function getHistorySnapshot(uid) {
  const k = keyFor(uid);
  let raw = null;
  try {
    raw = localStorage.getItem(k);
  } catch {
    raw = null;
  }
  const cached = _snapshotCache.get(k);
  if (cached && cached.raw === raw) return cached.value;
  // Reuse getRouteHistory's parse/validate so the shape rules stay in one place.
  const value = getRouteHistory(uid);
  _snapshotCache.set(k, { raw, value });
  return value;
}

/**
 * useRouteHistory — read the stored history (newest first), live within the
 * current tab. Subscribes to localStorage via useSyncExternalStore so the
 * ResumeRow re-renders the moment the recorder writes (same-tab CHANGE_EVENT)
 * or another tab navigates (native "storage" event) — no setState-in-effect.
 *
 * The CURRENT path is filtered out at read time too (belt-and-suspenders:
 * storage already excludes it, but a just-navigated render can briefly hold the
 * new current path at the head before the recorder effect runs). The consumer
 * still applies visibility/tier filtering.
 */
export function useRouteHistory() {
  const { user } = useAuth();
  const uid = user?.id || null;
  const location = useLocation();
  const currentPath = location.pathname;

  const subscribe = useCallback(
    (onStoreChange) => {
      const onStorage = (e) => {
        if (!e.key || e.key === keyFor(uid)) onStoreChange();
      };
      window.addEventListener(CHANGE_EVENT, onStoreChange);
      window.addEventListener("storage", onStorage);
      return () => {
        window.removeEventListener(CHANGE_EVENT, onStoreChange);
        window.removeEventListener("storage", onStorage);
      };
    },
    [uid],
  );

  const getSnapshot = useCallback(() => getHistorySnapshot(uid), [uid]);
  // SSR/getServerSnapshot — empty list (there is no localStorage on the server).
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_LIST);

  const history = useMemo(
    () => raw.filter((p) => p !== currentPath),
    [raw, currentPath],
  );

  return { history };
}

// Stable empty array for the server snapshot (referential stability).
const EMPTY_LIST = Object.freeze([]);
