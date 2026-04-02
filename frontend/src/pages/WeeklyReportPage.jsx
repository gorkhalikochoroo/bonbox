import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

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

  const currency = report.currency || "DKK";
  const changeColor = report.change_pct >= 0 ? "text-green-600" : "text-red-600";
  const changeArrow = report.change_pct >= 0 ? "↑" : "↓";

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-6" id="weekly-report">
        <div className="text-center mb-6">
          <p className="text-sm text-gray-400 dark:text-gray-500 uppercase tracking-wide">{t("weeklySalesReport")}</p>
          <h1 className="text-xl font-bold text-gray-800 dark:text-white mt-1">
            {report.business_name || t("myBusiness")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {report.week_start} &mdash; {report.week_end}
          </p>
        </div>

        <div className="text-center mb-6">
          <p className="text-4xl font-extrabold text-gray-900 dark:text-white">
            {report.total_revenue.toLocaleString()} {currency}
          </p>
          <p className={`text-sm font-semibold mt-1 ${changeColor}`}>
            {changeArrow} {Math.abs(report.change_pct)}% {t("vsLastWeek")}
            <span className="text-gray-400 font-normal ml-2">
              ({report.prev_week_total.toLocaleString()} {currency})
            </span>
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("dailyAvg")}</p>
            <p className="text-lg font-bold text-gray-800 dark:text-white">{report.daily_avg.toLocaleString()}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("daysRecorded")}</p>
            <p className="text-lg font-bold text-gray-800 dark:text-white">{report.days_recorded}/7</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("bestDay")}</p>
            <p className="text-lg font-bold text-green-600">{report.best_day ? report.best_day.day : "—"}</p>
          </div>
        </div>

        {report.daily_breakdown.length > 0 && (
          <div className="mb-4">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={report.daily_breakdown}>
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} width={60} tickFormatter={(v) => v.toLocaleString()} />
                <Tooltip formatter={(v) => [`${v.toLocaleString()} ${currency}`, t("revenue")]} />
                <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
                  {report.daily_breakdown.map((entry, i) => (
                    <Cell key={i} fill={report.best_day && entry.date === report.best_day.date ? "#22c55e" : "#3b82f6"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

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
              {report.daily_breakdown.map((d) => (
                <tr key={d.date} className="border-t border-gray-50 dark:border-gray-700">
                  <td className="py-2 text-gray-700 dark:text-gray-300 font-medium">{d.day}</td>
                  <td className="py-2 text-gray-500 dark:text-gray-400">{d.date}</td>
                  <td className="py-2 text-right font-semibold text-gray-800 dark:text-white">
                    {d.amount.toLocaleString()} {currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(report.best_day || report.worst_day) && (
          <div className="flex gap-3 mt-4">
            {report.best_day && (
              <div className="flex-1 bg-green-50 dark:bg-green-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-green-600 dark:text-green-400 font-medium">{t("bestDay")}</p>
                <p className="text-sm font-bold text-green-700 dark:text-green-300">
                  {report.best_day.day} — {report.best_day.amount.toLocaleString()} {currency}
                </p>
              </div>
            )}
            {report.worst_day && (
              <div className="flex-1 bg-orange-50 dark:bg-orange-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-orange-600 dark:text-orange-400 font-medium">{t("slowestDay")}</p>
                <p className="text-sm font-bold text-orange-700 dark:text-orange-300">
                  {report.worst_day.day} — {report.worst_day.amount.toLocaleString()} {currency}
                </p>
              </div>
            )}
          </div>
        )}

        <p className="text-center text-xs text-gray-300 dark:text-gray-600 mt-6">
          BonBox
        </p>
      </div>
    </div>
  );
}
