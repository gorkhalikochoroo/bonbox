import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Trial countdown chip — small floating pill in the bottom-LEFT
 * corner. NOT in the sidebar (cluttered the header), NOT in the
 * top-right (overlapped page action buttons like Quick Sale /
 * Download PDF), NOT a full-width banner (too pushy).
 *
 * Design:
 *   • Compact pill: just "🎁 14d" (icon + abbreviated days).
 *     Hover/aria reveals the full "14 days left in trial" text.
 *   • Fixed bottom-left, just inside the viewport. Doesn't take
 *     up layout space — floats above content.
 *   • Position: fixed bottom-CENTER (left-1/2 with -translate-x-1/2).
 *     Picked deliberately to sit out of the way of the four
 *     occupied corners:
 *       - top-left   : sidebar
 *       - top-right  : per-page action buttons (Download PDF /
 *                      Quick Sale / Snap Receipt)
 *       - bottom-left: QuickAdd ➕ widget (at left-6)
 *       - bottom-right: ✨ BonBoxAgent (at right-6)
 *     The bottom-center stripe is empty everywhere — no fights
 *     with sidebar z-index either (the chip sits in the main
 *     content area horizontally).
 *   • Calm slate-on-white default with a subtle border + shadow.
 *     Shifts to amber when ≤ 3 days remain (gentle urgency,
 *     not red-alarm — nothing bad happens at trial end).
 *   • Inline × button to dismiss for 24h.
 *   • Click anywhere else on the pill → /subscription.
 *   • Hidden on mobile (md-) — mobile users have the dashboard
 *     final-stretch tip kick in at ≤ 2 days, which is enough
 *     signal without crowding their tighter top bar.
 *
 * Renders nothing for paid users, expired trials, or legacy users
 * without trial state.
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
  const tooltip = days === 1
    ? (t("trialChipOneDay") || "1 day left in trial")
    : (t("trialChipManyDays") || "{n} days left in trial").replace("{n}", days);

  const dismiss = (e) => {
    e.preventDefault();
    e.stopPropagation();
    localStorage.setItem(DISMISS_KEY, String(Date.now() + 86400000));
    setHidden(true);
  };

  return (
    <div
      className="hidden md:flex fixed bottom-4 left-1/2 -translate-x-1/2 z-40 items-center gap-1"
      role="status"
      aria-label={tooltip}
    >
      <Link
        to="/subscription"
        title={tooltip}
        className={`group inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border shadow-sm transition ${
          urgent
            ? "bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50"
            : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-900 dark:hover:text-white"
        }`}
      >
        <span aria-hidden="true">{urgent ? "🌤️" : "🎁"}</span>
        <span>{days}d</span>
      </Link>
      <button
        type="button"
        onClick={dismiss}
        title={t("hideForToday") || "Hide for today"}
        aria-label={t("hideForToday") || "Hide for today"}
        className="w-5 h-5 inline-flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
