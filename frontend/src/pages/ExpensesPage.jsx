import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";

const QUICK_AMOUNTS = [100, 250, 500, 1000, 2500, 5000];
const DEFAULT_CATEGORIES = ["Ingredients", "Rent", "Wages", "Utilities", "Supplies", "Other"];

export default function ExpensesPage() {
  const { t } = useLanguage();
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [catId, setCatId] = useState("");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [expDate, setExpDate] = useState(new Date().toISOString().split("T")[0]);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const fetchData = (from, to) => {
    const params = {};
    if (from) params.from = from;
    if (to) params.to = to;
    api.get("/expenses", { params })
      .then((res) => setExpenses(res.data))
      .catch((err) => setError(err.response?.data?.detail || "Failed to load expenses"));
    api.get("/expenses/categories")
      .then((res) => {
        setCategories(res.data);
        if (res.data.length === 0) setShowSetup(true);
      })
      .catch((err) => setError(err.response?.data?.detail || "Failed to load categories"));
  };

  useEffect(() => { fetchData(); }, []);

  const quickSetup = async () => {
    try {
      for (const name of DEFAULT_CATEGORIES) {
        await api.post("/expenses/categories", { name });
      }
      setShowSetup(false);
      fetchData();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to set up categories");
    }
  };

  const submit = async (quickAmt) => {
    const value = quickAmt || parseFloat(amount);
    if (!value || !catId || !desc) return;
    setError("");
    try {
      await api.post("/expenses", {
        category_id: catId,
        date: expDate,
        amount: value,
        description: desc,
        is_recurring: false,
      });
      const isBackdated = expDate !== new Date().toISOString().split("T")[0];
      setAmount("");
      setDesc("");
      setExpDate(new Date().toISOString().split("T")[0]);
      trackEvent("expense_logged", "expenses", `${value} DKK`);
      setSuccess(`${value.toLocaleString()} DKK${isBackdated ? ` (${expDate})` : ""}!`);
      fetchData(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add expense");
    }
  };

  const startEdit = (exp) => {
    setEditId(exp.id);
    setEditData({
      date: exp.date,
      amount: parseFloat(exp.amount),
      description: exp.description,
      category_id: exp.category_id,
    });
  };

  const saveEdit = async () => {
    try {
      await api.put(`/expenses/${editId}`, editData);
      setEditId(null);
      setEditData({});
      fetchData(filterFrom, filterTo);
      setSuccess("Expense updated!");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to update expense");
    }
  };

  const deleteExpense = async (id) => {
    try {
      await api.delete(`/expenses/${id}`);
      setDeleteConfirm(null);
      fetchData(filterFrom, filterTo);
      setSuccess("Expense deleted");
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to delete expense");
    }
  };

  const getCatName = (catId) => {
    const cat = categories.find((c) => c.id === catId);
    return cat ? cat.name : "";
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("expenseTracker")}</h1>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {showSetup && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 p-5 rounded-xl">
          <p className="text-blue-800 dark:text-blue-300 font-medium mb-2">{t("firstTimeSetup")}</p>
          <p className="text-blue-600 dark:text-blue-400 text-sm mb-3">{DEFAULT_CATEGORIES.join(", ")}</p>
          <button onClick={quickSetup}
            className="bg-blue-600 text-white px-5 py-2.5 rounded-lg hover:bg-blue-700 transition font-medium text-sm">
            {t("setupCategories")}
          </button>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">{t("addExpense")}</h2>
        <p className="text-sm text-gray-400 dark:text-gray-400 mb-4">{t("pickCategory")}</p>

        <div className="flex flex-wrap gap-2 mb-4">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setCatId(c.id)}
              className={`px-4 py-2.5 rounded-xl text-sm font-medium border transition ${
                catId === c.id
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t("whatWasIt")}
          className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
        />

        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              disabled={!catId || !desc}
              className="px-5 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-600 hover:text-blue-700 dark:hover:text-blue-300 transition disabled:opacity-30"
            >
              {amt.toLocaleString()} DKK
            </button>
          ))}
        </div>

        <div className="flex gap-3">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t("customAmount")}
            className="flex-1 px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={() => submit()}
            disabled={!amount || !catId || !desc}
            className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-semibold disabled:opacity-40"
          >
            {t("add")}
          </button>
        </div>

        {/* Date picker */}
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}:</label>
          <input
            type="date"
            value={expDate}
            max={new Date().toISOString().split("T")[0]}
            onChange={(e) => setExpDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {expDate !== new Date().toISOString().split("T")[0] && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Backdated entry</span>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("recentExpenses")}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); fetchData(e.target.value, filterTo); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); fetchData(filterFrom, e.target.value); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {(filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterFrom(""); setFilterTo(""); fetchData(); }}
                className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <table className="w-full text-left">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("description")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Category</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("amount")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {expenses.slice(0, 50).map((exp) => (
              <tr key={exp.id}>
                {editId === exp.id ? (
                  <>
                    <td className="px-6 py-3">
                      <input
                        type="date"
                        value={editData.date}
                        onChange={(e) => setEditData({ ...editData, date: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-36"
                      />
                    </td>
                    <td className="px-6 py-3">
                      <input
                        type="text"
                        value={editData.description}
                        onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-32"
                      />
                    </td>
                    <td className="px-6 py-3">
                      <select
                        value={editData.category_id}
                        onChange={(e) => setEditData({ ...editData, category_id: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-3">
                      <input
                        type="number"
                        value={editData.amount}
                        onChange={(e) => setEditData({ ...editData, amount: parseFloat(e.target.value) || 0 })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-28"
                      />
                    </td>
                    <td className="px-6 py-3 text-right space-x-2">
                      <button onClick={saveEdit} className="text-green-600 dark:text-green-400 text-sm font-medium hover:underline">Save</button>
                      <button onClick={() => setEditId(null)} className="text-gray-400 dark:text-gray-500 text-sm hover:underline">Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{exp.date}</td>
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{exp.description}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{getCatName(exp.category_id)}</td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-800 dark:text-white">{parseFloat(exp.amount).toLocaleString()} DKK</td>
                    <td className="px-6 py-4 text-right space-x-3">
                      <button onClick={() => startEdit(exp)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">Edit</button>
                      {deleteConfirm === exp.id ? (
                        <>
                          <button onClick={() => deleteExpense(exp.id)} className="text-red-600 dark:text-red-400 text-sm font-medium hover:underline">Confirm</button>
                          <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-sm hover:underline">No</button>
                        </>
                      ) : (
                        <button onClick={() => setDeleteConfirm(exp.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">Delete</button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {expenses.length === 0 && (
              <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noExpensesYet")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
