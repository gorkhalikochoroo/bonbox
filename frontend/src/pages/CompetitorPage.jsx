import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }

export default function CompetitorPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("overview");

  // Add competitor form
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newCategory, setNewCategory] = useState("");

  // Price check form
  const [priceCompId, setPriceCompId] = useState("");
  const [priceItem, setPriceItem] = useState("");
  const [theirPrice, setTheirPrice] = useState("");
  const [ourPrice, setOurPrice] = useState("");

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get("/competitors/insights");
      setData(res.data);
    } catch { setError("Could not load competitor data"); }
    setLoading(false);
  };

  const handleAddCompetitor = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.post("/competitors/add", { name: newName.trim(), address: newAddress.trim() || null, category: newCategory.trim() || null });
      setNewName(""); setNewAddress(""); setNewCategory(""); setShowAdd(false);
      fetchData();
    } catch { /* silent */ }
  };

  const handlePriceCheck = async (e) => {
    e.preventDefault();
    if (!priceCompId || !priceItem.trim() || !theirPrice) return;
    try {
      await api.post("/competitors/price-check", {
        competitor_id: priceCompId,
        item_name: priceItem.trim(),
        their_price: parseFloat(theirPrice),
        our_price: ourPrice ? parseFloat(ourPrice) : null,
      });
      setPriceItem(""); setTheirPrice(""); setOurPrice("");
      fetchData();
    } catch { /* silent */ }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/competitors/${id}`);
      fetchData();
    } catch { /* silent */ }
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🔍</div>
          <p className="text-gray-500 dark:text-gray-400">Scanning competitors...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <div className="text-4xl mb-4">🔍</div>
        <p className="text-red-500">{error}</p>
        <button onClick={fetchData} className="mt-4 text-sm text-green-600 hover:underline">Try again</button>
      </div>
    );
  }

  const {
    total_competitors, total_price_checks, price_position,
    cheaper_count, pricier_count, competitors, overpriced_items,
    underpriced_items, nearby_businesses, alerts,
  } = data;

  const positionLabel = { premium: "👑 Premium", budget: "🏷️ Budget", balanced: "⚖️ Balanced" };

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "competitors", label: `Competitors (${total_competitors})` },
    { key: "nearby", label: `Nearby (${nearby_businesses?.length || 0})` },
  ];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">
            🔍 {t("competitorScan") || "Competitor Scan"}
          </h1>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 transition"
          >
            + Add Competitor
          </button>
        </div>
      </FadeIn>

      {/* ─── ADD COMPETITOR FORM ─── */}
      {showAdd && (
        <form onSubmit={handleAddCompetitor} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm space-y-3">
          <h3 className="font-bold text-gray-700 dark:text-gray-200">Add Competitor</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Business name *"
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" required />
            <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="Address (optional)"
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" />
            <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="Type (cafe, restaurant...)"
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium">Save</button>
            <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm">Cancel</button>
          </div>
        </form>
      )}

      {/* ─── ALERTS ─── */}
      {alerts?.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => (
            <div key={i} className={`p-4 rounded-2xl border-l-4 ${
              alert.severity === "warning" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20" :
              alert.severity === "positive" ? "border-green-500 bg-green-50 dark:bg-green-900/20" :
              "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
            }`}>
              <div className="flex items-start gap-3">
                <span className="text-2xl">{alert.icon}</span>
                <div className="flex-1">
                  <p className="text-sm font-bold text-gray-800 dark:text-gray-200">{alert.title}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{alert.detail}</p>
                  {alert.action && (
                    <p className="text-xs text-green-700 dark:text-green-400 mt-2 font-medium">💡 {alert.action}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── KEY METRICS ─── */}
      {total_competitors > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Competitors" value={total_competitors} color="text-blue-600" />
          <MetricCard label="Price Checks" value={total_price_checks} color="text-purple-600" />
          <MetricCard
            label="Position"
            value={positionLabel[price_position] || "—"}
            color="text-gray-700 dark:text-gray-200"
          />
          <MetricCard
            label="We're Cheaper"
            value={cheaper_count}
            sub={`Higher: ${pricier_count}`}
            color="text-green-600"
          />
        </div>
      )}

      {/* ─── TABS ─── */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition ${
              tab === t.key ? "bg-green-600 text-white" : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── OVERVIEW TAB ─── */}
      {tab === "overview" && (
        <div className="space-y-6">
          {/* Overpriced items */}
          {overpriced_items?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-yellow-500">
              <h2 className="font-bold text-gray-800 dark:text-white mb-3">📈 We're Priced Higher</h2>
              <div className="space-y-2">
                {overpriced_items.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 bg-yellow-50 dark:bg-yellow-900/10 rounded-xl px-3 sm:px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{p.item}</p>
                      <p className="text-xs text-gray-500">vs {p.competitor}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-red-600">+{p.diff_pct}%</p>
                      <p className="text-[10px] sm:text-xs text-gray-400">{fmt(p.our_price)} vs {fmt(p.their_price)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Underpriced items */}
          {underpriced_items?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-green-500">
              <h2 className="font-bold text-gray-800 dark:text-white mb-3">💡 Room to Raise Prices</h2>
              <div className="space-y-2">
                {underpriced_items.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 bg-green-50 dark:bg-green-900/10 rounded-xl px-3 sm:px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{p.item}</p>
                      <p className="text-xs text-gray-500">vs {p.competitor}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-green-600">{p.diff_pct}%</p>
                      <p className="text-[10px] sm:text-xs text-gray-400">{fmt(p.our_price)} vs {fmt(p.their_price)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Log price check form */}
          {competitors?.length > 0 && (
            <form onSubmit={handlePriceCheck} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm space-y-3">
              <h2 className="font-bold text-gray-800 dark:text-white">📋 Log Price Check</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <select value={priceCompId} onChange={(e) => setPriceCompId(e.target.value)}
                  className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" required>
                  <option value="">Select competitor</option>
                  {competitors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input value={priceItem} onChange={(e) => setPriceItem(e.target.value)} placeholder="Item name (e.g. Latte)"
                  className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" required />
                <input type="number" step="0.01" value={theirPrice} onChange={(e) => setTheirPrice(e.target.value)}
                  placeholder={`Their price (${currency})`} className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" required />
                <input type="number" step="0.01" value={ourPrice} onChange={(e) => setOurPrice(e.target.value)}
                  placeholder={`Our price (${currency}, optional)`} className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 text-sm" />
              </div>
              <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Log Price Check</button>
            </form>
          )}
        </div>
      )}

      {/* ─── COMPETITORS TAB ─── */}
      {tab === "competitors" && (
        <div className="space-y-4">
          {competitors?.length > 0 ? competitors.map((comp) => (
            <div key={comp.id} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-lg font-bold text-gray-800 dark:text-white">{comp.name}</p>
                  {comp.category && <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">{comp.category}</span>}
                  {comp.address && <p className="text-xs text-gray-500 mt-1">📍 {comp.address}</p>}
                </div>
                <button onClick={() => handleDelete(comp.id)} className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
              {comp.recent_prices?.length > 0 ? (
                <div className="space-y-1">
                  {comp.recent_prices.map((p, i) => (
                    <div key={i} className="flex items-center justify-between text-sm py-1 border-t dark:border-gray-700/50">
                      <span className="text-gray-700 dark:text-gray-300">{p.item}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-gray-500">{fmt(p.their_price)} {currency}</span>
                        {p.our_price && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            p.position === "we_are_lower" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" :
                            p.position === "we_are_higher" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" :
                            "bg-gray-100 text-gray-500"
                          }`}>
                            {p.position === "we_are_lower" ? `${p.diff_pct}%` : p.position === "we_are_higher" ? `+${p.diff_pct}%` : "Same"}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No price checks yet</p>
              )}
            </div>
          )) : (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 shadow-sm text-center">
              <div className="text-5xl mb-3">🔍</div>
              <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-2">No competitors tracked</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
                Add competitors to start tracking their prices and comparing with yours.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ─── NEARBY TAB ─── */}
      {tab === "nearby" && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">📍 Nearby Businesses</h2>
          {nearby_businesses?.length > 0 ? (
            <div className="space-y-2">
              {nearby_businesses.map((biz, i) => (
                <div key={i} className="flex items-center justify-between bg-gray-50 dark:bg-gray-700/30 rounded-xl px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{biz.name}</p>
                    <p className="text-xs text-gray-500">{biz.type} {biz.address && `| ${biz.address}`}</p>
                  </div>
                  <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-1 rounded-full">{biz.type}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                {user?.latitude ? "No nearby businesses found within 1km." : "Set your location in Profile to discover nearby businesses."}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, color, currency }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>
        {value} {currency && <span className="text-sm font-normal opacity-60">{currency}</span>}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
