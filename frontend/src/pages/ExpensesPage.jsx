import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { displayCurrency } from "../utils/currency";

const QUICK_AMOUNTS = [100, 250, 500, 1000, 2500, 5000];
const DEFAULT_CATEGORIES = ["Ingredients", "Rent", "Wages", "Utilities", "Supplies", "Other"];

export default function ExpensesPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
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
  const [selected, setSelected] = useState(new Set());
  const [method, setMethod] = useState("card");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [customCat, setCustomCat] = useState("");
  const [listening, setListening] = useState(false);
  const [isPersonal, setIsPersonal] = useState(false);
  const [showFilter, setShowFilter] = useState("business"); // "all", "business", "personal"

  const filtered = expenses.filter(e => {
    if (search && !(e.description?.toLowerCase().includes(search.toLowerCase()) || e.notes?.toLowerCase().includes(search.toLowerCase()) || e.payment_method?.toLowerCase().includes(search.toLowerCase()))) return false;
    if (showFilter === "personal" && !e.is_personal) return false;
    if (showFilter === "business" && e.is_personal) return false;
    return true;
  }).sort((a, b) => {
    const d = b.date.localeCompare(a.date);
    if (d !== 0) return d;
    return (b.created_at || "").localeCompare(a.created_at || "");
  });

  const startVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setError("Voice input not supported in this browser"); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript.toLowerCase();
      const numMatch = text.match(/[\d,]+\.?\d*/);
      if (numMatch) {
        const val = parseFloat(numMatch[0].replace(/,/g, ""));
        if (val > 0) {
          setAmount(String(val));
          if (text.includes("cash")) setMethod("cash");
          else if (text.includes("card")) setMethod("card");
          // Try to match a category
          const catMatch = categories.find(c => text.includes(c.name.toLowerCase()));
          if (catMatch) { setCatId(catMatch.id); setCustomCat(""); }
          // Use remaining text as description
          const remaining = text.replace(numMatch[0], "").replace(/cash|card|mobilepay|mixed|dankort/g, "").trim();
          if (remaining.length > 2) setDesc(remaining);
          setSuccess(`Voice: "${text}" → ${val.toLocaleString()} ${currency}`);
          setTimeout(() => setSuccess(""), 3000);
        }
      } else {
        setError(`Couldn't parse amount from: "${text}"`);
        setTimeout(() => setError(""), 3000);
      }
    };
    recognition.onerror = () => { setListening(false); setError("Voice recognition failed"); setTimeout(() => setError(""), 3000); };
    recognition.start();
  };

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

  useEffect(() => {
    fetchData();
    const onDataChanged = () => fetchData();
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

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
    if (!value) return;
    // Need either a selected category or a custom one typed
    let finalCatId = catId;
    if (!finalCatId && !customCat.trim()) return;
    // Auto-fill description from category if empty
    const finalDesc = desc || customCat.trim() || categories.find(c => c.id === finalCatId)?.name || "Expense";
    setError("");
    try {
      // If custom category typed, create it first
      if (!finalCatId && customCat.trim()) {
        const catRes = await api.post("/expenses/categories", { name: customCat.trim() });
        finalCatId = catRes.data.id;
        setCategories((prev) => {
          if (prev.find((c) => c.id === catRes.data.id)) return prev;
          return [...prev, catRes.data];
        });
        setCatId(catRes.data.id);
        setCustomCat("");
      }
      await api.post("/expenses", {
        category_id: finalCatId,
        date: expDate,
        amount: value,
        description: finalDesc,
        is_recurring: false,
        payment_method: method,
        notes: notes || null,
        is_personal: isPersonal,
      });
      const isBackdated = expDate !== new Date().toISOString().split("T")[0];
      setAmount("");
      setDesc("");
      setMethod("card");
      setNotes("");
      setCustomCat("");
      setIsPersonal(false);
      setExpDate(new Date().toISOString().split("T")[0]);
      trackEvent("expense_logged", "expenses", `${value} ${currency}`);
      setSuccess(`${value.toLocaleString()} ${currency}${isBackdated ? ` (${expDate})` : ""}!`);
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
      payment_method: exp.payment_method || "card",
      notes: exp.notes || "",
      is_personal: exp.is_personal || false,
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

  const bulkDelete = async () => {
    if (!confirm(`Move ${selected.size} items to trash?`)) return;
    try {
      await Promise.all([...selected].map(id => api.delete(`/expenses/${id}`)));
      setSelected(new Set());
      fetchData(filterFrom, filterTo);
      setSuccess(`${selected.size} items moved to trash`);
      setTimeout(() => setSuccess(""), 2500);
    } catch {
      setError("Failed to delete some items");
    }
  };

  const deleteExpense = async (id) => {
    try {
      await api.delete(`/expenses/${id}`);
      setDeleteConfirm(null);
      fetchData(filterFrom, filterTo);
      setSuccess("Moved to recently deleted");
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
    <div className="p-4 sm:p-6 space-y-6">
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

        <div className="flex flex-wrap gap-2 mb-3">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => { setCatId(c.id); setCustomCat(""); setDesc(c.name); }}
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
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm text-gray-400 dark:text-gray-500">or</span>
          <input
            type="text"
            value={customCat}
            onChange={(e) => { setCustomCat(e.target.value); if (e.target.value) setCatId(""); }}
            placeholder="Type custom category..."
            className="flex-1 px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
          />
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
              disabled={!catId && !customCat.trim()}
              className="px-5 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-600 hover:text-blue-700 dark:hover:text-blue-300 transition disabled:opacity-30"
            >
              {amt.toLocaleString()} {currency}
            </button>
          ))}
        </div>

        <div className="flex gap-2 sm:gap-3">
          <button
            onClick={startVoice}
            className={`px-3 py-3 rounded-xl border transition flex-shrink-0 ${
              listening
                ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-600 text-red-600 dark:text-red-400 animate-pulse"
                : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600"
            }`}
            title="Voice input"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </button>
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
            disabled={!amount || (!catId && !customCat.trim())}
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

        {/* Payment method */}
        <div className="flex flex-wrap gap-2 mt-3">
          {["cash", "card", "mobilepay", "mixed", "dankort"].map((m) => (
            <button key={m} type="button" onClick={() => setMethod(m)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize ${
                method === m ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
              }`}>{m}</button>
          ))}
        </div>

        {/* Notes */}
        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)" className="mt-3 w-full px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />

        {/* Personal toggle */}
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsPersonal(!isPersonal)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
              isPersonal ? "bg-purple-600" : "bg-gray-200 dark:bg-gray-600"
            }`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition transform ${isPersonal ? "translate-x-6" : "translate-x-1"}`} />
          </button>
          <span className={`text-sm font-medium ${isPersonal ? "text-purple-600 dark:text-purple-400" : "text-gray-500 dark:text-gray-400"}`}>
            {isPersonal ? "Personal expense" : "Business expense"}
          </span>
          {isPersonal && (
            <span className="text-xs text-purple-500 dark:text-purple-400">Excluded from reports & VAT</span>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("recentExpenses")}</h2>
            <div className="flex gap-1 ml-2">
              {["all", "business", "personal"].map((f) => (
                <button key={f} onClick={() => setShowFilter(f)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition ${
                    showFilter === f ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                  }`}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
              ))}
            </div>
          </div>
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
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              onClick={() => exportToCsv("expenses.csv", expenses.map(exp => ({
                ...exp,
                category_name: getCatName(exp.category_id),
              })), [
                { key: "date", label: "Date" },
                { key: "description", label: "Description" },
                { key: "category_name", label: "Category" },
                { key: "amount", label: "Amount" },
              ])}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              Export CSV
            </button>
          </div>
        </div>
        {selected.size > 0 && (
          <div className="px-6 py-3 bg-blue-50 dark:bg-blue-900/20 flex items-center justify-between">
            <span className="text-sm text-blue-700 dark:text-blue-400">{selected.size} selected</span>
            <button onClick={bulkDelete} className="text-sm text-red-600 dark:text-red-400 font-medium hover:underline">
              Move to trash
            </button>
          </div>
        )}
        <div className="overflow-x-auto">
        <table className="w-full text-left min-w-[600px]">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-4 sm:px-6 py-3 w-8">
                <input type="checkbox" onChange={(e) => {
                  if (e.target.checked) setSelected(new Set(filtered.map(i => i.id)));
                  else setSelected(new Set());
                }} checked={selected.size === filtered.length && filtered.length > 0} />
              </th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("description")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Category</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("amount")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Payment</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">Notes</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("date")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {filtered.slice(0, 50).map((exp) => (
              <tr key={exp.id}>
                <td className="px-4 sm:px-6 py-4">
                  <input type="checkbox" checked={selected.has(exp.id)} onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(exp.id);
                    else next.delete(exp.id);
                    setSelected(next);
                  }} />
                </td>
                {editId === exp.id ? (
                  <>
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
                    <td className="px-6 py-3">
                      <select
                        value={editData.payment_method}
                        onChange={(e) => setEditData({ ...editData, payment_method: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                      >
                        {["cash", "card", "mobilepay", "mixed", "dankort"].map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-3">
                      <input
                        type="text"
                        value={editData.notes}
                        onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-28"
                      />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <input
                        type="date"
                        value={editData.date}
                        onChange={(e) => setEditData({ ...editData, date: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-36"
                      />
                    </td>
                    <td className="px-6 py-3 text-right space-x-2">
                      <button onClick={saveEdit} className="text-green-600 dark:text-green-400 text-sm font-medium hover:underline">Save</button>
                      <button onClick={() => setEditId(null)} className="text-gray-400 dark:text-gray-500 text-sm hover:underline">Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">
                      {exp.description}
                      {exp.is_personal && <span className="ml-2 px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-xs rounded font-medium">Personal</span>}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{getCatName(exp.category_id)}</td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-800 dark:text-white">{parseFloat(exp.amount).toLocaleString()} {currency}</td>
                    <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400 capitalize">{exp.payment_method || "-"}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{exp.notes || "-"}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 text-right">{exp.date}</td>
                    <td className="px-6 py-4 text-right space-x-3">
                      <button onClick={() => startEdit(exp)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">Edit</button>
                      {deleteConfirm === exp.id ? (
                        <>
                          <button onClick={() => deleteExpense(exp.id)} className="text-red-600 dark:text-red-400 text-sm font-medium hover:underline">Yes, move</button>
                          <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-sm hover:underline">No</button>
                        </>
                      ) : (
                        <button onClick={() => setDeleteConfirm(exp.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">Move to trash</button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noExpensesYet")}</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
