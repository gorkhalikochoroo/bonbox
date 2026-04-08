import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }

const STATUS_CONFIG = {
  expired:  { label: "Expired",   color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" },
  critical: { label: "< 7 days",  color: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  warning:  { label: "7-14 days", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" },
  upcoming: { label: "14-30 days",color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
};

export default function ExpiryPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get("/expiry/forecast");
      setData(res.data);
    } catch { setError("Could not load expiry data"); }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">📦</div>
          <p className="text-gray-500 dark:text-gray-400">Checking expiry dates...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <div className="text-4xl mb-4">📦</div>
        <p className="text-red-500">{error}</p>
        <button onClick={fetchData} className="mt-4 text-sm text-green-600 hover:underline">Try again</button>
      </div>
    );
  }

  const {
    expired_items, expiring_soon, expiring_moderate, expiring_later,
    total_at_risk_value, total_tracked_items, missing_expiry,
    waste_summary, waste_trend, recommendations, alerts,
  } = data;

  const allExpiring = [
    ...expired_items.map(i => ({ ...i, _section: "expired" })),
    ...expiring_soon.map(i => ({ ...i, _section: "critical" })),
    ...expiring_moderate.map(i => ({ ...i, _section: "warning" })),
    ...expiring_later.map(i => ({ ...i, _section: "upcoming" })),
  ];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">
          📦 {t("expiryForecasting") || "Expiry Forecasting"}
        </h1>
      </FadeIn>

      {/* ─── ALERTS ─── */}
      {alerts?.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => (
            <div key={i} className={`p-4 rounded-2xl border-l-4 ${
              alert.severity === "warning" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20" :
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

      {/* ─── KEY METRICS ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Tracked Items" value={total_tracked_items} color="text-blue-600" />
        <MetricCard
          label="At-Risk Value"
          value={fmt(total_at_risk_value)}
          color="text-red-600"
          currency={currency}
        />
        <MetricCard
          label="Expired Items"
          value={expired_items.length}
          sub="Remove now"
          color={expired_items.length > 0 ? "text-red-600" : "text-green-600"}
        />
        <MetricCard
          label="Expiring < 7d"
          value={expiring_soon.length}
          sub="Act fast"
          color={expiring_soon.length > 0 ? "text-orange-600" : "text-green-600"}
        />
      </div>

      {/* ─── RECOMMENDATIONS ─── */}
      {recommendations?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">💡 Recommendations</h2>
          <div className="space-y-3">
            {recommendations.map((rec, i) => (
              <div key={i} className={`flex items-start gap-3 p-3 rounded-xl ${
                rec.priority === "high" ? "bg-red-50 dark:bg-red-900/10" :
                rec.priority === "medium" ? "bg-yellow-50 dark:bg-yellow-900/10" :
                "bg-gray-50 dark:bg-gray-700/30"
              }`}>
                <span className="text-2xl">{rec.icon}</span>
                <div>
                  <p className="text-sm font-bold text-gray-800 dark:text-gray-200">{rec.title}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">{rec.detail}</p>
                </div>
                {rec.priority === "high" && (
                  <span className="text-xs bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 px-2 py-1 rounded-full font-medium ml-auto whitespace-nowrap">
                    Urgent
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── EXPIRY TIMELINE ─── */}
      {allExpiring.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">📅 Expiry Timeline</h2>
          {/* Mobile: card layout */}
          <div className="space-y-2 md:hidden">
            {allExpiring.map((item, i) => {
              const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.upcoming;
              return (
                <div key={i} className={`p-3 rounded-xl border ${
                  item.status === "expired" ? "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800" :
                  item.status === "critical" ? "bg-orange-50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-800" :
                  "bg-white dark:bg-gray-700/30 border-gray-200 dark:border-gray-700"
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate flex-1">{item.name}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ml-2 ${cfg.color}`}>{cfg.label}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{item.quantity} {item.unit} | {item.category}</span>
                    <span className={`font-bold ${
                      item.days_left < 0 ? "text-red-600" : item.days_left <= 7 ? "text-orange-600" : "text-gray-600"
                    }`}>
                      {item.days_left < 0 ? `${Math.abs(item.days_left)}d overdue` : `${item.days_left}d left`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs mt-1">
                    <span className="text-gray-400">Expires: {item.expiry_date}</span>
                    <span className="text-gray-600 dark:text-gray-400 font-medium">{fmt(item.cost_at_risk)} {currency}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Desktop: table layout */}
          <div className="overflow-x-auto hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b dark:border-gray-700">
                  <th className="text-left py-2 px-2">Item</th>
                  <th className="text-left py-2 px-2">Category</th>
                  <th className="text-right py-2 px-2">Stock</th>
                  <th className="text-left py-2 px-2">Expiry</th>
                  <th className="text-right py-2 px-2">Days Left</th>
                  <th className="text-right py-2 px-2">Cost at Risk</th>
                  <th className="text-center py-2 px-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {allExpiring.map((item, i) => {
                  const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.upcoming;
                  return (
                    <tr key={i} className={`border-b dark:border-gray-700/50 ${
                      item.status === "expired" ? "bg-red-50/50 dark:bg-red-900/10" :
                      item.status === "critical" ? "bg-orange-50/50 dark:bg-orange-900/10" : ""
                    }`}>
                      <td className="py-3 px-2 font-medium text-gray-700 dark:text-gray-300">{item.name}</td>
                      <td className="py-3 px-2 text-gray-500 text-xs">{item.category}</td>
                      <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">{item.quantity} {item.unit}</td>
                      <td className="py-3 px-2 text-gray-500">{item.expiry_date}</td>
                      <td className={`py-3 px-2 text-right font-bold ${
                        item.days_left < 0 ? "text-red-600" : item.days_left <= 7 ? "text-orange-600" : "text-gray-600 dark:text-gray-400"
                      }`}>
                        {item.days_left < 0 ? `${Math.abs(item.days_left)}d overdue` : `${item.days_left}d`}
                      </td>
                      <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">{fmt(item.cost_at_risk)} {currency}</td>
                      <td className="py-3 px-2 text-center">
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${cfg.color}`}>
                          {cfg.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── WASTE HISTORY ─── */}
      {waste_summary?.top_items?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-1">🗑️ Waste History (90 days)</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Total waste: {fmt(waste_summary.total_cost_90d)} {currency} | Expired: {fmt(waste_summary.expired_cost_90d)} {currency}
          </p>

          {/* Waste trend chart */}
          {waste_trend?.length > 0 && (
            <div className="h-48 mb-6">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={waste_trend}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => fmt(v)} />
                  <Tooltip
                    formatter={(val) => [`${fmt(val)} ${currency}`, "Waste Cost"]}
                    contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}
                  />
                  <Bar dataKey="cost" fill="#ef4444" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top wasted items */}
          <div className="space-y-2">
            {waste_summary.top_items.map((item, i) => (
              <div key={i} className="flex items-center justify-between bg-red-50 dark:bg-red-900/10 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{item.name}</p>
                  <p className="text-xs text-gray-500">{item.count} times wasted</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-red-600">{fmt(item.total_cost)} {currency}</p>
                  <p className="text-xs text-gray-400">total loss</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── MISSING EXPIRY DATES ─── */}
      {missing_expiry?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-blue-500">
          <h2 className="font-bold text-gray-800 dark:text-white mb-2">📝 Missing Expiry Dates</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            These perishable items need expiry dates for better forecasting.
          </p>
          <div className="flex flex-wrap gap-2">
            {missing_expiry.map((item, i) => (
              <span key={i} className="bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-xs px-3 py-1.5 rounded-full">
                {item.name} ({item.quantity} {item.unit})
              </span>
            ))}
          </div>
          <a href="/inventory" className="text-sm text-green-600 dark:text-green-400 hover:underline mt-3 inline-block">
            Go to Inventory to add expiry dates →
          </a>
        </div>
      )}

      {/* ─── EMPTY STATE ─── */}
      {allExpiring.length === 0 && !waste_summary?.top_items?.length && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 shadow-sm text-center">
          <div className="text-5xl mb-3">📦</div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-2">No expiry data yet</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            Add expiry dates to your inventory items to unlock expiry forecasting, waste prediction, and order recommendations.
          </p>
          <a href="/inventory" className="inline-block mt-4 px-6 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition">
            Go to Inventory
          </a>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, color, currency }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>
        {value} {currency && <span className="text-sm font-normal opacity-60">{currency}</span>}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
