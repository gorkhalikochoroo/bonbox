import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import ReceiptCapture from "../components/ReceiptCapture";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  BarChart, Bar,
} from "recharts";

const COLORS = ["#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899"];

export default function DashboardPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [summary, setSummary] = useState(null);
  const [monthlyData, setMonthlyData] = useState(null);
  const [lastSale, setLastSale] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [quickMsg, setQuickMsg] = useState("");
  const [forecast, setForecast] = useState(null);

  const fetchAll = () => {
    api.get("/dashboard/summary").then((res) => setSummary(res.data));
    const now = new Date();
    api
      .get("/reports/monthly", { params: { month: now.getMonth() + 1, year: now.getFullYear() } })
      .then((res) => setMonthlyData(res.data));
    api.get("/sales/latest").then((res) => setLastSale(res.data)).catch(() => {});
    api.get("/sales/receipts").then((res) => setReceipts(res.data)).catch(() => {});
    api.get("/reports/forecast", { params: { days: 7 } }).then((res) => setForecast(res.data)).catch(() => {});
  };

  useEffect(() => { fetchAll(); }, []);

  const downloadPdf = async () => {
    const now = new Date();
    const res = await api.get("/reports/monthly/pdf", {
      params: { month: now.getMonth() + 1, year: now.getFullYear() },
      responseType: "blob",
    });
    const url = window.URL.createObjectURL(new Blob([res.data]));
    const a = document.createElement("a");
    a.href = url;
    a.download = `report_${now.getFullYear()}_${now.getMonth() + 1}.pdf`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const repeatYesterday = async () => {
    try {
      await api.post("/sales/repeat-yesterday");
      setQuickMsg(t("yesterdayCopied"));
      fetchAll();
      setTimeout(() => setQuickMsg(""), 3000);
    } catch {
      setQuickMsg(t("noYesterdaySale"));
      setTimeout(() => setQuickMsg(""), 3000);
    }
  };

  if (!summary) {
    return <div className="p-8 text-center text-gray-500">{t("loadingDashboard")}</div>;
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header + Quick Actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">
            {t("welcome")}, {user?.business_name}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {new Date().toLocaleDateString("en-DK", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>

        {/* One-tap actions */}
        <div className="flex flex-wrap gap-2">
          <ReceiptCapture onSaleCreated={fetchAll} />
          <button
            onClick={repeatYesterday}
            className="px-4 py-2.5 bg-green-50 text-green-700 border border-green-200 rounded-lg text-sm font-medium hover:bg-green-100 transition"
          >
            {t("repeatYesterday")}
            {lastSale && (
              <span className="ml-1 text-green-500">({parseFloat(lastSale.amount).toLocaleString()} DKK)</span>
            )}
          </button>
          <button
            onClick={downloadPdf}
            className="px-4 py-2.5 bg-purple-50 text-purple-700 border border-purple-200 rounded-lg text-sm font-medium hover:bg-purple-100 transition"
          >
            {t("downloadPdf")}
          </button>
        </div>
      </div>

      {/* Quick message toast */}
      {quickMsg && (
        <div className="bg-blue-50 text-blue-700 px-4 py-2.5 rounded-lg text-sm font-medium">
          {quickMsg}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title={t("todayRevenue")}
          value={`${summary.today_revenue.toLocaleString()} DKK`}
          change={summary.today_revenue_change}
          changeLabel={t("vsYesterday")}
        />
        <KpiCard
          title={t("monthlyProfit")}
          value={`${summary.month_profit.toLocaleString()} DKK`}
          subtitle={`${summary.profit_margin}% ${t("margin")}`}
        />
        <KpiCard
          title={t("topExpense")}
          value={summary.top_expense_category || t("none")}
          subtitle={summary.top_expense_amount > 0 ? `${summary.top_expense_amount.toLocaleString()} DKK` : ""}
        />
        <KpiCard
          title={t("inventoryAlerts")}
          value={summary.inventory_alerts}
          alert={summary.inventory_alerts > 0}
        />
      </div>

      {/* Daily Goal Progress */}
      <DailyGoal revenue={summary.today_revenue} />

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue Trend */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-lg font-semibold text-gray-700 mb-4">{t("revenueTrend")}</h2>
          {monthlyData?.daily_revenue?.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={monthlyData.daily_revenue}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="amount" stroke="#3B82F6" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-400 text-center py-12">{t("noRevenueData")}</p>
          )}
        </div>

        {/* Expense Breakdown */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-lg font-semibold text-gray-700 mb-4">{t("expenseBreakdown")}</h2>
          {monthlyData?.expense_breakdown?.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={monthlyData.expense_breakdown}
                  dataKey="amount"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={({ category }) => category}
                >
                  {monthlyData.expense_breakdown.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-400 text-center py-12">{t("noExpenseData")}</p>
          )}
        </div>
      </div>

      {/* Revenue Forecast */}
      {forecast && forecast.forecast?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200">
                {t("revenueForecastTitle")}
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {t("nextDays")} &bull; {t("forecastConfidence")}: {forecast.confidence}%
                &bull; {forecast.trend_direction === "up" ? "📈" : forecast.trend_direction === "down" ? "📉" : "📊"}{" "}
                {forecast.trend_direction === "up" ? t("trendUp") : forecast.trend_direction === "down" ? t("trendDown") : t("trendStable")}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-500">{t("predictedTotal")}</p>
              <p className="text-xl font-bold text-blue-600">{forecast.total_predicted?.toLocaleString()} DKK</p>
              <p className="text-xs text-gray-400">{t("avgDaily")}: {forecast.avg_daily_predicted?.toLocaleString()} DKK</p>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={forecast.forecast}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toLocaleString()} />
              <Tooltip
                formatter={(v) => [`${v.toLocaleString()} DKK`, t("predicted")]}
                labelFormatter={(label) => label}
              />
              <Bar dataKey="predicted_revenue" radius={[6, 6, 0, 0]}>
                {forecast.forecast.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.trend === "up" ? "#22c55e" : entry.trend === "down" ? "#ef4444" : "#3b82f6"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          <div className="grid grid-cols-7 gap-1 mt-3">
            {forecast.forecast.map((f, i) => (
              <div key={i} className="text-center">
                <p className="text-xs font-medium text-gray-600 dark:text-gray-300">{f.day.slice(0, 3)}</p>
                <p className="text-sm font-bold text-gray-800 dark:text-white">{f.predicted_revenue.toLocaleString()}</p>
                <p className="text-xs text-gray-400">{f.confidence}%</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Receipt History */}
      {receipts.length > 0 && (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-4">{t("recentReceipts")}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {receipts.map((r) => (
              <div key={r.id} className="group relative">
                <img
                  src={r.receipt_photo?.startsWith('http') ? r.receipt_photo : `${import.meta.env.VITE_API_URL?.replace('/api', '') || 'http://localhost:8000'}/${r.receipt_photo}`}
                  alt={`Receipt ${r.date}`}
                  className="w-full h-28 object-cover rounded-lg border border-gray-200 dark:border-gray-600"
                />
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs px-2 py-1 rounded-b-lg">
                  <p className="font-semibold">{r.amount.toLocaleString()} DKK</p>
                  <p className="text-gray-300">{r.date}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DailyGoal({ revenue }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [goal, setGoal] = useState(user?.daily_goal || 0);
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState("");

  const pct = goal > 0 ? Math.min(Math.round((revenue / goal) * 100), 100) : 0;
  const hit = pct >= 100;

  const saveGoal = async () => {
    const val = parseFloat(inputVal);
    if (!val || val <= 0) return;
    await api.patch("/auth/daily-goal", null, { params: { goal: val } });
    setGoal(val);
    setEditing(false);
  };

  if (goal <= 0 && !editing) {
    return (
      <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{t("setDailyGoal")}</p>
          <p className="text-xs text-gray-400 mt-0.5">{t("trackProgress")}</p>
        </div>
        <button
          onClick={() => { setEditing(true); setInputVal(""); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
        >
          {t("setGoal")}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {t("dailyGoal")} {hit && <span className="text-green-600 ml-1">{t("reached")}</span>}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {revenue.toLocaleString()} / {goal.toLocaleString()} DKK ({pct}%)
          </p>
        </div>
        {editing ? (
          <div className="flex gap-2">
            <input
              type="number"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder={String(goal)}
              className="w-28 px-3 py-1.5 border border-gray-200 rounded-lg text-sm"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && saveGoal()}
            />
            <button onClick={saveGoal} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium">{t("save")}</button>
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-gray-500 text-xs">{t("cancel")}</button>
          </div>
        ) : (
          <button onClick={() => { setEditing(true); setInputVal(String(goal)); }}
            className="text-xs text-blue-600 hover:underline">{t("editGoal")}</button>
        )}
      </div>
      {/* Progress bar */}
      <div className="w-full h-4 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${hit ? "bg-green-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function KpiCard({ title, value, change, changeLabel, subtitle, alert }) {
  return (
    <div className={`bg-white p-5 rounded-xl shadow-sm border ${alert ? "border-red-300" : "border-gray-100"}`}>
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-bold text-gray-800 mt-1">{value}</p>
      {change !== undefined && (
        <p className={`text-sm mt-1 ${change >= 0 ? "text-green-600" : "text-red-600"}`}>
          {change >= 0 ? "+" : ""}{change}% {changeLabel}
        </p>
      )}
      {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}
