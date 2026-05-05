import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";

/**
 * Dashboard countdown banner — shown when user has an active trial OR
 * when their trial ended in the last 7 days (gives them a re-upgrade nudge).
 *
 * Renders nothing for paid users or users without trial state. Self-loads
 * billing summary from /api/billing/me on mount; gracefully no-ops on error.
 */

const DISMISS_KEY = "bonbox_trial_banner_dismissed_until";

export default function TrialBanner() {
  const [billing, setBilling] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Honor dismissal — set in localStorage with a timestamp
    const until = parseInt(localStorage.getItem(DISMISS_KEY) || "0", 10);
    if (until > Date.now()) {
      setHidden(true);
      return;
    }
    api
      .get("/billing/me")
      .then((res) => setBilling(res.data))
      .catch(() => {});
  }, []);

  if (hidden || !billing) return null;
  if (billing.is_paid) return null;

  const days = billing.trial_days_remaining;
  // Three states: trial active (days > 0), trial ended recently, no trial
  if (days == null) return null; // Legacy user without trial — don't pester

  // Active trial — calm, informational. We deliberately do NOT use red/amber
  // alarm colors; nothing bad happens at trial end (you just go to Free, your
  // data stays). A soft slate/blue card across all states keeps it from
  // reading as "ACTION REQUIRED" — feedback was that the amber felt pushy.
  if (billing.trial_active && days > 0) {
    const closing = days <= 2; // "closing" not "urgent" — wording matters
    return (
      <div className="flex items-start gap-3 rounded-xl border bg-gray-50 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700 px-4 py-3">
        <span className="text-lg shrink-0">{closing ? "🌤️" : "🎁"}</span>
        <div className="flex-1 text-sm">
          <span className="font-semibold text-gray-800 dark:text-gray-200">
            {closing
              ? `${days} day${days === 1 ? "" : "s"} left in your free Pro trial.`
              : `${days} days left in your free Pro trial.`}
          </span>
          <span className="ml-1 text-gray-600 dark:text-gray-400">
            {closing
              ? "When it ends you stay on Free. Every feature still works — just with usage caps. No card, no surprises."
              : "No card needed. If you decide to keep Pro, founding price 99 kr/mo is locked in for the first 1,000 customers."}
          </span>
        </div>
        <Link
          to="/subscription"
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap
            bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-100"
        >
          {closing ? "See what changes" : "See plans"}
        </Link>
        <button
          onClick={() => {
            // Hide for 24h
            localStorage.setItem(DISMISS_KEY, String(Date.now() + 86400000));
            setHidden(true);
          }}
          aria-label="Hide for today"
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
        >
          ×
        </button>
      </div>
    );
  }

  // Trial just expired (within 7 days) — gentle nudge
  if (billing.trial_active === false && billing.plan === "free" && billing.trial_ends_at) {
    const endTime = new Date(billing.trial_ends_at).getTime();
    const daysSince = Math.floor((Date.now() - endTime) / 86400000);
    if (daysSince < 0 || daysSince > 7) return null;
    return (
      <div className="flex items-start gap-3 rounded-xl border bg-gray-50 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700 px-4 py-3">
        <span className="text-lg shrink-0">📦</span>
        <div className="flex-1 text-sm">
          <span className="font-semibold text-gray-800 dark:text-gray-200">
            Your trial ended {daysSince === 0 ? "today" : `${daysSince} day${daysSince === 1 ? "" : "s"} ago`}.
          </span>
          <span className="ml-1 text-gray-600 dark:text-gray-400">
            You're back on Free — every feature still works, just with usage caps.
            Founding-member 99 kr/mo is still available (first 1,000 customers).
          </span>
        </div>
        <Link
          to="/subscription"
          className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-md bg-green-600 hover:bg-green-700 text-white whitespace-nowrap"
        >
          Upgrade
        </Link>
        <button
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, String(Date.now() + 86400000 * 7));
            setHidden(true);
          }}
          aria-label="Hide"
          className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
        >
          ×
        </button>
      </div>
    );
  }

  return null;
}
