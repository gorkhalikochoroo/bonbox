/**
 * useActivation — the ACTIVATION axis (the 4th orthogonal IA axis).
 *
 *   RELEVANCE ⊥ ENTITLEMENT ⊥ BUSINESS-TYPE ⊥ ACTIVATION
 *
 * A pillar is "activated" iff a real usage/config row exists for the owner.
 * A DORMANT pillar (relevant, never used, not owner-hidden, in an in-scope
 * account) drops out of the dense nav and surfaces as a one-tap "Sæt op" tile
 * (PillarDiscovery) while staying findable in ⌘K. When the owner uses the
 * feature, its usage row flips the boolean → the pillar AUTO-GRADUATES into
 * normal nav.
 *
 * Backed by GET /api/activation (routers/activation.py). The payload shape is:
 *   { inventory, reservations, events, staff,   // per-pillar activated bools
 *     in_scope,   // cohort firewall: only NEW accounts are gateable
 *     enabled }   // feature-flag kill-switch
 * `insights` is NOT gated (always-on) and is therefore absent from the map.
 *
 * WHY A SEPARATE CONTEXT (mirrors usePillars' reasoning):
 *   • Activation is DERIVED from usage, not an owner toggle and not a tier
 *     concern — folding it into useEntitlements / usePillars would invite the
 *     exact axis-collapse the 4-axis model forbids.
 *   • It has its own fetch lifecycle + its own refresh triggers (it re-pulls
 *     when data changes so a just-used feature graduates without reload).
 *
 * WHAT IT EXPOSES:
 *   isActivated(pillar) -> bool   membership in the activated Set. UNKNOWN /
 *                                 not-gated pillars (e.g. 'insights') → true.
 *   activatedPillars   Set<string> the activated pillar ids (for ctx threading).
 *   isInScope          bool        true only for the gateable NEW-account cohort.
 *   activationEnabled  bool        the feature-flag kill-switch.
 *   loading / isReady              three-state contract, mirrors usePillars.
 *   refresh()                      re-pull /api/activation.
 *
 * FAIL-OPEN (the firewall): on fetch error / while loading / outside the
 * provider / for accountant-view, EVERY pillar is treated as activated (the
 * activated Set conceptually contains everything → isActivated always true,
 * and passesActivation hides nothing). Losing a real surface is far worse than
 * showing a dormant one. This is deliberately the SAME safe direction as
 * usePillars' fail-OPEN.
 *
 * EXISTING-OWNERS FIREWALL: even when the fetch succeeds, an established
 * account reports in_scope=false → consumers treat everything as activated →
 * the EXACT nav they see today. Activation NEVER writes anything.
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

const ActivationContext = createContext(null);

// The activation-gateable pillars (insights is NOT gated → always-on). Keep
// in sync with backend ACTIVATION_PILLARS.
const GATEABLE = Object.freeze(["inventory", "reservations", "events", "staff"]);

// The fail-open shape consumers see when loading / errored / accountant /
// logged-out / outside-provider: a Set of every gateable pillar (so each is
// "activated"), in_scope=false and enabled=false (both make passesActivation a
// no-op). Frozen so it's safe to share.
const ALL_ACTIVATED = Object.freeze(new Set(GATEABLE));

const FAIL_OPEN = Object.freeze({
  activatedPillars: ALL_ACTIVATED,
  isActivated: () => true,
  isInScope: false,
  activationEnabled: false,
  loading: false,
  isReady: true,
  refresh: () => Promise.resolve(ALL_ACTIVATED),
});

export function ActivationProvider({ children }) {
  const { user } = useAuth();

  // Accountant-view never participates — a revisor always sees the owner's
  // full nav, never an activation-hidden surface. Logged-out → no fetch.
  const isAccountant = (user?.role || "").toLowerCase() === "accountant";
  const shouldFetch = !!user && !isAccountant;

  // null = not loaded yet. While null we fail-open (everything activated).
  const [state, setState] = useState(null); // { activated:Set, inScope, enabled } | null
  const inflight = useRef(null); // de-dupe concurrent refreshes

  const refresh = useCallback(() => {
    if (inflight.current) return inflight.current;
    const p = api
      .get("/activation", { _noRetry: true })
      .then((res) => {
        const data = res.data || {};
        const activated = new Set();
        for (const pid of GATEABLE) {
          // Treat any non-explicit-false as activated (fail-open at the field
          // level too — a missing key never hides a pillar).
          if (data[pid] !== false) activated.add(pid);
        }
        const next = {
          activated,
          inScope: data.in_scope === true,
          enabled: data.enabled === true,
        };
        setState(next);
        return activated;
      })
      .catch(() => {
        // Fail-OPEN — never hide a pillar because the fetch failed. Mark every
        // pillar activated + force the gate inert (enabled/inScope false).
        setState({ activated: new Set(GATEABLE), inScope: false, enabled: false });
        return new Set(GATEABLE);
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, []);

  // Fetch on auth. Logged-out / accountant settle immediately to fail-open.
  useEffect(() => {
    if (!shouldFetch) {
      setState({ activated: new Set(GATEABLE), inScope: false, enabled: false });
      return;
    }
    refresh();
  }, [shouldFetch, refresh]);

  // SEAMLESS GRADUATION — re-pull when data changes so a just-used feature
  // (e.g. first inventory item, first booking) flips dormant→active without a
  // reload. The 'bonbox-data-changed' event is dispatched app-wide on writes.
  useEffect(() => {
    if (!shouldFetch) return;
    const onChange = () => { refresh(); };
    window.addEventListener("bonbox-data-changed", onChange);
    return () => window.removeEventListener("bonbox-data-changed", onChange);
  }, [shouldFetch, refresh]);

  const loading = state === null;
  // While loading OR for accountant-view, fail-open: everything activated.
  const activatedPillars =
    state && !isAccountant ? state.activated : ALL_ACTIVATED;
  const isInScope = !!state && !isAccountant && state.inScope === true;
  const activationEnabled = !!state && !isAccountant && state.enabled === true;

  const isActivated = useCallback(
    (pillar) => {
      // Not gateable (e.g. 'insights', null) → always activated.
      if (!pillar || !GATEABLE.includes(pillar)) return true;
      return activatedPillars.has(pillar);
    },
    [activatedPillars],
  );

  const value = useMemo(
    () => ({
      activatedPillars,
      isActivated,
      isInScope,
      activationEnabled,
      loading,
      isReady: !loading,
      refresh,
    }),
    [activatedPillars, isActivated, isInScope, activationEnabled, loading, refresh],
  );

  return (
    <ActivationContext.Provider value={value}>
      {children}
    </ActivationContext.Provider>
  );
}

/**
 * useActivation — read the activation state.
 *
 * Outside the provider (public pages, tests rendering a surface bare) this
 * returns the fail-open shape so callers never null-check and passesActivation
 * stays a no-op (nothing hidden).
 */
export function useActivation() {
  const ctx = useContext(ActivationContext);
  if (ctx) return ctx;
  return FAIL_OPEN;
}
