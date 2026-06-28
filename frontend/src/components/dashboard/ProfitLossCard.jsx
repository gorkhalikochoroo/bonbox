/**
 * ProfitLossCard — compact Revenue / Expenses / Net row. Full P&L
 * breakdown lives in /reports; this is the 3-line Zone 2 summary.
 *
 * Doctrine compliance:
 *   • Neutral surface (rounded-xl, gray-200 border, bg-white).
 *   • Revenue uses emerald-600 (money-in moment per doctrine).
 *   • Expenses use red-600 (money-out signal).
 *   • Net profit color = emerald (positive) or red (negative). The
 *     status of "this month is profitable" is the data, so coloring
 *     it carries information.
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";
import { formatKr } from "../../utils/currency";

export default function ProfitLossCard({ ctx = {} }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const summary = ctx?.summary || {};
  const revenue = Number(summary.month_revenue || 0);
  const expenses = Number(summary.month_expenses || 0);
  const profit = Number(summary.month_profit ?? revenue - expenses);
  const margin = Number(
    summary.profit_margin ||
      (revenue > 0 ? Math.round((profit / revenue) * 100) : 0),
  );
  const isProfit = profit >= 0;

  return (
    <div
      onClick={() => navigate("/reports")}
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
      data-zone="2"
      data-component="ProfitLossCard"
    >
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t("profitAndLoss", "Profit & loss")}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-4">
        {t("thisMonth", "This month")}
      </p>

      <div className="space-y-2 border-b border-gray-200 dark:border-gray-800 pb-3 mb-3">
        <div className="flex justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {t("revenue", "Revenue")}
          </span>
          <span className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            +{formatKr(revenue, { decimals: 0 })}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {t("expenses", "Expenses")}
          </span>
          <span className="text-sm font-semibold tabular-nums text-red-600 dark:text-red-400">
            −{formatKr(expenses, { decimals: 0 })}
          </span>
        </div>
      </div>

      {expenses > 0 ? (
        <div className="flex justify-between items-baseline">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            {t("netProfit", "Net profit")}
          </span>
          <div className="text-right">
            <p
              className={`text-xl font-bold tabular-nums ${
                isProfit
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {formatKr(profit, { decimals: 0, sign: true })}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
              {t("marginColonPct", "Margin: {pct}%").replace("{pct}", String(margin))}
            </p>
          </div>
        </div>
      ) : (
        // Honesty guard: with zero expenses logged, "Net profit = revenue"
        // and "Margin 100%" are a lie — revenue is gross (incl. MOMS owed)
        // and no costs are in yet. Don't fake profit; invite the one tap
        // that makes it real.
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            navigate("/expenses");
          }}
          className="block w-full text-left -mx-1 px-1 py-0.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
        >
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {t("plNoExpensesTitle", "No expenses logged this month")}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("plNoExpensesCta", "Add expenses to see your real profit →")}
          </p>
        </button>
      )}
    </div>
  );
}
