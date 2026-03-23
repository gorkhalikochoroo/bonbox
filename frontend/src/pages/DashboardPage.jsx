import { useState, useEffect, useMemo } from "react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import ReceiptCapture from "../components/ReceiptCapture";
import Onboarding from "../components/Onboarding";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  BarChart, Bar, ReferenceLine,
} from "recharts";
import { displayCurrency } from "../utils/currency";

const COLORS = ["#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16"];

const PERIODS = ["today", "thisWeek", "thisMonth", "last30"];

const PERIOD_LABELS = {
  today: { revenue: "Today's Revenue", profit: "Today's Profit" },
  thisWeek: { revenue: "This Week's Revenue", profit: "This Week's Profit" },
  thisMonth: { revenue: "This Month's Revenue", profit: "This Month's Profit" },
  last30: { revenue: "Last 30 Days Revenue", profit: "Last 30 Days Profit" },
};

function getDateRange(period) {
  const now = new Date();
  const fmt = (d) => d.toISOString().split("T")[0];
  const today = fmt(now);

  switch (period) {
    case "today":
      return { from: today, to: today };
    case "thisWeek": {
      const d = new Date(now);
      const day = d.getDay();
      // Monday-based week: Sunday (0) goes back 6 days, Mon (1) stays, Tue (2) goes back 1, etc.
      d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
      return { from: fmt(d), to: today };
    }
    case "thisMonth": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: fmt(d), to: today };
    }
    case "last30": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { from: fmt(d), to: today };
    }
    default:
      return { from: "", to: "" };
  }
}

