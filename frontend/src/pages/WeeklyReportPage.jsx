// Slice-4 polish: the weekly summary now reads as an authentic on-screen
// "statement" —
//   • money routes through formatKr (da-DK "15.000,00 kr.", never "DKK")
//   • the denominator contradiction is fixed at the source: the average is
//     labelled "pr. åben dag" and sits beside a separate "Åbne dage" tile, so
//     total ÷ open-days reconciles (was total÷open-days shown next to "/7")
//   • DK-locked "Uge N" ISO-week label + a readable da-DK date range
//   • status-only bars (gray-900 normal, emerald best day — no blue), Lucide
//     arrows (no unicode ↑/↓), amber (not orange) slowest-day chip
//   • fail-soft guards + honest "week in progress" / "no prior week" states
//     so a 2-day partial week never reads as a complete weekly statement.
import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { ArrowUp, ArrowDown } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { formatKr } from "../utils/currency";
import { formatDateClear, formatDateClearFull, isoWeek } from "../utils/dateFormat";

export default function WeeklyReportPage() {
  const { t } = useLanguage();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/sales/weekly-report")
      .then((res) => setReport(res.data))
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 text-center text-gray-500">{t("loadingReport")}</div>;
  if (!report) return <div className="p-8 text-center text-gray-400">{t("noSalesData")}</div>;

  // Fail-soft: a partial / empty payload must not throw.
  const breakdown = Array.isArray(report.daily_breakdown) ? report.daily_breakdown : [];
  const openDays = report.open_days ?? report.days_recorded ?? breakdown.length;
  const avgPerOpenDay = report.avg_per_open_day ?? report.daily_avg ?? 0;
  const changePct = Number(report.change_pct) || 0;
  // has_comparison distinguishes a real flat 0% from "no prior week yet".
  const hasComparison = report.has_comparison ?? (Number(report.prev_week_total) || 0) > 0;
  // A week is "in progress" until all 7 days could plausibly be recorded — we
  // surface that rather than presenting a 2-day partial as a full statement.
  const weekInProgress = openDays > 0 && openDays < 7;

  const weekNo = isoWeek(report.week_start);
  const ArrowIcon = changePct >= 0 ? ArrowUp : ArrowDown;
  const changeColor = changePct >= 0 ? "text-emerald-600" : "text-red-600";

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6" id="weekly-report">
        {/* ─── Statement header ─── */}
        <div className="text-center mb-6">
          <p className="text-sm text-gray-400 dark:text-gray-500 uppercase tracking-wide">{t("weeklySalesReport")}</p>
          <h1 className="text-xl font-bold text-gray-800 dark:text-white mt-1">
            {report.business_name || t("myBusiness")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {weekNo != null && (
              <span className="font-semibold text-gray-700 dark:text-gray-300">{t("weekLabel")} {weekNo}</span>
            )}
            {weekNo != null && " · "}
            {formatDateClearFull(report.week_start)} &mdash; {formatDateClearFull(report.week_end)}
          </p>
          {weekInProgress && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 font-medium">{t("weekInProgress")}</p>
          )}
        </div>

        {/* ─── Headline total with a ruled line above (statement hierarchy) ─── */}
        <div className="text-center mb-6">
          <div className="border-t border-gray-200 dark:border-gray-700 w-24 mx-auto mb-3" />
          <p className="text-4xl font-extrabold text-gray-900 dark:text-white tabular-nums">
            {formatKr(report.total_revenue ?? 0)}
          </p>
          {hasComparison ? (
            <p className={`text-sm font-semibold mt-1 inline-flex items-center gap-1 ${changeColor}`}>
              <ArrowIcon size={14} strokeWidth={2.5} aria-hidden="true" />
              {Math.abs(changePct)}% {t("vsLastWeek")}
              <span className="text-gray-400 font-normal ml-1 tabular-nums">
                ({formatKr(report.prev_week_total ?? 0, { decimals: 0 })})
              </span>
            </p>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">{t("noComparisonYet")}</p>
          )}
        </div>

        {/* ─── Stat grid — average labelled with its denominator ─── */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("avgPerOpenDay")}</p>
            <p className="text-lg font-bold text-gray-800 dark:text-white tabular-nums">{formatKr(avgPerOpenDay, { decimals: 0 })}</p>
            <p className="text-[10px] text-gray-400">{t("perOpenDay")}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("daysOpen")}</p>
            <p className="text-lg font-bold text-gray-800 dark:text-white tabular-nums">{openDays}/7</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("bestDay")}</p>
            <p className="text-lg font-bold text-emerald-600">{report.best_day ? report.best_day.day : "—"}</p>
          </div>
        </div>

        {/* ─── Chart — gray-900 bars, emerald best day (no blue) ─── */}
        {breakdown.length > 0 && (
          <div className="mb-4">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={breakdown}>
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  width={60}
                  tickFormatter={(v) => formatKr(v, { decimals: 0 })}
                  className="tabular-nums"
                />
                <Tooltip formatter={(v) => [formatKr(v, { decimals: 0 }), t("revenue")]} />
                <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
                  {breakdown.map((entry, i) => (
                    <Cell key={i} fill={report.best_day && entry.date === report.best_day.date ? "#10b981" : "#111827"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ─── Per-day table — da-DK clear dates ─── */}
        <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 dark:text-gray-400">
                <th className="text-left py-2 font-medium">{t("day")}</th>
                <th className="text-left py-2 font-medium">{t("date")}</th>
                <th className="text-right py-2 font-medium">{t("revenue")}</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((d) => (
                <tr key={d.date} className="border-t border-gray-50 dark:border-gray-700">
                  <td className="py-2 text-gray-700 dark:text-gray-300 font-medium">{d.day}</td>
                  <td className="py-2 text-gray-500 dark:text-gray-400">{formatDateClear(d.date)}</td>
                  <td className="py-2 text-right font-semibold text-gray-800 dark:text-white tabular-nums">
                    {formatKr(d.amount ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ─── Best / slowest footer — amber (not orange) slowest chip ─── */}
        {(report.best_day || report.worst_day) && (
          <div className="flex gap-3 mt-4">
            {report.best_day && (
              <div className="flex-1 bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 text-center">
                <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">{t("bestDay")}</p>
                <p className="text-sm font-bold text-gray-700 dark:text-gray-300 tabular-nums">
                  {report.best_day.day} — {formatKr(report.best_day.amount ?? 0, { decimals: 0 })}
                </p>
              </div>
            )}
            {report.worst_day && (
              <div className="flex-1 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">{t("slowestDay")}</p>
                <p className="text-sm font-bold text-amber-700 dark:text-amber-300 tabular-nums">
                  {report.worst_day.day} — {formatKr(report.worst_day.amount ?? 0, { decimals: 0 })}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ─── Provenance footer — accountant-grade quiet line ─── */}
        <p className="text-center text-xs text-gray-300 dark:text-gray-600 mt-6">
          {weekNo != null ? `${t("weekLabel")} ${weekNo} · ` : ""}{t("weeklyReportProvenance")}
        </p>
      </div>
    </div>
  );
}
