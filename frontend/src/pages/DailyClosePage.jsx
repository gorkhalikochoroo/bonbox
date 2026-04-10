import { useState, useEffect, useMemo, useRef } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useBranch } from "../components/BranchSelector";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

/* ═══════════════════════════════════════════════════════════
   DEFAULT CATEGORIES — adapt based on business type
   ═══════════════════════════════════════════════════════════ */
const REVENUE_CATS_BY_TYPE = {
  restaurant: [
    { key: "food", label: "Food / Mad", icon: "🍽️" },
    { key: "drinks", label: "Drinks / Drikkevarer", icon: "🍺" },
    { key: "takeaway", label: "Takeaway / Udbringning", icon: "📦" },
  ],
  workshop: [
    { key: "parts", label: "Parts / Reservedele", icon: "🔩" },
    { key: "labor", label: "Labor / Arbejde", icon: "🔧" },
    { key: "diagnostics", label: "Diagnostics", icon: "🔍" },
    { key: "towing", label: "Towing / Bugsering", icon: "🚛" },
  ],
  retail: [
    { key: "products", label: "Products / Varer", icon: "👕" },
    { key: "returns", label: "Returns / Returvarer", icon: "↩️" },
    { key: "services", label: "Services / Ydelser", icon: "🛠️" },
  ],
  grocery: [
    { key: "products", label: "Products / Dagligvarer", icon: "🛒" },
    { key: "tobacco_lottery", label: "Tobacco & Lottery", icon: "🎰" },
    { key: "fresh", label: "Fresh / Frisk", icon: "🥬" },
    { key: "other", label: "Other / Andet", icon: "📦" },
  ],
  ecommerce: [
    { key: "online_sales", label: "Online Sales", icon: "🛍️" },
    { key: "returns", label: "Returns / Refunds", icon: "↩️" },
    { key: "shipping", label: "Shipping Revenue", icon: "📦" },
  ],
  general: [
    { key: "revenue", label: "Revenue", icon: "💰" },
  ],
};

const PAYMENT_METHODS_BY_TYPE = {
  restaurant: [
    { key: "cash", label: "Cash / Kontant", icon: "💵" },
    { key: "card", label: "Card / Dankort", icon: "💳" },
    { key: "mobilepay", label: "MobilePay", icon: "📱" },
    { key: "invoice", label: "Invoice / Faktura", icon: "📄" },
  ],
  workshop: [
    { key: "cash", label: "Cash", icon: "💵" },
    { key: "card", label: "Card", icon: "💳" },
    { key: "bank_transfer", label: "Bank Transfer", icon: "🏦" },
    { key: "invoice", label: "Invoice / Credit", icon: "📄" },
  ],
  retail: [
    { key: "cash", label: "Cash / Kontant", icon: "💵" },
    { key: "card", label: "Card / Dankort", icon: "💳" },
    { key: "mobilepay", label: "MobilePay", icon: "📱" },
    { key: "gift_card", label: "Gift Card / Gavekort", icon: "🎁" },
  ],
  grocery: [
    { key: "cash", label: "Cash / Kontant", icon: "💵" },
    { key: "card", label: "Card / Dankort", icon: "💳" },
    { key: "mobilepay", label: "MobilePay", icon: "📱" },
  ],
  ecommerce: [
    { key: "card", label: "Card / Online", icon: "💳" },
    { key: "mobilepay", label: "MobilePay", icon: "📱" },
    { key: "bank_transfer", label: "Bank Transfer", icon: "🏦" },
    { key: "paypal", label: "PayPal", icon: "🅿️" },
  ],
};

/* Per-type close configuration — controls which steps appear */
const CLOSE_CONFIG = {
  restaurant:  { hasTips: true,  hasCashDrawer: true,  stepOneLabel: "Revenue by Category", description: "End-of-day closing — revenue, payments, cash drawer, tips." },
  workshop:    { hasTips: false, hasCashDrawer: true,  stepOneLabel: "Revenue by Service",  description: "End-of-day closing — parts & labor revenue, payments, cash drawer." },
  retail:      { hasTips: false, hasCashDrawer: true,  stepOneLabel: "Revenue by Category", description: "End-of-day closing — sales, returns, payments, cash drawer." },
  grocery:     { hasTips: false, hasCashDrawer: true,  stepOneLabel: "Revenue by Category", description: "End-of-day closing — sales, cash drawer, transactions." },
  ecommerce:   { hasTips: false, hasCashDrawer: false, stepOneLabel: "Revenue by Channel",  description: "End-of-day closing — online sales, returns, payments." },
  general:     { hasTips: false, hasCashDrawer: true,  stepOneLabel: "Revenue",             description: "End-of-day closing — revenue, expenses, payments." },
};

function getRevenueCats(branchType) {
  return REVENUE_CATS_BY_TYPE[branchType] || REVENUE_CATS_BY_TYPE.restaurant;
}

