import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";

const TEMPLATES = [
  { type: "restaurant", name: "Restaurant & Cafe", icon: "🍽️", count: 45, desc: "Ingredients, beverages, sauces, supplies. Fresh produce & meat tracking.", color: "orange" },
  { type: "veggie_shop", name: "Dukan / Veggie Shop", icon: "🥬", count: 40, desc: "Vegetables, fruits, herbs, lentils. Kg-based with daily pricing.", color: "green" },
  { type: "kiosk", name: "Danish Kiosk", icon: "🏪", count: 50, desc: "Beverages, snacks, tobacco, bakery, lottery. Piece-based with barcodes.", color: "blue" },
  { type: "grocery", name: "Grocery / Mini-Mart", icon: "🛒", count: 45, desc: "Packaged food, dairy, household, personal care, spices. Mixed units.", color: "yellow" },
  { type: "clothing", name: "Clothing Store", icon: "👕", count: 40, desc: "Tops, bottoms, dresses, footwear, accessories. Size-based variants.", color: "purple" },
  { type: "pharmacy", name: "Pharmacy", icon: "💊", count: 45, desc: "Medicines, vitamins, first aid, devices, hygiene. Expiry tracking.", color: "red" },
  { type: "electronics", name: "Electronics & Mobile", icon: "📱", count: 35, desc: "Chargers, cables, audio, phone accessories, computer gear, batteries.", color: "cyan" },
];

