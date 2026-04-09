import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

const WINE_TYPES = [
  { key: "all", label: "All", icon: "🍷" },
  { key: "red", label: "Red", icon: "🔴" },
  { key: "white", label: "White", icon: "⚪" },
  { key: "rosé", label: "Rosé", icon: "🩷" },
  { key: "sparkling", label: "Sparkling", icon: "✨" },
  { key: "natural", label: "Natural", icon: "🌿" },
  { key: "dessert", label: "Dessert", icon: "🍯" },
  { key: "orange", label: "Orange", icon: "🟠" },
];

/* ═══════════════════════════════════════════════════════════ */
export default function WineListPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [wines, setWines] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [tab, setTab] = useState("catalog"); // catalog | add | staff
  const [showAdd, setShowAdd] = useState(false);

  const fetchWines = async () => {
    try {
      const [wineRes, sumRes] = await Promise.all([
        api.get("/wines"),
        api.get("/wines/summary"),
      ]);
      setWines(wineRes.data);
      setSummary(sumRes.data);
    } catch { /* silent */ }
    setLoading(false);
  };

  useEffect(() => { fetchWines(); }, []);

  const filtered = useMemo(() => {
    let list = wines;
    if (filter !== "all") list = list.filter(w => w.wine_type === filter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(w =>
        w.name.toLowerCase().includes(q) ||
        (w.winery || "").toLowerCase().includes(q) ||
        (w.region || "").toLowerCase().includes(q) ||
        (w.grape_variety || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [wines, filter, search]);

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(filtered.map(w => w.id)));
  const selectNone = () => setSelected(new Set());

  const handleSell = async (id) => {
    try {
      await api.post(`/wines/${id}/sell?quantity=1`);
      fetchWines();
    } catch (err) {
      alert(err.response?.data?.detail || "Failed to sell");
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Remove this wine?")) return;
    try {
      await api.delete(`/wines/${id}`);
      fetchWines();
    } catch { /* silent */ }
  };

  const handlePdfExport = async () => {
    try {
      const body = {};
      if (selected.size > 0 && selected.size < filtered.length) {
        body.wine_ids = [...selected];
      } else if (filter !== "all") {
        body.wine_type = filter;
      }
      const res = await api.post("/wines/pdf", body, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `wine_menu_${new Date().toISOString().split("T")[0]}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Failed to generate PDF");
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <FadeIn>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold dark:text-white flex items-center gap-2">
              🍷 {t("wineList") || "Wine List"}
            </h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
              {t("wineListDesc") || "Manage your wine catalog, track stock & margins, export menus."}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowAdd(true)}
              className="px-4 py-2 bg-purple-600 text-white rounded-xl text-sm font-semibold hover:bg-purple-700 transition">
              + Add Wine
            </button>
            <button onClick={handlePdfExport} disabled={wines.length === 0}
              className="px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-40">
              📄 {selected.size > 0 ? `PDF (${selected.size})` : "PDF Menu"}
            </button>
          </div>
        </div>
      </FadeIn>

      {/* ── KPI Cards ── */}
      {summary && summary.total_wines > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Wines", val: summary.total_wines, icon: "🍷" },
            { label: "Bottles", val: summary.total_bottles, icon: "🍾" },
            { label: "Avg Margin", val: `${summary.avg_margin}%`, icon: "📊",
              color: summary.avg_margin >= 40 ? "text-green-600" : summary.avg_margin >= 25 ? "text-yellow-600" : "text-red-600" },
            { label: "Low Stock", val: summary.low_stock_count, icon: "⚠️",
              color: summary.low_stock_count > 0 ? "text-red-600" : "text-green-600" },
          ].map(k => (
            <div key={k.label} className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400">{k.icon} {k.label}</p>
              <p className={`text-2xl font-bold mt-1 ${k.color || "dark:text-white"}`}>{k.val}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1 flex-wrap">
          {WINE_TYPES.map(wt => (
            <button key={wt.key} onClick={() => { setFilter(wt.key); setSelected(new Set()); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                filter === wt.key ? "bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
              }`}>
              {wt.icon} {wt.label}
            </button>
          ))}
        </div>
        <input type="text" placeholder="Search wines..." value={search} onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm flex-1 min-w-[140px]" />
      </div>

      {/* ── Selection bar ── */}
      {filtered.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <button onClick={selected.size === filtered.length ? selectNone : selectAll}
            className="underline hover:text-gray-700 dark:hover:text-gray-200">
            {selected.size === filtered.length ? "Deselect all" : `Select all ${filtered.length}`}
          </button>
          {selected.size > 0 && (
            <span className="text-purple-600 dark:text-purple-400 font-medium">
              {selected.size} selected — click "PDF" to export
            </span>
          )}
        </div>
      )}

      {/* ── Wine Cards ── */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          {wines.length === 0 ? (
            <>
              <p className="text-4xl mb-3">🍷</p>
              <p className="text-lg font-medium">No wines yet</p>
              <p className="text-sm mt-1">Add your first wine to build your catalog.</p>
            </>
          ) : (
            <p>No wines match your filter.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(w => (
            <WineCard key={w.id} wine={w} currency={currency}
              isSelected={selected.has(w.id)}
              onToggle={() => toggleSelect(w.id)}
              onSell={() => handleSell(w.id)}
              onDelete={() => handleDelete(w.id)} />
          ))}
        </div>
      )}

      {/* ── Add Wine Modal ── */}
      {showAdd && <AddWineModal currency={currency} onClose={() => setShowAdd(false)} onDone={() => { setShowAdd(false); fetchWines(); }} />}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   WINE CARD
   ═══════════════════════════════════════════════════════════ */
function WineCard({ wine: w, currency, isSelected, onToggle, onSell, onDelete }) {
  const marginColor = w.margin_pct >= 40 ? "text-green-600 dark:text-green-400"
    : w.margin_pct >= 25 ? "text-yellow-600 dark:text-yellow-400"
    : "text-red-600 dark:text-red-400";

  const stockColor = w.stock_qty <= w.reorder_level
    ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300";

  return (
    <div className={`bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border transition ${
      isSelected ? "border-purple-400 dark:border-purple-500 ring-1 ring-purple-200 dark:ring-purple-800"
        : "border-gray-100 dark:border-gray-700"
    }`}>
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <button onClick={onToggle} className="mt-1 flex-shrink-0">
          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition ${
            isSelected ? "bg-purple-600 border-purple-600" : "border-gray-300 dark:border-gray-600"
          }`}>
            {isSelected && <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>}
          </div>
        </button>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="font-bold text-gray-900 dark:text-white">{w.name}</h3>
            {w.vintage && <span className="text-sm text-gray-400">{w.vintage}</span>}
            {w.winery && <span className="text-xs text-gray-400">— {w.winery}</span>}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-gray-500 dark:text-gray-400">
            {w.grape_variety && <span>{w.grape_variety}</span>}
            {w.region && <span>{w.region}{w.country ? `, ${w.country}` : ""}</span>}
            <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 font-medium capitalize">{w.wine_type}</span>
          </div>
          {w.tasting_notes && (
            <p className="text-xs text-gray-400 dark:text-gray-500 italic mt-1 line-clamp-1">"{w.tasting_notes}"</p>
          )}
        </div>

        {/* Metrics + Actions */}
        <div className="flex items-center gap-4 flex-shrink-0 text-right">
          <div>
            <p className={`text-sm font-bold ${marginColor}`}>{w.margin_pct}%</p>
            <p className="text-[10px] text-gray-400">margin</p>
          </div>
          <div>
            <p className="text-sm font-bold dark:text-white">{w.sell_price.toLocaleString()} {currency}</p>
            <p className="text-[10px] text-gray-400">{w.cost_price.toLocaleString()} cost</p>
          </div>
          <div>
            <p className={`text-sm font-bold ${stockColor}`}>{w.stock_qty}</p>
            <p className="text-[10px] text-gray-400">bottles</p>
          </div>
          <div className="flex gap-1">
            <button onClick={onSell} title="Sell 1 bottle" disabled={w.stock_qty <= 0}
              className="p-2 rounded-lg bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/50 transition disabled:opacity-30">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4"/></svg>
            </button>
            <button onClick={onDelete} title="Delete"
              className="p-2 rounded-lg text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:text-red-500 transition">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   ADD WINE MODAL
   ═══════════════════════════════════════════════════════════ */
function AddWineModal({ currency, onClose, onDone }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    name: "", winery: "", vintage: "", grape_variety: "", region: "", country: "",
    wine_type: "red", tasting_notes: "", food_pairing: "", staff_description: "",
    cost_price: "", sell_price: "", stock_qty: "", reorder_level: "2", supplier: "",
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const margin = useMemo(() => {
    const c = parseFloat(form.cost_price) || 0;
    const s = parseFloat(form.sell_price) || 0;
    if (s <= 0) return 0;
    return Math.round((s - c) / s * 1000) / 10;
  }, [form.cost_price, form.sell_price]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await api.post("/wines", {
        ...form,
        vintage: form.vintage ? parseInt(form.vintage) : null,
        cost_price: parseFloat(form.cost_price) || 0,
        sell_price: parseFloat(form.sell_price) || 0,
        stock_qty: parseInt(form.stock_qty) || 0,
        reorder_level: parseInt(form.reorder_level) || 2,
      });
      onDone();
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to save");
    }
    setSaving(false);
  };

  const inputClass = "w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500";
  const labelClass = "text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-gray-800 px-5 pt-5 pb-3 border-b dark:border-gray-700 z-10">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold dark:text-white">🍷 Add Wine</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Name + Winery */}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>Wine Name *</label>
              <input className={inputClass} value={form.name} onChange={e => set("name", e.target.value)} placeholder="Sancerre" required /></div>
            <div><label className={labelClass}>Winery</label>
              <input className={inputClass} value={form.winery} onChange={e => set("winery", e.target.value)} placeholder="Domaine Vacheron" /></div>
          </div>

          {/* Type + Vintage + Grape */}
          <div className="grid grid-cols-3 gap-3">
            <div><label className={labelClass}>Type</label>
              <select className={inputClass} value={form.wine_type} onChange={e => set("wine_type", e.target.value)}>
                {WINE_TYPES.filter(t => t.key !== "all").map(t => (
                  <option key={t.key} value={t.key}>{t.icon} {t.label}</option>
                ))}
              </select></div>
            <div><label className={labelClass}>Vintage</label>
              <input className={inputClass} type="number" value={form.vintage} onChange={e => set("vintage", e.target.value)} placeholder="2023" /></div>
            <div><label className={labelClass}>Grape</label>
              <input className={inputClass} value={form.grape_variety} onChange={e => set("grape_variety", e.target.value)} placeholder="Sauvignon Blanc" /></div>
          </div>

          {/* Region + Country */}
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>Region</label>
              <input className={inputClass} value={form.region} onChange={e => set("region", e.target.value)} placeholder="Loire Valley" /></div>
            <div><label className={labelClass}>Country</label>
              <input className={inputClass} value={form.country} onChange={e => set("country", e.target.value)} placeholder="France" /></div>
          </div>

          {/* Pricing */}
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-3">PRICING & STOCK</p>
            <div className="grid grid-cols-4 gap-3">
              <div><label className={labelClass}>Cost ({currency})</label>
                <input className={inputClass + " text-right"} type="number" step="0.01" value={form.cost_price} onChange={e => set("cost_price", e.target.value)} placeholder="120" /></div>
              <div><label className={labelClass}>Sell ({currency})</label>
                <input className={inputClass + " text-right"} type="number" step="0.01" value={form.sell_price} onChange={e => set("sell_price", e.target.value)} placeholder="350" /></div>
              <div><label className={labelClass}>Stock</label>
                <input className={inputClass + " text-right"} type="number" value={form.stock_qty} onChange={e => set("stock_qty", e.target.value)} placeholder="12" /></div>
              <div><label className={labelClass}>Reorder at</label>
                <input className={inputClass + " text-right"} type="number" value={form.reorder_level} onChange={e => set("reorder_level", e.target.value)} /></div>
            </div>
            {margin > 0 && (
              <div className={`mt-3 text-center text-sm font-bold ${margin >= 40 ? "text-green-600" : margin >= 25 ? "text-yellow-600" : "text-red-600"}`}>
                {margin}% margin
                {margin < 30 && <span className="font-normal text-xs ml-2">— consider raising your price</span>}
              </div>
            )}
          </div>

          {/* Notes */}
          <div><label className={labelClass}>Tasting Notes</label>
            <textarea className={inputClass} rows={2} value={form.tasting_notes} onChange={e => set("tasting_notes", e.target.value)} placeholder="Crisp citrus, mineral finish..." /></div>
          <div><label className={labelClass}>Food Pairing</label>
            <input className={inputClass} value={form.food_pairing} onChange={e => set("food_pairing", e.target.value)} placeholder="Oysters, goat cheese, grilled fish" /></div>
          <div><label className={labelClass}>Staff Description (what to tell customers)</label>
            <textarea className={inputClass} rows={2} value={form.staff_description} onChange={e => set("staff_description", e.target.value)} placeholder="Light and refreshing, perfect for summer. From a small family winery in Loire." /></div>
          <div><label className={labelClass}>Supplier</label>
            <input className={inputClass} value={form.supplier} onChange={e => set("supplier", e.target.value)} placeholder="Vinimport A/S" /></div>

          {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-2 rounded-xl text-sm">{error}</div>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-300">Cancel</button>
            <button type="submit" disabled={saving || !form.name.trim()}
              className="flex-1 py-2.5 bg-purple-600 text-white rounded-xl text-sm font-bold hover:bg-purple-700 transition disabled:opacity-50">
              {saving ? "Adding..." : "🍷 Add Wine"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