function getPaymentMethods(branchType) {
  return PAYMENT_METHODS_BY_TYPE[branchType] || PAYMENT_METHODS_BY_TYPE.restaurant;
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function DailyClosePage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { branchId, branchType } = useBranch();
  const currency = displayCurrency(user?.currency);

  const [tab, setTab] = useState("close"); // close | history | insights
  const [history, setHistory] = useState([]);
  const [insights, setInsights] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchHistory = () => {
    api.get("/daily-close").then(r => setHistory(r.data)).catch(() => {});
  };
  const fetchInsights = () => {
    api.get("/daily-close/insights").then(r => setInsights(r.data)).catch(() => {});
  };

  useEffect(() => { fetchHistory(); fetchInsights(); }, []);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <FadeIn>
        <h1 className="text-2xl font-bold dark:text-white flex items-center gap-2">
          📋 {t("dailyClose") || "Daily Close"}
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
{(CLOSE_CONFIG[branchType] || CLOSE_CONFIG.general).description}
        </p>
      </FadeIn>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        {[
          { id: "close", label: t("newClose") || "New Close", icon: "✏️" },
          { id: "history", label: t("historyTab") || "History", icon: "📅" },
          { id: "insights", label: t("insightsTab") || "Insights", icon: "💡" },
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

      {tab === "close" && <CloseForm currency={currency} t={t} branchType={branchType} branchId={branchId} onDone={() => { fetchHistory(); fetchInsights(); setTab("history"); }} />}
      {tab === "history" && <HistoryView data={history} currency={currency} t={t} onRefresh={fetchHistory} />}
      {tab === "insights" && <InsightsView data={insights} currency={currency} t={t} />}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   MULTI-STEP CLOSE FORM
   ═══════════════════════════════════════════════════════════ */
function CloseForm({ currency, t, branchType, branchId, onDone }) {
  const defaultRevCats = useMemo(() => getRevenueCats(branchType), [branchType]);
  const defaultPayMethods = useMemo(() => getPaymentMethods(branchType), [branchType]);
  const config = CLOSE_CONFIG[branchType] || CLOSE_CONFIG.general;

  const stepSequence = useMemo(() => {
    const seq = ["revenue", "payments"];
    if (config.hasCashDrawer !== false) seq.push("cash");
    if (config.hasTips) seq.push("tips");
    seq.push("review");
    return seq;
  }, [branchType]);
  const totalSteps = stepSequence.length;

  const [step, setStep] = useState(1);
  const currentStepId = stepSequence[step - 1];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Step 1: Revenue
  const [revCats, setRevCats] = useState(defaultRevCats);
  const [revAmounts, setRevAmounts] = useState({});
  const [customRevName, setCustomRevName] = useState("");

  // Step 2: Payments
  const [payMethods, setPayMethods] = useState(defaultPayMethods);
  const [payAmounts, setPayAmounts] = useState({});

  // Step 3: Cash drawer
  const [cashCounted, setCashCounted] = useState("");

  // Step 4: Tips
  const [tipsTotal, setTipsTotal] = useState("");
  const [staffCount, setStaffCount] = useState("");

  // Step 5: Meta
  const [closedBy, setClosedBy] = useState("");
  const [notes, setNotes] = useState("");

  // Scan / OCR state — supports multiple photos
  const [scanMode, setScanMode] = useState("idle"); // idle | scanning | result | skipped
  const [scanResult, setScanResult] = useState(null);
  const [scanPhotos, setScanPhotos] = useState([]); // [{url, name}]
  const [scanError, setScanError] = useState("");
  const fileInputRef = useRef(null);

  // Merge two OCR scan results — newer non-null values overwrite
  const mergeScans = (existing, incoming) => {
    if (!existing) return incoming;
    const merged = { ...existing };
    const rev = { ...(existing.revenue || {}) };
    Object.entries(incoming.revenue || {}).forEach(([k, v]) => { if (v != null) rev[k] = v; });
    merged.revenue = rev;
    const pay = { ...(existing.payments || {}) };
    Object.entries(incoming.payments || {}).forEach(([k, v]) => { if (v != null) pay[k] = v; });
    merged.payments = pay;
    if (incoming.tips != null) merged.tips = incoming.tips;
    if (incoming.moms_total != null) merged.moms_total = incoming.moms_total;
    if (incoming.revenue_total != null) merged.revenue_total = incoming.revenue_total;
    merged.raw_text = ((existing.raw_text || "") + "\n---\n" + (incoming.raw_text || "")).slice(0, 2000);
    merged.ocr_available = true;
    const allVals = [...Object.values(merged.revenue || {}), ...Object.values(merged.payments || {}), merged.tips, merged.moms_total, merged.revenue_total];
    const found = allVals.filter(v => v != null).length;
    merged.confidence = found >= 3 ? "high" : found >= 1 ? "medium" : "low";
    return merged;
  };

  const handleFileSelect = async (file) => {
    if (!file) return;
    setScanMode("scanning");
    setScanError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await api.post("/daily-close/scan-report", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      // Add thumbnail
      const thumbUrl = URL.createObjectURL(file);
      setScanPhotos(prev => [...prev, { url: thumbUrl, name: file.name }]);
      // Merge with existing results
      setScanResult(prev => mergeScans(prev, res.data));
      setScanMode("result");
    } catch (err) {
      setScanError(err.response?.data?.detail || "OCR scanning failed. Please enter values manually.");
      setScanMode(scanResult ? "result" : "idle"); // keep results if we already have some
    }
  };

  const applyScanValues = (jumpToReview = false) => {
    if (!scanResult) return;
    const r = scanResult.revenue || {};
    const p = scanResult.payments || {};
    // Fill revenue — match against current template cats + any extras from OCR
    const newRev = {};
    revCats.forEach(c => { if (r[c.key]) newRev[c.key] = String(r[c.key]); });
    Object.entries(r).forEach(([k, v]) => { if (v && !newRev[k]) newRev[k] = String(v); });
    setRevAmounts(prev => ({ ...prev, ...newRev }));
    // Fill payments — match against current template methods + extras
    const newPay = {};
    payMethods.forEach(m => { if (p[m.key]) newPay[m.key] = String(p[m.key]); });
    Object.entries(p).forEach(([k, v]) => { if (v && !newPay[k]) newPay[k] = String(v); });
    setPayAmounts(prev => ({ ...prev, ...newPay }));
    // Fill tips (only for types that have tips)
    if (config.hasTips && scanResult.tips) setTipsTotal(String(scanResult.tips));
    // If OCR detected MOMS, switch to manual mode with the scanned value
    if (scanResult.moms_total) {
      setMomsMode("manual");
      setMomsManual(String(scanResult.moms_total));
    }
    // Jump to review or step 1
    setScanMode("skipped");
    setStep(jumpToReview ? totalSteps : 1);
  };

  // Prefill from real data
  const [prefill, setPrefill] = useState(null);
  const [prefillLoading, setPrefillLoading] = useState(false);

  useEffect(() => {
    const fetchPrefill = async () => {
      setPrefillLoading(true);
      try {
        const today = new Date().toISOString().split("T")[0];
        const params = { date: today };
        if (branchId) params.branch_id = branchId;
        const res = await api.get("/daily-close/prefill", { params });
        if (res.data.has_data) {
          setPrefill(res.data);
          // Auto-fill payment methods from sales data
          const payPrefill = res.data.suggested_prefill?.payment_breakdown || {};
          if (Object.keys(payPrefill).length > 0) {
            const newPay = {};
            // Add any payment methods from data that aren't in the default list
            const existingKeys = new Set(defaultPayMethods.map(m => m.key));
            Object.entries(payPrefill).forEach(([k, v]) => {
              newPay[k] = String(v);
              if (!existingKeys.has(k) && k !== "other") {
                setPayMethods(prev => {
                  if (prev.find(m => m.key === k)) return prev;
                  return [...prev, { key: k, label: k.charAt(0).toUpperCase() + k.slice(1), icon: "💰" }];
                });
              }
            });
            setPayAmounts(newPay);
          }
          // Auto-fill revenue total into the first category (or "revenue" for general)
          const salesTotal = res.data.suggested_prefill?.revenue_total || 0;
          if (salesTotal > 0) {
            const firstCat = defaultRevCats[0]?.key;
            if (defaultRevCats.length === 1 || branchType === "general") {
              setRevAmounts({ [firstCat]: String(salesTotal) });
            }
            // For restaurant/workshop with multiple cats, leave revenue blank
            // so user distributes manually — but show total as hint
          }
        }
      } catch {
        // Silent — manual entry still works
      }
      setPrefillLoading(false);
    };
    fetchPrefill();
  }, [branchId]);

  const revenueTotal = useMemo(() => Object.values(revAmounts).reduce((s, v) => s + (parseFloat(v) || 0), 0), [revAmounts]);
  const paymentTotal = useMemo(() => Object.values(payAmounts).reduce((s, v) => s + (parseFloat(v) || 0), 0), [payAmounts]);
  const balanceDiff = revenueTotal - paymentTotal;
  const cashExpected = parseFloat(payAmounts.cash || 0);
  const cashCountedVal = parseFloat(cashCounted || 0);
  const cashDiff = cashCounted ? cashCountedVal - cashExpected : null;
  const tipsPP = tipsTotal && staffCount && parseInt(staffCount) > 0
    ? Math.round(parseFloat(tipsTotal) / parseInt(staffCount)) : null;

  // MOMS / VAT — toggle between auto-calc and manual entry from receipt
  const [momsMode, setMomsMode] = useState("auto"); // "auto" | "manual"
  const [momsManual, setMomsManual] = useState("");

  const momsTotal = useMemo(() => {
    if (momsMode === "manual") return parseFloat(momsManual) || 0;
    if (scanResult?.moms_total) return scanResult.moms_total;
    return revenueTotal > 0 ? Math.round((revenueTotal * 0.25 / 1.25) * 100) / 100 : 0;
  }, [momsMode, momsManual, scanResult, revenueTotal]);
  const revenueExMoms = useMemo(() => Math.round((revenueTotal - momsTotal) * 100) / 100, [revenueTotal, momsTotal]);

  const addCustomRevCat = () => {
    if (!customRevName.trim()) return;
    const key = customRevName.toLowerCase().replace(/\s+/g, "_");
    if (!revCats.find(c => c.key === key)) {
      setRevCats([...revCats, { key, label: customRevName, icon: "📌" }]);
    }
    setCustomRevName("");
  };

  // Build payload used by both auto-save and final submit
  const buildPayload = (status = "confirmed") => {
    const revenue_breakdown = {};
    revCats.forEach(c => { if (revAmounts[c.key]) revenue_breakdown[c.key] = parseFloat(revAmounts[c.key]); });
    const payment_breakdown = {};
    payMethods.forEach(m => { if (payAmounts[m.key]) payment_breakdown[m.key] = parseFloat(payAmounts[m.key]); });
    return {
      date: new Date().toISOString().split("T")[0],
      branch_id: branchId || null,
      status,
      revenue_breakdown,
      payment_breakdown,
      moms_total: momsTotal || null,
      moms_mode: momsMode,
      tips_total: tipsTotal ? parseFloat(tipsTotal) : null,
      tips_staff_count: staffCount ? parseInt(staffCount) : null,
      cash_counted: cashCounted ? parseFloat(cashCounted) : null,
      closed_by: closedBy || null,
      notes: notes || null,
    };
  };

  // Draft auto-save — fires on step change (silent, no loading state)
  const [draftSaved, setDraftSaved] = useState(false);
  const autoSaveRef = useRef(null);

  useEffect(() => {
    // Only auto-save if user has entered some data and is past scan UI
    if (scanMode !== "skipped" || revenueTotal === 0) return;
    // Debounce: save 2s after last step change
    clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(async () => {
      try {
        await api.post("/daily-close", buildPayload("draft"));
        setDraftSaved(true);
        setTimeout(() => setDraftSaved(false), 3000);
      } catch {
        // Silent — auto-save is best-effort
      }
    }, 2000);
    return () => clearTimeout(autoSaveRef.current);
  }, [step, revAmounts, payAmounts, cashCounted, tipsTotal]);

  // Final submit — locks the close
  const handleSubmit = async () => {
    setSaving(true);
    setError("");
    try {
      await api.post("/daily-close", buildPayload("confirmed"));
      onDone();
    } catch (err) {
      const d = err.response?.data?.detail;
      setError(typeof d === "string" ? d : Array.isArray(d) ? d.map(e => e.msg || e).join(", ") : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 text-right text-lg";
  const labelClass = "text-sm font-medium text-gray-600 dark:text-gray-300";

  const showScanUI = scanMode === "idle" || scanMode === "scanning" || scanMode === "result";

  // Count how many fields OCR detected
  const scanFieldsDetected = useMemo(() => {
    if (!scanResult) return 0;
    let count = 0;
    const r = scanResult.revenue || {};
    const p = scanResult.payments || {};
    defaultRevCats.forEach(c => { if (r[c.key]) count++; });
    defaultPayMethods.forEach(m => { if (p[m.key]) count++; });
    if (config.hasTips && scanResult.tips) count++;
    return count;
  }, [scanResult, defaultRevCats, defaultPayMethods]);
  const scanFieldsTotal = defaultRevCats.length + defaultPayMethods.length + (config.hasTips ? 1 : 0);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      {/* Progress bar */}
      <div className="flex">
        {showScanUI ? (
          <div className="flex-1 h-1.5 bg-gradient-to-r from-green-400 to-green-600 animate-pulse" />
        ) : (
          Array.from({ length: totalSteps }, (_, i) => i + 1).map(s => (
            <div key={s} className={`flex-1 h-1.5 ${s <= step ? "bg-green-500" : "bg-gray-200 dark:bg-gray-700"} transition-colors`} />
          ))
        )}
      </div>

      <div className="p-5 sm:p-6">
        {/* Hidden file input for camera/upload — supports multiple files */}
        <input ref={fileInputRef} type="file" accept="image/*" multiple capture="environment" className="hidden"
          onChange={async e => {
            const files = Array.from(e.target.files || []);
            for (const f of files) await handleFileSelect(f);
            e.target.value = "";
          }} />

        {/* ─── SCAN BANNER (Step 0) ─── */}
        {scanMode === "idle" && (
          <div className="space-y-4">
            <div className="rounded-2xl p-6 text-center"
              style={{ background: "linear-gradient(135deg, #059669 0%, #10b981 50%, #34d399 100%)" }}>
              <div className="text-4xl mb-3">📷</div>
              <h2 className="text-xl font-bold text-white mb-1">Scan your Z-Report / Kasserapport</h2>
              <p className="text-green-100 text-sm mb-5">
                Take photos or upload images of your Z-report — add multiple pages and we'll merge the results.
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => { if (fileInputRef.current) { fileInputRef.current.setAttribute("capture", "environment"); fileInputRef.current.click(); } }}
                  className="px-5 py-2.5 bg-white text-green-700 rounded-xl font-semibold shadow-md hover:shadow-lg transition text-sm">
                  📸 Take Photo
                </button>
                <button
                  onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
                  className="px-5 py-2.5 bg-white/20 text-white border border-white/40 rounded-xl font-semibold hover:bg-white/30 transition text-sm">
                  📁 Upload Image
                </button>
              </div>
            </div>
            {/* Upload zone */}
            <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-6 text-center cursor-pointer hover:border-green-400 dark:hover:border-green-500 transition-colors"
              onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
              onDragOver={e => e.preventDefault()}
              onDrop={async e => { e.preventDefault(); const files = Array.from(e.dataTransfer.files || []); for (const f of files) await handleFileSelect(f); }}>
              <p className="text-gray-400 dark:text-gray-500 text-sm">
                Drag & drop your Z-report images here, or click to browse
              </p>
            </div>
            {scanError && (
              <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
                {scanError}
              </div>
            )}
            <div className="text-center">
              <button onClick={() => { setScanMode("skipped"); setStep(1); }}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline underline-offset-2 transition">
                Skip — enter manually
              </button>
            </div>
          </div>
        )}

        {/* ─── SCANNING SPINNER ─── */}
        {scanMode === "scanning" && (
          <div className="py-12 text-center space-y-4">
            <div className="inline-block w-10 h-10 border-4 border-green-200 border-t-green-600 rounded-full animate-spin" />
            <p className="text-gray-600 dark:text-gray-300 font-medium">Reading your Z-report...</p>
            <p className="text-sm text-gray-400">OCR is extracting revenue, payments, and MOMS data</p>
          </div>
        )}

        {/* ─── SCAN RESULT CARD ─── */}
        {scanMode === "result" && scanResult && (
          <div className="space-y-5">
            {/* Confidence indicator */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold dark:text-white">Scan Results</h2>
              <span className={`text-sm font-medium px-3 py-1 rounded-full ${
                scanFieldsDetected >= 5 ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300"
                  : scanFieldsDetected >= 3 ? "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300"
                    : "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400"
              }`}>
                🎯 {scanFieldsDetected >= 5 ? "High" : scanFieldsDetected >= 3 ? "Medium" : "Low"} confidence — {scanFieldsDetected}/{scanFieldsTotal} fields detected
              </span>
            </div>

            {/* Revenue (med moms) */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
                Revenue (med moms)
              </h3>
              {defaultRevCats.map(c => {
                const val = scanResult.revenue?.[c.key];
                return (
                  <div key={c.key} className="flex items-center gap-3">
                    <span className="text-sm w-44 flex items-center gap-2 dark:text-gray-300">
                      {val ? <span className="text-green-500">✓</span> : <span className="text-gray-300 dark:text-gray-600">—</span>}
                      {c.icon} {c.label}
                      {val && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 rounded">OCR</span>}
                    </span>
                    <input type="number" inputMode="decimal" className={inputClass}
                      defaultValue={val || ""}
                      onChange={e => {
                        setScanResult(prev => ({
                          ...prev,
                          revenue: { ...prev.revenue, [c.key]: parseFloat(e.target.value) || 0 }
                        }));
                      }} />
                  </div>
                );
              })}
              {scanResult.revenue_total && (
                <div className="flex justify-between pt-2 border-t dark:border-gray-600 text-sm font-bold dark:text-white">
                  <span>Total Revenue</span>
                  <span>{scanResult.revenue_total.toLocaleString()} {currency}</span>
                </div>
              )}
            </div>

            {/* MOMS section */}
            <div className="rounded-xl p-4 space-y-2"
              style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.08))" }}>
              <h3 className="font-semibold text-sm flex items-center gap-2" style={{ color: "#6366f1" }}>
                MOMS (Danish VAT 25%)
                {scanResult.moms_total && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded">OCR</span>}
              </h3>
              <div className="flex justify-between text-sm dark:text-gray-300">
                <span>Total MOMS</span>
                <span className="font-semibold" style={{ color: "#6366f1" }}>
                  {(scanResult.moms_total || Math.round(((scanResult.revenue_total || 0) * 0.25 / 1.25) * 100) / 100).toLocaleString()} {currency}
                </span>
              </div>
              {defaultRevCats.map(c => {
                const val = scanResult.revenue?.[c.key];
                if (!val) return null;
                const udenMoms = Math.round((val / 1.25) * 100) / 100;
                return (
                  <div key={c.key} className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                    <span>{c.label.split(" / ")[0]} (uden moms)</span>
                    <span>{udenMoms.toLocaleString()} {currency}</span>
                  </div>
                );
              })}
            </div>

            {/* Payments */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400">Payments</h3>
              {defaultPayMethods.map(m => {
                const val = scanResult.payments?.[m.key];
                return (
                  <div key={m.key} className="flex items-center gap-3">
                    <span className="text-sm w-44 flex items-center gap-2 dark:text-gray-300">
                      {val ? <span className="text-green-500">✓</span> : <span className="text-gray-300 dark:text-gray-600">—</span>}
                      {m.icon} {m.label}
                      {val && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 rounded">OCR</span>}
                    </span>
                    <input type="number" inputMode="decimal" className={inputClass}
                      defaultValue={val || ""}
                      onChange={e => {
                        setScanResult(prev => ({
                          ...prev,
                          payments: { ...prev.payments, [m.key]: parseFloat(e.target.value) || 0 }
                        }));
                      }} />
                  </div>
                );
              })}
            </div>

            {/* Tips — only for types that have tips */}
            {config.hasTips && (
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <span className="text-sm w-44 flex items-center gap-2 dark:text-gray-300">
                  {scanResult.tips ? <span className="text-green-500">✓</span> : <span className="text-gray-300 dark:text-gray-600">—</span>}
                  💰 Tips
                  {scanResult.tips && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 rounded">OCR</span>}
                </span>
                <input type="number" inputMode="decimal" className={inputClass}
                  defaultValue={scanResult.tips || ""}
                  onChange={e => {
                    setScanResult(prev => ({ ...prev, tips: parseFloat(e.target.value) || 0 }));
                  }} />
              </div>
            </div>
            )}

            {/* Photo thumbnails */}
            {scanPhotos.length > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 shrink-0">📷 {scanPhotos.length} photo{scanPhotos.length > 1 ? "s" : ""} scanned</span>
                <div className="flex gap-2 overflow-x-auto">
                  {scanPhotos.map((p, i) => (
                    <img key={i} src={p.url} alt={p.name} className="w-12 h-12 rounded-lg object-cover border-2 border-green-500/50" />
                  ))}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col sm:flex-row gap-3">
              <button onClick={() => applyScanValues(true)}
                className="flex-1 px-6 py-3 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 transition text-sm">
                ✅ Use these values — jump to review
              </button>
              <button onClick={() => applyScanValues(false)}
                className="flex-1 px-6 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-gray-600 transition text-sm">
                ✏️ Continue step-by-step
              </button>
            </div>
            <div className="flex justify-center gap-4">
              <button onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
                className="text-sm text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 font-medium">
                + Add another photo
              </button>
              <button onClick={() => { setScanResult(null); setScanPhotos([]); setScanMode("idle"); }}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline underline-offset-2">
                Start over
              </button>
            </div>
          </div>
        )}

        {/* ─── NORMAL STEP FLOW ─── */}
        {!showScanUI && (<>
        {/* Draft auto-save indicator */}
        {draftSaved && (
          <div className="mb-3 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-center text-xs text-gray-400 flex items-center justify-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-green-400 rounded-full" /> Draft saved — you can leave and resume later
          </div>
        )}

        {/* Sync indicator */}
        {prefillLoading && (
          <div className="mb-4 px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl text-center text-sm text-gray-400">
            Loading today's records...
          </div>
        )}
        {prefill && !prefillLoading && (
          <div className="mb-4 px-4 py-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl text-sm text-blue-700 dark:text-blue-300">
            <div className="flex items-center gap-2 font-medium">
              <span>🔄</span>
              <span>
                Synced from {prefill.sales.count} sale{prefill.sales.count !== 1 ? "s" : ""}
                {prefill.expenses.count > 0 && ` & ${prefill.expenses.count} expense${prefill.expenses.count !== 1 ? "s" : ""}`}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 mt-2 text-xs">
              <span>Revenue: {prefill.sales.total.toLocaleString()} {currency}</span>
              {prefill.expenses.total > 0 && <span>Expenses: {prefill.expenses.total.toLocaleString()} {currency}</span>}
              <span>Net: {(prefill.sales.total - prefill.expenses.total).toLocaleString()} {currency}</span>
            </div>
          </div>
        )}

        {/* Step header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold dark:text-white">
            {currentStepId === "revenue" && `Step ${step} — ${config.stepOneLabel}`}
            {currentStepId === "payments" && `Step ${step} — Payment Methods`}
            {currentStepId === "cash" && `Step ${step} — Cash Drawer Count`}
            {currentStepId === "tips" && `Step ${step} — Tips`}
            {currentStepId === "review" && `Step ${step} — Review & Submit`}
          </h2>
          <span className="text-sm text-gray-400">{step}/{totalSteps}</span>
        </div>

        {/* ─── STEP: Revenue ─── */}
        {currentStepId === "revenue" && (
          <div className="space-y-4">
            {/* Hint: show sales total from system if multi-category */}
            {prefill && prefill.sales.total > 0 && defaultRevCats.length > 1 && (
              <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-3 text-sm text-green-700 dark:text-green-300">
                Today's total sales: <strong>{prefill.sales.total.toLocaleString()} {currency}</strong> — distribute across categories below.
                {Object.keys(prefill.sales.by_item).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {Object.entries(prefill.sales.by_item).slice(0, 8).map(([name, val]) => (
                      <span key={name} className="px-2 py-0.5 bg-green-100 dark:bg-green-900/40 rounded text-xs">{name}: {val.toLocaleString()}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {revCats.map(cat => (
              <div key={cat.key}>
                <label className={labelClass}>{cat.icon} {cat.label}</label>
                <input type="number" inputMode="decimal" placeholder="0" className={inputClass}
                  value={revAmounts[cat.key] || ""}
                  onChange={e => setRevAmounts({ ...revAmounts, [cat.key]: e.target.value })} />
              </div>
            ))}
            <div className="flex gap-2">
              <input type="text" placeholder={t("addCategory") || "Add category..."} className="flex-1 px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm"
                value={customRevName} onChange={e => setCustomRevName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCustomRevCat()} />
              <button onClick={addCustomRevCat} className="px-4 py-2.5 bg-gray-100 dark:bg-gray-700 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 dark:text-white">+ Add</button>
            </div>
            <div className="pt-3 border-t dark:border-gray-700 text-right">
              <span className="text-sm text-gray-500">{t("total") || "Total"}: </span>
              <span className="text-xl font-bold dark:text-white">{revenueTotal.toLocaleString()} {currency}</span>
            </div>
          </div>
        )}

        {/* ─── STEP: Payments ─── */}
        {currentStepId === "payments" && (
          <div className="space-y-4">
            {payMethods.map(m => (
              <div key={m.key}>
                <label className={labelClass}>{m.icon} {m.label}</label>
                <input type="number" inputMode="decimal" placeholder="0" className={inputClass}
                  value={payAmounts[m.key] || ""}
                  onChange={e => setPayAmounts({ ...payAmounts, [m.key]: e.target.value })} />
              </div>
            ))}
            <div className="pt-3 border-t dark:border-gray-700">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Payment Total:</span>
                <span className="text-xl font-bold dark:text-white">{paymentTotal.toLocaleString()} {currency}</span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <span className="text-sm text-gray-500">Revenue Total:</span>
                <span className="text-sm dark:text-gray-300">{revenueTotal.toLocaleString()} {currency}</span>
              </div>
              {revenueTotal > 0 && (
                <div className={`mt-2 px-3 py-2 rounded-lg text-sm font-medium ${
                  Math.abs(balanceDiff) < 1 ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400"
                }`}>
                  {Math.abs(balanceDiff) < 1 ? "✅ Balanced!" : `⚠️ Difference: ${balanceDiff > 0 ? "+" : ""}${balanceDiff.toLocaleString()} ${currency}`}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── STEP: Cash Drawer ─── */}
        {currentStepId === "cash" && (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 text-sm text-blue-700 dark:text-blue-300">
              Count the physical cash in your drawer and enter the amount below. We'll compare it against what the system expects.
            </div>
            <div>
              <label className={labelClass}>Expected (from payment step)</label>
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl text-right text-lg font-semibold dark:text-gray-300">
                {cashExpected.toLocaleString()} {currency}
              </div>
            </div>
            <div>
              <label className={labelClass}>💵 Counted Amount</label>
              <input type="number" inputMode="decimal" placeholder="Count your drawer..." className={inputClass}
                value={cashCounted} onChange={e => setCashCounted(e.target.value)} />
            </div>
            {cashDiff !== null && (
              <div className={`px-4 py-3 rounded-xl text-center font-bold text-lg ${
                Math.abs(cashDiff) <= 100 ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300"
                  : "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400"
              }`}>
                Difference: {cashDiff > 0 ? "+" : ""}{cashDiff.toLocaleString()} {currency}
                {Math.abs(cashDiff) > 100 && <p className="text-sm font-normal mt-1">⚠️ Off by more than 100 — double-check your count</p>}
              </div>
            )}
            {!cashExpected && (
              <p className="text-sm text-gray-400 text-center">No cash payments entered in Step 2 — you can skip this step.</p>
            )}
          </div>
        )}

        {/* ─── STEP: Tips (only for types with tips) ─── */}
        {currentStepId === "tips" && (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>💰 Total Tips</label>
              <input type="number" inputMode="decimal" placeholder="0" className={inputClass}
                value={tipsTotal} onChange={e => setTipsTotal(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>👥 Staff Count</label>
              <input type="number" inputMode="numeric" placeholder="How many staff tonight?" className={inputClass}
                value={staffCount} onChange={e => setStaffCount(e.target.value)} />
            </div>
            {tipsPP !== null && (
              <div className="bg-green-50 dark:bg-green-900/30 rounded-xl p-4 text-center">
                <p className="text-sm text-green-600 dark:text-green-400">Per person</p>
                <p className="text-2xl font-bold text-green-700 dark:text-green-300">{tipsPP.toLocaleString()} {currency}</p>
              </div>
            )}
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-xs text-amber-700 dark:text-amber-300">
              <strong>Danish tax note:</strong> Tips must be reported via eIndkomst. Share this data with your accountant.
            </div>
          </div>
        )}

        {/* ─── REVIEW STEP ─── */}
        {currentStepId === "review" && (
          <div className="space-y-4">
            {/* Revenue summary */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 mb-2">Revenue</h3>
              {revCats.filter(c => revAmounts[c.key]).map(c => (
                <div key={c.key} className="flex justify-between text-sm py-0.5 dark:text-gray-300">
                  <span>{c.icon} {c.label}</span>
                  <span>{parseFloat(revAmounts[c.key]).toLocaleString()} {currency}</span>
                </div>
              ))}
              <div className="flex justify-between font-bold pt-2 border-t dark:border-gray-600 mt-2 dark:text-white">
                <span>Total</span><span>{revenueTotal.toLocaleString()} {currency}</span>
              </div>
            </div>

            {/* MOMS (VAT) summary — with auto/manual toggle */}
            {revenueTotal > 0 && (
              <div className="rounded-xl p-4 space-y-3"
                style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.08))" }}>
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm" style={{ color: "#6366f1" }}>MOMS / VAT (25%)</h3>
                  {/* Toggle: Auto vs Manual */}
                  <div className="flex bg-gray-200 dark:bg-gray-700 rounded-lg p-0.5 text-xs">
                    <button onClick={() => setMomsMode("auto")}
                      className={`px-3 py-1 rounded-md font-medium transition ${momsMode === "auto" ? "bg-indigo-500 text-white shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
                      Auto
                    </button>
                    <button onClick={() => setMomsMode("manual")}
                      className={`px-3 py-1 rounded-md font-medium transition ${momsMode === "manual" ? "bg-indigo-500 text-white shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
                      From receipt
                    </button>
                  </div>
                </div>
                {momsMode === "manual" && (
                  <div>
                    <label className="text-xs text-indigo-400 mb-1 block">Enter MOMS from your Z-report / receipt</label>
                    <input type="number" inputMode="decimal" placeholder="MOMS amount..."
                      className="w-full px-4 py-2.5 border border-indigo-300 dark:border-indigo-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-right text-lg"
                      value={momsManual} onChange={e => setMomsManual(e.target.value)} />
                  </div>
                )}
                {momsMode === "auto" && (
                  <p className="text-xs text-indigo-400">Auto-calculated: Revenue × 25% / 125%</p>
                )}
                <div className="flex justify-between text-sm dark:text-gray-300 py-0.5">
                  <span>Revenue (med moms)</span>
                  <span>{revenueTotal.toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between text-sm font-semibold py-0.5" style={{ color: "#6366f1" }}>
                  <span>MOMS 25%{momsMode === "manual" ? " (from receipt)" : ""}</span>
                  <span>{momsTotal.toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between text-sm font-bold pt-2 border-t mt-1 dark:text-white" style={{ borderColor: "rgba(99,102,241,0.2)" }}>
                  <span>Revenue (uden moms)</span>
                  <span>{revenueExMoms.toLocaleString()} {currency}</span>
                </div>
                <div className="pt-2 border-t" style={{ borderColor: "rgba(99,102,241,0.15)" }}>
                  <p className="text-xs text-indigo-400">
                    📊 This MOMS data is saved and available in <strong>Tax Autopilot</strong> for your accountant.
                  </p>
                </div>
              </div>
            )}

            {/* Payment summary */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 mb-2">Payments</h3>
              {payMethods.filter(m => payAmounts[m.key]).map(m => (
                <div key={m.key} className="flex justify-between text-sm py-0.5 dark:text-gray-300">
                  <span>{m.icon} {m.label}</span>
                  <span>{parseFloat(payAmounts[m.key]).toLocaleString()} {currency}</span>
                </div>
              ))}
              <div className="flex justify-between font-bold pt-2 border-t dark:border-gray-600 mt-2 dark:text-white">
                <span>Total</span><span>{paymentTotal.toLocaleString()} {currency}</span>
              </div>
            </div>

            {/* Cash drawer */}
            {cashCounted && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 mb-2">Cash Drawer</h3>
                <div className="flex justify-between text-sm dark:text-gray-300"><span>Expected</span><span>{cashExpected.toLocaleString()} {currency}</span></div>
                <div className="flex justify-between text-sm dark:text-gray-300"><span>Counted</span><span>{cashCountedVal.toLocaleString()} {currency}</span></div>
                <div className={`flex justify-between font-bold pt-2 border-t dark:border-gray-600 mt-2 ${cashDiff < -100 ? "text-red-600" : "dark:text-white"}`}>
                  <span>Difference</span><span>{cashDiff > 0 ? "+" : ""}{cashDiff?.toLocaleString()} {currency}</span>
                </div>
              </div>
            )}

            {/* Expenses (from synced data) */}
            {prefill && prefill.expenses.total > 0 && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-red-500 dark:text-red-400 mb-2">Today's Expenses</h3>
                {Object.entries(prefill.expenses.by_category).map(([cat, val]) => (
                  <div key={cat} className="flex justify-between text-sm py-0.5 text-red-700 dark:text-red-300">
                    <span>{cat}</span>
                    <span>-{val.toLocaleString()} {currency}</span>
                  </div>
                ))}
                <div className="flex justify-between font-bold pt-2 border-t border-red-200 dark:border-red-800 mt-2 text-red-700 dark:text-red-300">
                  <span>Total Expenses</span><span>-{prefill.expenses.total.toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between font-bold pt-2 mt-1 text-green-700 dark:text-green-300">
                  <span>Net Profit</span><span>{(revenueTotal - prefill.expenses.total).toLocaleString()} {currency}</span>
                </div>
              </div>
            )}

            {/* Tips */}
            {tipsTotal && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 mb-2">Tips</h3>
                <div className="flex justify-between text-sm dark:text-gray-300"><span>Total</span><span>{parseFloat(tipsTotal).toLocaleString()} {currency}</span></div>
                <div className="flex justify-between text-sm dark:text-gray-300"><span>Staff</span><span>{staffCount}</span></div>
                {tipsPP && <div className="flex justify-between font-bold pt-2 border-t dark:border-gray-600 mt-2 dark:text-white"><span>Per Person</span><span>{tipsPP.toLocaleString()} {currency}</span></div>}
              </div>
            )}

            {/* Closed by + notes */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300">Closed by</label>
                <input type="text" placeholder="Manager name..." className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl"
                  value={closedBy} onChange={e => setClosedBy(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300">Notes</label>
                <textarea placeholder="Any notes for tonight..." rows={2} className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl resize-none"
                  value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
            </div>

            {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex justify-between mt-6 pt-4 border-t dark:border-gray-700">
          {step > 1 ? (
            <button onClick={() => setStep(step - 1)}
              className="px-5 py-2.5 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl font-medium">
              ← Back
            </button>
          ) : (
            <button onClick={() => { setScanMode("idle"); setScanResult(null); setScanPhotos([]); }}
              className="px-5 py-2.5 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl font-medium text-sm">
              ← Scan Z-Report
            </button>
          )}

          {step < totalSteps ? (
            <button onClick={() => setStep(step + 1)}
              className="px-6 py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 font-semibold transition">
              Next →
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={saving || revenueTotal === 0}
              className="px-6 py-2.5 bg-green-600 text-white rounded-xl hover:bg-green-700 font-semibold transition disabled:opacity-50">
              {saving ? "Saving..." : "🔒 Confirm & Lock"}
            </button>
          )}
        </div>
        </>)}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   HISTORY VIEW
   ═══════════════════════════════════════════════════════════ */
function HistoryView({ data, currency, t, onRefresh }) {
  const [downloading, setDownloading] = useState(null);
  const [unlockId, setUnlockId] = useState(null);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const handleUnlock = async () => {
    if (!unlockReason.trim() || !unlockId) return;
    setUnlocking(true);
    try {
      await api.post(`/daily-close/${unlockId}/unlock`, { reason: unlockReason.trim() });
      setUnlockId(null);
      setUnlockReason("");
      onRefresh();
    } catch { /* ignore */ } finally {
      setUnlocking(false);
    }
  };

  const downloadPdf = async (id, dateStr) => {
    setDownloading(id);
    try {
      const res = await api.get(`/daily-close/${id}/pdf`, { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `kasserapport_${dateStr}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch { /* ignore */ } finally {
      setDownloading(null);
    }
  };

  if (!data.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <p className="text-4xl mb-3">📋</p>
        <p className="font-semibold dark:text-white">No daily closes yet</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Submit your first end-of-day close to see history here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {data.map(dc => {
        const rev = dc.revenue_breakdown || {};
        const pay = dc.payment_breakdown || {};
        return (
          <div key={dc.id} className="bg-white dark:bg-gray-800 rounded-2xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold dark:text-white">
                    {new Date(dc.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                  </h3>
                  {(dc.status || "confirmed") === "confirmed" ? (
                    <span className="text-[10px] px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded font-semibold">🔒 Locked</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded font-semibold">📝 Draft</span>
                  )}
                </div>
                {dc.closed_by && <p className="text-xs text-gray-400">Closed by {dc.closed_by}</p>}
                {dc.unlock_reason && (
                  <p className="text-xs text-amber-500 mt-0.5">Unlocked: {dc.unlock_reason}</p>
                )}
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-green-600 dark:text-green-400">{dc.revenue_total?.toLocaleString()} {currency}</p>
              </div>
            </div>

            {/* Revenue chips */}
            <div className="flex flex-wrap gap-2 mt-3">
              {Object.entries(rev).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-lg text-xs font-medium">
                  {k}: {v.toLocaleString()}
                </span>
              ))}
            </div>

            {/* Payment chips */}
            <div className="flex flex-wrap gap-2 mt-2">
              {Object.entries(pay).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-lg text-xs font-medium">
                  {k}: {v.toLocaleString()}
                </span>
              ))}
            </div>

            {/* Bottom row */}
            <div className="flex items-center justify-between mt-3 pt-3 border-t dark:border-gray-700">
              <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
                {dc.cash_difference !== null && (
                  <span className={dc.cash_difference < -100 ? "text-red-500" : ""}>
                    Cash: {dc.cash_difference > 0 ? "+" : ""}{dc.cash_difference?.toLocaleString()}
                  </span>
                )}
                {dc.tips_total > 0 && <span>Tips: {dc.tips_total?.toLocaleString()} ({dc.tips_staff_count} staff)</span>}
              </div>
              <div className="flex gap-2">
                {(dc.status || "confirmed") === "confirmed" && (
                  <button onClick={() => { setUnlockId(dc.id); setUnlockReason(""); }}
                    className="text-xs px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 font-medium">
                    🔓 Unlock
                  </button>
                )}
                <button onClick={() => downloadPdf(dc.id, dc.date)} disabled={downloading === dc.id}
                  className="text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 font-medium dark:text-gray-300">
                  {downloading === dc.id ? "..." : "📄 PDF"}
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Unlock modal */}
      {unlockId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setUnlockId(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold dark:text-white mb-1">🔓 Unlock Daily Close</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              This will allow editing. Enter a reason for the audit trail.
            </p>
            <textarea placeholder="e.g. Accountant found an error in cash count..."
              rows={3}
              className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl resize-none mb-4"
              value={unlockReason} onChange={e => setUnlockReason(e.target.value)} />
            <div className="flex gap-3">
              <button onClick={() => setUnlockId(null)}
                className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 rounded-xl font-medium text-sm dark:text-gray-300">
                Cancel
              </button>
              <button onClick={handleUnlock} disabled={unlocking || !unlockReason.trim()}
                className="flex-1 px-4 py-2.5 bg-amber-500 text-white rounded-xl font-semibold text-sm hover:bg-amber-600 transition disabled:opacity-50">
                {unlocking ? "Unlocking..." : "🔓 Unlock"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   INSIGHTS VIEW
   ═══════════════════════════════════════════════════════════ */
function InsightsView({ data, currency, t }) {
  if (!data || !data.has_data) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <p className="text-4xl mb-3">💡</p>
        <p className="font-semibold dark:text-white">Not enough data yet</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Submit a few daily closes to unlock insights about your revenue, tips, and cash handling.</p>
      </div>
    );
  }

  const { insights, summary } = data;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <SummaryCard label="Avg Daily Revenue" value={`${summary.avg_daily_revenue?.toLocaleString()} ${currency}`} />
        <SummaryCard label="Total Tips (90d)" value={`${summary.total_tips?.toLocaleString()} ${currency}`} />
        <SummaryCard label="Cash Drift (90d)" value={`${summary.total_cash_difference > 0 ? "+" : ""}${summary.total_cash_difference?.toLocaleString()} ${currency}`}
          color={summary.total_cash_difference < -200 ? "red" : "green"} />
      </div>

      {/* Insight cards */}
      {insights.map((ins, i) => (
        <div key={i} className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="text-2xl">{ins.icon}</span>
            <div>
              <h3 className="font-bold dark:text-white">{ins.title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{ins.detail}</p>
              {ins.benchmark && (
                <p className="text-xs text-gray-400 mt-2">Industry benchmark: {ins.benchmark}</p>
              )}
            </div>
          </div>
        </div>
      ))}

      {insights.length === 0 && (
        <div className="text-center text-gray-400 text-sm py-8">
          Keep logging daily closes to unlock more insights.
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  const c = color === "red" ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400";
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-lg font-bold mt-1 ${color ? c : "dark:text-white"}`}>{value}</p>
    </div>
  );
}
