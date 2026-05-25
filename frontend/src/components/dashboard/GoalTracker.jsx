/**
 * GoalTracker — daily + monthly revenue progress bars.
 *
 * Renders only when `ctx.goalsSet` is true (the renderIf gate is in
 * dashboardCardSets.js). When goals aren't set, this card simply doesn't
 * render — no empty-state nudge spam.
 *
 * Doctrine compliance:
 *   • Neutral surface (rounded-xl, gray-200 border, bg-white)
 *   • Progress bar: gray-700 fill when in-progress, emerald-500 when
 *     goal hit. Hitting the goal IS the success signal, so emerald
 *     earns its keep.
 *   • Percent label: emerald-600 when hit, gray-500 otherwise.
 *   • No editable input — goal management lives on /profile to keep
 *     the dashboard read-only.
 */
import React from "react";
import { useLanguage } from "../../hooks/useLanguage";

function Bar({ label, current, goal, currency }) {
  const pct = goal > 0 ? Math.min(Math.round((current / goal) * 100), 100) : 0;
  const hit = pct >= 100;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {label}
        </p>
        <p
          className={`text-xs font-semibold tabular-nums ${
            hit
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-gray-500 dark:text-gray-400"
          }`}
        >
          {pct}%
        </p>
      </div>
      <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            hit ? "bg-emerald-500" : "bg-gray-700 dark:bg-gray-300"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 tabular-nums">
        {Math.round(current).toLocaleString()} /{" "}
        {Math.round(goal).toLocaleString()} {currency}
      </p>
    </div>
  );
}

export default function GoalTracker({ ctx = {} }) {
  const { t } = useLanguage();
  const summary = ctx?.summary || {};
  const profile = ctx?.profile || {};
  const currency = ctx?.currency || "DKK";
  const todayRev = Number(summary.today_revenue || summary.todayRevenue || 0);
  const monthRev = Number(summary.month_revenue || summary.monthRevenue || 0);
  const dailyGoal = Number(
    profile.daily_revenue_goal || ctx?.user?.daily_goal || 0,
  );
  const monthlyGoal = Number(
    profile.monthly_revenue_goal || ctx?.user?.monthly_goal || 0,
  );

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 space-y-4"
      data-zone="2"
      data-component="GoalTracker"
    >
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t("goals", "Goals")}
      </h3>
      {dailyGoal > 0 && (
        <Bar
          label={t("dailyGoal", "Daily goal")}
          current={todayRev}
          goal={dailyGoal}
          currency={currency}
        />
      )}
      {monthlyGoal > 0 && (
        <Bar
          label={t("monthlyGoal", "Monthly goal")}
          current={monthRev}
          goal={monthlyGoal}
          currency={currency}
        />
      )}
    </div>
  );
}
