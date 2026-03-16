import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";

const REASONS = ["expired", "overcooked", "damaged", "other"];
const REASON_COLORS = { expired: "#ef4444", overcooked: "#f97316", damaged: "#eab308", other: "#6b7280" };
const QUICK_COSTS = [50, 100, 250, 500, 1000];

export default function WastePage() {
  const { t } = useLanguage();
  const [logs, setLogs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("kg");
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState("expired");
  const [success, setSuccess] = useState("");

  const fetchData = () => {
    api.get("/waste").then((res) => setLogs(res.data));
    api.get("/waste/summary").then((res) => setSummary(res.data));
  };

  useEffect(() => { fetchData(); }, []);

  const submit = async (quickCost) => {
    const c = quickCost || parseFloat(cost);
    if (!item || !qty) return;
    await api.post("/waste", {
      item_name: item,
      quantity: parseFloat(qty),
      unit,
      estimated_cost: c || 0,
      reason,
    });
    setItem(""); setQty(""); setCost("");
    setSuccess(t("wasteLogged"));
    fetchData();
    setTimeout(() => setSuccess(""), 2500);
  };

  const pieData = summary?.by_reason
    ? Object.entries(summary.by_reason).map(([r, v]) => ({ name: t(r), value: v }))
    : [];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("wasteTracker")}</h1>

      {success && <div className="bg-green-50 text-green-700 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("monthlyWasteCost")}</p>
            <p className="text-2xl font-bold text-red-600 mt-1">{summary.total_cost.toLocaleString()} DKK</p>
          </div>
          <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("itemsWasted")}</p>
            <p className="text-2xl font-bold text-gray-800 dark:text-white mt-1">{summary.total_items}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={120}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={50} label={false}>
                    {pieData.map((e, i) => <Cell key={i} fill={Object.values(REASON_COLORS)[i] || "#6b7280"} />)}
                  </Pie>
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-gray-400 text-center pt-8">{t("noDataYet")}</p>
            )}
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-1">{t("logWaste")}</h2>
        <p className="text-sm text-gray-400 mb-4">{t("trackWaste")}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <input type="text" value={item} onChange={(e) => setItem(e.target.value)}
            placeholder={t("whatWasWasted")}
            className="px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <div className="flex gap-2">
            <input type="number" value={qty} onChange={(e) => setQty(e.target.value)}
              placeholder={t("qty")} className="flex-1 px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <select value={unit} onChange={(e) => setUnit(e.target.value)}
              className="px-3 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl">
              <option value="kg">{t("kg")}</option>
              <option value="liters">{t("liters")}</option>
              <option value="pieces">{t("pieces")}</option>
              <option value="portions">{t("portions")}</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {REASONS.map((r) => (
            <button key={r} onClick={() => setReason(r)}
              className={`px-4 py-2.5 rounded-xl text-sm font-medium capitalize border transition ${
                reason === r
                  ? "bg-red-50 border-red-300 text-red-700 dark:bg-red-900/30 dark:border-red-700 dark:text-red-400"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              }`}
            >
              {t(r)}
            </button>
          ))}
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t("estimatedCost")}</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_COSTS.map((c) => (
            <button key={c} onClick={() => submit(c)} disabled={!item || !qty}
              className="px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-red-50 hover:border-red-300 hover:text-red-700 transition disabled:opacity-30">
              {c} DKK
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          <input type="number" value={cost} onChange={(e) => setCost(e.target.value)}
            placeholder={t("customCost")} className="flex-1 px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button onClick={() => submit()} disabled={!item || !qty}
            className="px-6 py-3 bg-red-600 text-white rounded-xl hover:bg-red-700 transition font-semibold disabled:opacity-40">
            {t("logWaste")}
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-200">{t("recentWaste")}</h2>
        </div>
        <table className="w-full text-left">
          <thead className="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("item")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("qty")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("reason")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("cost")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {logs.slice(0, 20).map((log) => (
              <tr key={log.id}>
                <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{log.date}</td>
                <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300 font-medium">{log.item_name}</td>
                <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">{parseFloat(log.quantity)} {log.unit}</td>
                <td className="px-6 py-4">
                  <span className={`text-xs font-medium px-2 py-1 rounded-full capitalize ${
                    log.reason === "expired" ? "bg-red-100 text-red-700" :
                    log.reason === "overcooked" ? "bg-orange-100 text-orange-700" :
                    log.reason === "damaged" ? "bg-yellow-100 text-yellow-700" :
                    "bg-gray-100 text-gray-700"
                  }`}>{t(log.reason)}</span>
                </td>
                <td className="px-6 py-4 text-sm font-semibold text-red-600">{parseFloat(log.estimated_cost).toLocaleString()} DKK</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-400">{t("noWasteYet")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
