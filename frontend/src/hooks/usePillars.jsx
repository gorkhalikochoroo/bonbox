/**
 * usePillars — the RELEVANCE axis (architecture_pillar_visibility.md) on the
 * frontend. Single source of truth for which owner pillars are toggled OFF.
 *
 * Backed by GET/PUT /api/pillars (routers/pillars.py). The payload shape is:
 *   { hidden: ["events", ...], available: ["reservations","events", ...] }
 * `hidden` is the OFF-list (CSV-backed users.hidden_pillars); `available`
 * is the canonical 5-pillar catalog. NULL column → hidden: [] → everything
 * visible (the grandfather state for every existing account on deploy day).
 *
 * WHY A SEPARATE CONTEXT (not folded into useEntitlements / useAuth):
 *   • Pillars are FREE + uncapped (founder decision) — they are NOT an
 *     entitlement concern, and conflating them with useEntitlements would
 *     invite the exact "hidden vs locked" collapse the 3-axis model forbids.
 *   • The toggle is owner-mutable (optimistic PUT) — useEntitlements is a
 *     read-only tier cache; useAuth holds the identity. Pillar state has its
 *     own fetch + mutation lifecycle, so it gets its own provider.
 *
 * WHAT IT EXPOSES:
 *   hiddenPillars   Set<string>   the OFF pillar ids (empty Set while loading,
 *                                 for accountant-view, and logged-out).
 *   available       string[]      the catalog (the 5 pillar ids).
 *   isPillarHidden(id) -> bool     convenience membership check.
 *   setPillarHidden(id, makeHidden) -> Promise
 *                                 OPTIMISTIC: mutates local Set immediately,
 *                                 PUTs the FULL new OFF-list, rolls back on
 *                                 error. Resolves to the persisted Set.
 *   loading / isReady             three-state contract, mirrors useEntitlements.
 *   refresh()                     re-pull /api/pillars.
 *
 * SECURITY / SAFETY:
 *   • Accountant-view sessions NEVER fetch and NEVER gate — a revisor must
 *     see the owner's full read-only nav, never a pillar interstitial. The
 *     provider returns an empty hiddenPillars Set for role === "accountant".
 *   • Logged-out → empty Set (no gate on public surfaces).
 *   • Fail-OPEN on any fetch error: an unreachable /api/pillars must NEVER
 *     hide a pillar (the safe direction for a navigation preference — losing
 *     a destination is worse than showing one the owner toggled off). This is
 *     the opposite of useEntitlements' fail-CLOSED, and deliberately so:
 *     entitlements gate money, pillars are a cosmetic relevance filter.
 *   • The backend is the source of truth — set_hidden re-validates against the
 *     allowlist; this hook is a cache + optimistic UI.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import api from "../services/api";
import { useAuth } from "./useAuth";

const PillarsContext = createContext(null);

// Empty defaults — the shape a logged-out / accountant / outside-provider
// consumer sees. hiddenPillars is an empty Set so filterDestinations is a
// pure no-op (nothing hidden) and PillarGate never triggers.
const EMPTY_HIDDEN = Object.freeze(new Set());

export function PillarsProvider({ children }) {
  const { user } = useAuth();

  // Accountant-view never participates: a revisor session gets the full
  // read-only nav, never a pillar gate. Logged-out is handled by `user`
  // being null (no fetch fires).
  const isAccountant = (user?.role || "").toLowerCase() === "accountant";
  const shouldFetch = !!user && !isAccountant;

  const [hidden, setHidden] = useState(null); // null = not loaded yet
  const [available, setAvailable] = useState([]);
  const inflight = useRef(null); // de-dupe concurrent refreshes

  const refresh = useCallback(() => {
    if (inflight.current) return inflight.current;
    const p = api
      .get("/pillars", { _noRetry: true })
      .then((res) => {
        const list = Array.isArray(res.data?.hidden) ? res.data.hidden : [];
        setHidden(new Set(list));
        if (Array.isArray(res.data?.available)) setAvailable(res.data.available);
        return new Set(list);
      })
      .catch(() => {
        // Fail OPEN — never hide a pillar because the fetch failed. An empty
        // Set means every pillar stays visible (the grandfather state).
        setHidden(new Set());
        return new Set();
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, []);

  // Fetch on auth. When the session is logged-out or accountant-view, we
  // settle immediately to an empty Set without a network call.
  useEffect(() => {
    if (!shouldFetch) {
      setHidden(new Set());
      return;
    }
    refresh();
  }, [shouldFetch, refresh]);

  /**
   * setPillarHidden(pillarId, makeHidden) — OPTIMISTIC toggle.
   *
   * 1. Compute the new full OFF-list from the current Set.
   * 2. Apply it locally at once (the UI reacts instantly).
   * 3. PUT the FULL new list (the endpoint has full-set semantics).
   * 4. On error, roll back to the snapshot and re-throw so the caller can
   *    surface the failure.
   * Accountant-view is a hard no-op (a revisor can't re-shape owner nav).
   */
  const setPillarHidden = useCallback(
    async (pillarId, makeHidden) => {
      if (isAccountant) return EMPTY_HIDDEN;
      const prev = hidden instanceof Set ? hidden : new Set();
      const next = new Set(prev);
      if (makeHidden) next.add(pillarId);
      else next.delete(pillarId);

      // Optimistic apply.
      setHidden(next);
      try {
        const res = await api.put("/pillars", { hidden: [...next] });
        const list = Array.isArray(res.data?.hidden) ? res.data.hidden : [...next];
        const persisted = new Set(list);
        setHidden(persisted);
        if (Array.isArray(res.data?.available)) setAvailable(res.data.available);
        return persisted;
      } catch (err) {
        // Roll back to the pre-toggle snapshot.
        setHidden(prev);
        throw err;
      }
    },
    [hidden, isAccountant],
  );

  const loading = hidden === null;
  // Settled Set the rest of the app reads. While loading, treat as empty
  // (nothing hidden) so there is never a "destination vanishes then returns"
  // flicker — pillars appear, and an OFF one disappears only once we KNOW.
  const hiddenPillars = hidden instanceof Set ? hidden : EMPTY_HIDDEN;

  const isPillarHidden = useCallback(
    (id) => hiddenPillars.has(id),
    [hiddenPillars],
  );

  const value = useMemo(
    () => ({
      hiddenPillars,
      available,
      isPillarHidden,
      setPillarHidden,
      loading,
      isReady: !loading,
      refresh,
    }),
    [hiddenPillars, available, isPillarHidden, setPillarHidden, loading, refresh],
  );

  return (
    <PillarsContext.Provider value={value}>{children}</PillarsContext.Provider>
  );
}

/**
 * usePillars — read the pillar-relevance state + the optimistic toggle.
 *
 * Outside the provider (public landing pages, tests rendering a surface bare)
 * this returns a settled empty-Set shape so callers never have to null-check —
 * filterDestinations becomes a no-op and PillarGate never gates.
 */
export function usePillars() {
  const ctx = useContext(PillarsContext);
  if (ctx) return ctx;
  return {
    hiddenPillars: EMPTY_HIDDEN,
    available: [],
    isPillarHidden: () => false,
    setPillarHidden: () => Promise.resolve(EMPTY_HIDDEN),
    loading: false,
    isReady: true,
    refresh: () => Promise.resolve(EMPTY_HIDDEN),
  };
}
