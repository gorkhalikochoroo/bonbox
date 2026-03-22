import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";

const IN_CATEGORIES = ["Sales", "Tips", "Loan", "Other"];
const OUT_CATEGORIES = ["Purchase", "Wages", "Supplies", "Rent", "Other"];
const QUICK_AMOUNTS = [100, 500, 1000, 2500, 5000];

export default function CashBookPage() {
  const { t } = useLanguage();
  const [transactions, setTransactions] = useState([]);
  const [balance, setBalance] = useState({ balance: 0, total_in: 0, total_out: 0 });
  const [tab, setTab] = useState("cash_in");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("");
  const [txnDate, setTxnDate] = useState(new Date().toISOString().split("T")[0]);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);

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
      setTxnDate(new Date().toISOString().split("T")[0]);
      trackEvent("cash_transaction", "cashbook", `${tab} ${value} DKK`);
      setSuccess(`${tab === "cash_in" ? "+" : "-"}${value.toLocaleString()} DKK`);
      fetchData(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add transaction");
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
      await api.put(`/cashbook/${editId}`, editData);
      setEditId(null);
      fetchData(filterFrom, filterTo);
      setSuccess("Updated!");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update");
    }
  };

  const deleteTxn = async (id) => {
    try {
      await api.delete(`/cashbook/${id}`);
      setDeleteConfirm(null);
      fetchData(filterFrom, filterTo);
      setSuccess("Moved to recently deleted");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to delete");
    }
  };

  // Calculate running balance
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let runningBal = 0;
  const withBalance = sorted.map((txn) => {
    runningBal += txn.type === "cash_in" ? parseFloat(txn.amount) : -parseFloat(txn.amount);
    return { ...txn, runningBalance: runningBal };
  });
  const displayTxns = [...withBalance].reverse();

  const categories = tab === "cash_in" ? IN_CATEGORIES : OUT_CATEGORIES;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Cash Book</h1>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {/* Balance Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">Cash Balance</p>
          <p className={`text-3xl font-bold mt-1 ${balance.balance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
            {balance.balance.toLocaleString()} DKK
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Cash In</p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">+{balance.total_in.toLocaleString()} DKK</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Cash Out</p>
          <p className="text-2xl font-bold text-red-600 dark:text-red-400 mt-1">-{balance.total_out.toLocaleString()} DKK</p>
        </div>
      </div>

      {/* Quick Entry */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        {/* Tabs */}
        <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1 mb-5 w-fit">
          <button
            onClick={() => { setTab("cash_in"); setCategory(""); }}
            className={`px-5 py-2 rounded-md text-sm font-medium transition ${
              tab === "cash_in" ? "bg-green-600 text-white" : "text-gray-600 dark:text-gray-300"
            }`}
          >
            Cash In
          </button>
          <button
            onClick={() => { setTab("cash_out"); setCategory(""); }}
            className={`px-5 py-2 rounded-md text-sm font-medium transition ${
              tab === "cash_out" ? "bg-red-600 text-white" : "text-gray-600 dark:text-gray-300"
            }`}
          >
            Cash Out
          </button>
        </div>

        {/* Category */}
        <p className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Category</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-4 py-2 rounded-xl text-sm font-medium border transition ${
                category === c
                  ? tab === "cash_in"
                    ? "bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-600 text-green-700 dark:text-green-300"
                    : "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-600 text-red-700 dark:text-red-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Description */}
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What was it for?"
          className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
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
                  ? "border-green-200 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30"
                  : "border-red-200 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30"
              }`}
            >
              {amt.toLocaleString()} DKK
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="flex gap-3">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Custom amount"
            className="flex-1 px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={() => submit()}
            disabled={!amount || !desc}
            className={`px-6 py-3 text-white rounded-xl font-semibold transition disabled:opacity-40 ${
              tab === "cash_in" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {tab === "cash_in" ? "Add In" : "Add Out"}
          </button>
        </div>

        {/* Date picker */}
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}:</label>
          <input
            type="date"
            value={txnDate}
            max={new Date().toISOString().split("T")[0]}
            onChange={(e) => setTxnDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {txnDate !== new Date().toISOString().split("T")[0] && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Backdated entry</span>
          )}
        </div>
      </div>

      {/* Transaction History */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">Transaction History</h2>
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
            {(filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterFrom(""); setFilterTo(""); fetchData(); }}
                className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => exportToCsv("cashbook.csv", transactions, [
                { key: "date", label: "Date" },
                { key: "type", label: "Type" },
                { key: "description", label: "Description" },
                { key: "category", label: "Category" },
                { key: "amount", label: "Amount" },
              ])}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              Export CSV
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Description</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Category</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Cash In</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Cash Out</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Balance</th>
                <th className="px-4 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Actions</th>
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
                            <option value="cash_in">In</option>
                            <option value="cash_out">Out</option>
                          </select>
                          <input type="number" value={editData.amount} onChange={(e) => setEditData({ ...editData, amount: parseFloat(e.target.value) || 0 })}
                            className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded text-sm dark:bg-gray-700 dark:text-white w-24" />
                        </div>
                      </td>
                      <td className="px-4 py-3"></td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={saveEdit} className="text-green-600 dark:text-green-400 text-sm font-medium hover:underline">Save</button>
                        <button onClick={() => setEditId(null)} className="text-gray-400 text-sm hover:underline">Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={`px-4 py-3 text-sm ${txn.reference_id ? "text-gray-400 dark:text-gray-500" : "text-gray-700 dark:text-gray-300"}`}>{txn.date}</td>
                      <td className={`px-4 py-3 text-sm ${txn.reference_id ? "text-gray-400 dark:text-gray-500" : "text-gray-700 dark:text-gray-300"}`}>
                        {txn.description}
                        {txn.reference_id && <span className="ml-1.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded">(auto)</span>}
                      </td>
                      <td className={`px-4 py-3 text-sm ${txn.reference_id ? "text-gray-400 dark:text-gray-500" : "text-gray-500 dark:text-gray-400"}`}>{txn.category || "-"}</td>
                      <td className={`px-4 py-3 text-sm text-right font-semibold ${txn.reference_id ? "text-green-400 dark:text-green-600" : "text-green-600 dark:text-green-400"}`}>
                        {txn.type === "cash_in" ? `+${parseFloat(txn.amount).toLocaleString()}` : ""}
                      </td>
                      <td className={`px-4 py-3 text-sm text-right font-semibold ${txn.reference_id ? "text-red-400 dark:text-red-600" : "text-red-600 dark:text-red-400"}`}>
                        {txn.type === "cash_out" ? `-${parseFloat(txn.amount).toLocaleString()}` : ""}
                      </td>
                      <td className={`px-4 py-3 text-sm text-right font-bold ${txn.runningBalance >= 0 ? "text-gray-800 dark:text-white" : "text-red-600 dark:text-red-400"}`}>
                        {txn.runningBalance.toLocaleString()} DKK
                      </td>
                      <td className="px-4 py-3 text-right space-x-2">
                        {txn.reference_id ? (
                          <span className="text-xs text-gray-400 dark:text-gray-500 italic">Auto-synced</span>
                        ) : (
                          <>
                            <button onClick={() => startEdit(txn)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">Edit</button>
                            {deleteConfirm === txn.id ? (
                              <>
                                <button onClick={() => deleteTxn(txn.id)} className="text-red-600 dark:text-red-400 text-sm font-medium hover:underline">Yes, move</button>
                                <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-sm hover:underline">No</button>
                              </>
                            ) : (
                              <button onClick={() => setDeleteConfirm(txn.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">Move to trash</button>
                            )}
                          </>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">No cash transactions yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
