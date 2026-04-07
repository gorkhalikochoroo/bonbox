import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";

const STATUS_COLORS = {
  green: { bg: "bg-green-500", track: "bg-green-100 dark:bg-green-900/30", text: "text-green-600 dark:text-green-400", badge: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400" },
  yellow: { bg: "bg-amber-500", track: "bg-amber-100 dark:bg-amber-900/30", text: "text-amber-600 dark:text-amber-400", badge: "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400" },
  red: { bg: "bg-red-500", track: "bg-red-100 dark:bg-red-900/30", text: "text-red-600 dark:text-red-400", badge: "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400" },
};

function getMonthStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(str) {
  const [y, m] = str.split("-");
  const d = new Date(+y, +m - 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export default function BudgetPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [monthDate, setMonthDate] = useState(new Date());
  const month = useMemo(() => getMonthStr(monthDate), [monthDate]);

  const [summary, setSummary] = useState(null);
  const [budgets, setBudgets] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLimits, setEditLimits] = useState({});
  const [totalLimit, setTotalLimit] = useState("");
  const [newCat, setNewCat] = useState("");
  const [toast, setToast] = useState("");

  const prevMonth = () => setMonthDate((d) => new Date(d.getFullYear(), d.getMonth() - 1));
  const nextMonth = () => setMonthDate((d) => new Date(d.getFullYear(), d.getMonth() + 1));

  // Fetch data
  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get(`/budgets/summary?month=${month}&mode=business`),
      api.get(`/budgets?month=${month}`),
      api.get("/expenses/categories"),
    ])
      .then(([sumRes, budRes, catRes]) => {
        setSummary(sumRes.data);
        setBudgets(budRes.data);
        setCategories(catRes.data.map((c) => c.name));

        // Init edit limits
        const limits = {};
        budRes.data.forEach((b) => {
          if (b.category === "__TOTAL__") setTotalLimit(String(b.limit_amount));
          else limits[b.category] = String(b.limit_amount);
        });
        setEditLimits(limits);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [month]);

  // Save budgets
  const handleSave = async () => {
    setSaving(true);
    const items = Object.entries(editLimits)
      .filter(([, v]) => v && parseFloat(v) > 0)
      .map(([category, v]) => ({ category, limit_amount: parseFloat(v) }));
    if (totalLimit && parseFloat(totalLimit) > 0) {
      items.push({ category: "__TOTAL__", limit_amount: parseFloat(totalLimit) });
    }
    try {
      await api.put("/budgets", { month, budgets: items });
      setEditing(false);
      setToast("Budget saved");
      setTimeout(() => setToast(""), 2000);
      // Refresh
      const [sumRes, budRes] = await Promise.all([
        api.get(`/budgets/summary?month=${month}&mode=business`),
        api.get(`/budgets?month=${month}`),
      ]);
      setSummary(sumRes.data);
      setBudgets(budRes.data);
    } catch {
      setToast("Failed to save");
      setTimeout(() => setToast(""), 2000);
    }
    setSaving(false);
  };

  // Add new category budget
  const addCategory = () => {
    if (!newCat.trim()) return;
    setEditLimits((prev) => ({ ...prev, [newCat.trim()]: "" }));
    setNewCat("");
  };

  // Unused categories for dropdown
  const unusedCats = categories.filter((c) => !(c in editLimits));

  const cats = summary?.categories || [];
  const overBudget = cats.filter((c) => c.status === "red");
  const nearBudget = cats.filter((c) => c.status === "yellow");

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1000px] mx-auto">
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-green-600 text-white px-4 py-2 rounded-xl text-sm font-medium shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      {/* Header */}
      <FadeIn>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("budgetOverview") || "Budget"}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Track spending vs budget by category</p>
          </div>
          <button
            onClick={() => setEditing(!editing)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition ${
              editing
                ? "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {editing ? "Cancel" : t("setBudget") || "Set Budgets"}
          </button>
        </div>
      </FadeIn>

      {/* Month nav */}
      <FadeIn>
        <div className="flex items-center justify-center gap-4">
          <button onClick={prevMonth} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition text-gray-600 dark:text-gray-400">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <span className="text-lg font-semibold text-gray-800 dark:text-white min-w-[180px] text-center">
            {formatMonth(month)}
          </span>
          <button onClick={nextMonth} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition text-gray-600 dark:text-gray-400">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      </FadeIn>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-gray-100 dark:bg-gray-800 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : editing ? (
        /* ═══ EDIT MODE ═══ */
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700 shadow-sm space-y-5">
            <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">Set monthly limits</h2>

            {/* Total budget */}
            <div className="flex items-center gap-3 pb-4 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400 w-32">Total Budget</span>
              <input
                type="number"
                value={totalLimit}
                onChange={(e) => setTotalLimit(e.target.value)}
                placeholder="e.g. 50000"
                className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
              />
              <span className="text-xs text-gray-400">{currency}</span>
            </div>

            {/* Per-category limits */}
            {Object.entries(editLimits)
              .filter(([k]) => k !== "__TOTAL__")
              .map(([cat, val]) => (
                <div key={cat} className="flex items-center gap-3">
                  <span className="text-sm text-gray-700 dark:text-gray-300 w-32 truncate" title={cat}>{cat}</span>
                  <input
                    type="number"
                    value={val}
                    onChange={(e) => setEditLimits((prev) => ({ ...prev, [cat]: e.target.value }))}
                    placeholder="0"
                    className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                  />
                  <button
                    onClick={() => setEditLimits((prev) => { const n = { ...prev }; delete n[cat]; return n; })}
                    className="text-red-400 hover:text-red-600 text-sm"
                  >
                    &times;
                  </button>
                </div>
              ))}

            {/* Add category */}
            <div className="flex items-center gap-2 pt-3 border-t border-gray-100 dark:border-gray-700">
              {unusedCats.length > 0 ? (
                <select
                  value={newCat}
                  onChange={(e) => setNewCat(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-700 dark:text-gray-300"
                >
                  <option value="">Add category...</option>
                  {unusedCats.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  value={newCat}
                  onChange={(e) => setNewCat(e.target.value)}
                  placeholder="New category name"
                  className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                />
              )}
              <button
                onClick={addCategory}
                disabled={!newCat.trim()}
                className="px-3 py-2 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg text-sm font-medium disabled:opacity-40"
              >
                + Add
              </button>
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full py-3 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 disabled:opacity-50 transition"
            >
              {saving ? "Saving..." : "Save Budgets"}
            </button>
          </div>
        </FadeIn>
      ) : (
        /* ═══ VIEW MODE ═══ */
        <>
          {/* Overall progress */}
          {summary && summary.total_budget > 0 && (
            <FadeIn>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Overall Budget</span>
                  <span className="text-sm font-semibold text-gray-800 dark:text-white">
                    {summary.total_spent.toLocaleString()} / {summary.total_budget.toLocaleString()} {currency}
                  </span>
                </div>
                <div className="h-4 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      summary.total_pct > 100 ? "bg-red-500" : summary.total_pct >= 80 ? "bg-amber-500" : "bg-green-500"
                    }`}
                    style={{ width: `${Math.min(summary.total_pct, 100)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className={`text-xs font-semibold ${
                    summary.total_pct > 100 ? "text-red-500" : summary.total_pct >= 80 ? "text-amber-500" : "text-green-500"
                  }`}>
                    {summary.total_pct}% used
                  </span>
                  <span className="text-xs text-gray-400">
                    {Math.max(0, summary.total_budget - summary.total_spent).toLocaleString()} {currency} remaining
                  </span>
                </div>
              </div>
            </FadeIn>
          )}

          {/* Alert banners */}
          {overBudget.length > 0 && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3">
              <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                {overBudget.length} {overBudget.length === 1 ? "category" : "categories"} over budget
              </p>
              <p className="text-xs text-red-500 dark:text-red-400/70 mt-0.5">
                {overBudget.map((c) => c.category).join(", ")}
              </p>
            </div>
          )}
          {nearBudget.length > 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                {nearBudget.length} {nearBudget.length === 1 ? "category" : "categories"} approaching limit (80%+)
              </p>
            </div>
          )}

          {/* Summary stats */}
          <StaggerGrid className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StaggerGridItem>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 border border-gray-100 dark:border-gray-700 text-center">
                <p className="text-2xl font-bold text-gray-800 dark:text-white">{cats.length}</p>
                <p className="text-xs text-gray-400 mt-1">Categories</p>
              </div>
            </StaggerGridItem>
            <StaggerGridItem>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 border border-gray-100 dark:border-gray-700 text-center">
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">{cats.filter((c) => c.status === "green").length}</p>
                <p className="text-xs text-gray-400 mt-1">On Track</p>
              </div>
            </StaggerGridItem>
            <StaggerGridItem>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 border border-gray-100 dark:border-gray-700 text-center">
                <p className="text-2xl font-bold text-amber-500">{nearBudget.length}</p>
                <p className="text-xs text-gray-400 mt-1">Near Limit</p>
              </div>
            </StaggerGridItem>
            <StaggerGridItem>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 border border-gray-100 dark:border-gray-700 text-center">
                <p className="text-2xl font-bold text-red-500">{overBudget.length}</p>
                <p className="text-xs text-gray-400 mt-1">Over Budget</p>
              </div>
            </StaggerGridItem>
          </StaggerGrid>

          {/* Category rows */}
          {cats.length > 0 ? (
            <FadeIn>
              <div className="space-y-3">
                {cats.map((cat) => {
                  const sc = STATUS_COLORS[cat.status] || STATUS_COLORS.green;
                  return (
                    <div key={cat.category} className="bg-white dark:bg-gray-800 rounded-2xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-800 dark:text-white">{cat.category}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${sc.badge}`}>
                            {cat.status === "red" ? "Over" : cat.status === "yellow" ? "Warning" : "OK"}
                          </span>
                        </div>
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          <span className={`font-semibold ${sc.text}`}>{cat.spent.toLocaleString()}</span>
                          {cat.limit_amount > 0 && <span> / {cat.limit_amount.toLocaleString()} {currency}</span>}
                        </span>
                      </div>
                      {cat.limit_amount > 0 ? (
                        <>
                          <div className={`h-2.5 ${sc.track} rounded-full overflow-hidden`}>
                            <div
                              className={`h-full ${sc.bg} rounded-full transition-all duration-500`}
                              style={{ width: `${Math.min(cat.pct, 100)}%` }}
                            />
                          </div>
                          <p className={`text-xs mt-1.5 ${sc.text} font-medium`}>
                            {cat.pct}% used
                            {cat.status === "red" && ` \u2014 ${(cat.spent - cat.limit_amount).toLocaleString()} ${currency} over`}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-gray-400 mt-1">No budget set \u2014 {cat.spent.toLocaleString()} {currency} spent</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </FadeIn>
          ) : (
            <FadeIn>
              <div className="bg-white dark:bg-gray-800 rounded-2xl p-10 border border-gray-100 dark:border-gray-700 text-center">
                <div className="text-4xl mb-3">📊</div>
                <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">No budgets yet</h3>
                <p className="text-sm text-gray-400 mb-4">Set spending limits per category to track your expenses.</p>
                <button
                  onClick={() => setEditing(true)}
                  className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition"
                >
                  {t("setBudget") || "Set Budgets"}
                </button>
              </div>
            </FadeIn>
          )}
        </>
      )}
    </div>
  );
}
