// Task #120 polish (Agent E): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { Link } from "react-router-dom";
import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { errText } from "../utils/errText";
import { FadeIn } from "../components/AnimationKit";
import { PageHeader, StatCard, SectionBanner, TabPills, Button } from "../components/ui";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }

export default function BranchPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [branches, setBranches] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("overview");
  // Plan caps from /billing/me — drives the "X/Y used" hint and the
  // upgrade prompt when at cap. Failure to load falls back to the
  // legacy unlimited behaviour (better than blocking the whole page).
  const [billing, setBilling] = useState(null);
  // Surface the backend cap-error message verbatim if create_branch
  // returns 403 (handles the "Branch limit reached" case)
  const [createError, setCreateError] = useState("");

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newType, setNewType] = useState("restaurant");

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [branchRes, summaryRes, billingRes] = await Promise.all([
        api.get("/branches/list"),
        api.get("/branches/summary"),
        api.get("/billing/me").catch(() => ({ data: null })),
      ]);
      setBranches(branchRes.data.branches || []);
      setSummary(summaryRes.data);
      setBilling(billingRes.data);
    } catch { /* silent */ }
    setLoading(false);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreateError("");
    try {
      await api.post("/branches/create", { name: newName.trim(), address: newAddress.trim() || null, business_type: newType });
      setNewName(""); setNewAddress(""); setNewType("restaurant"); setShowCreate(false);
      fetchData();
    } catch (err) {
      // Cap-hit: backend returns 403 with explicit upgrade message.
      // Show it inline so the owner sees WHY rather than a silent failure.
      const detail = err?.response?.data?.detail;
      const status = err?.response?.status;
      if (status === 403 && detail) {
        setCreateError(errText(err, t("branchCreateFailed") || "Could not create branch"));
      } else {
        setCreateError(t("branchCreateFailed") || "Could not create branch");
      }
    }
  };

  // Derive cap state for the UI. cap < 0 = unlimited.
  const branchCap = billing?.caps?.branches ?? null;
  const branchesUsed = branches.length;
  const branchUnlimited = branchCap !== null && branchCap < 0;
  const branchAtCap = branchCap !== null && !branchUnlimited && branchesUsed >= branchCap;

  const handleSetDefault = async (branchId) => {
    try {
      await api.post(`/branches/${branchId}/set-default`);
      fetchData();
    } catch { /* silent */ }
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🏢</div>
          <p className="text-gray-500 dark:text-gray-400">Loading branches...</p>
        </div>
      </div>
    );
  }

  const hasBranches = branches.length > 0;
  const chartData = summary?.branches?.map(b => ({
    name: b.name.length > 15 ? b.name.slice(0, 15) + "..." : b.name,
    Revenue: b.month_revenue,
    Expenses: b.month_expenses,
    Profit: b.month_profit,
  })) || [];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <PageHeader
          eyebrow="MANAGE"
          title={t("branches") || "Branch Bookkeeping"}
          subtitle={
            branchCap !== null
              ? branchUnlimited
                ? (t("branchesUnlimited") || "Unlimited branches on your plan")
                : (t("branchesUsedOfCap") || "{used} of {cap} branches used")
                    .replace("{used}", branchesUsed)
                    .replace("{cap}", branchCap)
              : null
          }
          actions={
            <Button
              variant="accent"
              onClick={() => setShowCreate(!showCreate)}
              disabled={branchAtCap}
              title={branchAtCap ? (t("branchAtCapHint") || "Branch limit reached on your plan — upgrade for more") : ""}
            >
              + New Branch
            </Button>
          }
        />
      </FadeIn>

      {/* Cap-hit upgrade prompt — appears below header when at cap.
          App Store compliance (Apple 3.1.1): this banner is purely an "Upgrade
          to Pro" prompt, so it's hidden on native. Web unchanged. */}
      {branchAtCap && !isNativeApp() && (
        <FadeIn delay={0.02}>
          <SectionBanner
            severity="warn"
            icon="AlertTriangle"
            title={(t("branchCapHitTitle") || "{cap} branch on your plan").replace("{cap}", branchCap)}
          >
            {t("branchCapHitBody") || "Upgrade to Pro for up to 3 branches with cross-outlet daily close consolidation."}
            {" "}
            {canPurchaseInApp() && (
              <Link to="/subscription" className="font-semibold underline whitespace-nowrap">
                {t("seePlans") || "See plans →"}
              </Link>
            )}
          </SectionBanner>
        </FadeIn>
      )}

      {/* ─── CREATE BRANCH ─── */}
      {showCreate && (
        <form onSubmit={handleCreate} className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm space-y-3">
          <h3 className="font-bold text-gray-700 dark:text-gray-200">{t("createBranch")}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("branchNamePlaceholder")}
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" required />
            <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder={t("addressOptionalPlaceholder")}
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" />
            <select value={newType} onChange={(e) => setNewType(e.target.value)}
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm dark:text-gray-200">
              <option value="restaurant">🍽️ Restaurant / Cafe</option>
              <option value="workshop">🔧 Workshop / Garage</option>
              <option value="retail">🛒 Retail / Shop</option>
              <option value="service">💼 Service</option>
              <option value="general">🏢 General</option>
            </select>
          </div>
          {createError && (
            <div className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {createError}
            </div>
          )}
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium">{t("create")}</button>
            <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">{t("cancel")}</button>
          </div>
        </form>
      )}

      {/* ─── CONSOLIDATED SUMMARY ─── */}
              {/* This card was a DARK panel (text-white + opacity-NN labels + bg-white/10
            glass). db32753 swapped the background to light and left the light
            foreground behind, so in light mode every figure below rendered white
            on #f9fafb (~1.045:1) — the consolidated revenue/expenses/profit were
            all invisible. Foreground now flips with the background. */}
{summary?.has_branches && (
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-6 text-gray-900 dark:text-white shadow-sm">
          <h2 className="font-bold text-lg mb-1">Consolidated View — This Month</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t("allBranchesCombined")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="bg-white dark:bg-white/10 border border-gray-100 dark:border-transparent rounded-xl p-3 sm:p-4 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t("totalRevenue")}</p>
              <p className="text-xl sm:text-2xl font-bold mt-1 tabular-nums">{fmt(summary.consolidated.month_revenue)}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{currency}</p>
            </div>
            <div className="bg-white dark:bg-white/10 border border-gray-100 dark:border-transparent rounded-xl p-3 sm:p-4 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t("totalExpenses")}</p>
              <p className="text-xl sm:text-2xl font-bold mt-1 tabular-nums">{fmt(summary.consolidated.month_expenses)}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{currency}</p>
            </div>
            <div className="bg-white dark:bg-white/10 border border-gray-100 dark:border-transparent rounded-xl p-3 sm:p-4 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t("totalProfit")}</p>
              <p className="text-xl sm:text-2xl font-bold mt-1 tabular-nums">{fmt(summary.consolidated.month_profit)}</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">{currency}</p>
            </div>
          </div>
          {summary.unassigned?.revenue > 0 && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
              * Includes {fmt(summary.unassigned.revenue)} {currency} unassigned revenue not linked to any branch.
            </p>
          )}
        </div>
      )}

      {/* ─── TABS ─── */}
      {hasBranches && (
        <TabPills
          tabs={[
            { id: "overview", label: t("overview") },
            { id: "branches", label: t("branches"), count: branches.length },
          ]}
          activeId={tab}
          onChange={setTab}
          wrap={false}
        />
      )}

      {/* ─── OVERVIEW TAB ─── */}
      {tab === "overview" && hasBranches && (
        <div className="space-y-6">
          {/* Comparison chart */}
          {chartData.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm">
              <h2 className="font-bold text-gray-800 dark:text-white mb-4">📊 Branch Comparison — This Month</h2>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={(v) => fmt(v)} />
                    <Tooltip
                      formatter={(val) => [`${fmt(val)} ${currency}`, undefined]}
                      contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}
                    />
                    <Legend />
                    <Bar dataKey="Revenue" fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Profit" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Branch cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {summary?.branches?.map((b) => {
              const margin = b.month_revenue > 0 ? Math.round(b.month_profit / b.month_revenue * 100) : 0;
              return (
                <div key={b.id} className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-gray-800 dark:text-white">{b.name}</p>
                      {b.is_default && (
                        <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-0.5 rounded-full">
                          {t("defaultLabel")}
                        </span>
                      )}
                      {b.business_type && b.business_type !== "general" && (
                        <span className="text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 px-2 py-0.5 rounded-full">
                          {{ restaurant: "🍽️", workshop: "🔧", retail: "🛒", service: "💼" }[b.business_type] || ""} {b.business_type}
                        </span>
                      )}
                    </div>
                    <span className={`text-sm font-bold ${margin >= 20 ? "text-emerald-600" : margin >= 0 ? "text-yellow-600" : "text-red-600"}`}>
                      {margin}% margin
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-xs text-gray-500">{t("revenue")}</p>
                      <p className="text-base sm:text-lg font-bold text-emerald-600">{fmt(b.month_revenue)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">{t("expenses")}</p>
                      <p className="text-base sm:text-lg font-bold text-red-500">{fmt(b.month_expenses)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">{t("profit")}</p>
                      <p className={`text-base sm:text-lg font-bold ${b.month_profit >= 0 ? "text-blue-600" : "text-red-600"}`}>{fmt(b.month_profit)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── BRANCHES TAB ─── */}
      {tab === "branches" && (
        <div className="space-y-4">
          {branches.map((b) => (
            <div key={b.id} className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-lg font-bold text-gray-800 dark:text-white">{b.name}</p>
                    {b.is_default && (
                      <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-0.5 rounded-full">{t("defaultLabel")}</span>
                    )}
                    {b.business_type && b.business_type !== "general" && (
                      <span className="text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 px-2 py-0.5 rounded-full">
                        {{ restaurant: "🍽️", workshop: "🔧", retail: "🛒", service: "💼" }[b.business_type] || ""} {b.business_type}
                      </span>
                    )}
                  </div>
                  {b.address && <p className="text-sm text-gray-500 mt-1">📍 {b.address}</p>}
                  <p className="text-xs text-gray-400 mt-1">Created: {b.created}</p>
                </div>
                {!b.is_default && (
                  <button onClick={() => handleSetDefault(b.id)}
                    className="text-xs text-emerald-600 hover:underline">{t("setAsDefault")}</button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 sm:gap-3 mt-4">
                <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-2 sm:p-3 text-center">
                  <p className="text-[10px] sm:text-xs text-gray-500">{t("revenue")}</p>
                  <p className="text-sm sm:text-lg font-bold text-emerald-600">{fmt(b.total_revenue)}</p>
                  <p className="text-[10px] text-gray-400 sm:hidden">{currency}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-2 sm:p-3 text-center">
                  <p className="text-[10px] sm:text-xs text-gray-500">{t("expenses")}</p>
                  <p className="text-sm sm:text-lg font-bold text-red-500">{fmt(b.total_expenses)}</p>
                  <p className="text-[10px] text-gray-400 sm:hidden">{currency}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-2 sm:p-3 text-center">
                  <p className="text-[10px] sm:text-xs text-gray-500">{t("inventory")}</p>
                  <p className="text-sm sm:text-lg font-bold text-blue-600">{b.inventory_items}</p>
                  <p className="text-[10px] text-gray-400 sm:hidden">{t("items")}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── EMPTY STATE ─── */}
      {!hasBranches && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-8 shadow-sm text-center">
          <div className="text-5xl mb-3">🏢</div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-2">{t("noBranchesYet")}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto mb-4">
            Create branches to manage multiple locations with separate bookkeeping — all from one account.
            Each branch gets its own sales, expenses, inventory, and cashbook.
          </p>
          <button onClick={() => setShowCreate(true)}
            className="px-6 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition">
            {t("createFirstBranch")}
          </button>
        </div>
      )}

      {/* ─── HOW IT WORKS ─── */}
      {!hasBranches && (
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-5">
          <h3 className="font-bold text-blue-800 dark:text-blue-200 mb-3">{t("howBranchBookkeeping")}</h3>
          <div className="space-y-2 text-sm text-blue-700 dark:text-blue-300">
            <p>1. <strong>{t("nameYourLocations")}</strong></p>
            <p>2. <strong>{t("pickActiveBranch")}</strong></p>
            <p>3. {t("howBranchStep3") || "Each branch keeps its own books automatically"}</p>
            <p>4. {t("howBranchStep4") || "Get the big picture with a combined view across all branches"}</p>
            <p>5. <strong>{t("compareSideBySide")}</strong></p>
          </div>
        </div>
      )}
    </div>
  );
}
