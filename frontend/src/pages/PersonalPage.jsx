import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";

const PERSONAL_CATEGORIES = [
  "Salary", "Freelance", "Side Income", "Gift Received",
  "Groceries", "Rent", "Transport", "Loan Payment", "EMI",
  "Borrowed", "Lent Out", "Utilities", "Food & Dining",
  "Shopping", "Entertainment", "Health", "Gym & Fitness",
  "Education", "Subscriptions", "Insurance", "Phone & Internet",
  "Clothing", "Personal Care", "Family", "Savings", "Investment", "Other",
];

const INCOME_CATS = ["Salary", "Freelance", "Side Income", "Gift Received", "Borrowed"];
const LEND_BORROW_CATS = ["Borrowed", "Lent Out"];
const QUICK_AMOUNTS = [100, 500, 1000, 2500, 5000];

export default function PersonalPage() {
  const { user } = useAuth();
  const currency = user?.currency || "DKK";
  const [entries, setEntries] = useState([]);
  const [categories, setCategories] = useState([]);
  const [catId, setCatId] = useState("");
  const [customCat, setCustomCat] = useState("");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split("T")[0]);
  const [method, setMethod] = useState("cash");
  const [notes, setNotes] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState("all"); // "all", "income", "spent"
  const [filterMonth, setFilterMonth] = useState(new Date().toISOString().slice(0, 7));

  const fetchData = () => {
    api.get("/expenses", { params: {} })
      .then((res) => setEntries(res.data.filter((e) => e.is_personal)))
      .catch(() => {});
    api.get("/expenses/categories")
      .then((res) => setCategories(res.data))
      .catch(() => {});
  };

  useEffect(() => {
    fetchData();
    const onDataChanged = () => fetchData();
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

  const setupPersonalCategories = async () => {
    try {
      for (const name of PERSONAL_CATEGORIES) {
        await api.post("/expenses/categories", { name });
      }
      fetchData();
      setSuccess("Personal categories created!");
      setTimeout(() => setSuccess(""), 2500);
    } catch {
      setError("Failed to create categories");
    }
  };

  const isIncome = (catName) => INCOME_CATS.includes(catName);
  const getCatName = (id) => categories.find((c) => c.id === id)?.name || "";

  const filteredEntries = entries.filter((e) => {
    if (filterMonth && !e.date.startsWith(filterMonth)) return false;
    const catName = getCatName(e.category_id);
    if (tab === "income" && !isIncome(catName)) return false;
    if (tab === "spent" && isIncome(catName)) return false;
    return true;
  });

  const totalIncome = entries
    .filter((e) => e.date.startsWith(filterMonth) && isIncome(getCatName(e.category_id)))
    .reduce((s, e) => s + parseFloat(e.amount), 0);
  const totalSpent = entries
    .filter((e) => e.date.startsWith(filterMonth) && !isIncome(getCatName(e.category_id)))
    .reduce((s, e) => s + parseFloat(e.amount), 0);
  const balance = totalIncome - totalSpent;

  // Monthly breakdown by category
  const monthEntries = entries.filter((e) => e.date.startsWith(filterMonth));
  const spendingByCategory = {};
  monthEntries.forEach((e) => {
    const catName = getCatName(e.category_id);
    if (!isIncome(catName)) {
      spendingByCategory[catName] = (spendingByCategory[catName] || 0) + parseFloat(e.amount);
    }
  });
  const topSpending = Object.entries(spendingByCategory).sort((a, b) => b[1] - a[1]);

  // Borrowed & Lent tracker (all time)
  const totalBorrowed = entries
    .filter((e) => getCatName(e.category_id) === "Borrowed")
    .reduce((s, e) => s + parseFloat(e.amount), 0);
  const totalLent = entries
    .filter((e) => getCatName(e.category_id) === "Lent Out")
    .reduce((s, e) => s + parseFloat(e.amount), 0);
  const totalLoanPayments = entries
    .filter((e) => ["Loan Payment", "EMI"].includes(getCatName(e.category_id)))
    .reduce((s, e) => s + parseFloat(e.amount), 0);

  // Savings rate
  const savingsRate = totalIncome > 0 ? Math.round(((totalIncome - totalSpent) / totalIncome) * 100) : 0;

  const submit = async () => {
    const value = parseFloat(amount);
    if (!value) return;
    let finalCatId = catId;
    if (!finalCatId && !customCat.trim()) return;
    setError("");
    try {
      if (!finalCatId && customCat.trim()) {
        const catRes = await api.post("/expenses/categories", { name: customCat.trim() });
        finalCatId = catRes.data.id;
        setCategories((prev) => prev.find((c) => c.id === catRes.data.id) ? prev : [...prev, catRes.data]);
        setCustomCat("");
      }
      const finalDesc = desc || customCat.trim() || getCatName(finalCatId) || "Entry";
      await api.post("/expenses", {
        category_id: finalCatId,
        date: entryDate,
        amount: value,
        description: finalDesc,
        is_recurring: false,
        payment_method: method,
        notes: notes || null,
        is_personal: true,
      });
      setAmount("");
      setDesc("");
      setNotes("");
      setCatId("");
      setCustomCat("");
      setSuccess(`${value.toLocaleString()} ${currency} logged!`);
      fetchData();
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add entry");
    }
  };

  const deleteEntry = async (id) => {
    try {
      await api.delete(`/expenses/${id}`);
      fetchData();
    } catch {}
  };

  // Personal categories that exist
  const personalCats = categories.filter((c) => PERSONAL_CATEGORIES.includes(c.name));
  const hasPersonalCats = personalCats.length > 0;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Personal Finance</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Track your personal income and spending</p>
        </div>
      </div>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {/* Quick setup */}
      {!hasPersonalCats && (
        <div className="bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-700 p-5 rounded-xl">
          <p className="text-purple-800 dark:text-purple-300 font-medium mb-2">Set up personal categories</p>
          <p className="text-purple-600 dark:text-purple-400 text-sm mb-3">{PERSONAL_CATEGORIES.join(", ")}</p>
          <button onClick={setupPersonalCategories}
            className="bg-purple-600 text-white px-5 py-2.5 rounded-lg hover:bg-purple-700 transition font-medium text-sm">
            Create Categories
          </button>
        </div>
      )}

      {/* Balance overview */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 p-4 sm:p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Income</p>
          <p className="text-lg sm:text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{totalIncome.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 p-4 sm:p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Spent</p>
          <p className="text-lg sm:text-2xl font-bold text-red-500 dark:text-red-400 mt-1">{totalSpent.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{currency}</p>
        </div>
        <div className={`bg-white dark:bg-gray-800 p-4 sm:p-5 rounded-xl shadow-sm border ${balance >= 0 ? "border-green-200 dark:border-green-800" : "border-red-200 dark:border-red-800"} text-center`}>
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Balance</p>
          <p className={`text-lg sm:text-2xl font-bold mt-1 ${balance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>{balance.toLocaleString()}</p>
          <p className="text-xs text-gray-400">{currency}</p>
        </div>
      </div>

      {/* Monthly Insights */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Spending breakdown */}
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Where your money goes</h2>
          {topSpending.length > 0 ? (
            <div className="space-y-2">
              {topSpending.slice(0, 6).map(([cat, amt]) => (
                <div key={cat} className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 dark:text-gray-400 w-28 truncate">{cat}</span>
                  <div className="flex-1 h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full bg-purple-500 rounded-full" style={{ width: `${(amt / totalSpent) * 100}%` }} />
                  </div>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300 w-24 text-right">{amt.toLocaleString()} {currency}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">No spending data yet</p>
          )}
        </div>

        {/* Financial snapshot */}
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">Financial Snapshot</h2>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Savings Rate</span>
            <span className={`text-sm font-bold ${savingsRate >= 20 ? "text-green-600" : savingsRate >= 0 ? "text-yellow-600" : "text-red-500"}`}>
              {savingsRate}%
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Total Borrowed</span>
            <span className="text-sm font-bold text-orange-600 dark:text-orange-400">{totalBorrowed.toLocaleString()} {currency}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Total Lent Out</span>
            <span className="text-sm font-bold text-blue-600 dark:text-blue-400">{totalLent.toLocaleString()} {currency}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">Loan/EMI Paid</span>
            <span className="text-sm font-bold text-gray-700 dark:text-gray-300">{totalLoanPayments.toLocaleString()} {currency}</span>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-gray-100 dark:border-gray-700">
            <span className="text-sm text-gray-500 dark:text-gray-400">Net Owed to You</span>
            <span className={`text-sm font-bold ${(totalLent - totalBorrowed) >= 0 ? "text-green-600" : "text-red-500"}`}>
              {(totalLent - totalBorrowed).toLocaleString()} {currency}
            </span>
          </div>
        </div>
      </div>

      {/* Add entry */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">Add Entry</h2>
        <p className="text-sm text-gray-400 mb-4">Pick a category or type your own</p>

        <div className="flex flex-wrap gap-2 mb-3">
          {(hasPersonalCats ? personalCats : categories).map((c) => (
            <button
              key={c.id}
              onClick={() => { setCatId(c.id); setCustomCat(""); if (!desc) setDesc(c.name); }}
              className={`px-3 py-2 rounded-xl text-sm font-medium border transition ${
                catId === c.id
                  ? isIncome(c.name)
                    ? "bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-600 text-green-700 dark:text-green-300"
                    : "bg-purple-50 dark:bg-purple-900/30 border-purple-300 dark:border-purple-600 text-purple-700 dark:text-purple-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {isIncome(c.name) ? "+" : "-"} {c.name}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm text-gray-400">or</span>
          <input
            type="text"
            value={customCat}
            onChange={(e) => { setCustomCat(e.target.value); if (e.target.value) setCatId(""); }}
            placeholder="Type custom category..."
            className="flex-1 px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
          />
        </div>

        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Description (optional)"
          className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl mb-4 focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
        />

        {/* Quick amounts */}
        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_AMOUNTS.map((amt) => (
            <button key={amt} onClick={() => setAmount(String(amt))}
              className={`px-4 py-2 rounded-xl border text-sm font-medium transition ${
                amount === String(amt)
                  ? "bg-purple-50 dark:bg-purple-900/30 border-purple-300 text-purple-700"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}>{amt.toLocaleString()} {currency}</button>
          ))}
        </div>

        <div className="flex gap-3 mb-3">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Custom amount"
            className="flex-1 px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={submit}
            disabled={!amount || (!catId && !customCat.trim())}
            className="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition font-semibold disabled:opacity-40"
          >
            Add
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
          />
          <div className="flex gap-1">
            {["cash", "card", "bank_transfer"].map((m) => (
              <button key={m} onClick={() => setMethod(m)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize ${
                  method === m ? "bg-purple-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                }`}>{m.replace("_", " ")}</button>
            ))}
          </div>
        </div>

        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder={LEND_BORROW_CATS.includes(getCatName(catId)) ? "Who? (e.g., Ram, John)" : "Notes (optional)"}
          className="mt-3 w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
        {LEND_BORROW_CATS.includes(getCatName(catId)) && (
          <p className="mt-1 text-xs text-purple-500 dark:text-purple-400">
            Tip: Add the person's name so you can track who owes what
          </p>
        )}
      </div>

      {/* History */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">History</h2>
            <div className="flex gap-1 ml-2">
              {["all", "income", "spent"].map((f) => (
                <button key={f} onClick={() => setTab(f)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                    tab === f ? "bg-purple-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                  }`}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
              ))}
            </div>
          </div>
          <input
            type="month"
            value={filterMonth}
            onChange={(e) => setFilterMonth(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[500px]">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Date</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Category</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Description</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Amount</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Payment</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Notes</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {filteredEntries.map((e) => {
                const catName = getCatName(e.category_id);
                const income = isIncome(catName);
                return (
                  <tr key={e.id}>
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{e.date}</td>
                    <td className="px-6 py-4 text-sm">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        income ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400" : "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400"
                      }`}>
                        {income ? "+" : "-"} {catName}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{e.description}</td>
                    <td className={`px-6 py-4 text-sm font-semibold ${income ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
                      {income ? "+" : "-"}{parseFloat(e.amount).toLocaleString()} {currency}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 capitalize">{e.payment_method?.replace("_", " ") || "-"}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{e.notes || "-"}</td>
                    <td className="px-6 py-4 text-right">
                      <button onClick={() => deleteEntry(e.id)} className="text-red-400 text-sm hover:underline">Delete</button>
                    </td>
                  </tr>
                );
              })}
              {filteredEntries.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">No entries yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
