import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";

/**
 * Dashboard countdown banner — shown when user has an active trial OR
 * when their trial ended in the last 7 days (gives them a re-upgrade nudge).
 *
 * Renders nothing for paid users or users without trial state. Reads
 * entitlements from the unified hook (no per-component round-trip).
 */

const DISMISS_KEY = "bonbox_trial_banner_dismissed_until";

export default function TrialBanner() {
  const { t } = useLanguage();
  const ent = useEntitlements();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Honor dismissal — set in localStorage with a timestamp
    const until = parseInt(localStorage.getItem(DISMISS_KEY) || "0", 10);
    if (until > Date.now()) {
      setHidden(true);
    }
  }, []);

  if (hidden || ent.loading) return null;
  if (ent.isPaid) return null;

  const days = ent.trialDaysRemaining;
  // Three states: trial active (days > 0), trial ended recently, no trial
  if (days == null) return null; // Legacy user without trial — don't pester

  // Active trial — calm, informational. We deliberately do NOT use red/amber
  // alarm colors; nothing bad happens at trial end (you just go to Free, your
  // data stays). A soft slate/blue card across all states keeps it from
  // reading as "ACTION REQUIRED" — feedback was that the amber felt pushy.
  if (ent.inTrial && days > 0) {
    const closing = days <= 2; // "closing" not "urgent" — wording matters
    return (
      <div className="flex items-start gap-3 rounded-xl border bg-gray-50 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700 px-4 py-3">
        <span className="text-lg shrink-0">{closing ? "🌤️" : "🎁"}</span>
        <div className="flex-1 text-sm">
          <span className="font-semibold text-gray-800 dark:text-gray-200">
            {(days === 1 ? (t("trialDaysLeftSingular") || "{n} day left in your free Pro trial.") : (t("trialDaysLeftPlural") || "{n} days left in your free Pro trial.")).replace("{n}", days)}
          </span>
          <span className="ml-1 text-gray-600 dark:text-gray-400">
            {closing
              ? (t("trialClosingDetail") || "When it ends you stay on Free. Every feature still works — just with usage caps. No card, no surprises.")
              : (t("trialOpenDetail") || "No card needed. If you decide to keep Pro, founding price 249 kr/mo is locked in for the first 100 customers.")}
          </span>
        </div>
        <Link
          to="/subscription"
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap
            bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-100"
        >
          {closing ? (t("seeWhatChanges") || "See what changes") : (t("seePlans") || "See plans")}
        </Link>
        <button
          onClick={() => {
            // Hide for 24h
            localStorage.setItem(DISMISS_KEY, String(Date.now() + 86400000));
            setHidden(true);
          }}
          aria-label={t("hideForToday") || "Hide for today"}
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
        >
          ×
        </button>
      </div>
    );
  }

  // Trial just expired (within 7 days) — gentle nudge
  if (!ent.inTrial && ent.plan === "free" && ent.trialEndsAt) {
    const endTime = new Date(ent.trialEndsAt).getTime();
    const daysSince = Math.floor((Date.now() - endTime) / 86400000);
    if (daysSince < 0 || daysSince > 7) return null;
    return (
      <div className="flex items-start gap-3 rounded-xl border bg-gray-50 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700 px-4 py-3">
        <span className="text-lg shrink-0">📦</span>
        <div className="flex-1 text-sm">
          <span className="font-semibold text-gray-800 dark:text-gray-200">
            {daysSince === 0
              ? (t("trialEndedToday") || "Your trial ended today.")
              : (daysSince === 1
                  ? (t("trialEndedAgoSingular") || "Your trial ended {n} day ago.").replace("{n}", daysSince)
                  : (t("trialEndedAgoPlural")   || "Your trial ended {n} days ago.").replace("{n}", daysSince))}
          </span>
          <span className="ml-1 text-gray-600 dark:text-gray-400">
            {t("trialEndedBackOnFree") || "You're back on Free — every feature still works, just with usage caps. Founding-member 249 kr/mo is still available (first 100 customers)."}
          </span>
        </div>
        <Link
          to="/subscription"
          className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-md bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white whitespace-nowrap"
        >
          {t("upgrade") || "Upgrade"}
        </Link>
        <button
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, String(Date.now() + 86400000 * 7));
            setHidden(true);
          }}
          aria-label={t("hide") || "Hide"}
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
        >
          ×
        </button>
      </div>
    );
  }

  return null;
}
