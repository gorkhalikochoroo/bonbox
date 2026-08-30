// Task #118 polish (Agent C): migrated H1 → PageHeader and the
// balance/in/out stat row → StatCard grid (red/green semantic accents
// preserved for cash-in vs cash-out where they're data-true).
// Behavior + i18n + a11y unchanged.
import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { displayCurrency, formatOwnerMoney } from "../utils/currency";
import { formatDate, formatDateShort, localIso } from "../utils/dateFormat";
import { FadeIn } from "../components/AnimationKit";
import { PageHeader, StatCard, Amount } from "../components/ui";
import { errText } from "../utils/errText";
import { useUndoToast } from "../hooks/useUndoToast";

const IN_CATEGORIES = ["Sales", "Tips", "Loan", "Other"];
const OUT_CATEGORIES = ["Purchase", "Wages", "Supplies", "Rent", "Other"];
const QUICK_AMOUNTS = [100, 500, 1000, 2500, 5000];
const CATEGORY_KEYS = { Sales: "catSales", Tips: "catTips", Loan: "catLoan", Other: "catOther", Purchase: "catPurchase", Wages: "catWages", Supplies: "catSupplies", Rent: "catRent" };

export default function CashBookPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const { show: showUndo, ToastUI: undoToastUI } = useUndoToast();
  const [transactions, setTransactions] = useState([]);
  const [balance, setBalance] = useState({ balance: 0, total_in: 0, total_out: 0 });
  const [tab, setTab] = useState("cash_in");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("");
  const [txnDate, setTxnDate] = useState(localIso());
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState("");

  const fetchData = (from, to) => {
    const params = {};
    if (from) params.from = from;
    if (to) params.to = to;
    api.get("/cashbook", { params }).then((res) => setTransactions(res.data)).catch(() => {});
    api.get("/cashbook/balance", { params }).then((res) => setBalance(res.data)).catch(() => {});
  };

  useEffect(() => { fetchData(); }, []);

  const submit = async (quickAmt) => {
    const value = quickAmt || parseFloat(amount);
    if (!value || !desc) return;
    setError("");
    try {
      await api.post("/cashbook", {
        date: txnDate,
        type: tab,
        amount: value,
        description: desc,
        category: category || null,
      });
      setAmount("");
      setDesc("");
      setCategory("");
      setTxnDate(localIso());
      trackEvent("cash_transaction", "cashbook", `${tab} ${value} ${currency}`);
      setSuccess(`${tab === "cash_in" ? "+" : "-"}${formatOwnerMoney(value, user?.currency, { decimals: 2 })}`);
      fetchData(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToAddTransaction")));
    }
  };

  const startEdit = (txn) => {
    setEditId(txn.id);
    setEditData({
      date: txn.date,
      amount: parseFloat(txn.amount),
      description: txn.description,
      type: txn.type,
      category: txn.category || "",
    });
  };

  const saveEdit = async () => {
    try {
      const payload = { ...editData };
      if (payload.amount === "") payload.amount = 0;
      await api.put(`/cashbook/${editId}`, payload);
      setEditId(null);
      fetchData(filterFrom, filterTo);
      setSuccess(t("updated"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToUpdate")));
    }
  };

  const deleteTxn = async (id) => {
    try {
      await api.delete(`/cashbook/${id}`);
      setDeleteConfirm(null);
      fetchData(filterFrom, filterTo);
      // NOTE: this page dispatches no bonbox-data-changed on delete (unlike
      // Sales/Expenses), so undo stays symmetric and doesn't either. If the
      // cash position ever feeds a cached figure, BOTH need the dispatch.
      showUndo({
        message: t("movedToDeleted"),
        onUndo: async () => {
          await api.put(`/cashbook/${id}/restore`);
          fetchData(filterFrom, filterTo);
        },
      });
    } catch (err) {
      setError(errText(err, t("failedToDelete")));
    }
  };

  // Calculate running balance
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || (a.created_at || "").localeCompare(b.created_at || ""));
  let runningBal = 0;
  const withBalance = sorted.map((txn) => {
    runningBal += txn.type === "cash_in" ? parseFloat(txn.amount) : -parseFloat(txn.amount);
    return { ...txn, runningBalance: runningBal };
  });
  const displayTxns = [...withBalance].reverse().filter(txn => !search || txn.description?.toLowerCase().includes(search.toLowerCase()) || txn.category?.toLowerCase().includes(search.toLowerCase()));

  const categories = tab === "cash_in" ? IN_CATEGORIES : OUT_CATEGORIES;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <FadeIn>
        <PageHeader eyebrow="MONEY" title={t("cashBook")} />
      </FadeIn>

      {success && <div className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {/* Balance Summary — value accent only when it's data-true
          (balance going negative = critical; cash-in vs cash-out
          colors are inherently semantic and preserved). */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label={t("cashBalance")}
          value={<Amount value={balance.balance} currency={currency} decimals={2} />}
          accent={balance.balance >= 0 ? "success" : "critical"}
        />
        <StatCard
          label={t("totalCashIn")}
          value={<Amount value={balance.total_in} currency={currency} decimals={2} sign />}
          accent="success"
        />
        <StatCard
          label={t("totalCashOut")}
          value={<Amount value={balance.total_out ? -balance.total_out : 0} currency={currency} decimals={2} />}
          accent="critical"
        />
      </div>

      {/* Quick Entry */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        {/* Tabs */}
        <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1 mb-5 w-fit">
          <button
            onClick={() => { setTab("cash_in"); setCategory(""); }}
            className={`px-5 py-2 rounded-md text-sm font-medium transition ${
              tab === "cash_in" ? "bg-gray-900 text-white" : "text-gray-600 dark:text-gray-300"
            }`}
          >
            {t("cashIn")}
          </button>
          <button
            onClick={() => { setTab("cash_out"); setCategory(""); }}
            className={`px-5 py-2 rounded-md text-sm font-medium transition ${
              tab === "cash_out" ? "bg-red-600 text-white" : "text-gray-600 dark:text-gray-300"
            }`}
          >
            {t("cashOut")}
          </button>
        </div>

        {/* Category */}
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">{t("category")}</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => { setCategory(c); setDesc(c); }}
              className={`px-4 py-2 rounded-xl text-sm font-medium border transition ${
                category === c
                  ? tab === "cash_in"
                    ? "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-900 text-gray-700 dark:text-gray-300"
                    : "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-600 text-red-700 dark:text-red-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {t(CATEGORY_KEYS[c]) || c}
            </button>
          ))}
        </div>

        {/* Description */}
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t("whatWasItFor")}
          className="max-w-sm px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl mb-4 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-700 dark:text-white"
        />

        {/* Quick amounts */}
        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              disabled={!desc}
              className={`px-5 py-3 rounded-xl border text-sm font-semibold transition disabled:opacity-30 ${
                tab === "cash_in"
                  ? "border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  : "border-red-200 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30"
              }`}
            >
              <Amount value={amt} currency={currency} />
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="flex gap-3">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t("customAmount")}
            className="flex-1 max-w-sm px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-700 dark:text-white"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={() => submit()}
            disabled={!amount || !desc}
            className={`px-6 py-3 text-white rounded-xl font-semibold transition disabled:opacity-40 ${
              tab === "cash_in" ? "bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white" : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {tab === "cash_in" ? t("addIn") : t("addOut")}
          </button>
        </div>

        {/* Date picker */}
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}:</label>
          <input
            type="date"
            value={txnDate}
            max={localIso()}
            onChange={(e) => setTxnDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          {txnDate !== localIso() && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">{t("backdatedEntry")}</span>
          )}
        </div>
      </div>

      {/* Transaction History */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("transactionHistory")}</h2>
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
              placeholder={t("search")}
              className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            {(filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterFrom(""); setFilterTo(""); fetchData(); }}
                className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium"
              >
                {t("clear")}
              </button>
            )}
            <button
              onClick={() => exportToCsv("cashbook.csv", transactions, [
                { key: "date", label: t("date") },
                { key: "type", label: t("type") },
                { key: "description", label: t("description") },
                { key: "category", label: t("category") },
                { key: "amount", label: t("amount") },
              ])}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              {t("exportCsv")}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("description")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("category")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("cashIn")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("cashOut")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("balance")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {displayTxns.slice(0, 50).map((txn) => (
                <tr key={txn.id}>
                  {editId === txn.id ? (
                    <>
                      <td className="px-4 py-3">
                        <input type="date" value={editData.date} onChange={(e) => setEditData({ ...editData, date: e.target.value })}
                          className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-32" />
                      </td>
                      <td className="px-4 py-3">
                        <input type="text" value={editData.description} onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                          className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-28" />
                      </td>
                      <td className="px-4 py-3">
                        <input type="text" value={editData.category} onChange={(e) => setEditData({ ...editData, category: e.target.value })}
                          className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-20" />
                      </td>
                      <td className="px-4 py-3" colSpan={2}>
                        <div className="flex items-center gap-2">
                          <select value={editData.type} onChange={(e) => setEditData({ ...editData, type: e.target.value })}
                            className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white">
                            <option value="cash_in">{t("cashIn")}</option>
                            <option value="cash_out">{t("cashOut")}</option>
                          </select>
                          <input type="number" value={editData.amount} onChange={(e) => setEditData({ ...editData, amount: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                            className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-24" />
                        </div>
                      </td>
                      <td className="px-4 py-3"></td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={saveEdit} className="text-emerald-600 dark:text-gray-300 text-sm font-medium hover:underline">{t("save")}</button>
                        <button onClick={() => setEditId(null)} className="text-gray-400 text-sm hover:underline">{t("cancel")}</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={`px-4 py-3 text-sm ${txn.reference_id ? "text-gray-400 dark:text-gray-500" : "text-gray-700 dark:text-gray-300"}`}>{formatDate(txn.date)}</td>
                      <td className={`px-4 py-3 text-sm ${txn.reference_id ? "text-gray-400 dark:text-gray-500" : "text-gray-700 dark:text-gray-300"}`}>
                        {txn.description}
                        {txn.reference_id && <span className="ml-1.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded">({t("autoTag")})</span>}
                      </td>
                      <td className={`px-4 py-3 text-sm ${txn.reference_id ? "text-gray-400 dark:text-gray-500" : "text-gray-500 dark:text-gray-400"}`}>{txn.category || "-"}</td>
                      <td className={`px-4 py-3 text-sm text-right font-semibold ${txn.reference_id ? "text-gray-300 dark:text-emerald-600" : "text-emerald-600 dark:text-gray-300"}`}>
                        {txn.type === "cash_in" ? <Amount value={parseFloat(txn.amount)} currency={currency} decimals={2} sign /> : ""}
                      </td>
                      <td className={`px-4 py-3 text-sm text-right font-semibold ${txn.reference_id ? "text-red-400 dark:text-red-600" : "text-red-600 dark:text-red-400"}`}>
                        {txn.type === "cash_out" ? <Amount value={-parseFloat(txn.amount)} currency={currency} decimals={2} /> : ""}
                      </td>
                      <td className={`px-4 py-3 text-sm text-right font-bold ${txn.runningBalance >= 0 ? "text-gray-800 dark:text-white" : "text-red-600 dark:text-red-400"}`}>
                        <Amount value={txn.runningBalance} currency={currency} decimals={2} />
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        {txn.reference_id ? (
                          <span className="text-xs text-gray-400 dark:text-gray-500 italic">{t("autoSynced")}</span>
                        ) : (
                          <>
                            <button onClick={() => startEdit(txn)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">{t("edit")}</button>
                            {deleteConfirm === txn.id ? (
                              <span className="inline-flex items-center gap-1.5 bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded-lg">
                                <span className="text-xs text-red-600 dark:text-red-400">{t("delete")}?</span>
                                <button onClick={() => deleteTxn(txn.id)} className="text-red-600 dark:text-red-400 text-xs font-bold hover:underline">&#x2713;</button>
                                <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-xs font-bold hover:underline">&#x2715;</button>
                              </span>
                            ) : (
                              <button onClick={() => setDeleteConfirm(txn.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">{t("moveToTrash")}</button>
                            )}
                          </>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noCashTransactionsYet")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {undoToastUI}
    </div>
  );
}
