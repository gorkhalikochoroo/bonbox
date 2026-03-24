import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";

export default function InventoryPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const [items, setItems] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState("All");
  const [form, setForm] = useState({
    name: "", quantity: "", unit: "pieces", cost_per_unit: "",
    min_threshold: "", category: "General", sell_price: "", is_perishable: false,
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [adjustId, setAdjustId] = useState(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);

  const fetchData = () => {
    api.get("/inventory").then((res) => setItems(res.data)).catch(() => {});
    api.get("/inventory/alerts").then((res) => setAlerts(res.data)).catch(() => {});
    api.get("/inventory/categories").then((res) => setCategories(res.data)).catch(() => {});
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
        sell_price: form.sell_price ? parseFloat(form.sell_price) : null,
        category: form.category || "General",
      });
      setForm({ name: "", quantity: "", unit: "pieces", cost_per_unit: "", min_threshold: "", category: "General", sell_price: "", is_perishable: false });
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
      category: item.category || "General",
      sell_price: item.sell_price != null ? parseFloat(item.sell_price) : "",
      is_perishable: item.is_perishable || false,
    });
  };

  const saveEdit = async () => {
    try {
      const payload = { ...editData };
      if (payload.sell_price === "" || payload.sell_price === null) {
        payload.sell_price = null;
      }
      await api.patch(`/inventory/${editId}`, payload);
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
      await api.post("/inventory/logs", { item_id: itemId, change_qty: qty, date: new Date().toISOString().split("T")[0] });
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

  const loadTemplate = async (templateType) => {
    setTemplateLoading(true);
    try {
      const res = await api.post("/inventory/templates/load", { template_type: templateType });
      setShowTemplateModal(false);
      fetchData();
      setSuccess(`Loaded ${res.data.length} items from template!`);
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to load template");
    } finally {
      setTemplateLoading(false);
    }
  };

  const alertIds = new Set(alerts.map((a) => a.id));

  const filtered = useMemo(() => {
    let list = items;
    if (activeCategory !== "All") {
      list = list.filter((i) => (i.category || "General") === activeCategory);
    }
    if (search) {
      list = list.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()));
    }
    return list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  }, [items, activeCategory, search]);

  const totalValue = items.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.cost_per_unit), 0);
  const perishableCount = items.filter((i) => i.is_perishable).length;

  const allCategories = ["All", ...categories];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("inventoryMonitor")}</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowTemplateModal(true)}
            className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition font-medium"
          >
            Load Template
          </button>
          <div className="text-right">
            <p className="text-sm text-gray-500 dark:text-gray-400">Total Stock Value</p>
            <p className="text-xl font-bold text-blue-600 dark:text-blue-400">{totalValue.toLocaleString()} {currency}</p>
          </div>
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
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
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
          <p className="text-xs text-gray-500 dark:text-gray-400">Perishable</p>
          <p className="text-2xl font-bold text-orange-500 mt-1">{perishableCount}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">Categories</p>
          <p className="text-2xl font-bold text-purple-600 dark:text-purple-400 mt-1">{categories.length}</p>
        </div>
      </div>

      {/* Category tabs */}
      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {allCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1.5 text-sm rounded-lg transition font-medium ${
                activeCategory === cat
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Add item form */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-4">{t("addItem")}</h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
            <option value="bundle">Bundle</option>
            <option value="dozen">Dozen</option>
          </select>
          <input type="text" placeholder="Category" value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
          <input type="number" step="0.01" placeholder={`Buy Price (${currency})`} value={form.cost_per_unit}
            onChange={(e) => setForm({ ...form, cost_per_unit: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <input type="number" step="0.01" placeholder={`Sell Price (${currency})`} value={form.sell_price}
            onChange={(e) => setForm({ ...form, sell_price: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
          <input type="number" step="0.01" placeholder={t("threshold")} value={form.min_threshold}
            onChange={(e) => setForm({ ...form, min_threshold: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <label className="flex items-center gap-2 px-3 py-3 text-sm text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={form.is_perishable}
              onChange={(e) => setForm({ ...form, is_perishable: e.target.checked })}
              className="rounded" />
            Perishable
          </label>
          <button type="submit" className="bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 transition font-medium col-span-2 md:col-span-4">
            {t("addItem")}
          </button>
        </form>
      </div>

      {/* Inventory table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">
            Stock Items {activeCategory !== "All" && <span className="text-sm font-normal text-gray-400">({activeCategory})</span>}
          </h2>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items..."
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[800px]">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("item")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Category</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("quantity")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("unit")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Buy</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Sell</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Margin</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("threshold")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {filtered.map((item) => {
                const buy = parseFloat(item.cost_per_unit);
                const sell = item.sell_price != null ? parseFloat(item.sell_price) : null;
                const margin = sell && buy > 0 ? Math.round(((sell - buy) / buy) * 100) : null;

                return (
                  <tr key={item.id} className={alertIds.has(item.id) ? "bg-red-50 dark:bg-red-900/20" : ""}>
                    {editId === item.id ? (
                      <>
                        <td className="px-6 py-3">
                          <input type="text" value={editData.name} onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-28" />
                        </td>
                        <td className="px-6 py-3">
                          <input type="text" value={editData.category} onChange={(e) => setEditData({ ...editData, category: e.target.value })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-24" />
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
                            <option value="bundle">bundle</option>
                            <option value="dozen">dozen</option>
                          </select>
                        </td>
                        <td className="px-6 py-3">
                          <input type="number" step="0.01" value={editData.cost_per_unit} onChange={(e) => setEditData({ ...editData, cost_per_unit: parseFloat(e.target.value) || 0 })}
                            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-20" />
                        </td>
                        <td className="px-6 py-3">
                          <input type="number" step="0.01" value={editData.sell_price} onChange={(e) => setEditData({ ...editData, sell_price: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                            placeholder="—"
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
                          {item.is_perishable && <span className="ml-1.5 px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400 text-[10px] rounded font-medium">Fresh</span>}
                          {alertIds.has(item.id) && <span className="ml-1.5 px-1.5 py-0.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[10px] rounded font-medium">Low</span>}
                        </td>
                        <td className="px-6 py-4 text-xs text-gray-500 dark:text-gray-400">{item.category || "General"}</td>
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
                        <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">{buy} {currency}</td>
                        <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
                          {sell != null ? `${sell} ${currency}` : "—"}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          {margin != null ? (
                            <span className={margin >= 0 ? "text-green-600 dark:text-green-400 font-medium" : "text-red-500 font-medium"}>
                              {margin >= 0 ? "+" : ""}{margin}%
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
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
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noInventoryYet")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Template Modal */}
      {showTemplateModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowTemplateModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-2">Load Inventory Template</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">Pre-load common items for your business type. Existing items won't be duplicated.</p>

            <div className="space-y-3">
              <button
                onClick={() => loadTemplate("veggie_shop")}
                disabled={templateLoading}
                className="w-full p-4 text-left border border-gray-200 dark:border-gray-600 rounded-xl hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 transition"
              >
                <p className="font-semibold text-gray-800 dark:text-white">Nepali Veggie Shop</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">40 items — vegetables, fruits, herbs, lentils. Kg-based, perishable tracking.</p>
              </button>

              <button
                onClick={() => loadTemplate("kiosk")}
                disabled={templateLoading}
                className="w-full p-4 text-left border border-gray-200 dark:border-gray-600 rounded-xl hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition"
              >
                <p className="font-semibold text-gray-800 dark:text-white">Danish Kiosk</p>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">50 items — beverages, snacks, tobacco, bakery. Piece-based with barcodes.</p>
              </button>
            </div>

            {templateLoading && (
              <p className="text-sm text-blue-600 dark:text-blue-400 mt-3 text-center">Loading template...</p>
            )}

            <button
              onClick={() => setShowTemplateModal(false)}
              className="w-full mt-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
