import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";

export default function RecentlyDeletedPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const [dark] = useDarkMode();
  const { t } = useLanguage();
  const [tab, setTab] = useState("sales");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const tabs = [
    { key: "sales", label: t("sales") },
    { key: "expenses", label: t("expenses") },
    { key: "waste", label: t("waste") },
    { key: "cashbook", label: t("cashBook") },
  ];

  const fetchDeleted = async () => {
    setLoading(true);
    try {
      const endpoint = tab === "cashbook" ? "/cashbook/recently-deleted" : `/${tab}/recently-deleted`;
      const res = await api.get(endpoint);
      setItems(res.data);
    } catch {
      setItems([]);
    }
    setLoading(false);
  };

  useEffect(() => { fetchDeleted(); }, [tab]);

  const restore = async (id) => {
    try {
      const endpoint = tab === "cashbook" ? `/cashbook/${id}/restore` : `/${tab}/${id}/restore`;
      await api.put(endpoint);
      fetchDeleted();
    } catch (err) {
      alert(t("failedToRestore"));
    }
  };

  const permanentDelete = async (id) => {
    if (!confirm(t("permanentDeleteConfirm"))) return;
    try {
      const endpoint = tab === "cashbook" ? `/cashbook/${id}/permanent` : `/${tab}/${id}/permanent`;
      await api.delete(endpoint);
      fetchDeleted();
    } catch (err) {
      alert(t("failedToDelete"));
    }
  };

  const renderItem = (item) => {
    let info = "";
    let amount = "";
    switch (tab) {
      case "sales":
        info = `${item.date} — ${item.payment_method || "mixed"}`;
        amount = `${Number(item.amount).toLocaleString()} ${currency}`;
        break;
      case "expenses":
        info = `${item.date} — ${item.description}`;
        amount = `${Number(item.amount).toLocaleString()} ${currency}`;
        break;
      case "waste":
        info = `${item.date} — ${item.item_name} (${item.quantity} ${item.unit})`;
        amount = `${Number(item.estimated_cost).toLocaleString()} ${currency}`;
        break;
      case "cashbook":
        info = `${item.date} — ${item.description} (${item.type})`;
        amount = `${Number(item.amount).toLocaleString()} ${currency}`;
        break;
    }
    const deletedAt = item.deleted_at ? new Date(item.deleted_at).toLocaleDateString() : "";

    return (
      <div key={item.id} className="flex items-center justify-between p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-white">{info}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("amount")}: {amount} · {t("deleted")}: {deletedAt}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => restore(item.id)}
            className="px-3 py-1.5 text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-lg hover:bg-green-200 dark:hover:bg-green-900/50">
            {t("restore")}
          </button>
          <button onClick={() => permanentDelete(item.id)}
            className="px-3 py-1.5 text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-200 dark:hover:bg-red-900/50">
            {t("deleteForever")}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t("recentlyDeleted")}</h1>
      <div className="flex gap-2 flex-wrap">
        {tabs.map((tb) => (
          <button key={tb.key} onClick={() => setTab(tb.key)}
            className={`px-4 py-2 rounded-xl text-sm font-medium ${
              tab === tb.key
                ? "bg-blue-600 text-white"
                : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
            }`}>{tb.label}</button>
        ))}
      </div>

      {loading ? (
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">{t("loading")}</p>
      ) : items.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">{t("noDeletedItems")}</p>
      ) : (
        <div className="space-y-3">
          {items.map(renderItem)}
        </div>
      )}
    </div>
  );
}
