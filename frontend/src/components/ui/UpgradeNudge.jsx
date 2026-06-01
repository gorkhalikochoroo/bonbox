/**
 * UpgradeNudge — the single, tasteful tier-upgrade prompt.
 *
 * Before this, the app showed locked features four different ways:
 *   • silent failures
 *   • window.alert("Upgrade to Pro!")
 *   • inline red error text
 *   • disabled buttons with no explanation
 * All four felt amateur. This component bakes the one true pattern.
 *
 * Three intents:
 *
 *   `inline` — a soft chip under a locked button or next to a result.
 *     Used when the user CAN still complete the task another way
 *     (e.g. Free user can download accountant report; Starter unlocks
 *     direct-email).
 *
 *   `card` — a Card-shaped block that replaces a section. Used when
 *     the feature itself is gated and the user has nothing else to do
 *     there (e.g. AI menu scan section for Free).
 *
 *   `dialog` — a centered modal. Used as the response when the user
 *     actively tries a locked action. Replaces the old window.alert.
 *
 * Voice (always):
 *   "What it does for you" (one sentence) → "Tier · price/mo" → "Try"
 * Never:
 *   "Upgrade required" / "This feature is locked" / "Premium only"
 *
 * Pricing: shows the FOUNDING rate by default since that's what
 * early users see. Strikethrough on regular rate so they see the
 * discount. Once the founding window closes (first 100 customers)
 * we'll flip the default.
 */
import React, { useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useEntitlements } from "../../hooks/useEntitlements";
import { isNativeApp } from "../../utils/platform";

// ─── Tier prices (founding rates leading) ─────────────────────────
// Single source of truth — sync with backend/app/services/billing.py
// STRIPE prices. Keep DKK only; localization is handled at render
// time if/when other currencies launch.
const TIER_LABELS = {
  starter: {
    name: "Starter",
    founding: "129 DKK/mo",
    regular: "199 DKK/mo",
    badge: "Founding rate · First 100",
  },
  pro: {
    name: "Pro",
    founding: "249 DKK/mo",
    regular: "349 DKK/mo",
    badge: "Founding rate · First 100",
  },
};

function PriceTag({ tier }) {
  const t = TIER_LABELS[tier] || TIER_LABELS.starter;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-semibold text-stone-900 dark:text-stone-100">
        {t.founding}
      </span>
      <span className="line-through text-stone-400 text-[11px]">
        {t.regular}
      </span>
    </span>
  );
}

/**
 * <UpgradeNudge intent="inline" tier="starter" benefit="…" />
 *
 * Optional self-gating: pass a `feature` key (e.g. "bank_auto_reconcile")
 * and the component will:
 *   • return null while entitlements are still loading (kills the
 *     trial-flicker for callsites that render the nudge unconditionally)
 *   • return null when the user already has the feature
 *   • render the nudge when isReady && !hasFeature(feature)
 *
 * Without `feature`, the component renders unconditionally — the parent
 * is responsible for gating (legacy pattern; many callers still use it
 * because they wrap the nudge in their own `isReady && !hasFeature(...)`
 * check, which is also fine).
 */
