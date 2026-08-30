/**
 * Recently Deleted — the recovery surface for the four soft-deleted domains.
 *
 * Fixed here after looking at it on an actual phone:
 *
 *   • Money bypassed the app's own formatter. `Number(x).toLocaleString()`
 *     uses the BROWSER's locale, not the account's, and appended the raw
 *     currency code — so 1234 kr rendered as "1,234 DKK". In Danish that
 *     comma is a DECIMAL separator, so the figure reads as one-point-two-
 *     three-four kroner, on the one screen where you decide whether to
 *     destroy a transaction permanently. formatOwnerMoney is the single
 *     source of truth (DKK → formatKr → "1.234 kr.") and every other money
 *     surface already goes through it.
 *   • You could not tell which tab held anything without opening all four.
 *     The counts load up front now, so the page answers "is anything
 *     recoverable?" at a glance — which is the only question it exists for.
 *   • "Amount: X · Deleted: Y" reflowed so the "·" dangled at the end of a
 *     line on a 402pt screen. The lines are stacked instead.
 *   • Restore was grey and "Delete Forever" was a filled red block — the
 *     irreversible action was the biggest, brightest target on the RECOVERY
 *     page. Emphasis swapped: restoring is the primary action here.
 */
import { useState, useEffect } from "react";
import { useToast } from "../hooks/useToast";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { formatOwnerMoney } from "../utils/currency";
import { formatDate } from "../utils/dateFormat";

/** Endpoint base per tab — cashbook is the one that isn't its own plural. */
const endpointFor = (tab) => (tab === "cashbook" ? "/cashbook" : `/${tab}`);

export default function RecentlyDeletedPage() {
  const toast = useToast();
  const { user } = useAuth();
  const { t } = useLanguage();
  const confirm = useConfirm();
  const [tab, setTab] = useState("sales");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({});

  /** Clearing here (an event handler) rather than in the effect keeps the old
   *  tab's rows from sitting under the new tab's heading while it loads. */
  const selectTab = (key) => {
    if (key === tab) return;
    setTab(key);
    setItems([]);
    setLoading(true);
  };

  const tabs = [
    { key: "sales", label: t("sales") },
    { key: "expenses", label: t("expenses") },
    { key: "waste", label: t("waste") },
    { key: "cashbook", label: t("cashBook") },
  ];

  // Bumped by restore / permanent-delete to re-run both loads. Reloading via
  // a key rather than an imperative fetch() keeps every setState in an event
  // handler or an async continuation, never in an effect body.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  // The `alive` guard is not ceremony: tapping through the four tabs quickly
  // can land an earlier response after a later one and show the wrong domain's
  // rows under the wrong tab.
  useEffect(() => {
    let alive = true;
    (async () => {
      let next = [];
      try {
        const res = await api.get(`${endpointFor(tab)}/recently-deleted`);
        next = Array.isArray(res.data) ? res.data : [];
      } catch {
        next = [];
      }
      if (!alive) return;
      setItems(next);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [tab, reloadKey]);

  /** One pass over all four so the tabs can show where things actually are. */
  useEffect(() => {
    let alive = true;
    (async () => {
      const keys = ["sales", "expenses", "waste", "cashbook"];
      const results = await Promise.all(
        keys.map((k) =>
          api
            .get(`${endpointFor(k)}/recently-deleted`)
            .then((r) => (Array.isArray(r.data) ? r.data.length : 0))
            // A failing domain must not blank the other three — null renders
            // as no badge, honest about "we don't know" rather than "0".
            .catch(() => null),
        ),
      );
      if (!alive) return;
      setCounts(Object.fromEntries(keys.map((k, i) => [k, results[i]])));
    })();
    return () => { alive = false; };
  }, [reloadKey]);

  const restore = async (id) => {
    try {
      await api.put(`${endpointFor(tab)}/${id}/restore`);
      // Restoring a sale or an expense moves revenue, profit and the MOMS
      // input VAT — the dashboard hero and KPI strip read cached figures.
      window.dispatchEvent(new Event("bonbox-data-changed"));
      reload();
    } catch {
      toast({ message: t("failedToRestore"), severity: "critical" });
    }
  };

  const permanentDelete = async (id) => {
    if (!(await confirm({ message: t("permanentDeleteConfirm"), destructive: true }))) return;
    try {
      await api.delete(`${endpointFor(tab)}/${id}/permanent`);
      reload();
    } catch {
      toast({ message: t("failedToDelete"), severity: "critical" });
    }
  };

  const renderItem = (item) => {
    let info = "";
    switch (tab) {
      case "sales":
        info = `${formatDate(item.date)} — ${item.payment_method || "mixed"}`;
        break;
      case "expenses":
        info = `${formatDate(item.date)} — ${item.description}`;
        break;
      case "waste":
        info = `${formatDate(item.date)} — ${item.item_name} (${item.quantity} ${item.unit})`;
        break;
      case "cashbook":
        info = `${formatDate(item.date)} — ${item.description} (${item.type})`;
        break;
    }
    // Waste carries its value as estimated_cost, not amount.
    const value = tab === "waste" ? item.estimated_cost : item.amount;
    const amount = formatOwnerMoney(value, user?.currency);
    const deletedAt = item.deleted_at ? formatDate(item.deleted_at.split("T")[0]) : "";

    return (
      <div
        key={item.id}
        className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white break-words">{info}</p>
          <p data-testid="deleted-item-amount" className="text-sm font-semibold text-gray-900 dark:text-white mt-0.5">{amount}</p>
          {deletedAt && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t("deleted")}: {deletedAt}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => restore(item.id)}
            className="flex-1 sm:flex-none px-4 py-2 min-h-[44px] sm:min-h-0 text-xs font-semibold bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg hover:bg-gray-800 dark:hover:bg-gray-100 transition"
          >
            {t("restore")}
          </button>
          <button
            onClick={() => permanentDelete(item.id)}
            className="flex-1 sm:flex-none px-4 py-2 min-h-[44px] sm:min-h-0 text-xs font-medium text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition"
          >
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
        {tabs.map((tb) => {
          const n = counts[tb.key];
          return (
            <button
              key={tb.key}
              onClick={() => selectTab(tb.key)}
              className={`px-4 py-2 min-h-[44px] sm:min-h-0 rounded-xl text-sm font-medium inline-flex items-center gap-2 ${
                tab === tb.key
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
              }`}
            >
              {tb.label}
              {n > 0 && (
                <span
                  className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${
                    tab === tb.key
                      ? "bg-white/25 text-white"
                      : "bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200"
                  }`}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
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
