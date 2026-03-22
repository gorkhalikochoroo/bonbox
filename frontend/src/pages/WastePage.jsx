import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";

const REASONS = ["expired", "overcooked", "damaged", "other"];
const REASON_COLORS = { expired: "#ef4444", overcooked: "#f97316", damaged: "#eab308", other: "#6b7280" };
const QUICK_COSTS = [50, 100, 250, 500, 1000];

export default function WastePage() {
  const { user } = useAuth();
  const currency = user?.currency || "DKK";
  const { t } = useLanguage();
  const [logs, setLogs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("kg");
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState("expired");
  const [wasteDate, setWasteDate] = useState(new Date().toISOString().split("T")[0]);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());

  const filtered = logs.filter(l => !search || l.item_name?.toLowerCase().includes(search.toLowerCase()) || l.reason?.toLowerCase().includes(search.toLowerCase()));

  const fetchData = (from, to) => {
    const params = {};
    if (from) params.from = from;
    if (to) params.to = to;
    api.get("/waste", { params }).then((res) => setLogs(res.data)).catch(() => {});
    api.get("/waste/summary").then((res) => setSummary(res.data)).catch(() => {});
  };

  useEffect(() => { fetchData(); }, []);

  const submit = async (quickCost) => {
    const c = quickCost || parseFloat(cost);
    if (!item || !qty) return;
    setError("");
    try {
      await api.post("/waste", {
        item_name: item,
        quantity: parseFloat(qty),
        unit,
        estimated_cost: c || 0,
        reason,
        date: wasteDate,
      });
      setItem(""); setQty(""); setCost("");
      setWasteDate(new Date().toISOString().split("T")[0]);
      trackEvent("waste_logged", "waste", `${item} - ${c || 0} ${currency}`);
      setSuccess(t("wasteLogged"));
      fetchData(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to log waste");
    }
  };

  const startEdit = (log) => {
    setEditId(log.id);
    setEditData({
      date: log.date,
      item_name: log.item_name,
      quantity: parseFloat(log.quantity),
      unit: log.unit,
      reason: log.reason,
      estimated_cost: parseFloat(log.estimated_cost),
    });
  };

  const saveEdit = async () => {
    try {
      await api.put(`/waste/${editId}`, editData);
      setEditId(null);
      fetchData(filterFrom, filterTo);
      setSuccess("Updated!");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update");
    }
  };

  const bulkDelete = async () => {
    if (!confirm(`Move ${selected.size} items to trash?`)) return;
    try {
      await Promise.all([...selected].map(id => api.delete(`/waste/${id}`)));
      setSelected(new Set());
      fetchData(filterFrom, filterTo);
      setSuccess(`${selected.size} items moved to trash`);
      setTimeout(() => setSuccess(""), 2500);
    } catch {
      setError("Failed to delete some items");
    }
  };

  const deleteWaste = async (id) => {
    try {
      await api.delete(`/waste/${id}`);
      setDeleteConfirm(null);
      fetchData(filterFrom, filterTo);
      setSuccess("Moved to recently deleted");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to delete");
    }
  };

  const pieData = summary?.by_reason
    ? Object.entries(summary.by_reason).map(([r, v]) => ({ name: t(r), value: v }))
    : [];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("wasteTracker")}</h1>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t("monthlyWasteCost")}</p>
            <p className="text-2xl font-bold text-red-600 dark:text-red-400 mt-1">{summary.total_cost.toLocaleString()} {currency}</p>
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
              className="px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-red-50 dark:hover:bg-red-900/30 hover:border-red-300 dark:hover:border-red-700 hover:text-red-700 dark:hover:text-red-400 transition disabled:opacity-30">
              {c} {currency}
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

        {/* Date picker */}
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}:</label>
          <input
            type="date"
            value={wasteDate}
            max={new Date().toISOString().split("T")[0]}
            onChange={(e) => setWasteDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {wasteDate !== new Date().toISOString().split("T")[0] && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Backdated entry</span>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-200">{t("recentWaste")}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); fetchData(e.target.value, filterTo); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); fetchData(filterFrom, e.target.value); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {(filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterFrom(""); setFilterTo(""); fetchData(); }}
                className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => exportToCsv("waste.csv", logs, [
                { key: "date", label: "Date" },
                { key: "item_name", label: "Item" },
                { key: "quantity", label: "Quantity" },
                { key: "unit", label: "Unit" },
                { key: "reason", label: "Reason" },
                { key: "estimated_cost", label: "Cost" },
              ])}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              Export CSV
            </button>
          </div>
        </div>
        {selected.size > 0 && (
          <div className="px-6 py-3 bg-blue-50 dark:bg-blue-900/20 flex items-center justify-between">
            <span className="text-sm text-blue-700 dark:text-blue-400">{selected.size} selected</span>
            <button onClick={bulkDelete} className="text-sm text-red-600 dark:text-red-400 font-medium hover:underline">
              Move to trash
            </button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-4 py-3 w-8">
                  <input type="checkbox" onChange={(e) => {
                    if (e.target.checked) setSelected(new Set(filtered.map(i => i.id)));
                    else setSelected(new Set());
                  }} checked={selected.size === filtered.length && filtered.length > 0} />
                </th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("item")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("qty")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("reason")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("cost")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {filtered.slice(0, 50).map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-4">
                    <input type="checkbox" checked={selected.has(log.id)} onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(log.id);
                      else next.delete(log.id);
                      setSelected(next);
                    }} />
                  </td>
                  {editId === log.id ? (
                    <>
                      <td className="px-4 py-3">
                        <input type="date" value={editData.date} onChange={(e) => setEditData({ ...editData, date: e.target.value })}
                          className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-32" />
                      </td>
                      <td className="px-4 py-3">
                        <input type="text" value={editData.item_name} onChange={(e) => setEditData({ ...editData, item_name: e.target.value })}
                          className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-28" />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <input type="number" value={editData.quantity} onChange={(e) => setEditData({ ...editData, quantity: parseFloat(e.target.value) || 0 })}
                            className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-16" />
                          <select value={editData.unit} onChange={(e) => setEditData({ ...editData, unit: e.target.value })}
                            className="px-1 py-1 border border-gray-200 dark:border-gray-600 rounded text-xs dark:bg-gray-700 dark:text-white">
                            <option value="kg">kg</option>
                            <option value="liters">L</option>
                            <option value="pieces">pcs</option>
                            <option value="portions">port</option>
                          </select>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <select value={editData.reason} onChange={(e) => setEditData({ ...editData, reason: e.target.value })}
                          className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white">
                          {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <input type="number" value={editData.estimated_cost} onChange={(e) => setEditData({ ...editData, estimated_cost: parseFloat(e.target.value) || 0 })}
                          className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-20" />
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={saveEdit} className="text-green-600 dark:text-green-400 text-sm font-medium hover:underline">Save</button>
                        <button onClick={() => setEditId(null)} className="text-gray-400 text-sm hover:underline">Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{log.date}</td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 font-medium">{log.item_name}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{parseFloat(log.quantity)} {log.unit}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-1 rounded-full capitalize ${
                          log.reason === "expired" ? "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400" :
                          log.reason === "overcooked" ? "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400" :
                          log.reason === "damaged" ? "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400" :
                          "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                        }`}>{t(log.reason)}</span>
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-red-600 dark:text-red-400">{parseFloat(log.estimated_cost).toLocaleString()} {currency}</td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={() => startEdit(log)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">Edit</button>
                        {deleteConfirm === log.id ? (
                          <>
                            <button onClick={() => deleteWaste(log.id)} className="text-red-600 dark:text-red-400 text-sm font-medium hover:underline">Yes, move</button>
                            <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-sm hover:underline">No</button>
                          </>
                        ) : (
                          <button onClick={() => setDeleteConfirm(log.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">Move to trash</button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noWasteYet")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
