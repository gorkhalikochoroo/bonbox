/**
 * BusinessHealthCard — REFACTORED from the original 90/100 circular gauge.
 *
 * The original `HealthScore` (defined inline in DashboardPage.jsx as a
 * 5-factor radar gauge with a colored ring) was vanity decoration — it
 * gave the owner a number with no falsifiable claim and no next action.
 * Per the v2 spec, this version is the Stripe / Pleo pattern: one number
 * worth of signal, one verdict that can be wrong (so it can be right),
 * and one next-best-action link.
 *
 * Three states:
 *   • Healthy  — margin > 25% AND profit_30d > 0 AND zero overdue invoices.
 *     "Margin held above 30% this week. Watch: expense-to-revenue ratio
 *      drifted +4%."
 *   • Watch    — exactly 1 metric off.
 *     "Expenses up 18% vs last week. Review category breakdown."
 *   • Action   — 2+ metrics off.
 *     "Margin slipped below 20%. Net profit negative this week. Review costs."
 *
 * Doctrine compliance:
 *   • Surface stays neutral (bg-white / dark:bg-gray-900, rounded-xl,
 *     gray-200 border). NO tinted backgrounds even for the Action state.
 *   • Status dot is the ONLY colored pixel — bg-emerald-500 / bg-amber-500
 *     / bg-red-500. Doctrine-allowed (status dots are signal).
 *   • Single horizontal row: dot · verdict label · body sentence · action.
 *   • No gauge, no factor bars, no big number.
 *
 * Data:
 *   • Reads from `ctx.summary`: profit_margin, profit_30d, month_revenue,
 *     month_expenses, week_expense_delta_pct, today_revenue,
 *     overdue_invoice_count. Falls back gracefully when fields are missing.
 *   • The verdict logic is deterministic — no AI in the hot path. Same
 *     inputs always produce the same output (testable).
 */
import React from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";

/**
 * deriveVerdict — pure function so the verdict logic is testable.
 *
 * @param summary  ctx.summary
 * @param overdueCount ctx.invoices?.overdueCount
 * @returns { verdict: "healthy" | "watch" | "action", reasons: string[] }
 */
export function deriveVerdict(summary = {}, overdueCount = 0) {
  const margin = Number(summary?.profit_margin ?? 0);
  const profit30d = Number(
    summary?.profit_30d ??
      (Number(summary?.month_revenue ?? 0) - Number(summary?.month_expenses ?? 0)),
  );
  const weekExpenseDelta = Number(summary?.week_expense_delta_pct ?? 0);
  const expenseRatio =
    Number(summary?.month_revenue ?? 0) > 0
      ? Number(summary?.month_expenses ?? 0) /
        Number(summary?.month_revenue ?? 1)
      : 0;

  // Honesty guard: revenue but ZERO expenses logged means margin (~100%)
  // and "profit = revenue" are not real signals — there are no costs to
  // weigh. Don't claim "healthy / margin above X%"; surface the one thing
  // that makes the read real (mirrors the ProfitLossCard zero-expense fix).
  const monthRevenue = Number(summary?.month_revenue ?? 0);
  const monthExpenses = Number(summary?.month_expenses ?? 0);
  if (monthRevenue > 0 && monthExpenses === 0) {
    return { verdict: "incomplete", reasons: ["noExpenses"], margin, profit30d, weekExpenseDelta };
  }

  const offMetrics = [];
  if (margin < 20) offMetrics.push("marginLow");
  if (profit30d < 0) offMetrics.push("profitNegative");
  if (weekExpenseDelta > 15) offMetrics.push("expensesUp");
  if (overdueCount > 0) offMetrics.push("overdueInvoices");
  if (expenseRatio > 0.85 && Number(summary?.month_revenue ?? 0) > 0) {
    offMetrics.push("expenseRatioHigh");
  }

  let verdict;
  if (offMetrics.length >= 2) verdict = "action";
  else if (offMetrics.length === 1) verdict = "watch";
  else verdict = "healthy";

  return { verdict, reasons: offMetrics, margin, profit30d, weekExpenseDelta };
}

// Status dot color per verdict — the ONLY colored pixels on the card.
const DOT_CLASS = {
  healthy: "bg-emerald-500",
  watch: "bg-amber-500",
  action: "bg-red-500",
  // 'incomplete' = missing cost data, not a warning → neutral gray dot.
  incomplete: "bg-gray-400",
};

