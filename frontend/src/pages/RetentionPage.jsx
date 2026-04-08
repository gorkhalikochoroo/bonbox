import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from "recharts";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }

const STATUS_CONFIG = {
  active:  { label: "Active",   color: "#10b981", bg: "bg-green-100 dark:bg-green-900/30", text: "text-green-700 dark:text-green-300" },
  at_risk: { label: "At Risk",  color: "#f59e0b", bg: "bg-yellow-100 dark:bg-yellow-900/30", text: "text-yellow-700 dark:text-yellow-300" },
  churned: { label: "Churned",  color: "#ef4444", bg: "bg-red-100 dark:bg-red-900/30", text: "text-red-700 dark:text-red-300" },
};

export default function RetentionPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("overview");

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get("/retention/insights");
      setData(res.data);
    } catch { setError("Could not load retention data"); }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🤝</div>
          <p className="text-gray-500 dark:text-gray-400">Analyzing customer retention...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <div className="text-4xl mb-4">🤝</div>
        <p className="text-red-500">{error}</p>
        <button onClick={fetchData} className="mt-4 text-sm text-green-600 hover:underline">Try again</button>
      </div>
    );
  }

  const {
    total_customers, active_customers, at_risk_customers, churned_customers,
    retention_rate, churn_rate, avg_clv, total_clv,
    txn_trend_pct, rev_trend_pct, current_month_txns, prev_month_txns,
    top_customers, at_risk_list, churned_list, monthly_cohort, alerts,
  } = data;

  const pieData = [
    { name: "Active", value: active_customers, color: "#10b981" },
    { name: "At Risk", value: at_risk_customers, color: "#f59e0b" },
    { name: "Churned", value: churned_customers, color: "#ef4444" },
  ].filter(d => d.value > 0);

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "customers", label: `Top Customers (${top_customers?.length || 0})` },
    { key: "at_risk", label: `At Risk (${at_risk_list?.length || 0})` },
  ];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">
          🤝 {t("customerRetention") || "Customer Retention"}
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
        <MetricCard label="Total Customers" value={total_customers} color="text-blue-600" />
        <MetricCard
          label="Retention Rate"
          value={`${retention_rate}%`}
          sub={`${active_customers} active`}
          color={retention_rate >= 60 ? "text-green-600" : "text-red-600"}
        />
        <MetricCard
          label="Churn Rate"
          value={`${churn_rate}%`}
          sub={`${churned_customers} lost`}
          color={churn_rate <= 20 ? "text-green-600" : "text-red-600"}
        />
        <MetricCard
          label="Avg CLV"
          value={fmt(avg_clv)}
          sub={`Total: ${fmt(total_clv)}`}
          color="text-purple-600"
          currency={currency}
        />
      </div>

      {/* ─── TRANSACTION TRENDS ─── */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-gray-500">Transaction Trend</p>
          <p className={`text-2xl font-bold mt-1 ${txn_trend_pct >= 0 ? "text-green-600" : "text-red-600"}`}>
            {txn_trend_pct >= 0 ? "+" : ""}{txn_trend_pct}%
          </p>
          <p className="text-xs text-gray-400 mt-1">{current_month_txns} vs {prev_month_txns} last month</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-gray-500">Revenue Trend</p>
          <p className={`text-2xl font-bold mt-1 ${rev_trend_pct >= 0 ? "text-green-600" : "text-red-600"}`}>
            {rev_trend_pct >= 0 ? "+" : ""}{rev_trend_pct}%
          </p>
          <p className="text-xs text-gray-400 mt-1">vs previous 30 days</p>
        </div>
      </div>

      {/* ─── TABS ─── */}
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

      {/* ─── OVERVIEW TAB ─── */}
      {tab === "overview" && (
        <div className="space-y-6">
          {/* Status pie chart */}
          {pieData.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
              <h2 className="font-bold text-gray-800 dark:text-white mb-4">📊 Customer Status</h2>
              <div className="flex flex-col md:flex-row items-center gap-6">
                <div className="h-48 w-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={40}
                        outerRadius={70}
                        dataKey="value"
                        paddingAngle={3}
                      >
                        {pieData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(val) => [val, "Customers"]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-3 flex-1">
                  {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
                    const count = key === "active" ? active_customers : key === "at_risk" ? at_risk_customers : churned_customers;
                    const pctVal = total_customers ? Math.round(count / total_customers * 100) : 0;
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: cfg.color }} />
                        <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">{cfg.label}</span>
                        <span className="text-sm font-bold text-gray-800 dark:text-white">{count}</span>
                        <span className="text-xs text-gray-400 w-10 text-right">{pctVal}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Monthly cohort chart */}
          {monthly_cohort?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
              <h2 className="font-bold text-gray-800 dark:text-white mb-4">📅 Monthly Customer Activity</h2>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthly_cohort}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} />
                    <Tooltip contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }} />
                    <Legend />
                    <Bar dataKey="returning" stackId="a" fill="#10b981" name="Returning" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="new" stackId="a" fill="#3b82f6" name="New" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── TOP CUSTOMERS TAB ─── */}
      {tab === "customers" && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">👑 Top Customers by CLV</h2>
          {top_customers?.length > 0 ? (
            <div className="space-y-3">
              {top_customers.map((c, i) => (
                <CustomerCard key={c.id} customer={c} rank={i + 1} currency={currency} />
              ))}
            </div>
          ) : (
            <EmptyState message="No customer data yet. Add customers in Khata to start tracking." />
          )}
        </div>
      )}

      {/* ─── AT RISK TAB ─── */}
      {tab === "at_risk" && (
        <div className="space-y-6">
          {at_risk_list?.length > 0 ? (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-yellow-500">
              <h2 className="font-bold text-gray-800 dark:text-white mb-2">⚠️ At Risk (30-60 days inactive)</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">These customers may be slipping away. Reach out soon!</p>
              <div className="space-y-3">
                {at_risk_list.map((c) => (
                  <CustomerCard key={c.id} customer={c} currency={currency} showUrgency />
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm text-center">
              <div className="text-4xl mb-2">🎉</div>
              <p className="text-gray-600 dark:text-gray-300 font-medium">No at-risk customers!</p>
              <p className="text-sm text-gray-400">All your customers are active.</p>
            </div>
          )}

          {churned_list?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-red-500">
              <h2 className="font-bold text-gray-800 dark:text-white mb-2">🚨 Churned (60+ days inactive)</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Haven't returned in over 60 days. Win-back campaign recommended.</p>
              <div className="space-y-3">
                {churned_list.map((c) => (
                  <CustomerCard key={c.id} customer={c} currency={currency} showUrgency />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CustomerCard({ customer: c, rank, currency, showUrgency }) {
  const cfg = STATUS_CONFIG[c.status];
  return (
    <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl px-4 py-3">
      <div className="flex items-center gap-3">
        {rank && (
          <span className={`text-lg font-bold ${rank <= 3 ? "text-yellow-500" : "text-gray-400"}`}>
            #{rank}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{c.name}</p>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${cfg.bg} ${cfg.text}`}>
              {cfg.label}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {c.txn_count} visits | Last: {c.last_visit}
            {showUrgency && <span className="text-red-500 font-medium"> ({c.days_since_last}d ago)</span>}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4 mt-2 pl-0 sm:pl-8">
        <div>
          <p className="text-sm font-bold text-purple-600">{fmt(c.clv)} {currency}</p>
          <p className="text-[10px] text-gray-400">CLV</p>
        </div>
        <div>
          <p className="text-sm font-bold text-gray-700 dark:text-gray-300">{fmt(c.monthly_avg)} {currency}</p>
          <p className="text-[10px] text-gray-400">/month</p>
        </div>
      </div>
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

function EmptyState({ message }) {
  return (
    <div className="text-center py-8">
      <div className="text-4xl mb-2">📊</div>
      <p className="text-sm text-gray-500 dark:text-gray-400">{message}</p>
    </div>
  );
}
