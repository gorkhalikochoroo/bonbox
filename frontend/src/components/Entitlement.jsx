/**
 * Tier-gating UI primitives — used everywhere a free/starter user would
 * otherwise hit a backend 402.
 *
 * Three components live here:
 *
 *   <Locked feature="ai_anomaly_detection">{children}</Locked>
 *     Renders children dimmed + un-clickable, overlaid with a small lock
 *     badge. Clicking opens the matching <UpgradePrompt>. If the user's
 *     plan already grants the feature, renders children unchanged. Use
 *     when the locked element is small/medium (a card, a button strip,
 *     a chart).
 *
 *   <UpgradePrompt feature="..." onClose={fn}>
 *     Modal that explains "you need at least Starter" with the lowest
 *     plan's caps + features summary, plus a CTA to /subscription. Can
 *     be controlled (pass `open` + `onClose`) or self-managed (no props
 *     and it triggers from <Locked>).
 *
 *   <TierBadge plan="pro" />
 *     Tiny inline pill ("Pro", "Starter") shown next to feature names in
 *     menus and tooltips. Color-coded by plan (matches the SubscriptionPage
 *     palette).
 *
 * Why one file: these three are tightly coupled — <Locked> renders a
 * <TierBadge> + opens an <UpgradePrompt>, and they share the same plan
 * color helpers. Splitting into 3 files would mean a circular import or
 * a 4th `entitlement-helpers.js`. One file is simpler and they're all
 * small.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useEntitlements } from "../hooks/useEntitlements";
import { useLanguage } from "../hooks/useLanguage";


// ─── Plan label + color helpers ─────────────────────────────────────

/** Display label for a plan key. Tiny enough to inline; centralised so
 * "starter" never becomes "Starter Plan" in one place and "starter" in
 * another. Three purchasable tiers + the trial state — Business was
 * dropped May 2026 (kept as a defensive label below in case a legacy
 * user payload somehow surfaces it). */
function planLabel(plan, t) {
  const map = {
    free:     t("planFree")     || "Free",
    starter:  t("planStarter")  || "Starter",
    trial:    t("planTrial")    || "Trial",
    pro:      t("planPro")      || "Pro",
  };
  return map[plan] || plan;
}

/** Plan-keyed color classes for the badge + button accents. Matched to
 * the SubscriptionPage palette so the visual language is consistent
 * across the upgrade journey. */
function planClasses(plan) {
  switch (plan) {
    case "starter":
      return {
        badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
        button: "bg-blue-600 hover:bg-blue-700",
      };
    case "pro":
      return {
        badge: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
        button: "bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white",
      };
    case "trial":
      return {
        badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
        button: "bg-amber-600 hover:bg-amber-700",
      };
    case "free":
    default:
      return {
        badge: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
        button: "bg-gray-600 hover:bg-gray-700",
      };
  }
}


// ─── <TierBadge plan="pro" /> ───────────────────────────────────────

/**
 * Small inline pill showing a plan tier. Use to mark feature names with
 * "Pro" so users see WHICH tier they need before they click. Compact
 * enough to fit inside a menu item; just text — no icon — to stay quiet.
 */