export default function UpgradeNudge({
  intent = "inline",
  tier = "starter",
  benefit,        // one-sentence value: "Email directly to your accountant"
  ctaLabel = "See plans",
  cta = "/subscription",
  onTry = null,    // optional callback if you want to handle the click
  icon = null,
  className = "",
  feature = null,  // optional — when set, self-gate on entitlements (see above)
}) {
  const navigate = useNavigate();
  const tierMeta = TIER_LABELS[tier] || TIER_LABELS.starter;

  // Self-gating path — only fires when caller passed `feature`. Hooks
  // must run unconditionally, so we always call useEntitlements and
  // decide whether to short-circuit below.
  const ent = useEntitlements();
  if (feature) {
    // Tier-flicker contract: don't render the upgrade surface while
    // entitlements are still in flight. The fail-closed Free fallback
    // would otherwise make hasFeature("anything") === false and flash
    // the nudge to trial / Starter / Pro users for 150-300ms.
    if (!ent.isReady) return null;
    // If the user already has the feature, the nudge is wrong — hide.
    if (ent.hasFeature(feature)) return null;
  }

  // ── App Store compliance (Apple Guideline 3.1.1) ────────────────────
  // The native app must carry NO upgrade/purchase surface at all — that
  // includes the tier NAME ("Included on Pro / Starter"), the price block
  // (TIER_LABELS / PriceTag), and any /subscription CTA. Approach (a) for
  // iOS is to HIDE gated features outright, so the nudge has nothing to
  // say: render null. This also guarantees TIER_LABELS / PriceTag are never
  // reached on native. Web keeps the full nudge (price + CTA) unchanged.
  if (isNativeApp()) return null;

  const handleClick = (e) => {
    if (onTry) {
      e.preventDefault();
      onTry();
    }
  };

  if (intent === "inline") {
    return (
      <Link
        to={cta}
        onClick={handleClick}
        className={
          "inline-flex items-center gap-2 px-3 py-1.5 rounded-md " +
          "bg-emerald-50 dark:bg-emerald-900/20 " +
          "text-emerald-800 dark:text-emerald-300 " +
          "border border-emerald-200/70 dark:border-emerald-800/60 " +
          "hover:bg-emerald-100/70 dark:hover:bg-emerald-900/40 " +
          "text-xs font-medium transition-colors " + className
        }
      >
        {icon && <span aria-hidden="true">{icon}</span>}
        <span>
          {benefit} · <strong>{tierMeta.name}</strong> {tierMeta.founding}
        </span>
        <svg
          className="w-3 h-3 opacity-70"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </Link>
    );
  }

  if (intent === "card") {
    return (
      <div
        className={
          "rounded-xl border border-emerald-200/70 dark:border-emerald-800/60 " +
          "bg-gradient-to-br from-emerald-50/80 to-white " +
          "dark:from-emerald-900/20 dark:to-stone-900 " +
          "p-5 sm:p-6 " + className
        }
      >
        <div className="flex items-start gap-3 mb-3">
          {icon && (
            <div className="text-2xl shrink-0" aria-hidden="true">
              {icon}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-semibold tracking-wider uppercase text-emerald-700 dark:text-emerald-400">
              {tierMeta.name} · {tierMeta.badge}
            </p>
            <h4 className="text-base font-semibold text-stone-900 dark:text-stone-100 mt-1">
              {benefit}
            </h4>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <PriceTag tier={tier} />
          <Link
            to={cta}
            onClick={handleClick}
            className="inline-flex items-center gap-1.5 px-4 h-9 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors"
          >
            {ctaLabel}
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>
    );
  }

  // intent === "dialog"
  return <UpgradeNudgeDialog
    icon={icon}
    benefit={benefit}
    ctaLabel={ctaLabel}
    cta={cta}
    handleClick={handleClick}
    tier={tier}
    tierMeta={tierMeta}
    className={className}
    navigate={navigate}
  />;
}

/** Modal dialog variant — split out so we can wire up Escape + focus
 *  restoration via hooks without touching the simpler chip/card paths.
 *
 *  WEB ONLY. The parent <UpgradeNudge> returns null on native (Apple 3.1.1),
 *  so this dialog — which shows the tier name, price (PriceTag) and a
 *  /subscription CTA — is never rendered inside the iOS app. */
function UpgradeNudgeDialog({ icon, benefit, ctaLabel, cta, handleClick, tier, tierMeta, className, navigate }) {
  const dialogRef = useRef(null);
  const previousActiveElementRef = useRef(null);

  useEffect(() => {
    previousActiveElementRef.current = document.activeElement;
    const focusTimer = setTimeout(() => dialogRef.current?.focus(), 0);
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        navigate(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(focusTimer);
      try { previousActiveElementRef.current?.focus?.(); } catch { /* gone */ }
    };
  }, [navigate]);

  return (
    <div
      className={
        "fixed inset-0 z-[100] flex items-center justify-center p-4 " +
        "bg-stone-900/50 backdrop-blur-sm " + className
      }
      onClick={() => navigate(-1)}
      aria-hidden="true"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-nudge-title"
        tabIndex={-1}
        className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-2xl shadow-xl max-w-sm w-full p-6 text-center focus:outline-none"
      >
        {icon && <div className="text-4xl mb-3" aria-hidden="true">{icon}</div>}
        <p className="text-[10px] font-semibold tracking-wider uppercase text-emerald-700 dark:text-emerald-400">
          {tierMeta.name} · {tierMeta.badge}
        </p>
        <h4 id="upgrade-nudge-title" className="text-lg font-semibold text-stone-900 dark:text-stone-100 mt-1 mb-2">
          {benefit}
        </h4>
        <div className="mb-5">
          <PriceTag tier={tier} />
        </div>
        <Link
          to={cta}
          onClick={handleClick}
          className="block w-full px-4 h-11 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors leading-[2.75rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900"
        >
          {ctaLabel}
        </Link>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mt-3 text-xs text-stone-600 dark:text-stone-300 hover:text-stone-800 dark:hover:text-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded px-1"
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}
