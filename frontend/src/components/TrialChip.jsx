import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Small trial countdown chip — sits in the sidebar above the
 * navigation. Replaces the older full-width TrialBanner that
 * occupied a stripe across the dashboard.
 *
 * Design:
 *   • Compact pill that lives in the sidebar header — always
 *     visible without competing for content area attention.
 *   • Calm by default (cool blue tint with 🎁 icon) — informational.
 *   • Shifts to warm amber + 🌤️ icon when ≤ 3 days remain. Still
 *     not red-alarm: nothing bad happens at trial end (downgrade
 *     to Free with usage caps), so urgency stays gentle.
 *   • Clickable — taps go to /subscription.
 *   • Dismissible — × hides for 24 hours, persisted in localStorage.
 *
 * Renders nothing for paid users, expired trials, or legacy users
 * without trial state. Self-loads /api/billing/me; silent on
 * failure.
 */

const DISMISS_KEY = "bonbox_trial_chip_dismissed_until";


export default function TrialChip() {
  const { t } = useLanguage();
  const [billing, setBilling] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
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
  if (days == null || !billing.trial_active || days <= 0) return null;

  const urgent = days <= 3;
  const label = days === 1
    ? (t("trialChipOneDay") || "1 day left in trial")
    : (t("trialChipManyDays") || "{n} days left in trial").replace("{n}", days);

  return (
    <div className="px-3 pb-2">
      <Link
        to="/subscription"
        className={`group relative block px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition ${
          urgent
            ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
            : "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/60 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30"
        }`}
        title={urgent
          ? (t("trialChipUrgentTooltip") || "Trial ends soon — see plans")
          : (t("trialChipTooltip") || "View Pro plans")}
      >
        <span className="flex items-center gap-1.5">
          <span className="shrink-0">{urgent ? "🌤️" : "🎁"}</span>
          <span className="flex-1 truncate">{label}</span>
          <svg
            className="w-2.5 h-2.5 opacity-50 group-hover:opacity-100 shrink-0"
            fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </span>
      </Link>
      {/* Tiny "Hide for today" link below — separate from the chip
          so a casual click on the chip itself navigates rather than
          dismisses. Single-tap interactions feel less hostile. */}
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, String(Date.now() + 86400000));
          setHidden(true);
        }}
        className="mt-0.5 w-full text-[9px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-right"
      >
        {t("hideForToday") || "hide for today"}
      </button>
    </div>
  );
}
