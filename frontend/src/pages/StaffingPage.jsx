import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from "recharts";
import { displayCurrency } from "../utils/currency";

const LEVEL_COLORS = {
  Slow: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700",
  Normal: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
  Busy: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
};

const LEVEL_BAR_COLORS = { Slow: "#22c55e", Normal: "#3b82f6", Busy: "#f97316" };

export default function StaffingPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const [forecast, setForecast] = useState(null);
  const [rules, setRules] = useState([]);
  const [ruleForm, setRuleForm] = useState({ label: "Normal", revenue_min: "", revenue_max: "", recommended_staff: "" });
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      api.get("/staffing/forecast", { params: { days } }),
      api.get("/staffing/rules"),
    ]).then(([fcRes, rulesRes]) => {
      setForecast(fcRes.data);
      setRules(rulesRes.data);
      setLoading(false);
    }).catch(() => setLoading(false));
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
      setError(err?.response?.data?.message || err.message || "Failed to add rule");
    }
  };

  const deleteRule = async (id) => {
    setError(null);
    try {
      await api.delete(`/staffing/rules/${id}`);
      fetchData();
    } catch (err) {
      setError(err?.response?.data?.message || err.message || "Failed to delete rule");
    }
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

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("smartStaffing")}</h1>
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

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 p-4 rounded-xl text-center">
          <p className="text-red-700 dark:text-red-300 text-sm">{error}</p>
        </div>
      )}

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

          {/* Total staff summary */}
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
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{r.date}</td>
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
