import { useState, useEffect, useMemo, useRef } from "react";
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

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
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
  const [tab, setTab] = useState("catalog"); // catalog | menu | staff | sommelier
  const [showAdd, setShowAdd] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [menuToken, setMenuToken] = useState(null);
  const [scanPrefill, setScanPrefill] = useState(null);

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

  const fetchMenuToken = async () => {
    try {
      const res = await api.get("/wines/menu-token");
      setMenuToken(res.data);
    } catch { /* silent */ }
  };

  useEffect(() => { fetchWines(); fetchMenuToken(); }, []);

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
    } catch {
      alert("Failed to generate PDF");
    }
  };

  const handleScanDone = (data) => {
    setScanPrefill(data);
    setShowAdd(true);
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-5">
      {/* ── Header ── */}
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
          <div className="flex gap-2 flex-wrap">
            <ScanButton onResult={handleScanDone} />
            <button onClick={() => setShowAdd(true)}
              className="px-4 py-2 bg-purple-600 text-white rounded-xl text-sm font-semibold hover:bg-purple-700 transition">
              + Add Manually
            </button>
            <button onClick={() => setShowQR(true)} disabled={!menuToken}
              className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-40"
              title="QR wine menu for customers">
              📱 QR Menu
            </button>
            <button onClick={handlePdfExport} disabled={wines.length === 0}
              className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition disabled:opacity-40">
              📄 {selected.size > 0 ? `PDF (${selected.size})` : "PDF"}
            </button>
          </div>
        </div>
      </FadeIn>

      {/* ── KPI Cards ── */}
      {summary && (
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

      {/* ── Tab Bar ── */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        {[
          { id: "catalog", label: "Catalog", icon: "🍷" },
          { id: "menu", label: "Menu Editor", icon: "📜" },
          { id: "staff", label: "Staff Cheat Sheet", icon: "📋" },
          { id: "sommelier", label: "AI Sommelier", icon: "🤖" },
        ].map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${
              tab === tb.id ? "bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
            }`}>
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {/* ── CATALOG TAB ── */}
      {tab === "catalog" && (
        <>
          {/* Filters */}
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

          {/* Selection bar */}
          {filtered.length > 0 && (
            <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
              <button onClick={selected.size === filtered.length ? selectNone : selectAll}
                className="underline hover:text-gray-700 dark:hover:text-gray-200">
                {selected.size === filtered.length ? "Deselect all" : `Select all ${filtered.length}`}
              </button>
              {selected.size > 0 && (
                <span className="text-purple-600 dark:text-purple-400 font-medium">
                  {selected.size} selected — click PDF to export
                </span>
              )}
            </div>
          )}

          {/* Wine list */}
          {filtered.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              {wines.length === 0 ? (
                <>
                  <p className="text-4xl mb-3">🍷</p>
                  <p className="text-lg font-medium">No wines yet</p>
                  <p className="text-sm mt-1">Scan a bottle or add manually to start your catalog.</p>
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
        </>
      )}

      {/* ── MENU EDITOR TAB ── */}
      {tab === "menu" && <MenuEditorTab wines={wines} currency={currency} onUpdate={fetchWines} />}

      {/* ── STAFF CHEAT SHEET TAB ── */}
      {tab === "staff" && <StaffSheet wines={wines} currency={currency} />}

      {/* ── AI SOMMELIER TAB ── */}
      {tab === "sommelier" && <SommelierTab currency={currency} />}

      {/* ── Modals ── */}
      {showAdd && (
        <AddWineModal currency={currency} prefill={scanPrefill}
          onClose={() => { setShowAdd(false); setScanPrefill(null); }}
          onDone={() => { setShowAdd(false); setScanPrefill(null); fetchWines(); }} />
      )}
      {showQR && menuToken && (
        <QRModal token={menuToken} onClose={() => setShowQR(false)} />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   SCAN BUTTON — camera capture → AI label reading
   ═══════════════════════════════════════════════════════════ */
function ScanButton({ onResult }) {
  const fileRef = useRef(null);
  const [scanning, setScanning] = useState(false);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanning(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api.post("/wines/scan", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      if (res.data.success) {
        onResult(res.data.data);
      } else {
        alert(res.data.error || "Could not read label — try a clearer photo");
      }
    } catch (err) {
      const msg = err.response?.data?.detail || "Scan failed";
      if (msg.includes("not configured")) {
        alert("AI scanning requires API configuration. Use 'Add Manually' instead.");
      } else {
        alert(msg);
      }
    }
    setScanning(false);
    e.target.value = "";
  };

  return (
    <>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
      <button onClick={() => fileRef.current?.click()} disabled={scanning}
        className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-xl text-sm font-semibold hover:from-purple-700 hover:to-pink-700 transition disabled:opacity-60 flex items-center gap-1.5">
        {scanning ? (
          <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Reading...</>
        ) : (
          <>📷 Scan Bottle</>
        )}
      </button>
    </>
  );
}


/* ═══════════════════════════════════════════════════════════
   WINE CARD (catalog tab)
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
        <button onClick={onToggle} className="mt-1 flex-shrink-0">
          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition ${
            isSelected ? "bg-purple-600 border-purple-600" : "border-gray-300 dark:border-gray-600"
          }`}>
            {isSelected && <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>}
          </div>
        </button>

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
              className="p-2 rounded-lg bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/50 transition disabled:opacity-30 text-xs font-bold">
              -1
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
   MENU EDITOR TAB — edit display names, glass prices, export PDF
   ═══════════════════════════════════════════════════════════ */
function MenuEditorTab({ wines, currency, onUpdate }) {
  const [edits, setEdits] = useState({});      // { wineId: { menu_name, glass_price, sell_price } }
  const [saving, setSaving] = useState(null);   // wineId currently saving
  const [pdfLoading, setPdfLoading] = useState(false);
  const [menuTitle, setMenuTitle] = useState("");
  const [showNotes, setShowNotes] = useState(true);
  const [showPairing, setShowPairing] = useState(true);
  const [pdfSuccess, setPdfSuccess] = useState(false);

  const TYPE_ORDER = ["sparkling", "white", "rosé", "orange", "red", "natural", "dessert"];
  const TYPE_LABELS = {
    red: "Red Wines", white: "White Wines", "rosé": "Rosé Wines",
    sparkling: "Sparkling & Champagne", natural: "Natural Wines",
    dessert: "Dessert Wines", orange: "Orange Wines",
  };

  const grouped = useMemo(() => {
    const g = {};
    wines.forEach(w => { g[w.wine_type] = g[w.wine_type] || []; g[w.wine_type].push(w); });
    return g;
  }, [wines]);

  const getEdit = (w) => edits[w.id] || {
    menu_name: w.menu_name || "",
    glass_price: w.glass_price != null ? String(w.glass_price) : "",
    sell_price: String(w.sell_price),
  };

  const setField = (wId, field, val) => {
    setEdits(prev => ({
      ...prev,
      [wId]: { ...getEdit(wines.find(w => w.id === wId)), [field]: val },
    }));
  };

  const isDirty = (w) => {
    const e = edits[w.id];
    if (!e) return false;
    const menuDirty = (e.menu_name || "") !== (w.menu_name || "");
    const glassDirty = (e.glass_price || "") !== (w.glass_price != null ? String(w.glass_price) : "");
    const sellDirty = (e.sell_price || "") !== String(w.sell_price);
    return menuDirty || glassDirty || sellDirty;
  };

  const dirtyCount = wines.filter(isDirty).length;

  const handleSave = async (w) => {
    const e = getEdit(w);
    setSaving(w.id);
    try {
      const payload = {};
      if ((e.menu_name || "") !== (w.menu_name || "")) payload.menu_name = e.menu_name || null;
      if ((e.glass_price || "") !== (w.glass_price != null ? String(w.glass_price) : ""))
        payload.glass_price = e.glass_price ? parseFloat(e.glass_price) : null;
      if ((e.sell_price || "") !== String(w.sell_price))
        payload.sell_price = parseFloat(e.sell_price) || w.sell_price;
      if (Object.keys(payload).length > 0) {
        await api.put(`/wines/${w.id}`, payload);
        setEdits(prev => { const n = { ...prev }; delete n[w.id]; return n; });
        onUpdate();
      }
    } catch (err) {
      alert(err.response?.data?.detail || "Save failed");
    }
    setSaving(null);
  };

  const handleSaveAll = async () => {
    const dirtyWines = wines.filter(isDirty);
    for (const w of dirtyWines) {
      await handleSave(w);
    }
  };

  const handlePdfExport = async () => {
    setPdfLoading(true);
    setPdfSuccess(false);
    try {
      const body = {
        show_glass: true,
        show_notes: showNotes,
        show_pairing: showPairing,
      };
      if (menuTitle.trim()) body.title = menuTitle.trim();
      const res = await api.post("/wines/pdf", body, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `wine_menu_${new Date().toISOString().split("T")[0]}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setPdfSuccess(true);
      setTimeout(() => setPdfSuccess(false), 3000);
    } catch {
      alert("Failed to generate PDF");
    }
    setPdfLoading(false);
  };

  const hasAnyGlass = wines.some(w => {
    const e = edits[w.id];
    const gp = e ? e.glass_price : (w.glass_price != null ? String(w.glass_price) : "");
    return gp && parseFloat(gp) > 0;
  });

  return (
    <div className="space-y-5">
      {/* Info banner */}
      <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-4 flex items-start gap-3">
        <span className="text-2xl">📜</span>
        <div>
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Wine Menu Editor</p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
            Set display names for your printed menu, add glass pricing, then export a beautiful restaurant-style wine card PDF.
          </p>
        </div>
      </div>

      {/* PDF Export Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <h3 className="text-sm font-bold dark:text-white">Print Settings</h3>
          <div className="flex gap-2">
            {dirtyCount > 0 && (
              <button onClick={handleSaveAll}
                className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition">
                Save {dirtyCount} Change{dirtyCount > 1 ? "s" : ""}
              </button>
            )}
            <button onClick={handlePdfExport} disabled={pdfLoading || wines.length === 0}
              className="px-5 py-2 bg-gradient-to-r from-purple-700 to-pink-600 text-white rounded-xl text-sm font-bold hover:from-purple-800 hover:to-pink-700 transition disabled:opacity-50 flex items-center gap-1.5">
              {pdfLoading ? (
                <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Generating...</>
              ) : pdfSuccess ? (
                <>✅ Downloaded!</>
              ) : (
                <>📄 Export Wine Card PDF</>
              )}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">Menu Title</label>
            <input type="text" value={menuTitle} onChange={e => setMenuTitle(e.target.value)}
              placeholder="Your restaurant name (default)"
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 cursor-pointer">
            <input type="checkbox" checked={showNotes} onChange={e => setShowNotes(e.target.checked)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500" />
            Tasting Notes
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 cursor-pointer">
            <input type="checkbox" checked={showPairing} onChange={e => setShowPairing(e.target.checked)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500" />
            Food Pairing
          </label>
        </div>

        {hasAnyGlass && (
          <p className="text-xs text-green-600 dark:text-green-400 mt-2">
            Glass pricing detected — PDF will show Glass / Bottle columns
          </p>
        )}
      </div>

      {/* Wines grouped by type */}
      {wines.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">📜</p>
          <p className="text-lg font-medium">No wines in catalog</p>
          <p className="text-sm mt-1">Add wines in the Catalog tab first.</p>
        </div>
      ) : (
        TYPE_ORDER.filter(t => grouped[t]).map(wtype => (
          <div key={wtype}>
            <h3 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-2">
              <span className="w-8 h-px bg-gray-200 dark:bg-gray-700" />
              {TYPE_LABELS[wtype] || wtype}
              <span className="text-xs font-normal">({grouped[wtype].length})</span>
              <span className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
            </h3>

            <div className="space-y-2 mb-5">
              {grouped[wtype].map(w => {
                const e = getEdit(w);
                const dirty = isDirty(w);
                const displayName = e.menu_name || w.name;

                return (
                  <div key={w.id} className={`bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border transition ${
                    dirty ? "border-amber-300 dark:border-amber-600 ring-1 ring-amber-100 dark:ring-amber-900/30"
                      : "border-gray-100 dark:border-gray-700"
                  }`}>
                    <div className="flex items-start gap-4 flex-wrap">
                      {/* Left: Wine info + editable fields */}
                      <div className="flex-1 min-w-[280px] space-y-2">
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">#{wines.indexOf(w) + 1}</span>
                          <span className="text-sm font-bold dark:text-white">{w.name}</span>
                          {w.vintage && <span className="text-xs text-gray-400">{w.vintage}</span>}
                          {w.winery && <span className="text-xs text-gray-400">— {w.winery}</span>}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div>
                            <label className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-semibold block mb-0.5">
                              Menu Name
                            </label>
                            <input type="text"
                              value={e.menu_name}
                              onChange={ev => setField(w.id, "menu_name", ev.target.value)}
                              placeholder={w.name}
                              className="w-full px-2.5 py-1.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-purple-500" />
                          </div>
                          <div>
                            <label className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-semibold block mb-0.5">
                              Bottle Price ({currency})
                            </label>
                            <input type="number" step="0.01"
                              value={e.sell_price}
                              onChange={ev => setField(w.id, "sell_price", ev.target.value)}
                              className="w-full px-2.5 py-1.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm text-right focus:outline-none focus:ring-1 focus:ring-purple-500" />
                          </div>
                          <div>
                            <label className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-semibold block mb-0.5">
                              Glass Price ({currency})
                            </label>
                            <input type="number" step="0.01"
                              value={e.glass_price}
                              onChange={ev => setField(w.id, "glass_price", ev.target.value)}
                              placeholder="—"
                              className="w-full px-2.5 py-1.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm text-right focus:outline-none focus:ring-1 focus:ring-purple-500" />
                          </div>
                        </div>
                      </div>

                      {/* Right: Preview + Save */}
                      <div className="flex flex-col items-end gap-2 flex-shrink-0">
                        {/* Mini preview */}
                        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg px-3 py-2 text-right min-w-[140px]">
                          <p className="text-xs text-gray-400 dark:text-gray-500 mb-0.5">On menu shows as:</p>
                          <p className="text-sm font-serif font-bold text-gray-800 dark:text-gray-200 italic">
                            {displayName}
                          </p>
                          <div className="flex justify-end gap-3 mt-1">
                            {e.glass_price && parseFloat(e.glass_price) > 0 && (
                              <span className="text-xs text-gray-500">
                                Glass: <span className="font-semibold">{parseFloat(e.glass_price).toLocaleString()}</span>
                              </span>
                            )}
                            <span className="text-xs text-gray-500">
                              Bottle: <span className="font-semibold">{parseFloat(e.sell_price || w.sell_price).toLocaleString()}</span>
                            </span>
                          </div>
                        </div>

                        {dirty && (
                          <button onClick={() => handleSave(w)} disabled={saving === w.id}
                            className="px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-semibold hover:bg-green-700 transition disabled:opacity-50">
                            {saving === w.id ? "Saving..." : "Save"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   STAFF CHEAT SHEET TAB — phone-optimized
   ═══════════════════════════════════════════════════════════ */
function StaffSheet({ wines, currency }) {
  const [typeFilter, setTypeFilter] = useState("all");
  const filtered = typeFilter === "all" ? wines : wines.filter(w => w.wine_type === typeFilter);

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 text-sm text-blue-700 dark:text-blue-300">
        📋 Quick reference for your staff during service. Each card has what to say, food pairings, and key facts.
      </div>

      <div className="flex gap-1 flex-wrap">
        {WINE_TYPES.slice(0, 6).map(wt => (
          <button key={wt.key} onClick={() => setTypeFilter(wt.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              typeFilter === wt.key ? "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300"
                : "bg-gray-100 dark:bg-gray-800 text-gray-500"
            }`}>
            {wt.icon} {wt.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-center text-gray-400 py-8">No wines to show.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map(w => (
            <div key={w.id} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <h3 className="font-bold text-gray-900 dark:text-white text-lg">{w.name}</h3>
                <span className="text-sm font-bold text-gray-600 dark:text-gray-300 whitespace-nowrap">{w.sell_price.toLocaleString()} {currency}</span>
              </div>

              <div className="flex flex-wrap gap-2 mb-3 text-xs">
                <span className="px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 capitalize">{w.wine_type}</span>
                {w.grape_variety && <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{w.grape_variety}</span>}
                {w.region && <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{w.region}</span>}
                {w.vintage && <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{w.vintage}</span>}
              </div>

              {/* What to tell the customer */}
              {w.staff_description ? (
                <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-3 mb-2">
                  <p className="text-xs font-semibold text-green-700 dark:text-green-400 mb-1">💬 What to say:</p>
                  <p className="text-sm text-green-800 dark:text-green-300 leading-relaxed">{w.staff_description}</p>
                </div>
              ) : w.tasting_notes ? (
                <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-3 mb-2">
                  <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">🍷 Tasting notes:</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 italic">{w.tasting_notes}</p>
                </div>
              ) : null}

              {w.food_pairing && (
                <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3">
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">🍽️ Pairs with:</p>
                  <p className="text-sm text-amber-800 dark:text-amber-300">{w.food_pairing}</p>
                </div>
              )}

              <div className="flex items-center justify-between mt-3 pt-2 border-t dark:border-gray-700">
                <span className={`text-xs font-medium ${w.stock_qty <= w.reorder_level ? "text-red-500" : "text-gray-400"}`}>
                  {w.stock_qty} bottles left
                </span>
                <span className={`text-xs font-bold ${w.margin_pct >= 40 ? "text-green-600" : w.margin_pct >= 25 ? "text-yellow-600" : "text-red-600"}`}>
                  {w.margin_pct}% margin
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   AI SOMMELIER TAB
   ═══════════════════════════════════════════════════════════ */
function SommelierTab({ currency }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isAI, setIsAI] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await api.post("/wines/sommelier", { query: query.trim() });
      setResults(res.data.results);
      setIsAI(res.data.ai || false);
    } catch {
      setResults([]);
    }
    setLoading(false);
  };

  return (
    <div className="space-y-4">
      <div className="bg-purple-50 dark:bg-purple-900/20 rounded-xl p-4 text-center">
        <p className="text-3xl mb-2">🤖🍷</p>
        <p className="text-sm text-purple-700 dark:text-purple-300 font-medium">
          Ask like a customer would: "Something fruity and light under 400 DKK"
        </p>
      </div>

      <div className="flex gap-2">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
          placeholder="Something bold and red for a steak dinner..."
          className="flex-1 px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
        <button onClick={handleSearch} disabled={loading || !query.trim()}
          className="px-6 py-3 bg-purple-600 text-white rounded-xl text-sm font-bold hover:bg-purple-700 transition disabled:opacity-50">
          {loading ? "Thinking..." : "Ask"}
        </button>
      </div>

      {/* Quick suggestions */}
      <div className="flex flex-wrap gap-2">
        {[
          "Something fruity under 400",
          "Best white for seafood",
          "Bold red for steak night",
          "Light and refreshing for summer",
          "Natural wine recommendation",
        ].map(q => (
          <button key={q} onClick={() => { setQuery(q); }}
            className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-lg text-xs hover:bg-gray-200 dark:hover:bg-gray-700 transition">
            {q}
          </button>
        ))}
      </div>

      {/* Results */}
      {results !== null && (
        <div className="space-y-3">
          {results.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <p className="text-2xl mb-2">🤔</p>
              <p>No matching wines in stock. Try a different description.</p>
            </div>
          ) : (
            <>
              {isAI && (
                <p className="text-xs text-purple-500 dark:text-purple-400 font-medium">✨ AI-powered recommendations</p>
              )}
              {results.map((w, i) => (
                <div key={w.id} className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-100 dark:border-gray-700">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl flex-shrink-0 mt-0.5">{"🥇🥈🥉"[i] || "🍷"}</span>
                    <div className="flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <h3 className="font-bold dark:text-white">{w.name}</h3>
                        <span className="text-sm font-bold dark:text-white whitespace-nowrap">{w.sell_price?.toLocaleString()} {currency}</span>
                      </div>
                      <div className="flex flex-wrap gap-2 mt-1 text-xs text-gray-500">
                        <span className="capitalize">{w.wine_type}</span>
                        {w.grape_variety && <span>· {w.grape_variety}</span>}
                        {w.region && <span>· {w.region}</span>}
                        <span>· {w.stock_qty} in stock</span>
                      </div>
                      {w.recommendation && (
                        <p className="mt-2 text-sm text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/20 rounded-lg px-3 py-2">
                          💡 {w.recommendation}
                        </p>
                      )}
                      {!w.recommendation && w.tasting_notes && (
                        <p className="mt-1 text-xs text-gray-400 italic">"{w.tasting_notes}"</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   QR CODE MODAL
   ═══════════════════════════════════════════════════════════ */
function QRModal({ token, onClose }) {
  const menuUrl = `${window.location.origin}${token.url}`;

  // Simple QR code SVG generation (using Google Charts API for simplicity)
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(menuUrl)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-sm p-6 text-center">
        <h2 className="text-lg font-bold dark:text-white mb-1">📱 Customer Wine Menu</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Print this QR code and place it on tables</p>

        <div className="bg-white rounded-xl p-4 inline-block mb-4">
          <img src={qrImageUrl} alt="QR Code" className="w-48 h-48 mx-auto" />
        </div>

        <p className="text-xs text-gray-400 break-all mb-4">{menuUrl}</p>

        <div className="flex gap-2">
          <button onClick={() => { navigator.clipboard.writeText(menuUrl); }}
            className="flex-1 py-2.5 bg-purple-600 text-white rounded-xl text-sm font-medium hover:bg-purple-700 transition">
            📋 Copy Link
          </button>
          <button onClick={() => { window.open(menuUrl, "_blank"); }}
            className="flex-1 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-medium hover:bg-gray-200 transition">
            🔗 Open
          </button>
        </div>

        <button onClick={onClose} className="mt-3 text-sm text-gray-400 hover:text-gray-600">Close</button>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   ADD WINE MODAL (with scan prefill support)
   ═══════════════════════════════════════════════════════════ */
function AddWineModal({ currency, prefill, onClose, onDone }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    name: prefill?.name || "",
    winery: prefill?.winery || "",
    vintage: prefill?.vintage ? String(prefill.vintage) : "",
    grape_variety: prefill?.grape_variety || "",
    region: prefill?.region || "",
    country: prefill?.country || "",
    wine_type: prefill?.wine_type || "red",
    tasting_notes: prefill?.tasting_notes || "",
    food_pairing: prefill?.food_pairing || "",
    staff_description: prefill?.staff_description || "",
    cost_price: "",
    sell_price: "",
    stock_qty: "",
    reorder_level: "2",
    supplier: "",
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
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-gray-800 px-5 pt-5 pb-3 border-b dark:border-gray-700 z-10">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold dark:text-white">
              {prefill ? "📷 Scanned Wine — confirm details" : "🍷 Add Wine"}
            </h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
          </div>
          {prefill && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-1">✅ AI filled the details from your label photo. Just add pricing and confirm.</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>Wine Name *</label>
              <input className={inputClass} value={form.name} onChange={e => set("name", e.target.value)} placeholder="Sancerre" required /></div>
            <div><label className={labelClass}>Winery</label>
              <input className={inputClass} value={form.winery} onChange={e => set("winery", e.target.value)} placeholder="Domaine Vacheron" /></div>
          </div>

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

          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>Region</label>
              <input className={inputClass} value={form.region} onChange={e => set("region", e.target.value)} placeholder="Loire Valley" /></div>
            <div><label className={labelClass}>Country</label>
              <input className={inputClass} value={form.country} onChange={e => set("country", e.target.value)} placeholder="France" /></div>
          </div>

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

          <div><label className={labelClass}>Tasting Notes</label>
            <textarea className={inputClass} rows={2} value={form.tasting_notes} onChange={e => set("tasting_notes", e.target.value)} placeholder="Crisp citrus, mineral finish..." /></div>
          <div><label className={labelClass}>Food Pairing</label>
            <input className={inputClass} value={form.food_pairing} onChange={e => set("food_pairing", e.target.value)} placeholder="Oysters, goat cheese, grilled fish" /></div>
          <div><label className={labelClass}>Staff Description (what to tell customers)</label>
            <textarea className={inputClass} rows={2} value={form.staff_description} onChange={e => set("staff_description", e.target.value)} placeholder="Light and refreshing, perfect for summer." /></div>
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
