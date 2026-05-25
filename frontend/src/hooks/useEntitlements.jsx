/**
 * useEntitlements — single source of truth for tier entitlements on the
 * frontend.
 *
 * Backed by GET /api/billing/entitlements which returns:
 *   {
 *     plan, raw_plan, is_paid, in_trial, trial_ends_at, trial_days_remaining,
 *     caps: { branches, team_users, modules, ai_brief_refreshes_per_day, … },
 *     features: { ai_anomaly_detection, white_label_pdf, … },
 *     min_plan_by_feature: { ai_anomaly_detection: "starter", … },
 *     plans: { free: {caps,features}, starter: {…}, pro: {…}, business: {…} }
 *   }
 *
 * Why a separate hook + context (not just /billing/me directly):
 *   • One network call shared across <TrialChip>, <Locked>, gates inside
 *     pages — instead of every component fetching independently.
 *   • Refreshes naturally after a checkout completes (refresh() is exposed
 *     so SubscriptionPage can re-pull after Stripe portal closes).
 *   • Exposes ergonomic helpers (hasFeature, isAtCap, planFor) so callers
 *     don't need to know the payload shape.
 *
 * Multi-layer note: the BACKEND is the source of truth — this hook is a
 * cache. A user editing localStorage or this object can't grant themselves
 * a feature; every premium endpoint re-checks via has_feature/at_cap on
 * the server (see backend/app/services/billing.py).
 *
 * Fallback: if the API call fails (401, network, etc.), the hook returns
 * a defensive Free-tier shape so the app keeps rendering — locked features
 * just stay locked. This is intentional: a backend outage should NEVER
 * silently grant Pro entitlements (fail closed).
 *
 * ─── DOCTRINE: TIER-FLICKER CONTRACT (LOCKED 2026-05-25, commit 4a66e03+) ──
 *
 * The fail-closed Free fallback bites consumers that naively render the
 * locked surface whenever hasFeature(...) returns false. During the
 * ~150-300ms cold-load window before /billing/entitlements responds, every
 * trial / Starter / Pro user looks like Free, so they see "Upgrade to
 * Starter+" cards / locked-overlay surfaces flash before the real payload
 * lands. This is the "trial glich" Manoj reported (BUG #195, follow-ups).
 *
 * The LOCKED rule for every consumer (Option A — chosen because the
 * consumer count was small enough to not need Suspense/route-loader
 * refactor):
 *
 *   1. Read `isReady` (preferred) or `!loading` from the hook.
 *   2. While !isReady, render NOTHING (or a low-contrast skeleton).
 *      Never the locked surface.
 *   3. Only show locked / UpgradeNudge UI when `isReady && !hasFeature(key)`.
 *
 * Anti-patterns that re-introduce the flicker — DO NOT use:
 *
 *   ✗ if (!hasFeature(key)) return <UpgradeNudge .../>   // flashes for trial
 *   ✗ const isUnlocked = hasFeature(key);                // boolean, loses tri-state
 *     if (!isUnlocked) return <Locked surface/>;
 *   ✗ const plan = user?.plan;                           // useAuth, not useEnt
 *     if (plan === "free") return <UpgradeNudge.../>;    // user.plan lags
 *
 * Correct patterns:
 *
 *   ✓ const { hasFeature, isReady } = useEntitlements();
 *     if (!isReady) return null;                         // or skeleton
 *     if (!hasFeature(key)) return <UpgradeNudge .../>;
 *
 *   ✓ const isUnlocked = isReady ? hasFeature(key) : null;   // tri-state
 *     if (isUnlocked === null) return <Skeleton/>;
 *     if (!isUnlocked) return <UpgradeNudge .../>;
 *
 *   ✓ <UpgradeNudge feature="bank_auto_reconcile" tier="starter" .../>
 *     // UpgradeNudge accepts an optional `feature` prop and self-gates
 *     // on isReady + hasFeature(feature) — returns null while loading or
 *     // when the user already has the feature.  Use this when the
 *     // surrounding page renders the nudge unconditionally.
 *
 * Backward compatibility: old consumers that don't import `isReady` or use
 * UpgradeNudge without a `feature` prop keep working — they just keep
 * flickering until migrated.  All current-as-of-commit consumers are
 * migrated; new consumers should follow this doctrine.
 *
 * Pre-commit grep to catch regressions:
 *   grep -rn 'hasFeature(' frontend/src --include='*.jsx' --include='*.js' \
 *     | grep -v isReady | grep -v entReady | grep -v entLoading
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import api from "../services/api";

const EntitlementsContext = createContext(null);

/** Shape used until the API responds (or if the API errors). Same fields
 * as the real payload but everything boolean is `false` and every cap is
 * 0 — i.e. "you can't do anything until we know what you can do". This
 * is the fail-closed default the security model requires. */
const DEFAULT_FREE_FALLBACK = {
  plan: "free",
  raw_plan: "free",
  is_paid: false,
  in_trial: false,
  trial_ends_at: null,
  trial_days_remaining: null,
  caps: {},
  features: {},
  min_plan_by_feature: {},
  plans: {},
};

