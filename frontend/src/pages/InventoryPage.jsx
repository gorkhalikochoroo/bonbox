import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

export default function InventoryPage() {
  const { t } = useLanguage();
  const [items, setItems] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [form, setForm] = useState({ name: "", quantity: "", unit: "pieces", cost_per_unit: "", min_threshold: "" });
  const [error, setError] = useState("");

  const fetchData = () => {
    api.get("/inventory").then((res) => setItems(res.data));
    api.get("/inventory/alerts").then((res) => setAlerts(res.data));
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
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add item");
    }
  };

  const alertIds = new Set(alerts.map((a) => a.id));

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">{t("inventoryMonitor")}</h1>

      {alerts.length > 0 && (
        <div className="bg-red-50 border border-red-200 p-4 rounded-xl">
          <p className="text-red-700 font-medium">{t("lowStockAlerts")}: {alerts.map((a) => a.name).join(", ")}</p>
        </div>
      )}

      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-lg font-semibold text-gray-700 mb-4">{t("addItem")}</h2>
        {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <input type="text" placeholder={t("itemName")} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg" required />
          <input type="number" step="0.01" placeholder={t("quantity")} value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg" required />
          <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg">
            <option value="pieces">{t("pieces")}</option>
            <option value="kg">{t("kg")}</option>
            <option value="liters">{t("liters")}</option>
            <option value="boxes">{t("boxes")}</option>
          </select>
          <input type="number" step="0.01" placeholder={t("costPerUnit")} value={form.cost_per_unit}
            onChange={(e) => setForm({ ...form, cost_per_unit: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg" required />
          <input type="number" step="0.01" placeholder={t("threshold")} value={form.min_threshold}
            onChange={(e) => setForm({ ...form, min_threshold: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-lg" required />
          <button type="submit" className="bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition font-medium md:col-span-5">
            {t("addItem")}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("item")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("quantity")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("unit")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("costPerUnit")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("threshold")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((item) => (
              <tr key={item.id} className={alertIds.has(item.id) ? "bg-red-50" : ""}>
                <td className="px-6 py-4 text-sm text-gray-700 font-medium">{item.name}</td>
                <td className="px-6 py-4 text-sm text-gray-800">{parseFloat(item.quantity)}</td>
                <td className="px-6 py-4 text-sm text-gray-600">{item.unit}</td>
                <td className="px-6 py-4 text-sm text-gray-600">{parseFloat(item.cost_per_unit)} DKK</td>
                <td className="px-6 py-4 text-sm text-gray-600">{parseFloat(item.min_threshold)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-400">{t("noInventoryYet")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
