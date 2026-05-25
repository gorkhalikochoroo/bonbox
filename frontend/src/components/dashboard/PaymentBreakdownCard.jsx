/**
 * PaymentBreakdownCard — compact 3-row by-method summary.
 *
 * Zone 2 card for the transactional-daily archetype when ≥2 distinct
 * payment methods are seen. Café operators need this daily — "did the
 * card terminal go down at 14:00?" is a real reconciliation question.
 *
 * The full per-method chart with stacked bar lives in /reports. Here
 * we show the top 3 methods with amount + percent — enough signal to
 * notice if today's mix looks wrong.
 *
 * Doctrine compliance:
 *   • Neutral surface (rounded-xl, gray-200 border, bg-white)
 *   • No category color swatches in this compact view (the deep
 *     report keeps them — they're labels there, not chrome here)
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";

export default function PaymentBreakdownCard({ ctx = {}, compact = true }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const breakdown = ctx?.paymentBreakdown || [];
  const currency = ctx?.currency || "DKK";

  if (!breakdown || breakdown.length === 0) return null;

  const total = breakdown.reduce((s, p) => s + (p.amount || 0), 0);
  const sorted = [...breakdown].sort(
    (a, b) => (b.amount || 0) - (a.amount || 0),
  );
  const top = compact ? sorted.slice(0, 3) : sorted;

  return (
    <div
      onClick={() => navigate("/sales")}
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
      data-zone="2"
      data-component="PaymentBreakdownCard"
    >
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t("paymentMethods", "Payment methods")}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3">
        {t("thisMonth", "This month")}
      </p>
      <div className="space-y-2">
        {top.map((p) => {
          const pct = total > 0 ? Math.round((p.amount / total) * 100) : 0;
          const label =
            (p.method || "").charAt(0).toUpperCase() + (p.method || "").slice(1);
          return (
            <div
              key={p.method}
              className="flex items-center justify-between gap-3"
            >
              <span className="text-sm text-gray-700 dark:text-gray-200 flex-1 truncate">
                {label}
              </span>
              <span className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {Math.round(p.amount).toLocaleString()} {currency}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400 w-10 text-right tabular-nums">
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
