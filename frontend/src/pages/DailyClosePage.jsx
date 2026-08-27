import { useState, useEffect, useMemo, useRef } from "react";
import { dateLocale } from "../utils/dateFormat";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useBranch } from "../components/BranchSelector";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency, getTaxConfig, getVatTerms } from "../utils/currency";
import { trackEvent } from "../hooks/useEventLog";
import DismissibleTip from "../components/DismissibleTip";
import { safeImageUrl } from "../utils/safeUrl";
import { errText } from "../utils/errText";
import { resizeImageIfLarge } from "../utils/resizeImage";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";
import { haptic } from "../utils/haptics";
import { archetypeForUser, archetypeIdFor } from "../config/archetypes";
import {
  buildShareMessage,
  buildShareTitle,
  formatDanishDateLabel,
  shareCloseSummary,
} from "../utils/shareClose";
import { sendDailyCloseRangeToAccountant } from "../utils/shareDailyCloseRange";
// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { UpgradeNudge, PageHeader, TabPills, Button, Icon, SectionBanner } from "../components/ui";
import PageShell from "../components/ui/PageShell";
import SmartScanModal from "../components/SmartScanModal";
// LiveKpisToday — extracted from the legacy /daily-report page so
// the merged daily page (#150) shows the live operational snapshot
// at the top, then the close wizard below. Keeps a single "Today"
// experience instead of two competing entries.
import LiveKpisToday from "../components/LiveKpisToday";

// Per-archetype subtitle for the "Today" header — the close page speaks each
// trade's language (restaurant vs salon vs bar vs retail). Keys resolve in
// useLanguage (en+da); unknown / generic archetype → the neutral navTodaySubtitle.
const TODAY_SUBTITLE_KEY = {
  food_service: "todaySubtitleFood",
  bar: "todaySubtitleBar",
  salon: "todaySubtitleSalon",
  retail: "todaySubtitleRetail",
  services: "todaySubtitleServices",
  personal: "todaySubtitlePersonal",
};

// Per-vertical close TITLE ("X er låst · {time} af {who}"). Bakery is
// business_type-specific (within food_service only a bakery says "bagning");
// bar/salon/retail key on archetype (they cover many business_types). Café /
// restaurant / everything else keeps the default closeLockedTitle. Every key
// preserves the {time}/{who} placeholders so the .replace() calls still work.
function closeTitleKeyFor(businessType) {
  if (String(businessType || "").trim().toLowerCase() === "bakery") return "closeLockedTitleBakery";
  const archId = archetypeIdFor(businessType);
  if (archId === "bar") return "closeLockedTitleBar";
  if (archId === "salon") return "closeLockedTitleSalon";
  if (archId === "retail") return "closeLockedTitleRetail";
  return "closeLockedTitle";
}

/**
 * Decode an axios error from a blob-typed request.
 *
 * When a request expects responseType: "blob" but the server returns
 * an error JSON body, axios still wraps the body as a Blob in
 * err.response.data. We read the blob → parse → return the structured
 * detail. Returns:
 *   { message: string, isPlanCap: boolean, capDays?: number,
 *     planTier?: string }
 *
 * Falls back to a generic "Could not export." message if anything
 * about the parse fails — never throws.
 */
async function parseExportError(err) {
  // Plan cap → 402 with structured JSON body
  // Cooldown / rate limit → 429
  // Other → generic
  const status = err?.response?.status;
  let detail = err?.response?.data;

  // If the response was a blob (export endpoints), read it as text
  if (detail instanceof Blob) {
    try {
      const text = await detail.text();
      try {
        detail = JSON.parse(text);
      } catch {
        detail = text;
      }
    } catch {
      detail = null;
    }
  }

  // Backend shape: detail.detail = {code, message, cap_days, plan}
  // Pydantic + FastAPI sometimes nests structured errors under .detail,
  // sometimes flat. Try both.
  const inner = detail?.detail ?? detail;

  if (status === 402 && inner && typeof inner === "object" && inner.code === "plan_cap_exceeded") {
    return {
      message: inner.message || `Your plan exports up to ${inner.cap_days || "?"} days.`,
      isPlanCap: true,
      capDays: inner.cap_days,
      planTier: inner.plan,
    };
  }

  if (status === 429) {
    return {
      message: typeof inner === "string"
        ? inner
        : (inner?.message || "Too many requests — wait a minute and try again."),
      isPlanCap: false,
    };
  }

  // Generic — try a string message, then fall back
  const msg = typeof inner === "string"
    ? inner
    : inner?.message || "Could not export. Please try again.";
  return { message: msg, isPlanCap: false };
}


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
/* Built-in category + payment labels are i18n keys, not literals.
   They used to be hardcoded and three-way inconsistent: bilingual
   ("Food / Mad"), English-only ("Diagnostics", "Bank Transfer") and
   Danish-only ("Behandlinger", "Brød & bagværk") all shipped side by side, so
   an owner saw both languages at once in whichever one they had chosen.
   `label` is kept as a clean ENGLISH fallback only — the real strings live in
   en + da in useLanguage.jsx. Owner-added custom categories carry no labelKey
   and render their free text verbatim; see catLabel(). */
const REVENUE_CATS_BY_TYPE = {
  restaurant: [
    { key: "food", labelKey: "dcCatFood", label: "Food", icon: "Utensils" },
    { key: "drinks", labelKey: "dcCatDrinks", label: "Drinks", icon: "Beer" },
    { key: "takeaway", labelKey: "dcCatTakeaway", label: "Takeaway", icon: "Package" },
  ],
  workshop: [
    { key: "parts", labelKey: "dcCatParts", label: "Parts", icon: "Wrench" },
    { key: "labor", labelKey: "dcCatLabor", label: "Labour", icon: "Hammer" },
    { key: "diagnostics", labelKey: "dcCatDiagnostics", label: "Diagnostics", icon: "Search" },
    { key: "towing", labelKey: "dcCatTowing", label: "Towing", icon: "Truck" },
  ],
  retail: [
    { key: "products", labelKey: "dcCatProducts", label: "Products", icon: "ShoppingBag" },
    { key: "returns", labelKey: "dcCatReturns", label: "Returns", icon: "RotateCcw" },
    { key: "services", labelKey: "dcCatServices", label: "Services", icon: "Wrench" },
  ],
  // Phase A — salon: the frisør's actual money view is the Behandlinger
  // (service) vs Udsalgsvarer (retail product) split. Both are standard 25%
  // MOMS revenue, so they sit in the normal revenue_breakdown (MOMS math
  // unchanged). Gavekort is handled as a SEPARATE line below (NOT a revenue
  // category — excluded from the day-of-sale MOMS base, flagged for revisor).
  salon: [
    { key: "treatments", labelKey: "dcCatTreatments", label: "Treatments", icon: "Scissors" },
    { key: "retail_products", labelKey: "dcCatRetailProducts", label: "Retail products", icon: "ShoppingBag" },
  ],
  // Phase A — bakery: counter trade. Standard food-service-style split.
  bakery: [
    { key: "bread_pastry", labelKey: "dcCatBreadPastry", label: "Bread & pastry", icon: "Croissant" },
    { key: "drinks", labelKey: "dcCatDrinks", label: "Drinks", icon: "Coffee" },
    { key: "other", labelKey: "dcCatOther", label: "Other", icon: "Package" },
  ],
  grocery: [
    { key: "products", labelKey: "dcCatGroceries", label: "Groceries", icon: "ShoppingCart" },
    { key: "tobacco_lottery", labelKey: "dcCatTobaccoLottery", label: "Tobacco & lottery", icon: "Ticket" },
    { key: "fresh", labelKey: "dcCatFresh", label: "Fresh", icon: "Leaf" },
    { key: "other", labelKey: "dcCatOther", label: "Other", icon: "Package" },
  ],
  ecommerce: [
    { key: "online_sales", labelKey: "dcCatOnlineSales", label: "Online sales", icon: "Globe" },
    { key: "returns", labelKey: "dcCatReturnsRefunds", label: "Returns & refunds", icon: "RotateCcw" },
    { key: "shipping", labelKey: "dcCatShipping", label: "Shipping revenue", icon: "Truck" },
  ],
  general: [
    { key: "revenue", labelKey: "dcCatRevenue", label: "Revenue", icon: "Coins" },
  ],
};

/* MobilePay and PayPal are brand names and carry NO labelKey — they are not
   translated in either language. `faktura` keeps its Danish spelling in BOTH
   languages by the locked-terminology rule, as do kasserapport / revisor /
   MOMS. `gavekort` is left as the product's own term so this screen agrees
   with the Gavekort destination in the nav. */
const PAYMENT_METHODS_BY_TYPE = {
  restaurant: [
    { key: "cash", labelKey: "dcPayCash", label: "Cash", icon: "Banknote" },
    { key: "card", labelKey: "dcPayCard", label: "Card", icon: "CreditCard" },
    { key: "mobilepay", label: "MobilePay", icon: "Wallet" },
    { key: "invoice", labelKey: "dcPayInvoice", label: "Faktura", icon: "FileText" },
  ],
  workshop: [
    { key: "cash", labelKey: "dcPayCash", label: "Cash", icon: "Banknote" },
    { key: "card", labelKey: "dcPayCard", label: "Card", icon: "CreditCard" },
    { key: "bank_transfer", labelKey: "dcPayBankTransfer", label: "Bank transfer", icon: "Landmark" },
    { key: "invoice", labelKey: "dcPayInvoiceCredit", label: "Faktura / credit", icon: "FileText" },
  ],
  retail: [
    { key: "cash", labelKey: "dcPayCash", label: "Cash", icon: "Banknote" },
    { key: "card", labelKey: "dcPayCard", label: "Card", icon: "CreditCard" },
    { key: "mobilepay", label: "MobilePay", icon: "Wallet" },
    { key: "gift_card", labelKey: "dcPayGiftCard", label: "Gavekort", icon: "Gift" },
  ],
  grocery: [
    { key: "cash", labelKey: "dcPayCash", label: "Cash", icon: "Banknote" },
    { key: "card", labelKey: "dcPayCard", label: "Card", icon: "CreditCard" },
    { key: "mobilepay", label: "MobilePay", icon: "Wallet" },
  ],
  ecommerce: [
    { key: "card", labelKey: "dcPayCardOnline", label: "Card (online)", icon: "CreditCard" },
    { key: "mobilepay", label: "MobilePay", icon: "Wallet" },
    { key: "bank_transfer", labelKey: "dcPayBankTransfer", label: "Bank transfer", icon: "Landmark" },
    { key: "paypal", label: "PayPal", icon: "Wallet" },
  ],
};

/** Resolve a category / payment label. Built-ins carry a labelKey; categories
 *  the owner typed themselves carry only their own free text. */
function catLabel(t, entry) {
  return entry.labelKey ? t(entry.labelKey, entry.label) : entry.label;
}

/* Per-type close configuration — controls which steps + extra fields appear.
   Phase A flags:
     hasCouverts  — show a guest/couvert count field. There is NO couvert input
                    in the close form today, so this currently documents intent
                    + future-proofs: salon/bakery/retail are explicitly false so
                    a couvert field can never be added for them by default.
     hasGavekort  — salon: show a separate "Gavekort solgt" line. It is EXCLUDED
                    from the day-of-sale service MOMS base and flagged for the
                    revisor (single- vs multi-purpose voucher MOMS is a judgment
                    call we never auto-decide).
     hasBatch     — bakery: show a "Parti / Batch" reference field (informational
                    — appended to notes for the revisor, never part of MOMS). */
