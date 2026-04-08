import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
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

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newType, setNewType] = useState("restaurant");

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [branchRes, summaryRes] = await Promise.all([
        api.get("/branches/list"),
        api.get("/branches/summary"),
      ]);
      setBranches(branchRes.data.branches || []);
      setSummary(summaryRes.data);
    } catch { /* silent */ }
    setLoading(false);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.post("/branches/create", { name: newName.trim(), address: newAddress.trim() || null, business_type: newType });
      setNewName(""); setNewAddress(""); setNewType("restaurant"); setShowCreate(false);
      fetchData();
    } catch { /* silent */ }
  };

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
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">
            🏢 {t("branches") || "Branch Bookkeeping"}
          </h1>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 transition"
          >
            + New Branch
          </button>
        </div>
      </FadeIn>

      {/* ─── CREATE BRANCH ─── */}
      {showCreate && (
        <form onSubmit={handleCreate} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm space-y-3">
          <h3 className="font-bold text-gray-700 dark:text-gray-200">Create Branch</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Branch name (e.g. Downtown, Mall Branch) *"
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" required />
            <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="Address (optional)"
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
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium">Create</button>
            <button type="button" onClick={() => setShowCreate(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Cancel</button>
          </div>
        </form>
      )}

      {/* ─── CONSOLIDATED SUMMARY ─── */}
      {summary?.has_branches && (
        <div className="bg-gradient-to-br from-green-600 to-emerald-700 rounded-2xl p-6 text-white shadow-lg">
          <h2 className="font-bold text-lg mb-1">📊 Consolidated View — This Month</h2>
          <p className="text-sm opacity-80 mb-4">All branches combined</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="bg-white/10 rounded-xl p-3 sm:p-4 text-center">
              <p className="text-xs opacity-70">Total Revenue</p>
              <p className="text-xl sm:text-2xl font-bold mt-1">{fmt(summary.consolidated.month_revenue)}</p>
              <p className="text-xs opacity-60">{currency}</p>
            </div>
            <div className="bg-white/10 rounded-xl p-3 sm:p-4 text-center">
              <p className="text-xs opacity-70">Total Expenses</p>
              <p className="text-xl sm:text-2xl font-bold mt-1">{fmt(summary.consolidated.month_expenses)}</p>
              <p className="text-xs opacity-60">{currency}</p>
            </div>
            <div className="bg-white/10 rounded-xl p-3 sm:p-4 text-center">
              <p className="text-xs opacity-70">Total Profit</p>
              <p className="text-xl sm:text-2xl font-bold mt-1">{fmt(summary.consolidated.month_profit)}</p>
              <p className="text-xs opacity-60">{currency}</p>
            </div>
          </div>
          {summary.unassigned?.revenue > 0 && (
            <p className="text-xs opacity-60 mt-3">
              * Includes {fmt(summary.unassigned.revenue)} {currency} unassigned revenue not linked to any branch.
            </p>
          )}
        </div>
      )}

      {/* ─── TABS ─── */}
      {hasBranches && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {[
            { key: "overview", label: "Overview" },
            { key: "branches", label: `Branches (${branches.length})` },
          ].map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition ${
                tab === t.key ? "bg-green-600 text-white" : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ─── OVERVIEW TAB ─── */}
      {tab === "overview" && hasBranches && (
        <div className="space-y-6">
          {/* Comparison chart */}
          {chartData.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
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
                <div key={b.id} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-gray-800 dark:text-white">{b.name}</p>
                      {b.is_default && (
                        <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full">
                          Default
                        </span>
                      )}
                      {b.business_type && b.business_type !== "general" && (
                        <span className="text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 px-2 py-0.5 rounded-full">
                          {{ restaurant: "🍽️", workshop: "🔧", retail: "🛒", service: "💼" }[b.business_type] || ""} {b.business_type}
                        </span>
                      )}
                    </div>
                    <span className={`text-sm font-bold ${margin >= 20 ? "text-green-600" : margin >= 0 ? "text-yellow-600" : "text-red-600"}`}>
                      {margin}% margin
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-xs text-gray-500">Revenue</p>
                      <p className="text-base sm:text-lg font-bold text-green-600">{fmt(b.month_revenue)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Expenses</p>
                      <p className="text-base sm:text-lg font-bold text-red-500">{fmt(b.month_expenses)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Profit</p>
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
            <div key={b.id} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-lg font-bold text-gray-800 dark:text-white">{b.name}</p>
                    {b.is_default && (
                      <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full">Default</span>
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
                    className="text-xs text-green-600 hover:underline">Set as default</button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 sm:gap-3 mt-4">
                <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-2 sm:p-3 text-center">
                  <p className="text-[10px] sm:text-xs text-gray-500">Revenue</p>
                  <p className="text-sm sm:text-lg font-bold text-green-600">{fmt(b.total_revenue)}</p>
                  <p className="text-[10px] text-gray-400 sm:hidden">{currency}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-2 sm:p-3 text-center">
                  <p className="text-[10px] sm:text-xs text-gray-500">Expenses</p>
                  <p className="text-sm sm:text-lg font-bold text-red-500">{fmt(b.total_expenses)}</p>
                  <p className="text-[10px] text-gray-400 sm:hidden">{currency}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-2 sm:p-3 text-center">
                  <p className="text-[10px] sm:text-xs text-gray-500">Inventory</p>
                  <p className="text-sm sm:text-lg font-bold text-blue-600">{b.inventory_items}</p>
                  <p className="text-[10px] text-gray-400 sm:hidden">items</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── EMPTY STATE ─── */}
      {!hasBranches && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 shadow-sm text-center">
          <div className="text-5xl mb-3">🏢</div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-2">No branches yet</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto mb-4">
            Create branches to manage multiple locations with separate bookkeeping — all from one account.
            Each branch gets its own sales, expenses, inventory, and cashbook.
          </p>
          <button onClick={() => setShowCreate(true)}
            className="px-6 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition">
            Create First Branch
          </button>
        </div>
      )}

      {/* ─── HOW IT WORKS ─── */}
      {!hasBranches && (
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-2xl p-5">
          <h3 className="font-bold text-blue-800 dark:text-blue-200 mb-3">How Branch Bookkeeping Works</h3>
          <div className="space-y-2 text-sm text-blue-700 dark:text-blue-300">
            <p>1. <strong>Name your locations</strong> — like "Downtown" or "Mall Branch"</p>
            <p>2. <strong>Pick the active branch</strong> before logging sales, expenses, or stock</p>
            <p>3. Each branch <strong>keeps its own books</strong> automatically</p>
            <p>4. Get the <strong>big picture</strong> with a combined view across all branches</p>
            <p>5. <strong>Compare side by side</strong> to see which branch is performing best</p>
          </div>
        </div>
      )}
    </div>
  );
}
