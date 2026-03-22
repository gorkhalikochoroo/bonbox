import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";

export default function InventoryPage() {
  const { user } = useAuth();
  const currency = user?.currency || "DKK";
  const { t } = useLanguage();
  const [items, setItems] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [form, setForm] = useState({ name: "", quantity: "", unit: "pieces", cost_per_unit: "", min_threshold: "" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [adjustId, setAdjustId] = useState(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState("");

  const fetchData = () => {
    api.get("/inventory").then((res) => setItems(res.data)).catch(() => {});
    api.get("/inventory/alerts").then((res) => setAlerts(res.data)).catch(() => {});
  };

  useEffect(() => { fetchData(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await api.post("/inventory", {
        ...form,
        quantity: parseFloat(form.quantity),
        cost_per_unit: parseFloat(form.cost_per_unit),
        min_threshold: parseFloat(form.min_threshold),
      });
      setForm({ name: "", quantity: "", unit: "pieces", cost_per_unit: "", min_threshold: "" });
      fetchData();
      setSuccess("Item added!");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add item");
    }
  };

  const startEdit = (item) => {
    setEditId(item.id);
    setEditData({
      name: item.name,
      quantity: parseFloat(item.quantity),
      unit: item.unit,
      cost_per_unit: parseFloat(item.cost_per_unit),
      min_threshold: parseFloat(item.min_threshold),
    });
  };

  const saveEdit = async () => {
    try {
      await api.patch(`/inventory/${editId}`, editData);
      setEditId(null);
      fetchData();
      setSuccess("Item updated!");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update");
    }
  };

  const adjustStock = async (itemId, change) => {
    const qty = parseFloat(change);
    if (!qty) return;
    try {
      await api.post("/inventory/logs", { item_id: itemId, change_qty: qty });
      setAdjustId(null);
      setAdjustQty("");
      fetchData();
      setSuccess(`Stock ${qty > 0 ? "added" : "removed"}!`);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to adjust stock");
    }
  };

  const deleteItem = async (id) => {
    try {
      await api.delete(`/inventory/${id}`);
      setDeleteConfirm(null);
      fetchData();
      setSuccess("Item deleted");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to delete");
    }
  };

  const alertIds = new Set(alerts.map((a) => a.id));
  const filtered = items.filter((i) => !search || i.name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => {
    return (b.created_at || "").localeCompare(a.created_at || "");
  });
  const totalValue = items.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.cost_per_unit), 0);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("inventoryMonitor")}</h1>
        <div className="text-right">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Stock Value</p>
          <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{totalValue.toLocaleString()} {currency}</p>
        </div>
      </div>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {alerts.length > 0 && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 p-4 rounded-xl">
          <p className="text-red-700 dark:text-red-300 font-medium">{t("lowStockAlerts")}: {alerts.map((a) => a.name).join(", ")}</p>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Total Items</p>
          <p className="text-2xl font-bold text-gray-800 dark:text-white mt-1">{items.length}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Low Stock</p>
          <p className={`text-2xl font-bold mt-1 ${alerts.length > 0 ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>{alerts.length}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Stock Value</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{totalValue.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Avg Item Cost</p>
          <p className="text-2xl font-bold text-gray-700 dark:text-gray-200 mt-1">{items.length > 0 ? Math.round(totalValue / items.length).toLocaleString() : 0}</p>
          <p className="text-xs text-gray-400">{currency}</p>
        </div>
      </div>

      {/* Add item form */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-4">{t("addItem")}</h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <input type="text" placeholder={t("itemName")} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg col-span-2 md:col-span-1" required />
          <input type="number" step="0.01" placeholder={t("quantity")} value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg">
            <option value="pieces">{t("pieces")}</option>
            <option value="kg">{t("kg")}</option>
            <option value="liters">{t("liters")}</option>
            <option value="boxes">{t("boxes")}</option>
          </select>
          <input type="number" step="0.01" placeholder={`${t("costPerUnit")} (${currency})`} value={form.cost_per_unit}
            onChange={(e) => setForm({ ...form, cost_per_unit: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <input type="number" step="0.01" placeholder={t("threshold")} value={form.min_threshold}
            onChange={(e) => setForm({ ...form, min_threshold: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <button type="submit" className="bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition font-medium col-span-2 md:col-span-5">
            {t("addItem")}
          </button>
        </form>
      </div>

      {/* Inventory table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">Stock Items</h2>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items..."
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[650px]">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("item")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("quantity")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("unit")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("costPerUnit")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Value</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("threshold")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {filtered.map((item) => (
                <tr key={item.id} className={alertIds.has(item.id) ? "bg-red-50 dark:bg-red-900/20" : ""}>
                  {editId === item.id ? (
                    <>
                      <td className="px-6 py-3">
                        <input type="text" value={editData.name} onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                          className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-28" />
                      </td>
                      <td className="px-6 py-3">
                        <input type="number" value={editData.quantity} onChange={(e) => setEditData({ ...editData, quantity: parseFloat(e.target.value) || 0 })}
                          className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-20" />
                      </td>
                      <td className="px-6 py-3">
                        <select value={editData.unit} onChange={(e) => setEditData({ ...editData, unit: e.target.value })}
                          className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white">
                          <option value="pieces">pieces</option>
                          <option value="kg">kg</option>
                          <option value="liters">liters</option>
                          <option value="boxes">boxes</option>
                        </select>
                      </td>
                      <td className="px-6 py-3">
                        <input type="number" step="0.01" value={editData.cost_per_unit} onChange={(e) => setEditData({ ...editData, cost_per_unit: parseFloat(e.target.value) || 0 })}
                          className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-20" />
                      </td>
                      <td className="px-6 py-3 text-sm text-gray-500">—</td>
                      <td className="px-6 py-3">
                        <input type="number" step="0.01" value={editData.min_threshold} onChange={(e) => setEditData({ ...editData, min_threshold: parseFloat(e.target.value) || 0 })}
                          className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-20" />
                      </td>
                      <td className="px-6 py-3 text-right space-x-2">
                        <button onClick={saveEdit} className="text-green-600 dark:text-green-400 text-sm font-medium hover:underline">Save</button>
                        <button onClick={() => setEditId(null)} className="text-gray-400 text-sm hover:underline">Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300 font-medium">
                        {item.name}
                        {alertIds.has(item.id) && <span className="ml-2 px-1.5 py-0.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-xs rounded font-medium">Low</span>}
                      </td>
                      <td className="px-6 py-4 text-sm font-semibold text-gray-800 dark:text-white">
                        {parseFloat(item.quantity)}
                        {adjustId === item.id ? (
                          <span className="ml-2 inline-flex items-center gap-1">
                            <input type="number" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} placeholder="+/-"
                              className="w-16 px-1.5 py-1 border border-gray-200 dark:border-gray-600 rounded text-xs dark:bg-gray-700 dark:text-white"
                              onKeyDown={(e) => e.key === "Enter" && adjustStock(item.id, adjustQty)} autoFocus />
                            <button onClick={() => adjustStock(item.id, adjustQty)} className="text-green-600 text-xs font-medium">Go</button>
                            <button onClick={() => { setAdjustId(null); setAdjustQty(""); }} className="text-gray-400 text-xs">X</button>
                          </span>
                        ) : (
                          <button onClick={() => setAdjustId(item.id)} className="ml-2 text-blue-500 text-xs hover:underline">+/-</button>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">{item.unit}</td>
                      <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">{parseFloat(item.cost_per_unit)} {currency}</td>
                      <td className="px-6 py-4 text-sm font-medium text-gray-700 dark:text-gray-300">{(parseFloat(item.quantity) * parseFloat(item.cost_per_unit)).toLocaleString()} {currency}</td>
                      <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">{parseFloat(item.min_threshold)}</td>
                      <td className="px-6 py-4 text-right space-x-3">
                        <button onClick={() => startEdit(item)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">Edit</button>
                        {deleteConfirm === item.id ? (
                          <>
                            <button onClick={() => deleteItem(item.id)} className="text-red-600 dark:text-red-400 text-sm font-medium hover:underline">Yes</button>
                            <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-sm hover:underline">No</button>
                          </>
                        ) : (
                          <button onClick={() => setDeleteConfirm(item.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">Delete</button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noInventoryYet")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