export function TierBadge({ plan, className = "" }) {
  const { t } = useLanguage();
  if (!plan) return null;
  const c = planClasses(plan);
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${c.badge} ${className}`}
    >
      {planLabel(plan, t)}
    </span>
  );
}


// ─── <UpgradePrompt feature="..." onClose={fn} /> ───────────────────

/**
 * Modal that surfaces when a user tries to use a locked feature. Shows
 * the lowest plan that unlocks it, what they'd get on that plan, and
 * a CTA to /subscription.
 *
 * Two usage modes:
 *   1. Self-contained from <Locked>: just pass `feature`. The component
 *      reads the entitlements hook for min plan info.
 *   2. Cap-exceeded (caller knows they hit a numeric cap): pass
 *      `feature` AS the cap key + `forCap` true. The modal renders
 *      "You've hit X/Y" instead of "feature locked".
 *
 * Closing: clicking outside, the X button, or the "Maybe later" button
 * fires onClose. The "See plans" CTA is a Link to /subscription so
 * the back button works correctly.
 */
export function UpgradePrompt({ feature, forCap = false, open = true, onClose }) {
  const { t } = useLanguage();
  const ent = useEntitlements();
  if (!open) return null;

  const upgradePlan = forCap ? null : ent.minPlanForFeature(feature);
  // Fallback: when min_plan_by_feature returns null (unknown feature) or
  // the caller didn't pass enough info, point them to Pro as the safe
  // upsell (covers most premium features in practice).
  const targetPlan = upgradePlan || "pro";
  const snapshot = ent.planSnapshot(targetPlan);
  const c = planClasses(targetPlan);

  const headline = forCap
    ? (t("upgradeCapHeadline") || "You've reached your plan limit")
    : (t("upgradeFeatureHeadline") || "Upgrade to unlock this feature");

  // Body copy: pick a sentence based on whether we know the target plan.
  const body = forCap
    ? (t("upgradeCapBody") || "You're on the {plan} plan. Upgrade to {target} for higher limits.")
        .replace("{plan}", planLabel(ent.plan, t))
        .replace("{target}", planLabel(targetPlan, t))
    : (t("upgradeFeatureBody") || "This feature is available on {target} and above.")
        .replace("{target}", planLabel(targetPlan, t));

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl max-w-md w-full shadow-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`p-5 sm:p-6 ${c.badge.split(" ")[0]} bg-opacity-50 dark:bg-opacity-20`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <TierBadge plan={targetPlan} />
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {t("upgradeRequired") || "required"}
                </span>
              </div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {headline}
              </h2>
              <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">{body}</p>
            </div>
            {onClose && (
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 shrink-0"
                aria-label={t("close") || "Close"}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {snapshot && (
          <div className="px-5 sm:px-6 py-4 border-t border-gray-100 dark:border-gray-700/50">
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
              {t("upgradeWhatYouGet") || "What you get on"} {planLabel(targetPlan, t)}
            </p>
            <ul className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
              {/* Pull a few highlights — full matrix lives on /subscription. */}
              {snapshot.caps?.branches !== undefined && (
                <li className="flex items-center gap-2">
                  <span className="text-emerald-600">✓</span>
                  <span>{snapshot.caps.branches === -1
                    ? (t("upgradeUnlimitedBranches") || "Unlimited businesses")
                    : (t("upgradeNumBranches") || "{n} businesses").replace("{n}", snapshot.caps.branches)}
                  </span>
                </li>
              )}
              {snapshot.caps?.team_users !== undefined && (
                <li className="flex items-center gap-2">
                  <span className="text-emerald-600">✓</span>
                  <span>{snapshot.caps.team_users === -1
                    ? (t("upgradeUnlimitedTeam") || "Unlimited team members")
                    : (t("upgradeNumTeam") || "{n} team members").replace("{n}", snapshot.caps.team_users)}
                  </span>
                </li>
              )}
              {snapshot.caps?.daily_close_export_days !== undefined && (
                <li className="flex items-center gap-2">
                  <span className="text-emerald-600">✓</span>
                  <span>
                    {snapshot.caps.daily_close_export_days >= 366
                      ? (t("upgradeFullYearExport") || "Full-year accountant export")
                      : (t("upgradeDayExport") || "{n}-day accountant export").replace("{n}", snapshot.caps.daily_close_export_days)}
                  </span>
                </li>
              )}
              {snapshot.features?.ai_anomaly_detection && (
                <li className="flex items-center gap-2">
                  <span className="text-emerald-600">✓</span>
                  <span>{t("upgradeAIAnomaly") || "AI anomaly detection"}</span>
                </li>
              )}
              {snapshot.features?.white_label_pdf && (
                <li className="flex items-center gap-2">
                  <span className="text-emerald-600">✓</span>
                  <span>{t("upgradeWhiteLabelPdf") || "White-label PDFs (no BonBox branding)"}</span>
                </li>
              )}
              {snapshot.features?.priority_support && (
                <li className="flex items-center gap-2">
                  <span className="text-emerald-600">✓</span>
                  <span>{t("upgradePrioritySupport") || "Priority support"}</span>
                </li>
              )}
            </ul>
          </div>
        )}
        <div className="px-5 sm:px-6 py-4 flex items-center justify-end gap-2 bg-gray-50 dark:bg-gray-900/40">
          {onClose && (
            <button
              onClick={onClose}
              className="px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
            >
              {t("upgradeMaybeLater") || "Maybe later"}
            </button>
          )}
          <Link
            to="/subscription"
            onClick={onClose}
            className={`px-4 py-2 ${c.button} text-white text-sm font-medium rounded-lg transition shadow-sm`}
          >
            {t("upgradeCTA") || "See plans →"}
          </Link>
        </div>
      </div>
    </div>
  );
}


// ─── <Locked feature="..."> ─────────────────────────────────────────

/**
 * Wraps a feature UI element. If the user's plan grants the feature,
 * passes children through unchanged. If not, dims them, blocks
 * pointer events, and adds a small "Pro" badge in the top-right
 * that opens <UpgradePrompt>.
 *
 * Use the OPPOSITE of what you'd think: the children are the FEATURE,
 * not the upgrade CTA. Locked just adds the lock layer on top.
 *
 * Example:
 *   <Locked feature="ai_anomaly_detection">
 *     <AnomalyChartCard data={...} />
 *   </Locked>
 *
 * For numeric-cap gating (no boolean feature flag), use
 * <Locked atCap capKey="branches" current={count}> instead.
 */
export function Locked({
  feature,
  capKey,
  current,
  atCap = false,
  children,
  className = "",
  badgePlacement = "top-right",
}) {
  const ent = useEntitlements();
  const [promptOpen, setPromptOpen] = useState(false);

  // Tier-flicker fix: while entitlements are still loading, ent.hasFeature()
  // returns false (Free-tier fail-closed default) — which would render the
  // locked overlay for ~150-300ms before the trial/Starter/Pro payload
  // lands and the children un-lock. That flicker is the "asks Starter+
  // even, then gets normal" bug Manoj saw on the trial flow.
  //
  // While !isReady we pass children through unchanged (no overlay, no
  // badge). The user sees the real feature UI directly — and IF it turns
  // out they're actually Free, the next render adds the overlay. The
  // multi-barrier 10-layer model means the SERVER still gates the
  // underlying action; a Free user who clicked through during the
  // loading window would just get a 402 from the API. UI-side this is
  // strictly better than the flicker.
  if (!ent.isReady) return <>{children}</>;

  // Determine lock state.
  let locked = false;
  if (atCap && capKey != null) {
    locked = ent.isAtCap(capKey, current ?? 0);
  } else if (feature) {
    locked = !ent.hasFeature(feature);
  }

  if (!locked) return <>{children}</>;

  const targetPlan = atCap
    ? null
    : ent.minPlanForFeature(feature) || "pro";

  const placement = {
    "top-right": "top-2 right-2",
    "top-left": "top-2 left-2",
    "bottom-right": "bottom-2 right-2",
  }[badgePlacement] || "top-2 right-2";

  return (
    <>
      <div className={`relative ${className}`}>
        {/* The feature UI, dimmed + non-interactive. tabIndex=-1 + the
            wrapper's onClick prevent keyboard / mouse from reaching the
            children at all — important so a Free user can't tab into
            a "locked" button and trigger its handler. */}
        <div
          aria-hidden="true"
          className="opacity-50 grayscale pointer-events-none select-none"
        >
          {children}
        </div>
        {/* Click-overlay opens the upgrade prompt. Sits over EVERYTHING
            so the entire card is the click target — easier on mobile. */}
        <button
          type="button"
          onClick={() => setPromptOpen(true)}
          className="absolute inset-0 w-full h-full cursor-pointer"
          aria-label="Upgrade required"
        />
        {/* Badge floats in the corner. Z-10 keeps it above the click
            overlay. */}
        <div className={`absolute ${placement} z-10 pointer-events-none`}>
          <TierBadge plan={targetPlan || "pro"} />
        </div>
      </div>
      <UpgradePrompt
        feature={feature || capKey}
        forCap={atCap}
        open={promptOpen}
        onClose={() => setPromptOpen(false)}
      />
    </>
  );
}
