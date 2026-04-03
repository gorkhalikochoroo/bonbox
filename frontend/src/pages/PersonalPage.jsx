import { useState, useEffect, useMemo, useCallback } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { formatDate, formatDateShort } from "../utils/dateFormat";

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
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);
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
  const [loanSummary, setLoanSummary] = useState({ total_borrowed: 0, total_lent: 0, net_balance: 0, persons: [] });
  const [showBudgetEditor, setShowBudgetEditor] = useState(false);
  const [budgets, setBudgets] = useState({});
  const [totalBudget, setTotalBudget] = useState(0);
  const [showMonthlyReport, setShowMonthlyReport] = useState(false);
  const [budgetDirty, setBudgetDirty] = useState(false);

  const fetchData = () => {
    api.get("/expenses", { params: { is_personal: true } })
      .then((res) => setEntries(res.data))
      .catch(() => {});
    api.get("/expenses/categories")
      .then((res) => setCategories(res.data))
      .catch(() => {});
  };

  const fetchLoanSummary = () => {
    api.get("/loans/summary").then((r) => setLoanSummary(r.data)).catch(() => {});
  };

  useEffect(() => {
    fetchData();
    fetchLoanSummary();
    const onDataChanged = () => { fetchData(); fetchLoanSummary(); };
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

  const setupPersonalCategories = async () => {
    try {
      for (const name of PERSONAL_CATEGORIES) {
        await api.post("/expenses/categories", { name });
      }
      fetchData();
      setSuccess(t("personalCategoriesCreated"));
      setTimeout(() => setSuccess(""), 2500);
    } catch {
      setError(t("failedToCreateCategories"));
    }
  };

  const isIncome = (catName) => INCOME_CATS.includes(catName);

  // Fast category lookup map instead of .find() on every entry
  const catMap = useMemo(() => {
    const m = {};
    categories.forEach((c) => { m[c.id] = c.name; });
    return m;
  }, [categories]);
  const getCatName = useCallback((id) => catMap[id] || "", [catMap]);

  // Memoize all heavy computations
  const { filteredEntries, totalIncome, totalSpent, balance, spendingByCategory, topSpending, incomeByCategory, totalLoanPayments, savingsRate, monthEntries } = useMemo(() => {
    const monthE = entries.filter((e) => e.date.startsWith(filterMonth));
    let inc = 0, spent = 0;
    const spendByCat = {};
    const incByCat = {};
    let loanPay = 0;

    monthE.forEach((e) => {
      const catName = getCatName(e.category_id);
      const amt = parseFloat(e.amount);
      if (isIncome(catName)) {
        inc += amt;
        incByCat[catName] = (incByCat[catName] || 0) + amt;
      } else {
        spent += amt;
        spendByCat[catName] = (spendByCat[catName] || 0) + amt;
      }
      if (["Loan Payment", "EMI"].includes(catName)) loanPay += amt;
    });

    const filtered = entries.filter((e) => {
      if (filterMonth && !e.date.startsWith(filterMonth)) return false;
      const catName = getCatName(e.category_id);
      if (tab === "income" && !isIncome(catName)) return false;
      if (tab === "spent" && isIncome(catName)) return false;
      return true;
    }).sort((a, b) => {
      const d = b.date.localeCompare(a.date);
      if (d !== 0) return d;
      return (b.created_at || "").localeCompare(a.created_at || "");
    });

    const bal = inc - spent;
    const rate = inc > 0 ? Math.round((bal / inc) * 100) : 0;

    return {
      filteredEntries: filtered,
      totalIncome: inc,
      totalSpent: spent,
      balance: bal,
      spendingByCategory: spendByCat,
      topSpending: Object.entries(spendByCat).sort((a, b) => b[1] - a[1]),
      incomeByCategory: incByCat,
      totalLoanPayments: loanPay,
      savingsRate: rate,
      monthEntries: monthE,
    };
  }, [entries, filterMonth, tab, getCatName]);

  // Loan data from Loan Tracker API
  const totalBorrowed = loanSummary.total_borrowed;
  const totalLent = loanSummary.total_lent;
  const loanNetBalance = loanSummary.net_balance;

  // Fetch budgets from API
  const fetchBudgets = () => {
    api.get("/budgets", { params: { month: filterMonth } }).then((r) => {
      const map = {};
      let total = 0;
      r.data.forEach((b) => {
        if (b.category === "__TOTAL__") total = b.limit_amount;
        else map[b.category] = b.limit_amount;
      });
      setBudgets(map);
      setTotalBudget(total);
    }).catch(() => {});
  };

  useEffect(() => { fetchBudgets(); }, [filterMonth]);

  // Budget helpers
  const saveBudgets = (newBudgets) => {
    setBudgets(newBudgets);
    setBudgetDirty(true);
  };
  const saveTotalBudget = (val) => {
    setTotalBudget(val);
    setBudgetDirty(true);
  };
  const saveBudgetsToApi = () => {
    const items = Object.entries(budgets).map(([category, limit_amount]) => ({ category, limit_amount }));
    items.push({ category: "__TOTAL__", limit_amount: totalBudget });
    api.put("/budgets", { month: filterMonth, budgets: items }).then(() => {
      setBudgetDirty(false);
    }).catch(() => {});
  };

  // Budget warnings — categories that exceeded their budget
  const overBudgetCats = Object.entries(budgets).filter(([cat, limit]) => {
    const spent = spendingByCategory[cat] || 0;
    return limit > 0 && spent > limit;
  }).map(([cat, limit]) => ({ cat, limit, spent: spendingByCategory[cat] || 0, over: (spendingByCategory[cat] || 0) - limit }));

  // Near budget (80%+)
  const nearBudgetCats = Object.entries(budgets).filter(([cat, limit]) => {
    const spent = spendingByCategory[cat] || 0;
    return limit > 0 && spent >= limit * 0.8 && spent <= limit;
  }).map(([cat, limit]) => ({ cat, limit, spent: spendingByCategory[cat] || 0, pct: Math.round(((spendingByCategory[cat] || 0) / limit) * 100) }));

  const totalBudgetUsed = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;

  // Monthly report data
  const spendingCats = PERSONAL_CATEGORIES.filter((c) => !INCOME_CATS.includes(c));

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
      setSuccess(`${value.toLocaleString()} ${currency} ${t("logged")}`);
      fetchData();
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToAddEntry"));
    }
  };

  const deleteEntry = async (id) => {
    try {
      await api.delete(`/expenses/${id}`);
      fetchData();
    } catch {}
  };

  // Personal categories that exist (deduplicated by name, keeping first match)
  const seen = new Set();
  const personalCats = categories.filter((c) => {
    if (!PERSONAL_CATEGORIES.includes(c.name) || seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
  // Sort to match PERSONAL_CATEGORIES order
  personalCats.sort((a, b) => PERSONAL_CATEGORIES.indexOf(a.name) - PERSONAL_CATEGORIES.indexOf(b.name));
  const hasPersonalCats = personalCats.length > 0;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("personalFinance")}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("trackPersonalIncome")}</p>
        </div>
      </div>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {/* Quick setup */}
      {!hasPersonalCats && (
        <div className="bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-700 p-5 rounded-xl">
          <p className="text-purple-800 dark:text-purple-300 font-medium mb-2">{t("setupPersonalCategories")}</p>
          <p className="text-purple-600 dark:text-purple-400 text-sm mb-3">{PERSONAL_CATEGORIES.join(", ")}</p>
          <button onClick={setupPersonalCategories}
            className="bg-purple-600 text-white px-5 py-2.5 rounded-lg hover:bg-purple-700 transition font-medium text-sm">
            {t("createCategories")}
          </button>
        </div>
      )}

      {/* Wallet — one big balance, auto-deducts */}
      <div className={`rounded-2xl shadow-sm border p-5 sm:p-6 text-center ${
        balance >= 0
          ? "bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 border-green-200 dark:border-green-800"
          : "bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-900/20 dark:to-orange-900/20 border-red-200 dark:border-red-800"
      }`}>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">
          {balance >= 0 ? t("youHave") : t("youreShort")}
        </p>
        <p className={`text-4xl sm:text-5xl font-extrabold ${
          balance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"
        }`}>
          {balance.toLocaleString()} <span className="text-lg font-medium text-gray-400">{currency}</span>
        </p>
        <div className="flex items-center justify-center gap-4 mt-3 text-sm">
          <span className="text-green-600 dark:text-green-400">+{totalIncome.toLocaleString()} {t("in")}</span>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <span className="text-red-500 dark:text-red-400">-{totalSpent.toLocaleString()} {t("out")}</span>
        </div>
        {/* Progress bar */}
        {totalIncome > 0 && (
          <div className="mt-3 max-w-xs mx-auto">
            <div className="h-2 bg-white/60 dark:bg-gray-700/60 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${
                totalSpent > totalIncome ? "bg-red-500" : totalSpent >= totalIncome * 0.8 ? "bg-amber-500" : "bg-green-500"
              }`} style={{ width: `${Math.min((totalSpent / totalIncome) * 100, 100)}%` }} />
            </div>
            <p className="text-xs text-gray-400 mt-1">{Math.min(Math.round((totalSpent / totalIncome) * 100), 999)}% {t("spent")}</p>
          </div>
        )}
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className={`bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border text-center ${loanNetBalance >= 0 ? "border-blue-100 dark:border-blue-900" : "border-orange-100 dark:border-orange-900"}`}>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("loans")}</p>
          <p className={`text-xl font-bold mt-0.5 ${loanNetBalance >= 0 ? "text-blue-600 dark:text-blue-400" : "text-orange-600 dark:text-orange-400"}`}>
            {loanNetBalance >= 0 ? "+" : ""}{loanNetBalance.toLocaleString()} <span className="text-xs font-normal text-gray-400">{currency}</span>
          </p>
          <p className="text-xs text-gray-400">{loanNetBalance >= 0 ? t("owedToYou") : t("youOwe")}</p>
        </div>
        <div className={`bg-white dark:bg-gray-800 p-4 rounded-xl shadow-sm border text-center ${(balance + loanNetBalance) >= 0 ? "border-purple-100 dark:border-purple-900" : "border-red-100 dark:border-red-900"}`}>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t("netWorth")}</p>
          <p className={`text-xl font-bold mt-0.5 ${(balance + loanNetBalance) >= 0 ? "text-purple-600 dark:text-purple-400" : "text-red-500 dark:text-red-400"}`}>
            {(balance + loanNetBalance).toLocaleString()} <span className="text-xs font-normal text-gray-400">{currency}</span>
          </p>
          <p className="text-xs text-gray-400">{t("balancePlusLoans")}</p>
        </div>
      </div>

      {/* Budget Warnings */}
      {overBudgetCats.length > 0 && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 space-y-2">
          <p className="text-red-700 dark:text-red-400 font-semibold text-sm flex items-center gap-2">
            <span className="text-lg">!</span> {t("budgetExceeded")}
          </p>
          {overBudgetCats.map(({ cat, limit, spent, over }) => (
            <div key={cat} className="flex items-center justify-between text-sm">
              <span className="text-red-600 dark:text-red-400 font-medium">{cat}</span>
              <span className="text-red-600 dark:text-red-400">
                {spent.toLocaleString()} / {limit.toLocaleString()} {currency}
                <span className="ml-2 bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 px-2 py-0.5 rounded text-xs font-bold">
                  +{over.toLocaleString()} {t("over")}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {nearBudgetCats.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 space-y-2">
          <p className="text-amber-700 dark:text-amber-400 font-semibold text-sm flex items-center gap-2">
            <span className="text-lg">!</span> {t("approachingBudgetLimit")}
          </p>
          {nearBudgetCats.map(({ cat, limit, spent, pct }) => (
            <div key={cat} className="flex items-center justify-between text-sm">
              <span className="text-amber-600 dark:text-amber-400 font-medium">{cat}</span>
              <span className="text-amber-600 dark:text-amber-400">
                {spent.toLocaleString()} / {limit.toLocaleString()} {currency}
                <span className="ml-2 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded text-xs font-bold">
                  {pct}% {t("used")}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {totalBudget > 0 && (
        <div className={`rounded-xl p-4 border ${totalBudgetUsed > 100 ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800" : totalBudgetUsed >= 80 ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800" : "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"}`}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t("monthlyBudget")}</span>
            <span className={`text-sm font-bold ${totalBudgetUsed > 100 ? "text-red-600" : totalBudgetUsed >= 80 ? "text-amber-600" : "text-green-600"}`}>
              {totalSpent.toLocaleString()} / {totalBudget.toLocaleString()} {currency} ({totalBudgetUsed}%)
            </span>
          </div>
          <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${totalBudgetUsed > 100 ? "bg-red-500" : totalBudgetUsed >= 80 ? "bg-amber-500" : "bg-green-500"}`}
              style={{ width: `${Math.min(totalBudgetUsed, 100)}%` }} />
          </div>
          {totalBudgetUsed > 100 && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-1 font-medium">{t("youveExceededMonthlyBudgetBy")} {(totalSpent - totalBudget).toLocaleString()} {currency}</p>
          )}
        </div>
      )}

      {/* Budget & Report Buttons */}
      <div className="flex gap-3">
        <button onClick={() => setShowBudgetEditor(!showBudgetEditor)}
          className="px-4 py-2.5 rounded-xl text-sm font-medium border border-purple-200 dark:border-purple-700 text-purple-700 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 transition">
          {showBudgetEditor ? t("hideBudgetSettings") : t("setBudget")}
        </button>
        <button onClick={() => setShowMonthlyReport(!showMonthlyReport)}
          className="px-4 py-2.5 rounded-xl text-sm font-medium border border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition">
          {showMonthlyReport ? t("hideMonthlyReport") : t("monthlyReport")}
        </button>
      </div>

      {/* Budget Editor */}
      {showBudgetEditor && (
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-4">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("monthlyBudgetSettings")}</h2>
          <div className="flex items-center gap-3 pb-3 border-b border-gray-100 dark:border-gray-700">
            <label className="text-sm font-medium text-gray-600 dark:text-gray-400 whitespace-nowrap">{t("totalMonthlyBudget")}:</label>
            <input type="number" value={totalBudget || ""} onChange={(e) => saveTotalBudget(parseFloat(e.target.value) || 0)}
              placeholder="e.g. 15000" className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-40" />
            <span className="text-sm text-gray-400">{currency}</span>
          </div>
          <p className="text-xs text-gray-400">{t("setLimitsPerCategory")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {spendingCats.map((cat) => (
              <div key={cat} className="flex items-center gap-2">
                <span className="text-sm text-gray-600 dark:text-gray-400 w-32 truncate">{cat}</span>
                <input type="number" value={budgets[cat] || ""} onChange={(e) => saveBudgets({ ...budgets, [cat]: parseFloat(e.target.value) || 0 })}
                  placeholder="0" className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-24" />
              </div>
            ))}
          </div>
          <button onClick={saveBudgetsToApi}
            className={`mt-3 px-5 py-2.5 rounded-lg text-sm font-medium transition ${
              budgetDirty ? "bg-purple-600 text-white hover:bg-purple-700" : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
            }`}>
            {budgetDirty ? t("saveBudget") : t("saved")}
          </button>
        </div>
      )}

      {/* Monthly Report */}
      {showMonthlyReport && (
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-5">
          <div className="text-center border-b border-gray-100 dark:border-gray-700 pb-4">
            <p className="text-xs text-gray-400 uppercase tracking-wider">{t("monthlyReport")}</p>
            <p className="text-lg font-bold text-gray-800 dark:text-white mt-1">{new Date(filterMonth + "-01").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</p>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="text-center p-3 bg-green-50 dark:bg-green-900/20 rounded-xl">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t("income")}</p>
              <p className="text-lg font-bold text-green-600 dark:text-green-400">{totalIncome.toLocaleString()}</p>
            </div>
            <div className="text-center p-3 bg-red-50 dark:bg-red-900/20 rounded-xl">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t("expense")}</p>
              <p className="text-lg font-bold text-red-500 dark:text-red-400">{totalSpent.toLocaleString()}</p>
            </div>
            <div className={`text-center p-3 rounded-xl ${balance >= 0 ? "bg-green-50 dark:bg-green-900/20" : "bg-red-50 dark:bg-red-900/20"}`}>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t("saved")}</p>
              <p className={`text-lg font-bold ${balance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>{balance.toLocaleString()}</p>
            </div>
            <div className="text-center p-3 bg-purple-50 dark:bg-purple-900/20 rounded-xl">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t("savingsRate")}</p>
              <p className={`text-lg font-bold ${savingsRate >= 20 ? "text-green-600" : savingsRate >= 0 ? "text-amber-600" : "text-red-500"}`}>{savingsRate}%</p>
            </div>
          </div>

          {/* Income Breakdown */}
          {Object.keys(incomeByCategory).length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-2">{t("incomeSources")}</h3>
              <div className="space-y-2">
                {Object.entries(incomeByCategory).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                  <div key={cat} className="flex items-center justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">{cat}</span>
                    <span className="font-medium text-green-600 dark:text-green-400">+{amt.toLocaleString()} {currency}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Spending vs Budget */}
          <div>
            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-2">{t("spendingByCategory")}</h3>
            <div className="space-y-3">
              {topSpending.map(([cat, amt]) => {
                const limit = budgets[cat] || 0;
                const pct = limit > 0 ? Math.round((amt / limit) * 100) : 0;
                const exceeded = limit > 0 && amt > limit;
                return (
                  <div key={cat}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-600 dark:text-gray-400">{cat}</span>
                      <span className={`font-medium ${exceeded ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>
                        {amt.toLocaleString()} {limit > 0 ? `/ ${limit.toLocaleString()}` : ""} {currency}
                        {exceeded && <span className="ml-1 text-xs text-red-500 font-bold">{t("over").toUpperCase()}</span>}
                      </span>
                    </div>
                    {limit > 0 && (
                      <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${exceeded ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-green-500"}`}
                          style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
              {topSpending.length === 0 && <p className="text-sm text-gray-400">{t("noSpendingThisMonth")}</p>}
            </div>
          </div>

          {/* Verdict */}
          <div className={`p-4 rounded-xl text-center ${balance >= 0 ? "bg-green-50 dark:bg-green-900/20" : "bg-red-50 dark:bg-red-900/20"}`}>
            <p className={`text-lg font-bold ${balance >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
              {balance >= 0
                ? savingsRate >= 20 ? t("greatMonth") : t("inTheGreen")
                : t("overspentThisMonth")}
            </p>
            {totalBudget > 0 && totalSpent > totalBudget && (
              <p className="text-sm text-red-500 mt-1">{t("budgetExceededBy")} {(totalSpent - totalBudget).toLocaleString()} {currency}</p>
            )}
          </div>
        </div>
      )}

      {/* Monthly Insights */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Spending breakdown */}
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{t("whereYourMoneyGoes")}</h2>
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
            <p className="text-sm text-gray-400">{t("noSpendingData")}</p>
          )}
        </div>

        {/* Financial snapshot */}
        <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 space-y-3">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t("financialSnapshot")}</h2>
            <a href="/loans" className="text-xs text-purple-600 dark:text-purple-400 hover:underline">{t("viewLoanTracker")}</a>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">{t("savingsRate")}</span>
            <span className={`text-sm font-bold ${savingsRate >= 20 ? "text-green-600" : savingsRate >= 0 ? "text-yellow-600" : "text-red-500"}`}>
              {savingsRate}%
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">{t("iOweBorrowed")}</span>
            <span className="text-sm font-bold text-orange-600 dark:text-orange-400">{totalBorrowed.toLocaleString()} {currency}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">{t("owedToMeLent")}</span>
            <span className="text-sm font-bold text-blue-600 dark:text-blue-400">{totalLent.toLocaleString()} {currency}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">{t("loanEmiPaid")}</span>
            <span className="text-sm font-bold text-gray-700 dark:text-gray-300">{totalLoanPayments.toLocaleString()} {currency}</span>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-gray-100 dark:border-gray-700">
            <span className="text-sm text-gray-500 dark:text-gray-400">{t("netBalance")}</span>
            <span className={`text-sm font-bold ${loanNetBalance >= 0 ? "text-green-600" : "text-red-500"}`}>
              {loanNetBalance >= 0 ? "+" : ""}{loanNetBalance.toLocaleString()} {currency}
            </span>
          </div>
          {loanSummary.persons?.length > 0 && (
            <div className="pt-2 border-t border-gray-100 dark:border-gray-700 space-y-1">
              <p className="text-xs text-gray-400 uppercase">{t("topPeople")}</p>
              {loanSummary.persons.slice(0, 3).map((p, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-gray-600 dark:text-gray-400">{p.name}</span>
                  <span className={`font-medium ${p.net >= 0 ? "text-green-600" : "text-orange-600"}`}>
                    {p.net >= 0 ? `+${Number(p.net).toLocaleString()}` : Number(p.net).toLocaleString()} {currency}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add entry */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">{t("addEntry")}</h2>
        <p className="text-sm text-gray-400 mb-4">{t("pickCategoryOrType")}</p>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {(hasPersonalCats ? personalCats : categories).map((c) => (
            <button
              key={c.id}
              onClick={() => { setCatId(c.id); setCustomCat(""); if (!desc) setDesc(c.name); }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition whitespace-nowrap ${
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

        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm text-gray-400">{t("or")}</span>
          <input
            type="text"
            value={customCat}
            onChange={(e) => { setCustomCat(e.target.value); if (e.target.value) setCatId(""); }}
            placeholder={t("typeCustomCategory")}
            className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
          />
        </div>

        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t("descriptionOptional")}
          className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
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

        <div className="flex items-center gap-2 mb-3">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t("customAmount")}
            className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={submit}
            disabled={!amount || (!catId && !customCat.trim())}
            className="px-5 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition font-semibold text-sm disabled:opacity-40"
          >
            {t("add")}
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
            {["cash", "card", "bankTransfer"].map((m) => (
              <button key={m} onClick={() => setMethod(m === "bankTransfer" ? "bank_transfer" : m)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                  method === (m === "bankTransfer" ? "bank_transfer" : m) ? "bg-purple-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                }`}>{t(m)}</button>
            ))}
          </div>
        </div>

        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder={LEND_BORROW_CATS.includes(getCatName(catId)) ? t("whoEgName") : t("notesOptional")}
          className="mt-3 w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
        {LEND_BORROW_CATS.includes(getCatName(catId)) && (
          <p className="mt-1 text-xs text-purple-500 dark:text-purple-400">
            {t("tipAddPersonName")}
          </p>
        )}
      </div>

      {/* History */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("history")}</h2>
            <div className="flex gap-1 ml-2">
              {[{ key: "all", label: "all" }, { key: "income", label: "income" }, { key: "spent", label: "expense" }].map(({ key, label }) => (
                <button key={key} onClick={() => setTab(key)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                    tab === key ? "bg-purple-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                  }`}>{t(label)}</button>
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
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("category")}</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("description")}</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("amount")}</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("payment")}</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("notes")}</th>
                <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {filteredEntries.map((e) => {
                const catName = getCatName(e.category_id);
                const income = isIncome(catName);
                return (
                  <tr key={e.id}>
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{formatDate(e.date)}</td>
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
                      <button onClick={() => deleteEntry(e.id)} className="text-red-400 text-sm hover:underline">{t("delete")}</button>
                    </td>
                  </tr>
                );
              })}
              {filteredEntries.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noEntriesYet")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