const COLOR_MAP = {
  orange: { border: "hover:border-orange-400", bg: "hover:bg-orange-50 dark:hover:bg-orange-900/20" },
  green: { border: "hover:border-green-400", bg: "hover:bg-green-50 dark:hover:bg-green-900/20" },
  blue: { border: "hover:border-blue-400", bg: "hover:bg-blue-50 dark:hover:bg-blue-900/20" },
  yellow: { border: "hover:border-yellow-400", bg: "hover:bg-yellow-50 dark:hover:bg-yellow-900/20" },
  purple: { border: "hover:border-purple-400", bg: "hover:bg-purple-50 dark:hover:bg-purple-900/20" },
  red: { border: "hover:border-red-400", bg: "hover:bg-red-50 dark:hover:bg-red-900/20" },
  cyan: { border: "hover:border-cyan-400", bg: "hover:bg-cyan-50 dark:hover:bg-cyan-900/20" },
};

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
  const [templateLoaded, setTemplateLoaded] = useState(null);
  const [templateFilter, setTemplateFilter] = useState(null); // categories from last loaded template

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
      // First fetch template definition to get categories (works even if items already exist)
      const tmplRes = await api.get("/inventory/templates", { params: { template_type: templateType } });
      const tmplCats = [...new Set(tmplRes.data.map((tp) => tp.default_category || "General"))].sort();

      const res = await api.post("/inventory/templates/load", { template_type: templateType });
      setTemplateLoaded(templateType);

      // Filter categories to this template's categories
      if (tmplCats.length > 0) {
        setTemplateFilter(tmplCats);
        setActiveCategory("All");
      }
      fetchData(); // refresh items + categories behind the panel
      const count = res.data.length;
      setSuccess(count > 0 ? `Loaded ${count} items from template!` : "All items already in your inventory.");
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
    // Filter by template categories if active
    if (templateFilter && activeCategory === "All") {
      list = list.filter((i) => templateFilter.includes(i.category || "General"));
    }
    if (activeCategory !== "All") {
      list = list.filter((i) => (i.category || "General") === activeCategory);
    }
    if (search) {
      list = list.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()));
    }
    return list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  }, [items, activeCategory, search, templateFilter]);

  // Auto-calculated financials
  const stats = useMemo(() => {
    let totalCost = 0, totalRevenue = 0, itemsWithMargin = 0, totalMarginPct = 0;
    items.forEach((i) => {
      const qty = parseFloat(i.quantity);
      const buy = parseFloat(i.cost_per_unit);
      const sell = i.sell_price != null ? parseFloat(i.sell_price) : null;
      totalCost += qty * buy;
      if (sell != null) {
        totalRevenue += qty * sell;
        if (buy > 0) {
          totalMarginPct += ((sell - buy) / buy) * 100;
          itemsWithMargin++;
        }
      }
    });
    const totalProfit = totalRevenue - totalCost;
    const avgMargin = itemsWithMargin > 0 ? Math.round(totalMarginPct / itemsWithMargin) : 0;
    return { totalCost, totalRevenue, totalProfit, avgMargin, itemsWithMargin };
  }, [items]);

  const perishableCount = items.filter((i) => i.is_perishable).length;
  const displayCategories = templateFilter
    ? ["All", ...categories.filter((c) => templateFilter.includes(c))]
    : ["All", ...categories];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("inventoryMonitor")}</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowTemplateModal(true)}
            className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition font-medium"
          >
            {t("loadTemplate")}
          </button>
        </div>
      </div>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {alerts.length > 0 && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 p-4 rounded-xl">
          <p className="text-red-700 dark:text-red-300 font-medium text-sm">{t("lowStockAlerts")}: {alerts.length} {t("itemsBelowMinStock")}</p>
        </div>
      )}

      {/* Financial overview — auto-calculated from buy/sell prices */}
      <div className="bg-gradient-to-r from-blue-50 to-emerald-50 dark:from-gray-800 dark:to-gray-800 p-5 rounded-2xl border border-blue-100 dark:border-gray-700">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">{t("stockCost")}</p>
            <p className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-white mt-1">{stats.totalCost.toLocaleString()}</p>
            <p className="text-xs text-gray-400">{currency} {t("invested")}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">{t("potentialRevenue")}</p>
            <p className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{stats.totalRevenue.toLocaleString()}</p>
            <p className="text-xs text-gray-400">{currency} {t("ifAllSold")}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">{t("potentialProfit")}</p>
            <p className={`text-xl sm:text-2xl font-bold mt-1 ${stats.totalProfit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
              {stats.totalProfit >= 0 ? "+" : ""}{stats.totalProfit.toLocaleString()}
            </p>
            <p className="text-xs text-gray-400">{currency} {t("margin")}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">{t("avgMargin")}</p>
            <p className={`text-xl sm:text-2xl font-bold mt-1 ${stats.avgMargin >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
              {stats.avgMargin}%
            </p>
            <p className="text-xs text-gray-400">{stats.itemsWithMargin} {t("itemsPriced")}</p>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("totalItems")}</p>
          <p className="text-2xl font-bold text-gray-800 dark:text-white mt-1">{items.length}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("lowStock")}</p>
          <p className={`text-2xl font-bold mt-1 ${alerts.length > 0 ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>{alerts.length}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("freshItems")}</p>
          <p className="text-2xl font-bold text-orange-500 mt-1">{perishableCount}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("categories")}</p>
          <p className="text-2xl font-bold text-purple-600 dark:text-purple-400 mt-1">{categories.length}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("priced")}</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{stats.itemsWithMargin}/{items.length}</p>
        </div>
      </div>

      {/* Category tabs */}
      {categories.length > 0 && (
        <div>
          {templateFilter && (
            <div className="flex items-center gap-2 mb-2">
              <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                {t("filteredBy")}: {TEMPLATES.find((tp) => tp.type === templateLoaded)?.name || "Template"}
              </p>
              <button
                onClick={() => { setTemplateFilter(null); setActiveCategory("All"); }}
                className="text-xs text-gray-400 hover:text-red-500 transition"
              >
                ✕ {t("showAll")}
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {displayCategories.map((cat) => (
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
            <option value="bundle">{t("bundle")}</option>
            <option value="dozen">{t("dozen")}</option>
          </select>
          <input type="text" placeholder={t("categoryPlaceholder")} value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
          <input type="number" step="0.01" placeholder={`Cost (${currency})`} value={form.cost_per_unit}
            onChange={(e) => setForm({ ...form, cost_per_unit: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <input type="number" step="0.01" placeholder={`Sell Price (${currency})`} value={form.sell_price}
            onChange={(e) => setForm({ ...form, sell_price: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" />
          <input type="number" step="0.01" placeholder={t("minStock")} value={form.min_threshold}
            onChange={(e) => setForm({ ...form, min_threshold: e.target.value })}
            className="px-3 py-3 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg" required />
          <label className="flex items-center gap-2 px-3 py-3 text-sm text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={form.is_perishable}
              onChange={(e) => setForm({ ...form, is_perishable: e.target.checked })}
              className="rounded" />
            {t("freshItem")}
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
            {t("stockItems")} {activeCategory !== "All" && <span className="text-sm font-normal text-gray-400">({activeCategory})</span>}
          </h2>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchItems")}
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[800px]">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("item")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("category")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("quantity")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("unit")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("cost")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("sell")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("margin")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("profit")}</th>
                <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {filtered.map((item) => {
                const qty = parseFloat(item.quantity);
                const buy = parseFloat(item.cost_per_unit);
                const sell = item.sell_price != null ? parseFloat(item.sell_price) : null;
                const margin = sell && buy > 0 ? Math.round(((sell - buy) / buy) * 100) : null;
                const profit = sell != null ? (sell - buy) * qty : null;

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
                            <option value="pieces">{t("pieces")}</option>
                            <option value="kg">{t("kg")}</option>
                            <option value="liters">{t("liters")}</option>
                            <option value="boxes">{t("boxes")}</option>
                            <option value="bundle">{t("bundle")}</option>
                            <option value="dozen">{t("dozen")}</option>
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
                        <td className="px-6 py-3 text-sm text-gray-500">—</td>
                        <td className="px-6 py-3 text-right space-x-2">
                          <button onClick={saveEdit} className="text-green-600 dark:text-green-400 text-sm font-medium hover:underline">{t("save")}</button>
                          <button onClick={() => setEditId(null)} className="text-gray-400 text-sm hover:underline">{t("cancel")}</button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300 font-medium">
                          {item.name}
                          {alertIds.has(item.id) && <span className="ml-1.5 px-1.5 py-0.5 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[10px] rounded font-medium">Low</span>}
                        </td>
                        <td className="px-6 py-4 text-xs text-gray-500 dark:text-gray-400">{item.category || "General"}</td>
                        <td className="px-6 py-4 text-sm font-semibold text-gray-800 dark:text-white">
                          {qty}
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
                        <td className="px-6 py-4 text-sm">
                          {profit != null ? (
                            <span className={profit >= 0 ? "text-green-600 dark:text-green-400 font-medium" : "text-red-500 font-medium"}>
                              {profit >= 0 ? "+" : ""}{profit.toLocaleString()}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right space-x-3">
                          <button onClick={() => startEdit(item)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">{t("edit")}</button>
                          {deleteConfirm === item.id ? (
                            <span className="inline-flex items-center gap-1.5 bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded-lg">
                              <span className="text-xs text-red-600 dark:text-red-400">{t("delete")}?</span>
                              <button onClick={() => deleteItem(item.id)} className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded hover:bg-red-700">{t("delete")}</button>
                              <button onClick={() => setDeleteConfirm(null)} className="bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300 text-xs font-bold px-2 py-0.5 rounded hover:bg-gray-300">&#10005;</button>
                            </span>
                          ) : (
                            <button onClick={() => setDeleteConfirm(item.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">{t("delete")}</button>
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

      {/* Template Side Panel */}
      {showTemplateModal && (
        <div className="fixed inset-0 bg-black/30 z-50 flex justify-end" onClick={() => { setShowTemplateModal(false); setTemplateLoaded(null); }}>
          <div
            className="bg-white dark:bg-gray-800 shadow-2xl w-full max-w-sm h-full overflow-y-auto p-6 animate-slideIn"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "slideIn 0.25s ease-out" }}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-gray-800 dark:text-white">{t("loadTemplate")}</h3>
              <button onClick={() => { setShowTemplateModal(false); setTemplateLoaded(null); }} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">Pick a template. Items already in your inventory won't be duplicated.</p>

            <div className="space-y-2.5">
              {TEMPLATES.map((tmpl) => {
                const c = COLOR_MAP[tmpl.color];
                const isLoaded = templateLoaded === tmpl.type;
                return (
                  <button
                    key={tmpl.type}
                    onClick={() => loadTemplate(tmpl.type)}
                    disabled={templateLoading}
                    className={`w-full p-4 text-left border rounded-xl transition ${isLoaded ? "border-green-400 bg-green-50 dark:bg-green-900/20" : `border-gray-200 dark:border-gray-600 ${c.border} ${c.bg}`}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{tmpl.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-gray-800 dark:text-white">{tmpl.name}</p>
                          <span className="text-xs text-gray-400">{tmpl.count} items</span>
                          {isLoaded && <span className="text-xs text-green-600 dark:text-green-400 font-medium">✓ Loaded</span>}
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{tmpl.desc}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {templateLoading && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <svg className="animate-spin h-4 w-4 text-blue-600" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                <p className="text-sm text-blue-600 dark:text-blue-400">Loading template...</p>
              </div>
            )}

            <button
              onClick={() => { setShowTemplateModal(false); setTemplateLoaded(null); }}
              className="w-full mt-5 py-2.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 border border-gray-200 dark:border-gray-600 rounded-lg"
            >
              Done
            </button>
          </div>
        </div>
      )}
      <style>{`@keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
    </div>
  );
}
