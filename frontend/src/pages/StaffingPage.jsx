import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, ComposedChart,
} from "recharts";
import { displayCurrency } from "../utils/currency";
import { formatDate, formatDateShort } from "../utils/dateFormat";
import { FadeIn } from "../components/AnimationKit";

const LEVEL_COLORS = {
  Slow: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700",
  Normal: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
  Busy: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
};

const LEVEL_BAR_COLORS = { Slow: "#22c55e", Normal: "#3b82f6", Busy: "#f97316" };

const STATUS_COLORS = {
  overstaffed: "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800",
  understaffed: "bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800",
  optimal: "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800",
  no_data: "bg-gray-50 dark:bg-gray-700/30 border-gray-200 dark:border-gray-700",
};

const STATUS_BADGE = {
  overstaffed: "text-red-600 bg-red-100 dark:bg-red-900/40 dark:text-red-300",
  understaffed: "text-orange-600 bg-orange-100 dark:bg-orange-900/40 dark:text-orange-300",
  optimal: "text-green-600 bg-green-100 dark:bg-green-900/40 dark:text-green-300",
};

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "—"; }

export default function StaffingPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();

  // Forecast state
  const [forecast, setForecast] = useState(null);
  const [rules, setRules] = useState([]);
  const [ruleForm, setRuleForm] = useState({ label: "Normal", revenue_min: "", revenue_max: "", recommended_staff: "" });
  const [days, setDays] = useState(14);

  // Intelligence state
  const [insights, setInsights] = useState(null);
  const [staffLogs, setStaffLogs] = useState([]);

  // Staff log form
  const [logForm, setLogForm] = useState({
    date: new Date().toISOString().split("T")[0],
    staff_count: "",
    total_hours: "",
    labor_cost: "",
    notes: "",
  });
  const [logSuccess, setLogSuccess] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeView, setActiveView] = useState("forecast"); // "forecast" | "intelligence" | "log"

  const fetchData = () => {
    setLoading(true);
    Promise.allSettled([
      api.get("/staffing/forecast", { params: { days } }),
      api.get("/staffing/rules"),
      api.get("/staffing/insights"),
      api.get("/staffing/logs"),
    ]).then(([fcRes, rulesRes, insRes, logsRes]) => {
      if (fcRes.status === "fulfilled") setForecast(fcRes.value.data);
      if (rulesRes.status === "fulfilled") setRules(rulesRes.value.data);
      if (insRes.status === "fulfilled") setInsights(insRes.value.data);
      if (logsRes.status === "fulfilled") setStaffLogs(logsRes.value.data);
      setLoading(false);
    });
  };

  useEffect(() => { fetchData(); }, [days]);

  const addRule = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post("/staffing/rules", {
        ...ruleForm,
        revenue_min: parseFloat(ruleForm.revenue_min),
        revenue_max: parseFloat(ruleForm.revenue_max),
        recommended_staff: parseInt(ruleForm.recommended_staff),
      });
      setRuleForm({ label: "Normal", revenue_min: "", revenue_max: "", recommended_staff: "" });
      fetchData();
    } catch (err) {
      setError(err?.response?.data?.message || err.message || t("failedToAddRule"));
    }
  };

  const deleteRule = async (id) => {
    try { await api.delete(`/staffing/rules/${id}`); fetchData(); }
    catch (err) { setError(err?.response?.data?.message || err.message); }
  };

  const logStaff = async (e) => {
    e.preventDefault();
    if (!logForm.staff_count) return;
    try {
      await api.post("/staffing/log", {
        date: logForm.date,
        staff_count: parseInt(logForm.staff_count),
        total_hours: logForm.total_hours ? parseFloat(logForm.total_hours) : null,
        labor_cost: logForm.labor_cost ? parseFloat(logForm.labor_cost) : null,
        notes: logForm.notes || null,
      });
      setLogForm({ ...logForm, staff_count: "", total_hours: "", labor_cost: "", notes: "" });
      setLogSuccess("Staff logged!");
      setTimeout(() => setLogSuccess(""), 2000);
      fetchData();
    } catch { setError("Failed to log staff"); }
  };

  const recs = forecast?.recommendations || [];
  const patterns = forecast?.patterns;

  const chartData = recs.map((r) => ({
    date: r.date.slice(5),
    day: r.day.slice(0, 3),
    revenue: r.predicted_revenue,
    staff: r.recommended_staff,
    fill: Object.entries(LEVEL_BAR_COLORS).find(([k]) => r.business_level?.toLowerCase().includes(k.toLowerCase()))?.[1] || "#3b82f6",
  }));

  const dowData = patterns
    ? Object.entries(patterns.day_of_week).map(([day, avg]) => ({
        day: day.slice(0, 3),
        avg_revenue: avg,
      }))
    : [];

  // Intelligence chart data
  const insightChartData = (insights?.weekday_analysis || [])
    .filter(w => w.avg_revenue > 0)
    .map(w => ({
      day: w.day_name.slice(0, 3),
      revenue: w.avg_revenue,
      rev_per_staff: w.rev_per_staff,
      staff: w.avg_staff,
      status: w.status,
    }));

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FadeIn><h1 className="text-2xl font-bold text-gray-800 dark:text-white">🧠 {t("smartStaffing")}</h1></FadeIn>
        <div className="flex gap-2">
          {["forecast", "intelligence", "log"].map(v => (
            <button
              key={v}
              onClick={() => setActiveView(v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${
                activeView === v
                  ? "bg-green-600 text-white"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
              }`}
            >
              {v === "forecast" ? "📅 Forecast" : v === "intelligence" ? "🧠 Insights" : "✏️ Log Staff"}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 p-4 rounded-xl text-center">
          <p className="text-red-700 dark:text-red-300 text-sm">{error}</p>
        </div>
      )}

      {/* ─── INTELLIGENCE ALERTS (always visible) ─── */}
      {insights?.alerts?.length > 0 && (
        <div className="space-y-3">
          {insights.alerts.map((alert, i) => (
            <div key={i} className={`p-4 rounded-2xl border-l-4 ${
              alert.severity === "warning" ? "border-red-500 bg-red-50 dark:bg-red-900/20" :
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

      {/* ═══════ FORECAST VIEW ═══════ */}
      {activeView === "forecast" && (
        <>
          <div className="flex justify-end">
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value))}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
            >
              <option value={7}>{t("next7days")}</option>
              <option value={14}>{t("next14days")}</option>
              <option value={30}>{t("next30days")}</option>
            </select>
          </div>

          {loading ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-12">{t("analyzingPatterns")}</p>
          ) : recs.length === 0 ? (
            <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-700 p-6 rounded-xl text-center">
              <p className="text-yellow-700 dark:text-yellow-300 font-medium">{t("notEnoughData")}</p>
              <p className="text-yellow-600 dark:text-yellow-400 text-sm mt-1">{t("logMoreSales")}</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <SummaryCard title={t("slowDaysAhead")} value={recs.filter((r) => r.business_level?.toLowerCase().includes("slow")).length} subtitle={t("reduceStaff")} color="text-green-600" />
                <SummaryCard title={t("normalDays")} value={recs.filter((r) => r.business_level?.toLowerCase().includes("normal")).length} subtitle={t("standardStaffing")} color="text-blue-600" />
                <SummaryCard title={t("busyDaysAhead")} value={recs.filter((r) => r.business_level?.toLowerCase().includes("busy")).length} subtitle={t("extraStaff")} color="text-orange-600" />
              </div>

              <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 p-4 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-blue-700 dark:text-blue-300">{t("totalStaffNeeded")} ({t("next" + days + "days")})</p>
                  <p className="text-xs text-blue-500 dark:text-blue-400 mt-0.5">{t("basedOnPatterns")}</p>
                </div>
                <p className="text-3xl font-bold text-blue-700 dark:text-blue-300">{recs.reduce((sum, r) => sum + (r.recommended_staff || 0), 0)}</p>
              </div>

              <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
                <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-4">{t("revenueForecast")}</h2>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="revenue" tick={{ fontSize: 12 }} />
                    <YAxis yAxisId="staff" orientation="right" tick={{ fontSize: 12 }} domain={[0, 10]} />
                    <Tooltip formatter={(value, name) => name === "revenue" ? [`${value} ${currency}`, t("predictedRevenue")] : [value, t("staffNeeded")]} />
                    <Legend />
                    <Bar yAxisId="revenue" dataKey="revenue" name={t("predictedRevenue")} radius={[4, 4, 0, 0]}>
                      {chartData.map((entry, i) => (
                        <rect key={i} fill={entry.fill} />
                      ))}
                    </Bar>
                    <Line yAxisId="staff" dataKey="staff" name={t("staffNeeded")} stroke="#ef4444" strokeWidth={2} dot />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {dowData.length > 0 && (
                <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
                  <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">{t("salesPatterns")}</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                    {patterns.total_days_analyzed} {t("daysRecorded")} — {patterns.overall_avg.toLocaleString()} {currency}
                  </p>
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={dowData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="day" />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(v) => [`${v} ${currency}`, t("revenue")]} />
                      <Bar dataKey="avg_revenue" fill="#6366f1" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left min-w-[700px]">
                    <thead className="bg-gray-50 dark:bg-gray-700/50">
                      <tr>
                        <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}</th>
                        <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("day")}</th>
                        <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("predictedRevenue")}</th>
                        <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("level")}</th>
                        <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("staffNeeded")}</th>
                        <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("confidence")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {recs.map((r) => (
                        <tr key={r.date}>
                          <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{formatDate(r.date)}</td>
                          <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{r.day}</td>
                          <td className="px-6 py-4 text-sm font-medium text-gray-800 dark:text-white">{r.predicted_revenue.toLocaleString()} {currency}</td>
                          <td className="px-6 py-4">
                            <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${Object.entries(LEVEL_COLORS).find(([k]) => r.business_level?.toLowerCase().includes(k.toLowerCase()))?.[1] || ""}`}>
                              {r.business_level}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm font-bold text-gray-800 dark:text-white">{r.recommended_staff}</td>
                          <td className="px-6 py-4">
                            <span className={`text-xs ${r.confidence === "high" ? "text-green-600 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400"}`}>
                              {r.confidence}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {/* Staffing Rules */}
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-4">{t("staffingRules")}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t("staffingRulesDesc")}</p>
            <form onSubmit={addRule} className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              <select value={ruleForm.label} onChange={(e) => setRuleForm({ ...ruleForm, label: e.target.value })}
                className="px-3 py-3 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white">
                <option value="Slow">{t("slow")}</option>
                <option value="Normal">{t("normal")}</option>
                <option value="Busy">{t("busy")}</option>
              </select>
              <input type="number" placeholder={t("minRevenue")} value={ruleForm.revenue_min}
                onChange={(e) => setRuleForm({ ...ruleForm, revenue_min: e.target.value })}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white" required />
              <input type="number" placeholder={t("maxRevenue")} value={ruleForm.revenue_max}
                onChange={(e) => setRuleForm({ ...ruleForm, revenue_max: e.target.value })}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white" required />
              <input type="number" placeholder={t("staffNeeded")} value={ruleForm.recommended_staff}
                onChange={(e) => setRuleForm({ ...ruleForm, recommended_staff: e.target.value })}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white" required />
              <button type="submit" className="bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition text-sm font-medium">
                {t("addRule")}
              </button>
            </form>
            {rules.length > 0 && (
              <div className="space-y-2">
                {rules.map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-700/50 px-4 py-2.5 rounded-lg">
                    <span className="text-sm dark:text-gray-200">
                      <span className="font-medium">{rule.label}</span> — {rule.revenue_min.toLocaleString()}–{rule.revenue_max.toLocaleString()} {currency}
                      → <span className="font-bold">{rule.recommended_staff} {t("staff")}</span>
                    </span>
                    <button onClick={() => deleteRule(rule.id)} className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 text-sm">{t("remove")}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ═══════ INTELLIGENCE VIEW ═══════ */}
      {activeView === "intelligence" && (
        <>
          {/* Key metrics */}
          {insights?.ready && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
                <p className="text-xs text-gray-500">Days Analyzed</p>
                <p className="text-2xl font-bold text-gray-800 dark:text-white mt-1">{insights.days_logged}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
                <p className="text-xs text-gray-500">Best Day</p>
                <p className="text-2xl font-bold text-green-600 mt-1">{insights.peak_day?.slice(0, 3) || "—"}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
                <p className="text-xs text-gray-500">Weakest Day</p>
                <p className="text-2xl font-bold text-red-600 mt-1">{insights.weakest_day?.slice(0, 3) || "—"}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
                <p className="text-xs text-gray-500">Savings Potential</p>
                <p className="text-2xl font-bold text-blue-600 mt-1">{fmt(insights.monthly_savings_potential)}</p>
                <p className="text-xs text-gray-400">/month</p>
              </div>
            </div>
          )}

          {/* Revenue per Staff Chart */}
          {insightChartData.length > 0 && (
            <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">Revenue per Staff by Day</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">Higher = more efficient. Red bars = overstaffed.</p>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={insightChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" />
                  <YAxis yAxisId="rps" tick={{ fontSize: 12 }} />
                  <YAxis yAxisId="staff" orientation="right" domain={[0, 10]} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value, name) => {
                      if (name === "rev_per_staff") return [`${fmt(value)} ${currency}`, "Rev/Staff"];
                      if (name === "revenue") return [`${fmt(value)} ${currency}`, "Revenue"];
                      return [value, "Staff"];
                    }}
                  />
                  <Legend />
                  <Bar yAxisId="rps" dataKey="rev_per_staff" name="Rev/Staff" radius={[4, 4, 0, 0]}>
                    {insightChartData.map((entry, i) => (
                      <rect key={i} fill={entry.status === "overstaffed" ? "#ef4444" : entry.status === "understaffed" ? "#f97316" : "#10b981"} />
                    ))}
                  </Bar>
                  <Line yAxisId="staff" dataKey="staff" name="Avg Staff" stroke="#6366f1" strokeWidth={2} dot />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Weekday breakdown cards */}
          {insights?.weekday_analysis?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-4">Weekday Breakdown</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
                {insights.weekday_analysis.map((w, i) => (
                  <div key={i} className={`p-3 rounded-xl border text-center ${STATUS_COLORS[w.status] || STATUS_COLORS.no_data}`}>
                    <p className="text-sm font-bold text-gray-800 dark:text-white">{w.day_name.slice(0, 3)}</p>
                    {w.avg_revenue > 0 ? (
                      <>
                        <p className="text-lg font-bold mt-1 text-gray-800 dark:text-white">{fmt(w.rev_per_staff)}</p>
                        <p className="text-[10px] text-gray-500">{currency}/staff</p>
                        <p className="text-xs text-gray-500 mt-1">{w.avg_staff} staff • {fmt(w.avg_revenue)} rev</p>
                        {w.status !== "no_data" && w.status !== "ok" && (
                          <span className={`text-[10px] mt-1 px-1.5 py-0.5 rounded-full inline-block ${STATUS_BADGE[w.status] || ""}`}>
                            {w.status === "overstaffed" ? "📉 Over" : w.status === "understaffed" ? "🔥 Under" : "✅ OK"}
                          </span>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-gray-400 mt-2">No data</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Not enough data prompt */}
          {insights && !insights.ready && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 shadow-sm text-center">
              <div className="text-5xl mb-4">👥</div>
              <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-2">Build Your Staff Intelligence</h2>
              <p className="text-gray-500 dark:text-gray-400 mb-2">
                {insights.days_logged}/14 days logged. Switch to "Log Staff" tab to log daily counts.
              </p>
              <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden w-64 mx-auto">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full transition-all"
                  style={{ width: `${Math.min(100, (insights.days_logged / 14) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══════ LOG STAFF VIEW ═══════ */}
      {activeView === "log" && (
        <>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-4">📝 Log Daily Staff</h2>
            <form onSubmit={logStaff} className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              <input
                type="date"
                value={logForm.date}
                onChange={e => setLogForm({ ...logForm, date: e.target.value })}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
              />
              <input
                type="number"
                placeholder="Staff count *"
                value={logForm.staff_count}
                onChange={e => setLogForm({ ...logForm, staff_count: e.target.value })}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                required min="1"
              />
              <input
                type="number"
                step="0.5"
                placeholder="Total hours"
                value={logForm.total_hours}
                onChange={e => setLogForm({ ...logForm, total_hours: e.target.value })}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
              />
              <input
                type="number"
                placeholder={`Labor cost (${currency})`}
                value={logForm.labor_cost}
                onChange={e => setLogForm({ ...logForm, labor_cost: e.target.value })}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
              />
              <button type="submit" className="bg-green-600 text-white py-2 rounded-lg hover:bg-green-700 transition text-sm font-medium">
                Log Staff
              </button>
            </form>
            {logSuccess && <p className="text-green-500 text-sm">{logSuccess}</p>}
            <p className="text-xs text-gray-400 mt-2">Only staff count is required. Hours and cost are optional but improve insights.</p>
          </div>

          {/* Recent logs */}
          {staffLogs.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-700/50">
                    <tr>
                      <th className="px-4 py-3 text-xs text-gray-500">Date</th>
                      <th className="px-4 py-3 text-xs text-gray-500">Day</th>
                      <th className="px-4 py-3 text-xs text-gray-500 text-center">Staff</th>
                      <th className="px-4 py-3 text-xs text-gray-500 text-right">Hours</th>
                      <th className="px-4 py-3 text-xs text-gray-500 text-right">Labor Cost</th>
                      <th className="px-4 py-3 text-xs text-gray-500">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {staffLogs.slice(0, 30).map((log) => {
                      const d = new Date(log.date + "T12:00:00");
                      const dayName = d.toLocaleDateString("en", { weekday: "short" });
                      return (
                        <tr key={log.id}>
                          <td className="px-4 py-3 text-gray-700 dark:text-gray-300">{log.date}</td>
                          <td className="px-4 py-3 text-gray-500">{dayName}</td>
                          <td className="px-4 py-3 text-center font-bold text-gray-800 dark:text-white">{log.staff_count}</td>
                          <td className="px-4 py-3 text-right text-gray-500">{log.total_hours || "—"}</td>
                          <td className="px-4 py-3 text-right text-gray-500">{log.labor_cost ? `${fmt(log.labor_cost)} ${currency}` : "—"}</td>
                          <td className="px-4 py-3 text-gray-400 text-xs">{log.notes || ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {staffLogs.length === 0 && (
            <div className="text-center py-8 text-gray-400">
              <p className="text-3xl mb-2">📋</p>
              <p>No staff logs yet. Start logging above!</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCard({ title, value, subtitle, color }) {
  return (
    <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
      <p className="text-sm text-gray-500 dark:text-gray-400">{title}</p>
      <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{subtitle}</p>
    </div>
  );
}
