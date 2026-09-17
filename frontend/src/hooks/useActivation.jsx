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
 *   usageDormantPillars Set<string> the USAGE GATE (below) — what the NAV hides.
 *   usageKnownDormant   Set<string> the usage gate, but only once it is KNOWN.
 *
 * ── THE USAGE GATE (Sep 2026) ────────────────────────────────────────────
 * Separate from, and stricter than, the activation axis: navManifest's
 * USAGE_GATED_PILLARS (today: events) are hidden from the nav for EVERY owner
 * — no cohort firewall, no feature flag — until a real usage row exists.
 * Rationale: BonBox focuses on six jobs and Events is not one of them; of 73
 * production accounts exactly one has ever created an Event row. So for
 * everyone else the surface is noise, not an un-started feature.
 *
 * TWO SETS, ON PURPOSE:
 *   • usageDormantPillars — what the NAV hides. Defaults to HIDDEN while we
 *     don't know yet, so an owner who has never used Events never sees the
 *     row appear and then vanish a moment later.
 *   • usageKnownDormant   — hidden only once ESTABLISHED (a real response, or
 *     a localStorage hint from this owner's last known answer). Surfaces that
 *     are already on screen under the owner's finger (the /modules toggle
 *     list, the DoorScan tiles) use this one so nothing MOVES while loading.
 *
 * CONTRACT (mirrored by the tests in __tests__/useActivation.usageGate):
 *   logged out                       → both empty.
 *   business_type ∈ USAGE_GATE_EXEMPT_TYPES → both empty (an event organizer
 *                                    sees Events from minute one).
 *   accountant                       → both = {events} (the revisor sidebar
 *                                    has never listed Events; keep More
 *                                    consistent with it).
 *   loading (no response yet for the CURRENT user key)
 *                                    → dormant = {events} unless a stored hint
 *                                      says this owner HAS used events;
 *                                      known = hint-says-unused ? {events} : ∅.
 *   success                          → dormant iff the payload says events is
 *                                      not activated; the hint is rewritten.
 *   error                            → keep a good response for the same key
 *                                      (a failed background refetch must not
 *                                      flap Events into view); else the hint;
 *                                      else FAIL OPEN (Events visible).
 *
 * BACKEND COUPLING: /api/activation returns the REAL per-pillar booleans for
 * out-of-scope (established) accounts too — but only while
 * ACTIVATION_DISCLOSURE_ENABLED is on (its default). With the flag OFF the
 * endpoint forces every pillar True, so the usage gate resolves to "events
 * used" → Events visible for everyone. That is the safe direction and the
 * kill-switch for this gate as well. (Documented on both sides — see
 * routers/activation.py and utils/features.py.)
 *
 * FAIL-OPEN (the firewall): on fetch error / while loading / outside the
 * provider / for accountant-view, EVERY pillar is treated as activated (the
 * activated Set conceptually contains everything → isActivated always true,
 * and passesActivation hides nothing). Losing a real surface is far worse than
 * showing a dormant one. This is deliberately the SAME safe direction as
 * usePillars' fail-OPEN. The usage gate is the ONE deliberate exception: while
 * loading it fails CLOSED for its own pillars (never for any other), because
 * an Events row that appears and then disappears is worse than one that shows
 * up a beat late — and it is always one ⌘K search away.
 *
 * EXISTING-OWNERS FIREWALL: even when the fetch succeeds, an established
 * account reports in_scope=false → consumers treat everything as activated →
 * the EXACT nav they see today, apart from the usage gate above. Activation
 * NEVER writes anything (the localStorage hint is a per-browser cache of the
 * server's own answer, never a source of truth).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import api from "../services/api";
import { useAuth } from "./useAuth";
import { USAGE_GATED_PILLARS, USAGE_GATE_EXEMPT_TYPES } from "../config/navManifest";

const ActivationContext = createContext(null);

// The activation-gateable pillars (insights is NOT gated → always-on). Keep
// in sync with backend ACTIVATION_PILLARS.
const GATEABLE = Object.freeze(["inventory", "reservations", "events", "staff"]);

// The fail-open shape consumers see when loading / errored / accountant /
// logged-out / outside-provider: a Set of every gateable pillar (so each is
// "activated"), in_scope=false and enabled=false (both make passesActivation a
// no-op). Frozen so it's safe to share.
const ALL_ACTIVATED = Object.freeze(new Set(GATEABLE));

// The two usage-gate Sets, as shared constants so consumers can rely on a
// stable identity (they land in dependency arrays and ctx objects).
const NO_USAGE_DORMANT = Object.freeze(new Set());
const USAGE_DORMANT_ALL = Object.freeze(new Set(USAGE_GATED_PILLARS));

// localStorage hint — a per-browser cache of the LAST KNOWN server answer for
// this owner, so a reload doesn't flash the gated nav row while /activation is
// in flight. Never a source of truth: a real response always overwrites it,
// and a missing/corrupt value just means "not known yet".
const USAGE_HINT_PREFIX = "bonbox_usage_hint:";

/** Read the stored hint for a user key → { <pillar>: bool } or null. Every
 *  access is guarded: private mode, cleared site data and blocked storage all
 *  throw, and a thrown read here would take down the whole authed tree. */
function readUsageHint(userKey) {
  if (!userKey) return null;
  try {
    const raw = localStorage.getItem(USAGE_HINT_PREFIX + userKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const out = {};
    for (const pid of USAGE_GATED_PILLARS) {
      if (typeof parsed[pid] === "boolean") out[pid] = parsed[pid];
    }
    // A hint that carries none of the gated pillars tells us nothing.
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Persist the server's answer for the gated pillars. Fire-and-forget. */
function writeUsageHint(userKey, activated) {
  if (!userKey) return;
  try {
    const hint = {};
    for (const pid of USAGE_GATED_PILLARS) hint[pid] = activated.has(pid);
    localStorage.setItem(USAGE_HINT_PREFIX + userKey, JSON.stringify(hint));
  } catch {
    /* storage unavailable — the gate still works, just without the hint. */
  }
}

/** The dormant Set implied by a per-pillar "has used it" map (from a response
 *  or a hint). `usedMap[pid] === true` → not dormant. Unknown → NOT dormant
 *  (fail open), because the caller only reaches here with a real answer. */
function dormantFromUsed(usedMap) {
  const dormant = USAGE_GATED_PILLARS.filter((pid) => usedMap?.[pid] !== true);
  if (dormant.length === 0) return NO_USAGE_DORMANT;
  if (dormant.length === USAGE_GATED_PILLARS.length) return USAGE_DORMANT_ALL;
  return new Set(dormant);
}

const FAIL_OPEN = Object.freeze({
  activatedPillars: ALL_ACTIVATED,
  isActivated: () => true,
  isInScope: false,
  activationEnabled: false,
  loading: false,
  isReady: true,
  refresh: () => Promise.resolve(ALL_ACTIVATED),
  // Outside the provider (public pages, a surface rendered bare in a test) the
  // usage gate hides NOTHING — same fail-open direction as every other field.
  usageDormantPillars: NO_USAGE_DORMANT,
  usageKnownDormant: NO_USAGE_DORMANT,
});

export function ActivationProvider({ children }) {
  const { user } = useAuth();

  // Accountant-view never participates — a revisor always sees the owner's
  // full nav, never an activation-hidden surface. Logged-out → no fetch.
  const isAccountant = (user?.role || "").toLowerCase() === "accountant";
  const shouldFetch = !!user && !isAccountant;

  // The ACCOUNT the state belongs to. Activation is per-owner, so a response
  // is only ever applied to the key it was requested for — otherwise owner B
  // would briefly inherit owner A's answer (the useEntitlements "log out, log
  // back in, wrong plan" class of bug).
  const userKey = user ? String(user.id) : null;

  // null = nothing fetched yet. Shape:
  //   { key, activated:Set, inScope, enabled, ok, used:{<pillar>:bool}|null }
  // `ok` distinguishes a real response from the error fallback so a failed
  // background refetch can't overwrite a good answer. `used` is the usage-gate
  // view of the same payload (null = unknown → fail open).
  const [state, setState] = useState(null);
  const inflight = useRef(null); // { key, promise } — de-dupe concurrent refreshes

  // The key a resolving request must still match to be committed. Synced in a
  // LAYOUT effect, not a passive one: layout effects run synchronously on
  // commit, so the ref is already the new owner's key by the time any pending
  // response's microtask runs — a passive effect can flush after it, and a
  // stale answer would then be committed over the new owner's state.
  const currentKeyRef = useRef(userKey);
  useLayoutEffect(() => {
    currentKeyRef.current = userKey;
  }, [userKey]);

  const refresh = useCallback(() => {
    const key = currentKeyRef.current;
    // De-dupe only within the SAME account — a request in flight for the
    // previous owner must never be handed back as this owner's answer.
    if (inflight.current && inflight.current.key === key) {
      return inflight.current.promise;
    }
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
        // A response for an account that is no longer signed in is DROPPED.
        if (key !== currentKeyRef.current) return activated;
        const used = {};
        for (const pid of USAGE_GATED_PILLARS) used[pid] = activated.has(pid);
        setState({
          key,
          activated,
          inScope: data.in_scope === true,
          enabled: data.enabled === true,
          ok: true,
          used,
        });
        writeUsageHint(key, activated);
        return activated;
      })
      .catch(() => {
        // Fail-OPEN — never hide a pillar because the fetch failed. Mark every
        // pillar activated + force the gate inert (enabled/inScope false).
        const activated = new Set(GATEABLE);
        if (key !== currentKeyRef.current) return activated;
        const hint = readUsageHint(key);
        setState((prev) => {
          // A GOOD answer for this same account wins: a failed background
          // refetch (offline blip, 503) must not flap a hidden pillar into
          // view and back out again.
          if (prev && prev.key === key && prev.ok) return prev;
          return {
            key,
            activated,
            inScope: false,
            enabled: false,
            ok: false,
            // No response → the owner's last known answer, else unknown
            // (→ usage gate fails open, Events visible).
            used: hint,
          };
        });
        return activated;
      })
      .finally(() => {
        if (inflight.current && inflight.current.key === key) {
          inflight.current = null;
        }
      });
    inflight.current = { key, promise: p };
    return p;
  }, []);

  // Fetch on auth (and on an account switch — `userKey` is in the deps).
  // Logged-out / accountant settle during RENDER instead (see below), so there
  // is no setState-in-effect that would make "loading" a second state to sync.
  useEffect(() => {
    if (!shouldFetch) return;
    refresh();
  }, [shouldFetch, refresh, userKey]);

  // SEAMLESS GRADUATION — re-pull when data changes so a just-used feature
  // (e.g. first inventory item, first booking, first event) flips dormant→active
  // without a reload. The 'bonbox-data-changed' event is dispatched app-wide on
  // writes.
  useEffect(() => {
    if (!shouldFetch) return;
    const onChange = () => { refresh(); };
    window.addEventListener("bonbox-data-changed", onChange);
    return () => window.removeEventListener("bonbox-data-changed", onChange);
  }, [shouldFetch, refresh]);

  // Only state belonging to the CURRENT account counts. Computed during render
  // so an account switch is "not loaded yet" on the very first render of the
  // new account — no effect round-trip, no frame of the previous owner's nav.
  const settled = state && state.key === userKey ? state : null;
  const loading = shouldFetch ? settled === null : false;
  // While loading OR for accountant-view, fail-open: everything activated.
  const activatedPillars =
    settled && !isAccountant ? settled.activated : ALL_ACTIVATED;
  const isInScope = !!settled && !isAccountant && settled.inScope === true;
  const activationEnabled = !!settled && !isAccountant && settled.enabled === true;

  const isActivated = useCallback(
    (pillar) => {
      // Not gateable (e.g. 'insights', null) → always activated.
      if (!pillar || !GATEABLE.includes(pillar)) return true;
      return activatedPillars.has(pillar);
    },
    [activatedPillars],
  );

  // The usage gate's "we don't know yet" answer for THIS owner: the stored
  // hint, read once per account (a write only happens alongside a response,
  // which supersedes the hint anyway).
  const usageHint = useMemo(() => readUsageHint(userKey), [userKey]);

  // This business type is exempt from the gate entirely (an event organizer
  // must see Events before their first row exists).
  const isUsageExemptType = USAGE_GATE_EXEMPT_TYPES.includes(
    String(user?.business_type || "").trim().toLowerCase(),
  );

  const [usageDormantPillars, usageKnownDormant] = useMemo(() => {
    if (!user) return [NO_USAGE_DORMANT, NO_USAGE_DORMANT];
    if (isUsageExemptType) return [NO_USAGE_DORMANT, NO_USAGE_DORMANT];
    // A revisor's sidebar has never carried Events; hide it on the More grid
    // too so the two surfaces agree.
    if (isAccountant) return [USAGE_DORMANT_ALL, USAGE_DORMANT_ALL];
    if (settled) {
      // `used === null` is the errored-with-no-hint case → fail open.
      if (!settled.used) return [NO_USAGE_DORMANT, NO_USAGE_DORMANT];
      const dormant = dormantFromUsed(settled.used);
      // Established by a real response (or by this owner's stored hint on the
      // error path) — safe for the "don't move under a finger" surfaces too.
      return [dormant, dormant];
    }
    // LOADING. The nav hides by default (a row that appears then vanishes is
    // worse than one that shows up late); the on-screen surfaces wait until
    // the answer is actually known.
    if (!usageHint) return [USAGE_DORMANT_ALL, NO_USAGE_DORMANT];
    const dormant = dormantFromUsed(usageHint);
    return [dormant, dormant];
  }, [user, isUsageExemptType, isAccountant, settled, usageHint]);

  const value = useMemo(
    () => ({
      activatedPillars,
      isActivated,
      isInScope,
      activationEnabled,
      loading,
      isReady: !loading,
      refresh,
      usageDormantPillars,
      usageKnownDormant,
    }),
    [
      activatedPillars,
      isActivated,
      isInScope,
      activationEnabled,
      loading,
      refresh,
      usageDormantPillars,
      usageKnownDormant,
    ],
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