const CLOSE_CONFIG = {
  restaurant:  { hasTips: true,  hasCashDrawer: true,  hasCouverts: true,  stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory", description: "End-of-day closing — revenue, payments, cash drawer, tips." },
  workshop:    { hasTips: false, hasCashDrawer: true,  hasCouverts: false, stepOneLabel: "Revenue by Service",  stepOneLabelKey: "stepOneRevenueByService",  description: "End-of-day closing — parts & labor revenue, payments, cash drawer." },
  retail:      { hasTips: false, hasCashDrawer: true,  hasCouverts: false, stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory", description: "End-of-day closing — sales, returns, payments, cash drawer." },
  grocery:     { hasTips: false, hasCashDrawer: true,  hasCouverts: false, stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory", description: "End-of-day closing — sales, cash drawer, transactions." },
  ecommerce:   { hasTips: false, hasCashDrawer: false, hasCouverts: false, stepOneLabel: "Revenue by Channel",  stepOneLabelKey: "stepOneRevenueByChannel",  description: "End-of-day closing — online sales, returns, payments." },
  // Phase A — salon: no couverts; service-vs-product split lives in the revenue
  // cats; gavekort gets its own line; tips kept (DK salons take tips).
  salon:       { hasTips: true,  hasCashDrawer: true,  hasCouverts: false, hasGavekort: true, stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory", description: "End-of-day closing — Behandlinger, Udsalgsvarer, gavekort, payments." },
  // Phase A — bakery: no couverts; Parti/Batch reference field.
  bakery:      { hasTips: false, hasCashDrawer: true,  hasCouverts: false, hasBatch: true, stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory", description: "End-of-day closing — bagværk, drikkevarer, payments, cash drawer." },
  general:     { hasTips: false, hasCashDrawer: true,  hasCouverts: false, stepOneLabel: "Revenue",             stepOneLabelKey: "revenue",                   description: "End-of-day closing — revenue, expenses, payments." },
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
  // Scan-first close (#close-funnel) — the one-tap front door. Opens the
  // shared SmartScanModal; a kasserapport scan navigates back here with a
  // prefill via the existing consumer. No change to revenue/reconciliation.
  const [scanOpen, setScanOpen] = useState(false);
  // editDraft holds a DailyClose row when the user clicked "Edit" on a
  // draft in History. CloseForm reads it on mount and pre-fills all
  // fields so the owner doesn't have to re-type yesterday's numbers.
  // Cleared via onEditConsumed when the form has loaded the values.
  const [editDraft, setEditDraft] = useState(null);

  // ─── Smart Scan prefill consumer ─────────────────────────────────
  // SmartScanModal navigates here with the kasserapport extraction in
  // location.state when the classifier recognizes a Z-report. We hand
  // the payload to CloseForm via the smartScanPrefill prop; CloseForm
  // hydrates its scanResult state from it (same path it uses for
  // /daily-close/scan-report POSTs) so the wizard pre-fills steps 1–3.
  const location = useLocation();
  const navigate = useNavigate();
  const [smartScanPrefill, setSmartScanPrefill] = useState(null);
  const [smartScanVerifyHints, setSmartScanVerifyHints] = useState([]);
  useEffect(() => {
    const st = location.state;
    if (!st || (st.source !== "smart_scan" && st.source !== "smart_scan_manual")) return;
    // Switch to the close tab so the prefill lands somewhere visible.
    setTab("close");
    if (st.prefill) {
      setSmartScanPrefill(st.prefill);
      setSmartScanVerifyHints(Array.isArray(st.verify_hints) ? st.verify_hints : []);
    } else {
      // Manual override or empty extracted_data — still switch to the
      // close tab and clear any stale prefill so the owner starts fresh.
      setSmartScanPrefill(null);
      setSmartScanVerifyHints([]);
    }
    // Clear router state — same reason as ExpensesPage: refresh / back-
    // nav must not re-apply yesterday's prefill.
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  const [history, setHistory] = useState([]);
  const [insights, setInsights] = useState(null);
  const [loading, setLoading] = useState(false);
  // Lane A — when CloseForm successfully locks a close, the parent
  // captures the close_ritual block returned by the backend (auto-
  // email status, scan attached, bank-drop hint, etc.) so we can
  // render the locked-state card at the top of the History tab. The
  // card stays until the user dismisses it or navigates away.
  const [lastLockedClose, setLastLockedClose] = useState(null);

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

  // #150 merge — surface today's confirmed close (if any) at the very top
  // of the page so an owner who already locked sees the success summary
  // immediately, regardless of which tab is active. We derive this from
  // `history` (already fetched above) so no extra API call is needed.
  // The same JustLockedCard component is used for both the in-session
  // lock and the cross-visit re-entry case — single source of truth.
  const todayIso = new Date().toISOString().slice(0, 10);
  const todaysConfirmedClose = useMemo(
    () => (history || []).find(
      (dc) => (dc?.date || "").slice(0, 10) === todayIso && dc?.status === "confirmed",
    ),
    [history, todayIso],
  );
  // We prefer the *fresh* lockResult from this session (it carries the
  // close_ritual block with email status / bank-drop / push). If absent
  // (page reload after a previous lock), we synthesize a minimal close
  // object from history so the locked banner still renders — without
  // the email-status row (because that ritual already played out).
  const lockedBannerClose = lastLockedClose || (todaysConfirmedClose
    ? { ...todaysConfirmedClose, close_ritual: todaysConfirmedClose.close_ritual || {} }
    : null);
  const isLockedToday = Boolean(lockedBannerClose);

  // CTA scroll target — when the owner taps "Close the day" at the top
  // we auto-scroll to the wizard. ref attached on the wrapper below.
  const closeWizardRef = useRef(null);
  // Bumped when the owner asks for manual entry. CloseForm owns scanMode and
  // step, so this page cannot set them directly — it raises a signal and
  // CloseForm acts on it. (Writing them from here was a real bug: three
  // undefined references, so the button threw on click and did nothing.)
  const [manualRequest, setManualRequest] = useState(0);

  const scrollToWizard = ({ manual = false } = {}) => {
    setTab("close");
    // "Enter manually" has to actually ENTER MANUALLY. It used to only scroll,
    // which landed the owner on the scan card — where they then had to decline
    // scanning a SECOND time via the small underlined "Skip — enter manually"
    // link. Two decisions for one choice, on the screen they reach at 22:30.
    if (manual) setManualRequest((n) => n + 1);
    // Defer one frame so React has rendered the wizard if we just
    // switched from History/Insights.
    requestAnimationFrame(() => {
      closeWizardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const todaySubtitleKey = TODAY_SUBTITLE_KEY[archetypeForUser(user).id] || "navTodaySubtitle";

  return (
    <PageShell width="default">
      <PageHeader
        eyebrow={t("dcReportsEyebrow", "REPORTS")}
        title={t("navToday") || "Today"}
        subtitle={t(todaySubtitleKey)}
        actions={
          (!isOnline || pendingCount > 0) && (
            <div className="flex items-center gap-2">
              {!isOnline && (
                <span className="text-[10px] px-2 py-1 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full font-semibold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-gray-500 rounded-full" /> {t("dcOffline", "Offline")}
                </span>
              )}
              {pendingCount > 0 && (
                <Button variant="secondary" size="sm" onClick={doSync} disabled={!isOnline}>
                  {isOnline ? t("dcSyncPending", "Sync {count} pending", { count: pendingCount }) : t("dcQueued", "{count} queued", { count: pendingCount })}
                </Button>
              )}
            </div>
          )
        }
      />

      {/* ─── Locked-today summary at the TOP of the page (#150) ───
          When today already has a confirmed close, the JustLockedCard
          jumps to the top so the owner sees "you're done for tonight"
          before the live KPIs or the close wizard. Dismissible — same
          state as the in-History card so it doesn't pop back. */}
      {isLockedToday && (
        <JustLockedCard
          t={t}
          close={lockedBannerClose}
          currency={currency}
          businessType={user?.business_type}
          onDismiss={() => setLastLockedClose(null)}
        />
      )}

      {/* ─── Live KPIs (always visible) ───
          The "Today's Floor" snapshot, hoisted to the top of the daily
          page. Self-contained — its own data fetch, its own fail-closed
          empty + error states. If it errors, the rest of the page below
          (close wizard, history, insights) still renders cleanly. */}
      <LiveKpisToday />

      {/* "Close the day" CTA — the explicit handoff from "I'm running
          the shift" to "the shift is done, let's lock the books".
          Hidden once today is locked (no value showing a CTA that
          would just open an already-confirmed wizard). Emerald is the
          one DNA-approved money-moment accent. */}
      {!isLockedToday && (
        <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/50 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t("closeTheDayCta") || "Close the day"}
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
              {t("closeScanHint") || "Snap your Z-report and we fill in tonight's numbers — or enter them by hand."}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 shrink-0 w-full sm:w-auto">
            <Button
              variant="primary"
              onClick={() => setScanOpen(true)}
              className="w-full sm:w-auto"
            >
              {t("closeScanCta") || "Snap your Z-report"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => scrollToWizard({ manual: true })}
              className="w-full sm:w-auto"
            >
              {t("closeManualCta") || "Enter manually"}
            </Button>
          </div>
        </div>
      )}
      <SmartScanModal open={scanOpen} onClose={() => setScanOpen(false)} />

      <DismissibleTip
        id="daily-close-intro-v1"
        iconName="ClipboardList"
        title={t("whatIsDailyClose")}
      >
        <p>{t("dailyCloseTipBody")}</p>
      </DismissibleTip>

      {/* Tab bar */}
      <TabPills
        tabs={[
          { id: "close", label: t("newClose") || "New Close" },
          { id: "history", label: t("historyTab") || "History" },
          { id: "insights", label: t("insightsTab") || "Insights" },
          ...(hasMultiBranch ? [{ id: "branches", label: t("branches") || "Branches" }] : []),
        ]}
        activeId={tab}
        onChange={setTab}
        ariaLabel={t("dcTabsAriaLabel", "Daily close view")}
      />

      <div ref={closeWizardRef}>
        {tab === "close" && <CloseForm currency={currency} t={t} branchType={branchType} branchId={branchId} isOnline={isOnline}
          manualRequest={manualRequest}
          editDraft={editDraft}
          onEditConsumed={() => setEditDraft(null)}
          smartScanPrefill={smartScanPrefill}
          smartScanVerifyHints={smartScanVerifyHints}
          onSmartScanConsumed={() => { setSmartScanPrefill(null); setSmartScanVerifyHints([]); }}
          onDone={(lockResult) => {
            fetchHistory();
            fetchInsights();
            // Lane A — surface the lock result on the next view so the
            // user sees email-status feedback even though the form has
            // been replaced by the History tab.
            if (lockResult && lockResult.close_ritual) {
              setLastLockedClose(lockResult);
            }
            setTab("history");
          }}
          onQueued={() => { setPendingCount(getOfflineQueue().length); setTab("history"); }} />}
        {tab === "history" && <HistoryView data={history} currency={currency} t={t} onRefresh={fetchHistory} insights={insights}
          // #150 — the locked-today card now renders at the top of the
          // page (above LiveKpisToday). Don't render it inside History
          // too, otherwise the same banner shows twice. The History
          // tab keeps showing the in-list per-close summary as before.
          lastLockedClose={null}
          onDismissLastLocked={() => setLastLockedClose(null)}
          onEdit={(dc) => { setEditDraft(dc); setTab("close"); }} />}
        {tab === "insights" && <InsightsView data={insights} currency={currency} t={t} />}
        {tab === "branches" && <BranchSummaryView currency={currency} />}
      </div>
    </PageShell>
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

function CloseForm({ currency, t, branchType, branchId, onDone, onQueued, isOnline, editDraft, onEditConsumed, smartScanPrefill, smartScanVerifyHints, onSmartScanConsumed, manualRequest = 0 }) {
  const navigate = useNavigate();  // was undefined here → navigate("/connections") crashed (lines ~1029/1682)
  const { user, refreshUser } = useAuth();
  const { hasFeature, isReady: entReady } = useEntitlements();
  const defaultRevCats = useMemo(() => getRevenueCats(branchType), [branchType]);
  const defaultPayMethods = useMemo(() => getPaymentMethods(branchType), [branchType]);
  const config = CLOSE_CONFIG[branchType] || CLOSE_CONFIG.general;

  // Lane A — auto-email-on-lock preference. Mirrors user.auto_email_on_close
  // and writes through to /auth/profile when toggled. Starter+ feature;
  // shown locked for Free users with the upgrade nudge so the path
  // to Starter is one tap.
  //
  // Tier-flicker fix: tri-state `null | true | false`. While entitlements
  // are still loading we render NEITHER the unlocked toggle NOR the
  // locked "Upgrade to Starter" CTA — both would flash and disappear for
  // trial users (the bug Manoj reported). A subtle skeleton fills the
  // slot until the real entitlement lands ~150-300ms later.
  const closeAutoEmailEntitled = entReady ? hasFeature("close_auto_email") : null;
  const [autoEmailPref, setAutoEmailPref] = useState(
    user?.auto_email_on_close !== false,
  );
  // Keep the local state in sync when /auth/me reloads with a new value
  useEffect(() => {
    if (typeof user?.auto_email_on_close === "boolean") {
      setAutoEmailPref(user.auto_email_on_close);
    }
  }, [user?.auto_email_on_close]);

  const toggleAutoEmail = async () => {
    const next = !autoEmailPref;
    setAutoEmailPref(next);  // optimistic
    try {
      await api.patch("/auth/profile", { auto_email_on_close: next });
      refreshUser?.();
    } catch {
      // Rollback on failure — toggle is non-critical, fail silently
      setAutoEmailPref(!next);
    }
  };

  // VAT rate from user.currency — was hardcoded 0.25 (Danish only), which
  // was wrong for NPR (13%) / EUR_DE (19%) / GBP (20%) / USD (0%) etc.
  // Backend already uses _get_vat_rate(user.currency); this aligns the
  // on-screen preview with what gets persisted. RED finding from audit #127.
  const vatRate = getTaxConfig(user?.currency).rate;
  const vatRatePct = Math.round(vatRate * 100);
  const vatDivisor = 1 + vatRate;
  const vatName = getVatTerms(user?.currency).vatName || "VAT";

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
  // close_sanity soft guard — holds the anomaly payload when today's
  // total is far off the recent same-weekday baseline; drives the
  // "double-check before you lock" dialog. null = no warning pending.
  const [anomalyCheck, setAnomalyCheck] = useState(null);

  // Night shift: business date may differ from calendar date
  // DK-first default: 06:00 business-day cutoff (Europe/Copenhagen restaurant
  // convention) until the prefill returns the owner's real day_cutoff_hour.
  // Was 0 (midnight) → a late-night closer at 01:30 saw today pre-selected
  // and reconciled against the wrong day's sales.
  const [businessDate, setBusinessDate] = useState(() => getBusinessDate(6));
  const [cutoffHour, setCutoffHour] = useState(6);

  // Step 1: Revenue
  const [revCats, setRevCats] = useState(defaultRevCats);
  const [revAmounts, setRevAmounts] = useState({});
  // Computed category-split suggestion for multi-category verticals:
  //   { source: "history"|"none", confidence, sampleSize, categories }
  // Drives the honest "beregnet fordeling" header + the graceful first-time
  // hint. null = single-category vertical (no split UI). See the prefill effect.
  const [splitMeta, setSplitMeta] = useState(null);
  const [customRevName, setCustomRevName] = useState("");

  // Step 2: Payments
  const [payMethods, setPayMethods] = useState(defaultPayMethods);
  const [payAmounts, setPayAmounts] = useState({});

  // Step 3: Cash drawer
  const [cashCounted, setCashCounted] = useState("");
  // Register-derived expected cash (POS `kontant`/`cash` total for the
  // business day, from the /daily-close/prefill suggested_prefill block).
  // When present this is the REAL baseline for the drawer variance —
  // counted drawer vs what the register says was taken — instead of the
  // self-referential "typed cash vs counted cash". null = no synced
  // register figure for the date, fall back to the owner's typed entry.
  // Captured at prefill time so it survives the owner editing the cash
  // line on the payments step (editing payAmounts.cash must NOT move the
  // register baseline).
  const [registerCash, setRegisterCash] = useState(null);

  // Edit-resync guard. When the owner unlocks + edits an existing close
  // (editDraft), the [branchId, businessDate]-keyed prefill effect re-fires
  // because loading the draft sets businessDate. Without this flag the
  // sales-sync would call setPayAmounts/setRevAmounts and clobber the saved
  // breakdown with the day's raw sales totals (card 1850, "Expected cash 0
  // / +380 off"). A ref (not state) so it's set synchronously before the
  // prefill effect's async fetch resolves — the prefill still loads `prefill`
  // for the informational banner + expenses summary, it just won't overwrite
  // the owner's saved/entered breakdown.
  const editLoadedRef = useRef(false);

  // Step 4: Tips
  const [tipsTotal, setTipsTotal] = useState("");
  const [staffCount, setStaffCount] = useState("");

  // Phase A — per-archetype close fields.
  //   gavekortSold (salon) — gift cards SOLD today. Surfaced on its own line,
  //     EXCLUDED from the day-of-sale service MOMS base, flagged for the
  //     revisor (single- vs multi-purpose voucher MOMS is a judgment call we
  //     never auto-decide). Sent as forward-compat `gift_cards_sold` (the
  //     backend ignores unknown fields today) + summarised into notes.
  //   batchRef (bakery) — a Parti/Batch reference. Informational only; folded
  //     into notes for the revisor, never part of any MOMS computation.
  const [gavekortSold, setGavekortSold] = useState("");
  const [batchRef, setBatchRef] = useState("");

  // Step 5: Meta
  const [closedBy, setClosedBy] = useState("");
  const [notes, setNotes] = useState("");

  // Scan / OCR state — supports multiple photos
  const [scanMode, setScanMode] = useState("idle"); // idle | scanning | result | skipped

  // The page's "Enter manually" button raises manualRequest. Skipping straight
  // to step 1 is the whole point — otherwise the owner lands on the scan card
  // and has to decline scanning a second time. Guarded on "idle" so a scan in
  // flight ("scanning") or results awaiting review ("result") are never thrown
  // away by a stray tap.
  useEffect(() => {
    if (!manualRequest) return;
    if (scanMode === "idle") {
      setScanMode("skipped");
      setStep(1);
    }
  }, [manualRequest, scanMode]);
  const [scanResult, setScanResult] = useState(null);
  const [scanPhotos, setScanPhotos] = useState([]); // [{url, name}]
  // First scanned Z-report photo URL (Supabase signed URL or local path).
  // Persisted on the close row as receipt_photo so the owner can re-view
  // the source document later (Bogføringsloven §10 retention).
  const [receiptPhotoUrl, setReceiptPhotoUrl] = useState(null);

  // ─── POS terminal auto-detect — Commit 3 owner-confirm state ───────
  //
  // The Commit 2 amber chip (0.60-0.85 confidence band) is read-only.
  // Commit 3 adds two buttons inline: Confirm → POST link-provider,
  // Not-this-one → dismiss the chip locally (no API). The auto-linked
  // chip (≥ 0.85) gets a "Wrong terminal?" link that opens the unlink
  // dialog.
  //
  // chipDismissed — frontend-only dismissal of the chip. Per-scan; the
  //   next scan creates fresh detected_provider data and re-shows the
  //   chip if applicable. We DON'T persist this to localStorage —
  //   the chip is contextual ("we think THIS scan is from X"), not a
  //   user-wide preference.
  // chipConfirming — true while the link-provider POST is in flight.
  //   Disables both buttons + swaps the Confirm label to "Saving…" so
  //   the owner doesn't double-tap.
  // chipConfirmed — once the link succeeds, we swap the chip to its
  //   "Linked!" success state. Stays until the next scan replaces it.
  // chipLinkTarget — when the owner has 2+ unlinked terminals, the
  //   Confirm flow shows a dropdown so the owner picks which one. This
  //   holds the selected terminal_id; null/undefined = pick the only
  //   unlinked one if there's exactly 1.
  // terminalsForConfirm — list of terminals (from GET /terminals)
  //   needed for the dropdown. Fetched lazily on first chip render so
  //   we don't add an extra request to the page-load critical path.
  // conflictDismissed — frontend-only dismissal of the conflict tag.
  //   Same scoping as chipDismissed.
  // unlinkOpenForTerminalId — when the owner clicks "Wrong terminal?"
  //   on the auto-linked chip, this opens a tiny inline confirm dialog
  //   below the chip. null = closed. Strict string-compare against the
  //   target terminal_id so the dialog never opens on the wrong row.
  // unlinking — true while the unlink-provider POST is in flight.
  const [chipDismissed, setChipDismissed] = useState(false);
  const [chipConfirming, setChipConfirming] = useState(false);
  const [chipConfirmed, setChipConfirmed] = useState(false);
  const [chipLinkTarget, setChipLinkTarget] = useState("");
  const [terminalsForConfirm, setTerminalsForConfirm] = useState(null);
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const [unlinkOpenForTerminalId, setUnlinkOpenForTerminalId] = useState(null);
  const [unlinking, setUnlinking] = useState(false);
  const [chipError, setChipError] = useState("");

  // Prefill from an existing draft when the user clicked "Edit" in
  // History. Runs once when editDraft becomes non-null, then clears
  // via onEditConsumed so re-renders don't re-fill (which would clobber
  // the user's in-progress edits).
  useEffect(() => {
    if (!editDraft) return;
    const dc = editDraft;
    // Mark this as an existing-close edit so the sales-sync prefill (which
    // re-fires when we set businessDate below) does NOT clobber the saved
    // payment/revenue breakdown. See registerCash / editLoadedRef notes.
    editLoadedRef.current = true;
    if (dc.date) setBusinessDate(typeof dc.date === "string" ? dc.date.slice(0, 10) : dc.date);
    if (dc.revenue_breakdown) {
      const rev = {};
      Object.entries(dc.revenue_breakdown).forEach(([k, v]) => { rev[k] = String(v); });
      setRevAmounts(rev);
    }
    if (dc.payment_breakdown) {
      const pay = {};
      Object.entries(dc.payment_breakdown).forEach(([k, v]) => { pay[k] = String(v); });
      setPayAmounts(pay);
    }
    if (dc.cash_counted != null) setCashCounted(String(dc.cash_counted));
    // NOTE: registerCash (the "Expected (from register)" baseline) is NOT set
    // from the saved close here — a close row can't tell us whether its stored
    // cash_expected was register- or typed-derived. Instead the prefill effect
    // re-derives it from live Sale rows for this date (authoritative, and what
    // the backend will use on re-save), so the label stays honest on edit.
    if (dc.tips_total != null) setTipsTotal(String(dc.tips_total));
    if (dc.tips_staff_count != null) setStaffCount(String(dc.tips_staff_count));
    if (dc.closed_by) setClosedBy(dc.closed_by);
    if (dc.notes) setNotes(dc.notes);
    if (dc.receipt_photo) setReceiptPhotoUrl(dc.receipt_photo);
    // Skip scan UI (the user already has values) and jump to step 1.
    setScanMode("skipped");
    setStep(1);
    onEditConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editDraft]);

  // ─── Smart Scan prefill (kasserapport) ────────────────────────────
  // When SmartScanModal classifies a kasserapport, it navigates here
  // with the scan-report extraction in location.state. The DailyClose
  // page hands that payload down here as smartScanPrefill. We hydrate
  // the existing scanResult state from it — same shape the
  // /daily-close/scan-report endpoint returns — so the existing
  // mergeScans / applyScanValues / verify-this-amount UX is reused
  // without duplicating the wizard logic.
  //
  // L6 fail-closed: we DO NOT auto-apply the values into the steps;
  // we drop the owner at scanMode="result" so they see what we found,
  // can review, and tap "Use these" (existing affordance) to fill.
  const [smartScanVerifyState, setSmartScanVerifyState] = useState([]);
  useEffect(() => {
    if (!smartScanPrefill) return;
    // Hydrate the scanResult — backend extracted_data uses the same
    // schema as /daily-close/scan-report (the same service powers both).
    setScanResult(smartScanPrefill);
    setScanMode("result");
    setStep(1);
    setSmartScanVerifyState(Array.isArray(smartScanVerifyHints) ? smartScanVerifyHints : []);
    onSmartScanConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smartScanPrefill]);

  const [scanError, setScanError] = useState("");
  // "with-moms" | "without-moms" — owner picks before scan so the OCR
  // numbers are interpreted correctly. Most DK Z-reports show gross
  // amounts (with MOMS); some POS exports give net only. Defaults to
  // "with-moms" because it's the common case.
  const [scanMomsMode, setScanMomsMode] = useState("with-moms");
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
    // Rich Z-report fields — last scan wins (typical retake = better photo)
    if (incoming.prefill) merged.prefill = incoming.prefill;
    if (incoming.cash_denominations) merged.cash_denominations = incoming.cash_denominations;
    if (incoming.cash_counted_total != null) merged.cash_counted_total = incoming.cash_counted_total;
    if (incoming.per_clerk) merged.per_clerk = incoming.per_clerk;
    if (incoming.doc_type) merged.doc_type = incoming.doc_type;
    // Structured 3-tier payment view (headline / card_breakdown / adjustments)
    // for the detection-driven breakdown display. Last scan wins.
    if (incoming.payments_view) merged.payments_view = incoming.payments_view;
    // POS terminal auto-detect (Commit 2) — last scan wins. A re-scan
    // with a clearer header may flip the detection from null to a real
    // provider chip, so we always overwrite (including with null).
    if ("detected_provider" in incoming) {
      merged.detected_provider = incoming.detected_provider;
    }
    merged.raw_text = ((existing.raw_text || "") + "\n---\n" + (incoming.raw_text || "")).slice(0, 2000);
    merged.ocr_available = true;
    const allVals = [...Object.values(merged.revenue || {}), ...Object.values(merged.payments || {}), merged.tips, merged.moms_total, merged.revenue_total];
    const found = allVals.filter(v => v != null).length;
    merged.confidence = found >= 3 ? "high" : found >= 1 ? "medium" : "low";
    return merged;
  };

  const handleFileSelect = async (rawFile) => {
    if (!rawFile) return;
    setScanMode("scanning");
    setScanError("");
    // Commit 3 — reset per-scan chip + conflict state so the new scan's
    // detection feedback shows fresh (a previous "Not this one" dismiss
    // shouldn't suppress the next scan's chip).
    setChipDismissed(false);
    setChipConfirmed(false);
    setChipError("");
    setUnlinkOpenForTerminalId(null);
    setConflictDismissed(false);
    try {
      // Auto-resize iPhone-sized photos (48 MP camera shots routinely
      // exceed our 12 MB backend cap). 2000 px long edge keeps OCR
      // text crisp + uploads stay fast on 4G in restaurant kitchens.
      const file = await resizeImageIfLarge(rawFile);
      const formData = new FormData();
      formData.append("file", file);
      const res = await api.post("/daily-close/scan-report", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      // Add thumbnail (use the resized file so the preview matches what
      // the backend actually saw)
      const thumbUrl = URL.createObjectURL(file);
      setScanPhotos(prev => [...prev, { url: thumbUrl, name: file.name }]);
      // Merge with existing results
      setScanResult(prev => mergeScans(prev, res.data));
      // Capture the durable storage URL — first scan wins so editing
      // a draft and re-scanning doesn't churn the persisted reference.
      if (res.data?.image_url && !receiptPhotoUrl) {
        setReceiptPhotoUrl(res.data.image_url);
      }
      setScanMode("result");
    } catch (err) {
      setScanError(errText(err, "OCR scanning failed. Please enter values manually."));
      setScanMode(scanResult ? "result" : "idle"); // keep results if we already have some
    }
  };

  // ─── Commit 3 — chip action handlers ────────────────────────────────
  //
  // Owner-facing buttons on the auto-detect chip. All API calls are
  // optimistic on the UI side (loading spinner during the request,
  // error toast on failure) but never crash the page — failure leaves
  // the chip visible so the owner can retry.
  //
  // ensureTerminalsLoaded: lazy-fetch the user's terminals the first
  //   time the Confirm flow needs them. We use GET /api/terminals which
  //   now returns provider_id / provider_locked_by_owner / display_name
  //   per terminal (extended schema, Commit 3 schema update). Cached in
  //   `terminalsForConfirm` state so a second Confirm tap is instant.
  const ensureTerminalsLoaded = async () => {
    if (Array.isArray(terminalsForConfirm)) return terminalsForConfirm;
    try {
      const res = await api.get("/terminals");
      const list = Array.isArray(res?.data) ? res.data : [];
      setTerminalsForConfirm(list);
      return list;
    } catch {
      // L8 graceful — if the terminals list fails to load we still
      // surface the chip; the Confirm button just stays disabled with
      // an inline error message until the request succeeds.
      setTerminalsForConfirm([]);
      return [];
    }
  };

  // Compute the target terminal for the Confirm flow.
  // Returns:
  //   { terminalId: "<uuid>" }       — unique unlinked terminal exists,
  //                                    auto-pick it.
  //   { terminalId: chipLinkTarget } — owner picked from dropdown.
  //   { needsPicker: true, choices } — 2+ unlinked, need a dropdown.
  //   { error: "no_unlinked" }       — 0 unlinked terminals (the silent-
  //                                    link path would have already
  //                                    fired, or every terminal is
  //                                    locked elsewhere).
  const resolveConfirmTarget = (terms) => {
    const unlinked = (terms || []).filter(
      (t) => !t.provider_id && t.is_active !== false,
    );
    if (chipLinkTarget) {
      const picked = (terms || []).find((t) => t.id === chipLinkTarget);
      if (picked) return { terminalId: picked.id };
    }
    if (unlinked.length === 1) return { terminalId: unlinked[0].id };
    if (unlinked.length >= 2) return { needsPicker: true, choices: unlinked };
    // 0 unlinked: surface ALL terminals so the owner can override an
    // existing (non-locked) link. Locked terminals stay clickable —
    // the backend will set lock=true on the new provider; the owner
    // is asserting authority by clicking Confirm here.
    if ((terms || []).length >= 2) return { needsPicker: true, choices: terms };
    if ((terms || []).length === 1) return { terminalId: terms[0].id };
    return { error: "no_terminals" };
  };

  const handleConfirmDetectedProvider = async () => {
    const dp = scanResult?.detected_provider;
    if (!dp || chipConfirming) return;
    setChipError("");
    const terms = await ensureTerminalsLoaded();
    const target = resolveConfirmTarget(terms);
    if (target.needsPicker) {
      // Render path will show the dropdown — caller re-clicks Confirm
      // once a terminal is picked.
      if (!chipLinkTarget) {
        setChipError(t("detectedTerminalPickTarget",
          "Pick which terminal this is:"));
        return;
      }
    }
    if (target.error === "no_terminals") {
      setChipError(t("detectedTerminalNoTerminals",
        "No terminals yet — add one in Settings first."));
      return;
    }
    const targetId = target.terminalId || chipLinkTarget;
    if (!targetId) {
      setChipError(t("detectedTerminalPickTarget",
        "Pick which terminal this is:"));
      return;
    }
    setChipConfirming(true);
    try {
      // Find the provider catalog row from the list endpoint. We could
      // skip this if the backend returned a provider_id in the chip
      // payload — it DID. The Commit 2 chip includes slug + display_name,
      // and we need provider_id (UUID) for the body. Look it up via
      // /api/terminals/terminal-providers (Commit 3 endpoint).
      let providerId = dp.provider_id;
      if (!providerId) {
        try {
          const pr = await api.get("/terminals/terminal-providers");
          const match = (pr?.data?.providers || []).find(
            (p) => p.slug === dp.slug,
          );
          providerId = match?.id;
        } catch {
          // fall through — handled below
        }
      }
      if (!providerId) {
        setChipError(t("detectedTerminalCatalogMissing",
          "Could not find this provider in the catalog. Try again."));
        return;
      }
      await api.post(`/terminals/${targetId}/link-provider`, {
        provider_id: providerId,
        confidence: dp.confidence,
      });
      setChipConfirmed(true);
      // Refresh local terminal cache so the dropdown shows the new
      // linked state on the next Confirm. Cheap — one GET per click is
      // fine here; this is not a hot path.
      setTerminalsForConfirm(null);
    } catch (err) {
      setChipError(errText(err,
        t("detectedTerminalConfirmError",
          "Could not save the link. Please try again.")));
    } finally {
      setChipConfirming(false);
    }
  };

  const handleDismissChip = () => {
    setChipDismissed(true);
  };

  // Unlink flow — owner clicked "Wrong terminal?" on the auto-linked
  // chip. We need to figure out WHICH terminal was auto-linked. The
  // chip payload doesn't carry the terminal_id (Commit 2 didn't include
  // it), so we resolve it from the terminals list: the auto-linked
  // terminal is the only one with provider_slug === dp.slug AND
  // provider_locked_by_owner === false. If we can't resolve uniquely,
  // bounce the owner to /connections#terminals where they have a
  // clearer per-terminal UI.
  const handleUnlinkAutoLinked = async () => {
    const dp = scanResult?.detected_provider;
    if (!dp) return;
    setChipError("");
    const terms = await ensureTerminalsLoaded();
    const candidates = (terms || []).filter(
      (term) =>
        term.provider_slug === dp.slug &&
        term.provider_locked_by_owner === false &&
        term.is_active !== false,
    );
    if (candidates.length === 1) {
      setUnlinkOpenForTerminalId(candidates[0].id);
    } else {
      // Ambiguous — punt to the Connections page where each terminal
      // has its own Unlink button.
      navigate("/connections");
    }
  };

  const handleConfirmUnlink = async () => {
    if (!unlinkOpenForTerminalId || unlinking) return;
    setUnlinking(true);
    try {
      await api.post(`/terminals/${unlinkOpenForTerminalId}/unlink-provider`);
      // Hide the chip post-unlink — provider link is now gone, so the
      // chip's "auto-linked" claim is no longer true.
      setChipDismissed(true);
      setUnlinkOpenForTerminalId(null);
      setTerminalsForConfirm(null);
    } catch (err) {
      setChipError(errText(err,
        t("detectedTerminalUnlinkError",
          "Could not unlink. Please try again.")));
    } finally {
      setUnlinking(false);
    }
  };

  const handleDismissConflict = () => {
    setConflictDismissed(true);
  };

  // Lazy-fetch terminals the first time a chip OR a conflict appears.
  // We need this for two reasons:
  //   1. The Confirm dropdown needs to know how many unlinked terminals
  //      exist before the owner clicks (so the dropdown / single-target
  //      branch is correct on first render).
  //   2. The "Wrong terminal?" unlink flow needs to resolve which
  //      terminal was auto-linked.
  // Single-shot — once `terminalsForConfirm` is an array (even empty),
  // skip subsequent fetches. Cleared back to null by handleFileSelect /
  // handleConfirmDetectedProvider / handleConfirmUnlink so stale state
  // doesn't survive a re-scan or post-mutation.
  useEffect(() => {
    if (
      !scanResult ||
      (!scanResult.detected_provider && !scanResult.conflict)
    ) {
      return;
    }
    if (Array.isArray(terminalsForConfirm)) return;
    let alive = true;
    api
      .get("/terminals")
      .then((res) => {
        if (!alive) return;
        setTerminalsForConfirm(Array.isArray(res?.data) ? res.data : []);
      })
      .catch(() => {
        if (!alive) return;
        // L8 graceful — leave as [] so the confirm-button error branch
        // surfaces a clean message instead of an infinite spinner.
        setTerminalsForConfirm([]);
      });
    return () => {
      alive = false;
    };
  }, [scanResult, terminalsForConfirm]);

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
    // Fill tips (only for types that have tips). Z-reports often show
    // tips as negative (paid out) — keep the sign for accountant clarity.
    if (config.hasTips && scanResult.tips) setTipsTotal(String(scanResult.tips));
    // If OCR detected MOMS, switch to manual mode with the scanned value
    if (scanResult.moms_total) {
      setMomsMode("manual");
      setMomsManual(String(scanResult.moms_total));
    }
    // ── Z-report specialized prefill (Part D) ───────────────────────
    // When the backend ran the kasserapport-specialized extractor it
    // returns a `prefill` block with cash-drawer counts, per-clerk
    // earnings, and the full payment-method split. Pre-populate the
    // cash-drawer step and drop the clerk summary into notes so the
    // owner spots schedule mismatches before locking the close.
    const pf = scanResult.prefill;
    if (pf) {
      // Step 3 — Cash drawer counted total (from denomination math)
      if (pf.cash_drawer?.counted_total != null) {
        setCashCounted(String(pf.cash_drawer.counted_total));
      }
      // Notes — per-clerk earnings + any kasserapport notes
      const noteParts = [];
      if (pf.per_clerk_notes) noteParts.push(pf.per_clerk_notes);
      if (scanResult.claude_notes) noteParts.push(scanResult.claude_notes);
      if (noteParts.length > 0) {
        setNotes(prev => prev ? prev + "\n" + noteParts.join("\n") : noteParts.join("\n"));
      }
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
        // branch_type lets the backend resolve THIS vertical's revenue category
        // keys for the computed split (restaurant food/drinks/takeaway, etc.).
        if (branchType) params.branch_type = branchType;
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
          // Register-derived expected cash for the drawer variance — the REAL
          // baseline: counted drawer vs what the till says was taken, not the
          // self-referential typed-cash figure. Register is authoritative
          // whenever the day has completed sales (a synced POS register exists
          // to compare against). suggested_prefill.cash_expected is the POS
          // cash total — backend prefill's by_payment.get("cash") — and is 0
          // when there were card-only sales (still a real "register says 0
          // cash" baseline). When the day has NO sales (manual / cash-only
          // closer), we leave registerCash null → graceful fall back to the
          // owner's typed cash line on the payments step.
          //
          // Runs on BOTH new and edited closes (NOT gated by editLoadedRef):
          // it's a read that re-confirms the authoritative register for the
          // date, mirrors the backend's _register_cash_for_date rule exactly
          // (so the on-screen "Expected (from register)" figure always agrees
          // with the persisted cash_difference), and never touches the saved
          // payment/revenue breakdown the edit guard protects below.
          {
            const salesCount = Number(res.data.sales?.count || 0);
            const regCash = res.data.suggested_prefill?.cash_expected;
            setRegisterCash(
              salesCount > 0 && regCash != null ? Number(regCash) : null,
            );
          }
          // Auto-fill payment methods + revenue from sales data — but ONLY
          // for a brand-new close. When the owner unlocked + is editing an
          // existing close (editLoadedRef), this sales-sync would clobber the
          // saved breakdown (e.g. cash 400/card 500/mp 170 → card 1850), so
          // we skip the writes. `prefill` is still set above so the
          // informational sync banner + expenses summary keep rendering.
          if (!editLoadedRef.current) {
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
                    return [...prev, { key: k, label: k.charAt(0).toUpperCase() + k.slice(1), icon: "Coins" }];
                  });
                }
              });
              setPayAmounts(newPay);
            }
            // Revenue prefill. Single-category verticals get the whole total in
            // the one category. Multi-category verticals get an HONEST computed
            // split ("beregnet fordeling") from the owner's own historical mix
            // when the backend has enough confirmed closes — the owner confirms
            // or corrects (confirm-and-correct). When there's no signal we leave
            // categories BLANK and show a calm one-liner (never invent a split).
            const salesTotal = res.data.suggested_prefill?.revenue_total || 0;
            const split = res.data.category_split;
            if (defaultRevCats.length === 1 || branchType === "general") {
              const firstCat = defaultRevCats[0]?.key;
              if (salesTotal > 0 && firstCat) setRevAmounts({ [firstCat]: String(salesTotal) });
              setSplitMeta(null);
            } else if (split && split.categories && Object.keys(split.categories).length > 0) {
              const next = {};
              Object.entries(split.categories).forEach(([k, v]) => { next[k] = String(v); });
              setRevAmounts(next);
              setSplitMeta({
                source: split.source,
                confidence: split.confidence,
                sampleSize: split.sample_size,
                categories: split.categories,
              });
            } else {
              // Multi-category vertical with not enough history → blank fields +
              // a calm first-time hint (splitMeta.source === "none").
              setSplitMeta({ source: "none" });
            }
          }
        }
      } catch {
        // Silent — manual entry still works
      }
      setPrefillLoading(false);
    };
    fetchPrefill();
  }, [branchId, branchType, businessDate]);

  const revenueTotal = useMemo(() => Object.values(revAmounts).reduce((s, v) => s + (parseFloat(v) || 0), 0), [revAmounts]);
  const paymentTotal = useMemo(() => Object.values(payAmounts).reduce((s, v) => s + (parseFloat(v) || 0), 0), [payAmounts]);
  const balanceDiff = revenueTotal - paymentTotal;
  // Expected cash baseline for the drawer variance. Prefer the SYNCED POS
  // register cash (what the till says was taken) over the owner's typed cash
  // line — typed-vs-counted is self-referential and can't surface a real
  // shortage/theft. registerCash is null when no POS cash figure exists for
  // the date, in which case we fall back to the typed entry. The variance
  // math (counted − expected) and the persisted cash_difference are unchanged
  // — only the baseline source moves.
  const typedCash = parseFloat(payAmounts.cash || 0);
  const cashExpectedFromRegister = registerCash != null && !Number.isNaN(registerCash);
  const cashExpected = cashExpectedFromRegister ? registerCash : typedCash;
  const cashCountedVal = parseFloat(cashCounted || 0);
  const cashDiff = cashCounted ? cashCountedVal - cashExpected : null;
  const tipsPP = tipsTotal && staffCount && parseInt(staffCount) > 0
    ? Math.round(parseFloat(tipsTotal) / parseInt(staffCount)) : null;

  // ─── Tax-exempt awareness ──────────────────────────────────────────
  // Today's MOMS calc used to roll ALL revenue into the taxable base,
  // which double-counts gift cards, B2B reverse-charge, EU export, and
  // §13 nr.17 charitable events as MOMS-liable. Those rows already exist
  // in the Sale table with `is_tax_exempt=true` (see commit 8fce2ef for
  // the MOMS PDF fix). Here we pull the exempt total for the same
  // business day from `/property-report` and subtract it from the
  // taxable base so the close screen agrees with what eventually lands
  // on the SKAT MOMS-angivelse PDF.
  //
  // `/property-report` returns both `totals.total_revenue` (includes
  // exempt) and `totals.taxable_sales` (excludes exempt) — the
  // difference is the exempt total we want to show. Self-contained
  // fetch: keeps the existing /daily-close/prefill path untouched so
  // the close wizard still loads even if this call fails.
  const [exemptSalesTotal, setExemptSalesTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchExempt = async () => {
      try {
        const params = { date: businessDate, day_cutoff_hour: cutoffHour };
        if (branchId) params.branch_id = branchId;
        const res = await api.get("/property-report", { params });
        if (cancelled) return;
        const totals = res?.data?.totals || {};
        const totalRev = Number(totals.total_revenue || 0);
        const taxable = Number(totals.taxable_sales || 0);
        // Clamp at 0 — a corrupted server response should never let a
        // negative exempt total flow into the MOMS math. Round to 2dp
        // because the prop is displayed in money cells.
        const exempt = Math.max(0, Math.round((totalRev - taxable) * 100) / 100);
        setExemptSalesTotal(exempt);
      } catch {
        // Silent — falls back to "no exempt rows known", which is
        // strictly worse than perfect but still better than blocking
        // the close wizard. The headline MOMS calc just won't be
        // exempt-aware until refresh.
        if (!cancelled) setExemptSalesTotal(0);
      }
    };
    fetchExempt();
    return () => { cancelled = true; };
  }, [businessDate, branchId, cutoffHour]);

  // MOMS / VAT — toggle between auto-calc and manual entry from receipt
  const [momsMode, setMomsMode] = useState("auto"); // "auto" | "manual"
  const [momsManual, setMomsManual] = useState("");

  // Taxable base = entered revenue MINUS today's exempt sales total.
  // Clamp at 0: if the user only entered a placeholder and the exempt
  // total exceeds it, we'd otherwise show a negative MOMS amount which
  // confuses the owner more than a zero.
  const taxableBase = useMemo(() => {
    return Math.max(0, Math.round((revenueTotal - exemptSalesTotal) * 100) / 100);
  }, [revenueTotal, exemptSalesTotal]);

  const momsTotal = useMemo(() => {
    if (momsMode === "manual") return parseFloat(momsManual) || 0;
    if (scanResult?.moms_total) return scanResult.moms_total;
    return taxableBase > 0 && vatRate > 0 ? Math.round((taxableBase * vatRate / vatDivisor) * 100) / 100 : 0;
  }, [momsMode, momsManual, scanResult, taxableBase]);
  const revenueExMoms = useMemo(() => Math.round((revenueTotal - momsTotal) * 100) / 100, [revenueTotal, momsTotal]);

  const addCustomRevCat = () => {
    if (!customRevName.trim()) return;
    const key = customRevName.toLowerCase().replace(/\s+/g, "_");
    if (!revCats.find(c => c.key === key)) {
      setRevCats([...revCats, { key, label: customRevName, icon: "Tag" }]);
    }
    setCustomRevName("");
  };

  // Build payload used by both auto-save and final submit
  const buildPayload = (status = "confirmed") => {
    const revenue_breakdown = {};
    revCats.forEach(c => { if (revAmounts[c.key]) revenue_breakdown[c.key] = parseFloat(revAmounts[c.key]); });
    const payment_breakdown = {};
    payMethods.forEach(m => { if (payAmounts[m.key]) payment_breakdown[m.key] = parseFloat(payAmounts[m.key]); });

    // Always forward the OCR'd total as override when one was detected.
    // Backend uses max(breakdown_sum, override) so:
    //   • all 3 cats filled fully → sum == override → either path = same
    //     number, no harm done
    //   • partial breakdown (e.g. Drinks=1.82 wrong-parse,
    //     Food/Takeaway empty) → override wins → close saves real total
    //   • user manually exceeded the override → sum wins → user-driven
    //     edits take precedence over the OCR original
    // Sending it always (instead of only-when-empty) is what makes the
    // "skip — total saves correctly either way" banner promise true.
    const ocrTotal = scanResult?.revenue_total;
    const revenue_total_override = ocrTotal && ocrTotal > 0
      ? Number(ocrTotal)
      : null;
    // Only override when the user actually scanned with the toggle —
    // otherwise leave null and let the user's account-level
    // prices_include_moms preference apply.
    const prices_include_moms_override = scanMode === "skipped" || scanMode === "result"
      ? scanMomsMode === "with-moms"
      : null;
    // Phase A — fold the per-archetype extra fields into a revisor-readable
    // note suffix so they survive on the close row + the revisor PDF even
    // before the backend grows dedicated columns. Gavekort is explicitly
    // marked as EXCLUDED from the MOMS base (never auto-decided).
    const extraNoteParts = [];
    const gavekortNum = gavekortSold ? parseFloat(gavekortSold) : 0;
    if (gavekortNum > 0) {
      extraNoteParts.push(
        `Gavekort solgt: ${gavekortNum.toLocaleString()} ${currency} (uden for dagens moms-grundlag — vurderes af revisor).`,
      );
    }
    if (config.hasBatch && batchRef.trim()) {
      extraNoteParts.push(`Parti/Batch: ${batchRef.trim()}.`);
    }
    const notesWithExtras = [notes, ...extraNoteParts].filter(Boolean).join("\n") || null;

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
      notes: notesWithExtras,
      // Phase A forward-compat fields — the backend ignores unknown keys today
      // (Pydantic v2 default), so these are safe to send and become available
      // the moment DailyCloseCreate grows columns. Gavekort is deliberately a
      // SEPARATE field, never merged into revenue_breakdown (which feeds MOMS).
      gift_cards_sold: gavekortNum > 0 ? gavekortNum : null,
      batch_ref: (config.hasBatch && batchRef.trim()) ? batchRef.trim() : null,
      // Z-report photo URL — backend stores on DailyClose.receipt_photo.
      // Only sent if the owner actually scanned a photo this session;
      // null preserves the existing value on update (server-side guard).
      receipt_photo: receiptPhotoUrl || null,
      // Total-only fallback (banner-driven) and per-close MOMS-mode
      // override. Both are accepted by the backend in DailyCloseCreate.
      revenue_total_override,
      prices_include_moms_override,
      // Tax-exempt total for the day. Pydantic schemas/daily_close.py
      // does NOT accept this field yet — sending it is forward-compat
      // for when the audit row + MOMS PDF want to display the split.
      // Until the schema is extended, FastAPI ignores unknown fields
      // (Pydantic v2 default), so this is safe to send today.
      exempt_sales_total: exemptSalesTotal || null,
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

  // Final submit — locks the close (with offline queue fallback).
  // opts.acknowledgeAnomaly=true is passed by the "Yes, lock it" button
  // in the close_sanity double-check dialog to skip the guard and commit.
  const handleSubmit = async (opts = {}) => {
    setSaving(true);
    setError("");
    const payload = buildPayload("confirmed");
    if (opts.acknowledgeAnomaly) payload.acknowledge_anomaly = true;

    if (!navigator.onLine) {
      addToOfflineQueue(payload);
      setSaving(false);
      onQueued?.();
      return;
    }

    try {
      const resp = await api.post("/daily-close", payload);
      // Detective control — when today's total is far off the recent
      // same-weekday baseline the backend returns this (and saves
      // NOTHING) instead of a close. Surface the soft "double-check"
      // dialog; the owner fixes the numbers or confirms to lock anyway.
      if (resp?.data?.requires_confirmation) {
        setAnomalyCheck(resp.data.anomaly || {});
        setSaving(false);
        return;
      }
      setAnomalyCheck(null);
      // Sealed — one success haptic on a genuine confirmed lock. Native-only
      // (no-op on web); the offline-queue + anomaly paths returned above, so
      // this fires exactly once per real lock, never on draft/queue/validation-fail.
      if (payload.status === "confirmed") haptic.success();
      trackEvent(
        payload.status === "draft" ? "daily_close_draft_saved" : "daily_close_completed",
        "daily-close",
        payload.report_date || null
      );
      // Lane A — bubble the lock response (including close_ritual)
      // up to the parent so the locked-state card on History can
      // render the email status + bank-drop reminder + push status.
      onDone(resp?.data || null);
      // A confirmed close is the canonical per-date revenue (resolver prefers
      // it over raw sales), so tell any mounted Dashboard/Reports to refetch —
      // otherwise an already-open tab shows pre-close numbers until reload.
      if (payload.status === "confirmed") {
        window.dispatchEvent(new Event("bonbox-data-changed"));
      }
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

  const inputClass = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-400 text-right text-lg";
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
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      {/* ─── Close anomaly double-check (close_sanity soft guard) ───
          Shown when today's total is far off the recent same-weekday
          baseline — catches a misread Z-report total before it locks. */}
      {anomalyCheck && (() => {
        const pct = Math.abs(Math.round((anomalyCheck.delta_pct || 0) * 100));
        const today = Math.round(anomalyCheck.today_total || 0).toLocaleString("da-DK");
        const avg = Math.round(anomalyCheck.baseline_avg || 0).toLocaleString("da-DK");
        const msgKey = anomalyCheck.reason === "high" ? "closeAnomalyHighMsg" : "closeAnomalyLowMsg";
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full p-5 sm:p-6 animate-fadeIn">
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center"><Icon name="AlertTriangle" size={20} className="text-amber-600 dark:text-amber-400" /></div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white">{t("closeAnomalyTitle")}</h3>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{t(msgKey, { today, pct, avg })}</p>
                  <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{t("closeAnomalyHint")}</p>
                </div>
              </div>
              <div className="mt-5 flex gap-3 justify-end">
                <Button variant="secondary" onClick={() => setAnomalyCheck(null)} disabled={saving}>
                  {t("closeAnomalyCancel")}
                </Button>
                <Button variant="accent" onClick={() => handleSubmit({ acknowledgeAnomaly: true })} disabled={saving}>
                  {saving ? "…" : t("closeAnomalyConfirm")}
                </Button>
              </div>
            </div>
          </div>
        );
      })()}
      {/* Progress bar */}
      <div className="flex">
        {showScanUI ? (
          <div className="flex-1 h-1.5 bg-gray-50 dark:bg-gray-800/50 animate-pulse" />
        ) : (
          Array.from({ length: totalSteps }, (_, i) => i + 1).map(s => (
            <div key={s} className={`flex-1 h-1.5 ${s <= step ? "bg-emerald-500" : "bg-gray-200 dark:bg-gray-700"} transition-colors`} />
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
            <div className="rounded-xl p-6 text-center"
              style={{ background: "linear-gradient(135deg, #059669 0%, #10b981 50%, #34d399 100%)" }}>
              <div className="flex justify-center mb-3"><Icon name="Image" size={36} className="text-white" /></div>
              <h2 className="text-xl font-bold text-white mb-1">{t("scanZReportTitle", "Scan your Z-report / kasserapport")}</h2>
              <p className="text-gray-100 text-sm mb-5">
                {t("scanZReportBody", "Take photos or upload images of your Z-report — add multiple pages and we'll merge the results.")}
              </p>
              <div className="flex flex-wrap gap-3 justify-center sm:flex-nowrap">
                <button
                  onClick={() => { if (fileInputRef.current) { fileInputRef.current.setAttribute("capture", "environment"); fileInputRef.current.click(); } }}
                  className="px-5 py-2.5 bg-white text-gray-700 rounded-xl font-semibold shadow-sm hover:shadow-sm transition text-sm inline-flex items-center gap-1.5">
                  <Icon name="Image" size={16} /> {t("takePhoto", "Take Photo")}
                </button>
                <button
                  onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
                  className="px-5 py-2.5 bg-white/20 text-white border border-white/40 rounded-xl font-semibold hover:bg-white/30 transition text-sm inline-flex items-center gap-1.5">
                  <Icon name="FolderOpen" size={16} /> {t("uploadImage", "Upload Image")}
                </button>
              </div>
              {/* MOMS / VAT toggle — owner picks before scan so OCR'd
                  numbers are interpreted right. Most DK Z-reports are
                  gross (with MOMS); B2B / Excel exports may be net.
                  Uses currency-aware `vatName` so a Nepali user sees
                  "with VAT (gross)" and a Danish user sees "with Moms
                  (gross)" — fixes the #148 MEDIUM-10 mix where this
                  block hardcoded "MOMS" while siblings used `vatName`. */}
              <div className="mt-4 flex flex-wrap items-center gap-2 justify-center sm:flex-nowrap">
                <span className="text-xs text-gray-100">{t("receiptAmountsAre", "Receipt amounts are:")}</span>
                <button
                  onClick={() => setScanMomsMode("with-moms")}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                    scanMomsMode === "with-moms"
                      ? "bg-white text-gray-700 shadow"
                      : "bg-white/10 text-white hover:bg-white/20"
                  }`}>
                  {t("withVatGross", "with {vat} (gross)", { vat: vatName })}
                </button>
                <button
                  onClick={() => setScanMomsMode("without-moms")}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                    scanMomsMode === "without-moms"
                      ? "bg-white text-gray-700 shadow"
                      : "bg-white/10 text-white hover:bg-white/20"
                  }`}>
                  {t("withoutVatNet", "without {vat} (net)", { vat: vatName })}
                </button>
              </div>
            </div>
            {/* Upload zone */}
            <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-6 text-center cursor-pointer hover:border-gray-300 dark:hover:border-gray-300 transition-colors"
              onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
              onDragOver={e => e.preventDefault()}
              onDrop={async e => { e.preventDefault(); const files = Array.from(e.dataTransfer.files || []); for (const f of files) await handleFileSelect(f); }}>
              <p className="text-gray-400 dark:text-gray-500 text-sm">
                {t("dragDropZReport", "Drag & drop your Z-report images here, or click to browse")}
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
                {t("skipEnterManually", "Skip — enter manually")}
              </button>
            </div>
          </div>
        )}

        {/* ─── SCANNING SPINNER ─── */}
        {scanMode === "scanning" && (
          <div className="py-12 text-center space-y-4">
            <div className="inline-block w-10 h-10 border-4 border-gray-100 border-t-green-600 rounded-full animate-spin" />
            <p className="text-gray-600 dark:text-gray-300 font-medium">{t("readingZReport", "Reading your Z-report…")}</p>
            <p className="text-sm text-gray-400">{t("ocrExtractingData", "OCR is extracting revenue, payments, and {vat} data", { vat: vatName })}</p>
          </div>
        )}

        {/* ─── SCAN RESULT CARD ─── */}
        {scanMode === "result" && scanResult && (
          <div className="space-y-5">
            {/* ─── Conflict warning — Commit 3 ──────────────────────────
                Fires when the scan's detected provider disagrees with a
                terminal the owner has LOCKED to a different provider.
                Rendered ABOVE the prefill fields (per L6 fail-closed
                doctrine — owner sees the dispute first, decides
                whether to trust the scan).
                  • Backend never silently overwrites a locked terminal.
                  • Dismissing the tag is local-only; the audit row is
                    already written backend-side. */}
            {scanResult.conflict && !conflictDismissed && (() => {
              const cf = scanResult.conflict;
              return (
                <div className="rounded-xl p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-100">
                  <div className="font-medium flex items-center gap-1.5">
                    <Icon name="AlertTriangle" size={16} />
                    {t(
                      "terminalConflictTitle",
                      "Terminal mismatch detected",
                    )}
                  </div>
                  <div className="text-xs opacity-90 mt-1 leading-relaxed">
                    {t("terminalConflictBody", {
                      detected: cf.detected?.display_name || "",
                      current: cf.current?.display_name || "",
                    })}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleDismissConflict}
                      className="text-[12px] px-2.5 py-1 rounded-md bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100 hover:bg-amber-50 dark:hover:bg-amber-900/40 transition"
                    >
                      {t("terminalConflictDismiss", "Looks fine")}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate("/connections")}
                      className="text-[12px] px-2.5 py-1 rounded-md bg-amber-900 dark:bg-amber-100 text-white dark:text-amber-900 hover:bg-amber-800 dark:hover:bg-amber-200 transition"
                    >
                      {t("terminalConflictReview", "Review in Settings")}
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* ─── POS terminal auto-detect chip — Commit 2 + Commit 3 ───
                Renders when the backend's deterministic provider matcher
                identified the acquirer (Nets, Worldline, MobilePay, ...)
                from the receipt header/footer.
                  • auto_linked  → subtle gray, "linked automatically",
                                    + tiny "Wrong terminal?" link
                                    (Commit 3 unlink dialog).
                  • 0.60-0.85    → amber, "we think this is your X
                                    terminal" + Confirm / Not-this-one
                                    buttons (Commit 3 confirm UX).
                  • < 0.60       → backend returns null, no chip. */}
            {scanResult.detected_provider && !chipDismissed && (() => {
              const dp = scanResult.detected_provider;
              const autoLinked = !!dp.auto_linked;
              // After Confirm succeeds the amber chip swaps to the gray
              // "linked" treatment with a tiny check icon — visual
              // confirmation that the link landed without forcing the
              // owner to scroll up to a toast.
              const showAsLinked = autoLinked || chipConfirmed;
              const styleCls = showAsLinked
                ? "rounded-xl p-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/40 text-sm text-gray-900 dark:text-gray-100"
                : "rounded-xl p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200";
              // Confirm button states for the 0.60-0.85 amber band:
              //   • If 2+ unlinked terminals exist and the owner hasn't
              //     picked yet, render a tiny inline dropdown.
              //   • If 1 unlinked or owner has picked, render Confirm.
              const terms = terminalsForConfirm || [];
              const unlinkedCount = terms.filter(
                (t) => !t.provider_id && t.is_active !== false,
              ).length;
              const needsPicker =
                Array.isArray(terminalsForConfirm) &&
                unlinkedCount >= 2 &&
                !chipLinkTarget;

              return (
                <div className={styleCls}>
                  <div className="font-medium flex items-center gap-1.5">
                    <Icon
                      name={chipConfirmed ? "Check" : "Cpu"}
                      size={16}
                    />
                    {chipConfirmed
                      ? t(
                          "detectedTerminalLinkedConfirmed",
                          "Terminal confirmed: {provider}",
                          { provider: dp.display_name },
                        )
                      : `${t("detectedTerminalTitle")}: ${dp.display_name}`}
                  </div>
                  {showAsLinked && !chipConfirmed && (
                    <div className="text-xs opacity-80 mt-0.5">
                      {t("detectedTerminalAutoLinked")}
                    </div>
                  )}
                  {!showAsLinked && (
                    <div className="text-xs opacity-90 mt-0.5">
                      {t("detectedTerminalConfirmHint", {
                        provider: dp.display_name,
                      })}
                    </div>
                  )}

                  {/* Action row — Commit 3.
                      Amber chip (0.60-0.85, not yet confirmed): Confirm + Not-this-one.
                      Auto-linked chip: small "Wrong terminal?" link.
                      Post-confirm: no buttons (chip is in success state). */}
                  {!chipConfirmed && !showAsLinked && (
                    <div className="mt-2 space-y-2">
                      {needsPicker && (
                        <div>
                          <label className="block text-[11px] opacity-80 mb-1">
                            {t(
                              "detectedTerminalPickTarget",
                              "Pick which terminal this is:",
                            )}
                          </label>
                          <select
                            value={chipLinkTarget}
                            onChange={(e) => setChipLinkTarget(e.target.value)}
                            className="text-[12px] w-full px-2 py-1 rounded-md bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100"
                          >
                            <option value="">
                              {t(
                                "detectedTerminalPickPlaceholder",
                                "— Select terminal —",
                              )}
                            </option>
                            {terms
                              .filter(
                                (term) =>
                                  !term.provider_id &&
                                  term.is_active !== false,
                              )
                              .map((term) => (
                                <option key={term.id} value={term.id}>
                                  {term.name}
                                </option>
                              ))}
                          </select>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={handleConfirmDetectedProvider}
                          disabled={chipConfirming}
                        >
                          {chipConfirming
                            ? t("detectedTerminalConfirming", "Saving…")
                            : t("detectedTerminalConfirm", "Confirm")}
                        </Button>
                        <button
                          type="button"
                          onClick={handleDismissChip}
                          disabled={chipConfirming}
                          className="text-[12px] text-amber-800 dark:text-amber-200 hover:underline disabled:opacity-50"
                        >
                          {t("detectedTerminalNotThisOne", "Not this one")}
                        </button>
                      </div>
                      {chipError && (
                        <div className="text-[11px] text-red-700 dark:text-red-300 mt-1">
                          {chipError}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Auto-linked: a small "Wrong terminal?" link that
                      opens an inline confirm-unlink dialog. Kept subtle
                      because the auto-link was already confidence ≥ 0.85
                      — most owners won't touch this. */}
                  {showAsLinked && !chipConfirmed && (
                    <div className="mt-2">
                      {!unlinkOpenForTerminalId && (
                        <button
                          type="button"
                          onClick={handleUnlinkAutoLinked}
                          className="text-[12px] text-gray-600 dark:text-gray-300 hover:underline"
                        >
                          {t("detectedTerminalWrong", "Wrong terminal?")}
                        </button>
                      )}
                      {unlinkOpenForTerminalId && (
                        <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 mt-1 text-[12px]">
                          <div className="mb-1.5 text-gray-700 dark:text-gray-300">
                            {t(
                              "detectedTerminalUnlinkConfirm",
                              "Unlink this terminal? You'll be able to relink it later.",
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              onClick={handleConfirmUnlink}
                              disabled={unlinking}
                            >
                              {unlinking
                                ? t(
                                    "detectedTerminalUnlinking",
                                    "Unlinking…",
                                  )
                                : t("detectedTerminalUnlink", "Unlink")}
                            </Button>
                            <button
                              type="button"
                              onClick={() =>
                                setUnlinkOpenForTerminalId(null)
                              }
                              disabled={unlinking}
                              className="px-2.5 py-1 text-gray-600 dark:text-gray-300 hover:underline disabled:opacity-50"
                            >
                              {t("detectedTerminalCancel", "Cancel")}
                            </button>
                          </div>
                          {chipError && (
                            <div className="text-[11px] text-red-700 dark:text-red-300 mt-1">
                              {chipError}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
            {/* Smart Scan source banner — appears when the kasserapport
                was classified + prefilled by SmartScanModal (instead of
                uploaded directly here). Tells the owner why the form
                already has values, and lists the fields the classifier
                flagged as needing verification. */}
            {smartScanVerifyState.length > 0 && (
              <div className="rounded-xl p-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/40 text-sm text-gray-900 dark:text-gray-100 space-y-1">
                <div className="font-medium flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
                  {t("smartScan.verifyHint", "Bekræft venligst")}
                </div>
                <div className="text-xs opacity-90">
                  {t(
                    "smartScan.verifyDailyClose",
                    "Vi har pre-udfyldt felterne fra dit billede. Tjek særligt:",
                  )}{" "}
                  <strong>{smartScanVerifyState.join(", ")}</strong>
                </div>
              </div>
            )}
            {/* Confidence indicator */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold dark:text-white">{t("scanResults")}</h2>
              <span className={`text-sm font-medium px-3 py-1 rounded-full ${
                scanFieldsDetected >= 5 ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                  : scanFieldsDetected >= 3 ? "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300"
                    : "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400"
              }`}>
                <Icon name="Target" size={14} className="inline align-text-bottom mr-1" /> {t("scanConfidenceLevel", "{level} confidence — {detected}/{total} fields detected", {
                  level: scanFieldsDetected >= 5 ? t("confidenceHigh", "High") : scanFieldsDetected >= 3 ? t("confidenceMedium", "Medium") : t("confidenceLow", "Low"),
                  detected: scanFieldsDetected,
                  total: scanFieldsTotal,
                })}
              </span>
            </div>

            {/* Detection-gap banner — fires when the total is detected
                but ANY revenue category is missing or zero. Two flavors:
                  • "all empty"   → save total via revenue_total_override
                  • "partial"     → tell owner which categories to fill
                Both keep the close save-able instead of silently writing
                the wrong number (was the original bug). */}
            {(() => {
              const hasTotal = (scanResult.revenue_total || 0) > 0;
              if (!hasTotal) return null;
              const detected = defaultRevCats
                .map(c => ({ key: c.key, label: c.label, val: scanResult.revenue?.[c.key] }))
                .filter(r => r.val != null && r.val !== 0 && r.val !== "");
              const missing = defaultRevCats
                .map(c => ({ key: c.key, label: c.label, val: scanResult.revenue?.[c.key] }))
                .filter(r => !(r.val != null && r.val !== 0 && r.val !== ""));
              if (missing.length === 0) return null;
              const allEmpty = detected.length === 0;
              return (
                <div className="rounded-xl p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200 space-y-1">
                  <div>
                    <Icon name="Info" size={14} className="inline align-text-bottom mr-1" /> <strong>
                      {allEmpty
                        ? t("scanGapNoBreakdown", "We couldn't detect the per-category breakdown")
                        : t("scanGapDetectedSome", "We detected {detected} of {total} revenue categories", { detected: detected.length, total: defaultRevCats.length })}
                    </strong>
                    {" "}{t("scanGapTotalIs", "from this receipt — total is {amount}.", { amount: `${scanResult.revenue_total.toLocaleString()} ${currency}` })}
                  </div>
                  <div className="text-xs opacity-90">
                    {allEmpty
                      ? t("scanGapSavingTotal", "Saving the total revenue anyway. Enter the per-category split below if you need it for reports.")
                      : <>{t("scanGapEnterActualFor", "Please enter the actual amount for:")} <strong>{missing.map(m => m.label.split(" / ")[0]).join(", ")}</strong>. {t("scanGapOrSkip", "Or skip — the total above will save correctly either way.")}</>}
                  </div>
                </div>
              );
            })()}

            {/* Revenue (med moms) */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
                {t("revenueMedMoms", "Revenue (med moms)")}
              </h3>
              {defaultRevCats.map(c => {
                const val = scanResult.revenue?.[c.key];
                const isEmpty = !val;
                return (
                  <div key={c.key} className="flex items-center gap-3">
                    <span className="text-sm w-44 flex items-center gap-2 dark:text-gray-300">
                      {val ? <Icon name="Check" size={14} className="text-emerald-600" /> : <span className="text-gray-300 dark:text-gray-600">—</span>}
                      <Icon name={c.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, c)}
                      {val && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-600 dark:text-gray-300 rounded">OCR</span>}
                      {isEmpty && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded">{t("scanBadgeMissing", "missing")}</span>}
                    </span>
                    <input type="number" inputMode="decimal"
                      className={`${inputClass} ${isEmpty ? "border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}
                      defaultValue={val || ""}
                      placeholder={isEmpty ? t("enterActualAmount", "enter actual amount") : ""}
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
                  <span>{t("totalRevenue")}</span>
                  <span>{scanResult.revenue_total.toLocaleString()} {currency}</span>
                </div>
              )}
            </div>

            {/* MOMS section */}
            <div className="rounded-xl p-4 space-y-2"
              style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.08))" }}>
              <h3 className="font-semibold text-sm flex items-center gap-2" style={{ color: "#6366f1" }}>
                {vatName} ({vatRatePct}%)
                {scanResult.moms_total && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded">OCR</span>}
              </h3>
              <div className="flex justify-between text-sm dark:text-gray-300">
                <span>{t("totalMoms")}</span>
                <span className="font-semibold" style={{ color: "#6366f1" }}>
                  {(scanResult.moms_total || (vatRate > 0 ? Math.round(((scanResult.revenue_total || 0) * vatRate / vatDivisor) * 100) / 100 : 0)).toLocaleString()} {currency}
                </span>
              </div>
              {defaultRevCats.map(c => {
                const val = scanResult.revenue?.[c.key];
                if (!val) return null;
                const udenMoms = Math.round((val / vatDivisor) * 100) / 100;
                return (
                  <div key={c.key} className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                    <span>{c.label.split(" / ")[0]} {t("udenMomsSuffix", "(uden moms)")}</span>
                    <span>{udenMoms.toLocaleString()} {currency}</span>
                  </div>
                );
              })}
            </div>

            {/* Payments */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400">{t("paymentsLabel")}</h3>
              {defaultPayMethods.map(m => {
                const val = scanResult.payments?.[m.key];
                const isEmpty = !val;
                return (
                  <div key={m.key} className="flex items-center gap-3">
                    <span className="text-sm w-44 flex items-center gap-2 dark:text-gray-300">
                      {val ? <Icon name="Check" size={14} className="text-emerald-600" /> : <span className="text-gray-300 dark:text-gray-600">—</span>}
                      <Icon name={m.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, m)}
                      {val && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-600 dark:text-gray-300 rounded">OCR</span>}
                      {isEmpty && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded">{t("scanBadgeMissing", "missing")}</span>}
                    </span>
                    <input type="number" inputMode="decimal"
                      className={`${inputClass} ${isEmpty ? "border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}
                      defaultValue={val || ""}
                      placeholder={isEmpty ? t("enterActualAmount", "enter actual amount") : ""}
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

            {/* Card breakdown (Fordeling) — informational brand/channel
                splits the OCR read, shown UNDER the card line. Read-only +
                demoted: these are HOW the card total split by scheme, not
                extra money, so they never enter the payment total. Surfaced
                so the on-screen close mirrors the paper kasserapport 1:1. */}
            {scanResult.payments_view?.card_breakdown &&
              Object.keys(scanResult.payments_view.card_breakdown).length > 0 && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl px-4 py-3">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                  {t("cardBreakdownHeader", "Card breakdown")}
                </div>
                <div className="space-y-1 pl-1">
                  {Object.entries(scanResult.payments_view.card_breakdown).map(([k, v]) => (
                    <div key={k} className="flex justify-between text-xs text-gray-600 dark:text-gray-300">
                      <span>{k === "betalingskort"
                        ? t("brandBetalingskort", "Betalingskort (terminal)")
                        : k.charAt(0).toUpperCase() + k.slice(1)}</span>
                      <span className="tabular-nums">{(typeof v === "number" ? v : 0).toLocaleString()} {currency}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tips — only for types that have tips */}
            {config.hasTips && (
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <div className="flex items-center gap-3">
                <span className="text-sm w-44 flex items-center gap-2 dark:text-gray-300">
                  {scanResult.tips ? <Icon name="Check" size={14} className="text-emerald-600" /> : <span className="text-gray-300 dark:text-gray-600">—</span>}
                  <Icon name="Coins" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("tipsLabel", "Tips")}
                  {scanResult.tips && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-600 dark:text-gray-300 rounded">OCR</span>}
                  {!scanResult.tips && <span className="text-[10px] font-mono px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded">{t("scanBadgeMissing", "missing")}</span>}
                </span>
                <input type="number" inputMode="decimal"
                  className={`${inputClass} ${!scanResult.tips ? "border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}
                  defaultValue={scanResult.tips || ""}
                  placeholder={!scanResult.tips ? t("enterActualAmount", "enter actual amount") : ""}
                  onChange={e => {
                    setScanResult(prev => ({ ...prev, tips: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 }));
                  }} />
              </div>
            </div>
            )}

            {/* Adjustments — Gebyr (surcharge). A separate line that is NOT
                part of the payment total (it's a fee, not money taken).
                Display-only this pass so the owner sees what's on the report;
                persistence into the accountant export is a tracked follow-up. */}
            {typeof scanResult.payments_view?.adjustments?.surcharge === "number" &&
              scanResult.payments_view.adjustments.surcharge !== 0 && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl px-4 py-3">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                  {t("adjustmentsHeader", "Adjustments")}
                </div>
                <div className="flex justify-between text-xs text-gray-600 dark:text-gray-300">
                  <span>{t("adjSurcharge", "Surcharge")}</span>
                  <span className="tabular-nums">{scanResult.payments_view.adjustments.surcharge.toLocaleString()} {currency}</span>
                </div>
              </div>
            )}

            {/* Photo thumbnails — bigger + clickable to view full-size,
                so the owner can keep the receipt visible while
                reviewing the OCR'd numbers. Each thumb opens the full
                image in a new tab (works for both blob URLs and
                Supabase signed URLs). */}
            {scanPhotos.length > 0 && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 inline-flex items-center gap-1.5">
                    <Icon name="Image" size={14} /> {scanPhotos.length > 1 ? t("receiptPhotosLabel", "Receipt photos") : t("receiptPhotoLabel", "Receipt photo")}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t("tapToViewFullSize", "Tap to view full size")}
                  </span>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {scanPhotos.map((p, i) => {
                    const safe = safeImageUrl(p.url);
                    return safe ? (
                      <a key={i} href={safe} target="_blank" rel="noreferrer"
                        className="shrink-0 group">
                        <img src={safe} alt={p.name}
                          className="w-24 h-24 rounded-lg object-cover border-2 border-gray-300/50 group-hover:border-gray-300 transition" />
                      </a>
                    ) : null;
                  })}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col sm:flex-row gap-3">
              <Button variant="primary" size="lg" className="flex-1" onClick={() => applyScanValues(true)}
                iconLeft={<Icon name="CheckCircle2" size={16} />}>
                {t("useTheseValuesJumpReview", "Use these values — jump to review")}
              </Button>
              <Button variant="secondary" size="lg" className="flex-1" onClick={() => applyScanValues(false)}
                iconLeft={<Icon name="Pencil" size={16} />}>
                {t("continueStepByStep", "Continue step-by-step")}
              </Button>
            </div>
            <div className="flex justify-center gap-4">
              <button onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
                className="text-sm text-emerald-600 dark:text-gray-300 hover:text-gray-700 dark:hover:text-gray-300 font-medium">
                + {t("addAnotherPhoto", "Add another photo")}
              </button>
              <button onClick={() => { setScanResult(null); setScanPhotos([]); setScanMode("idle"); }}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline underline-offset-2">
                {t("startOver", "Start over")}
              </button>
            </div>
          </div>
        )}

        {/* ─── NORMAL STEP FLOW ─── */}
        {!showScanUI && (<>
        {/* Date selector — defaults to today, allows past dates */}
        <div className="mb-4 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
            <Icon name="Calendar" size={14} /> {t("dateLabel", "Date")}
          </label>
          <input type="date" value={businessDate}
            max={getBusinessDate(cutoffHour)}
            onChange={e => { if (e.target.value) setBusinessDate(e.target.value); }}
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
          {businessDate !== getBusinessDate(cutoffHour) && (
            <span className="text-[10px] px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full font-semibold">
              {t("pastDate")}
            </span>
          )}
          {businessDate !== getBusinessDate(cutoffHour) && (
            <button onClick={() => setBusinessDate(getBusinessDate(cutoffHour))}
              className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline">
              {t("resetToToday", "Reset to today")}
            </button>
          )}
        </div>

        {/* Draft auto-save indicator */}
        {draftSaved && (
          <div className="mb-3 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-center text-xs text-gray-400 flex items-center justify-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" /> {t("draftSavedResumeLater", "Draft saved — you can leave and resume later")}
          </div>
        )}

        {/* Sync indicator */}
        {prefillLoading && (
          <div className="mb-4 px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl text-center text-sm text-gray-400">
            {t("loadingRecords", "Loading records…")}
          </div>
        )}
        {prefill && !prefillLoading && (
          <div className="mb-4 px-4 py-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl text-sm text-blue-700 dark:text-blue-300">
            <div className="flex items-center gap-2 font-medium">
              <Icon name="RefreshCw" size={16} />
              <span>
                {prefill.sales.count === 1
                  ? t("syncedFromSaleOne", "Synced from {n} sale", { n: prefill.sales.count })
                  : t("syncedFromSaleMany", "Synced from {n} sales", { n: prefill.sales.count })}
                {prefill.expenses.count > 0 && (prefill.expenses.count === 1
                  ? t("syncedExpensesOne", " & {n} expense", { n: prefill.expenses.count })
                  : t("syncedExpensesMany", " & {n} expenses", { n: prefill.expenses.count }))}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 mt-2 text-xs">
              <span>{t("revenueLabel", "Revenue")}: {prefill.sales.total.toLocaleString()} {currency}</span>
              {prefill.expenses.total > 0 && <span>{t("expensesLabel", "Expenses")}: {prefill.expenses.total.toLocaleString()} {currency}</span>}
              <span>{t("netLabel", "Net")}: {(prefill.sales.total - prefill.expenses.total).toLocaleString()} {currency}</span>
            </div>
          </div>
        )}

        {/* Gavekort redeemed today — attestation prompt. A gavekort is a TENDER,
            not a second sale: the meal it paid for must be in revenue above, or
            the MOMS is under-declared (DK MPV VAT falls at redemption). BonBox
            NEVER auto-adds it — the owner confirms it's included. Amber-stronger
            when redemptions materially exceed the gift-card tender on the day. */}
        {prefill && !prefillLoading && (prefill.gavekort?.redeemed || 0) > 0 && (() => {
          const redeemed = prefill.gavekort.redeemed;
          const tender = prefill.gavekort.tender || 0;
          const short = redeemed - tender;
          const maybeMissing = short > 50 && short / redeemed > 0.1;
          return (
            <div className="mb-4 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl text-sm text-amber-800 dark:text-amber-300">
              <div className="flex items-center gap-2 font-medium">
                <Icon name="Gift" size={16} />
                <span>
                  {t("dcGkRedeemedToday", "Gavekort indløst i dag: {amount} {cur}", {
                    amount: redeemed.toLocaleString(),
                    cur: currency,
                  })}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed">
                {maybeMissing
                  ? t(
                      "dcGkMaybeMissing",
                      "Det ser ud til, at gavekort-måltidet måske ikke er med i omsætningen ovenfor. MOMS skal afregnes ved indløsning — tjek at salget er bogført, så det indgår i MOMS-grundlaget.",
                    )
                  : t(
                      "dcGkConfirmIncluded",
                      "Sørg for, at måltidet er med i omsætningen ovenfor — gavekort er en betalingsmåde, ikke et ekstra salg. BonBox lægger det ikke til automatisk.",
                    )}
              </p>
            </div>
          );
        })()}

        {/* Night shift indicator */}
        {cutoffHour > 0 && businessDate !== new Date().toISOString().split("T")[0] && (
          <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl px-3 py-2 flex items-center gap-2 mb-3 border border-indigo-100 dark:border-indigo-800">
            <Icon name="Moon" size={14} className="text-indigo-600 dark:text-indigo-300" />
            <p className="text-xs text-indigo-600 dark:text-indigo-300">
              <strong>{t("nightShiftLabel", "Night shift:")}</strong> {t("nightShiftClosingFor", "closing for {date} (cutoff {hour}:00 AM)", { date: new Date(businessDate + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" }), hour: cutoffHour })}
            </p>
          </div>
        )}

        {/* Step header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold dark:text-white">
            {currentStepId === "revenue" && t("stepNRevenue", "Step {n} — {label}", { n: step, label: t(config.stepOneLabelKey, config.stepOneLabel) })}
            {currentStepId === "payments" && t("stepNPayments", "Step {n} — Payment Methods", { n: step })}
            {currentStepId === "cash" && t("stepNCash", "Step {n} — Cash Drawer Count", { n: step })}
            {currentStepId === "tips" && t("stepNTips", "Step {n} — Tips", { n: step })}
            {currentStepId === "review" && t("stepNReview", "Step {n} — Review & Submit", { n: step })}
          </h2>
          <span className="text-sm text-gray-400">{step}/{totalSteps}</span>
        </div>

        {/* ─── STEP: Revenue ─── */}
        {currentStepId === "revenue" && (
          <div className="space-y-4">
            {/* Sync-from-sales banner — one-tap distribute by item.
                Goal: close numbers MUST reconcile with the POS sales register,
                otherwise the bookkeeping is decorative. The banner does two things:
                  1. Surfaces the sales total so the owner can sanity-check.
                  2. Offers a "Use these" button that auto-fills the breakdown.
                If the owner enters numbers manually and they diverge >10% from
                sales, we flash a warning below the inputs. */}
            {prefill && prefill.sales.total > 0 && (
              <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/50 rounded-xl p-3 text-sm">
                <div className="flex items-start gap-3 justify-between">
                  <div className="text-gray-700 dark:text-gray-300">
                    <div>{t("posSalesRegisterForDate", "POS sales register for this date:")}
                      <strong className="ml-1">{prefill.sales.total.toLocaleString()} {currency}</strong>
                      <span className="text-emerald-600/70 dark:text-emerald-400/70 ml-1">
                        ({prefill.sales.count === 1
                          ? t("nSaleOne", "{n} sale", { n: prefill.sales.count })
                          : t("nSaleMany", "{n} sales", { n: prefill.sales.count })})
                      </span>
                    </div>
                    {Object.keys(prefill.sales.by_item).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {Object.entries(prefill.sales.by_item).slice(0, 6).map(([name, val]) => (
                          <span key={name} className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs">
                            {name}: {val.toLocaleString()}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Reset to the computed split — re-applies the honest
                      per-category "beregnet" amounts (never dumps the total into
                      one category, which the old best-effort item-matcher did).
                      Only shown when a computed split exists. */}
                  {splitMeta?.source === "history" && splitMeta.categories && (
                    <button
                      type="button"
                      className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline underline-offset-2"
                      onClick={() => {
                        const next = {};
                        Object.entries(splitMeta.categories).forEach(([k, v]) => { next[k] = String(v); });
                        setRevAmounts(next);
                      }}
                    >
                      {t("dcResetToComputed", "Reset to computed split")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Variance warning — fire if user-entered total diverges from POS by >10% */}
            {prefill && prefill.sales.total > 0 && revenueTotal > 0 && (() => {
              const variance = revenueTotal - prefill.sales.total;
              const pctOff = Math.abs(variance) / prefill.sales.total;
              if (pctOff <= 0.10) return null;  // <=10% is normal (rounding, etc.)
              return (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl p-3 text-sm text-amber-700 dark:text-amber-300">
                  <strong><Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1 text-amber-600 dark:text-amber-400" />{t("varianceFromRegister", "Variance from sales register: {amount}", { amount: `${variance > 0 ? "+" : ""}${variance.toLocaleString()} ${currency}` })}</strong>
                  <p className="text-xs mt-1 text-amber-600/80 dark:text-amber-400/80">
                    {t("closeDiffersBy", "Your close ({close}) differs by {pct}% from your POS total ({pos}). Double-check before locking — this number will be on your revisor's report.", { close: revenueTotal.toLocaleString(), pct: Math.round(pctOff * 100), pos: prefill.sales.total.toLocaleString() })}
                  </p>
                </div>
              );
            })()}
            {/* Honest computed-split cue. "beregnet" (computed), NEVER presented
                as a measured/scanned fact — it's the owner's own historical mix
                applied to today's total, to confirm or correct. The graceful
                first-time line shows when there's no history yet; single-category
                verticals show neither (splitMeta === null). */}
            {splitMeta?.source === "history" && (
              <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400 -mb-1">
                <Icon name="Sparkles" size={13} className="mt-0.5 shrink-0 text-gray-400 dark:text-gray-500" />
                <span>{t("dcSplitComputed", "Computed from your last {n} closes — check and adjust if needed.", { n: splitMeta.sampleSize })}</span>
              </div>
            )}
            {splitMeta?.source === "none" && (
              <div className="text-xs text-gray-400 dark:text-gray-500 -mb-1">
                {t("dcSplitFirstTime", "We'll suggest a split once you've closed a few days.")}
              </div>
            )}
            {revCats.map(cat => (
              <div key={cat.key}>
                <label className={labelClass}><Icon name={cat.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, cat)}</label>
                <input type="number" inputMode="decimal" placeholder="0" className={inputClass}
                  value={revAmounts[cat.key] || ""}
                  onChange={e => setRevAmounts({ ...revAmounts, [cat.key]: e.target.value })} />
              </div>
            ))}
            <div className="flex gap-2">
              <input type="text" placeholder={t("addCategory") || "Add category..."} className="flex-1 px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm"
                value={customRevName} onChange={e => setCustomRevName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCustomRevCat()} />
              <Button variant="secondary" size="lg" onClick={addCustomRevCat}>+ {t("addBtn", "Add")}</Button>
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
                <label className={labelClass}><Icon name={m.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, m)}</label>
                <input type="number" inputMode="decimal" placeholder="0" className={inputClass}
                  value={payAmounts[m.key] || ""}
                  onChange={e => setPayAmounts({ ...payAmounts, [m.key]: e.target.value })} />
              </div>
            ))}
            <div className="pt-3 border-t dark:border-gray-700">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">{t("paymentTotal")}:</span>
                <span className="text-xl font-bold dark:text-white">{paymentTotal.toLocaleString()} {currency}</span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <span className="text-sm text-gray-500">{t("revenueTotal")}:</span>
                <span className="text-sm dark:text-gray-300">{revenueTotal.toLocaleString()} {currency}</span>
              </div>
              {revenueTotal > 0 && (
                <div className={`mt-2 px-3 py-2 rounded-lg text-sm font-medium ${
                  Math.abs(balanceDiff) < 1 ? "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400"
                }`}>
                  {Math.abs(balanceDiff) < 1
                    ? <><Icon name="CheckCircle2" size={14} className="inline align-text-bottom mr-1" />{t("balanced", "Balanced!")}</>
                    : <><Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" />{`${t("difference", "Difference")}: ${balanceDiff > 0 ? "+" : ""}${balanceDiff.toLocaleString()} ${currency}`}</>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── STEP: Cash Drawer ─── */}
        {currentStepId === "cash" && (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 text-sm text-blue-700 dark:text-blue-300">
              {t("countPhysicalCash", "Count the physical cash in your drawer and enter the amount below. We'll compare it against what the system expects.")}
            </div>
            <div>
              <label className={labelClass}>
                {cashExpectedFromRegister
                  ? t("expectedFromRegister", "Expected (from register)")
                  : t("expectedFromEntry", "Expected (from your entry)")}
              </label>
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl text-right text-lg font-semibold dark:text-gray-300">
                {cashExpected.toLocaleString()} {currency}
              </div>
              {cashExpectedFromRegister && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {t("expectedFromRegisterHint", "From your synced POS register — counting against this flags a real cash shortage, not just a typo.")}
                </p>
              )}
            </div>
            <div>
              <label className={labelClass}><Icon name="Banknote" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("countedAmount", "Counted Amount")}</label>
              <input type="number" inputMode="decimal" placeholder={t("countYourDrawer")} className={inputClass}
                value={cashCounted} onChange={e => setCashCounted(e.target.value)} />
            </div>
            {cashDiff !== null && (
              <div className={`px-4 py-3 rounded-xl text-center font-bold text-lg ${
                Math.abs(cashDiff) <= 100 ? "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                  : "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400"
              }`}>
                {t("difference")}: {cashDiff > 0 ? "+" : ""}{cashDiff.toLocaleString()} {currency}
                {Math.abs(cashDiff) > 100 && <p className="text-sm font-normal mt-1"><Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" /> {t("offByMoreThan100", "Off by more than 100 — double-check your count")}</p>}
              </div>
            )}
            {!cashExpected && (
              <p className="text-sm text-gray-400 text-center">{t("noCashStep2")}</p>
            )}
          </div>
        )}

        {/* ─── STEP: Tips (only for types with tips) ─── */}
        {currentStepId === "tips" && (
          <div className="space-y-4">
            <div>
              <label className={labelClass}><Icon name="Coins" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("totalTipsLabel", "Total Tips")}</label>
              <input type="number" inputMode="decimal" placeholder="0" className={inputClass}
                value={tipsTotal} onChange={e => setTipsTotal(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}><Icon name="Users" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("staffCountLabel", "Staff Count")}</label>
              <input type="number" inputMode="numeric" placeholder={t("staffCountPrompt")} className={inputClass}
                value={staffCount} onChange={e => setStaffCount(e.target.value)} />
            </div>
            {tipsPP !== null && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 text-center">
                <p className="text-sm text-emerald-600 dark:text-gray-300">{t("perPerson")}</p>
                <p className="text-2xl font-bold text-gray-700 dark:text-gray-300">{tipsPP.toLocaleString()} {currency}</p>
              </div>
            )}
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-xs text-amber-700 dark:text-amber-300">
              <strong>{t("tipsTaxNoteLabel", "Danish tax note:")}</strong> {t("tipsTaxNoteBody", "Tips must be reported via eIndkomst. Share this data with your revisor.")}
            </div>
          </div>
        )}

        {/* ─── REVIEW STEP ─── */}
        {currentStepId === "review" && (
          <div className="space-y-4">
            {/* Date confirmation */}
            <div className="flex items-center gap-2 text-sm dark:text-gray-300">
              <Icon name="Calendar" size={14} className="text-gray-500 dark:text-gray-400" />
              <span className="font-medium">
                {new Date(businessDate + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              </span>
              {businessDate !== getBusinessDate(cutoffHour) && (
                <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded font-semibold">{t("pastDate")}</span>
              )}
            </div>

            {/* Revenue summary */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 mb-2">{t("revenue")}</h3>
              {revCats.filter(c => revAmounts[c.key]).map(c => (
                <div key={c.key} className="flex justify-between text-sm py-0.5 dark:text-gray-300">
                  <span><Icon name={c.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, c)}</span>
                  <span>{parseFloat(revAmounts[c.key]).toLocaleString()} {currency}</span>
                </div>
              ))}
              <div className="flex justify-between font-bold pt-2 border-t dark:border-gray-600 mt-2 dark:text-white">
                <span>{t("total")}</span><span>{revenueTotal.toLocaleString()} {currency}</span>
              </div>
            </div>

            {/* MOMS (VAT) summary — with auto/manual toggle */}
            {revenueTotal > 0 && (
              <div className="rounded-xl p-4 space-y-3"
                style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.08), rgba(139,92,246,0.08))" }}>
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm" style={{ color: "#6366f1" }}>{vatName} ({vatRatePct}%)</h3>
                  {/* Toggle: Auto vs Manual */}
                  <div className="flex bg-gray-200 dark:bg-gray-700 rounded-lg p-0.5 text-xs">
                    <button onClick={() => setMomsMode("auto")}
                      className={`px-3 py-1 rounded-md font-medium transition ${momsMode === "auto" ? "bg-indigo-500 text-white shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
                      {t("autoLabel")}
                    </button>
                    <button onClick={() => setMomsMode("manual")}
                      className={`px-3 py-1 rounded-md font-medium transition ${momsMode === "manual" ? "bg-indigo-500 text-white shadow-sm" : "text-gray-500 dark:text-gray-400 hover:text-gray-700"}`}>
                      {t("fromReceipt")}
                    </button>
                  </div>
                </div>
                {momsMode === "manual" && (
                  <div>
                    <label className="text-xs text-indigo-400 mb-1 block">{t("enterMomsFromReceipt", "Enter {vat} from your Z-report / receipt", { vat: vatName })}</label>
                    <input type="number" inputMode="decimal" placeholder={t("momsAmountPlaceholder")}
                      className="w-full px-4 py-2.5 border border-indigo-300 dark:border-indigo-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-right text-lg"
                      value={momsManual} onChange={e => setMomsManual(e.target.value)} />
                  </div>
                )}
                {momsMode === "auto" && (
                  <p className="text-xs text-indigo-400">{t("momsAutoCalc", "Auto-calculated: Revenue × {pct}% / {div}%", { pct: vatRatePct, div: 100 + vatRatePct })}</p>
                )}
                <div className="flex justify-between text-sm dark:text-gray-300 py-0.5">
                  <span>{t("revenueMedMoms", "Revenue (med moms)")}</span>
                  <span>{revenueTotal.toLocaleString()} {currency}</span>
                </div>
                {/* Salg uden moms i dag — exempt rows the owner already
                    flagged via Quick Sale MOMS-fri or the Sales page.
                    Pulled from /property-report (taxable_sales vs
                    total_revenue) so the close MOMS calc matches the
                    SKAT MOMS-angivelse PDF. DK term locked. */}
                {exemptSalesTotal > 0 && (
                  <div className="flex justify-between text-xs text-amber-700 dark:text-amber-300 py-0.5">
                    <span>{t("salgUdenMomsToday") || "Salg uden moms i dag"}</span>
                    <span>-{exemptSalesTotal.toLocaleString()} {currency}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm font-semibold py-0.5" style={{ color: "#6366f1" }}>
                  <span>{vatName} {vatRatePct}%{momsMode === "manual" ? ` ${t("fromReceiptSuffix", "(from receipt)")}` : ""}</span>
                  <span>{momsTotal.toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between text-sm font-bold pt-2 border-t mt-1 dark:text-white" style={{ borderColor: "rgba(99,102,241,0.2)" }}>
                  <span>{t("revenueUdenMoms", "Revenue (uden moms)")}</span>
                  <span>{revenueExMoms.toLocaleString()} {currency}</span>
                </div>
                <div className="pt-2 border-t" style={{ borderColor: "rgba(99,102,241,0.15)" }}>
                  <p className="text-xs text-indigo-400">
                    <Icon name="BarChart3" size={14} className="inline align-text-bottom mr-1" /> {t("dailyCloseReconcileNotePre", "Daily Close is your cash-drawer reconciliation. Your moms filing in ")}<a href="/tax" className="font-bold underline hover:text-indigo-300">{t("dailyCloseReconcileNoteLink", "Skat Autopilot")}</a>{t("dailyCloseReconcileNotePost", " reads from the POS sales register — this close adds a cross-check that flags variance.")}
                  </p>
                </div>
              </div>
            )}

            {/* Payment summary */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 mb-2">{t("paymentsLabel")}</h3>
              {payMethods.filter(m => payAmounts[m.key]).map(m => (
                <div key={m.key} className="flex justify-between text-sm py-0.5 dark:text-gray-300">
                  <span><Icon name={m.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, m)}</span>
                  <span>{parseFloat(payAmounts[m.key]).toLocaleString()} {currency}</span>
                </div>
              ))}
              <div className="flex justify-between font-bold pt-2 border-t dark:border-gray-600 mt-2 dark:text-white">
                <span>{t("total")}</span><span>{paymentTotal.toLocaleString()} {currency}</span>
              </div>
            </div>

            {/* Cash drawer */}
            {cashCounted && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 mb-2">{t("cashDrawer")}</h3>
                <div className="flex justify-between text-sm dark:text-gray-300"><span>{cashExpectedFromRegister ? t("expectedFromRegister", "Expected (from register)") : t("expectedFromEntry", "Expected (from your entry)")}</span><span>{cashExpected.toLocaleString()} {currency}</span></div>
                <div className="flex justify-between text-sm dark:text-gray-300"><span>{t("counted")}</span><span>{cashCountedVal.toLocaleString()} {currency}</span></div>
                <div className={`flex justify-between font-bold pt-2 border-t dark:border-gray-600 mt-2 ${cashDiff < -100 ? "text-red-600" : "dark:text-white"}`}>
                  <span>{t("difference")}</span><span>{cashDiff > 0 ? "+" : ""}{cashDiff?.toLocaleString()} {currency}</span>
                </div>
              </div>
            )}

            {/* Expenses (from synced data) */}
            {prefill && prefill.expenses.total > 0 && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-red-500 dark:text-red-400 mb-2">{t("todaysExpenses")}</h3>
                {Object.entries(prefill.expenses.by_category).map(([cat, val]) => (
                  <div key={cat} className="flex justify-between text-sm py-0.5 text-red-700 dark:text-red-300">
                    <span>{cat}</span>
                    <span>-{val.toLocaleString()} {currency}</span>
                  </div>
                ))}
                <div className="flex justify-between font-bold pt-2 border-t border-red-200 dark:border-red-800 mt-2 text-red-700 dark:text-red-300">
                  <span>{t("totalExpenses")}</span><span>-{prefill.expenses.total.toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between font-bold pt-2 mt-1 text-gray-700 dark:text-gray-300">
                  <span>{t("netProfit")}</span><span>{(revenueTotal - prefill.expenses.total).toLocaleString()} {currency}</span>
                </div>
              </div>
            )}

            {/* Tips */}
            {tipsTotal && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 mb-2">{t("tipsLabel", "Tips")}</h3>
                <div className="flex justify-between text-sm dark:text-gray-300"><span>{t("total")}</span><span>{parseFloat(tipsTotal).toLocaleString()} {currency}</span></div>
                <div className="flex justify-between text-sm dark:text-gray-300"><span>{t("staffCountLabel", "Staff Count")}</span><span>{staffCount}</span></div>
                {tipsPP && <div className="flex justify-between font-bold pt-2 border-t dark:border-gray-600 mt-2 dark:text-white"><span>{t("perPerson")}</span><span>{tipsPP.toLocaleString()} {currency}</span></div>}
              </div>
            )}

            {/* Phase A — salon Gavekort solgt. Its own line, EXCLUDED from the
                day-of-sale service MOMS base, flagged for the revisor (we never
                auto-decide single- vs multi-purpose voucher MOMS). */}
            {config.hasGavekort && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-2">
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
                  <Icon name="Gift" size={14} className="text-gray-500 dark:text-gray-400" />
                  {t("closeGavekortSoldLabel", "Gavekort solgt")}
                </label>
                <input type="number" inputMode="decimal" placeholder="0"
                  className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl"
                  value={gavekortSold} onChange={e => setGavekortSold(e.target.value)} />
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t("closeGavekortMomsNote", "Holdes uden for dagens moms-grundlag — moms afgøres af din revisor (enkelt- vs flerformålsvoucher).")}
                </p>
              </div>
            )}

            {/* Phase A — bakery Parti / Batch reference. Informational only;
                folded into notes for the revisor, never part of MOMS. */}
            {config.hasBatch && (
              <div>
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
                  <Icon name="Croissant" size={14} className="text-gray-500 dark:text-gray-400" />
                  {t("closeBatchLabel", "Parti / Batch")}
                </label>
                <input type="text" placeholder={t("closeBatchPlaceholder", "fx morgenbatch #2")}
                  className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl"
                  value={batchRef} onChange={e => setBatchRef(e.target.value)} />
              </div>
            )}

            {/* Closed by + notes */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300">{t("closedBy")}</label>
                <input type="text" placeholder={t("managerNamePlaceholder", "Manager name…")} className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl"
                  value={closedBy} onChange={e => setClosedBy(e.target.value)} />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300">{t("notes")}</label>
                <textarea placeholder={t("notesPlaceholderTonight", "Any notes for tonight…")} rows={2} className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl resize-none"
                  value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
            </div>

            {/* ─── Lane A — Auto-email-on-lock toggle ─── */}
            {/* Starter+ users see a live toggle; Free users see the
                gated state with a one-tap upgrade link. The toggle
                state is the user's preference; the entitlement is
                the tier gate — both must be true at lock time for
                the email to fire (router enforces). */}
            {closeAutoEmailEntitled === null ? (
              /* Tier-flicker fix: skeleton while entitlements load —
                 prevents trial users from seeing the "Upgrade to Starter"
                 nudge briefly before the real toggle appears. */
              <div className="rounded-xl p-4 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800">
                <div className="h-4 w-2/3 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" aria-hidden="true" />
                <div className="h-3 w-full mt-2 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" aria-hidden="true" />
              </div>
            ) : (!closeAutoEmailEntitled && isNativeApp()) ? (
              /* App Store compliance (Apple 3.1.1): the locked-toggle state is
                 an upsell ("Auto-email on lock is on Starter+ · Upgrade to
                 Starter"). Hide it entirely on native — the feature is simply
                 absent, with no tier name or upgrade pitch. Web unchanged. */
              null
            ) : (
              <div className={`rounded-xl p-4 ${
                closeAutoEmailEntitled
                  ? "bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800"
                  : "bg-gray-50 dark:bg-gray-800/50 border border-dashed border-gray-300 dark:border-gray-700"
              }`}>
                {closeAutoEmailEntitled ? (
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoEmailPref}
                      onChange={toggleAutoEmail}
                      className="mt-1 h-4 w-4 rounded text-emerald-600 focus:ring-gray-400"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-100 inline-flex items-center gap-1.5">
                        <Icon name="Mail" size={14} className="text-gray-500 dark:text-gray-400" /> {t("autoEmailToggleLabel") || "Email owner + accountant automatically on lock"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t("autoEmailToggleHint") || "When you tap Confirm & Lock, we send one email with the kasserapport PDF + scanned Z-report photo to your owner email and your accountant."}
                      </p>
                    </div>
                  </label>
                ) : (
                  <div className="flex items-start gap-3">
                    <Icon name="Lock" size={14} className="text-gray-400 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                        {t("autoEmailToggleStarterGate") || "Auto-email on lock is on Starter+"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t("autoEmailToggleStarterGateBody") || "Free still lets you manually tap Send to accountant after locking. Upgrade to Starter for the no-extra-tap version."}
                      </p>
                      {canPurchaseInApp() && (
                        <a
                          href="/subscription"
                          className="inline-block mt-2 text-xs font-semibold text-emerald-600 dark:text-gray-300 hover:underline"
                        >
                          {t("pricingUpgradeStarter") || "Upgrade to Starter"} →
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && <SectionBanner severity="critical" icon="AlertCircle">{error}</SectionBanner>}
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex justify-between mt-6 pt-4 border-t dark:border-gray-700">
          {step > 1 ? (
            <Button variant="ghost" size="lg" onClick={() => setStep(step - 1)}>
              ← {t("back", "Back")}
            </Button>
          ) : (
            <Button variant="ghost" size="lg" onClick={() => { setScanMode("idle"); setScanResult(null); setScanPhotos([]); }}>
              ← {t("scanZReportBack", "Scan Z-report")}
            </Button>
          )}

          {step < totalSteps ? (
            <Button variant="primary" size="lg" onClick={() => setStep(step + 1)}>
              {t("next", "Next")} →
            </Button>
          ) : (() => {
              // Save-preview — show the user the actual amount that will
              // be persisted, especially when the backend's max() will
              // pick the OCR override over their breakdown sum (e.g.
              // partial detection saved 1.82; override pushes it to
              // 17,030). Without this, the user types skip-fill values
              // and has to trust the banner — preview makes it explicit.
              const ocrTotal = Number(scanResult?.revenue_total || 0);
              const willSave = ocrTotal > revenueTotal ? ocrTotal : revenueTotal;
              const usingOverride = ocrTotal > 0 && ocrTotal > revenueTotal;
              return (
                <div className="flex flex-col items-end gap-1">
                  <Button variant="primary" size="lg" onClick={() => handleSubmit()} disabled={saving || willSave === 0}>
                    {saving ? (
                      t("savingEllipsis", "Saving…")
                    ) : !isOnline ? (
                      <span className="inline-flex items-center gap-2"><Icon name="UploadCloud" size={16} /> {t("queueAndLockOffline", "Queue & Lock (offline)")}</span>
                    ) : (
                      <span className="inline-flex items-center gap-2"><Icon name="Lock" size={16} /> {t("confirmAndLock", "Confirm & Lock")}</span>
                    )}
                  </Button>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t("willSaveTotal", "Will save total:")} <strong className="text-gray-700 dark:text-gray-200">{willSave.toLocaleString()} {currency}</strong>
                    {usingOverride && (
                      <span className="ml-1 text-amber-600 dark:text-amber-400">
                        {t("fromReceiptBreakdownSums", "(from receipt — your breakdown sums to {sum})", { sum: revenueTotal.toLocaleString() })}
                      </span>
                    )}
                  </p>
                  {/* Lock transparency — heads-up that locking ALSO emails the
                      kasserapport to the revisor, so it isn't a surprise. Only
                      when the auto-email toggle is entitled AND on; no blocking
                      modal — the 30-second close stays fast and the anomaly
                      guard already gates misreads. */}
                  {closeAutoEmailEntitled && autoEmailPref && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 text-right max-w-[16rem]">
                      <span className="inline-flex items-start gap-1.5"><Icon name="Mail" size={13} className="mt-0.5 shrink-0" /> {t("lockEmailsRevisorNote", "Locking emails the kasserapport to your revisor.")}</span>
                    </p>
                  )}
                </div>
              );
            })()}
        </div>
        </>)}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   LANE A — Just-locked card (locked-state UI per the doctrine)
   ═══════════════════════════════════════════════════════════
   Renders right after Confirm & Lock fires. Honest about every
   downstream outcome:
     • Email status: sent | queued_retry | skipped_pref | skipped_no_recipient
                     | failed_skipped | skipped_feature_locked
     • Bank-drop reminder: universal (all tiers); dismissible with
       persistence to user.bank_drop_dismissed_ids
     • Push status: Pro-only; falls back gracefully when no subscription
     • Upgrade nudge for Free users — points to Starter

   L9 in the multi-barrier defense: never lie about state. If the email
   couldn't go, the card says so — it doesn't fake a green checkmark.
*/
function JustLockedCard({ t, close, currency, onDismiss, businessType }) {
  const ritual = close.close_ritual || {};
  const closedAt = close.closed_at
    ? new Date(close.closed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
  const closedBy = close.closed_by || (t("staffShort") || "Staff");
  const recipients = (ritual.sent_to || []).join(", ");

  // Local dismiss state for bank-drop — POST to backend so the
  // dismissal sticks across reloads/devices.
  const [bankDropDone, setBankDropDone] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [emailStatus, setEmailStatus] = useState(ritual.email_status);

  const handleBankDropDone = async () => {
    setBankDropDone(true);  // optimistic
    try {
      await api.post(`/daily-close/${close.id}/bank-drop-dismiss`);
    } catch {
      // Non-critical — UI already showed done; let it stand. Worst
      // case: the reminder re-appears on next reload.
    }
  };

  const handleRetryEmail = async () => {
    setRetrying(true);
    try {
      // Re-trigger the auto-email by saving the close again with
      // status=confirmed. Backend's lock handler re-runs the email
      // pipeline. Cheaper than a dedicated /retry-email endpoint.
      const resp = await api.post("/daily-close", {
        date: close.date, branch_id: close.branch_id,
        status: "confirmed",
        revenue_breakdown: close.revenue_breakdown,
        payment_breakdown: close.payment_breakdown,
        moms_total: close.moms_total, moms_mode: close.moms_mode,
        cash_counted: close.cash_counted,
        tips_total: close.tips_total, tips_staff_count: close.tips_staff_count,
        notes: close.notes, closed_by: close.closed_by,
      });
      const newStatus = resp?.data?.close_ritual?.email_status;
      if (newStatus) setEmailStatus(newStatus);
    } catch {
      // Leave status as-is so the retry button stays available
    } finally {
      setRetrying(false);
    }
  };

  // Build the email status row — honest about every state
  let emailLine = null;
  if (emailStatus === "sent") {
    emailLine = (
      <p className="text-sm text-gray-700 dark:text-gray-200">
        <Icon name="Mail" size={14} className="inline align-text-bottom mr-1" /> {(t("closeLockedEmailSent") || "Sent to {recipients}").replace("{recipients}", recipients || "—")}
        {ritual.scan_degraded && (
          <span className="block text-xs text-amber-600 dark:text-amber-400 mt-1">
            <Icon name="AlertTriangle" size={13} className="inline align-text-bottom mr-1" /> {t("closeLockedScanDegraded") || "Z-report photo couldn't be fetched right now — your accountant got the PDF, no photo attached."}
          </span>
        )}
      </p>
    );
  } else if (emailStatus === "queued_retry") {
    emailLine = (
      <div className="text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5"><Icon name="Mail" size={14} /> {t("closeLockedEmailQueued") || "Email queued for retry — we'll keep trying"}</span>
        <button onClick={handleRetryEmail} disabled={retrying}
          className="text-xs px-2.5 py-1 bg-amber-500 text-white rounded-md font-medium hover:bg-amber-600 disabled:opacity-50">
          {retrying ? "..." : (t("closeLockedEmailRetry") || "Retry now")}
        </button>
      </div>
    );
  } else if (emailStatus === "skipped_preference_off") {
    emailLine = (
      <p className="text-sm text-gray-600 dark:text-gray-300">
        <Icon name="BellOff" size={14} className="inline align-text-bottom mr-1" /> {t("closeLockedEmailSkippedPref") || "Auto-email is off in your settings — open Settings to turn it back on"}
      </p>
    );
  } else if (emailStatus === "skipped_no_recipient") {
    emailLine = (
      <p className="text-sm text-amber-700 dark:text-amber-300">
        <Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" /> {t("closeLockedEmailSkippedNoRecipient") || "No owner email on file — set one on Profile to enable auto-send"}
      </p>
    );
  } else if (emailStatus === "failed_skipped") {
    emailLine = (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        <Icon name="Info" size={14} className="inline align-text-bottom mr-1" /> {t("closeLockedEmailFailed") || "Email send is disabled in this environment."}
      </p>
    );
  } else if (emailStatus === "skipped_feature_locked") {
    // App Store compliance (Apple 3.1.1): on native, show a neutral status line
    // with NO upgrade pitch / tier name / CTA. Web keeps the "Upgrade to
    // Starter" conversion nudge below.
    emailLine = isNativeApp() ? (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        <Icon name="Info" size={14} className="inline align-text-bottom mr-1" /> {t("closeLockedAutoSendNativeNote") || "Auto-send on lock isn't part of your current plan. You can still tap Send to revisor manually."}
      </p>
    ) : (
      <div className="text-sm bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-200 dark:border-amber-800">
        <p className="text-amber-800 dark:text-amber-200 font-medium">
          <Icon name="Lightbulb" size={14} className="inline align-text-bottom mr-1" /> {t("closeLockedFreeUpgradeNudge") || "Want the kasserapport auto-sent to your accountant the moment you lock? Upgrade to Starter."}
        </p>
        {canPurchaseInApp() && (
          <a href="/subscription" className="inline-block mt-2 text-xs font-bold text-amber-700 dark:text-amber-300 hover:underline">
            {t("pricingUpgradeStarter") || "Upgrade to Starter"} →
          </a>
        )}
      </div>
    );
  }

  const bankDrop = ritual.bank_drop;
  const showBankDrop = bankDrop && !bankDropDone;

  return (
    <div className="animate-scaleIn">
      <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-xl p-4 sm:p-5 shadow-sm relative">
        <button
          onClick={onDismiss}
          aria-label={t("dismiss", "Dismiss")}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 leading-none"
        >
          <Icon name="X" size={18} />
        </button>
        <div className="flex items-start gap-3">
          <Icon name="CheckCircle2" size={26} className="text-emerald-600 dark:text-emerald-500 shrink-0" />
          <div className="flex-1 space-y-3">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Icon name="Lock" size={14} className="inline align-text-bottom mr-1" /> {(t(closeTitleKeyFor(businessType)) || "Tonight's close — locked at {time} by {who}")
                .replace("{time}", closedAt)
                .replace("{who}", closedBy)}
            </p>
            {emailLine}
            {ritual.push_status === "sent" && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <Icon name="Bell" size={13} className="inline align-text-bottom mr-1" /> {t("closeLockedPushSent") || "Owner notified via push"}
              </p>
            )}
            {showBankDrop && (
              <div className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-amber-200 dark:border-amber-800 flex items-start gap-3">
                <Icon name="Landmark" size={20} className="text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t("bankDropReminderTitle") || "Bank-drop reminder"}
                  </p>
                  <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
                    {(t("bankDropReminderBody") || "Put {amount} {currency} in safe / drop bag. Keep {float} {currency} float in the drawer.")
                      .replace("{amount}", (bankDrop.to_drop_dkk || 0).toLocaleString())
                      .replace("{currency}", currency)
                      .replace("{float}", (bankDrop.leave_in_drawer_dkk || 1000).toLocaleString())}
                  </p>
                  <button onClick={handleBankDropDone}
                    className="mt-2 text-xs px-3 py-1 bg-amber-500 text-white rounded-md font-medium hover:bg-amber-600">
                    {t("bankDropMarkDone") || "Marked as done"}
                  </button>
                </div>
              </div>
            )}
            {bankDropDone && (
              <p className="text-xs text-gray-700 dark:text-gray-300">
                <Icon name="Check" size={13} className="inline align-text-bottom mr-1 text-emerald-600" />{t("bankDropDone") || "In safe"}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   HISTORY VIEW
   ═══════════════════════════════════════════════════════════ */
function HistoryView({ data, currency, t, onRefresh, insights, onEdit, lastLockedClose, onDismissLastLocked }) {
  const { user } = useAuth();
  const [downloading, setDownloading] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [shareToast, setShareToast] = useState("");
  const [unlockId, setUnlockId] = useState(null);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  // ── Date-range export state ──────────────────────────────────
  // The accountant handoff: pick a window (7d / 14d / 1m / 3m /
  // custom), then download all closes in that range as one PDF or
  // one CSV. Default 7 days because that's what most owners want
  // for a weekly review with their bookkeeper.
  //
  // Date math must respect the user's LOCAL timezone — toISOString()
  // returns UTC, which makes a Danish owner closing at 01:14 local
  // (CEST +2 → UTC 23:14 the day before) see "yesterday" as their
  // today. The off-by-one cascades: Last 7 days renders as days 8-1
  // ago and excludes the close just locked.
  const _localIso = (d) => {
    const offsetMs = d.getTimezoneOffset() * 60_000;
    return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10);
  };
  const todayIso = () => _localIso(new Date());
  const isoDaysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return _localIso(d);
  };
  const [rangePreset, setRangePreset] = useState("7d"); // 7d | 14d | 1m | 3m | custom
  const [customFrom, setCustomFrom] = useState(isoDaysAgo(7));
  const [customTo, setCustomTo] = useState(todayIso());
  const [exportingFmt, setExportingFmt] = useState(null); // 'pdf' | 'csv' | 'xlsx' | null
  // Accountant-send format chooser. Persisted so the user doesn't
  // re-pick on every send. Default: xlsx (what most DK accountants
  // actually want — sortable + filterable + pivotable).
  const [accountantFmt, setAccountantFmt] = useState(() => {
    try { return localStorage.getItem("bonbox_accountant_fmt") || "xlsx"; }
    catch { return "xlsx"; }
  });
  const persistAccountantFmt = (fmt) => {
    setAccountantFmt(fmt);
    try { localStorage.setItem("bonbox_accountant_fmt", fmt); } catch {}
  };
  const [exportError, setExportError] = useState("");
  // True iff the last export failure was a plan-cap (402). Drives an
  // inline "Upgrade →" link in the error banner so the user can
  // resolve the issue with one tap rather than reading + navigating.
  const [exportErrorIsCap, setExportErrorIsCap] = useState(false);
  const [sendingToAccountant, setSendingToAccountant] = useState(false);
  const [sendStatus, setSendStatus] = useState(""); // user-facing toast after a send

  // BusinessProfile carries accountant_email + accountant_name.
  // Loaded once so the Send button can pre-fill mailto's To: field
  // and the Danish greeting line ("Hej Anna,"). Failure is silent —
  // the Send button still works, just without a pre-filled recipient.
  const [businessProfile, setBusinessProfile] = useState(null);
  // Plan caps from /billing/me — drives the cap-aware preset
  // buttons (Free=7d / Starter=31d / Pro=full year). Defaults to
  // 366 (the hard ceiling) so before /billing/me responds the UI
  // is permissive rather than restrictive — backend is the
  // authoritative gate either way.
  const [exportCapDays, setExportCapDays] = useState(366);
  const [planTier, setPlanTier] = useState("free");
  // UpgradeNudge state — shown as a dialog when a Free user tries
  // the gated "Send to accountant" feature. Null = no nudge open.
  const [upgradeNudge, setUpgradeNudge] = useState(null);
  useEffect(() => {
    api.get("/business").then(r => setBusinessProfile(r.data)).catch(() => {});
    api.get("/billing/me").then(r => {
      const cap = r.data?.caps?.daily_close_export_days;
      if (typeof cap === "number" && cap > 0) setExportCapDays(cap);
      if (r.data?.plan) setPlanTier(r.data.plan);
    }).catch(() => {});
  }, []);

  // Compute the active (from, to) for whichever preset is selected.
  // "Last N days" = today - (N-1) ... today inclusive. Off-by-one fix:
  // previously `isoDaysAgo(7)` returned the day 7 ago, giving 8 calendar
  // days in the range (and excluding today entirely when combined with
  // the old UTC todayIso bug).
  const activeRange = useMemo(() => {
    const to = todayIso();
    if (rangePreset === "7d") return { from: isoDaysAgo(6), to };
    if (rangePreset === "14d") return { from: isoDaysAgo(13), to };
    if (rangePreset === "1m") return { from: isoDaysAgo(29), to };
    if (rangePreset === "3m") return { from: isoDaysAgo(89), to };
    // Custom: use whatever the user typed; basic guard against
    // inverted ranges so the API doesn't bounce a 422 visibly.
    const f = customFrom > customTo ? customTo : customFrom;
    const t = customFrom > customTo ? customFrom : customTo;
    return { from: f, to: t };
  }, [rangePreset, customFrom, customTo]);

  // Count closes that match the chosen range — gives the user
  // confidence ("Export 14 closes for this range") before they tap.
  const rangeCount = useMemo(
    () => data.filter(dc => dc.date >= activeRange.from && dc.date <= activeRange.to).length,
    [data, activeRange],
  );

  // ── Smart default + empty-range guidance ─────────────────────────
  // Most owners don't close EVERY day, so a fixed "Last 7 days" default
  // frequently lands on an empty window — "0 closes" with greyed-out
  // export buttons reads as broken ("the report doesn't show"). We find
  // the most recent close and, when the default window is empty,
  // auto-advance to the smallest IN-CAP preset that actually contains
  // it. A manual pick always wins and is never overridden; if a chosen
  // range is still empty we show a one-tap "jump to it" hint instead of
  // a silent dead end.
  const mostRecentCloseDate = useMemo(() => {
    if (!data || data.length === 0) return null;
    return data.reduce((m, dc) => (dc.date > m ? dc.date : m), data[0].date);
  }, [data]);

  // Smallest preset (id) whose window both covers `latestIso` AND fits the
  // user's export cap, or null if the close predates every in-cap preset.
  const coveringPreset = (latestIso) => {
    if (!latestIso) return null;
    const daysAgo = Math.floor(
      (Date.parse(todayIso()) - Date.parse(latestIso)) / 86400000,
    );
    // Day counts MUST match the activeRange windows exactly (7d→7, 14d→14,
    // 1m→isoDaysAgo(29)=30, 3m→isoDaysAgo(89)=90). A mismatch (e.g. 1m=31)
    // would resolve a 30-day-old close to "1m", whose window only spans 30
    // days, leaving it empty and the "Show it" jump a no-op dead-end.
    for (const [id, days] of [["7d", 7], ["14d", 14], ["1m", 30], ["3m", 90]]) {
      if (days <= exportCapDays && daysAgo <= days - 1) return id;
    }
    return null;
  };

  const userPickedRange = useRef(false);
  useEffect(() => {
    if (userPickedRange.current) return;     // never override a manual choice
    if (!data || data.length === 0) return;  // nothing to base a default on
    const id = coveringPreset(mostRecentCloseDate) || "7d";
    setRangePreset((prev) => (prev === id ? prev : id));
    // Re-runs when exportCapDays resolves (e.g. Free → 7) so we never auto-land
    // on a preset the user's tier has locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, exportCapDays, mostRecentCloseDate]);

  // One-tap "show my most recent close" — used by the empty-range hint.
  const jumpToMostRecent = () => {
    userPickedRange.current = true;
    const id = coveringPreset(mostRecentCloseDate);
    if (id) {
      setRangePreset(id);
    } else if (mostRecentCloseDate) {
      // Older than any in-cap preset → land a single-day custom range on it.
      setRangePreset("custom");
      setCustomFrom(mostRecentCloseDate);
      setCustomTo(mostRecentCloseDate);
    }
  };

  // MIME types for the three supported export formats. Used both by
  // the download flow (blob() needs the right type for Safari to
  // render correctly) and by the accountant-send flow.
  const _MIME = {
    pdf:  "application/pdf",
    csv:  "text/csv;charset=utf-8",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };

  const downloadRange = async (fmt) => {
    setExportingFmt(fmt);
    setExportError("");
    try {
      const url = `/daily-close/export.${fmt}?from=${activeRange.from}&to=${activeRange.to}`;
      const res = await api.get(url, { responseType: "blob" });
      const blob = new Blob([res.data], { type: _MIME[fmt] || "application/octet-stream" });
      const objectUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `daily-close_${activeRange.from}_to_${activeRange.to}.${fmt}`;
      a.click();
      window.URL.revokeObjectURL(objectUrl);
    } catch (e) {
      // Surface plan-cap (402) with the upgrade CTA distinctly from
      // other failures. The backend returns a structured detail with
      // {code: "plan_cap_exceeded", message, cap_days, plan} that we
      // parse via parseExportError() so the error banner contains
      // the upgrade link inline.
      const parsed = await parseExportError(e);
      setExportError(parsed.message);
      setExportErrorIsCap(parsed.isPlanCap);
      setTimeout(() => { setExportError(""); setExportErrorIsCap(false); }, 8000);
    } finally {
      setExportingFmt(null);
    }
  };

  /**
   * One-tap "Send to accountant" for the chosen date range.
   *
   * Fetches the multi-day PDF, then hands it to
   * sendDailyCloseRangeToAccountant() which:
   *   • on iPhone/Android: opens the native share sheet with the PDF
   *     pre-attached → user picks Mail / WhatsApp / AirDrop → done
   *   • on desktop: downloads the file + opens mailto: with To, Subject
   *     and Danish-language Body pre-filled → user attaches the file
   *
   * Errors during fetch are surfaced through the same exportError
   * state as the regular PDF/CSV downloads — same UI, same messaging.
   */
  const sendToAccountant = async () => {
    setSendingToAccountant(true);
    setExportError("");
    setSendStatus("");
    const fmt = accountantFmt; // honour the user's saved choice

    // ── PRIMARY PATH: server-side direct email via Resend ──
    // If the user has an accountant_email saved, ship the attachment
    // straight from BonBox — no mailto dance, no manual attach. The
    // user's email is set as reply_to so the accountant can hit Reply
    // and reach them directly.
    if (businessProfile?.accountant_email) {
      try {
        const r = await api.post(
          `/daily-close/send-to-accountant?from=${activeRange.from}&to=${activeRange.to}`,
          { fmt, cc_self: true },
        );
        if (r.data?.ok) {
          setSendStatus(
            (t("sentToAccountantOk") || "Sent to") +
            ` ${r.data.sent_to}` +
            (r.data.cc_self ? ` (${t("ccdYou") || "you cc'd"})` : "")
          );
          setTimeout(() => setSendStatus(""), 6000);
          setSendingToAccountant(false);
          return;
        }
      } catch (e) {
        // 503 = email service down (transient or unconfigured).
        // 400 = no accountant email (shouldn't hit here because we
        // checked above, but be defensive). Anything else = treat
        // same as 503 and fall through to the share/mailto fallback.
        const status = e.response?.status;
        if (status === 503 || status === 502 || status === 500) {
          // Fall through to share/mailto silently — the user still
          // gets a working path.
          // (We could surface a toast, but the fallback is good UX.)
        } else if (status === 402) {
          // 402 — plan-required. Two variants:
          //   • feature: "direct_accountant_email" → Free user trying
          //     the new gated feature. Show the UpgradeNudge dialog
          //     instead of an error toast.
          //   • else (date-range cap exceeded) → keep the old upgrade
          //     CTA banner behavior for backwards compatibility.
          const detail = e.response?.data?.detail;
          if (detail?.code === "plan_required" &&
              detail?.feature === "direct_accountant_email") {
            setUpgradeNudge({
              tier: detail.required_plan || "starter",
              benefit: t(
                "nudgeAccountantSend",
                "Email your accountant in one tap"
              ),
              icon: "📤",
            });
            setSendingToAccountant(false);
            return;
          }
          // Existing date-range plan-cap path
          const parsed = await parseExportError(e);
          setExportError(parsed.message);
          setExportErrorIsCap(parsed.isPlanCap);
          setTimeout(() => { setExportError(""); setExportErrorIsCap(false); }, 8000);
          setSendingToAccountant(false);
          return;
        }
        // Otherwise fall through
      }
    }

    // ── FALLBACK PATH: download + share/mailto (existing flow) ──
    // Triggered when no accountant_email is saved, or the direct-email
    // service is down. User still gets a usable path.
    try {
      const url = `/daily-close/export.${fmt}?from=${activeRange.from}&to=${activeRange.to}`;
      const res = await api.get(url, { responseType: "blob" });
      const blob = new Blob([res.data], { type: _MIME[fmt] || "application/octet-stream" });
      const filename = `daily-close_${activeRange.from}_to_${activeRange.to}.${fmt}`;

      // Inherit language from user.language (set in Profile) — defaults
      // to Danish since the recipient is typically a DK accountant.
      const lang = (user?.language === "en") ? "en" : "da";

      const result = await sendDailyCloseRangeToAccountant({
        blob, filename,
        accountantEmail: businessProfile?.accountant_email || "",
        accountantName: businessProfile?.accountant_name || "",
        businessName: user?.business_name || "",
        fromIso: activeRange.from,
        toIso: activeRange.to,
        closeCount: rangeCount,
        language: lang,
      });

      if (result.ok) {
        // Different toast per channel so the user knows what happened.
        if (result.channel === "share") {
          setSendStatus(t("sentViaShare") || "Share sheet opened — pick Mail / WhatsApp");
        } else if (result.channel === "mailto") {
          setSendStatus(
            businessProfile?.accountant_email
              ? (t("sentViaMailto") || "Email opened — attach the downloaded PDF and send")
              : (t("sentViaMailtoNoTo") || "Email opened — add accountant address, attach PDF, send"),
          );
        } else {
          setSendStatus(t("downloadedFallback") || "Downloaded — attach manually to email");
        }
        setTimeout(() => setSendStatus(""), 5000);
      } else {
        setExportError(result.reason || "Could not start the share. Please try the PDF download instead.");
        setTimeout(() => setExportError(""), 5000);
      }
    } catch (e) {
      // Same parser as downloadRange — preserves the plan-cap CTA
      // when the user hits the cap via the Send-to-accountant flow.
      const parsed = await parseExportError(e);
      setExportError(parsed.message);
      setExportErrorIsCap(parsed.isPlanCap);
      setTimeout(() => { setExportError(""); setExportErrorIsCap(false); }, 8000);
    } finally {
      setSendingToAccountant(false);
    }
  };

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

  /**
   * Map a single-terminal DailyClose row to the `aggregated` shape that
   * buildShareMessage() expects from the multi-terminal aggregator.
   * Single-terminal closes have no per-terminal breakdown, so terminals=[]
   * and the payment numbers all come from payment_categories.
   */
  const dcToAggregated = (dc) => {
    // Parse pipe-delimited "cash:4200|card:13500|mobilepay:3150" string
    const parsePayments = (s) => {
      const out = {};
      if (!s) return out;
      for (const pair of String(s).split("|")) {
        const [k, v] = pair.split(":");
        if (k && v != null) out[k.trim().toLowerCase()] = parseFloat(v) || 0;
      }
      return out;
    };
    const pay = parsePayments(dc.payment_categories);
    return {
      closed_by: dc.closed_by || "",
      cash_closing: pay.cash || 0,
      mobilepay_total: pay.mobilepay || pay.mobile_pay || 0,
      gift_cards_total: pay.gift_card || pay.giftcard || 0,
      cards_total: pay.card || pay.cards || 0,
      payments_total: parseFloat(dc.payment_total) || 0,
      sales_pos: parseFloat(dc.revenue_total) || 0,
      cash_difference: parseFloat(dc.cash_difference) || 0,
      cash_diff_flagged: Math.abs(parseFloat(dc.cash_difference) || 0) > 100,
      flagged_reason: null,
      terminals: [],
    };
  };

  const shareDc = async (dc) => {
    setSharing(dc.id);
    setShareToast("");
    try {
      const aggregated = dcToAggregated(dc);
      const dateLabel = formatDanishDateLabel(new Date(dc.date));
      const title = buildShareTitle({
        businessName: user?.business_name,
        dateLabel,
      });
      const text = buildShareMessage(aggregated, {
        businessName: user?.business_name,
        dateLabel,
        currency,
      });
      const res = await shareCloseSummary({ title, text });
      if (res.ok) {
        setShareToast(
          res.channel === "clipboard"
            ? (t("shareCopiedToClipboard") || "Copied to clipboard — paste into your group")
            : (t("shareOpened") || "Share sheet opened"),
        );
        setTimeout(() => setShareToast(""), 3000);
      } else {
        setShareToast(t("shareFailed") || "Could not open share sheet");
        setTimeout(() => setShareToast(""), 4000);
      }
    } catch {
      setShareToast(t("shareFailed") || "Could not open share sheet");
      setTimeout(() => setShareToast(""), 4000);
    } finally {
      setSharing(null);
    }
  };

  if (!data.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <div className="flex justify-center mb-3"><Icon name="ClipboardList" size={36} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="font-semibold dark:text-white">{t("noDailyClosesYet")}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("noDailyClosesYetHint") || "Submit your first end-of-day close to see history here."}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Share-to-team status toast — appears briefly after a Send tap.
          Floats above the list rather than inline so the closer's eye
          isn't pulled away from where they were tapping. */}
      {shareToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-xs font-semibold rounded-full shadow-sm">
          {shareToast}
        </div>
      )}

      {/* ─── Lane A — Just-locked close card ─── */}
      {/* Renders the close_ritual block returned by the lock handler:
          email status (honest — never "sent" when it wasn't), bank-drop
          reminder, push status. Dismissible. */}
      {lastLockedClose && (
        <JustLockedCard
          t={t}
          close={lastLockedClose}
          currency={currency}
          businessType={user?.business_type}
          onDismiss={onDismissLastLocked}
        />
      )}

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
            {activeStreak.title} &mdash; {t("dcCheckInsightsForDetails", "check Insights for details")}
          </p>
        </div>
      )}

      {/* Date-range export panel — accountant handoff.
          Lets the owner pick a window (7d / 14d / 1m / 3m / custom)
          and pull a multi-day PDF or CSV in one click. Distinct from
          the per-close PDF on each row below — this is the
          "send the whole month to my bookkeeper" format. */}
      <div className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <Icon name="Package" size={18} className="text-gray-500 dark:text-gray-400" />
          <h3 className="font-bold dark:text-white text-sm">
            {t("exportToAccountantTitle") || "Export to accountant"}
          </h3>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          {t("exportToAccountantDesc") ||
            "Pick a date range and download all closes as PDF or CSV. CSV is semicolon-delimited + UTF-8 BOM so Danish Excel opens it cleanly."}
        </p>

        {/* Preset buttons — cap-aware. Each preset declares its own
            day count; if it exceeds the user's tier cap, it renders
            disabled with a lock icon + upgrade tooltip. Backend re-checks
            (defense in depth) and returns 402 if anyone bypasses. */}
        <div className="flex flex-wrap gap-2 mb-3">
          {[
            { id: "7d",     label: t("rangePreset7d")  || "Last 7 days",   days: 7 },
            { id: "14d",    label: t("rangePreset14d") || "Last 14 days",  days: 14 },
            { id: "1m",     label: t("rangePreset1m")  || "Last 1 month",  days: 31 },
            { id: "3m",     label: t("rangePreset3m")  || "Last 3 months", days: 90 },
            { id: "custom", label: t("rangePresetCustom") || "Custom",     days: 0 },
          ].map(p => {
            // Custom is always allowed at the button level — the
            // date pickers themselves enforce the cap (max attribute
            // + range validation on submit).
            const locked = p.days > 0 && p.days > exportCapDays;
            const isActive = rangePreset === p.id;
            return (
              <button
                key={p.id}
                onClick={() => { if (!locked) { userPickedRange.current = true; setRangePreset(p.id); } }}
                disabled={locked}
                title={locked
                  // App Store compliance (Apple 3.1.1): native tooltip drops
                  // the "Upgrade to Pro" pitch — factual cap only.
                  ? (isNativeApp()
                      ? (t("planCapTooltipNative") || "Your plan exports up to {days} days.")
                          .replace("{days}", String(exportCapDays))
                      : (t("planCapTooltip") || "{tier} plan exports up to {days} days. Upgrade to Pro for full year.")
                          .replace("{tier}", planTier === "free" ? "Free" : planTier)
                          .replace("{days}", String(exportCapDays)))
                  : ""}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                  locked
                    ? "bg-gray-50 dark:bg-gray-800 text-gray-400 dark:text-gray-500 border-gray-200 dark:border-gray-700 cursor-not-allowed"
                    : isActive
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600 hover:border-gray-300"
                }`}
              >
                {locked && <Icon name="Lock" size={12} className="inline align-text-bottom mr-1" />}
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Plan-cap hint — visible when the user's cap is below the
            year ceiling (i.e. Free or Starter). Links to /subscription
            for the upgrade flow. Hidden for Pro/Business/Trial. */}
        {/* App Store compliance (Apple 3.1.1): on native, drop the tier name
            ("Free plan") + "Upgrade" CTA — show a neutral cap fact. Web keeps
            the tier-labelled hint + upgrade link. */}
        {exportCapDays < 366 && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-700 dark:text-amber-300 flex items-center gap-2">
            <Icon name="Lightbulb" size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
            {isNativeApp() ? (
              <span className="flex-1">
                {t("planCapHintNativePrefix") || "Export covers up to"}{" "}<strong>{exportCapDays} {t("planCapHintDays") || "days"}</strong>.
              </span>
            ) : (
              <span className="flex-1">
                <strong>{planTier === "free" ? "Free" : planTier} {t("planLabelSuffix") || "plan"}</strong>
                {" "}{t("planCapHintMid") || "exports up to"}{" "}<strong>{exportCapDays} {t("planCapHintDays") || "days"}</strong>.
                {canPurchaseInApp() && (
                  <a href="/subscription" className="ml-2 underline font-semibold hover:no-underline">
                    {t("planCapHintCta") || "Upgrade for full year →"}
                  </a>
                )}
              </span>
            )}
          </div>
        )}

        {/* Custom range pickers — shown only when preset === 'custom'.
            The "From" min is computed from the user's tier cap so they
            literally can't pick a date earlier than allowed. "To" is
            today. Backend re-validates (defense in depth). */}
        {rangePreset === "custom" && (
          <div>
            <div className="flex flex-wrap items-end gap-3 mb-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">
                {t("dcRangeFrom", "From")}
                <input
                  type="date"
                  value={customFrom}
                  min={isoDaysAgo(exportCapDays - 1)}
                  max={customTo}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="block mt-1 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-white text-sm"
                />
              </label>
              <label className="text-xs text-gray-500 dark:text-gray-400">
                {t("dcRangeTo", "To")}
                <input
                  type="date"
                  value={customTo}
                  min={customFrom}
                  max={todayIso()}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="block mt-1 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-white text-sm"
                />
              </label>
            </div>
            {/* Custom-range cap hint — shown only if the user's
                custom span exceeds their cap. Useful when they
                manually picked dates further apart than allowed. */}
            {(() => {
              const span = Math.floor(
                (new Date(customTo).getTime() - new Date(customFrom).getTime()) / 86400000
              ) + 1;
              if (span > exportCapDays) {
                return (
                  <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-400">
                    <Icon name="AlertTriangle" size={13} className="inline align-text-bottom mr-1" /> {t("dcRangeExceedsCap", "This range is {span} days — your plan caps at {cap}. The export will be rejected by the server.", { span, cap: exportCapDays })} {canPurchaseInApp() && (<a href="/subscription" className="underline font-semibold">{t("dcUpgradeQuestion", "Upgrade?")}</a>)}
                  </p>
                );
              }
              return null;
            })()}
          </div>
        )}

        {/* Range summary + download buttons */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            <strong className="text-gray-700 dark:text-gray-300">{activeRange.from}</strong>
            {" → "}
            <strong className="text-gray-700 dark:text-gray-300">{activeRange.to}</strong>
            {"  ·  "}
            {rangeCount} {rangeCount === 1
              ? (t("closeSingular") || "close")
              : (t("closePlural") || "closes")}
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            {/* Download buttons — one per format */}
            <button
              onClick={() => downloadRange("xlsx")}
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
              className="px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white text-xs font-semibold flex items-center gap-1 transition"
              title={t("excelTooltip", "Best for your accountant — sortable, filterable, pivotable")}
            >
              {exportingFmt === "xlsx"
                ? <><Icon name="Loader" size={14} className="animate-spin" /> {t("generatingPdfBtn") || "Generating…"}</>
                : <><Icon name="BarChart3" size={14} /> Excel</>}
            </button>
            <button
              onClick={() => downloadRange("pdf")}
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
              className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-800 dark:bg-gray-600 dark:hover:bg-gray-500 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white text-xs font-semibold flex items-center gap-1 transition"
              title={t("pdfTooltip", "One-pager — easy to read, not editable")}
            >
              {exportingFmt === "pdf"
                ? <><Icon name="Loader" size={14} className="animate-spin" /> {t("generatingPdfBtn") || "Generating…"}</>
                : <><Icon name="FileText" size={14} /> PDF</>}
            </button>
            <button
              onClick={() => downloadRange("csv")}
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white text-xs font-semibold flex items-center gap-1 transition"
              title={t("csvTooltip", "Raw data — for e-conomic / Dinero / Billy imports")}
            >
              {exportingFmt === "csv"
                ? <><Icon name="Loader" size={14} className="animate-spin" /> {t("generatingPdfBtn") || "Generating…"}</>
                : <><Icon name="FileSpreadsheet" size={14} /> CSV</>}
            </button>

            {/* Vertical divider + send-to-accountant group */}
            <div className="hidden sm:block w-px h-6 bg-gray-200 dark:bg-gray-700 mx-1" />

            <div className="flex gap-1 items-center">
              <select
                value={accountantFmt}
                onChange={(e) => persistAccountantFmt(e.target.value)}
                disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
                className="px-2 py-1.5 rounded-l-lg border border-amber-300 dark:border-amber-700 dark:bg-gray-800 text-amber-700 dark:text-amber-300 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                title={t("accountantFmtTooltip", "Pick the format your accountant prefers")}
              >
                <option value="xlsx">Excel</option>
                <option value="pdf">PDF</option>
                <option value="csv">CSV</option>
              </select>
              <button
                onClick={sendToAccountant}
                disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
                className="px-3 py-1.5 rounded-r-lg bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white text-xs font-semibold flex items-center gap-1 transition border-l border-amber-700"
                title={
                  businessProfile?.accountant_email
                    ? `${t("sendToTooltip") || "Send to"} ${businessProfile.accountant_email}`
                    : (t("sendToAccountantTooltipNoEmail") || "Send to accountant — set their email on Profile to skip typing it")
                }
              >
                {sendingToAccountant
                  ? <><Icon name="Loader" size={14} className="animate-spin" /> {t("sendingBtn") || "Sending…"}</>
                  : <><Icon name="Send" size={14} /> {t("sendToAccountantBtn") || "Send to revisor"}</>}
              </button>
            </div>
          </div>
        </div>

        {/* Empty-range guidance — when the chosen window has no closes but the
            business HAS closed before, explain WHY it's empty and offer a
            one-tap jump to the most recent close. Without this, "0 closes" +
            greyed buttons reads as a broken report. */}
        {rangeCount === 0 && data.length > 0 && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Icon name="Lightbulb" size={14} className="shrink-0 text-gray-400 dark:text-gray-500" />
            <span className="flex-1">
              {t("dcRangeEmptyHint", "No closes in this window.")}
              {mostRecentCloseDate && (
                <>
                  {" "}
                  {t("dcRangeMostRecent", "Your most recent close was {date}.", {
                    date: new Date(mostRecentCloseDate).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" }),
                  })}
                </>
              )}
            </span>
            {mostRecentCloseDate && (
              <button
                onClick={jumpToMostRecent}
                className="font-semibold text-gray-900 dark:text-white underline hover:no-underline shrink-0"
              >
                {t("dcRangeShowRecent", "Show it →")}
              </button>
            )}
          </div>
        )}

        {/* Hint when no accountant email is saved — points to Profile so
            the next send is one-tap. Hidden once the email is set. */}
        {!businessProfile?.accountant_email && rangeCount > 0 && (
          <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
            <Icon name="Lightbulb" size={12} className="inline align-text-bottom mr-1" /> {t("accountantHint") || "Tip: save your accountant's email on "}
            <a href="/profile" className="text-amber-600 dark:text-amber-400 hover:underline">
              {t("profileLinkLabel") || "Profile"}
            </a>
            {" "}{t("accountantHintTail") || "to skip typing it every time."}
          </p>
        )}

        {sendStatus && (
          <p className="mt-2 text-xs text-emerald-600 dark:text-gray-300 inline-flex items-center gap-1"><Icon name="CheckCircle2" size={14} /> {sendStatus}</p>
        )}

        {exportError && (
          <div className={`mt-2 px-3 py-2 rounded-lg text-xs flex items-start gap-2 ${
            exportErrorIsCap
              ? "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300"
              : "text-red-500 dark:text-red-400"
          }`}>
            <Icon name={exportErrorIsCap ? "Lock" : "AlertTriangle"} size={14} className="shrink-0 mt-0.5" />
            <span className="flex-1">
              {exportError}
              {exportErrorIsCap && canPurchaseInApp() && (
                <a href="/subscription" className="ml-2 underline font-semibold hover:no-underline">
                  {t("dcUpgradeArrow", "Upgrade →")}
                </a>
              )}
            </span>
          </div>
        )}
      </div>

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
          <div key={dc.id} className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold dark:text-white">
                    {new Date(dc.date).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                  </h3>
                  {(dc.status || "confirmed") === "confirmed" ? (
                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-600 dark:text-gray-300 rounded font-semibold inline-flex items-center gap-1"><Icon name="Lock" size={11} /> {t("dcStatusLocked", "Locked")}</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded font-semibold inline-flex items-center gap-1"><Icon name="Pencil" size={11} /> {t("dcStatusDraft", "Draft")}</span>
                  )}
                </div>
                {dc.closed_by && <p className="text-xs text-gray-400">{t("dcClosedBy", "Closed by {name}", { name: dc.closed_by })}</p>}
                {dc.unlock_reason && (
                  <p className="text-xs text-amber-500 mt-0.5">{t("dcUnlockedReason", "Unlocked: {reason}", { reason: dc.unlock_reason })}</p>
                )}
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-emerald-600 dark:text-gray-300">{dc.revenue_total?.toLocaleString()} {currency}</p>
                {revChange !== null && Math.abs(revChange) >= 1 && (
                  <p className={`text-[11px] font-semibold ${revChange > 0 ? "text-emerald-600" : "text-red-500"}`}>
                    {revChange > 0 ? "↑" : "↓"} {Math.abs(revChange)}% {t("dcVsPrev", "vs prev")}
                  </p>
                )}
              </div>
            </div>

            {/* Revenue chips */}
            <div className="flex flex-wrap gap-2 mt-3">
              {Object.entries(rev).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-gray-50 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 rounded-lg text-xs font-medium">
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
                    {t("dcCashLabel", "Cash")}: {dc.cash_difference > 0 ? "+" : ""}{dc.cash_difference?.toLocaleString()}
                  </span>
                )}
                {dc.tips_total > 0 && (
                  <span>{t("tipsLabel", "Tips")}: {dc.tips_total?.toLocaleString()} ({t("dcStaffCountInline", "{count} staff", { count: dc.tips_staff_count })})
                    {tipsChange !== null && Math.abs(tipsChange) >= 1 && (
                      <span className={`ml-1 font-semibold ${tipsChange > 0 ? "text-emerald-600" : "text-red-500"}`}>
                        {tipsChange > 0 ? "↑" : "↓"}{Math.abs(tipsChange)}%
                      </span>
                    )}
                  </span>
                )}
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                {/* Receipt photo thumbnail — when the close was created
                    via the Z-report scan flow, show the original image
                    so the owner can verify what they uploaded. Click
                    opens it full-size in a new tab (signed URL or
                    local path). Bogføringsloven §10 source-document
                    retention made visible. */}
                {dc.receipt_photo && (
                  <a href={dc.receipt_photo} target="_blank" rel="noreferrer"
                    title={t("dcViewOriginalZReport", "View original Z-report photo")}
                    className="inline-flex items-center gap-1.5 text-xs px-2 py-1 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/40 font-medium">
                    <Icon name="Image" size={13} /> {t("dcReceiptLabel", "Receipt")}
                  </a>
                )}
                {/* Locked closes: show Unlock; drafts: show Edit. Both
                    routes reach the same edit experience — Unlock first
                    flips status to draft, then the user picks Edit on
                    the now-draft row. */}
                {(dc.status || "confirmed") === "confirmed" && (
                  <button onClick={() => { setUnlockId(dc.id); setUnlockReason(""); }}
                    className="text-xs px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 font-medium inline-flex items-center gap-1.5">
                    <Icon name="LockOpen" size={13} /> {t("dcUnlock", "Unlock")}
                  </button>
                )}
                {(dc.status || "confirmed") === "draft" && onEdit && (
                  <button onClick={() => onEdit(dc)}
                    className="text-xs px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/40 font-medium inline-flex items-center gap-1.5">
                    <Icon name="Pencil" size={13} /> {t("edit", "Edit")}
                  </button>
                )}
                <button onClick={() => shareDc(dc)} disabled={sharing === dc.id}
                  className="text-xs px-3 py-1.5 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800/50 font-medium disabled:opacity-50 inline-flex items-center gap-1.5">
                  {sharing === dc.id ? "..." : <><Icon name="Send" size={13} /> {t("send") || "Send"}</>}
                </button>
                <button onClick={() => downloadPdf(dc.id, dc.date)} disabled={downloading === dc.id}
                  className="text-xs px-3 py-1.5 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 font-medium dark:text-gray-300 inline-flex items-center gap-1.5">
                  {downloading === dc.id ? "..." : <><Icon name="FileText" size={13} /> PDF</>}
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Unlock modal */}
      {unlockId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setUnlockId(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold dark:text-white mb-1 inline-flex items-center gap-2"><Icon name="LockOpen" size={18} /> {t("dcUnlockModalTitle", "Unlock Daily Close")}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("dcUnlockModalBody", "This will allow editing. Enter a reason for the audit trail.")}
            </p>
            <textarea placeholder={t("dcUnlockReasonPlaceholder", "e.g. Accountant found an error in cash count…")}
              rows={3}
              className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl resize-none mb-4"
              value={unlockReason} onChange={e => setUnlockReason(e.target.value)} />
            <div className="flex gap-3">
              <button onClick={() => setUnlockId(null)}
                className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 rounded-xl font-medium text-sm dark:text-gray-300">
                {t("cancel", "Cancel")}
              </button>
              <button onClick={handleUnlock} disabled={unlocking || !unlockReason.trim()}
                className="flex-1 px-4 py-2.5 bg-amber-500 text-white rounded-xl font-semibold text-sm hover:bg-amber-600 transition disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                {unlocking ? t("dcUnlocking", "Unlocking…") : <><Icon name="LockOpen" size={15} /> {t("dcUnlock", "Unlock")}</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upgrade nudge — shown when a Free user tries the gated
          "Send to accountant" feature. dialog intent renders a
          centered modal with the value sentence + price + try CTA. */}
      {upgradeNudge && (
        <UpgradeNudge
          intent="dialog"
          tier={upgradeNudge.tier}
          benefit={upgradeNudge.benefit}
          icon={upgradeNudge.icon}
          ctaLabel={t("nudgeSeePlans", "See plans")}
          onTry={() => setUpgradeNudge(null)}
        />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   BRANCH SUMMARY VIEW — multi-branch comparison
   ═══════════════════════════════════════════════════════════ */
function BranchSummaryView({ currency }) {
  const { t } = useLanguage();
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
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <div className="flex justify-center mb-3 animate-pulse"><Icon name="Building2" size={36} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="text-sm text-gray-500 dark:text-gray-400">{t("dcLoadingBranchData", "Loading branch data…")}</p>
      </div>
    );
  }

  if (!data || !data.branches?.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <div className="flex justify-center mb-3"><Icon name="Building2" size={36} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="font-semibold dark:text-white">{t("noBranchData")}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("noBranchDataHint") || "Submit daily closes for multiple branches to see comparisons."}</p>
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
          <Icon name="Building2" size={15} /> {t("dcBranchComparison", "Branch Comparison")}
        </h3>
        <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
          {[{ v: "1", l: t("dcRangeToday", "Today") }, { v: "7", l: t("dcRange7Days", "7 days") }, { v: "30", l: t("dcRange30Days", "30 days") }].map(r => (
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
          <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">{t("totalRevenue")}</p>
          <p className="text-lg font-bold text-emerald-600 dark:text-gray-300 mt-0.5">{grand_total.revenue_total?.toLocaleString()}</p>
          <p className="text-[10px] text-gray-400">{currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">{t("cashVariance")}</p>
          <p className={`text-lg font-bold mt-0.5 ${grand_total.cash_diff_total < -200 ? "text-red-500" : "text-gray-700 dark:text-white"}`}>
            {grand_total.cash_diff_total > 0 ? "+" : ""}{grand_total.cash_diff_total?.toLocaleString()}
          </p>
          <p className="text-[10px] text-gray-400">{currency}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-gray-100 dark:border-gray-700 text-center">
          <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">{t("totalTips")}</p>
          <p className="text-lg font-bold text-blue-600 dark:text-blue-400 mt-0.5">{grand_total.tips_total?.toLocaleString()}</p>
          <p className="text-[10px] text-gray-400">{currency}</p>
        </div>
      </div>

      {/* Branch cards */}
      {branches.map((b, i) => {
        const revShare = grand_total.revenue_total > 0 ? Math.round((b.revenue_total / grand_total.revenue_total) * 100) : 0;
        return (
          <div key={b.branch_id || i} className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold dark:text-white">{b.branch_name}</h3>
                  {i === 0 && branches.length > 1 && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-600 dark:text-gray-300 rounded font-semibold">{t("dcTopBadge", "Top")}</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-0.5">{b.days_count === 1
                  ? t("dcBranchClosesAvgOne", "{count} close · avg {avg}/day", { count: b.days_count, avg: b.avg_daily_revenue?.toLocaleString() })
                  : t("dcBranchClosesAvgMany", "{count} closes · avg {avg}/day", { count: b.days_count, avg: b.avg_daily_revenue?.toLocaleString() })}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-emerald-600 dark:text-gray-300">{b.revenue_total?.toLocaleString()} <span className="text-xs font-normal text-gray-400">{currency}</span></p>
                <p className="text-[10px] text-gray-400">{t("dcPctOfTotal", "{pct}% of total", { pct: revShare })}</p>
              </div>
            </div>

            {/* Revenue share bar */}
            <div className="mt-3 h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 dark:bg-emerald-500 rounded-full transition-all" style={{ width: `${revShare}%` }} />
            </div>

            {/* Metrics row */}
            <div className="flex gap-4 mt-3 text-xs text-gray-500 dark:text-gray-400">
              <span>{t("dcCashLabel", "Cash")}: <span className={b.cash_diff_total < -100 ? "text-red-500 font-semibold" : ""}>{b.cash_diff_total > 0 ? "+" : ""}{b.cash_diff_total?.toLocaleString()}</span></span>
              {b.tips_total > 0 && <span>{t("tipsLabel", "Tips")}: {b.tips_total?.toLocaleString()}</span>}
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
  const { t } = useLanguage();
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
        if (v <= p25) return "bg-gray-200 dark:bg-gray-800";
        if (v <= p50) return "bg-emerald-300 dark:bg-gray-800";
        if (v <= p75) return "bg-emerald-500 dark:bg-gray-900";
        return "bg-gray-800 dark:bg-emerald-500";
      };
    }
    // Cash variance mode
    return (dc) => {
      if (!dc) return "bg-gray-100 dark:bg-gray-800";
      const diff = dc.cash_difference;
      if (diff === null || diff === undefined) return "bg-gray-200 dark:bg-gray-700";
      if (diff >= 0) return "bg-emerald-300 dark:bg-gray-800";
      if (diff >= -100) return "bg-amber-300 dark:bg-amber-700";
      if (diff >= -300) return "bg-orange-400 dark:bg-orange-600";
      return "bg-red-500 dark:bg-red-500";
    };
  }, [data, mode]);

  const legendItems = mode === "revenue"
    ? [
        { color: "bg-gray-200 dark:bg-gray-700", label: t("dcLegendNone", "None") },
        { color: "bg-gray-200 dark:bg-gray-800", label: t("dcLegendLow", "Low") },
        { color: "bg-emerald-500 dark:bg-gray-900", label: t("dcLegendMid", "Mid") },
        { color: "bg-gray-800 dark:bg-emerald-500", label: t("dcLegendHigh", "High") },
      ]
    : [
        { color: "bg-gray-200 dark:bg-gray-700", label: t("dcLegendNA", "N/A") },
        { color: "bg-emerald-300 dark:bg-gray-800", label: t("dcLegendEvenPlus", "Even/+") },
        { color: "bg-amber-300 dark:bg-amber-700", label: "-100" },
        { color: "bg-red-500 dark:bg-red-500", label: t("dcLegendShort", "Short") },
      ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
      {/* Header + mode toggle */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm dark:text-white flex items-center gap-1.5">
          <Icon name="Calendar" size={15} /> {t("dcHeatmap90DayOverview", "90-Day Overview")}
        </h3>
        <div className="flex gap-0.5 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
          {[{ id: "revenue", label: t("dcHeatmapRevenueMode", "Revenue") }, { id: "cash", label: t("dcHeatmapCashMode", "Cash +/-") }].map(m => (
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
              {new Date(hovered.ds + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" })}
            </span>
            {hovered.dc ? (
              mode === "revenue"
                ? <> &mdash; {hovered.dc.revenue_total?.toLocaleString()} {currency}</>
                : <> &mdash; {t("dcHeatmapCashLabel", "Cash")}: {hovered.dc.cash_difference !== null && hovered.dc.cash_difference !== undefined
                    ? `${hovered.dc.cash_difference > 0 ? "+" : ""}${hovered.dc.cash_difference?.toLocaleString()} ${currency}`
                    : t("dcHeatmapNA", "N/A")}</>
            ) : <> &mdash; {t("dcHeatmapNoClose", "No close")}</>}
          </p>
        ) : (
          <p className="text-[10px] text-gray-400 dark:text-gray-500">{t("hoverDayForDetails")}</p>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[9px] text-gray-400">{t("dcHeatmapLess", "Less")}</span>
        {legendItems.map((l, i) => (
          <div key={i} className={`w-2.5 h-2.5 rounded-[2px] ${l.color}`} title={l.label} />
        ))}
        <span className="text-[9px] text-gray-400">{t("dcHeatmapMore", "More")}</span>
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
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <div className="flex justify-center mb-3"><Icon name="Lightbulb" size={36} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="font-semibold dark:text-white">{t("notEnoughDataYet")}</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("notEnoughDataHint") || "Submit a few daily closes to unlock insights about your revenue, tips, and cash handling."}</p>
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
        <SummaryCard label={t("dcInsightsAvgDailyRevenue", "Avg Daily Revenue")} value={`${summary.avg_daily_revenue?.toLocaleString()} ${currency}`} />
        <SummaryCard label={t("dcInsightsTotalTips90d", "Total Tips (90d)")} value={`${summary.total_tips?.toLocaleString()} ${currency}`} />
        <SummaryCard label={t("dcInsightsCashDrift90d", "Cash Drift (90d)")} value={`${summary.total_cash_difference > 0 ? "+" : ""}${summary.total_cash_difference?.toLocaleString()} ${currency}`}
          color={summary.total_cash_difference < -200 ? "red" : "green"} />
      </div>

      {/* Regular insight cards */}
      {regularInsights.map((ins, i) => (
        <div key={i} className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="text-2xl">{ins.icon}</span>
            <div>
              <h3 className="font-bold dark:text-white">{ins.title}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{ins.detail}</p>
              {ins.benchmark && (
                <p className="text-xs text-gray-400 mt-2">{t("dcInsightsIndustryBenchmark", "Industry benchmark")}: {ins.benchmark}</p>
              )}
            </div>
          </div>
        </div>
      ))}

      {insights.length === 0 && (
        <div className="text-center text-gray-400 text-sm py-8">
          {t("dcInsightsKeepLogging", "Keep logging daily closes to unlock more insights.")}
        </div>
      )}
    </div>
  );
}

function StreakAlertCard({ alert, currency }) {
  const { t } = useLanguage();
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
    <div className={`rounded-xl p-5 border-2 ${s.border} ${s.bg} shadow-sm`}>
      <div className="flex items-start gap-3">
        <span className="text-2xl">{alert.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`font-bold ${s.title}`}>{alert.title}</h3>
            {alert.is_active && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${s.badge}`}>
                {t("dcStreakActiveBadge", "Active")}
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
              {t("dcStreakConsecutiveDays", "{count} consecutive days", { count: alert.streak_length })} &middot; {alert.streak_total?.toLocaleString()} {currency}
            </span>
          </div>

          {alert.total_streaks > 1 && (
            <p className="text-xs mt-2 text-gray-400 dark:text-gray-500">
              {t("dcStreakSeparateShortages", "{count} separate shortage streaks detected in last 90 days", { count: alert.total_streaks })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  const c = color === "red" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-gray-300";
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-lg font-bold mt-1 ${color ? c : "dark:text-white"}`}>{value}</p>
    </div>
  );
}
