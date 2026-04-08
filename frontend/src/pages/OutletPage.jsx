import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }

export default function OutletPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("compare");

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get("/outlets/intelligence");
      setData(res.data);
    } catch { setError("Could not load outlet data"); }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🏪</div>
          <p className="text-gray-500 dark:text-gray-400">Analyzing outlets...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <div className="text-4xl mb-4">🏪</div>
        <p className="text-red-500">{error}</p>
        <button onClick={fetchData} className="mt-4 text-sm text-green-600 hover:underline">Try again</button>
      </div>
    );
  }

  const {
    outlet_count, outlets, total_revenue, total_transactions,
    imbalances, transfer_suggestions, best_performer, weakest_performer, alerts,
  } = data;

  // Chart data for comparison
  const compareData = outlets.map(o => ({
    name: o.name?.length > 12 ? o.name.slice(0, 12) + "..." : o.name,
    Revenue: o.revenue,
    Expenses: o.expenses,
    Profit: o.profit,
  }));

  const tabs = [
    { key: "compare", label: "Compare" },
    { key: "inventory", label: `Stock Balance (${imbalances?.length || 0})` },
    { key: "transfers", label: `Transfers (${transfer_suggestions?.length || 0})` },
  ];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">
          🏪 {t("crossOutlet") || "Cross-Outlet Intelligence"}
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
      {outlet_count > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Outlets" value={outlet_count} color="text-blue-600" />
          <MetricCard label="Total Revenue" value={fmt(total_revenue)} color="text-green-600" currency={currency} />
          <MetricCard label="Total Transactions" value={fmt(total_transactions)} color="text-purple-600" />
          <MetricCard
            label="Imbalances"
            value={imbalances?.length || 0}
            sub={transfer_suggestions?.length ? `${transfer_suggestions.length} transfers` : null}
            color={imbalances?.length > 0 ? "text-orange-600" : "text-green-600"}
          />
        </div>
      )}

      {/* ─── BEST vs WEAKEST ─── */}
      {best_performer && weakest_performer && outlet_count >= 2 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-gradient-to-br from-green-600 to-emerald-700 rounded-2xl p-5 text-white shadow-lg">
            <p className="text-sm opacity-80">🏆 Top Performer</p>
            <p className="text-xl font-bold mt-1">{best_performer.name}</p>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <p className="text-xs opacity-70">Revenue</p>
                <p className="text-lg font-bold">{fmt(best_performer.revenue)} {currency}</p>
              </div>
              <div>
                <p className="text-xs opacity-70">Margin</p>
                <p className="text-lg font-bold">{best_performer.margin}%</p>
              </div>
            </div>
          </div>
          <div className="bg-gradient-to-br from-orange-500 to-red-600 rounded-2xl p-5 text-white shadow-lg">
            <p className="text-sm opacity-80">📈 Needs Attention</p>
            <p className="text-xl font-bold mt-1">{weakest_performer.name}</p>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <p className="text-xs opacity-70">Revenue</p>
                <p className="text-lg font-bold">{fmt(weakest_performer.revenue)} {currency}</p>
              </div>
              <div>
                <p className="text-xs opacity-70">Margin</p>
                <p className="text-lg font-bold">{weakest_performer.margin}%</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── TABS ─── */}
      {outlet_count > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition ${
                tab === t.key
                  ? "bg-green-600 text-white"
                  : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ─── COMPARE TAB ─── */}
      {tab === "compare" && outlet_count > 0 && (
        <div className="space-y-6">
          {/* Revenue comparison chart */}
          {compareData.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
              <h2 className="font-bold text-gray-800 dark:text-white mb-4">📊 Performance Comparison</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={compareData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v) => fmt(v)} />
                    <Tooltip
                      formatter={(val) => [`${fmt(val)} ${currency}`, undefined]}
                      contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}
                    />
                    <Legend />
                    <Bar dataKey="Revenue" fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Profit" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Outlet detail table */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
            <h2 className="font-bold text-gray-800 dark:text-white mb-4">📋 Outlet Details</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b dark:border-gray-700">
                    <th className="text-left py-2 px-2">Outlet</th>
                    <th className="text-right py-2 px-2">Revenue</th>
                    <th className="text-right py-2 px-2">Txns</th>
                    <th className="text-right py-2 px-2">Avg Ticket</th>
                    <th className="text-right py-2 px-2">Expenses</th>
                    <th className="text-right py-2 px-2">Margin</th>
                    <th className="text-right py-2 px-2">Inventory</th>
                  </tr>
                </thead>
                <tbody>
                  {outlets.map((o, i) => (
                    <tr key={o.id} className="border-b dark:border-gray-700/50">
                      <td className="py-3 px-2">
                        <div className="flex items-center gap-2">
                          {i === 0 && outlets.length > 1 && <span className="text-yellow-500">🏆</span>}
                          <span className="font-medium text-gray-700 dark:text-gray-300">{o.name}</span>
                          <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 px-1.5 py-0.5 rounded">{o.role}</span>
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right font-bold text-green-600">{fmt(o.revenue)} {currency}</td>
                      <td className="py-3 px-2 text-right text-gray-500">{o.transactions}</td>
                      <td className="py-3 px-2 text-right text-gray-500">{fmt(o.avg_ticket)}</td>
                      <td className="py-3 px-2 text-right text-red-500">{fmt(o.expenses)}</td>
                      <td className="py-3 px-2 text-right">
                        <span className={`text-xs px-2 py-1 rounded-full font-bold ${
                          o.margin >= 30 ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" :
                          o.margin >= 10 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" :
                          "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                        }`}>
                          {o.margin}%
                        </span>
                      </td>
                      <td className="py-3 px-2 text-right text-gray-500">
                        {o.inventory_items} items
                        {o.low_stock_count > 0 && (
                          <span className="text-xs text-red-500 ml-1">({o.low_stock_count} low)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ─── INVENTORY TAB ─── */}
      {tab === "inventory" && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">⚖️ Stock Imbalances</h2>
          {imbalances?.length > 0 ? (
            <div className="space-y-3">
              {imbalances.map((item, i) => (
                <div key={i} className="bg-orange-50 dark:bg-orange-900/10 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-bold text-gray-800 dark:text-gray-200">{item.item} ({item.unit})</p>
                    <span className="text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 px-2 py-1 rounded-full">
                      Avg: {item.avg_qty}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
                      <p className="text-xs text-gray-500">Surplus</p>
                      <p className="text-sm font-medium text-green-600">{item.surplus_outlet}</p>
                      <p className="text-lg font-bold text-green-700">{item.surplus_qty}</p>
                    </div>
                    <div className="bg-white dark:bg-gray-800 rounded-lg p-3">
                      <p className="text-xs text-gray-500">Deficit</p>
                      <p className="text-sm font-medium text-red-600">{item.deficit_outlet}</p>
                      <p className="text-lg font-bold text-red-700">{item.deficit_qty}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="text-4xl mb-2">✅</div>
              <p className="text-gray-600 dark:text-gray-300">No stock imbalances detected.</p>
              <p className="text-sm text-gray-400">Inventory is evenly distributed.</p>
            </div>
          )}
        </div>
      )}

      {/* ─── TRANSFERS TAB ─── */}
      {tab === "transfers" && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">🔄 Suggested Transfers</h2>
          {transfer_suggestions?.length > 0 ? (
            <div className="space-y-3">
              {transfer_suggestions.map((t, i) => (
                <div key={i} className="flex items-center gap-4 bg-blue-50 dark:bg-blue-900/10 rounded-xl px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-800 dark:text-gray-200">{t.item}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                      <span className="font-medium text-red-600">{t.from_outlet}</span>
                      <span>→</span>
                      <span className="font-medium text-green-600">{t.to_outlet}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-blue-600">{t.suggested_qty} {t.unit}</p>
                    <p className="text-xs text-gray-400">{fmt(t.value)} {currency} value</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="text-4xl mb-2">✅</div>
              <p className="text-gray-600 dark:text-gray-300">No transfers needed right now.</p>
            </div>
          )}
        </div>
      )}

      {/* ─── EMPTY STATE ─── */}
      {outlet_count === 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 shadow-sm text-center">
          <div className="text-5xl mb-3">🏪</div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-2">No outlets to compare</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            Cross-outlet intelligence needs at least 2 team members. Add staff in the Team page to enable comparisons.
          </p>
          <a href="/team" className="inline-block mt-4 px-6 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition">
            Go to Team
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