export default function BusinessHealthCard({ ctx = {}, className = "" }) {
  const { t } = useLanguage();
  const overdueCount = ctx?.invoices?.overdueCount ?? 0;
  const { verdict, reasons, margin, profit30d, weekExpenseDelta } =
    deriveVerdict(ctx?.summary || {}, overdueCount);

  // Verdict-specific copy. Numbers are interpolated via t() vars so
  // translators don't have to chop strings into pieces.
  let verdictLabel;
  let body;
  let actionLabel;
  let actionHref;

  if (verdict === "incomplete") {
    // No costs logged → can't claim a margin/health read honestly. Point
    // the owner at the one tap that makes it real (mirrors ProfitLossCard).
    verdictLabel = t("dashIncompleteVerdict", "Add expenses");
    body = t(
      "dashIncompleteBody",
      "No expenses logged this month — add them to see your real profit and a true health read.",
    );
    actionLabel = t("dashIncompleteAction", "Add expenses");
    actionHref = "/expenses";
  } else if (verdict === "healthy") {
    verdictLabel = t("dashHealthyVerdict", "Healthy");
    body = t(
      "dashHealthyBody",
      "Margin held above {margin}% this week. Watch: expense-to-revenue ratio drifted {delta}%.",
    )
      .replace("{margin}", Math.round(margin).toString())
      .replace(
        "{delta}",
        (weekExpenseDelta > 0 ? "+" : "") + Math.round(weekExpenseDelta).toString(),
      );
    actionLabel = t("dashHealthyAction", "View trend");
    actionHref = "/reports";
  } else if (verdict === "watch") {
    verdictLabel = t("dashWatchVerdict", "Watch");
    if (reasons.includes("expensesUp")) {
      body = t(
        "dashWatchExpenses",
        "Expenses up {delta}% vs last week. Review category breakdown.",
      ).replace(
        "{delta}",
        (weekExpenseDelta > 0 ? "+" : "") + Math.round(weekExpenseDelta).toString(),
      );
      actionLabel = t("dashWatchExpensesAction", "Review categories");
      actionHref = "/reports?tab=expenses";
    } else if (reasons.includes("marginLow")) {
      body = t(
        "dashWatchMargin",
        "Margin slipped to {margin}%. Check P&L breakdown.",
      ).replace("{margin}", Math.round(margin).toString());
      actionLabel = t("dashWatchMarginAction", "Open P&L");
      actionHref = "/reports?tab=pl";
    } else if (reasons.includes("profitNegative")) {
      body = t(
        "dashWatchProfit",
        "30-day profit is negative. Open Reports to drill in.",
      );
      actionLabel = t("dashWatchProfitAction", "Open Reports");
      actionHref = "/reports";
    } else {
      // overdueInvoices or expenseRatioHigh
      body = t(
        "dashWatchGeneric",
        "One health metric is off this week. Open Reports to investigate.",
      );
      actionLabel = t("dashWatchGenericAction", "Open Reports");
      actionHref = "/reports";
    }
  } else {
    // verdict === "action"
    verdictLabel = t("dashActionVerdict", "Action needed");
    // Combine the two most impactful reasons into the body. We pick
    // margin + profit first because they're the falsifiable claims.
    const parts = [];
    if (reasons.includes("marginLow")) {
      parts.push(
        t("dashActionMarginPart", "Margin slipped below {margin}%.").replace(
          "{margin}",
          Math.round(Math.max(margin, 0)).toString(),
        ),
      );
    }
    if (reasons.includes("profitNegative")) {
      parts.push(t("dashActionProfitPart", "Net profit negative this week."));
    }
    if (parts.length === 0 && reasons.includes("expensesUp")) {
      parts.push(
        t("dashActionExpensesPart", "Expenses up {delta}% vs last week.").replace(
          "{delta}",
          (weekExpenseDelta > 0 ? "+" : "") + Math.round(weekExpenseDelta).toString(),
        ),
      );
    }
    body = parts.join(" ") + " " + t("dashActionTrailing", "Review costs.");
    actionLabel = t("dashActionLink", "Review costs");
    actionHref = "/reports?tab=expenses";
  }

  // Suppress when we have effectively no signal. The renderIf in
  // dashboardCardSets.js already gates on `summary.totalSales >= 10`,
  // but this is the L2 guard inside the component.
  if (
    profit30d === 0 &&
    margin === 0 &&
    (ctx?.summary?.totalSales ?? 0) < 10
  ) {
    return null;
  }

  return (
    <div
      className={
        "rounded-xl border border-gray-200 dark:border-gray-800 " +
        "bg-white dark:bg-gray-900 p-5 sm:p-6 " +
        (className || "")
      }
      data-zone="2"
      data-component="BusinessHealthCard"
      data-verdict={verdict}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t("dashHealthTitle", "Business health")}
        </h3>
        <Link
          to={actionHref}
          className={
            "shrink-0 inline-flex items-center gap-1 text-xs font-medium " +
            "text-gray-700 dark:text-gray-300 " +
            "hover:text-gray-900 dark:hover:text-gray-100 " +
            "transition-colors focus-visible:outline-none " +
            "focus-visible:ring-2 focus-visible:ring-gray-900 " +
            "dark:focus-visible:ring-gray-100 " +
            "focus-visible:ring-offset-1 rounded px-1 py-0.5"
          }
        >
          {actionLabel}
          <span aria-hidden="true">→</span>
        </Link>
      </div>

      <div className="flex items-start gap-3">
        <span
          className={
            "shrink-0 inline-block w-2.5 h-2.5 rounded-full mt-1.5 " +
            (DOT_CLASS[verdict] || DOT_CLASS.healthy)
          }
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {verdictLabel}
          </p>
          <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5 leading-relaxed">
            {body}
          </p>
        </div>
      </div>
    </div>
  );
}