export function EntitlementsProvider({ children }) {
  const [data, setData] = useState(null);   // null = still loading
  const [error, setError] = useState(null);
  const inflight = useRef(null);             // de-dupe concurrent requests

  const refresh = useCallback(() => {
    // De-dupe: if a request is already in flight, return its promise so
    // multiple simultaneous callers (e.g. <TrialChip> + <Layout>) share
    // the network round-trip.
    if (inflight.current) return inflight.current;
    // Bootstrap probe — must NOT retry on 503 (Render cold-start).
    // Same reasoning as the /auth/me bootstrap in useAuth.jsx: a 503
    // here would block the landing page for ~26s while axios backs
    // off.  Fail-closed to Free tier on any 5xx/network error.
    const p = api
      .get("/billing/entitlements", { _noRetry: true })
      .then((res) => {
        setData(res.data);
        setError(null);
        return res.data;
      })
      .catch((err) => {
        // Fail closed: keep showing Free tier. A 401 just means the
        // user isn't logged in — perfectly normal on landing page.
        setError(err);
        setData(DEFAULT_FREE_FALLBACK);
        return DEFAULT_FREE_FALLBACK;
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ─── Ergonomic accessors ───────────────────────────────────────────
  // These run on EVERY render but the data they read is stable, so
  // useMemo would cost more than it saves.

  /** True iff the user's plan grants the boolean feature flag. Unknown
   * features fail closed (false). Mirrors backend has_feature(). */
  const hasFeature = useCallback(
    (featureKey) => Boolean(data?.features?.[featureKey] === true),
    [data],
  );

  /** True iff `current` >= the cap on `capKey`. Treats unlimited (-1)
   * as never-at-cap. Mirrors backend at_cap(). */
  const isAtCap = useCallback(
    (capKey, current) => {
      const cap = data?.caps?.[capKey];
      if (cap == null) return false; // unknown cap — defer to server gate
      if (cap < 0) return false; // unlimited
      return current >= cap;
    },
    [data],
  );

  /** Numeric cap for a key, or -1 if unlimited, or undefined if unknown. */
  const cap = useCallback(
    (capKey) => data?.caps?.[capKey],
    [data],
  );

  /** The lowest plan that unlocks `featureKey` — for upgrade CTAs. */
  const minPlanForFeature = useCallback(
    (featureKey) => data?.min_plan_by_feature?.[featureKey] || null,
    [data],
  );

  /** Snapshot of caps + features for a specific plan — used by the
   * upgrade modal to render "Starter unlocks X / Pro unlocks Y". */
  const planSnapshot = useCallback(
    (planKey) => data?.plans?.[planKey] || null,
    [data],
  );

  // ─── Three-state contract (loading | locked | unlocked) ────────────
  // Tier-flicker fix: every consumer that gates UI on a feature/plan
  // MUST treat `loading` as a real third state. While `loading === true`
  // the cached payload defaults to Free shape (plan="free", every
  // hasFeature()→false) so naive consumers would render the locked /
  // upgrade UI for ~150-300ms and then re-render unlocked once the
  // payload lands. That flicker is the "asks Starter+ then gets normal"
  // bug Manoj reported on the trial flow.
  //
  // Rule for callers:
  //   • Show locked / UpgradeNudge ONLY when `isReady && !hasFeature(...)`
  //   • Render nothing (or a subtle skeleton) while `!isReady`
  //
  // `isReady` is the positive flag — preferred at call sites because
  // negating `loading` invites the "let me just check truthy" mistake.
  const loading = data === null;
  const isReady = !loading;

  const value = {
    // Raw payload (escape hatch)
    data,
    loading,
    isReady,
    error,
    refresh,

    // Quick state
    plan: data?.plan || "free",
    rawPlan: data?.raw_plan || "free",
    isPaid: Boolean(data?.is_paid),
    inTrial: Boolean(data?.in_trial),
    trialDaysRemaining: data?.trial_days_remaining ?? null,
    trialEndsAt: data?.trial_ends_at || null,

    // Helpers
    hasFeature,
    isAtCap,
    cap,
    minPlanForFeature,
    planSnapshot,
  };

  return (
    <EntitlementsContext.Provider value={value}>
      {children}
    </EntitlementsContext.Provider>
  );
}

/**
 * useEntitlements — pull the user's tier entitlements + helpers.
 *
 * Returns:
 *   {
 *     plan, isPaid, inTrial, trialDaysRemaining, ...
 *     hasFeature(key) -> bool
 *     isAtCap(key, current) -> bool
 *     cap(key) -> number | -1 (unlimited) | undefined (unknown)
 *     minPlanForFeature(key) -> "starter" | "pro" | null
 *     planSnapshot(plan) -> { caps, features } | null
 *     refresh() -> Promise<payload>
 *   }
 *
 * If used outside <EntitlementsProvider> (e.g. unauthenticated landing
 * pages), returns a fail-closed Free-tier shape so calling code doesn't
 * have to null-check every accessor.
 */
export function useEntitlements() {
  const ctx = useContext(EntitlementsContext);
  if (ctx) return ctx;
  // Used outside the provider — return a no-op safe default rather
  // than throwing, so a stray <Locked> on a public page doesn't crash.
  // `isReady: true` here because there's nothing to wait FOR — the
  // consumer should treat this as a settled Free shape, not a loading
  // state (otherwise public landing pages would render skeletons forever).
  return {
    data: DEFAULT_FREE_FALLBACK,
    loading: false,
    isReady: true,
    error: null,
    refresh: () => Promise.resolve(DEFAULT_FREE_FALLBACK),
    plan: "free",
    rawPlan: "free",
    isPaid: false,
    inTrial: false,
    trialDaysRemaining: null,
    trialEndsAt: null,
    hasFeature: () => false,
    isAtCap: () => false,
    cap: () => undefined,
    minPlanForFeature: () => null,
    planSnapshot: () => null,
  };
}
