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
import { formatKr } from "../../utils/currency";

// da-DK readable date with weekday — "lør 14. jun" / en "Sat 14 Jun". Lets a
// non-technical owner tell a Saturday spike from a Monday dip. Intl supplies
// the localized names; the ISO parse stays local-tz safe with the fallback.
function fmtTrendDate(label, lang) {
  try {
    const d = new Date(label + "T00:00:00");
    const locale = lang === "da" ? "da-DK" : "en-GB";
    return d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  } catch {
    return label;
  }
}

export default function RevenueTrendChart({ ctx = {}, days = 30 }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const data = (ctx?.dailyRevData || []).slice(-days);

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

  // Sparse-data honesty: with 1-2 real points recharts would still draw a
  // connecting segment that reads as a confident "trend" implying a pattern
  // that does not exist. Below 3 points, show the real values as rows + an
  // honest "not enough days" notice instead of a misleading 2-point line.
  if (data.length < 3) {
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
        <ul className="space-y-1.5 mt-2">
          {data.map((d) => (
            <li
              key={d.date}
              className="flex items-center justify-between text-sm text-gray-700 dark:text-gray-300 tabular-nums"
            >
              <span className="text-gray-500 dark:text-gray-400">{fmtTrendDate(d.date, lang)}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {formatKr(d.amount, { decimals: 0 })}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {t("revenueTrendSparse", "Not enough days yet to show a trend — keep logging sales.")}
        </p>
      </div>
    );
  }

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
          {t("avgShort", "Avg")}: {formatKr(avg, { decimals: 0 })}
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
            width={48}
            tickCount={4}
            tickFormatter={(v) =>
              v >= 1000
                ? `${new Intl.NumberFormat("da-DK").format(Math.round(v / 1000))} ${t("thousandShort", "t.kr.")}`
                : new Intl.NumberFormat("da-DK").format(Number(v))
            }
          />
          <Tooltip
            cursor={{ stroke: "#9CA3AF", strokeWidth: 1, strokeDasharray: "3 3" }}
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #E5E7EB",
              borderRadius: 8,
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              padding: "8px 12px",
            }}
            labelStyle={{
              color: "#6B7280",            // gray-500 — muted secondary
              fontSize: 11,
              fontWeight: 500,
              marginBottom: 2,
              textTransform: "none",
            }}
            itemStyle={{
              color: "#111827",            // gray-900 — primary value
              fontSize: 13,
              fontWeight: 600,
              padding: 0,
            }}
            formatter={(v) => [
              formatKr(v, { decimals: 0 }),
              t("revenue", "Revenue"),
            ]}
            labelFormatter={(label) => fmtTrendDate(label, lang)}
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
