import { useState, useEffect } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

function fmt(n) {
  if (n == null) return "—";
  return Math.round(n).toLocaleString();
}

function CustomTooltip({ active, payload, currency }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-white dark:bg-gray-800 p-3 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 text-sm">
      <p className="font-bold text-gray-800 dark:text-white">{d.day}, {d.date}</p>
      <div className="mt-1 space-y-0.5">
        <p className={`font-semibold ${d.balance >= 0 ? "text-green-600" : "text-red-600"}`}>
          Balance: {fmt(d.balance)} {currency}
        </p>
        {d.revenue > 0 && <p className="text-blue-500">+ Revenue: {fmt(d.revenue)} {currency}</p>}
        {d.expenses > 0 && <p className="text-orange-500">- Expenses: {fmt(d.expenses)} {currency}</p>}
        {d.recurring?.length > 0 && (
          <p className="text-purple-500 text-xs">📅 {d.recurring.join(", ")}</p>
        )}
      </div>
    </div>
  );
}

export default function CashFlowPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchForecast();
  }, []);

  const fetchForecast = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/cashflow/forecast");
      setData(res.data);
    } catch (e) {
      setError("Could not load cash flow forecast");
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">💰</div>
          <p className="text-gray-500 dark:text-gray-400">Calculating cash flow...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <div className="text-4xl mb-4">📊</div>
        <p className="text-red-500">{error || "No data available"}</p>
        <button onClick={fetchForecast} className="mt-4 text-sm text-green-600 hover:underline">Try again</button>
      </div>
    );
  }

  const { projection, alerts, current_balance, safety_threshold, lowest_point,
    danger_days, receivables, total_receivable, recurring_expenses,
    daily_expense_avg, has_data } = data;

  // Chart data — abbreviate dates
  const chartData = projection.map(p => ({
    ...p,
    label: p.date.slice(5), // "MM-DD"
    safetyLine: safety_threshold,
  }));

  const minBalance = Math.min(...projection.map(p => p.balance), 0);
  const maxBalance = Math.max(...projection.map(p => p.balance));
  const yMin = Math.floor(minBalance / 1000) * 1000 - 1000;
  const yMax = Math.ceil(maxBalance / 1000) * 1000 + 1000;

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <FadeIn><h1 className="text-2xl font-bold text-gray-800 dark:text-white">💰 Cash Flow Prediction</h1></FadeIn>
        <button onClick={fetchForecast} className="text-sm text-green-600 dark:text-green-400 hover:underline">
          {t("refresh")}
        </button>
      </div>

      {/* ─── KEY METRICS ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Current Balance</p>
          <p className={`text-2xl font-bold mt-1 ${current_balance >= 0 ? "text-green-600" : "text-red-600"}`}>
            {fmt(current_balance)}
          </p>
          <p className="text-xs text-gray-400">{currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Lowest Point</p>
          <p className={`text-2xl font-bold mt-1 ${lowest_point.balance >= safety_threshold ? "text-green-600" : lowest_point.balance >= 0 ? "text-yellow-600" : "text-red-600"}`}>
            {fmt(lowest_point.balance)}
          </p>
          <p className="text-xs text-gray-400">{lowest_point.date}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Danger Days</p>
          <p className={`text-2xl font-bold mt-1 ${danger_days === 0 ? "text-green-600" : danger_days <= 5 ? "text-yellow-600" : "text-red-600"}`}>
            {danger_days}
          </p>
          <p className="text-xs text-gray-400">of 30</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Receivables</p>
          <p className="text-2xl font-bold mt-1 text-blue-600">{fmt(total_receivable)}</p>
          <p className="text-xs text-gray-400">{receivables.length} customers</p>
        </div>
      </div>

      {/* ─── ALERTS ─── */}
      {alerts.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => (
            <div key={i} className={`p-4 rounded-2xl border-l-4 ${
              alert.severity === "critical" ? "border-red-600 bg-red-50 dark:bg-red-900/20" :
              alert.severity === "warning" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20" :
              alert.severity === "medium" ? "border-orange-500 bg-orange-50 dark:bg-orange-900/20" :
              alert.severity === "positive" ? "border-green-500 bg-green-50 dark:bg-green-900/20" :
              "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
            }`}>
              <div className="flex items-start gap-3">
                <span className="text-2xl">{alert.icon}</span>
                <div className="flex-1">
                  <p className="text-sm font-bold text-gray-800 dark:text-gray-200">{alert.title}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{alert.detail}</p>
                  {alert.action && (
                    <p className="text-xs text-green-700 dark:text-green-400 mt-2 font-medium">💡 {alert.action}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── 30-DAY CHART ─── */}
      {has_data && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-1">30-Day Cash Flow Projection</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Based on your recent sales patterns and recurring expenses
          </p>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="balanceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="dangerGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" opacity={0.5} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  interval={4}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                  domain={[yMin, yMax]}
                  width={45}
                />
                <Tooltip content={<CustomTooltip currency={currency} />} />
                <ReferenceLine
                  y={safety_threshold}
                  stroke="#f59e0b"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  label={{ value: "Safety Buffer", fill: "#f59e0b", fontSize: 10, position: "insideTopRight" }}
                />
                <ReferenceLine y={0} stroke="#ef4444" strokeWidth={1} />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#balanceGrad)"
                  dot={false}
                  activeDot={{ r: 5, fill: "#10b981" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-green-500 inline-block rounded" /> Balance</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-yellow-500 inline-block rounded border-dashed" /> Safety threshold ({fmt(safety_threshold)} {currency})</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-500 inline-block rounded" /> Zero line</span>
          </div>
        </div>
      )}

      {/* ─── DAILY BREAKDOWN TABLE ─── */}
      {has_data && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">Daily Breakdown</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b dark:border-gray-700">
                  <th className="text-left py-2 px-2">Date</th>
                  <th className="text-left py-2 px-2">Day</th>
                  <th className="text-right py-2 px-2">Revenue</th>
                  <th className="text-right py-2 px-2">Expenses</th>
                  <th className="text-right py-2 px-2">Balance</th>
                  <th className="text-left py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {projection.slice(0, 14).map((p, i) => (
                  <tr key={i} className={`border-b dark:border-gray-700/50 ${
                    p.is_danger ? "bg-red-50/50 dark:bg-red-900/10" : ""
                  }`}>
                    <td className="py-2 px-2 text-gray-700 dark:text-gray-300">{p.date.slice(5)}</td>
                    <td className="py-2 px-2 text-gray-500 dark:text-gray-400">{p.day.slice(0, 3)}</td>
                    <td className="py-2 px-2 text-right text-green-600">
                      {p.revenue > 0 ? `+${fmt(p.revenue)}` : "—"}
                    </td>
                    <td className="py-2 px-2 text-right text-orange-500">
                      {p.expenses > 0 ? `-${fmt(p.expenses)}` : "—"}
                    </td>
                    <td className={`py-2 px-2 text-right font-semibold ${
                      p.balance < 0 ? "text-red-600" : p.is_danger ? "text-yellow-600" : "text-gray-800 dark:text-white"
                    }`}>
                      {fmt(p.balance)}
                    </td>
                    <td className="py-2 px-2">
                      {p.is_danger && <span className="text-xs bg-red-100 dark:bg-red-900/30 text-red-600 px-2 py-0.5 rounded-full">⚠️</span>}
                      {p.recurring?.length > 0 && <span className="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-600 px-2 py-0.5 rounded-full ml-1">📅</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {projection.length > 14 && (
            <p className="text-xs text-gray-400 text-center mt-3">Showing first 14 days — full 30-day view on chart above</p>
          )}
        </div>
      )}

      {/* ─── TOP RECEIVABLES ─── */}
      {receivables.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-1 flex items-center gap-2">
            <span>💰</span> Outstanding Receivables
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Collecting these would boost your cash position by {fmt(total_receivable)} {currency}
          </p>
          <div className="space-y-2">
            {receivables.map((r, i) => {
              const pct = total_receivable > 0 ? (r.outstanding / total_receivable) * 100 : 0;
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-sm font-bold text-blue-600">
                    {i + 1}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{r.customer_name}</span>
                      <span className="text-sm font-bold text-blue-600">{fmt(r.outstanding)} {currency}</span>
                    </div>
                    <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full mt-1 overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── RECURRING EXPENSES ─── */}
      {recurring_expenses.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4 flex items-center gap-2">
            <span>📅</span> Upcoming Recurring Expenses
          </h2>
          <div className="space-y-2">
            {recurring_expenses.map((re, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{re.description}</p>
                  <p className="text-xs text-gray-500">{re.category} • Due {re.next_due}</p>
                </div>
                <span className="text-sm font-bold text-orange-500">-{fmt(re.amount)} {currency}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No data prompt */}
      {!has_data && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 shadow-sm text-center">
          <div className="text-5xl mb-4">📊</div>
          <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-2">Build Your Prediction Model</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            Log sales for at least 2 weeks to unlock accurate 30-day cash flow predictions.
          </p>
          <div className="flex gap-3 justify-center">
            <a href="/sales" className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition">
              Log Sales
            </a>
            <a href="/cashbook" className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-600 transition">
              Cash Book
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
