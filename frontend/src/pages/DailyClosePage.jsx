import { useState, useEffect, useMemo, useRef } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useBranch } from "../components/BranchSelector";
import { displayCurrency } from "../utils/currency";
import { trackEvent } from "../hooks/useEventLog";
import { FadeIn } from "../components/AnimationKit";
import DismissibleTip from "../components/DismissibleTip";

/* ═══════════════════════════════════════════════════════════
   OFFLINE QUEUE — store pending daily close submissions
   ═══════════════════════════════════════════════════════════ */
const OQ_KEY = "bonbox_dc_offline_queue";

function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OQ_KEY) || "[]"); } catch { return []; }
}
function addToOfflineQueue(payload) {
  const q = getOfflineQueue();
  q.push({ payload, ts: Date.now(), id: crypto.randomUUID() });
  localStorage.setItem(OQ_KEY, JSON.stringify(q));
}
async function syncOfflineQueue() {
  const q = getOfflineQueue();
  if (!q.length) return 0;
  const remaining = [];
  for (const item of q) {
    try {
      await api.post("/daily-close", item.payload);
    } catch (err) {
      if (!err.response) { remaining.push(item); break; } // network still down — stop
      // Server responded (even 4xx) — drop from queue
    }
  }
  // Keep only un-synced items
  const synced = q.length - remaining.length;
  const leftover = [...remaining, ...q.slice(q.length - remaining.length + remaining.length)];
  localStorage.setItem(OQ_KEY, JSON.stringify(remaining));
  return remaining.length;
}

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
  const { branchId, branchType, branches } = useBranch();
  const hasMultiBranch = branches?.length > 1;
  const currency = displayCurrency(user?.currency);

  const [tab, setTab] = useState("close"); // close | history | insights
  const [history, setHistory] = useState([]);
  const [insights, setInsights] = useState(null);
  const [loading, setLoading] = useState(false);

  // Offline resilience
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(getOfflineQueue().length);

  const doSync = async () => {
    const left = await syncOfflineQueue();
    setPendingCount(left);
    if (left === 0) { fetchHistory(); fetchInsights(); }
  };

  useEffect(() => {
    const goOn = () => { setIsOnline(true); doSync(); };
    const goOff = () => setIsOnline(false);
    window.addEventListener("online", goOn);
    window.addEventListener("offline", goOff);
    return () => { window.removeEventListener("online", goOn); window.removeEventListener("offline", goOff); };
  }, []);

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
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold dark:text-white flex items-center gap-2">
              📋 {t("dailyClose") || "Daily Close"}
            </h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
              {(CLOSE_CONFIG[branchType] || CLOSE_CONFIG.general).description}
            </p>
          </div>
          {/* Online/Offline + pending indicator */}
          {(!isOnline || pendingCount > 0) && (
            <div className="flex items-center gap-2">
              {!isOnline && (
                <span className="text-[10px] px-2 py-1 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full font-semibold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-gray-400 rounded-full" /> Offline
                </span>
              )}
              {pendingCount > 0 && (
                <button onClick={doSync} disabled={!isOnline}
                  className="text-[10px] px-2 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded-full font-semibold hover:bg-amber-200 disabled:opacity-50">
                  {isOnline ? `Sync ${pendingCount} pending` : `${pendingCount} queued`}
                </button>
              )}
            </div>
          )}
        </div>
      </FadeIn>

      <DismissibleTip
        id="daily-close-intro-v1"
        icon="📋"
        title="What is Daily Close?"
      >
        <p>
          End-of-shift wrap-up: count your cash drawer + card terminal totals once a day, and BonBox
          locks in your numbers as the source of truth for Moms reports. Tap{" "}
          <strong>New Close</strong>, fill in what you actually have, and confirm. Past closes show under <strong>History</strong>.
        </p>
      </DismissibleTip>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        {[
          { id: "close", label: t("newClose") || "New Close", icon: "✏️" },
          { id: "history", label: t("historyTab") || "History", icon: "📅" },
          { id: "insights", label: t("insightsTab") || "Insights", icon: "💡" },
          ...(hasMultiBranch ? [{ id: "branches", label: "Branches", icon: "🏢" }] : []),
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

      {tab === "close" && <CloseForm currency={currency} t={t} branchType={branchType} branchId={branchId} isOnline={isOnline}
        onDone={() => { fetchHistory(); fetchInsights(); setTab("history"); }}
        onQueued={() => { setPendingCount(getOfflineQueue().length); setTab("history"); }} />}
      {tab === "history" && <HistoryView data={history} currency={currency} t={t} onRefresh={fetchHistory} insights={insights} />}
      {tab === "insights" && <InsightsView data={insights} currency={currency} t={t} />}
      {tab === "branches" && <BranchSummaryView currency={currency} />}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   MULTI-STEP CLOSE FORM
   ═══════════════════════════════════════════════════════════ */
/** Compute the "business date" — if current hour < cutoff, it's still yesterday's shift. */
function getBusinessDate(cutoffHour = 0) {
  const now = new Date();
  const d = new Date(now);
  if (cutoffHour > 0 && now.getHours() < cutoffHour) {
    d.setDate(d.getDate() - 1);
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function CloseForm({ currency, t, branchType, branchId, onDone, onQueued, isOnline }) {
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

  // Night shift: business date may differ from calendar date
  const [businessDate, setBusinessDate] = useState(() => getBusinessDate(0));
  const [cutoffHour, setCutoffHour] = useState(0);

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
        const today = businessDate;
        const params = { date: today };
        if (branchId) params.branch_id = branchId;
        const res = await api.get("/daily-close/prefill", { params });
        // Apply night shift cutoff from business profile
        const serverCutoff = res.data.day_cutoff_hour || 0;
        if (serverCutoff !== cutoffHour) {
          setCutoffHour(serverCutoff);
          const correctedDate = getBusinessDate(serverCutoff);
          if (correctedDate !== today) {
            setBusinessDate(correctedDate);
            // Re-fetch with corrected date (don't loop — cutoffHour dep is stable after this)
          }
        }
        setBusinessDate(getBusinessDate(serverCutoff));

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
  }, [branchId, businessDate]);

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
      date: businessDate,
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

  // Final submit — locks the close (with offline queue fallback)
  const handleSubmit = async () => {
    setSaving(true);
    setError("");
    const payload = buildPayload("confirmed");

    if (!navigator.onLine) {
      addToOfflineQueue(payload);
      setSaving(false);
      onQueued?.();
      return;
    }

    try {
      await api.post("/daily-close", payload);
      trackEvent(
        payload.status === "draft" ? "daily_close_draft_saved" : "daily_close_completed",
        "daily-close",
        payload.report_date || null
      );
      onDone();
    } catch (err) {
      if (!err.response) {
        // Network failed mid-request — queue for later
        addToOfflineQueue(payload);
        setSaving(false);
        onQueued?.();
        return;
      }
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
                          revenue: { ...prev.revenue, [c.key]: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 }
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
                          payments: { ...prev.payments, [m.key]: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 }
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
                    setScanResult(prev => ({ ...prev, tips: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 }));
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
        {/* Date selector — defaults to today, allows past dates */}
        <div className="mb-4 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
            📅 Date
          </label>
          <input type="date" value={businessDate}
            max={getBusinessDate(cutoffHour)}
            onChange={e => { if (e.target.value) setBusinessDate(e.target.value); }}
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
          {businessDate !== getBusinessDate(cutoffHour) && (
            <span className="text-[10px] px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full font-semibold">
              Past date
            </span>
          )}
          {businessDate !== getBusinessDate(cutoffHour) && (
            <button onClick={() => setBusinessDate(getBusinessDate(cutoffHour))}
              className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline">
              Reset to today
            </button>
          )}
        </div>

        {/* Draft auto-save indicator */}
        {draftSaved && (
          <div className="mb-3 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-center text-xs text-gray-400 flex items-center justify-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-green-400 rounded-full" /> Draft saved — you can leave and resume later
          </div>
        )}

        {/* Sync indicator */}
        {prefillLoading && (
          <div className="mb-4 px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl text-center text-sm text-gray-400">
            Loading records...
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

        {/* Night shift indicator */}
        {cutoffHour > 0 && businessDate !== new Date().toISOString().split("T")[0] && (
          <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl px-3 py-2 flex items-center gap-2 mb-3 border border-indigo-100 dark:border-indigo-800">
            <span className="text-sm">🌙</span>
            <p className="text-xs text-indigo-600 dark:text-indigo-300">
              <strong>Night shift:</strong> closing for {new Date(businessDate + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} (cutoff {cutoffHour}:00 AM)
            </p>
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
            {/* Date confirmation */}
            <div className="flex items-center gap-2 text-sm dark:text-gray-300">
              <span>📅</span>
              <span className="font-medium">
                {new Date(businessDate + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              </span>
              {businessDate !== getBusinessDate(cutoffHour) && (
                <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded font-semibold">Past date</span>
              )}
            </div>

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
                    📊 This MOMS data feeds into <a href="/tax" className="font-bold underline hover:text-indigo-300">Tax Autopilot</a> &mdash; reconciled automatically with your sales records.
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
              {saving ? "Saving..." : !isOnline ? "📤 Queue & Lock (offline)" : "🔒 Confirm & Lock"}
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
function HistoryView({ data, currency, t, onRefresh, insights }) {
  const [downloading, setDownloading] = useState(null);
  const [unlockId, setUnlockId] = useState(null);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const activeStreak = insights?.insights?.find(i => i.type === "cash_streak" && i.is_active);

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
      {/* Active cash streak warning banner */}
      {activeStreak && (
        <div className={`rounded-xl p-3 flex items-center gap-2 border ${
          activeStreak.severity === "critical"
            ? "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800"
            : activeStreak.severity === "warning"
            ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800"
            : "bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800"
        }`}>
          <span className="text-lg">{activeStreak.icon}</span>
          <p className={`text-sm font-medium ${
            activeStreak.severity === "critical" ? "text-red-700 dark:text-red-300"
              : "text-amber-700 dark:text-amber-300"
          }`}>
            {activeStreak.title} &mdash; check Insights for details
          </p>
        </div>
      )}

      {/* Calendar heat map */}
      <CalendarHeatMap data={data} currency={currency} />

      {data.map((dc, idx) => {
        const rev = dc.revenue_breakdown || {};
        const pay = dc.payment_breakdown || {};
        const prev = data[idx + 1]; // previous close (list sorted desc)
        const revChange = prev && prev.revenue_total > 0 && dc.revenue_total > 0
          ? Math.round(((dc.revenue_total - prev.revenue_total) / prev.revenue_total) * 100) : null;
        const tipsChange = prev && prev.tips_total > 0 && dc.tips_total > 0
          ? Math.round(((dc.tips_total - prev.tips_total) / prev.tips_total) * 100) : null;
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
                {revChange !== null && Math.abs(revChange) >= 1 && (
                  <p className={`text-[11px] font-semibold ${revChange > 0 ? "text-green-500" : "text-red-500"}`}>
                    {revChange > 0 ? "↑" : "↓"} {Math.abs(revChange)}% vs prev
                  </p>
                )}
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
                {dc.tips_total > 0 && (
                  <span>Tips: {dc.tips_total?.toLocaleString()} ({dc.tips_staff_count} staff)
                    {tipsChange !== null && Math.abs(tipsChange) >= 1 && (
                      <span className={`ml-1 font-semibold ${tipsChange > 0 ? "text-green-500" : "text-red-500"}`}>
                        {tipsChange > 0 ? "↑" : "↓"}{Math.abs(tipsChange)}%
                      </span>
                    )}
                  </span>
                )}
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
   BRANCH SUMMARY VIEW — multi-branch comparison
   ═══════════════════════════════════════════════════════════ */
function BranchSummaryView({ currency }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState("7"); // "1" = today, "7" = week, "30" = month

  const fetchSummary = async () => {
    setLoading(true);
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - (parseInt(range) - 1));
      const fmtD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const res = await api.get("/daily-close/branch-summary", { params: { from: fmtD(from), to: fmtD(to) } });
      setData(res.data);
    } catch { /* silent */ }
    setLoading(false);
  };

  useEffect(() => { fetchSummary(); }, [range]);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <p className="text-4xl mb-3 animate-pulse">🏢</p>
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading branch data...</p>
      </div>
    );
  }

  if (!data || !data.branches?.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <p className="text-4xl mb-3">🏢</p>
        <p className="font-semibold dark:text-white">No branch data</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Submit daily closes for multiple branches to see comparisons.</p>
      </div>
    );
  }

  const { branches, grand_total } = data;
  const topBranch = branches[0];

  return (
    <div className="space-y-4">
      {/* Range toggle */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm dark:text-white flex items-center gap-1.5">
          <span>🏢</span> Branch Comparison
        </h3>
        <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
          {[{ v: "1", l: "Today" }, { v: "7", l: "7 days" }, { v: "30", l: "30 days" }].map(r => (
            <button key={r.v} onClick={() => setRange(r.v)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                range === r.v ? "bg-white dark:bg-gray-600 shadow-sm text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"
              }`}>
              {r.l}
            </button>
          ))}
        </div>
      </div>

      {/* Grand totals */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">Total Revenue</p>
          <p className="text-lg font-bold text-green-600 dark:text-green-400 mt-0.5">{grand_total.revenue_total?.toLocaleString()}</p>
          <p className="text-[10px] text-gray-400">{currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">Cash Variance</p>
          <p className={`text-lg font-bold mt-0.5 ${grand_total.cash_diff_total < -200 ? "text-red-500" : "text-gray-700 dark:text-white"}`}>
            {grand_total.cash_diff_total > 0 ? "+" : ""}{grand_total.cash_diff_total?.toLocaleString()}
          </p>
          <p className="text-[10px] text-gray-400">{currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">Total Tips</p>
          <p className="text-lg font-bold text-blue-600 dark:text-blue-400 mt-0.5">{grand_total.tips_total?.toLocaleString()}</p>
          <p className="text-[10px] text-gray-400">{currency}</p>
        </div>
      </div>

      {/* Branch cards */}
      {branches.map((b, i) => {
        const revShare = grand_total.revenue_total > 0 ? Math.round((b.revenue_total / grand_total.revenue_total) * 100) : 0;
        return (
          <div key={b.branch_id || i} className="bg-white dark:bg-gray-800 rounded-2xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold dark:text-white">{b.branch_name}</h3>
                  {i === 0 && branches.length > 1 && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded font-semibold">Top</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">{b.days_count} close{b.days_count !== 1 ? "s" : ""} &middot; avg {b.avg_daily_revenue?.toLocaleString()}/day</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-green-600 dark:text-green-400">{b.revenue_total?.toLocaleString()} <span className="text-xs font-normal text-gray-400">{currency}</span></p>
                <p className="text-[10px] text-gray-400">{revShare}% of total</p>
              </div>
            </div>

            {/* Revenue share bar */}
            <div className="mt-3 h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-green-500 dark:bg-green-400 rounded-full transition-all" style={{ width: `${revShare}%` }} />
            </div>

            {/* Metrics row */}
            <div className="flex gap-4 mt-3 text-xs text-gray-500 dark:text-gray-400">
              <span>Cash: <span className={b.cash_diff_total < -100 ? "text-red-500 font-semibold" : ""}>{b.cash_diff_total > 0 ? "+" : ""}{b.cash_diff_total?.toLocaleString()}</span></span>
              {b.tips_total > 0 && <span>Tips: {b.tips_total?.toLocaleString()}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   CALENDAR HEAT MAP — 90-day visual overview
   ═══════════════════════════════════════════════════════════ */
function CalendarHeatMap({ data, currency }) {
  const [mode, setMode] = useState("revenue"); // "revenue" | "cash"
  const [hovered, setHovered] = useState(null);

  // Build date → close lookup
  const closeMap = useMemo(() => {
    const map = {};
    (data || []).forEach(dc => { map[dc.date] = dc; });
    return map;
  }, [data]);

  // Generate 90 days of grid data grouped into weeks (Mon-start)
  const weeks = useMemo(() => {
    const today = new Date();
    const days = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      days.push(d);
    }
    const result = [];
    let week = new Array(7).fill(null);
    for (const d of days) {
      const dow = (d.getDay() + 6) % 7; // Mon=0, Sun=6
      week[dow] = d;
      if (dow === 6) { result.push(week); week = new Array(7).fill(null); }
    }
    if (week.some(d => d !== null)) result.push(week);
    return result;
  }, []);

  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Color logic based on mode + data percentiles
  const getColor = useMemo(() => {
    if (mode === "revenue") {
      const vals = (data || []).map(dc => dc.revenue_total).filter(v => v > 0).sort((a, b) => a - b);
      if (!vals.length) return () => "bg-gray-100 dark:bg-gray-800";
      const p25 = vals[Math.floor(vals.length * 0.25)];
      const p50 = vals[Math.floor(vals.length * 0.5)];
      const p75 = vals[Math.floor(vals.length * 0.75)];
      return (dc) => {
        if (!dc) return "bg-gray-100 dark:bg-gray-800";
        const v = dc.revenue_total;
        if (!v || v <= 0) return "bg-gray-200 dark:bg-gray-700";
        if (v <= p25) return "bg-green-200 dark:bg-green-900/60";
        if (v <= p50) return "bg-green-300 dark:bg-green-700";
        if (v <= p75) return "bg-green-500 dark:bg-green-600";
        return "bg-green-700 dark:bg-green-400";
      };
    }
    // Cash variance mode
    return (dc) => {
      if (!dc) return "bg-gray-100 dark:bg-gray-800";
      const diff = dc.cash_difference;
      if (diff === null || diff === undefined) return "bg-gray-200 dark:bg-gray-700";
      if (diff >= 0) return "bg-green-300 dark:bg-green-700";
      if (diff >= -100) return "bg-amber-300 dark:bg-amber-700";
      if (diff >= -300) return "bg-orange-400 dark:bg-orange-600";
      return "bg-red-500 dark:bg-red-500";
    };
  }, [data, mode]);

  const legendItems = mode === "revenue"
    ? [
        { color: "bg-gray-200 dark:bg-gray-700", label: "None" },
        { color: "bg-green-200 dark:bg-green-900/60", label: "Low" },
        { color: "bg-green-500 dark:bg-green-600", label: "Mid" },
        { color: "bg-green-700 dark:bg-green-400", label: "High" },
      ]
    : [
        { color: "bg-gray-200 dark:bg-gray-700", label: "N/A" },
        { color: "bg-green-300 dark:bg-green-700", label: "Even/+" },
        { color: "bg-amber-300 dark:bg-amber-700", label: "-100" },
        { color: "bg-red-500 dark:bg-red-500", label: "Short" },
      ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
      {/* Header + mode toggle */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm dark:text-white flex items-center gap-1.5">
          <span>📆</span> 90-Day Overview
        </h3>
        <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
          {[{ id: "revenue", label: "Revenue" }, { id: "cash", label: "Cash +/-" }].map(m => (
            <button key={m.id} onClick={() => setMode(m.id)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                mode === m.id ? "bg-white dark:bg-gray-600 shadow-sm text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"
              }`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {/* Day-of-week labels */}
        <div className="flex flex-col gap-[3px] mr-0.5 shrink-0">
          {["M", "", "W", "", "F", "", "S"].map((d, i) => (
            <div key={i} className="w-3 h-3 flex items-center justify-center text-[8px] text-gray-400 dark:text-gray-500 select-none">{d}</div>
          ))}
        </div>
        {/* Week columns */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((day, di) => {
              if (!day) return <div key={di} className="w-3 h-3" />;
              const ds = fmtDate(day);
              const dc = closeMap[ds];
              return (
                <div key={di}
                  className={`w-3 h-3 rounded-[2px] ${getColor(dc)} cursor-pointer transition-all hover:ring-2 hover:ring-gray-400 dark:hover:ring-gray-300 hover:scale-125`}
                  onMouseEnter={() => setHovered({ ds, dc })}
                  onMouseLeave={() => setHovered(null)}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Hover info line */}
      <div className="h-5 mt-1.5">
        {hovered ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            <span className="font-medium dark:text-gray-300">
              {new Date(hovered.ds + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
            </span>
            {hovered.dc ? (
              mode === "revenue"
                ? <> &mdash; {hovered.dc.revenue_total?.toLocaleString()} {currency}</>
                : <> &mdash; Cash: {hovered.dc.cash_difference !== null && hovered.dc.cash_difference !== undefined
                    ? `${hovered.dc.cash_difference > 0 ? "+" : ""}${hovered.dc.cash_difference?.toLocaleString()} ${currency}`
                    : "N/A"}</>
            ) : <> &mdash; No close</>}
          </p>
        ) : (
          <p className="text-[10px] text-gray-400 dark:text-gray-500">Hover a day to see details</p>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[9px] text-gray-400">Less</span>
        {legendItems.map((l, i) => (
          <div key={i} className={`w-2.5 h-2.5 rounded-[2px] ${l.color}`} title={l.label} />
        ))}
        <span className="text-[9px] text-gray-400">More</span>
      </div>
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
  const streakAlerts = insights.filter(i => i.type === "cash_streak");
  const regularInsights = insights.filter(i => i.type !== "cash_streak");

  return (
    <div className="space-y-4">
      {/* Streak alerts — prominent at top */}
      {streakAlerts.map((alert, i) => (
        <StreakAlertCard key={i} alert={alert} currency={currency} />
      ))}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <SummaryCard label="Avg Daily Revenue" value={`${summary.avg_daily_revenue?.toLocaleString()} ${currency}`} />
        <SummaryCard label="Total Tips (90d)" value={`${summary.total_tips?.toLocaleString()} ${currency}`} />
        <SummaryCard label="Cash Drift (90d)" value={`${summary.total_cash_difference > 0 ? "+" : ""}${summary.total_cash_difference?.toLocaleString()} ${currency}`}
          color={summary.total_cash_difference < -200 ? "red" : "green"} />
      </div>

      {/* Regular insight cards */}
      {regularInsights.map((ins, i) => (
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

function StreakAlertCard({ alert, currency }) {
  const styles = {
    critical: {
      border: "border-red-300 dark:border-red-700",
      bg: "bg-red-50 dark:bg-red-950/40",
      badge: "bg-red-500 text-white",
      title: "text-red-800 dark:text-red-200",
      detail: "text-red-600 dark:text-red-400",
      dot: "bg-red-500 dark:bg-red-400",
    },
    warning: {
      border: "border-amber-300 dark:border-amber-700",
      bg: "bg-amber-50 dark:bg-amber-950/40",
      badge: "bg-amber-500 text-white",
      title: "text-amber-800 dark:text-amber-200",
      detail: "text-amber-600 dark:text-amber-400",
      dot: "bg-amber-500 dark:bg-amber-400",
    },
    info: {
      border: "border-yellow-300 dark:border-yellow-700",
      bg: "bg-yellow-50 dark:bg-yellow-950/40",
      badge: "bg-yellow-500 text-white",
      title: "text-yellow-800 dark:text-yellow-200",
      detail: "text-yellow-700 dark:text-yellow-400",
      dot: "bg-yellow-500 dark:bg-yellow-400",
    },
  };

  const s = styles[alert.severity] || styles.info;

  return (
    <div className={`rounded-2xl p-5 border-2 ${s.border} ${s.bg} shadow-sm`}>
      <div className="flex items-start gap-3">
        <span className="text-2xl">{alert.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`font-bold ${s.title}`}>{alert.title}</h3>
            {alert.is_active && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${s.badge}`}>
                Active
              </span>
            )}
          </div>
          <p className={`text-sm mt-1 ${s.detail}`}>{alert.detail}</p>

          {/* Streak dots visualization */}
          <div className="flex items-center gap-1.5 mt-3">
            {Array.from({ length: alert.streak_length }).map((_, i) => (
              <div key={i} className={`w-2.5 h-2.5 rounded-full ${s.dot}`} />
            ))}
            <span className="text-xs ml-1.5 text-gray-500 dark:text-gray-400">
              {alert.streak_length} consecutive days &middot; {alert.streak_total?.toLocaleString()} {currency}
            </span>
          </div>

          {alert.total_streaks > 1 && (
            <p className="text-xs mt-2 text-gray-400 dark:text-gray-500">
              {alert.total_streaks} separate shortage streaks detected in last 90 days
            </p>
          )}
        </div>
      </div>
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
