/**
 * RevenueTrendChart — Zone 2 hero chart. Days window (7/30/90) driven
 * by tier features via the `days` prop the card-set config supplies.
 *
 * Doctrine compliance:
 *   • Neutral surface (rounded-xl, gray-200 border, bg-white)
 *   • Single chart series in gray-700 (no rainbow palette, no gradient)
 *   • Average reference shown as text, not a colored line
 *   • Clickable card → /reports for the deep view
 *
 * Phase B note: extracted from the inline RevenueTrendChart that used
 * to live in DashboardPage. The previous version filled the area with
 * an emerald gradient (`#22C55E`, `linearGradient`) which violated the
 * gradients-in-app-chrome ban. This version uses a flat gray-700 stroke
 * with a near-transparent gray fill — same readability, no decoration.
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useLanguage } from "../../hooks/useLanguage";

export default function RevenueTrendChart({ ctx = {}, days = 30 }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const data = (ctx?.dailyRevData || []).slice(-days);
  const currency = ctx?.currency || "DKK";

  if (!data || data.length === 0) {
    return (
      <div
        onClick={() => navigate("/reports")}
        className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
        data-zone="2"
        data-component="RevenueTrendChart"
      >
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t("revenueTrend", "Revenue trend")}
        </h3>
        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {t("revenueTrendEmpty", "Log your first sale to start the chart.")}
        </p>
      </div>
    );
  }

  const avg = Math.round(
    data.reduce((s, d) => s + (d.amount || 0), 0) / data.length,
  );

  return (
    <div
      onClick={() => navigate("/reports")}
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
      data-zone="2"
      data-component="RevenueTrendChart"
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("revenueTrend", "Revenue trend")}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("revenueTrendWindow", "Last {n} days").replace("{n}", String(days))}
          </p>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
          {t("avgShort", "Avg")}: {avg.toLocaleString()} {currency}
        </p>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(156,163,175,0.15)"
          />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "#9CA3AF" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#9CA3AF" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip
            contentStyle={{
              background: "rgba(17,24,39,0.95)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 10,
              color: "#f1f1f1",
              fontSize: 13,
            }}
            formatter={(v) => [
              `${v.toLocaleString()} ${currency}`,
              t("revenue", "Revenue"),
            ]}
          />
          <Area
            type="monotone"
            dataKey="amount"
            stroke="#374151"
            strokeWidth={2}
            fill="rgba(55,65,81,0.08)"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
