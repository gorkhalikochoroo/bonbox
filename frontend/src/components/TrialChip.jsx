import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Trial countdown — thin status strip at the very top of <main>,
 * right-aligned, ~28px tall.
 *
 * Why a strip and not a floating pill (after several iterations):
 *   • Sidebar placement → "looks disgusting" (Manoj)
 *   • Top-right floating → overlapped page action buttons
 *     (Quick Sale / Download PDF / etc.)
 *   • Bottom-left → invisible behind the sidebar (z-50 covers z-40)
 *   • Bottom-right → already taken by ✨ BonBoxAgent
 *   • Bottom-center → overlaid AI insight cards / content
 *
 * The thin top strip sits ABOVE all page content, takes its own
 * tiny row, and never overlaps anything. Right-aligned so it
 * doesn't compete with page titles which are left-aligned. Dismiss
 * × hides it for 24h; after dismiss the strip disappears entirely
 * (no empty space) so users who don't want it never see it.
 *
 * Renders nothing for paid users, expired trials, or legacy users
 * without trial state. Hidden on mobile (md-) — the dashboard
 * final-stretch tip kicks in at ≤ 2 days for mobile users.
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

  const dismiss = (e) => {
    e.preventDefault();
    e.stopPropagation();
    localStorage.setItem(DISMISS_KEY, String(Date.now() + 86400000));
    setHidden(true);
  };

  return (
    <div className={`hidden md:flex items-center justify-end gap-2 px-4 sm:px-6 py-1.5 border-b text-[11px] ${
      urgent
        ? "border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-900/10"
        : "border-gray-100 dark:border-gray-700/50 bg-gray-50/40 dark:bg-gray-800/20"
    }`}>
      <Link
        to="/subscription"
        className={`group inline-flex items-center gap-1.5 hover:underline ${
          urgent
            ? "text-amber-800 dark:text-amber-300 font-medium"
            : "text-gray-600 dark:text-gray-400"
        }`}
      >
        <span aria-hidden="true">{urgent ? "🌤️" : "🎁"}</span>
        <span>{label}</span>
      </Link>
      <span className="text-gray-300 dark:text-gray-600" aria-hidden="true">·</span>
      <Link
        to="/subscription"
        className={`hover:underline ${
          urgent
            ? "text-amber-800 dark:text-amber-300 font-medium"
            : "text-gray-500 dark:text-gray-400"
        }`}
      >
        {t("trialChipUpgradeLink") || "see plans"}
      </Link>
      <button
        type="button"
        onClick={dismiss}
        title={t("hideForToday") || "Hide for today"}
        aria-label={t("hideForToday") || "Hide for today"}
        className="ml-1 w-5 h-5 inline-flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-gray-700/40 transition"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