export default function DashboardPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const [summary, setSummary] = useState(null);
  const [monthlyData, setMonthlyData] = useState(null);
  const [lastSale, setLastSale] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [quickMsg, setQuickMsg] = useState("");
  const [forecast, setForecast] = useState(null);
  const [period, setPeriod] = useState("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [periodStats, setPeriodStats] = useState(null);
  const [categories, setCategories] = useState([]);
  const [benchmarks, setBenchmarks] = useState(null);

  const dateRange = useMemo(() => {
    if (period === "custom") return { from: customFrom, to: customTo };
    return getDateRange(period);
  }, [period, customFrom, customTo]);

  const fetchAll = () => {
    api.get("/dashboard/summary").then((res) => setSummary(res.data)).catch(() => {});
    const now = new Date();
    api
      .get("/reports/monthly", { params: { month: now.getMonth() + 1, year: now.getFullYear() } })
      .then((res) => setMonthlyData(res.data)).catch(() => {});
    api.get("/sales/latest").then((res) => setLastSale(res.data)).catch(() => {});
    api.get("/sales/receipts").then((res) => setReceipts(res.data)).catch(() => {});
    api.get("/reports/forecast", { params: { days: 7 } }).then((res) => setForecast(res.data)).catch(() => {});
    api.get("/expenses/categories").then((res) => setCategories(res.data)).catch(() => {});
    api.get("/dashboard/benchmarks").then((res) => setBenchmarks(res.data)).catch(() => {});
  };

  // Fetch period-specific data
  useEffect(() => {
    if (!dateRange.from || !dateRange.to) return;
    if (period === "today") { setPeriodStats(null); return; }
    const params = { from: dateRange.from, to: dateRange.to };
    Promise.all([
      api.get("/sales", { params }),
      api.get("/expenses", { params }),
    ]).then(([salesRes, expRes]) => {
      const sales = salesRes.data;
      const expenses = expRes.data;
      const totalRevenue = sales.reduce((s, x) => s + parseFloat(x.amount), 0);
      const totalExpenses = expenses.reduce((s, x) => s + parseFloat(x.amount), 0);

      // Group expenses by category (use description as fallback)
      const catMap = {};
      expenses.forEach((e) => {
        const key = e.category_id || "other";
        catMap[key] = (catMap[key] || 0) + parseFloat(e.amount);
      });
      const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];

      // Resolve top expense category name
      let topExpenseCategoryName = null;
      if (topCat) {
        const catObj = categories.find((c) => c.id === topCat[0]);
        topExpenseCategoryName = catObj ? catObj.name : "Other";
      }

      // Daily revenue for chart
      const dailyMap = {};
      sales.forEach((s) => {
        dailyMap[s.date] = (dailyMap[s.date] || 0) + parseFloat(s.amount);
      });
      // Daily expenses for chart
      const dailyExpMap = {};
      expenses.forEach((e) => {
        dailyExpMap[e.date] = (dailyExpMap[e.date] || 0) + parseFloat(e.amount);
      });
      // Merge into combined daily data
      const allDates = new Set([...Object.keys(dailyMap), ...Object.keys(dailyExpMap)]);
      const dailyRevenue = [...allDates]
        .sort((a, b) => a.localeCompare(b))
        .map((date) => ({
          date,
          amount: Math.round(dailyMap[date] || 0),
          expenses: Math.round(dailyExpMap[date] || 0),
          profit: Math.round((dailyMap[date] || 0) - (dailyExpMap[date] || 0)),
        }));

      setPeriodStats({
        totalRevenue: Math.round(totalRevenue),
        totalExpenses: Math.round(totalExpenses),
        profit: Math.round(totalRevenue - totalExpenses),
        margin: totalRevenue > 0 ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0,
        topExpenseAmount: topCat ? Math.round(topCat[1]) : 0,
        topExpenseCategoryName,
        dailyRevenue,
        salesCount: sales.length,
      });
    }).catch(() => {});
  }, [dateRange.from, dateRange.to, period, categories]);

  useEffect(() => {
    fetchAll();
    const onDataChanged = () => fetchAll();
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

  const downloadPdf = async () => {
    try {
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
    } catch {
      setQuickMsg(t("downloadPdf") + " failed");
      setTimeout(() => setQuickMsg(""), 3000);
    }
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
    return <div className="p-8 text-center text-gray-500 dark:text-gray-400">{t("loadingDashboard")}</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Header + Quick Actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">
            {t("welcome")}, {user?.business_name}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
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
              <span className="ml-1 text-green-500">({parseFloat(lastSale.amount).toLocaleString()} {currency})</span>
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
        <div className="bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-4 py-2.5 rounded-lg text-sm font-medium">
          {quickMsg}
        </div>
      )}

      {/* Period Selector */}
      <div className="flex flex-wrap items-center gap-2">
        {PERIODS.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
              period === p
                ? "bg-blue-600 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
            }`}
          >
            {p === "today" ? "Today" : p === "thisWeek" ? "This Week" : p === "thisMonth" ? "This Month" : "Last 30 Days"}
          </button>
        ))}
      </div>

      {/* Onboarding for new users */}
      <Onboarding summary={summary} />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard
          title={PERIOD_LABELS[period]?.revenue || t("todayRevenue")}
          value={`${(periodStats ? periodStats.totalRevenue : summary.today_revenue).toLocaleString()} ${currency}`}
          change={period === "today" ? summary.today_revenue_change : undefined}
          changeLabel={period === "today" ? t("vsYesterday") : undefined}
          subtitle={periodStats ? `${periodStats.salesCount} sales` : undefined}
        />
        <KpiCard
          title={PERIOD_LABELS[period]?.profit || t("monthlyProfit")}
          value={`${(periodStats ? periodStats.profit : summary.month_profit).toLocaleString()} ${currency}`}
          subtitle={`${periodStats ? periodStats.margin : summary.profit_margin}% ${t("margin")}`}
        />
        <KpiCard
          title={t("topExpense")}
          value={periodStats ? (periodStats.topExpenseCategoryName || t("none")) : (summary.top_expense_category || t("none"))}
          subtitle={periodStats ? (periodStats.topExpenseAmount > 0 ? `${periodStats.topExpenseAmount.toLocaleString()} ${currency}` : "") : (summary.top_expense_amount > 0 ? `${summary.top_expense_amount.toLocaleString()} ${currency}` : "")}
        />
        {summary.khata_receivable > 0 ? (
          <KpiCard
            title="Khata Receivable"
            value={`${summary.khata_receivable.toLocaleString()} ${currency}`}
            alert={true}
            subtitle="Outstanding credit"
          />
        ) : (
          <KpiCard
            title={t("inventoryAlerts")}
            value={summary.inventory_alerts}
            alert={summary.inventory_alerts > 0}
          />
        )}
      </div>

      {/* Daily Goal Progress */}
      <DailyGoal revenue={summary.today_revenue} />

      {/* Business Health Score */}
      <HealthScore summary={summary} monthlyData={monthlyData} />

      {/* Benchmark Cards */}
      {benchmarks && benchmarks.metrics?.length > 0 && (
        <BenchmarkCards benchmarks={benchmarks} currency={currency} />
      )}

      {/* Motivational Stats */}
      <MotivationalStats summary={summary} monthlyData={monthlyData} />

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue Trend + Profit Line */}
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-4">{t("revenueTrend")}</h2>
          {(periodStats?.dailyRevenue?.length > 0 || monthlyData?.daily_revenue?.length > 0) ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={periodStats?.dailyRevenue || monthlyData.daily_revenue}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value, name) => [
                  `${value.toLocaleString()} ${currency}`,
                  name === "amount" ? "Revenue" : name === "profit" ? "Profit" : name,
                ]} />
                <Line type="monotone" dataKey="amount" stroke="#3B82F6" strokeWidth={2} dot={false} name="Revenue" />
                {(periodStats?.dailyRevenue?.[0]?.profit !== undefined) && (
                  <Line type="monotone" dataKey="profit" stroke="#10B981" strokeWidth={2} dot={false} name="Profit" strokeDasharray="5 3" />
                )}
                <ReferenceLine y={0} stroke="#9CA3AF" strokeDasharray="3 3" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-400 dark:text-gray-500 text-center py-12">{t("noRevenueData")}</p>
          )}
        </div>

        {/* Expense Breakdown (Donut) */}
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-4">{t("expenseBreakdown")}</h2>
          {monthlyData?.expense_breakdown?.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={monthlyData.expense_breakdown}
                  dataKey="amount"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={100}
                  paddingAngle={2}
                  label={({ category, percent }) => `${category} (${(percent * 100).toFixed(0)}%)`}
                  labelLine={{ strokeWidth: 1 }}
                >
                  {monthlyData.expense_breakdown.map((entry, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => [`${value.toLocaleString()} ${currency}`, "Amount"]} />
                <Legend
                  formatter={(value) => <span className="text-sm text-gray-600 dark:text-gray-300">{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-400 dark:text-gray-500 text-center py-12">{t("noExpenseData")}</p>
          )}
        </div>
      </div>

      {/* Revenue vs Expenses Comparison */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-4">Revenue vs Expenses</h2>
        {(() => {
          // Build comparison data from period stats (daily) or monthly summary
          const dailyData = periodStats?.dailyRevenue?.filter((d) => d.expenses > 0 || d.amount > 0);
          if (dailyData && dailyData.length > 0) {
            return (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={dailyData} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toLocaleString()} />
                  <Tooltip formatter={(value, name) => [
                    `${value.toLocaleString()} ${currency}`,
                    name === "amount" ? "Revenue" : name === "expenses" ? "Expenses" : name,
                  ]} />
                  <Legend formatter={(value) => value === "amount" ? "Revenue" : value === "expenses" ? "Expenses" : value} />
                  <Bar dataKey="amount" fill="#3B82F6" radius={[4, 4, 0, 0]} name="amount" />
                  <Bar dataKey="expenses" fill="#EF4444" radius={[4, 4, 0, 0]} name="expenses" />
                </BarChart>
              </ResponsiveContainer>
            );
          }
          // Fallback: show monthly totals as a simple comparison
          const compData = [
            { label: "Revenue", value: summary.month_revenue, fill: "#3B82F6" },
            { label: "Expenses", value: summary.month_expenses, fill: "#EF4444" },
            { label: "Profit", value: summary.month_profit, fill: summary.month_profit >= 0 ? "#10B981" : "#F59E0B" },
          ];
          return (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={compData} barSize={60}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toLocaleString()} />
                <Tooltip formatter={(value) => [`${value.toLocaleString()} ${currency}`]} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                  {compData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          );
        })()}
      </div>

      {/* Daily Summary */}
      <DailySummary summary={summary} monthlyData={monthlyData} />

      {/* Revenue Forecast */}
      {forecast && forecast.forecast?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
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
            <div className="text-left sm:text-right">
              <p className="text-sm text-gray-500">{t("predictedTotal")}</p>
              <p className="text-xl font-bold text-blue-600">{forecast.total_predicted?.toLocaleString()} {currency}</p>
              <p className="text-xs text-gray-400">{t("avgDaily")}: {forecast.avg_daily_predicted?.toLocaleString()} {currency}</p>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={forecast.forecast}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toLocaleString()} />
              <Tooltip
                formatter={(v) => [`${v.toLocaleString()} ${currency}`, t("predicted")]}
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

          <div className="grid grid-cols-4 sm:grid-cols-7 gap-1 mt-3">
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
                {r.receipt_photo?.startsWith('http') ? (
                  <img
                    src={r.receipt_photo}
                    alt={`Receipt ${r.date}`}
                    className="w-full h-28 object-cover rounded-lg border border-gray-200 dark:border-gray-600"
                    onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
                  />
                ) : null}
                <div
                  className="w-full h-28 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 flex items-center justify-center"
                  style={{ display: r.receipt_photo?.startsWith('http') ? 'none' : 'flex' }}
                >
                  <span className="text-3xl">🧾</span>
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs px-2 py-1 rounded-b-lg">
                  <p className="font-semibold">{r.amount.toLocaleString()} {currency}</p>
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

function MotivationalStats({ summary, monthlyData }) {
  const { user } = useAuth();
  const dailyGoal = user?.daily_goal || 0;

  const messages = [];

  if (summary.today_revenue > 0) {
    messages.push({ icon: "check", text: "You've logged sales today", color: "text-blue-600 dark:text-blue-400" });
  }
  if (dailyGoal > 0 && summary.today_revenue >= dailyGoal) {
    messages.push({ icon: "star", text: "You've hit your daily goal!", color: "text-yellow-600 dark:text-yellow-400" });
  }
  if (summary.month_profit > 0) {
    messages.push({ icon: "trending", text: "You're profitable this month", color: "text-green-600 dark:text-green-400" });
  }

  // Streak: count consecutive days with sales from daily_revenue (most recent backwards)
  const dailyRevenue = monthlyData?.daily_revenue || [];
  let streak = 0;
  if (dailyRevenue.length > 0) {
    // daily_revenue is sorted by date ascending; walk backwards
    const today = new Date().toISOString().split("T")[0];
    const salesDates = new Set(dailyRevenue.map((d) => d.date));
    const d = new Date();
    // Check from today backwards
    for (let i = 0; i < 60; i++) {
      const key = d.toISOString().split("T")[0];
      if (salesDates.has(key)) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else {
        break;
      }
    }
  }

  if (streak > 1) {
    messages.push({ icon: "fire", text: `${streak}-day sales streak!`, color: "text-orange-600 dark:text-orange-400" });
  }

  if (messages.length === 0) return null;

  const iconMap = {
    check: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    ),
    star: (
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
      </svg>
    ),
    trending: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
      </svg>
    ),
    fire: (
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M12.395 2.553a1 1 0 00-1.45-.385c-.345.23-.614.558-.822.88-.214.33-.403.713-.57 1.116-.334.804-.614 1.768-.84 2.734a31.365 31.365 0 00-.613 3.58 2.64 2.64 0 01-.945-1.067c-.328-.68-.398-1.534-.398-2.654A1 1 0 005.05 6.05 6.981 6.981 0 003 11a7 7 0 1011.95-4.95c-.592-.591-.98-.985-1.348-1.467-.363-.476-.724-1.063-1.207-2.03zM12.12 15.12A3 3 0 017 13s.879.5 2.5.5c0-1 .5-4 1.25-4.5.5 1 .786 1.293 1.371 1.879A2.99 2.99 0 0113 13a2.99 2.99 0 01-.879 2.121z" clipRule="evenodd" />
      </svg>
    ),
  };

  return (
    <div className="flex flex-wrap gap-3">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`inline-flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-sm font-medium ${msg.color}`}
        >
          {iconMap[msg.icon]}
          {msg.text}
        </div>
      ))}
    </div>
  );
}

function DailyGoal({ revenue }) {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const [goal, setGoal] = useState(user?.daily_goal || 0);
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState("");

  const pct = goal > 0 ? Math.min(Math.round((revenue / goal) * 100), 100) : 0;
  const hit = pct >= 100;

  const saveGoal = async () => {
    const val = parseFloat(inputVal);
    if (!val || val <= 0) return;
    try {
      await api.patch("/auth/daily-goal", null, { params: { goal: val } });
      setGoal(val);
      setEditing(false);
    } catch {
      // silently handle save failure
    }
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
            {revenue.toLocaleString()} / {goal.toLocaleString()} {currency} ({pct}%)
          </p>
        </div>
        {editing ? (
          <div className="flex gap-2">
            <input
              type="number"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              placeholder={String(goal)}
              className="w-28 px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
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

function DailySummary({ summary, monthlyData }) {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const dailyRevenue = monthlyData?.daily_revenue || [];

  // Yesterday's data
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().split("T")[0];
  const yesterdayData = dailyRevenue.find(d => d.date === yesterdayKey);

  // This week average
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  const weekDays = dailyRevenue.filter(d => d.date >= weekStart.toISOString().split("T")[0]);
  const weekAvg = weekDays.length > 0 ? Math.round(weekDays.reduce((s, d) => s + d.amount, 0) / weekDays.length) : 0;

  // Best day this month
  const bestDay = dailyRevenue.length > 0 ? dailyRevenue.reduce((best, d) => d.amount > best.amount ? d : best, dailyRevenue[0]) : null;

  return (
    <div className="bg-white dark:bg-gray-800 p-5 sm:p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
      <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-4">Daily Summary</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="text-center p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
          <p className="text-xs text-gray-500 dark:text-gray-400">Today</p>
          <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{summary.today_revenue.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{currency}</p>
        </div>
        <div className="text-center p-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl">
          <p className="text-xs text-gray-500 dark:text-gray-400">Yesterday</p>
          <p className="text-lg font-bold text-gray-700 dark:text-gray-200">{yesterdayData ? yesterdayData.amount.toLocaleString() : "—"}</p>
          <p className="text-xs text-gray-400">{currency}</p>
        </div>
        <div className="text-center p-3 bg-green-50 dark:bg-green-900/20 rounded-xl">
          <p className="text-xs text-gray-500 dark:text-gray-400">Week Avg</p>
          <p className="text-lg font-bold text-green-600 dark:text-green-400">{weekAvg.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{currency}/day</p>
        </div>
        <div className="text-center p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-xl">
          <p className="text-xs text-gray-500 dark:text-gray-400">Best Day</p>
          <p className="text-lg font-bold text-yellow-600 dark:text-yellow-400">{bestDay ? bestDay.amount.toLocaleString() : "—"}</p>
          <p className="text-xs text-gray-400">{bestDay ? bestDay.date.slice(5) : ""}</p>
        </div>
      </div>
    </div>
  );
}

function HealthScore({ summary, monthlyData }) {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);

  // Calculate score 0-100 from existing data
  const factors = [];

  // 1. Profitability (0-30 pts)
  const margin = summary.profit_margin || 0;
  const profitScore = Math.min(Math.round(margin * 1.5), 30); // 20% margin = 30 pts
  factors.push({ label: "Profitability", score: profitScore, max: 30, tip: margin > 0 ? `${margin}% margin` : "Not profitable yet" });

  // 2. Revenue consistency (0-25 pts) — how many days had sales this month
  const dailyRevenue = monthlyData?.daily_revenue || [];
  const daysWithSales = dailyRevenue.filter(d => d.amount > 0).length;
  const totalDays = Math.max(dailyRevenue.length, 1);
  const consistencyPct = daysWithSales / totalDays;
  const consistencyScore = Math.min(Math.round(consistencyPct * 25), 25);
  factors.push({ label: "Consistency", score: consistencyScore, max: 25, tip: `${daysWithSales}/${totalDays} days active` });

  // 3. Revenue growth (0-20 pts)
  const growthChange = summary.today_revenue_change || 0;
  const growthScore = growthChange > 0 ? Math.min(Math.round(growthChange), 20) : growthChange === 0 ? 10 : Math.max(10 + Math.round(growthChange / 2), 0);
  factors.push({ label: "Growth", score: growthScore, max: 20, tip: `${growthChange >= 0 ? "+" : ""}${growthChange}% vs yesterday` });

  // 4. Expense control (0-15 pts) — lower expense ratio = better
  const expenseRatio = summary.month_revenue > 0 ? summary.month_expenses / summary.month_revenue : 1;
  const expenseScore = Math.round(Math.max(0, (1 - expenseRatio)) * 15);
  factors.push({ label: "Cost Control", score: expenseScore, max: 15, tip: `${Math.round(expenseRatio * 100)}% of revenue` });

  // 5. Activity (0-10 pts) — logged today?
  const activityScore = summary.today_revenue > 0 ? 10 : 0;
  factors.push({ label: "Activity", score: activityScore, max: 10, tip: summary.today_revenue > 0 ? "Active today" : "No sales today" });

  const total = factors.reduce((s, f) => s + f.score, 0);
  const color = total >= 75 ? "text-green-500" : total >= 50 ? "text-yellow-500" : total >= 25 ? "text-orange-500" : "text-red-500";
  const bgColor = total >= 75 ? "bg-green-500" : total >= 50 ? "bg-yellow-500" : total >= 25 ? "bg-orange-500" : "bg-red-500";
  const label = total >= 75 ? "Excellent" : total >= 50 ? "Good" : total >= 25 ? "Needs Work" : "Critical";

  return (
    <div className="bg-white dark:bg-gray-800 p-5 sm:p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
        {/* Score circle */}
        <div className="flex items-center gap-4 sm:gap-0 sm:flex-col sm:items-center">
          <div className="relative w-20 h-20 flex-shrink-0">
            <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="34" fill="none" stroke="currentColor" strokeWidth="6" className="text-gray-100 dark:text-gray-700" />
              <circle cx="40" cy="40" r="34" fill="none" strokeWidth="6" strokeLinecap="round"
                className={color}
                strokeDasharray={`${(total / 100) * 213.6} 213.6`}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`text-xl font-bold ${color}`}>{total}</span>
            </div>
          </div>
          <div className="sm:text-center sm:mt-1">
            <p className="text-sm font-semibold text-gray-800 dark:text-white">Business Health</p>
            <p className={`text-xs font-medium ${color}`}>{label}</p>
          </div>
        </div>

        {/* Factor bars */}
        <div className="flex-1 space-y-2">
          {factors.map((f) => (
            <div key={f.label} className="flex items-center gap-3">
              <span className="text-xs text-gray-500 dark:text-gray-400 w-20 shrink-0">{f.label}</span>
              <div className="flex-1 h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${bgColor} transition-all duration-500`} style={{ width: `${(f.score / f.max) * 100}%` }} />
              </div>
              <span className="text-xs text-gray-400 dark:text-gray-500 w-16 text-right">{f.tip}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BenchmarkCards({ benchmarks, currency }) {
  const statusColors = {
    good: { bg: "bg-green-50 dark:bg-green-900/20", border: "border-green-200 dark:border-green-800", text: "text-green-700 dark:text-green-400", bar: "bg-green-500", badge: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400" },
    average: { bg: "bg-yellow-50 dark:bg-yellow-900/20", border: "border-yellow-200 dark:border-yellow-800", text: "text-yellow-700 dark:text-yellow-400", bar: "bg-yellow-500", badge: "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400" },
    attention: { bg: "bg-red-50 dark:bg-red-900/20", border: "border-red-200 dark:border-red-800", text: "text-red-700 dark:text-red-400", bar: "bg-red-500", badge: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400" },
  };
  const statusLabels = { good: "On Track", average: "Average", attention: "Needs Attention" };
  const statusIcons = {
    good: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>,
    average: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M12 3a9 9 0 100 18 9 9 0 000-18z" /></svg>,
    attention: <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  };

  return (
    <div className="bg-white dark:bg-gray-800 p-5 sm:p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200">Industry Benchmarks</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {benchmarks.period} • {benchmarks.business_type.charAt(0).toUpperCase() + benchmarks.business_type.slice(1).replace("_", " ")}
          </p>
        </div>
        <div className="text-xs text-gray-400">📊 vs industry avg</div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {benchmarks.metrics.map((m) => {
          const c = statusColors[m.status];
          // Calculate marker position on the range bar (0-100%)
          const barMax = Math.max(m.range_high * 1.5, m.user_value * 1.2, 50);
          const userPos = Math.min((m.user_value / barMax) * 100, 100);
          const rangeLowPos = (m.range_low / barMax) * 100;
          const rangeHighPos = (m.range_high / barMax) * 100;

          return (
            <div key={m.name} className={`p-4 rounded-xl border ${c.border} ${c.bg}`}>
              <p className="text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">{m.label}</p>
              <div className="flex items-baseline gap-2 mb-2">
                <span className={`text-2xl font-bold ${c.text}`}>{m.user_value}%</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 ${c.badge}`}>
                  {statusIcons[m.status]}
                  {statusLabels[m.status]}
                </span>
              </div>
              {/* Range bar */}
              <div className="relative h-2 bg-gray-200 dark:bg-gray-600 rounded-full mb-1.5">
                {/* Industry average range */}
                <div
                  className="absolute h-full bg-gray-300 dark:bg-gray-500 rounded-full opacity-60"
                  style={{ left: `${rangeLowPos}%`, width: `${rangeHighPos - rangeLowPos}%` }}
                />
                {/* User marker */}
                <div
                  className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white dark:border-gray-800 shadow ${c.bar}`}
                  style={{ left: `${Math.max(userPos - 2, 0)}%` }}
                />
              </div>
              <p className="text-xs text-gray-400">
                Avg: {m.range_low}-{m.range_high}% • {m.tip}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KpiCard({ title, value, change, changeLabel, subtitle, alert }) {
  return (
    <div className={`bg-white dark:bg-gray-800 p-4 sm:p-5 rounded-xl shadow-sm border ${alert ? "border-red-300 dark:border-red-600" : "border-gray-100 dark:border-gray-700"}`}>
      <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{title}</p>
      <p className="text-lg sm:text-2xl font-bold text-gray-800 dark:text-gray-100 mt-1 break-words">{value}</p>
      {change !== undefined && (
        <p className={`text-sm mt-1 ${change >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
          {change >= 0 ? "+" : ""}{change}% {changeLabel}
        </p>
      )}
      {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{subtitle}</p>}
    </div>
  );
}
