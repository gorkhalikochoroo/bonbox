import { useState, useEffect, useRef } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { displayCurrency } from "../utils/currency";

const QUICK_AMOUNTS = [100, 250, 500, 1000, 2500, 5000];
const DEFAULT_CATEGORIES = ["Ingredients", "Rent", "Wages", "Utilities", "Supplies", "Other"];

// Categories that only belong in Personal mode — hide from Business expense buttons
const PERSONAL_ONLY_CATS = new Set([
  "Salary", "Freelance", "Side Income", "Gift Received",
  "Groceries", "Transport", "Loan Payment", "EMI",
  "Borrowed", "Lent Out", "Food & Dining",
  "Shopping", "Entertainment", "Health", "Gym & Fitness",
  "Education", "Subscriptions", "Insurance", "Phone & Internet",
  "Clothing", "Personal Care", "Family", "Savings", "Investment",
]);

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
  const customCatRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [isPersonal, setIsPersonal] = useState(false);
  const [showFilter, setShowFilter] = useState("business"); // "all", "business", "personal"
  const [suggestion, setSuggestion] = useState(null);
  const suggestTimer = useRef(null);

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

  // Auto-suggest category from description
  const fetchSuggestion = (text) => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (!text || text.length < 2) { setSuggestion(null); return; }
    suggestTimer.current = setTimeout(() => {
      api.get("/expenses/suggest-category", { params: { q: text } })
        .then((res) => {
          if (res.data.suggestion) {
            setSuggestion(res.data.suggestion);
          } else {
            setSuggestion(null);
          }
        })
        .catch(() => {});
    }, 400); // debounce 400ms
  };

  const applySuggestion = () => {
    if (!suggestion) return;
    setCatId(suggestion.category_id);
    setCustomCat("");
    setSuggestion(null);
  };

  const fetchData = (from, to) => {
    const params = { is_personal: false };
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

  // Quick expense (no category required)
  const [quickMode, setQuickMode] = useState(false);
  const [quickAmount, setQuickAmount] = useState("");
  const [quickMethod, setQuickMethod] = useState("card");
  const [quickNotes, setQuickNotes] = useState("");
  const [quickDate, setQuickDate] = useState(new Date().toISOString().split("T")[0]);

  const submitQuick = async (amt) => {
    const value = amt || parseFloat(quickAmount);
    if (!value) return;
    setError("");
    try {
      // Find or create "Other" category
      let otherCat = categories.find(c => c.name === "Other");
      if (!otherCat) {
        const res = await api.post("/expenses/categories", { name: "Other" });
        otherCat = res.data;
        setCategories(prev => [...prev, res.data]);
      }
      await api.post("/expenses", {
        category_id: otherCat.id,
        date: quickDate,
        amount: value,
        description: quickNotes || "Quick expense",
        is_recurring: false,
        payment_method: quickMethod,
        notes: quickNotes || null,
        is_personal: false,
      });
      const isBackdated = quickDate !== new Date().toISOString().split("T")[0];
      setQuickAmount("");
      setQuickNotes("");
      setQuickMethod("card");
      setQuickDate(new Date().toISOString().split("T")[0]);
      trackEvent("quick_expense_logged", "expenses", `${value} ${currency}`);
      setSuccess(`${value.toLocaleString()} ${currency}${isBackdated ? ` (${quickDate})` : ""}!`);
      fetchData(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add expense");
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
        <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 p-5 rounded-xl">
          <p className="text-green-800 dark:text-green-300 font-medium mb-2">{t("firstTimeSetup")}</p>
          <p className="text-green-600 dark:text-green-400 text-sm mb-3">{DEFAULT_CATEGORIES.join(", ")}</p>
          <button onClick={quickSetup}
            className="bg-green-600 text-white px-5 py-2.5 rounded-lg hover:bg-green-700 transition font-medium text-sm">
            {t("setupCategories")}
          </button>
        </div>
      )}

      {/* Form + Stats side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <div className="lg:col-span-3 bg-white dark:bg-gray-800 p-4 sm:p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <div className="max-w-md">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("addExpense")}</h2>
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
            <button
              onClick={() => setQuickMode(false)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${!quickMode ? "bg-white dark:bg-gray-600 text-gray-800 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400"}`}
            >
              Detailed
            </button>
            <button
              onClick={() => setQuickMode(true)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${quickMode ? "bg-white dark:bg-gray-600 text-gray-800 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400"}`}
            >
              Quick
            </button>
          </div>
        </div>

        {quickMode ? (
          <div>
            <p className="text-xs text-gray-400 dark:text-gray-400 mb-3">Amount, payment & go — saved as "Other"</p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => submitQuick(amt)}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-green-50 dark:hover:bg-green-900/30 hover:border-green-300 dark:hover:border-green-500 hover:text-green-700 dark:hover:text-green-300 transition"
                >
                  {amt.toLocaleString()} {currency}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 mb-2">
              <input
                type="number"
                value={quickAmount}
                onChange={(e) => setQuickAmount(e.target.value)}
                placeholder={t("customAmount")}
                className="flex-1 px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                onKeyDown={(e) => e.key === "Enter" && submitQuick()}
              />
              <button
                onClick={() => submitQuick()}
                disabled={!quickAmount}
                className="px-4 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-semibold text-sm disabled:opacity-40"
              >
                {t("add")}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                <button key={m} type="button" onClick={() => setQuickMethod(m)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                    quickMethod === m ? "bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-500 text-green-700 dark:text-green-300" : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  }`}>{t(m)}</button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="text" value={quickNotes} onChange={(e) => setQuickNotes(e.target.value)}
                placeholder="Notes (optional)" className="flex-1 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
              <input
                type="date"
                value={quickDate}
                max={new Date().toISOString().split("T")[0]}
                onChange={(e) => setQuickDate(e.target.value)}
                className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            {quickDate !== new Date().toISOString().split("T")[0] && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-medium">Backdated</p>
            )}
          </div>
        ) : (
          <div>
        <p className="text-xs text-gray-400 dark:text-gray-400 mb-3">{t("pickCategory")}</p>

        <div className="flex flex-wrap gap-1.5 mb-2">
          {categories
            .filter((c) => !PERSONAL_ONLY_CATS.has(c.name))
            .map((c) => (
            <button
              key={c.id}
              onClick={() => {
                if (c.name === "Other") {
                  setCatId("");
                  setCustomCat("");
                  setDesc("");
                  setTimeout(() => customCatRef.current?.focus(), 0);
                } else {
                  setCatId(c.id);
                  setCustomCat("");
                  setDesc(c.name);
                }
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                catId === c.id
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 mb-2 relative">
          <span className="text-xs text-gray-400 dark:text-gray-500">or</span>
          <div className="flex-1 relative">
            <input
              ref={customCatRef}
              type="text"
              value={customCat}
              onChange={(e) => { setCustomCat(e.target.value); if (e.target.value) setCatId(""); }}
              placeholder="Custom category..."
              className="w-full px-2.5 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
            />
            {customCat.length >= 1 && (() => {
              const matches = categories.filter(c => c.name.toLowerCase().includes(customCat.toLowerCase()) && c.name.toLowerCase() !== customCat.toLowerCase());
              if (matches.length === 0) return null;
              return (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-20 max-h-32 overflow-y-auto">
                  {matches.slice(0, 5).map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { setCatId(c.id); setCustomCat(""); setDesc(c.name); }}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition"
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>

        <div className="relative mb-2">
          <input
            type="text"
            value={desc}
            onChange={(e) => { setDesc(e.target.value); fetchSuggestion(e.target.value); }}
            placeholder={t("whatWasIt")}
            className="w-full px-2.5 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
          />
          {suggestion && !catId && (
            <button
              onClick={applySuggestion}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              {suggestion.category_name}
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 mb-2">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              disabled={!catId && !customCat.trim()}
              className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-600 hover:text-blue-700 dark:hover:text-blue-300 transition disabled:opacity-30"
            >
              {amt.toLocaleString()} {currency}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={startVoice}
            className={`p-2 rounded-lg border transition flex-shrink-0 ${
              listening
                ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-600 text-red-600 dark:text-red-400 animate-pulse"
                : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600"
            }`}
            title="Voice input"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </button>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t("customAmount")}
            className="flex-1 px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={() => submit()}
            disabled={!amount || (!catId && !customCat.trim())}
            className="px-4 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-semibold text-sm disabled:opacity-40"
          >
            {t("add")}
          </button>
        </div>

        {/* Payment method */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
            <button key={m} type="button" onClick={() => setMethod(m)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                method === m ? "bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-500 text-green-700 dark:text-green-300" : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}>{t(m)}</button>
          ))}
        </div>

        {/* Notes + Date row */}
        <div className="mt-2 flex items-center gap-2">
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)" className="flex-1 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
          <input
            type="date"
            value={expDate}
            max={new Date().toISOString().split("T")[0]}
            onChange={(e) => setExpDate(e.target.value)}
            className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {expDate !== new Date().toISOString().split("T")[0] && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-medium">Backdated entry</p>
        )}

        {/* Personal toggle */}
        <div className="mt-2 flex items-center gap-3">
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
        )}
        </div>
      </div>

      {/* Summary Stats - right side, Inventory Monitor style */}
      {expenses.length > 0 ? (() => {
        const totalExp = expenses.reduce((s, x) => s + parseFloat(x.amount), 0);
        const avgExp = totalExp / expenses.length;
        const todayExp = expenses.filter(e => e.date === new Date().toISOString().split("T")[0]);
        const todayTotal = todayExp.reduce((s, x) => s + parseFloat(x.amount), 0);
        const cats = {};
        expenses.forEach(e => { cats[e.category_name || "Other"] = (cats[e.category_name || "Other"] || 0) + parseFloat(e.amount); });
        const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
        return (
          <div className="lg:col-span-2 grid grid-cols-2 gap-3 content-start">
            <div className="bg-gradient-to-br from-red-950 to-gray-800 rounded-xl p-4 border border-red-800/50">
              <p className="text-[10px] uppercase tracking-widest text-red-300/70 font-semibold mb-1.5">Today</p>
              <p className="text-3xl font-extrabold text-red-400">{todayTotal.toLocaleString()}</p>
              <p className="text-[11px] text-red-300/50 mt-1 font-medium">{todayExp.length} expense{todayExp.length !== 1 ? "s" : ""} today</p>
            </div>
            <div className="bg-gradient-to-br from-blue-950 to-gray-800 rounded-xl p-4 border border-blue-800/50">
              <p className="text-[10px] uppercase tracking-widest text-blue-300/70 font-semibold mb-1.5">Total Spent</p>
              <p className="text-3xl font-extrabold text-blue-400">{totalExp.toLocaleString()}</p>
              <p className="text-[11px] text-blue-300/50 mt-1 font-medium">{currency} from {expenses.length} expenses</p>
            </div>
            <div className="bg-gradient-to-br from-purple-950 to-gray-800 rounded-xl p-4 border border-purple-800/50">
              <p className="text-[10px] uppercase tracking-widest text-purple-300/70 font-semibold mb-1.5">Avg Expense</p>
              <p className="text-3xl font-extrabold text-purple-400">{Math.round(avgExp).toLocaleString()}</p>
              <p className="text-[11px] text-purple-300/50 mt-1 font-medium">{currency} per expense</p>
            </div>
            <div className="bg-gradient-to-br from-orange-950 to-gray-800 rounded-xl p-4 border border-orange-800/50">
              <p className="text-[10px] uppercase tracking-widest text-orange-300/70 font-semibold mb-1.5">By Category</p>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([cat, amt]) => (
                  <button
                    key={cat}
                    onClick={() => setSearch(search === cat ? "" : cat)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition ${
                      search === cat
                        ? "bg-orange-500 text-white shadow-lg shadow-orange-500/30"
                        : "bg-orange-900/40 text-orange-200 hover:bg-orange-800/60 border border-orange-700/40"
                    }`}
                  >
                    {cat} · {amt.toLocaleString()}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-orange-300/50 mt-2 font-medium">{Object.keys(cats).length} categor{Object.keys(cats).length !== 1 ? "ies" : "y"}</p>
            </div>
          </div>
        );
      })() : (
        <div className="lg:col-span-2 grid grid-cols-2 gap-3 content-start">
          <div className="bg-gradient-to-br from-red-950 to-gray-800 rounded-xl p-4 border border-red-800/50">
            <p className="text-[10px] uppercase tracking-widest text-red-300/70 font-semibold mb-1.5">Today</p>
            <p className="text-3xl font-extrabold text-red-400">0</p>
            <p className="text-[11px] text-red-300/50 mt-1 font-medium">No expenses yet</p>
          </div>
          <div className="bg-gradient-to-br from-blue-950 to-gray-800 rounded-xl p-4 border border-blue-800/50">
            <p className="text-[10px] uppercase tracking-widest text-blue-300/70 font-semibold mb-1.5">Total Spent</p>
            <p className="text-3xl font-extrabold text-blue-400">0</p>
            <p className="text-[11px] text-blue-300/50 mt-1 font-medium">{currency}</p>
          </div>
          <div className="bg-gradient-to-br from-purple-950 to-gray-800 rounded-xl p-4 border border-purple-800/50">
            <p className="text-[10px] uppercase tracking-widest text-purple-300/70 font-semibold mb-1.5">Avg Expense</p>
            <p className="text-3xl font-extrabold text-purple-400">—</p>
            <p className="text-[11px] text-purple-300/50 mt-1 font-medium">Log your first expense</p>
          </div>
          <div className="bg-gradient-to-br from-orange-950 to-gray-800 rounded-xl p-4 border border-orange-800/50">
            <p className="text-[10px] uppercase tracking-widest text-orange-300/70 font-semibold mb-1.5">By Category</p>
            <p className="text-lg font-extrabold text-orange-400 mt-1">—</p>
            <p className="text-[11px] text-orange-300/50 mt-1 font-medium">No data yet</p>
          </div>
        </div>
      )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("recentExpenses")}</h2>
            <div className="flex gap-1 ml-2">
              {["all", "business", "personal"].map((f) => (
                <button key={f} onClick={() => setShowFilter(f)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition ${
                    showFilter === f ? "bg-green-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
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
                        {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                          <option key={m} value={m}>{t(m)}</option>
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

      {/* Sticky selection bar */}
      {selected.size > 0 && (() => {
        const selExp = filtered.filter(e => selected.has(e.id));
        const total = selExp.reduce((sum, e) => sum + parseFloat(e.amount), 0);
        const avg = selExp.length ? total / selExp.length : 0;
        const byCat = {};
        selExp.forEach(e => { byCat[e.category_name || "Other"] = (byCat[e.category_name || "Other"] || 0) + parseFloat(e.amount); });
        return (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-blue-600 dark:bg-blue-700 text-white rounded-2xl px-5 py-3 shadow-2xl shadow-blue-600/30 max-w-lg w-[calc(100%-2rem)]">
            <div className="flex items-center gap-3 mb-1.5">
              <button onClick={() => setSelected(new Set())} className="w-6 h-6 flex items-center justify-center rounded-full bg-white/20 text-white text-xs font-bold hover:bg-white/30 transition flex-shrink-0">
                &times;
              </button>
              <p className="text-sm font-semibold flex-1">
                {selected.size} selected &middot; {total.toLocaleString()} {currency}
              </p>
              <span className="text-xs opacity-75">Avg: {Math.round(avg).toLocaleString()}</span>
            </div>
            {Object.keys(byCat).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                  <span key={cat} className="px-2 py-0.5 bg-white/15 rounded-full text-[11px]">
                    {cat}: {amt.toLocaleString()}
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const text = `${selected.size} expenses | Total: ${total.toLocaleString()} ${currency} | Avg: ${Math.round(avg).toLocaleString()} ${currency}`;
                  navigator.clipboard?.writeText(text);
                  setSuccess("Copied to clipboard!");
                  setTimeout(() => setSuccess(""), 2000);
                }}
                className="px-3 py-1.5 bg-white/20 rounded-lg text-xs font-medium hover:bg-white/30 transition"
              >
                Copy Summary
              </button>
              <button onClick={bulkDelete} className="px-3 py-1.5 bg-red-500/80 rounded-lg text-xs font-medium hover:bg-red-500 transition">
                Move to trash
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
