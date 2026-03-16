import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from "recharts";

const LEVEL_COLORS = {
  Slow: "bg-green-100 text-green-700 border-green-200",
  Normal: "bg-blue-100 text-blue-700 border-blue-200",
  Busy: "bg-orange-100 text-orange-700 border-orange-200",
};

const LEVEL_BAR_COLORS = { Slow: "#22c55e", Normal: "#3b82f6", Busy: "#f97316" };

export default function StaffingPage() {
  const { t } = useLanguage();
  const [forecast, setForecast] = useState(null);
  const [rules, setRules] = useState([]);
  const [ruleForm, setRuleForm] = useState({ label: "Normal", revenue_min: "", revenue_max: "", recommended_staff: "" });
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(true);

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
    await api.post("/staffing/rules", {
      ...ruleForm,
      revenue_min: parseFloat(ruleForm.revenue_min),
      revenue_max: parseFloat(ruleForm.revenue_max),
      recommended_staff: parseInt(ruleForm.recommended_staff),
    });
    setRuleForm({ label: "Normal", revenue_min: "", revenue_max: "", recommended_staff: "" });
    fetchData();
  };

  const deleteRule = async (id) => {
    await api.delete(`/staffing/rules/${id}`);
    fetchData();
  };

  const recs = forecast?.recommendations || [];
  const patterns = forecast?.patterns;

  const chartData = recs.map((r) => ({
    date: r.date.slice(5),
    day: r.day.slice(0, 3),
    revenue: r.predicted_revenue,
    staff: r.recommended_staff,
    fill: LEVEL_BAR_COLORS[r.business_level] || "#3b82f6",
  }));

  const dowData = patterns
    ? Object.entries(patterns.day_of_week).map(([day, avg]) => ({
        day: day.slice(0, 3),
        avg_revenue: avg,
      }))
    : [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">{t("smartStaffing")}</h1>
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value))}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value={7}>{t("next7days")}</option>
          <option value={14}>{t("next14days")}</option>
          <option value={30}>{t("next30days")}</option>
        </select>
      </div>

      {loading ? (
        <p className="text-gray-500 text-center py-12">{t("analyzingPatterns")}</p>
      ) : recs.length === 0 ? (
        <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-xl text-center">
          <p className="text-yellow-700 font-medium">{t("notEnoughData")}</p>
          <p className="text-yellow-600 text-sm mt-1">{t("logMoreSales")}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <SummaryCard title={t("slowDaysAhead")} value={recs.filter((r) => r.business_level === "Slow").length} subtitle={t("reduceStaff")} color="text-green-600" />
            <SummaryCard title={t("normalDays")} value={recs.filter((r) => r.business_level === "Normal").length} subtitle={t("standardStaffing")} color="text-blue-600" />
            <SummaryCard title={t("busyDaysAhead")} value={recs.filter((r) => r.business_level === "Busy").length} subtitle={t("extraStaff")} color="text-orange-600" />
          </div>

          <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
            <h2 className="text-lg font-semibold text-gray-700 mb-4">{t("revenueForecast")}</h2>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="revenue" tick={{ fontSize: 12 }} />
                <YAxis yAxisId="staff" orientation="right" tick={{ fontSize: 12 }} domain={[0, 10]} />
                <Tooltip formatter={(value, name) => name === "revenue" ? [`${value} DKK`, t("predictedRevenue")] : [value, t("staffNeeded")]} />
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
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h2 className="text-lg font-semibold text-gray-700 mb-2">{t("salesPatterns")}</h2>
              <p className="text-sm text-gray-500 mb-4">
                {patterns.total_days_analyzed} {t("daysRecorded")} — {patterns.overall_avg.toLocaleString()} DKK
              </p>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={dowData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v) => [`${v} DKK`, t("revenue")]} />
                  <Bar dataKey="avg_revenue" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("date")}</th>
                  <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("day")}</th>
                  <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("predictedRevenue")}</th>
                  <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("level")}</th>
                  <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("staffNeeded")}</th>
                  <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("confidence")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recs.map((r) => (
                  <tr key={r.date}>
                    <td className="px-6 py-4 text-sm text-gray-700">{r.date}</td>
                    <td className="px-6 py-4 text-sm text-gray-700">{r.day}</td>
                    <td className="px-6 py-4 text-sm font-medium text-gray-800">{r.predicted_revenue.toLocaleString()} DKK</td>
                    <td className="px-6 py-4">
                      <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${LEVEL_COLORS[r.business_level] || ""}`}>
                        {r.business_level}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm font-bold text-gray-800">{r.recommended_staff}</td>
                    <td className="px-6 py-4">
                      <span className={`text-xs ${r.confidence === "high" ? "text-green-600" : "text-yellow-600"}`}>
                        {r.confidence}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-lg font-semibold text-gray-700 mb-4">{t("staffingRules")}</h2>
        <p className="text-sm text-gray-500 mb-4">{t("staffingRulesDesc")}</p>
        <form onSubmit={addRule} className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-4">
          <select value={ruleForm.label} onChange={(e) => setRuleForm({ ...ruleForm, label: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="Slow">Slow</option>
            <option value="Normal">Normal</option>
            <option value="Busy">Busy</option>
          </select>
          <input type="number" placeholder="Min revenue" value={ruleForm.revenue_min}
            onChange={(e) => setRuleForm({ ...ruleForm, revenue_min: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
          <input type="number" placeholder="Max revenue" value={ruleForm.revenue_max}
            onChange={(e) => setRuleForm({ ...ruleForm, revenue_max: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
          <input type="number" placeholder={t("staffNeeded")} value={ruleForm.recommended_staff}
            onChange={(e) => setRuleForm({ ...ruleForm, recommended_staff: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm" required />
          <button type="submit" className="bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition text-sm font-medium">
            {t("addRule")}
          </button>
        </form>
        {rules.length > 0 && (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between bg-gray-50 px-4 py-2.5 rounded-lg">
                <span className="text-sm">
                  <span className="font-medium">{rule.label}</span> — {rule.revenue_min.toLocaleString()}–{rule.revenue_max.toLocaleString()} DKK
                  → <span className="font-bold">{rule.recommended_staff} {t("staff")}</span>
                </span>
                <button onClick={() => deleteRule(rule.id)} className="text-red-500 hover:text-red-700 text-sm">{t("remove")}</button>
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
    <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
      <p className="text-sm text-gray-500">{title}</p>
      <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
      <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
    </div>
  );
}
