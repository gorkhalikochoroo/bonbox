import { useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";

/**
 * TrialFinalStretchTip — single-line conversion nudge in the last 48 hours
 * of the trial.
 *
 * Differs from TrialBanner (the calm, always-on day-counter):
 *   • Only renders when trial_days_remaining is 1 or 2
 *   • Conversion-focused copy (specific savings, not reassurance)
 *   • Small footprint — one line, fits below TrialBanner without clutter
 *   • Separate dismiss key — dismissing this doesn't hide the calm banner
 *   • Amber accent (urgency without alarm), distinct from TrialBanner's
 *     slate/gray
 *
 * The math in the copy is honest:
 *   founding 249 vs regular 349 = 100 kr/mo difference
 *   100 × 12 = 1,200 kr/year saved, locked for life as long as subscribed
 *
 * Dismissal persists for 24h, then the tip can re-appear (since the user
 * is in a tighter window each day). This way a Day-2 dismiss doesn't
 * silence the Day-1 nudge — those are different decisions.
 */
const DISMISS_KEY = "bonbox.trialFinalStretch.dismissedUntil";

export default function TrialFinalStretchTip() {
  const { t } = useLanguage();
  const ent = useEntitlements();
  const [hidden, setHidden] = useState(() => {
    const until = parseInt(localStorage.getItem(DISMISS_KEY) || "0", 10);
    return until > Date.now();
  });

  if (hidden || ent.loading) return null;
  if (ent.isPaid) return null;
  if (!ent.inTrial) return null;

  const days = ent.trialDaysRemaining;
  if (days == null || days < 1 || days > 2) return null;

  const dismiss = () => {
    // 24-hour dismiss — re-appears next day so the Day-1 nudge isn't muted
    // by a Day-2 dismiss
    localStorage.setItem(DISMISS_KEY, String(Date.now() + 86400000));
    setHidden(true);
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 text-[13px]">
      <span className="text-amber-700 dark:text-amber-300 font-semibold whitespace-nowrap">
        ⏰ {days === 1
          ? (t("trialFinalLastDay") || "Last day")
          : (t("trialFinalTwoDays") || "2 days left")
        }.
      </span>
      <span className="text-amber-800 dark:text-amber-200 flex-1 min-w-0">
        {t("trialFinalSavings") ||
          "Lock founding 249 kr/mo for life — saves 1,200 kr/year vs regular 349."}
      </span>
      <Link
        to="/subscription"
        className="shrink-0 px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-md text-[12px] font-semibold whitespace-nowrap"
      >
        {t("trialFinalLockNow") || "Lock now"}
      </Link>
      <button
        onClick={dismiss}
        aria-label={t("dismiss") || "Dismiss"}
        className="shrink-0 text-amber-400 hover:text-amber-700 dark:hover:text-amber-200 text-base leading-none px-1"
      >
        ×
      </button>
    </div>
  );
}
