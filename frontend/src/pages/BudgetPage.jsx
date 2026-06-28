// Task #118 polish (Agent C): migrated H1 → PageHeader, over/near-limit
// info banners → SectionBanner, summary stats → StatCard grid, primary
// CTAs → Button variants. Behavior + i18n + a11y unchanged.
import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";
import { PageHeader, Button, SectionBanner, StatCard } from "../components/ui";

const STATUS_COLORS = {
  green: { bg: "bg-emerald-500", track: "bg-gray-100 dark:bg-gray-800", text: "text-emerald-600 dark:text-gray-300", badge: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300" },
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
      setToast(t("bgtToastSaved", "Budget saved"));
      setTimeout(() => setToast(""), 2000);
      // Refresh
      const [sumRes, budRes] = await Promise.all([
        api.get(`/budgets/summary?month=${month}&mode=business`),
        api.get(`/budgets?month=${month}`),
      ]);
      setSummary(sumRes.data);
      setBudgets(budRes.data);
    } catch {
      setToast(t("bgtToastSaveFailed", "Failed to save"));
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
        <div className="fixed top-4 right-4 z-50 bg-gray-900 text-white px-4 py-2 rounded-xl text-sm font-medium shadow-sm animate-fade-in">
          {toast}
        </div>
      )}

      <FadeIn>
        <PageHeader
          eyebrow="MONEY"
          title={t("budgetOverview") || "Budget"}
          subtitle={t("bgtSubtitle", "Track spending vs budget by category")}
          actions={
            <Button
              variant={editing ? "secondary" : "primary"}
              onClick={() => setEditing(!editing)}
            >
              {editing ? t("cancel", "Cancel") : t("setBudget") || "Set Budgets"}
            </Button>
          }
        />
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
            <div key={i} className="h-24 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : editing ? (
        /* ═══ EDIT MODE ═══ */
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700 shadow-sm space-y-5">
            <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("bgtSetMonthlyLimits", "Set monthly limits")}</h2>

            {/* Total budget */}
            <div className="flex items-center gap-3 pb-4 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400 w-32">{t("bgtTotalBudget", "Total Budget")}</span>
              <input
                type="number"
                value={totalLimit}
                onChange={(e) => setTotalLimit(e.target.value)}
                placeholder={t("bgtTotalLimitPlaceholder", "e.g. 50000")}
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
                  <option value="">{t("bgtAddCategoryOption", "Add category...")}</option>
                  {unusedCats.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  value={newCat}
                  onChange={(e) => setNewCat(e.target.value)}
                  placeholder={t("newCategoryPlaceholder")}
                  className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                />
              )}
              <button
                onClick={addCategory}
                disabled={!newCat.trim()}
                className="px-3 py-2 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-lg text-sm font-medium disabled:opacity-40"
              >
                + {t("add", "Add")}
              </button>
            </div>

            <Button
              variant="accent"
              size="lg"
              busy={saving}
              onClick={handleSave}
              className="w-full"
            >
              {saving ? t("bgtSaving", "Saving...") : t("bgtSaveBudgets", "Save Budgets")}
            </Button>
          </div>
        </FadeIn>
      ) : (
        /* ═══ VIEW MODE ═══ */
        <>
          {/* Overall progress */}
          {summary && summary.total_budget > 0 && (
            <FadeIn>
              <div className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t("bgtOverallBudget", "Overall Budget")}</span>
                  <span className="text-sm font-semibold text-gray-800 dark:text-white">
                    {summary.total_spent.toLocaleString()} / {summary.total_budget.toLocaleString()} {currency}
                  </span>
                </div>
                <div className="h-4 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      summary.total_pct > 100 ? "bg-red-500" : summary.total_pct >= 80 ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.min(summary.total_pct, 100)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span className={`text-xs font-semibold ${
                    summary.total_pct > 100 ? "text-red-500" : summary.total_pct >= 80 ? "text-amber-500" : "text-emerald-600"
                  }`}>
                    {summary.total_pct}% {t("bgtUsed", "used")}
                  </span>
                  <span className="text-xs text-gray-400">
                    {Math.max(0, summary.total_budget - summary.total_spent).toLocaleString()} {currency} {t("bgtRemaining", "remaining")}
                  </span>
                </div>
              </div>
            </FadeIn>
          )}

          {/* Alert banners — semantic colors preserved (red for over,
              amber for near limit) since the data warrants it. */}
          {overBudget.length > 0 && (
            <SectionBanner
              severity="critical"
              icon="AlertTriangle"
              title={`${overBudget.length} ${overBudget.length === 1 ? t("bgtCategory", "category") : t("bgtCategories", "categories")} ${t("bgtOverBudgetSuffix", "over budget")}`}
            >
              {overBudget.map((c) => c.category).join(", ")}
            </SectionBanner>
          )}
          {nearBudget.length > 0 && (
            <SectionBanner
              severity="warn"
              icon="AlertTriangle"
              title={`${nearBudget.length} ${nearBudget.length === 1 ? t("bgtCategory", "category") : t("bgtCategories", "categories")} ${t("bgtApproachingLimit", "approaching limit (80%+)")}`}
            />
          )}

          {/* Summary stats — accent only on the semantically-charged
              tiles (near limit = warn, over = critical). */}
          <StaggerGrid className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StaggerGridItem>
              <StatCard label={t("bgtStatCategories", "Categories")} value={String(cats.length)} />
            </StaggerGridItem>
            <StaggerGridItem>
              <StatCard
                label={t("bgtStatOnTrack", "On Track")}
                value={String(cats.filter((c) => c.status === "green").length)}
                accent="success"
              />
            </StaggerGridItem>
            <StaggerGridItem>
              <StatCard label={t("bgtStatNearLimit", "Near Limit")} value={String(nearBudget.length)} accent="warn" />
            </StaggerGridItem>
            <StaggerGridItem>
              <StatCard label={t("bgtStatOverBudget", "Over Budget")} value={String(overBudget.length)} accent="critical" />
            </StaggerGridItem>
          </StaggerGrid>

          {/* Category rows */}
          {cats.length > 0 ? (
            <FadeIn>
              <div className="space-y-3">
                {cats.map((cat) => {
                  const sc = STATUS_COLORS[cat.status] || STATUS_COLORS.green;
                  return (
                    <div key={cat.category} className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-800 dark:text-white">{cat.category}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${sc.badge}`}>
                            {cat.status === "red" ? t("bgtBadgeOver", "Over") : cat.status === "yellow" ? t("bgtBadgeWarning", "Warning") : t("bgtBadgeOk", "OK")}
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
                            {cat.pct}% {t("bgtUsed", "used")}
                            {cat.status === "red" && ` \u2014 ${(cat.spent - cat.limit_amount).toLocaleString()} ${currency} ${t("bgtOverSuffix", "over")}`}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-gray-400 mt-1">{t("bgtNoBudgetSet", "No budget set")} \u2014 {cat.spent.toLocaleString()} {currency} {t("bgtSpent", "spent")}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </FadeIn>
          ) : (
            <FadeIn>
              <div className="bg-white dark:bg-gray-800 rounded-xl p-10 border border-gray-100 dark:border-gray-700 text-center">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">{t("bgtEmptyTitle", "No budgets yet")}</h3>
                <p className="text-sm text-gray-500 mb-4">{t("bgtEmptyDesc", "Set spending limits per category to track your expenses.")}</p>
                <Button variant="primary" onClick={() => setEditing(true)}>
                  {t("setBudget") || "Set Budgets"}
                </Button>
              </div>
            </FadeIn>
          )}
        </>
      )}
    </div>
  );
}
