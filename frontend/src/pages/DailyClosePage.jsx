import { useState, useEffect, useMemo, useRef } from "react";
import { dateLocale, businessTodayIso, formatDateClear, localIso } from "../utils/dateFormat";
import { Link, useLocation, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useBranch } from "../components/BranchSelector";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency, formatOwnerMoney, getTaxConfig, getVatTerms, isMoneyRejected, moneyLocale, parseMoneyInput } from "../utils/currency";
import { trackEvent } from "../hooks/useEventLog";
import DismissibleTip from "../components/DismissibleTip";
import { safeImageUrl } from "../utils/safeUrl";
import { errText } from "../utils/errText";
import { useConfirm } from "../hooks/useConfirm";
import { resizeImageIfLarge } from "../utils/resizeImage";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";
import { haptic } from "../utils/haptics";
import { archetypeForUser, archetypeIdFor } from "../config/archetypes";
import {
  addToOfflineQueue,
  firstNeedingConfirmation,
  getOfflineQueue,
  queueSummary,
  removeFromOfflineQueue,
  syncOfflineQueue,
  updateQueueItem,
  QUEUE_ALREADY_SAVED,
  QUEUE_ERR_REJECTED,
  QUEUE_ERR_SERVER,
  QUEUE_FAILED,
  QUEUE_NEEDS_CONFIRMATION,
} from "../utils/dailyCloseQueue";
import {
  headlineTotal,
  mergeScans,
  needsTerminalChoice,
  MERGE_FILL,
  MERGE_REPLACE,
  MERGE_SUM,
} from "../utils/dailyCloseScanMerge";
import { DEFAULT_CLOSE_CUTOFF_HOUR, findConfirmedCloseFor, resolveCutoffHour } from "../utils/dailyCloseDay";
import {
  buildShareMessage,
  buildShareTitle,
  formatDanishDateLabel,
  shareCloseSummary,
} from "../utils/shareClose";
import { sendDailyCloseRangeToAccountant } from "../utils/shareDailyCloseRange";
import { saveFile } from "../utils/download";
// Task #120 polish (Agent D): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
// Amount is the money-render primitive and the ONLY way a figure reaches the
// screen on this page. Every money render here used to be a bare
// `toLocaleString()`, which formats in the BROWSER locale: on an EN-locale
// machine (a MacBook bought abroad, a Chrome profile in English — common in
// DK) 17030 rendered "17,030" and a Dane reads the comma as a DECIMAL
// separator: seventeen kroner and three øre, on the one surface that produces
// the revisor's number. Amount/formatOwnerMoney pin da-DK and the "kr." token,
// and render a missing value as "—" instead of a confident 0.
// NOT importing Card, deliberately: this page's 17 hand-rolled card surfaces
// are `dark:bg-gray-800`, and the Card primitive's dark surface is gray-900 —
// which IS the dark page ground (#111827, `.dark body` in index.css), so a Card
// there is defined only by its 1px border. Converting SOME of them would split
// the page into two different dark surfaces, and converting all seventeen is a
// bigger change than a surface pass should make in one go. See the report.
import { UpgradeNudge, PageHeader, TabPills, Button, Icon, SectionBanner, Amount, StatCard, LoadFailed } from "../components/ui";
// Three outcomes, not two — the same rule the money primitives already enforce
// for a missing FIGURE ("—", never a confident 0), applied to a missing LIST.
// `/daily-close` and `/daily-close/insights` were `.catch(() => {})`, so a
// request that never came back left `history` at `[]` and the History tab told
// an owner with a year of closes to "submit your first end-of-day close" — and
// because today's lock status is derived from that same array, the page also
// concluded today was NOT locked and re-offered a close it had already sealed.
// useAsyncData keeps the last true rows through a failed reload and reports
// `failed` separately; LoadFailed is what that state says out loud.
import { useAsyncData } from "../hooks/useAsyncData";
import PageShell from "../components/ui/PageShell";
import Chip from "../components/ui/Chip";
import MoneyField from "../components/ui/MoneyField";
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
   OFFLINE QUEUE — see utils/dailyCloseQueue.js
   ═══════════════════════════════════════════════════════════ */
/* The queue used to live here as three inline helpers, which meant it could
   never be unit-tested (eslint react-refresh forbids exporting non-components
   from a page file) — and it was losing closes: a failure mid-queue destroyed
   every item behind it, and a 200 {requires_confirmation} counted as sent.
   It now lives in its own module with the poster injected, so every one of
   those paths is pinned by a test. */
const postClose = (payload) => api.post("/daily-close", payload);

/* ═══════════════════════════════════════════════════════════
   DECIMAL POLICY — one rule, stated once
   ═══════════════════════════════════════════════════════════
   LEDGER (two decimals) is for the REVIEW step and the save preview beside it,
   plus the revisor note buildPayload persists. That is the surface that becomes
   the document: the kasserapport PDF the server generates renders two decimals
   (see formatMoney's contract in utils/currency.js — the "#148 MEDIUM-11 drift"
   it cites is precisely a screen and a PDF disagreeing about øre for the same
   row), so the review card has to tie out against it line for line.

   GLANCE (whole kroner) is everything else: the scan card the owner checks
   against the paper in their hand, the running totals on the entry steps, the
   POS-sync banners, history rows, the 90-day heat map, insights, the branch
   comparison. Øre there costs a scan of the column and buys nothing, and whole
   kroner is what those surfaces already showed.

   Named constants rather than a bare 0/2 at fifty call sites, so the next
   person changing one surface can see which family it belongs to and cannot
   half-migrate a card into mixed precision — a row and its own card total are
   never allowed to disagree. */
const LEDGER_DECIMALS = 2;
const GLANCE_DECIMALS = 0;

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
  // The two reads the whole page is built on. Declared HERE rather than beside
  // the old fetchHistory/fetchInsights further down, because doSync() and
  // confirmQueuedClose() below both refresh them and a `const` referenced
  // before its own line is a TDZ error the moment either is called.
  //
  // `initial: []` keeps every `data.length` / `.filter` call site working
  // unchanged; `failed` is the new fact, and it is rendered, never swallowed.
  const historyQ = useAsyncData(() => api.get("/daily-close"), [], { initial: [] });
  const insightsQ = useAsyncData(() => api.get("/daily-close/insights"), []);
  // useMemo, not a bare `|| []`: `history` is a dependency of the lock-status
  // useMemo below, and a fresh array identity every render would re-run it
  // every render.
  const history = useMemo(() => historyQ.data || [], [historyQ.data]);
  const insights = insightsQ.data;
  const fetchHistory = historyQ.reload;
  const fetchInsights = insightsQ.reload;
  const [loading, setLoading] = useState(false);
  // Lane A — when CloseForm successfully locks a close, the parent
  // captures the close_ritual block returned by the backend (auto-
  // email status, scan attached, bank-drop hint, etc.) so we can
  // render the locked-state card at the top of the History tab. The
  // card stays until the user dismisses it or navigates away.
  const [lastLockedClose, setLastLockedClose] = useState(null);

  // Offline resilience
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  // The whole queue, not just its length: "waiting for the network" and
  // "waiting for YOUR confirmation" are two different promises to the owner
  // and a single count cannot tell them apart. A close blocked on the anomaly
  // guard used to be invisible (and, before that, deleted).
  const [queue, setQueue] = useState(() => getOfflineQueue());
  const queueCounts = useMemo(() => queueSummary(queue), [queue]);
  const pendingCount = queueCounts.total;
  // The queued close the owner is currently reviewing in the anomaly dialog.
  const [reviewItem, setReviewItem] = useState(null);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState("");

  // One sync at a time. Two overlapping runs would each POST the same close
  // (the second gets a 409 and now says "already saved", which is merely
  // noisy) — but more importantly the "online" listener and a double-tapped
  // Sync button are one gesture apart, and concurrency around money is not
  // something to leave to the merge logic alone.
  const syncInFlight = useRef(false);
  const [syncing, setSyncing] = useState(false);

  const doSync = async () => {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    try {
      const res = await syncOfflineQueue(postClose);
      setQueue(res.remaining);
      // Refresh whenever anything actually landed — a queue that still holds an
      // item awaiting confirmation may STILL have synced three others.
      if (res.synced > 0 || res.total === 0) { fetchHistory(); fetchInsights(); }
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  };

  /**
   * The Danish sentence for a close the server refused. The queue stores a
   * CODE, never a sentence: an English string baked into the item would show
   * up untranslated on the one surface that says money was not saved. The raw
   * server text rides along as secondary detail for the owner's revisor.
   */
  const queueErrorText = (it) => (
    it?.errorCode === QUEUE_ERR_SERVER
      ? t("dcQueueErrServer", "BonBox could not receive it just now. It is still on this phone — try again in a moment.")
      : t("dcQueueErrRejected", "The kasserapport was refused. Check the numbers and file this date again.")
  );

  /** Drop a queued copy the owner no longer needs (it is already in the books). */
  const dropQueuedClose = (item) => {
    if (!item) return;
    setQueue(removeFromOfflineQueue(item.id));
  };

  /**
   * The owner acknowledged the anomaly on a QUEUED close. This is the only
   * place acknowledge_anomaly is ever added to a queued payload — never the
   * sync loop, which would walk past a money guard nobody had read.
   */
  const confirmQueuedClose = async (item) => {
    if (!item) return;
    setReviewSaving(true);
    setReviewError("");
    try {
      await postClose({ ...item.payload, acknowledge_anomaly: true });
      setQueue(removeFromOfflineQueue(item.id));
      setReviewItem(null);
      fetchHistory();
      fetchInsights();
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch (err) {
      // Still not saved — keep the close, keep the reason, keep the dialog.
      const status = err?.response?.status ?? null;
      if (!err?.response) {
        setReviewError(t("dcQueueErrOffline", "No connection right now. The kasserapport is still on this phone — try again when you're back online."));
        setQueue(updateQueueItem(item.id, { state: QUEUE_NEEDS_CONFIRMATION }));
      } else if (status === 409) {
        // The owner already filed this date in the wizard (which is exactly
        // what our own "cancel and re-open the date" note tells them to do).
        // The money is in the books; this copy is now a duplicate.
        setReviewError(t("dcQueueErrLocked", "This date is already locked in your kasserapport, so nothing was changed. You can remove this copy."));
        setQueue(updateQueueItem(item.id, {
          state: QUEUE_ALREADY_SAVED, errorCode: null,
          errorDetail: errText(err, ""), httpStatus: status,
        }));
      } else {
        const code = status >= 500 ? QUEUE_ERR_SERVER : QUEUE_ERR_REJECTED;
        setReviewError(code === QUEUE_ERR_SERVER
          ? t("dcQueueErrServer", "BonBox could not receive it just now. It is still on this phone — try again in a moment.")
          : t("dcQueueErrRejected", "The kasserapport was refused. Check the numbers and file this date again."));
        setQueue(updateQueueItem(item.id, {
          state: QUEUE_FAILED, errorCode: code,
          errorDetail: errText(err, ""), httpStatus: status,
        }));
      }
    } finally {
      setReviewSaving(false);
    }
  };

  useEffect(() => {
    const goOn = () => { setIsOnline(true); doSync(); };
    const goOff = () => setIsOnline(false);
    window.addEventListener("online", goOn);
    window.addEventListener("offline", goOff);
    return () => { window.removeEventListener("online", goOn); window.removeEventListener("offline", goOff); };
  }, []);

  // (fetchHistory / fetchInsights are useAsyncData's `reload`, declared above
  // with the reads themselves. The initial load is the hook's own effect, so
  // the mount effect that used to live here is gone.)

  // #150 merge — surface today's confirmed close (if any) at the very top
  // of the page so an owner who already locked sees the success summary
  // immediately, regardless of which tab is active. We derive this from
  // `history` (already fetched above) so no extra API call is needed.
  // The same JustLockedCard component is used for both the in-session
  // lock and the cross-visit re-entry case — single source of truth.
  //
  // The day we ask for is the BUSINESS day, not the UTC calendar day. This
  // line used to read `new Date().toISOString().slice(0, 10)`, which is wrong
  // twice over: UTC (a Dane closing at 01:14 CEST is already "yesterday" in
  // UTC) and calendar-based (the close is filed against the 06:00 business
  // day). A bar locking at 03:00 and reloading watched its own close vanish
  // from the top of the page and was invited to close the day again.
  const todayIso = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
  const todaysConfirmedClose = useMemo(
    () => findConfirmedCloseFor(history, todayIso),
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
  // …and the third outcome for the lock itself. `isLockedToday === false` used
  // to mean two different things: "the list came back and today is not in it"
  // and "the list never came back", and the page rendered the reassuring one —
  // no locked banner, a plain "Close the day" CTA, no hint that it had not
  // managed to ask. An owner who locked at 23:40 on a flaky connection was
  // invited to close the day a second time as if the first had not happened.
  //
  // NOT a reason to take the CTA away: this page closes the day OFFLINE on
  // purpose (handleSubmit queues when navigator.onLine is false), so a failed
  // GET is the normal state on a phone in a basement and the primary action has
  // to stay exactly where it was. The only change is that the page now says it
  // could not check — and a duplicate is refused by the server (409) rather
  // than double-counted, which is the fact that makes the CTA safe to tap.
  const lockStatusUnknown = historyQ.failed && !isLockedToday;

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
        // No eyebrow. It said "RAPPORTER" — the group this page has not been
        // in since the C5 nav diet moved it onto the core spine (navManifest
        // declares it pillar: null), so it was a stale label sitting above the
        // title and reading as a SECOND name for the same thing. The eyebrow's
        // job on sibling pages is to name the pillar; there is no pillar to
        // name here, so the page keeps one name and nothing above it.
        title={t("navToday") || "Kasserapport"}
        subtitle={t(todaySubtitleKey)}
        actions={
          (!isOnline || pendingCount > 0) && (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {!isOnline && (
                <span className="text-[11px] px-2 py-1 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full font-semibold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-gray-500 rounded-full" /> {t("dcOffline", "Offline")}
                </span>
              )}
              {/* Waiting on the NETWORK — the owner can only wait, or tap
                  Sync once the connection is back. */}
              {queueCounts.waitingNetwork > 0 && (
                <Button variant="secondary" size="sm" onClick={doSync} disabled={!isOnline || syncing}>
                  {!isOnline
                    ? t("dcQueuedNetwork", "{count} waiting for network", { count: queueCounts.waitingNetwork })
                    : syncing
                      ? t("dcSyncRunning", "Sending…")
                      : t("dcSyncPending", "Sync {count} pending", { count: queueCounts.waitingNetwork })}
                </Button>
              )}
              {/* Waiting on the OWNER — a close the anomaly guard stopped.
                  Nothing will ever send it until they look at it, so it gets
                  its own amber, tappable chip instead of hiding inside a
                  "pending" count that implies the app is handling it. */}
              {queueCounts.needsConfirmation > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="!bg-amber-50 dark:!bg-amber-900/20 !text-amber-700 dark:!text-amber-300 !border-amber-200 dark:!border-amber-800"
                  onClick={() => { setReviewError(""); setReviewItem(firstNeedingConfirmation(queue)); }}
                  iconLeft={<Icon name="AlertTriangle" size={14} />}
                >
                  {t("dcQueuedNeedsConfirm", "{count} waiting for your confirmation", { count: queueCounts.needsConfirmation })}
                </Button>
              )}
              {queueCounts.failed > 0 && (
                <Button variant="secondary" size="sm" onClick={doSync} disabled={!isOnline || syncing}
                  className="!bg-red-50 dark:!bg-red-900/20 !text-red-600 dark:!text-red-400 !border-red-200 dark:!border-red-800"
                  iconLeft={<Icon name="AlertTriangle" size={14} />}>
                  {t("dcQueuedFailed", "{count} couldn't be saved — retry", { count: queueCounts.failed })}
                </Button>
              )}
              {/* Already in the books. NOT red and NOT a retry — a close the
                  server has locked is money that is safe; the only thing left
                  is to clear the spare copy off the phone. */}
              {queueCounts.alreadySaved > 0 && (
                <span className="text-[11px] px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full font-semibold">
                  {t("dcQueuedAlreadySaved", "{count} already saved", { count: queueCounts.alreadySaved })}
                </span>
              )}
            </div>
          )
        }
      />

      {/* ─── Queued closes that need the owner, not the network ───
          A close held back by the anomaly guard, or refused by the server,
          is money that is NOT in the books. It gets a named row with the
          date, the reason, and one tap to the same double-check dialog the
          wizard uses — never a silent counter. */}
      {(queueCounts.needsConfirmation > 0 || queueCounts.failed > 0 || queueCounts.alreadySaved > 0) && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-3">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
            <Icon name="AlertTriangle" size={16} />
            {t("dcQueueBlockedTitle", "Not saved yet")}
          </p>
          {queue.filter((it) => it.state === QUEUE_NEEDS_CONFIRMATION || it.state === QUEUE_FAILED
            || it.state === QUEUE_ALREADY_SAVED).map((it) => (
            <div key={it.id} className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
              <div className="min-w-0 text-xs text-amber-900 dark:text-amber-200">
                <span className="font-semibold">{formatDateClear(it.payload?.date) || it.payload?.date}</span>
                {" — "}
                {it.state === QUEUE_NEEDS_CONFIRMATION
                  ? t("dcQueueBlockedAnomaly", "the numbers look unusual, so nothing was saved. Take a look before it locks.")
                  : it.state === QUEUE_ALREADY_SAVED
                    ? t("dcQueueErrLocked", "This date is already locked in your kasserapport, so nothing was changed. You can remove this copy.")
                    : queueErrorText(it)}
                {/* The server's own wording, kept as secondary detail for the
                    owner's revisor — never as the headline, because it is
                    English and this is the Danish audit trail. */}
                {it.errorDetail && it.state === QUEUE_FAILED && (
                  <span className="block mt-0.5 opacity-70">{it.errorDetail}</span>
                )}
              </div>
              {it.state === QUEUE_NEEDS_CONFIRMATION && (
                <Button variant="secondary" size="sm"
                  onClick={() => { setReviewError(""); setReviewItem(it); }}>
                  {t("dcQueueReviewCta", "Review")}
                </Button>
              )}
              {/* Every row that is NOT waiting on the owner's confirmation gets
                  a way out. Without it a close the server already holds sits
                  under a permanent alarm with no button at all. */}
              {it.state !== QUEUE_NEEDS_CONFIRMATION && (
                <Button variant="secondary" size="sm" onClick={() => dropQueuedClose(it)}
                  iconLeft={<Icon name="Trash2" size={14} />}>
                  {t("dcQueueRemoveCopy", "Remove this copy")}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The wizard's own double-check dialog, re-used for a QUEUED close.
          Same component, same words, same guard — the only difference is
          that the payload comes from the device instead of the form. */}
      {reviewItem && (
        <CloseAnomalyDialog
          t={t}
          anomaly={reviewItem.anomaly || {}}
          dateLabel={formatDateClear(reviewItem.payload?.date) || reviewItem.payload?.date || ""}
          saving={reviewSaving}
          error={reviewError}
          extraNote={t("dcQueueReviewEdit", "Want to change the numbers? Cancel, then open this date in the kasserapport — this copy stays on your phone until it is saved.")}
          onCancel={() => { setReviewItem(null); setReviewError(""); }}
          onConfirm={() => confirmQueuedClose(reviewItem)}
        />
      )}

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
            {/* "We could not check", said out loud — and in the offline wording
                when that is the actual reason, because "something went wrong"
                is not true of a phone with no signal. The buttons above stay
                live either way: closing the day is the thing the owner came
                here to do, and the server refuses a duplicate. */}
            {lockStatusUnknown && (
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 flex items-start gap-1.5">
                <Icon name="AlertTriangle" size={13} className="shrink-0 mt-0.5" />
                <span>
                  {isOnline
                    ? t("dcLockCheckFailed", "We couldn't check whether today's kasserapport is already locked. You can still close the day — if it is already locked, the save is refused and nothing changes.")
                    : t("dcLockCheckOffline", "You're offline, so we can't check whether today's kasserapport is already locked. Close the day as usual — it's kept on this phone and sent when you're back online.")}
                  {isOnline && (
                    <>
                      {" "}
                      <button type="button" onClick={fetchHistory}
                        className="font-semibold underline underline-offset-2 hover:no-underline">
                        {t("tryAgain")}
                      </button>
                    </>
                  )}
                </span>
              </p>
            )}
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
          { id: "close", label: t("newClose", "New kasserapport") },
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
          onQueued={() => { setQueue(getOfflineQueue()); setTab("history"); }} />}
        {tab === "history" && <HistoryView data={history} currency={currency} t={t} onRefresh={fetchHistory} insights={insights}
          // The three outcomes, handed down whole. A child that only receives
          // `data` cannot tell an empty list from an unanswered request, which
          // is exactly how the first-run empty state reached a year-old venue.
          loading={historyQ.loading} failed={historyQ.failed} isOnline={isOnline}
          // #150 — the locked-today card now renders at the top of the
          // page (above LiveKpisToday). Don't render it inside History
          // too, otherwise the same banner shows twice. The History
          // tab keeps showing the in-list per-close summary as before.
          lastLockedClose={null}
          onDismissLastLocked={() => setLastLockedClose(null)}
          onEdit={(dc) => { setEditDraft(dc); setTab("close"); }} />}
        {tab === "insights" && <InsightsView data={insights} currency={currency} t={t}
          loading={insightsQ.loading} failed={insightsQ.failed} isOnline={isOnline}
          onRetry={fetchInsights} />}
        {tab === "branches" && <BranchSummaryView currency={currency} />}
      </div>
    </PageShell>
  );
}


/* ═══════════════════════════════════════════════════════════
   CLOSE ANOMALY DOUBLE-CHECK DIALOG
   ═══════════════════════════════════════════════════════════ */
/**
 * The close_sanity soft guard, as one dialog.
 *
 * Two callers, one set of words: the wizard (the owner is standing in front
 * of the form) and the page header (the same guard tripped on a close that
 * synced from the offline queue hours later). Extracted so the queued case
 * cannot drift into a second, weaker warning — it is the same money guard.
 *
 * Deliberately has no "lock it anyway" shortcut of its own: `onConfirm` is
 * the ONLY path that sends acknowledge_anomaly, and it is always a tap.
 */
/**
 * `dateLabel` is required whenever the close being acknowledged is NOT the one
 * the owner is looking at. The message templates say "Dagens total" — true in
 * the wizard, where the date is on screen a few rows up, and false for a
 * QUEUED close, which by construction sat on the device through an offline
 * stretch and can be any business date. Acknowledging a money guard without
 * knowing which day it locks is not an acknowledgement.
 */
function CloseAnomalyDialog({ t, anomaly, saving, onCancel, onConfirm, error = "", extraNote = "", dateLabel = "" }) {
  const a = anomaly || {};
  const pct = Math.abs(Math.round((a.delta_pct || 0) * 100));
  // Numbers only, grouped da-DK. NOT formatOwnerMoney/formatKr here: the
  // closeAnomaly*Msg templates already carry the unit ("{today} kr"), so a
  // formatter that appends "kr." would print "17.030 kr. kr". The locale is
  // pinned explicitly for the same reason the money primitives exist — a bare
  // toLocaleString() uses the BROWSER locale and renders 17030 as "17,030",
  // which a Dane reads as seventeen kroner.
  const today = Math.round(a.today_total || 0).toLocaleString("da-DK");
  const avg = Math.round(a.baseline_avg || 0).toLocaleString("da-DK");
  const msgKey = a.reason === "high" ? "closeAnomalyHighMsg" : "closeAnomalyLowMsg";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      {/* shadow-sm, not one of the heavy tiers: the unlock modal three hundred lines down
          already uses shadow-sm, the doctrine bans the heavy tiers, and the
          black/40 overlay is what actually lifts a dialog off the page. */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm max-w-md w-full p-5 sm:p-6 animate-fadeIn">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center"><Icon name="AlertTriangle" size={20} className="text-amber-600 dark:text-amber-400" /></div>
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold text-gray-900 dark:text-white">{t("closeAnomalyTitle")}</h3>
            {dateLabel && (
              <p className="mt-0.5 text-xs font-semibold text-gray-500 dark:text-gray-400">
                {t("dcAnomalyForDate", "Kasserapport for {date}", { date: dateLabel })}
              </p>
            )}
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{t(msgKey, { today, pct, avg })}</p>
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{t("closeAnomalyHint")}</p>
            {extraNote && <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{extraNote}</p>}
            {error && (
              <p className="mt-3 text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
                <Icon name="AlertTriangle" size={13} className="shrink-0 mt-0.5" /> <span>{error}</span>
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex gap-3 justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            {t("closeAnomalyCancel")}
          </Button>
          <Button variant="accent" onClick={onConfirm} disabled={saving}>
            {saving ? "…" : t("closeAnomalyConfirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   MULTI-STEP CLOSE FORM
   ═══════════════════════════════════════════════════════════ */

function CloseForm({ currency, t, branchType, branchId, onDone, onQueued, isOnline, editDraft, onEditConsumed, smartScanPrefill, smartScanVerifyHints, onSmartScanConsumed, manualRequest = 0 }) {
  const navigate = useNavigate();  // was undefined here → navigate("/connections") crashed (lines ~1029/1682)
  const { user, refreshUser } = useAuth();
  const { hasFeature, isReady: entReady } = useEntitlements();
  const defaultRevCats = useMemo(() => getRevenueCats(branchType), [branchType]);
  const defaultPayMethods = useMemo(() => getPaymentMethods(branchType), [branchType]);
  const config = CLOSE_CONFIG[branchType] || CLOSE_CONFIG.general;

  // Every money box on this page is <MoneyField> (text), not <input
  // type="number">, because a number input on an English-locale browser
  // rewrites a Dane's "1.500,50" to "1.50050" without raising badInput — see
  // the note in components/ui/MoneyField.jsx. So every read of one goes
  // through the STRICT parser, in the ACCOUNT's notation, never the browser's
  // and never the UI language's.
  const mLocale = moneyLocale(user?.currency);
  // Number, or NaN when the box holds something that is not an amount. The
  // NaN is the point: it propagates instead of silently becoming a smaller,
  // plausible number the way parseFloat("1.500,50") → 1.5 did.
  const readMoney = (v) => parseMoneyInput(v, mLocale);
  // For the running totals the owner watches while typing. An unreadable box
  // contributes nothing AND turns red AND blocks the save below, so nothing
  // can be written on the strength of a figure this skipped.
  const readMoney0 = (v) => { const n = readMoney(v); return Number.isFinite(n) ? n : 0; };

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
  // The server's own sentence, when it sent one. Kept apart from `error` so a
  // failed lock can lead in Danish and still hand the revisor the raw wording
  // underneath, instead of choosing between the two.
  const [errorDetail, setErrorDetail] = useState("");
  // close_sanity soft guard — holds the anomaly payload when today's
  // total is far off the recent same-weekday baseline; drives the
  // "double-check before you lock" dialog. null = no warning pending.
  const [anomalyCheck, setAnomalyCheck] = useState(null);

  // Night shift: business date may differ from calendar date
  // DK-first default: 06:00 business-day cutoff (Europe/Copenhagen restaurant
  // convention) until the prefill returns the owner's real day_cutoff_hour.
  // Was 0 (midnight) → a late-night closer at 01:30 saw today pre-selected
  // and reconciled against the wrong day's sales.
  // The local getBusinessDate() helper that used to live in this file is gone:
  // businessTodayIso() (utils/dateFormat) is the same rule, already the client
  // twin of the backend's business_today_local(), and already unit-tested —
  // one definition of "today" for the page header AND the wizard.
  const [businessDate, setBusinessDate] = useState(() => businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR));
  const [cutoffHour, setCutoffHour] = useState(DEFAULT_CLOSE_CUTOFF_HOUR);

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

  // Has the owner (or the Edit-an-existing-close path) deliberately chosen a
  // business date? Once they have, the date is THEIRS and the prefill must not
  // move it.
  //
  // THE DEFECT THIS EXISTS TO CLOSE: the prefill effect used to END with an
  // unconditional `setBusinessDate(businessTodayIso(serverCutoff))`, and
  // `businessDate` is one of that effect's own dependencies. So picking any
  // past date re-fired the effect and the resolving prefill snapped the date
  // straight back to today. The visible symptoms were that the date picker did
  // nothing, "Reset to today" and the `pastDate` badge could never appear
  // (their `businessDate !== businessTodayIso(cutoffHour)` condition was
  // unreachable) — and the money symptom was worse: the Edit path sets
  // businessDate from the saved close, so correcting a close from a past day
  // re-saved it with `date: businessDate` = TODAY, against the wrong day's
  // sales.
  //
  // A ref, not state, for the same reason as editLoadedRef above: it has to be
  // true synchronously, before the in-flight fetch resolves.
  const dateChosenRef = useRef(false);

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
    // An edited close is filed against ITS OWN date, never today — mark the
    // date as chosen before the prefill for that date can resolve.
    if (dc.date) {
      dateChosenRef.current = true;
      setBusinessDate(typeof dc.date === "string" ? dc.date.slice(0, 10) : dc.date);
    }
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

  // ─── Two scans, one kasserapport ──────────────────────────────────
  //
  // mergeScans now lives in utils/dailyCloseScanMerge.js (testable, and the
  // one place the rules are written down). What stays here is the QUESTION:
  // when a second scan arrives and BOTH carry a headline total, only the
  // owner knows whether that is a second terminal or a better photo of the
  // first one. The old code assumed "better photo" and overwrote — which is
  // how a two-till café locked one till's revenue into a signed kasserapport.
  //
  // pendingScans holds every scan we have NOT been told what to do with, in
  // arrival order. It is a QUEUE, not a slot: the file input is `multiple` and
  // the handler awaits one scan per file in a loop, so picking three till
  // photos in one go used to overwrite the second one with the third before
  // anybody had answered for it — the middle terminal's numbers never reached
  // state, were never asked about, and were never merged. One question is
  // asked per scan, and no scan is discarded to ask it.
  //
  // Both refs mirror their state because handleFileSelect is awaited in that
  // loop — the closure values would be one file stale.
  const [pendingScans, setPendingScans] = useState([]);
  const pendingScansRef = useRef([]);
  const applyPendingScans = (next) => {
    pendingScansRef.current = next;
    setPendingScans(next);
  };
  const pendingScan = pendingScans[0] || null;
  // One level of undo for a terminal choice, so a wrong tap is catchable
  // before anything is locked. It restores the unanswered queue too — an undo
  // means "I answered that wrong", so the question has to come back.
  const [mergeUndo, setMergeUndo] = useState(null);
  const scanResultRef = useRef(null);
  const applyScanResult = (next) => {
    scanResultRef.current = next;
    setScanResult(next);
  };
  useEffect(() => { scanResultRef.current = scanResult; }, [scanResult]);

  /** The owner answered "another terminal" (sum) or "same terminal" (replace). */
  const resolveTerminalChoice = (mode) => {
    const [head, ...rest] = pendingScansRef.current;
    if (!head) return;
    setMergeUndo({ scan: scanResultRef.current, pending: pendingScansRef.current });
    // mLocale, not a default: these buckets can hold the owner's own
    // keystrokes from the scan-review boxes, so the sum has to read them in
    // the account's notation or it adds 1,50 where 1.500,50 was corrected in.
    let merged = mergeScans(scanResultRef.current, head, mode, mLocale);
    // Everything still queued that is NOT ambiguous against the new state
    // folds in straight away. We only ever ask when the question is real, so a
    // batch of "one till photo + two detail pages" costs exactly one tap.
    const waiting = [...rest];
    while (waiting.length && !needsTerminalChoice(merged, waiting[0], mLocale)) {
      merged = mergeScans(merged, waiting.shift(), MERGE_FILL, mLocale);
    }
    applyScanResult(merged);
    applyPendingScans(waiting);
  };

  const undoMerge = () => {
    if (!mergeUndo) return;
    applyScanResult(mergeUndo.scan);
    applyPendingScans(mergeUndo.pending);
    setMergeUndo(null);
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
      // Merge with existing results — unless the merge is ambiguous, in which
      // case nothing is merged until the owner says which it is. Reading the
      // ref (not the closure) matters: several files are awaited in a loop.
      const current = scanResultRef.current;
      // Once ANY scan is waiting on the owner, every later scan waits behind
      // it. Merging a straggler into the numbers while an unanswered question
      // sits on top of them would mean answering that question about a state
      // the owner never saw.
      if (pendingScansRef.current.length || (current && needsTerminalChoice(current, res.data, mLocale))) {
        applyPendingScans([...pendingScansRef.current, res.data]);
      } else {
        applyScanResult(mergeScans(current, res.data, MERGE_FILL, mLocale));
      }
      // Capture the durable storage URL — first scan wins so editing
      // a draft and re-scanning doesn't churn the persisted reference.
      if (res.data?.image_url && !receiptPhotoUrl) {
        setReceiptPhotoUrl(res.data.image_url);
      }
      setScanMode("result");
    } catch (err) {
      // Danish default that names the action and the way out. errText still
      // surfaces a real server sentence when there is one (a size cap, a bad
      // file type — genuinely the only clue), but the untranslated
      // "OCR scanning failed" is no longer what a Dane reads when the photo
      // simply did not come through.
      setScanError(errText(err, t("dcScanFailed", "We couldn't read that photo. Take another one, or type the numbers in yourself.")));
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
    // If OCR detected MOMS, switch to manual mode with the scanned value —
    // UNLESS that number covers only one of the tills we just summed.
    //
    // This is the one prefill that must fail closed. When terminal 2's MOMS
    // line was unreadable, sumMerge keeps terminal 1's figure and flags it in
    // merge_info.incompleteFields; writing it in as "the MOMS from the
    // receipt" puts a one-till VAT base against a two-till revenue_total, and
    // the backend takes a supplied moms_total verbatim and derives
    // revenue_ex_moms from it. That is an under-declared MOMS in a signed
    // kasserapport. Leaving momsMode on "auto" derives it from the SUMMED
    // revenue instead, which is right for a standard-rate day and, when it
    // isn't, is a number the owner can see and override.
    const mergeIncomplete = scanResult.merge_info?.incompleteFields || [];
    if (scanResult.moms_total && !mergeIncomplete.includes("moms_total")) {
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
  // Three outcomes, not two. A boolean would collapse "the register says
  // nothing for this date" and "we could not reach the register" into the same
  // blank screen, and the blank screen reads as the first. The owner then
  // types a close with no POS cross-check and no idea one was missing — the
  // variance warning, the register-derived expected cash and the sync banner
  // are all silently absent. "failed" is rendered, never swallowed.
  const [prefillStatus, setPrefillStatus] = useState("idle"); // idle | ok | failed

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
        // Apply night shift cutoff from business profile.
        // `?? DEFAULT_CLOSE_CUTOFF_HOUR`, never `|| 0`: a MISSING day_cutoff_hour
        // is not a configured midnight. The old `|| 0` silently moved a venue
        // whose prefill omits the field from the page's own 06:00 default to
        // 00:00 mid-load, so the header and the wizard disagreed about which day
        // was "today" — see resolveCutoffHour in utils/dailyCloseDay.js.
        const serverCutoff = resolveCutoffHour(res.data.day_cutoff_hour);
        if (serverCutoff !== cutoffHour) {
          setCutoffHour(serverCutoff);
          const correctedDate = businessTodayIso(serverCutoff);
          // Only re-derive "today" while the owner has not picked a date. This
          // branch exists to apply the venue's real cutoff to the DEFAULT date
          // on first load; applied to a chosen date it is a clobber, not a
          // correction. See dateChosenRef.
          if (!dateChosenRef.current && correctedDate !== today) {
            setBusinessDate(correctedDate);
            // Re-fetch with corrected date (don't loop — cutoffHour dep is stable after this)
          }
        }
        // NOTE: there is deliberately NO unconditional
        // `setBusinessDate(businessTodayIso(serverCutoff))` here. It used to
        // be the last line of this block, and because `businessDate` is a
        // dependency of this very effect it reverted every date the owner
        // chose the moment the prefill resolved — killing the picker, the
        // pastDate badge and "Reset to today", and re-filing edited past
        // closes against today. The branch above is the only case that
        // legitimately moves the date, and it is now gated. Covered by
        // "keeps the owner's chosen business date" in
        // __tests__/DailyClosePage.moneySurface.test.jsx.

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
        setPrefillStatus("ok");
      } catch {
        // Manual entry still works — but say so. Failing closed and QUIET
        // meant the POS cross-check just wasn't there, which looks identical
        // to "this date had no sales".
        setPrefillStatus("failed");
      }
      setPrefillLoading(false);
    };
    fetchPrefill();
  }, [branchId, branchType, businessDate]);

  const revenueTotal = useMemo(() => Object.values(revAmounts).reduce((s, v) => s + readMoney0(v), 0), [revAmounts, mLocale]);
  const paymentTotal = useMemo(() => Object.values(payAmounts).reduce((s, v) => s + readMoney0(v), 0), [payAmounts, mLocale]);
  // A total of 0 is only a NUMBER once the owner has typed something. Before
  // the first keystroke the reduce above returns 0 and the step header printed
  // it as "0 DKK" — a confident statement that the venue took nothing today,
  // on an untouched form. That is the same class of lie the money primitives
  // exist to stop, so an untouched step renders Amount's honest "—" instead.
  const hasRevenueEntry = useMemo(
    () => Object.values(revAmounts).some((v) => String(v ?? "").trim() !== ""),
    [revAmounts],
  );
  const hasPaymentEntry = useMemo(
    () => Object.values(payAmounts).some((v) => String(v ?? "").trim() !== ""),
    [payAmounts],
  );
  // ── The tie-out, as ONE verdict both surfaces read ──────────────────
  //
  // THE DEFECT THIS EXISTS TO KILL: `balanceDiff` was computed here and
  // rendered on the PAYMENTS step only. The path this product promotes —
  // "Brug disse værdier — spring til gennemgang" — calls
  // applyScanValues(true), which does setStep(totalSteps) and lands the
  // owner on review without ever passing the payments step. So the single
  // line that says "your day does not add up" was skipped by the exact flow
  // we push people into, and the review card showed revenue and payments as
  // two unrelated totals with no difference between them. A kasserapport got
  // locked, signed and mailed to the revisor without anyone being told it
  // did not reconcile.
  //
  // Three outcomes, not two. "unknown" is the one that matters: with the
  // payments column untouched, revenue − payments equals the whole revenue,
  // and rendering that as "Difference: 17.030 kr" is a confident figure
  // derived from a number nobody entered — the same class of lie as a
  // not-known total printed as a zero. It says it cannot be checked instead.
  const tieOut = useMemo(() => {
    if (!hasRevenueEntry || !hasPaymentEntry) return { state: "unknown", diff: null };
    const diff = revenueTotal - paymentTotal;
    // Under 1 kr is rounding, not a discrepancy — same threshold the
    // payments step has always used, now defined once.
    return { state: Math.abs(diff) < 1 ? "balanced" : "off", diff };
  }, [hasRevenueEntry, hasPaymentEntry, revenueTotal, paymentTotal]);
  // Expected cash baseline for the drawer variance. Prefer the SYNCED POS
  // register cash (what the till says was taken) over the owner's typed cash
  // line — typed-vs-counted is self-referential and can't surface a real
  // shortage/theft. registerCash is null when no POS cash figure exists for
  // the date, in which case we fall back to the typed entry. The variance
  // math (counted − expected) and the persisted cash_difference are unchanged
  // — only the baseline source moves.
  const typedCash = readMoney0(payAmounts.cash);
  const cashExpectedFromRegister = registerCash != null && !Number.isNaN(registerCash);
  const cashExpected = cashExpectedFromRegister ? registerCash : typedCash;
  // Same rule as hasRevenueEntry/hasPaymentEntry above, applied one step later:
  // with no synced register AND nothing typed on the payments step, typedCash
  // is a fallback 0, and the card printed a confident "0 kr." under the label
  // "Expected (from your entry)" — an entry that does not exist. A
  // register-derived 0 and a typed 0 are both real and still render 0; only
  // "nothing is known" becomes "—". The variance math and the persisted
  // cash_difference are untouched: this is what the figure SAYS, not what it is.
  const hasCashBaseline =
    cashExpectedFromRegister || String(payAmounts.cash ?? "").trim() !== "";
  const cashCountedVal = readMoney0(cashCounted);
  const cashDiff = cashCounted ? cashCountedVal - cashExpected : null;
  // staffCount stays parseInt: it is a HEAD COUNT, not money. tipsTotal is
  // money and reads strictly, so an unreadable tips box yields no per-person
  // figure at all rather than a confident wrong one.
  const tipsPP = tipsTotal && staffCount && parseInt(staffCount) > 0
    && Number.isFinite(readMoney(tipsTotal))
    ? Math.round(readMoney(tipsTotal) / parseInt(staffCount)) : null;

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
  // Three outcomes again. The catch below used to setExemptSalesTotal(0), and
  // a 0 here is not a neutral value: it is the claim "there were no MOMS-free
  // sales today", rendered as a measured fact on the line the revisor reads,
  // and folded into the taxable base the MOMS figure is computed from. A read
  // that never completed must not be able to make that claim, so the status is
  // tracked separately and the MOMS card says which of the two it is.
  const [exemptStatus, setExemptStatus] = useState("loading"); // loading | ok | failed

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
        setExemptStatus("ok");
      } catch {
        // Falls back to "no exempt rows known" for the MATH — the conservative
        // direction, since it over-states rather than under-states the taxable
        // base, and it keeps the close wizard usable. But the 0 is now marked
        // as unknown so the review step tells the owner the exempt lookup
        // didn't answer, instead of printing a 0 that looks measured.
        if (!cancelled) { setExemptSalesTotal(0); setExemptStatus("failed"); }
      }
    };
    setExemptStatus("loading");
    fetchExempt();
    return () => { cancelled = true; };
  }, [businessDate, branchId, cutoffHour]);

  // MOMS / VAT — toggle between auto-calc and manual entry from receipt
  const [momsMode, setMomsMode] = useState("auto"); // "auto" | "manual"
  const [momsManual, setMomsManual] = useState("");

  // Any money box on the page holding text that is not an amount. This is the
  // save gate: a close writes to the ledger and prints a kasserapport, so it
  // must not go out while one of its figures is a question mark. Each field
  // shows its own refusal; this is what stops the button.
  //
  // Declared HERE rather than beside the totals above because momsManual is
  // declared on the line above it — reading it earlier would be a TDZ
  // ReferenceError at render, not a lint warning.
  const moneyRejected = useMemo(
    () =>
      [
        ...Object.values(revAmounts),
        ...Object.values(payAmounts),
        cashCounted,
        tipsTotal,
        gavekortSold,
        momsMode === "manual" ? momsManual : "",
      ].some((v) => isMoneyRejected(v, mLocale)),
    [revAmounts, payAmounts, cashCounted, tipsTotal, gavekortSold, momsManual, momsMode, mLocale],
  );

  // WHICH group holds it. The lock button sits on the review step, three
  // screens past the box that refused — so "one amount can't be read" with no
  // location is a dead end at 22:30. The field still says so in place; this
  // says where in place IS. Order matches the wizard, so the first hit is the
  // earliest step the owner has to go back to.
  const rejectedArea = useMemo(() => {
    const groups = [
      ["revenue", Object.values(revAmounts)],
      ["payments", Object.values(payAmounts)],
      ["cash", [cashCounted]],
      ["tips", [tipsTotal]],
      ["gavekort", [gavekortSold]],
      ["moms", [momsMode === "manual" ? momsManual : ""]],
    ];
    for (const [name, values] of groups) {
      if (values.some((v) => isMoneyRejected(v, mLocale))) return name;
    }
    return null;
  }, [revAmounts, payAmounts, cashCounted, tipsTotal, gavekortSold, momsManual, momsMode, mLocale]);

  // Taxable base = entered revenue MINUS today's exempt sales total.
  // Clamp at 0: if the user only entered a placeholder and the exempt
  // total exceeds it, we'd otherwise show a negative MOMS amount which
  // confuses the owner more than a zero.
  const taxableBase = useMemo(() => {
    return Math.max(0, Math.round((revenueTotal - exemptSalesTotal) * 100) / 100);
  }, [revenueTotal, exemptSalesTotal]);

  const momsTotal = useMemo(() => {
    if (momsMode === "manual") return readMoney0(momsManual);
    // Same guard as applyScanValues: a scanned MOMS that covers one of two
    // summed tills is not "the MOMS from the receipt". Without this, flipping
    // the toggle back to Auto did NOT recover — this branch returned the
    // one-till figure while the UI printed "Auto-calculated: Revenue × 25% /
    // 125%", a computation that had not happened.
    const scannedMoms = (scanResult?.merge_info?.incompleteFields || []).includes("moms_total")
      ? null
      : scanResult?.moms_total;
    if (scannedMoms) return scannedMoms;
    return taxableBase > 0 && vatRate > 0 ? Math.round((taxableBase * vatRate / vatDivisor) * 100) / 100 : 0;
  }, [momsMode, momsManual, scanResult, taxableBase]);

  // WHICH of the two "auto" paths produced that number — because the caption
  // underneath used to assert the multiplication either way. The comment above
  // caught this for a HALF-merged scan and stopped there; a complete one still
  // won the branch while the page printed "Auto-calculated: Revenue × 25% /
  // 125%" over a figure that came off the Z-report and does not equal that
  // product. An owner flipping back to Auto to cross-check their own arithmetic
  // was shown a sum that had never been done.
  //
  // The scanned figure still WINS — the till's own MOMS knows about split
  // rates that revenue × 25/125 cannot — so what is saved does not change.
  // Only the sentence changes, to name where the number actually came from.
  const momsSource = useMemo(() => {
    if (momsMode === "manual") return "manual";
    const scannedMoms = (scanResult?.merge_info?.incompleteFields || []).includes("moms_total")
      ? null
      : scanResult?.moms_total;
    return scannedMoms ? "scanned" : "computed";
  }, [momsMode, scanResult]);
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
    // readMoney, not parseFloat: these go straight into the ledger row and the
    // revisor PDF. An unreadable box cannot reach here anyway — moneyRejected
    // blocks the save — so a NaN would be a bug, and it is left OUT of the
    // breakdown rather than written as a guess.
    revCats.forEach(c => { const n = readMoney(revAmounts[c.key]); if (revAmounts[c.key] && Number.isFinite(n)) revenue_breakdown[c.key] = n; });
    const payment_breakdown = {};
    payMethods.forEach(m => { const n = readMoney(payAmounts[m.key]); if (payAmounts[m.key] && Number.isFinite(n)) payment_breakdown[m.key] = n; });

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
    const gavekortNum = gavekortSold ? readMoney0(gavekortSold) : 0;
    if (gavekortNum > 0) {
      extraNoteParts.push(
        // formatOwnerMoney, not toLocaleString: this note is persisted on the
        // close row and printed on the revisor's kasserapport, so it has to
        // read "1.500 kr." the way the rest of the document does — never
        // "1,500 DKK" because the closer's browser happened to be in English.
        `Gavekort solgt: ${formatOwnerMoney(gavekortNum, currency, { decimals: LEDGER_DECIMALS })} (uden for dagens moms-grundlag — vurderes af revisor).`,
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
      tips_total: tipsTotal && Number.isFinite(readMoney(tipsTotal)) ? readMoney(tipsTotal) : null,
      tips_staff_count: staffCount ? parseInt(staffCount) : null,
      cash_counted: cashCounted && Number.isFinite(readMoney(cashCounted)) ? readMoney(cashCounted) : null,
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
    setErrorDetail("");
    const payload = buildPayload("confirmed");
    if (opts.acknowledgeAnomaly) payload.acknowledge_anomaly = true;

    if (!navigator.onLine) {
      // A queue write can be refused (quota, Safari private mode). Saying
      // "queued" when nothing was stored would be the same lie the old sync
      // loop told — tell the owner instead, so they can write the numbers down.
      const queued = addToOfflineQueue(payload);
      setSaving(false);
      if (!queued) { setError(t("dcQueueStoreFailed", "This phone could not store the kasserapport offline. Note the numbers down and try again when you're back online.")); return; }
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
        // Network failed mid-request — queue for later (and say so honestly
        // if the device refused to store it).
        const queued = addToOfflineQueue(payload);
        setSaving(false);
        if (!queued) { setError(t("dcQueueStoreFailed", "This phone could not store the kasserapport offline. Note the numbers down and try again when you're back online.")); return; }
        onQueued?.();
        return;
      }
      // The server refused the lock. This used to render the server's own
      // English sentence as the headline — or, when there wasn't one, the
      // literal string "Failed to save", which is not a sentence in any
      // language the owner reads and does not say what was not saved.
      //
      // Now it leads with the Danish sentence that names the action and
      // demotes whatever the server said to a muted second line — the same
      // shape the offline queue already uses, and for the same reason: the
      // raw wording is a clue for the revisor, never the thing the person
      // standing at the till has to decode at 23:30.
      //
      // Only the server's OWN words earn that line. errText falls back to
      // axios's "Request failed with status code 500" when the payload said
      // nothing, which is noise dressed as an explanation.
      const d = err.response?.data;
      const serverSaid = d?.detail ?? d?.message ?? d?.reason;
      setError(t("dcLockFailed", "The kasserapport was not saved. Check your connection and try again — your numbers are still on this screen."));
      setErrorDetail(serverSaid == null ? "" : errText(err, ""));
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-400 text-right text-[16px] tabular-nums";
  const labelClass = "text-[13px] font-medium text-gray-600 dark:text-gray-300";


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

  /**
   * Owner-facing names for the lines a sum could NOT add up.
   *
   * "Some lines were only on one of the receipts" is true but useless: the
   * owner cannot check a line we refuse to name, and the one that matters
   * most (MOMS) is the one that would otherwise be filed one-till-short.
   * Per-terminal documents (cash denominations, per-clerk splits) are left
   * out on purpose — they are not money lines the owner types.
   */
  const mergeIncompleteLabels = useMemo(() => {
    const fields = scanResult?.merge_info?.incompleteFields || [];
    if (!fields.length) return [];
    const label = (f) => {
      if (f === "moms_total") return vatName;
      if (f === "tips") return t("tipsLabel", "Tips");
      if (f === "revenue_total") return t("totalRevenue", "Total revenue");
      if (f === "cash_counted_total") return t("cashCounted", "Cash counted");
      if (f.startsWith("revenue.")) {
        const k = f.slice("revenue.".length);
        return revCats.find((c) => c.key === k)?.label || k;
      }
      if (f.startsWith("payments.")) {
        const k = f.slice("payments.".length);
        return payMethods.find((m) => m.key === k)?.label || k;
      }
      return null;
    };
    return Array.from(new Set(fields.map(label).filter(Boolean)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanResult, revCats, payMethods, vatName]);

  /**
   * The scanned MOMS, but only when it still describes ALL the revenue on
   * screen. After a sum whose second Z-bon had no readable MOMS line, the
   * figure covers one till out of two — see the guard in applyScanValues.
   */
  const scanMomsTrusted = (scanResult?.merge_info?.incompleteFields || []).includes("moms_total")
    ? null
    : scanResult?.moms_total;

  /**
   * "These numbers are a SUM of two tills" — rendered on the scan card AND on
   * every step of the wizard, review included.
   *
   * It used to live only inside the scan result card, which unmounts the
   * instant the owner taps "Use these values — jump to review". That is the
   * same tap that lands them on the lock step: the per-terminal totals, the
   * Undo and the "check these lines before you lock" note all disappeared on
   * the way to the screen they were warning about. A disclosure the owner
   * cannot see while deciding is not a disclosure.
   *
   * A plain function, not a nested component: a component declared inside
   * CloseForm would remount (and lose focus/animation) on every render.
   */
  const renderMergeSummary = ({ withUndo = false } = {}) => {
    if (scanResult?.merge_info?.mode !== MERGE_SUM) return null;
    const info = scanResult.merge_info;
    return (
      <div className="rounded-xl p-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/40 text-sm space-y-1">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
            <Icon name="Calculator" size={15} />
            {t("scanMergedTerminals", "{count} terminals added together", { count: info.scans })}
          </span>
          {/* Undo belongs to the scan card — by the review step the owner has
              already left the photos behind, and an undo there would silently
              un-sum numbers they have since typed over. */}
          {withUndo && mergeUndo && (
            <button onClick={undoMerge}
              className="text-xs text-gray-500 dark:text-gray-400 underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200">
              {t("scanMergedUndo", "Undo")}
            </button>
          )}
        </div>
        <div className="text-xs text-gray-600 dark:text-gray-300">
          {(info.terminalTotals || []).map((v) => formatOwnerMoney(v, currency, { decimals: GLANCE_DECIMALS })).join("  +  ")}
          {" = "}
          <strong>{formatOwnerMoney(headlineTotal(scanResult, mLocale), currency, { decimals: GLANCE_DECIMALS })}</strong>
        </div>
        {/* Honest about what could NOT be added, BY NAME. "Terminal 2's MOMS
            line was unreadable" and "terminal 2 had no MOMS" look the same on
            a photo, so we say which lines instead of inventing a sum. */}
        {mergeIncompleteLabels.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("scanMergedIncompleteNamed", "Only on one of the receipts, so not added up: {fields}. Check them before you lock.", {
              fields: mergeIncompleteLabels.join(", "),
            })}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      {/* ─── Close anomaly double-check (close_sanity soft guard) ───
          Shown when today's total is far off the recent same-weekday
          baseline — catches a misread Z-report total before it locks. */}
      {anomalyCheck && (
        <CloseAnomalyDialog
          t={t}
          anomaly={anomalyCheck}
          saving={saving}
          onCancel={() => setAnomalyCheck(null)}
          onConfirm={() => handleSubmit({ acknowledgeAnomaly: true })}
        />
      )}
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
            {/* The scan step's opening instruction.
                It used to be a three-stop emerald gradient banner with a white
                title and gray-100 body — a marketing hero at the top of an
                instrument. Two things were wrong with it. It was illegible:
                white on the #34d399 stop measures 1.92:1 and the body text
                1.75:1, against the 4.5:1 floor. And it was off-doctrine: this
                product's design rule is premium via SUBTRACTION — no gloss, no
                gradient. The instruction is identical; the hierarchy now comes
                from size and weight on a calm surface, which is where it should
                have come from in the first place. */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <span className="shrink-0 mt-0.5 text-gray-500 dark:text-gray-400" aria-hidden="true">
                  <Icon name="Image" size={20} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[16px] font-semibold text-gray-900 dark:text-gray-100 leading-snug">
                    {t("scanZReportTitle", "Scan your Z-report / kasserapport")}
                  </h2>
                  <p className="mt-1 text-[13px] text-gray-600 dark:text-gray-300 leading-relaxed">
                    {/* Fallback kept in step with the key — a stale inline default
                        is the repo's own documented i18n trap: grep finds the old
                        promise long after useLanguage was corrected. */}
                    {t("scanZReportBody", "Take a photo of your Z-report. Extra pages are merged into one set of numbers — and when two photos each have their own total, we ask before we add them together.")}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-col sm:flex-row gap-2">
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={() => { if (fileInputRef.current) { fileInputRef.current.setAttribute("capture", "environment"); fileInputRef.current.click(); } }}
                  iconLeft={<Icon name="Image" size={16} />}>
                  {t("takePhoto", "Take Photo")}
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full sm:w-auto"
                  onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
                  iconLeft={<Icon name="FolderOpen" size={16} />}>
                  {t("uploadImage", "Upload Image")}
                </Button>
              </div>
              {/* MOMS / VAT toggle — owner picks before scan so OCR'd
                  numbers are interpreted right. Most DK Z-reports are
                  gross (with MOMS); B2B / Excel exports may be net.
                  Uses currency-aware `vatName` so a Nepali user sees
                  "with VAT (gross)" and a Danish user sees "with Moms
                  (gross)" — fixes the #148 MEDIUM-10 mix where this
                  block hardcoded "MOMS" while siblings used `vatName`.
                  Now the Chip primitive: it already owns this product's ONE
                  selected-state treatment (gray-900 fill), is a real button
                  with aria-pressed, and replaces a hand-rolled pair whose
                  unselected state was white-on-emerald at ~1.3:1. */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-gray-500 dark:text-gray-400">{t("receiptAmountsAre", "Receipt amounts are:")}</span>
                <Chip size="sm" selected={scanMomsMode === "with-moms"} onClick={() => setScanMomsMode("with-moms")}>
                  {t("withVatGross", "with {vat} (gross)", { vat: vatName })}
                </Chip>
                <Chip size="sm" selected={scanMomsMode === "without-moms"} onClick={() => setScanMomsMode("without-moms")}>
                  {t("withoutVatNet", "without {vat} (net)", { vat: vatName })}
                </Chip>
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
            {/* border-t-green-600 was a literal `green-*` utility, which
                index.css remaps to the brand token — a second green source on a
                page that is collapsing to one accent. emerald-600 is the
                accent, spelled the way the rest of the app spells it. */}
            <div className="inline-block w-10 h-10 border-4 border-gray-100 dark:border-gray-700 border-t-emerald-600 rounded-full animate-spin" />
            <p className="text-[14px] text-gray-600 dark:text-gray-300 font-medium">{t("readingZReport", "Reading your Z-report…")}</p>
            <p className="text-[13px] text-gray-500 dark:text-gray-400">{t("ocrExtractingData", "OCR is extracting revenue, payments, and {vat} data", { vat: vatName })}</p>
          </div>
        )}

        {/* ─── SCAN RESULT CARD ─── */}
        {scanMode === "result" && scanResult && (
          <div className="space-y-5">
            {/* ─── "Another terminal, or a better photo?" ───────────────
                The only question we ask, asked only when it is real: both
                scans carry a headline total, so the numbers either ADD UP
                or REPLACE and we cannot tell which. One tap either way,
                with both totals on the buttons so the owner answers by
                looking at the numbers, not by parsing a sentence. Nothing
                is merged until they answer. */}
            {pendingScan && (() => {
              const existingTotal = headlineTotal(scanResult, mLocale);
              const incomingTotal = headlineTotal(pendingScan, mLocale);
              return (
                <div className="rounded-xl p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-3">
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-100 flex items-center gap-1.5">
                    <Icon name="HelpCircle" size={16} />
                    {t("scanSecondTotalTitle", "Is this another terminal?")}
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    {t("scanSecondTotalBody", "This scan has its own total of {incoming}. The one on screen is {existing}.", {
                      incoming: formatOwnerMoney(incomingTotal, currency, { decimals: GLANCE_DECIMALS }),
                      existing: formatOwnerMoney(existingTotal, currency, { decimals: GLANCE_DECIMALS }),
                    })}
                  </p>
                  {/* Picking several photos at once is one tap, so say how many
                      are still in line — otherwise answering once looks like
                      answering for all of them. */}
                  {pendingScans.length > 1 && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t("scanPendingMore", "{count} more photos are waiting — you'll be asked about each one.", { count: pendingScans.length - 1 })}
                    </p>
                  )}
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button variant="primary" size="sm" className="flex-1"
                      onClick={() => resolveTerminalChoice(MERGE_SUM)}
                      iconLeft={<Icon name="Plus" size={15} />}>
                      {t("scanSecondTotalSum", "Another terminal — add them up ({sum})", {
                        sum: formatOwnerMoney((existingTotal || 0) + (incomingTotal || 0), currency, { decimals: GLANCE_DECIMALS }),
                      })}
                    </Button>
                    <Button variant="secondary" size="sm" className="flex-1"
                      onClick={() => resolveTerminalChoice(MERGE_REPLACE)}
                      iconLeft={<Icon name="RefreshCw" size={15} />}>
                      {t("scanSecondTotalReplace", "Same terminal — use the new photo ({incoming})", {
                        incoming: formatOwnerMoney(incomingTotal, currency, { decimals: GLANCE_DECIMALS }),
                      })}
                    </Button>
                  </div>
                </div>
              );
            })()}

            {!pendingScan && renderMergeSummary({ withUndo: true })}
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
                      className="text-[12px] px-2.5 py-1 rounded-lg bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100 hover:bg-amber-50 dark:hover:bg-amber-900/40 transition"
                    >
                      {t("terminalConflictDismiss", "Looks fine")}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate("/connections")}
                      className="text-[12px] px-2.5 py-1 rounded-lg bg-amber-900 dark:bg-amber-100 text-white dark:text-amber-900 hover:bg-amber-800 dark:hover:bg-amber-200 transition"
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
                            className="text-[12px] w-full px-2 py-1 rounded-lg bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100"
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
                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 mt-1 text-[12px]">
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
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-[16px] font-semibold text-gray-900 dark:text-white">{t("scanResults")}</h2>
              {/* Yellow → amber: "medium confidence" and "the drawer is short"
                  were two different hues for the same instruction ("check
                  this"), and yellow-700 on yellow-100 is the weakest pair of
                  the three. One warn colour, one critical colour. */}
              <span className={`text-[12px] font-medium px-3 py-1 rounded-full ${
                scanFieldsDetected >= 5 ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                  : scanFieldsDetected >= 3 ? "bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300"
                    : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
              }`}>
                {/* confidenceLevel*, not confidence*. The template already ends
                    in the noun ("… sikkerhed — 5/7 felter"), and the standalone
                    pill keys carry it too, so interpolating one into the other
                    printed "Høj sikkerhed sikkerhed — 5/7 felter" to every
                    Danish owner who scanned a kasserapport. The bare level word
                    has its own three keys now. */}
                <Icon name="Target" size={14} className="inline align-text-bottom mr-1" /> {t("scanConfidenceLevel", "{level} confidence — {detected}/{total} fields detected", {
                  level: scanFieldsDetected >= 5 ? t("confidenceLevelHigh", "High") : scanFieldsDetected >= 3 ? t("confidenceLevelMedium", "Medium") : t("confidenceLevelLow", "Low"),
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
                    {" "}{t("scanGapTotalIs", "from this receipt — total is {amount}", { amount: formatOwnerMoney(scanResult.revenue_total, currency, { decimals: GLANCE_DECIMALS }) })}
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
                      {val && <span className="text-[11px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg">OCR</span>}
                      {isEmpty && <span className="text-[11px] font-mono px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-lg">{t("scanBadgeMissing", "missing")}</span>}
                    </span>
                    {/* Controlled now, and the RAW string is what we keep. The
                        old handler was `parseFloat(e.target.value) || 0` on a
                        number input: a correction typed as "1.500,50" arrived
                        as "1.50050" and was stored as 1.5005, and anything the
                        parser disliked became a fabricated 0 sitting in the
                        OCR review as if the scanner had read it. Keeping the
                        keystrokes means applyScanValues hands them to the
                        revenue boxes verbatim, where the page's own strict
                        parser decides. */}
                    <MoneyField
                      locale={mLocale}
                      // The field IS the flex child of the row above, so the
                      // wrapper has to carry the growth or the box collapses.
                      wrapperClassName="flex-1 min-w-0"
                      className={`${inputClass} ${isEmpty ? "border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}
                      value={val ?? ""}
                      placeholder={isEmpty ? t("enterActualAmount", "enter actual amount") : ""}
                      onChange={e => {
                        setScanResult(prev => ({
                          ...prev,
                          revenue: { ...prev.revenue, [c.key]: e.target.value }
                        }));
                      }} />
                  </div>
                );
              })}
              {/* Money on this card goes through formatOwnerMoney. It used to
                  be a bare `toLocaleString() + currency code`, which uses the
                  BROWSER locale: a Danish owner on an English phone read
                  17.030 kr as "17,030 DKK", and in Danish the comma is the
                  DECIMAL separator — seventeen kroner. This is the figure the
                  "another terminal?" question is asked about, so it has to be
                  the one the owner would recognise. */}
              {scanResult.revenue_total && (
                <div className="flex justify-between pt-2 border-t dark:border-gray-600 text-[14px] font-semibold text-gray-900 dark:text-white">
                  <span>{t("totalRevenue")}</span>
                  <span>{formatOwnerMoney(scanResult.revenue_total, currency, { decimals: GLANCE_DECIMALS })}</span>
                </div>
              )}
            </div>

            {/* MOMS section.
                Was an indigo→violet gradient with a hardcoded #6366f1 heading —
                two colour families that appear nowhere else in the product,
                carrying no data (MOMS is a fact, not a status). Same neutral
                card surface as its Revenue and Payments siblings; the MOMS
                figure earns its emphasis from weight, which is what the type
                ramp is for. */}
            <div className="rounded-xl p-4 space-y-2 bg-gray-50 dark:bg-gray-700/50">
              <h3 className="font-semibold text-[13px] text-gray-500 dark:text-gray-400 flex items-center gap-2">
                {vatName} ({vatRatePct}%)
                {/* The OCR badge is a claim: "this number came off the paper".
                    After a sum whose second Z-bon had no readable MOMS line it
                    would be a one-till figure badged as the day's MOMS, sitting
                    under a two-till total. Same guard as applyScanValues. */}
                {scanMomsTrusted && <span className="text-[11px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg">OCR</span>}
              </h3>
              <div className="flex justify-between text-[13px] text-gray-700 dark:text-gray-300 tabular-nums">
                <span>{t("totalMoms")}</span>
                {/* formatOwnerMoney (the string primitive), not <Amount>: every
                    other figure on this scan card is a formatOwnerMoney string,
                    and Amount's whispered token is a separate element with a
                    margin instead of a literal space — mixing the two here would
                    give one row on the card a different glyph spacing from the
                    row above it. Same formatter either way. */}
                <span className="font-semibold text-gray-900 dark:text-gray-100">
                  {formatOwnerMoney(scanMomsTrusted || (vatRate > 0 ? Math.round(((scanResult.revenue_total || 0) * vatRate / vatDivisor) * 100) / 100 : 0), currency, { decimals: GLANCE_DECIMALS })}
                </span>
              </div>
              {defaultRevCats.map(c => {
                const val = scanResult.revenue?.[c.key];
                if (!val) return null;
                // The review field above stores what the owner TYPED, so this
                // line divides a string. Parse it strictly and print nothing
                // when it is not an amount — a NaN "uden moms" beside a red
                // field is noise, and a salvaged one would be a lie.
                const valNum = readMoney(val);
                if (!Number.isFinite(valNum)) return null;
                const udenMoms = Math.round((valNum / vatDivisor) * 100) / 100;
                return (
                  <div key={c.key} className="flex justify-between text-[12px] text-gray-500 dark:text-gray-400 tabular-nums">
                    <span>{c.label.split(" / ")[0]} {t("udenMomsSuffix", "(uden moms)")}</span>
                    <span>{formatOwnerMoney(udenMoms, currency, { decimals: GLANCE_DECIMALS })}</span>
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
                      {val && <span className="text-[11px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg">OCR</span>}
                      {isEmpty && <span className="text-[11px] font-mono px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-lg">{t("scanBadgeMissing", "missing")}</span>}
                    </span>
                    {/* Raw string kept, same reason as the revenue field above. */}
                    <MoneyField
                      locale={mLocale}
                      // The field IS the flex child of the row above, so the
                      // wrapper has to carry the growth or the box collapses.
                      wrapperClassName="flex-1 min-w-0"
                      className={`${inputClass} ${isEmpty ? "border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}
                      value={val ?? ""}
                      placeholder={isEmpty ? t("enterActualAmount", "enter actual amount") : ""}
                      onChange={e => {
                        setScanResult(prev => ({
                          ...prev,
                          payments: { ...prev.payments, [m.key]: e.target.value }
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
                      <span className="tabular-nums">{formatOwnerMoney(typeof v === "number" ? v : 0, currency, { decimals: GLANCE_DECIMALS })}</span>
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
                  {scanResult.tips && <span className="text-[11px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg">OCR</span>}
                  {!scanResult.tips && <span className="text-[11px] font-mono px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-lg">{t("scanBadgeMissing", "missing")}</span>}
                </span>
                {/* Raw string kept, same reason as the revenue field above. */}
                <MoneyField
                  locale={mLocale}
                  wrapperClassName="flex-1 min-w-0"
                  className={`${inputClass} ${!scanResult.tips ? "border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}
                  value={scanResult.tips ?? ""}
                  placeholder={!scanResult.tips ? t("enterActualAmount", "enter actual amount") : ""}
                  onChange={e => {
                    setScanResult(prev => ({ ...prev, tips: e.target.value }));
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
                  <span className="tabular-nums">{formatOwnerMoney(scanResult.payments_view.adjustments.surcharge, currency, { decimals: GLANCE_DECIMALS })}</span>
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

            {/* Action buttons — both disabled while the "another terminal?"
                question is open. Letting the owner walk past it would lock
                the numbers from BEFORE the second scan, which is the exact
                loss this flow exists to stop. */}
            <div className="flex flex-col sm:flex-row gap-3">
              <Button variant="primary" size="lg" className="flex-1" onClick={() => applyScanValues(true)}
                disabled={Boolean(pendingScan)}
                iconLeft={<Icon name="CheckCircle2" size={16} />}>
                {t("useTheseValuesJumpReview", "Use these values — jump to review")}
              </Button>
              <Button variant="secondary" size="lg" className="flex-1" onClick={() => applyScanValues(false)}
                disabled={Boolean(pendingScan)}
                iconLeft={<Icon name="Pencil" size={16} />}>
                {t("continueStepByStep", "Continue step-by-step")}
              </Button>
            </div>
            <div className="flex justify-center gap-4">
              {/* One decision at a time: while the "another terminal?"
                  question is open, a third photo would silently replace the
                  second one before anybody answered for it. */}
              {!pendingScan && (
                <button onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
                  className="text-[13px] text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white font-medium underline underline-offset-2">
                  + {t("addAnotherPhoto", "Add another page or terminal")}
                </button>
              )}
              <button onClick={() => { applyScanResult(null); setScanPhotos([]); applyPendingScans([]); setMergeUndo(null); setScanMode("idle"); }}
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
            max={businessTodayIso(cutoffHour)}
            onChange={e => { if (e.target.value) { dateChosenRef.current = true; setBusinessDate(e.target.value); } }}
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
          {businessDate !== businessTodayIso(cutoffHour) && (
            <span className="text-[11px] px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full font-semibold">
              {t("pastDate")}
            </span>
          )}
          {businessDate !== businessTodayIso(cutoffHour) && (
            <button onClick={() => { dateChosenRef.current = true; setBusinessDate(businessTodayIso(cutoffHour)); }}
              className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline">
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

        {/* Sync indicator.
            Was the page's only blue surface — a decorative family carrying no
            data (this is an informational "here's what the register says", the
            exact job SectionBanner's `info` severity already does in the
            product's neutral gray). Composing the primitive also gets the
            banner the right border, radius and dark-mode pair for free. */}
        {prefillLoading && (
          <div className="mb-4 px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl text-center text-[13px] text-gray-500 dark:text-gray-400">
            {t("loadingRecords", "Loading records…")}
          </div>
        )}
        {/* The prefill request FAILED. Rendering nothing here (the old silent
            catch) is indistinguishable from "this date has no sales" — and the
            owner then closes the day with no POS cross-check and no
            register-derived expected cash, neither of which announces its own
            absence. Say it — and say ONLY that. What actually goes quiet with
            the prefill is exactly two things: the POS variance warning
            (gated on `prefill && prefill.sales.total > 0`) and the
            register-authoritative cash baseline (registerCash stays null, so
            `cashExpected` falls back to the owner's typed cash line). The
            "Expected" figure and the "Off by more than 100" shortage warning
            both still render two steps later — `cashDiff` does not read
            prefill at all — so claiming those are gone would be a banner the
            owner's own screen contradicts. */}
        {prefillStatus === "failed" && !prefillLoading && (
          <SectionBanner
            severity="warn"
            icon="AlertTriangle"
            className="mb-4"
            title={t("dcPrefillFailedTitle", "We couldn't reach your sales register")}
          >
            {/* WAS: the generic "Noget gik galt. Prøv venligst igen." headline
                over a body that said only "Indtast manuelt" — two stock strings
                stacked, neither of which told the owner that the POS
                cross-check and the register-derived cash baseline had gone
                quiet.
                THEN: a first attempt (dcPrefillFailedBody) that over-claimed —
                it said there was "no expected cash in the drawer, and no
                warning if the count comes up short", and the cash step then
                showed the owner both. A banner the next screen contradicts is
                worse than the vague pair it replaced. This key claims only the
                two things that genuinely stop: the register cross-check, and
                the baseline the Expected figure is derived FROM. */}
            {t(
              "dcPrefillFailedDetail",
              "Tonight's numbers are yours alone: no cross-check against your POS total, and the expected cash falls back to the cash line you type instead of what the till recorded. Type the day in by hand — it still locks normally.",
            )}
          </SectionBanner>
        )}
        {prefill && !prefillLoading && (
          <SectionBanner severity="info" icon="RefreshCw" className="mb-4"
            title={
              (prefill.sales.count === 1
                ? t("syncedFromSaleOne", "Synced from {n} sale", { n: prefill.sales.count })
                : t("syncedFromSaleMany", "Synced from {n} sales", { n: prefill.sales.count }))
              + (prefill.expenses.count > 0 ? (prefill.expenses.count === 1
                ? t("syncedExpensesOne", " & {n} expense", { n: prefill.expenses.count })
                : t("syncedExpensesMany", " & {n} expenses", { n: prefill.expenses.count })) : "")
            }
          >
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums">
              <span>{t("revenueLabel", "Revenue")}: <Amount value={prefill.sales.total} currency={currency} decimals={GLANCE_DECIMALS} /></span>
              {prefill.expenses.total > 0 && <span>{t("expensesLabel", "Expenses")}: <Amount value={prefill.expenses.total} currency={currency} decimals={GLANCE_DECIMALS} /></span>}
              <span>{t("netLabel", "Net")}: <Amount value={prefill.sales.total - prefill.expenses.total} currency={currency} decimals={GLANCE_DECIMALS} /></span>
            </div>
          </SectionBanner>
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
            <div className="mb-4 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 rounded-xl text-[13px] text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40">
              <div className="flex items-center gap-2 font-medium">
                <Icon name="Gift" size={16} />
                <span>
                  {/* The template carries its own "{cur}" token and
                      formatOwnerMoney already appends one ("1.500 kr."), so
                      feeding both would print "1.500 kr. DKK" — kr./DKK mixing
                      on a single surface, the exact thing the whole-page
                      migration exists to prevent. The formatted amount goes in
                      and the template's token is emptied, then the space it
                      leaves behind is collapsed. */}
                  {t("dcGkRedeemedToday", "Gavekort indløst i dag: {amount} {cur}", {
                    amount: formatOwnerMoney(redeemed, currency, { decimals: GLANCE_DECIMALS }),
                    cur: "",
                  }).replace(/\s{2,}/g, " ").trim()}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed">
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

        {/* The headline figure is a SUM of two tills — said on every step,
            including the one where it locks. See renderMergeSummary. */}
        {scanResult?.merge_info?.mode === MERGE_SUM && (
          <div className="mb-3">{renderMergeSummary()}</div>
        )}

        {/* Night shift indicator — this one genuinely compares against the
            CALENDAR day ("you're filing for yesterday because of the cutoff"),
            so it must not use businessTodayIso: at 02:00 the two would be
            equal and the banner would hide exactly when it is most useful.
            It does have to be LOCAL though — toISOString() was UTC, so at
            01:14 CEST the UTC date was already YESTERDAY, which equals the
            cutoff-derived businessDate: the banner stayed hidden through the
            whole 00:00-02:00 window, exactly when the owner is filing for
            yesterday and most needs telling. */}
        {/* Indigo was this banner's only reason to exist as its own colour, and
            "you are filing for yesterday" is a NEUTRAL fact, not a warning and
            not a success. Neutral surface; the Moon icon carries the meaning. */}
        {cutoffHour > 0 && businessDate !== localIso() && (
          <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl px-3 py-2 flex items-center gap-2 mb-3 border border-gray-200 dark:border-gray-700">
            <Icon name="Moon" size={14} className="text-gray-500 dark:text-gray-400" />
            <p className="text-[12px] text-gray-600 dark:text-gray-300">
              <strong>{t("nightShiftLabel", "Night shift:")}</strong> {t("nightShiftClosingFor", "closing for {date} (cutoff {hour}:00 AM)", { date: new Date(businessDate + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" }), hour: cutoffHour })}
            </p>
          </div>
        )}

        {/* Step header */}
        <div className="flex items-center justify-between gap-3 mb-5">
          <h2 className="text-[16px] font-semibold text-gray-900 dark:text-white">
            {currentStepId === "revenue" && t("stepNRevenue", "Step {n} — {label}", { n: step, label: t(config.stepOneLabelKey, config.stepOneLabel) })}
            {currentStepId === "payments" && t("stepNPayments", "Step {n} — Payment Methods", { n: step })}
            {currentStepId === "cash" && t("stepNCash", "Step {n} — Cash Drawer Count", { n: step })}
            {currentStepId === "tips" && t("stepNTips", "Step {n} — Tips", { n: step })}
            {currentStepId === "review" && t("stepNReview", "Step {n} — Review & Submit", { n: step })}
          </h2>
          <span className="text-[13px] text-gray-400 dark:text-gray-500 tabular-nums shrink-0">{step}/{totalSteps}</span>
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
              <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-800/50 rounded-xl p-3 text-[13px]">
                <div className="flex items-start gap-3 justify-between">
                  <div className="text-gray-700 dark:text-gray-300">
                    <div>{t("posSalesRegisterForDate", "POS sales register for this date:")}
                      <strong className="ml-1 text-gray-900 dark:text-gray-100"><Amount value={prefill.sales.total} currency={currency} decimals={GLANCE_DECIMALS} /></strong>
                      <span className="text-gray-500 dark:text-gray-400 ml-1">
                        ({prefill.sales.count === 1
                          ? t("nSaleOne", "{n} sale", { n: prefill.sales.count })
                          : t("nSaleMany", "{n} sales", { n: prefill.sales.count })})
                      </span>
                    </div>
                    {Object.keys(prefill.sales.by_item).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {Object.entries(prefill.sales.by_item).slice(0, 6).map(([name, val]) => (
                          <span key={name} className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded-lg text-[11px] tabular-nums">
                            {name}: <Amount value={val} currency={currency} decimals={GLANCE_DECIMALS} />
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
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl p-3 text-[13px] text-amber-700 dark:text-amber-300">
                  {/* These three figures are the whole point of the warning —
                      the owner compares them by eye. They go through
                      formatOwnerMoney so the close and the POS total are
                      grouped identically; with toLocaleString an EN-locale
                      browser rendered the pair as "17,030" vs "15,400" and the
                      thousands separator read as a decimal point on both. */}
                  <strong><Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1 text-amber-600 dark:text-amber-400" />{t("varianceFromRegister", "Variance from sales register: {amount}", { amount: formatOwnerMoney(variance, currency, { decimals: GLANCE_DECIMALS, sign: true }) })}</strong>
                  <p className="text-[12px] mt-1 text-amber-700/90 dark:text-amber-300/90 tabular-nums">
                    {t("closeDiffersBy", "Your close ({close}) differs by {pct}% from your POS total ({pos}). Double-check before locking — this number will be on your revisor's report.", { close: formatOwnerMoney(revenueTotal, currency, { decimals: GLANCE_DECIMALS }), pct: Math.round(pctOff * 100), pos: formatOwnerMoney(prefill.sales.total, currency, { decimals: GLANCE_DECIMALS }) })}
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
              <div className="flex items-start gap-2 text-[12px] text-gray-500 dark:text-gray-400 -mb-1">
                <Icon name="Sparkles" size={13} className="mt-0.5 shrink-0 text-gray-400 dark:text-gray-500" />
                <span>{t("dcSplitComputed", "Computed from your last {n} closes — check and adjust if needed.", { n: splitMeta.sampleSize })}</span>
              </div>
            )}
            {splitMeta?.source === "none" && (
              <div className="text-[12px] text-gray-400 dark:text-gray-500 -mb-1">
                {t("dcSplitFirstTime", "We'll suggest a split once you've closed a few days.")}
              </div>
            )}
            {revCats.map(cat => (
              <div key={cat.key}>
                <label className={labelClass}><Icon name={cat.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, cat)}</label>
                <MoneyField locale={mLocale} placeholder="0" className={inputClass}
                  value={revAmounts[cat.key] || ""}
                  onChange={e => setRevAmounts({ ...revAmounts, [cat.key]: e.target.value })} />
              </div>
            ))}
            <div className="flex gap-2">
              <input type="text" placeholder={t("addCategory") || "Add category..."} className="flex-1 px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-[13px]"
                value={customRevName} onChange={e => setCustomRevName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addCustomRevCat()} />
              <Button variant="secondary" size="lg" onClick={addCustomRevCat}>+ {t("addBtn", "Add")}</Button>
            </div>
            {/* THE figure the founder sees first. It rendered "0 DKK" on an
                untouched form — a confident claim that the venue took nothing
                today, in the browser's own locale, on the screen that produces
                the revisor's number. Now the step's one hero KPI: `hero` size,
                da-DK grouping, a whispered "kr." token, and Amount's honest "—"
                until the owner has actually typed something. */}
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700 flex items-baseline justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{t("total") || "Total"}</span>
              <Amount
                value={hasRevenueEntry ? revenueTotal : null}
                currency={currency}
                decimals={GLANCE_DECIMALS}
                size="kpi"
                className="text-gray-900 dark:text-white"
              />
            </div>
          </div>
        )}

        {/* ─── STEP: Payments ─── */}
        {currentStepId === "payments" && (
          <div className="space-y-4">
            {payMethods.map(m => (
              <div key={m.key}>
                <label className={labelClass}><Icon name={m.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, m)}</label>
                <MoneyField locale={mLocale} placeholder="0" className={inputClass}
                  value={payAmounts[m.key] || ""}
                  onChange={e => setPayAmounts({ ...payAmounts, [m.key]: e.target.value })} />
              </div>
            ))}
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{t("paymentTotal")}</span>
                <Amount
                  value={hasPaymentEntry ? paymentTotal : null}
                  currency={currency}
                  decimals={GLANCE_DECIMALS}
                  size="kpi"
                  className="text-gray-900 dark:text-white"
                />
              </div>
              <div className="flex justify-between items-baseline gap-3 mt-1.5">
                <span className="text-[12px] text-gray-500 dark:text-gray-400">{t("revenueTotal")}</span>
                <span className="text-[13px] text-gray-600 dark:text-gray-300">
                  <Amount value={hasRevenueEntry ? revenueTotal : null} currency={currency} decimals={GLANCE_DECIMALS} />
                </span>
              </div>
              {/* Same verdict object the review card renders, so the two
                  surfaces cannot disagree about whether the day ties out.
                  It used to be gated on `revenueTotal > 0` alone, which meant
                  an untouched payments column produced "Difference: 17.030 kr"
                  — the full revenue, presented as a discrepancy. */}
              {tieOut.state !== "unknown" && (
                <div className={`mt-2 px-3 py-2 rounded-lg text-[13px] font-medium ${
                  tieOut.state === "balanced" ? "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                    : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400"
                }`}>
                  {tieOut.state === "balanced"
                    ? <><Icon name="CheckCircle2" size={14} className="inline align-text-bottom mr-1" />{t("balanced", "Balanced!")}</>
                    : <><Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" />{`${t("difference", "Difference")}: ${formatOwnerMoney(tieOut.diff, currency, { decimals: GLANCE_DECIMALS, sign: true })}`}</>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── STEP: Cash Drawer ─── */}
        {currentStepId === "cash" && (
          <div className="space-y-4">
            {/* Was the page's second blue surface. A step instruction is neutral
                information, not a status — SectionBanner's `info` severity. */}
            <SectionBanner severity="info" icon="Info">
              {t("countPhysicalCash", "Count the physical cash in your drawer and enter the amount below. We'll compare it against what the system expects.")}
            </SectionBanner>
            <div>
              <label className={labelClass}>
                {cashExpectedFromRegister
                  ? t("expectedFromRegister", "Expected (from register)")
                  : t("expectedFromEntry", "Expected (from your entry)")}
              </label>
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl text-right text-[16px] font-semibold text-gray-900 dark:text-gray-100">
                <Amount value={hasCashBaseline ? cashExpected : null} currency={currency} decimals={GLANCE_DECIMALS} />
              </div>
              {cashExpectedFromRegister && (
                <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1">
                  {t("expectedFromRegisterHint", "From your synced POS register — counting against this flags a real cash shortage, not just a typo.")}
                </p>
              )}
            </div>
            <div>
              <label className={labelClass}><Icon name="Banknote" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("countedAmount", "Counted Amount")}</label>
              <MoneyField locale={mLocale} placeholder={t("countYourDrawer")} className={inputClass}
                value={cashCounted} onChange={e => setCashCounted(e.target.value)} />
            </div>
            {cashDiff !== null && (
              <div className={`px-4 py-3 rounded-xl text-center font-semibold text-[16px] ${
                Math.abs(cashDiff) <= 100 ? "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                  : "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400"
              }`}>
                {t("difference")}: <Amount value={cashDiff} currency={currency} decimals={GLANCE_DECIMALS} sign />
                {Math.abs(cashDiff) > 100 && <p className="text-[13px] font-normal mt-1"><Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" /> {t("offByMoreThan100", "Off by more than 100 — double-check your count")}</p>}
              </div>
            )}
            {/* `!cashExpected` was true for a REGISTER-DERIVED 0 as well as for
                "no baseline at all" — so a till that genuinely took no cash was
                told there was no cash figure to compare against, which is the
                opposite of true and hides a real 0-vs-counted variance. Only the
                no-baseline case gets the hint now. */}
            {!cashExpectedFromRegister && !typedCash && (
              <p className="text-[13px] text-gray-500 dark:text-gray-400 text-center">{t("noCashStep2")}</p>
            )}
          </div>
        )}

        {/* ─── STEP: Tips (only for types with tips) ─── */}
        {currentStepId === "tips" && (
          <div className="space-y-4">
            <div>
              <label className={labelClass}><Icon name="Coins" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("totalTipsLabel", "Total Tips")}</label>
              <MoneyField locale={mLocale} placeholder="0" className={inputClass}
                value={tipsTotal} onChange={e => setTipsTotal(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}><Icon name="Users" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("staffCountLabel", "Staff Count")}</label>
              <input type="number" inputMode="numeric" placeholder={t("staffCountPrompt")} className={inputClass}
                value={staffCount} onChange={e => setStaffCount(e.target.value)} />
            </div>
            {tipsPP !== null && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 text-center">
                {/* Was text-emerald-600 dark:text-gray-300 — the accent drained
                    to grey in dark. It is a LABEL, so it is neutral in both. */}
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{t("perPerson")}</p>
                <Amount value={tipsPP} currency={currency} decimals={GLANCE_DECIMALS} size="kpi" className="mt-1 text-gray-900 dark:text-white" />
              </div>
            )}
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-[12px] text-amber-700 dark:text-amber-300">
              <strong>{t("tipsTaxNoteLabel", "Danish tax note:")}</strong> {t("tipsTaxNoteBody", "Tips must be reported via eIndkomst. Share this data with your revisor.")}
            </div>
          </div>
        )}

        {/* ─── REVIEW STEP ─── */}
        {currentStepId === "review" && (
          <div className="space-y-4">
            {/* Date confirmation */}
            <div className="flex items-center gap-2 text-[13px] text-gray-700 dark:text-gray-300">
              <Icon name="Calendar" size={14} className="text-gray-500 dark:text-gray-400" />
              <span className="font-medium">
                {new Date(businessDate + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              </span>
              {businessDate !== businessTodayIso(cutoffHour) && (
                <span className="text-[11px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg font-semibold">{t("pastDate")}</span>
              )}
            </div>

            {/* Revenue summary. This card and its siblings below are the
                kasserapport as the owner will see it on the PDF: every row and
                every total at LEDGER_DECIMALS (two) so the rows visibly add up to the
                card, and tabular-nums so the ø-column lines up down the stack. */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <h3 className="font-semibold text-[13px] text-gray-500 dark:text-gray-400 mb-2">{t("revenue")}</h3>
              {revCats.filter(c => revAmounts[c.key]).map(c => (
                <div key={c.key} className="flex justify-between gap-3 text-[13px] py-0.5 text-gray-700 dark:text-gray-300 tabular-nums">
                  <span><Icon name={c.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, c)}</span>
                  <span><Amount value={readMoney(revAmounts[c.key])} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
              ))}
              <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-2 text-gray-900 dark:text-white tabular-nums">
                <span>{t("total")}</span><span><Amount value={hasRevenueEntry ? revenueTotal : null} currency={currency} decimals={LEDGER_DECIMALS} /></span>
              </div>
            </div>

            {/* MOMS (VAT) summary — with auto/manual toggle.
                The second indigo→violet gradient, gone for the same reason as
                the first: two colour families and a hardcoded #6366f1 that
                appear nowhere else in the product and carry no data. This is
                the block the revisor's MOMS number comes out of, so it now
                reads like a ledger — neutral ground, ø-aligned tabular figures,
                and the one bold line reserved for the total. */}
            {revenueTotal > 0 && (
              <div className="rounded-xl p-4 space-y-3 bg-gray-50 dark:bg-gray-700/50">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-[13px] text-gray-500 dark:text-gray-400">{vatName} ({vatRatePct}%)</h3>
                  {/* Toggle: Auto vs Manual — the Chip primitive, so it shares
                      the product's single selected-state treatment with every
                      other pick-one row and is a real aria-pressed button. */}
                  <div className="flex gap-1.5">
                    <Chip size="sm" selected={momsMode === "auto"} onClick={() => setMomsMode("auto")}>
                      {t("autoLabel")}
                    </Chip>
                    <Chip size="sm" selected={momsMode === "manual"} onClick={() => setMomsMode("manual")}>
                      {t("fromReceipt")}
                    </Chip>
                  </div>
                </div>
                {momsMode === "manual" && (
                  <div>
                    <label className="text-[12px] text-gray-500 dark:text-gray-400 mb-1 block">{t("enterMomsFromReceipt", "Enter {vat} from your Z-report / receipt", { vat: vatName })}</label>
                    <MoneyField locale={mLocale} placeholder={t("momsAmountPlaceholder")}
                      className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-400 text-right text-[16px] tabular-nums"
                      value={momsManual} onChange={e => setMomsManual(e.target.value)} />
                  </div>
                )}
                {momsMode === "auto" && (
                  <p className="text-[12px] text-gray-500 dark:text-gray-400">
                    {momsSource === "scanned"
                      ? t("momsFromZReport", "Read from your Z-report — not recalculated from revenue.")
                      : t("momsAutoCalc", "Auto-calculated: Revenue × {pct}% / {div}%", { pct: vatRatePct, div: 100 + vatRatePct })}
                  </p>
                )}
                <div className="flex justify-between text-[13px] text-gray-700 dark:text-gray-300 py-0.5 tabular-nums">
                  <span>{t("revenueMedMoms", "Revenue (med moms)")}</span>
                  <span><Amount value={revenueTotal} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
                {/* Salg uden moms i dag — exempt rows the owner already
                    flagged via Quick Sale MOMS-fri or the Sales page.
                    Pulled from /property-report (taxable_sales vs
                    total_revenue) so the close MOMS calc matches the
                    SKAT MOMS-angivelse PDF. DK term locked. */}
                {exemptStatus === "ok" && exemptSalesTotal > 0 && (
                  <div className="flex justify-between text-[12px] text-amber-700 dark:text-amber-300 py-0.5 tabular-nums">
                    <span>{t("salgUdenMomsToday") || "Salg uden moms i dag"}</span>
                    <span><Amount value={-exemptSalesTotal} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                  </div>
                )}
                {/* The exempt lookup failed. Saying nothing here would let the
                    MOMS figure below stand as if the exempt total had been
                    checked and found to be zero — a computed number posing as a
                    measured one, on the line that goes to SKAT. So the row
                    renders with an honest "—" and the reason. */}
                {exemptStatus === "failed" && (
                  <div className="flex justify-between text-[12px] text-amber-700 dark:text-amber-300 py-0.5 gap-3">
                    <span>{t("salgUdenMomsToday") || "Salg uden moms i dag"}</span>
                    <span className="text-right">
                      <span className="tabular-nums">—</span>
                      <span className="block text-gray-500 dark:text-gray-400">{t("somethingWentWrong")}</span>
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-[13px] font-semibold py-0.5 text-gray-900 dark:text-gray-100 tabular-nums">
                  <span>{vatName} {vatRatePct}%{momsMode === "manual" ? ` ${t("fromReceiptSuffix", "(from receipt)")}` : ""}</span>
                  <span><Amount value={momsTotal} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
                <div className="flex justify-between text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-1 text-gray-900 dark:text-white tabular-nums">
                  <span>{t("revenueUdenMoms", "Revenue (uden moms)")}</span>
                  <span><Amount value={revenueExMoms} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
                <div className="pt-2 border-t border-gray-200 dark:border-gray-600">
                  <p className="text-[12px] text-gray-500 dark:text-gray-400">
                    <Icon name="BarChart3" size={14} className="inline align-text-bottom mr-1" /> {t("dailyCloseReconcileNotePre", "Your kasserapport is your cash-drawer reconciliation. Your moms filing in ")}<Link to="/tax" className="font-semibold underline hover:no-underline text-gray-700 dark:text-gray-200">{t("dailyCloseReconcileNoteLink", "Skat Autopilot")}</Link>{t("dailyCloseReconcileNotePost", " reads from the POS sales register — the kasserapport adds a cross-check that flags variance.")}
                  </p>
                </div>
              </div>
            )}

            {/* Payment summary */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
              <h3 className="font-semibold text-[13px] text-gray-500 dark:text-gray-400 mb-2">{t("paymentsLabel")}</h3>
              {payMethods.filter(m => payAmounts[m.key]).map(m => (
                <div key={m.key} className="flex justify-between gap-3 text-[13px] py-0.5 text-gray-700 dark:text-gray-300 tabular-nums">
                  <span><Icon name={m.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, m)}</span>
                  <span><Amount value={readMoney(payAmounts[m.key])} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
              ))}
              <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-2 text-gray-900 dark:text-white tabular-nums">
                <span>{t("total")}</span><span><Amount value={hasPaymentEntry ? paymentTotal : null} currency={currency} decimals={LEDGER_DECIMALS} /></span>
              </div>
            </div>

            {/* Cash drawer */}
            {cashCounted && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <h3 className="font-semibold text-[13px] text-gray-500 dark:text-gray-400 mb-2">{t("cashDrawer")}</h3>
                <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300 tabular-nums"><span>{cashExpectedFromRegister ? t("expectedFromRegister", "Expected (from register)") : t("expectedFromEntry", "Expected (from your entry)")}</span><span><Amount value={hasCashBaseline ? cashExpected : null} currency={currency} decimals={LEDGER_DECIMALS} /></span></div>
                <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300 tabular-nums"><span>{t("counted")}</span><span><Amount value={cashCountedVal} currency={currency} decimals={LEDGER_DECIMALS} /></span></div>
                <div className={`flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-2 tabular-nums ${cashDiff < -100 ? "text-red-700 dark:text-red-400" : "text-gray-900 dark:text-white"}`}>
                  <span>{t("difference")}</span><span><Amount value={cashDiff} currency={currency} decimals={LEDGER_DECIMALS} sign /></span>
                </div>
              </div>
            )}

            {/* Expenses (from synced data). Red stays — it is the one place on
                this card where the colour carries data (money leaving), and the
                minus sign alone is easy to miss in a stack of figures. */}
            {prefill && prefill.expenses.total > 0 && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 border border-red-200 dark:border-red-900/40">
                <h3 className="font-semibold text-[13px] text-red-700 dark:text-red-400 mb-2">{t("todaysExpenses")}</h3>
                {Object.entries(prefill.expenses.by_category).map(([cat, val]) => (
                  <div key={cat} className="flex justify-between gap-3 text-[13px] py-0.5 text-red-700 dark:text-red-300 tabular-nums">
                    <span>{cat}</span>
                    <span><Amount value={-val} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                  </div>
                ))}
                <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-red-200 dark:border-red-800 mt-2 text-red-700 dark:text-red-300 tabular-nums">
                  <span>{t("totalExpenses")}</span><span><Amount value={-prefill.expenses.total} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
                <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 mt-1 text-gray-900 dark:text-gray-100 tabular-nums">
                  <span>{t("netProfit")}</span><span><Amount value={hasRevenueEntry ? revenueTotal - prefill.expenses.total : null} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
              </div>
            )}

            {/* Tips */}
            {tipsTotal && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <h3 className="font-semibold text-[13px] text-gray-500 dark:text-gray-400 mb-2">{t("tipsLabel", "Tips")}</h3>
                <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300 tabular-nums"><span>{t("total")}</span><span><Amount value={readMoney(tipsTotal)} currency={currency} decimals={LEDGER_DECIMALS} /></span></div>
                <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300 tabular-nums"><span>{t("staffCountLabel", "Staff Count")}</span><span>{staffCount}</span></div>
                {tipsPP && <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-2 text-gray-900 dark:text-white tabular-nums"><span>{t("perPerson")}</span><span><Amount value={tipsPP} currency={currency} decimals={LEDGER_DECIMALS} /></span></div>}
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
                <MoneyField locale={mLocale} placeholder="0"
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
                <div className="h-4 w-2/3 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" aria-hidden="true" />
                <div className="h-3 w-full mt-2 bg-gray-100 dark:bg-gray-800 rounded-lg animate-pulse" aria-hidden="true" />
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
                      className="mt-1 h-4 w-4 rounded-lg text-emerald-600 focus:ring-gray-400"
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
                        <Link
                          to="/subscription"
                          className="inline-block mt-2 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
                        >
                          {t("pricingUpgradeStarter") || "Upgrade to Starter"} →
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && (
              <SectionBanner severity="critical" icon="AlertCircle">
                {error}
                {/* The server's wording, demoted. Same treatment as the offline
                    queue's failed rows: secondary, muted, there for the revisor
                    — never the headline, because it is English and this is the
                    Danish audit trail. */}
                {errorDetail && (
                  <span className="block mt-1 text-[12px] opacity-70">{errorDetail}</span>
                )}
              </SectionBanner>
            )}

            {/* ─── Does the day add up? ───────────────────────────────
                The last thing on the card, directly above Bekræft & lås,
                because this is the step the promoted scan path jumps to and
                the only place left to say it before the close is signed.

                It deliberately does NOT block the lock. An owner may be
                genuinely 200 kr short and still has to file the day; the
                rule on this surface is say it plainly, not prevent it. Once
                locked, a close that does not reconcile is picked up again by
                the close_unreconciled row in "Skal ses nu", so the statement
                survives the lock instead of dying with the wizard. */}
            {(hasRevenueEntry || hasPaymentEntry) && (
              <div className={`rounded-xl p-4 ${
                tieOut.state === "off"
                  ? "bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40"
                  : "bg-gray-50 dark:bg-gray-700/50"
              }`}>
                <div className="flex items-start gap-2">
                  <Icon
                    name={tieOut.state === "balanced" ? "CheckCircle2" : tieOut.state === "off" ? "AlertTriangle" : "HelpCircle"}
                    size={16}
                    className={`shrink-0 mt-0.5 ${
                      tieOut.state === "off"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-gray-500 dark:text-gray-400"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    {tieOut.state === "balanced" && (
                      <p className="text-[13px] font-medium text-gray-900 dark:text-white">
                        {t("dcTieOutBalanced", "Revenue and payments match.")}
                      </p>
                    )}
                    {tieOut.state === "off" && (
                      <>
                        <p className="text-[13px] font-semibold text-amber-800 dark:text-amber-300 tabular-nums">
                          {t("dcTieOutOff", "Revenue and payments differ by {amount}.", {
                            amount: formatOwnerMoney(tieOut.diff, currency, { decimals: LEDGER_DECIMALS, sign: true }),
                          })}
                        </p>
                        <p className="text-[12px] text-amber-700 dark:text-amber-400 mt-1">
                          {t("dcTieOutOffHint", "You can still lock the day — the kasserapport records the difference exactly as it stands.")}
                        </p>
                      </>
                    )}
                    {tieOut.state === "unknown" && (
                      <p className="text-[13px] text-gray-700 dark:text-gray-300">
                        {t("dcTieOutUnknown", "We can't tell whether the day adds up: revenue or payments are still empty.")}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
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
                  {/* moneyRejected: one of the amount boxes holds text that is
                      not an amount. This close writes a ledger row and prints
                      a kasserapport, so it does not go out on a figure nobody
                      could read — the offending field says so in place. */}
                  <Button variant="primary" size="lg" onClick={() => handleSubmit()} disabled={saving || willSave === 0 || moneyRejected}>
                    {saving ? (
                      t("savingEllipsis", "Saving…")
                    ) : !isOnline ? (
                      <span className="inline-flex items-center gap-2"><Icon name="UploadCloud" size={16} /> {t("queueAndLockOffline", "Queue & Lock (offline)")}</span>
                    ) : (
                      <span className="inline-flex items-center gap-2"><Icon name="Lock" size={16} /> {t("confirmAndLock", "Confirm & Lock")}</span>
                    )}
                  </Button>
                  {/* A disabled primary with nothing beside it is
                      indistinguishable from a broken one. The owner taps
                      Confirm & Lock, nothing happens, nothing appears — and in
                      the moneyRejected case the "Will save total" underneath
                      still reads a plausible figure, because revenueTotal
                      scores an unreadable box as 0. So say which of the three
                      gates is closed, and for the unreadable one say where. */}
                  {!saving && (moneyRejected || willSave === 0) && (
                    <p className="text-[12px] text-amber-700 dark:text-amber-400 text-right max-w-xs flex items-start gap-1.5 justify-end">
                      <Icon name="AlertTriangle" size={13} className="shrink-0 mt-0.5" />
                      <span>
                        {moneyRejected
                          ? (rejectedArea
                              ? t("dcLockBlockedAmountIn", "One amount under {area} can't be read — go back and fix the red field.", {
                                  area: {
                                    revenue: t("revenueLabel", "Revenue"),
                                    payments: t("paymentsLabel", "Payments"),
                                    cash: t("dcCashLabel", "Cash"),
                                    tips: t("tipsLabel", "Tips"),
                                    gavekort: t("gavekort", "Gavekort"),
                                    moms: vatName,
                                  }[rejectedArea],
                                })
                              : t("dcLockBlockedAmount", "One amount can't be read — go back and fix the red field."))
                          : t("dcLockBlockedNoRevenue", "Enter tonight's revenue before locking.")}
                      </span>
                    </p>
                  )}
                  <p className="text-[12px] text-gray-500 dark:text-gray-400 text-right">
                    {/* The number about to be written to the ledger. It has to
                        be formatted exactly like the review card above it and
                        the PDF below it, or the owner cannot check that the
                        three agree — which is the whole job of this preview. */}
                    {t("willSaveTotal", "Will save total:")}{" "}
                    <strong className="text-gray-900 dark:text-gray-100">
                      <Amount value={willSave} currency={currency} decimals={LEDGER_DECIMALS} />
                    </strong>
                    {usingOverride && (
                      <span className="ml-1 text-amber-700 dark:text-amber-400">
                        {t("fromReceiptBreakdownSums", "(from receipt — your breakdown sums to {sum})", { sum: formatOwnerMoney(revenueTotal, currency, { decimals: LEDGER_DECIMALS }) })}
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
          className="text-xs px-2.5 py-1 bg-amber-500 text-white rounded-lg font-medium hover:bg-amber-600 disabled:opacity-50">
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
          <Link to="/subscription" className="inline-block mt-2 text-[12px] font-semibold text-amber-800 dark:text-amber-300 hover:underline">
            {t("pricingUpgradeStarter") || "Upgrade to Starter"} →
          </Link>
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
                  <p className="text-[12px] text-gray-600 dark:text-gray-300 mt-0.5 tabular-nums">
                    {/* The template carries "{currency}" of its own and
                        formatOwnerMoney already appends a token, so both would
                        print "4.200 kr. DKK". The formatted amounts go in and
                        the template's token (with the space before it) comes
                        out — one token per figure, "kr." everywhere. */}
                    {(t("bankDropReminderBody") || "Put {amount} {currency} in safe / drop bag. Keep {float} {currency} float in the drawer.")
                      .replace("{amount}", formatOwnerMoney(bankDrop.to_drop_dkk ?? 0, currency, { decimals: GLANCE_DECIMALS }))
                      .replace("{float}", formatOwnerMoney(bankDrop.leave_in_drawer_dkk ?? 1000, currency, { decimals: GLANCE_DECIMALS }))
                      .replace(/\s*\{currency\}/g, "")}
                  </p>
                  <button onClick={handleBankDropDone}
                    className="mt-2 text-xs px-3 py-1 bg-amber-500 text-white rounded-lg font-medium hover:bg-amber-600">
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
function HistoryView({ data, currency, t, onRefresh, insights, onEdit, lastLockedClose, onDismissLastLocked,
  loading = false, failed = false, isOnline = true }) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [downloading, setDownloading] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [shareToast, setShareToast] = useState("");
  const [unlockId, setUnlockId] = useState(null);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  // A refused unlock used to be swallowed by `catch { /* ignore */ }`, so the
  // modal closed and the row stayed locked — identical on screen to success.
  // On a signed kasserapport that is the worst possible silence.
  const [unlockError, setUnlockError] = useState("");
  // Per-row PDF failure. Kept per-row rather than in the shared export banner
  // at the top of the tab, because that banner is off-screen by the time you
  // have scrolled to a close from three weeks ago.
  const [rowError, setRowError] = useState(null); // {id, message, isPlanCap}

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
    try {
      localStorage.setItem("bonbox_accountant_fmt", fmt);
    } catch {
      // A remembered dropdown choice, nothing more. Private mode and a full
      // quota both throw here, and neither is worth a word to the owner —
      // the export still runs in the format now on screen.
    }
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
  // and the Danish greeting line ("Hej Anna,"). Degrading to the mailto
  // path when it fails is deliberate and unchanged — the Send button still
  // works, just without a pre-filled recipient.
  //
  // What was NOT harmless: `!businessProfile?.accountant_email` also drives an
  // on-screen hint telling the owner to go and save their revisor's address.
  // On a failed read that hint fired at owners who saved it months ago, and
  // sent them to Profile to re-type something already there — a failed fetch
  // asserting a fact about the owner's own settings. `profileKnown` below is
  // the third state: the hint now needs a profile we actually received.
  const profileQ = useAsyncData(() => api.get("/business"), []);
  const businessProfile = profileQ.data;
  const profileKnown = !profileQ.loading && !profileQ.failed;
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
  // /billing/me keeps its silent catch ON PURPOSE, and it is the one shape of
  // silence that is honest: every failure leaves exportCapDays at 366, and the
  // whole cap UI — the hint line, the locked presets, the "exceeds your plan"
  // warning — is gated on `exportCapDays < 366`. So an unanswered read renders
  // no claim about the owner's plan at all, rather than a comforting one, and
  // the backend is the authoritative gate either way.
  useEffect(() => {
    api.get("/billing/me").then(r => {
      const cap = r.data?.caps?.daily_close_export_days;
      if (typeof cap === "number" && cap > 0) setExportCapDays(cap);
      if (r.data?.plan) setPlanTier(r.data.plan);
    }).catch(() => {
      // Deliberate, and argued above: a failed read leaves exportCapDays at
      // 366, and the whole cap UI is gated on `< 366`, so this renders NO
      // claim about the owner's plan rather than a comforting one. The
      // backend is the authoritative gate either way.
    });
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
      // Through the one delivery helper: this block revoked the blob URL in the
      // same tick as the click and never appended the anchor, which is a 0-byte
      // file on Safari and an ignored click on Firefox. A not-ok outcome is the
      // only signal the owner gets, so it reaches the same banner as a 402.
      const out = await saveFile(blob, `daily-close_${activeRange.from}_to_${activeRange.to}.${fmt}`, {
        type: _MIME[fmt] || "application/octet-stream",
      });
      if (!out.ok) setExportError(t("dcExportFailed"));
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
              // WAS: icon: "📤". A Free owner tapping "Send to revisor" met an
              // emoji in the upgrade dialog — the one moment the product most
              // needs to look like an accounting tool. UpgradeNudge prefers a
              // Lucide `iconName` over the legacy emoji prop.
              iconName: "Send",
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
    setUnlockError("");
    try {
      await api.post(`/daily-close/${unlockId}/unlock`, { reason: unlockReason.trim() });
      setUnlockId(null);
      setUnlockReason("");
      onRefresh();
    } catch (e) {
      // Keep the modal open with the server's own reason — a manager without
      // the right to unlock, a close already unlocked elsewhere, an offline
      // phone. The owner must know the kasserapport is still LOCKED.
      setUnlockError(errText(e, t("dcUnlockFailed", "Could not unlock this close.")));
    } finally {
      setUnlocking(false);
    }
  };

  /**
   * Delete a DRAFT kasserapport.
   *
   * The gap this closes: the row actions were Edit / Send / PDF / Unlock only,
   * so a mistaken or self-contradictory draft could never be removed — it sat
   * forever in the exact list an owner hands to their revisor.
   *
   * A LOCKED close is a record under Bogføringsloven §10 and is never deletable
   * from here; the server refuses it with 409 close_locked and the button is
   * not rendered for it either. Deletion is SOFT (is_deleted / deleted_at) and
   * writes an audit row, both server-side.
   */
  const deleteDraft = async (dc) => {
    // "Delete this kladde?" was true of every row on the page. With two drafts
    // next to each other the dialog looked identical for both, so the only
    // thing standing between the owner and the wrong day was their memory of
    // which button they tapped. The dialog now repeats the day back in the
    // same words the row uses, and states the total it is about to remove.
    const dayLabel = new Date(dc.date).toLocaleDateString(dateLocale(), {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
    });
    const ok = await confirm({
      title: t("dcDeleteDraftTitleDated", "Delete the kladde for {date}?", { date: dayLabel }),
      message: t(
        "dcDeleteDraftBodyAmount",
        // No full stop straight after the amount: the Danish money token ends
        // in one already ("1.070 kr."), and the dialog rendered "kr..".
        "This kladde shows {amount} — it is removed from your history and from anything you send your revisor. Locked closes cannot be deleted.",
        { amount: formatOwnerMoney(dc.revenue_total ?? 0, currency, { decimals: GLANCE_DECIMALS }) },
      ),
      confirmLabel: t("delete", "Delete"),
      cancelLabel: t("cancel", "Cancel"),
      destructive: true,
    });
    if (!ok) return;
    setDeleting(dc.id);
    setRowError(null);
    try {
      await api.delete(`/daily-close/${dc.id}`);
      onRefresh();
    } catch (e) {
      // A refused delete must say so next to the button the owner tapped —
      // the server's own reason first (e.g. the close was locked in another
      // tab between render and click).
      setRowError({
        id: dc.id,
        message: errText(e, t("dcDeleteFailed", "Could not delete this draft.")),
        isPlanCap: false,
      });
    } finally {
      setDeleting(null);
    }
  };

  const downloadPdf = async (id, dateStr, isDraft = false) => {
    setDownloading(id);
    setRowError(null);
    try {
      const res = await api.get(`/daily-close/${id}/pdf`, { responseType: "blob" });
      // The single most revisor-facing artifact in the product, and it was the
      // worst-shaped download in the repo: synchronous revoke, anchor never
      // appended. Through saveFile, and a failure says so instead of leaving
      // the owner looking at a Downloads folder that never got a file.
      //
      // A draft's filename must not imply finality either — it is mirrored
      // from the server's own Content-Disposition (kasserapport_kladde_…).
      // A kladde mailed on and opened a week later is identified by its
      // filename alone.
      const name = isDraft
        ? `kasserapport_kladde_${dateStr}.pdf`
        : `kasserapport_${dateStr}.pdf`;
      const out = await saveFile(res.data, name, {
        type: "application/pdf",
      });
      if (!out.ok) setRowError({ id, message: t("dcExportFailed"), isPlanCap: false });
    } catch (e) {
      // Same blob-aware parser the range export uses, so a plan cap (402)
      // arrives here as a real sentence plus the upgrade link instead of a
      // button that flickers and does nothing.
      const parsed = await parseExportError(e);
      setRowError({ id, message: parsed.message, isPlanCap: parsed.isPlanCap });
    } finally {
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

  /* ── Loading → failed → empty → data. In that order, every time. ──
     The empty state below is the product's first-run welcome ("submit your
     first end-of-day close"), and it used to be what an owner with a year of
     kasserapporter saw whenever the GET did not come back — the one screen
     that could make them doubt the books was the one that lied. The two
     branches in front of it are what make that empty state true again:
     nothing reaches it now except a list the server actually returned empty.
     A skeleton with WORDS, not a bare spinner, so the first paint of the tab
     never reads as "you have none" either. */
  if (loading && !data.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-100 dark:border-gray-700">
        <div className="flex justify-center mb-3 animate-pulse"><Icon name="ClipboardList" size={36} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="text-[13px] text-gray-500 dark:text-gray-400">{t("dcLoadingHistory", "Loading your kasserapporter…")}</p>
      </div>
    );
  }

  /* INSTEAD of the empty state, never above it — rendering both would still
     leave "submit your first close" on a page that has no idea. Offline gets
     its own headline: "something went wrong" is not true of a phone with no
     signal, and this tab is reachable offline by design. */
  if (failed && !data.length) {
    return (
      <LoadFailed
        onRetry={onRefresh}
        title={isOnline ? null : t("dcOfflineCantLoad", "You're offline, so this couldn't be loaded.")}
      />
    );
  }

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
      {/* Stale, and saying so. A reload that failed keeps the rows that WERE
          true rather than blanking a list the owner may be reading mid-task —
          but a refreshed-looking list that is actually ten minutes old is the
          same lie in slower motion, so the banner names it and offers the
          retry. (A close locked since the last good load is not in these
          rows; that is exactly what "may not be up to date" means.) */}
      {failed && data.length > 0 && (
        <LoadFailed
          onRetry={onRefresh}
          title={isOnline ? null : t("dcOfflineCantLoad", "You're offline, so this couldn't be loaded.")}
          body={t("dcShowingLastLoaded", "Showing the last kasserapporter we loaded — they may not be up to date.")}
        />
      )}

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

      {/* Active cash streak warning banner. Same two-level collapse as
          StreakAlertCard: anything that is not critical is amber, and the
          yellow third level is gone. */}
      {activeStreak && (
        <div className={`rounded-xl p-3 flex items-center gap-2 border ${
          activeStreak.severity === "critical"
            ? "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800"
            : "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800"
        }`}>
          {/* WAS: the server's raw emoji (🚨 / ⚠️ / 💡). Lucide, in the same
              red-or-amber the sentence beside it already carries. */}
          <Icon name={insightIconName(activeStreak)} size={16} className={`shrink-0 ${
            activeStreak.severity === "critical" ? "text-red-700 dark:text-red-300"
              : "text-amber-700 dark:text-amber-300"
          }`} />
          <p className={`text-[13px] font-medium ${
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
          <h3 className="text-[14px] font-semibold text-gray-900 dark:text-white">
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
                  <Link to="/subscription" className="ml-2 underline font-semibold hover:no-underline">
                    {t("planCapHintCta") || "Upgrade for full year →"}
                  </Link>
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
                    <Icon name="AlertTriangle" size={13} className="inline align-text-bottom mr-1" /> {t("dcRangeExceedsCap", "This range is {span} days — your plan caps at {cap}. The export will be rejected by the server.", { span, cap: exportCapDays })} {canPurchaseInApp() && (<Link to="/subscription" className="underline font-semibold">{t("dcUpgradeQuestion", "Upgrade?")}</Link>)}
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
            {/* Download buttons — one per format.
                Three buttons, three hand-rolled treatments: gray-900, gray-700
                and BLUE. The blue said nothing about CSV; it was the only thing
                separating a tertiary export from a secondary one. The Button
                primitive says it properly — Excel is the recommended handoff
                (primary), PDF and CSV are alternatives (secondary) — and brings
                the correct disabled and focus states with it. */}
            <Button
              size="sm"
              variant="primary"
              onClick={() => downloadRange("xlsx")}
              busy={exportingFmt === "xlsx"}
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
              iconLeft={exportingFmt === "xlsx" ? null : <Icon name="BarChart3" size={14} />}
              title={t("excelTooltip", "Best for your accountant — sortable, filterable, pivotable")}
            >
              {exportingFmt === "xlsx" ? (t("generatingPdfBtn") || "Generating…") : "Excel"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => downloadRange("pdf")}
              busy={exportingFmt === "pdf"}
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
              iconLeft={exportingFmt === "pdf" ? null : <Icon name="FileText" size={14} />}
              className="border border-gray-200 dark:border-gray-700"
              title={t("pdfTooltip", "One-pager — easy to read, not editable")}
            >
              {exportingFmt === "pdf" ? (t("generatingPdfBtn") || "Generating…") : "PDF"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => downloadRange("csv")}
              busy={exportingFmt === "csv"}
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
              iconLeft={exportingFmt === "csv" ? null : <Icon name="FileSpreadsheet" size={14} />}
              className="border border-gray-200 dark:border-gray-700"
              title={t("csvTooltip", "Raw data — for e-conomic / Dinero / Billy imports")}
            >
              {exportingFmt === "csv" ? (t("generatingPdfBtn") || "Generating…") : "CSV"}
            </Button>

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
            the next send is one-tap. Hidden once the email is set, and
            withheld entirely until the profile has actually been read: we do
            not tell an owner what is missing from a record we could not open. */}
        {profileKnown && !businessProfile?.accountant_email && rangeCount > 0 && (
          <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
            <Icon name="Lightbulb" size={12} className="inline align-text-bottom mr-1" /> {t("accountantHint") || "Tip: save your accountant's email on "}
            <Link to="/profile" className="text-amber-600 dark:text-amber-400 hover:underline">
              {t("profileLinkLabel") || "Profile"}
            </Link>
            {" "}{t("accountantHintTail") || "to skip typing it every time."}
          </p>
        )}

        {sendStatus && (
          <p className="mt-2 text-[12px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1"><Icon name="CheckCircle2" size={14} /> {sendStatus}</p>
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
                <Link to="/subscription" className="ml-2 underline font-semibold hover:no-underline">
                  {t("dcUpgradeArrow", "Upgrade →")}
                </Link>
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
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-[14px] font-semibold text-gray-900 dark:text-white">
                    {new Date(dc.date).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                  </h3>
                  {/* `dark:text-gray-300` under a light emerald was the drain:
                      the "Locked" badge lost its accent entirely at night. It
                      keeps the accent in dark now, at emerald-400 (9.2:1 on the
                      dark card) and emerald-700 in light (5.5:1 on white) — the
                      old emerald-600 measured 3.8:1, under the 4.5:1 floor for
                      an 11px badge. */}
                  {(dc.status || "confirmed") === "confirmed" ? (
                    <span className="text-[11px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg font-semibold inline-flex items-center gap-1"><Icon name="Lock" size={11} /> {t("dcStatusLocked", "Locked")}</span>
                  ) : (
                    <span className="text-[11px] px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg font-semibold inline-flex items-center gap-1"><Icon name="Pencil" size={11} /> {t("dcStatusDraft", "Draft")}</span>
                  )}
                </div>
                {dc.closed_by && <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">{t("dcClosedBy", "Closed by {name}", { name: dc.closed_by })}</p>}
                {dc.unlock_reason && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400 mt-0.5">{t("dcUnlockedReason", "Unlocked: {reason}", { reason: dc.unlock_reason })}</p>
                )}
              </div>
              <div className="text-right shrink-0">
                {/* The row's money figure leads in neutral gray-900. Emerald is
                    reserved for the money MOMENT (a lock, a send); a revenue
                    figure is a fact, and colouring facts is what made this page
                    read as nine palettes. */}
                <Amount value={dc.revenue_total} currency={currency} decimals={GLANCE_DECIMALS} size="kpi" className="text-gray-900 dark:text-white" />
                {revChange !== null && Math.abs(revChange) >= 1 && (
                  <p className={`text-[11px] font-semibold tabular-nums mt-0.5 ${revChange > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                    {revChange > 0 ? "↑" : "↓"} {Math.abs(revChange)}% {t("dcVsPrev", "vs prev")}
                  </p>
                )}
              </div>
            </div>

            {/* Revenue + payment chips. The payment row used to be blue for no
                reason other than "it is a different kind of chip" — a whole
                colour family spent on a distinction the label already makes. */}
            <div className="flex flex-wrap gap-2 mt-3">
              {Object.entries(rev).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-gray-50 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 rounded-lg text-[11px] font-medium tabular-nums">
                  {k}: <Amount value={v} currency={currency} decimals={GLANCE_DECIMALS} />
                </span>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 mt-2">
              {Object.entries(pay).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-gray-50 dark:bg-gray-800/50 text-gray-600 dark:text-gray-400 rounded-lg text-[11px] font-medium tabular-nums border border-gray-200 dark:border-gray-700">
                  {k}: <Amount value={v} currency={currency} decimals={GLANCE_DECIMALS} />
                </span>
              ))}
            </div>

            {/* Bottom row */}
            <div className="flex items-center justify-between gap-3 flex-wrap mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="flex gap-4 flex-wrap text-[12px] text-gray-500 dark:text-gray-400 tabular-nums">
                {dc.cash_difference !== null && (
                  <span className={dc.cash_difference < -100 ? "text-red-600 dark:text-red-400 font-semibold" : ""}>
                    {t("dcCashLabel", "Cash")}: <Amount value={dc.cash_difference} currency={currency} decimals={GLANCE_DECIMALS} sign />
                  </span>
                )}
                {dc.tips_total > 0 && (
                  <span>{t("tipsLabel", "Tips")}: <Amount value={dc.tips_total} currency={currency} decimals={GLANCE_DECIMALS} /> ({t("dcStaffCountInline", "{count} staff", { count: dc.tips_staff_count })})
                    {tipsChange !== null && Math.abs(tipsChange) >= 1 && (
                      <span className={`ml-1 font-semibold ${tipsChange > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
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
                {/* The URL comes off the server row, so it goes through
                    safeImageUrl before the browser is ever asked to follow it
                    (utils/safeUrl.js — https / same-origin blob only). Same
                    rule the photo thumbnails in the scan card already use;
                    an unsafe or unparseable value renders no link at all. */}
                {(() => {
                  const safeReceipt = dc.receipt_photo ? safeImageUrl(dc.receipt_photo) : null;
                  if (!safeReceipt) return null;
                  return (
                    /* Indigo was this row's fourth colour, on a link that is
                       simply "open the photo". Neutral, like its neighbours. */
                    <a href={safeReceipt} target="_blank" rel="noreferrer"
                      title={t("dcViewOriginalZReport", "View original Z-report photo")}
                      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 font-medium border border-gray-200 dark:border-gray-700">
                      <Icon name="Image" size={13} /> {t("dcReceiptLabel", "Receipt")}
                    </a>
                  );
                })()}
                {/* Locked closes: show Unlock; drafts: show Edit. Both
                    routes reach the same edit experience — Unlock first
                    flips status to draft, then the user picks Edit on
                    the now-draft row. */}
                {/* Unlock KEEPS amber: it is the one destructive-ish action in
                    the row (it re-opens a locked kasserapport), so the colour
                    is carrying data. Edit was blue for no reason and is now a
                    neutral secondary alongside Send and PDF. */}
                {(dc.status || "confirmed") === "confirmed" && (
                  <button onClick={() => { setUnlockId(dc.id); setUnlockReason(""); }}
                    className="text-[11px] px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-400 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 font-medium inline-flex items-center gap-1.5 border border-amber-200 dark:border-amber-800">
                    <Icon name="LockOpen" size={13} /> {t("dcUnlock", "Unlock")}
                  </button>
                )}
                {(dc.status || "confirmed") === "draft" && onEdit && (
                  <Button size="sm" variant="secondary" onClick={() => onEdit(dc)} iconLeft={<Icon name="Pencil" size={13} />} className="border border-gray-200 dark:border-gray-700">
                    {t("edit", "Edit")}
                  </Button>
                )}
                <Button size="sm" variant="secondary" onClick={() => shareDc(dc)} busy={sharing === dc.id}
                  iconLeft={sharing === dc.id ? null : <Icon name="Send" size={13} />} className="border border-gray-200 dark:border-gray-700">
                  {t("send") || "Send"}
                </Button>
                <Button size="sm" variant="secondary"
                  onClick={() => downloadPdf(dc.id, dc.date, (dc.status || "confirmed") !== "confirmed")}
                  busy={downloading === dc.id}
                  iconLeft={downloading === dc.id ? null : <Icon name="FileText" size={13} />} className="border border-gray-200 dark:border-gray-700">
                  PDF
                </Button>
                {/* Delete — DRAFTS ONLY. A locked close is the day's legal
                    kasserapport under Bogføringsloven §10; it is not offered
                    here and the server refuses it regardless. Red because this
                    one really does remove something. */}
                {(dc.status || "confirmed") === "draft" && (
                  <button onClick={() => deleteDraft(dc)} disabled={deleting === dc.id}
                    title={t("dcDeleteDraftTitle", "Delete this kladde?")}
                    className="text-[11px] px-3 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40 font-medium inline-flex items-center gap-1.5 border border-red-200 dark:border-red-800 disabled:opacity-50">
                    <Icon name="Trash2" size={13} />
                    {deleting === dc.id ? t("dcDeleting", "Deleting…") : t("delete", "Delete")}
                  </button>
                )}
              </div>
            </div>
            {/* A failed PDF must not look like a finished one. Same amber +
                upgrade-link treatment as the range export, next to the button
                the owner actually tapped. */}
            {rowError?.id === dc.id && (
              <div className={`mt-2 px-3 py-2 rounded-lg text-xs flex items-start gap-2 ${
                rowError.isPlanCap
                  ? "bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300"
                  : "text-red-500 dark:text-red-400"
              }`}>
                <Icon name={rowError.isPlanCap ? "Lock" : "AlertTriangle"} size={14} className="shrink-0 mt-0.5" />
                <span className="flex-1">
                  {rowError.message}
                  {rowError.isPlanCap && canPurchaseInApp() && (
                    <Link to="/subscription" className="ml-2 underline font-semibold hover:no-underline">
                      {t("dcUpgradeArrow", "Upgrade →")}
                    </Link>
                  )}
                </span>
              </div>
            )}
          </div>
        );
      })}

      {/* Unlock modal */}
      {unlockId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => { setUnlockId(null); setUnlockError(""); }}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-[16px] font-semibold text-gray-900 dark:text-white mb-1 inline-flex items-center gap-2"><Icon name="LockOpen" size={18} /> {t("dcUnlockModalTitle", "Unlock the kasserapport")}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("dcUnlockModalBody", "This will allow editing. Enter a reason for the audit trail.")}
            </p>
            <textarea placeholder={t("dcUnlockReasonPlaceholder", "e.g. Accountant found an error in cash count…")}
              rows={3}
              className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl resize-none mb-4"
              value={unlockReason} onChange={e => setUnlockReason(e.target.value)} />
            {unlockError && (
              <div className="mb-4 px-3 py-2 rounded-lg text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 flex items-start gap-2">
                <Icon name="AlertTriangle" size={14} className="shrink-0 mt-0.5" />
                <span className="flex-1">{unlockError}{" "}{t("dcUnlockStillLocked", "The close is still locked.")}</span>
              </div>
            )}
            <div className="flex gap-3">
              <button onClick={() => { setUnlockId(null); setUnlockError(""); }}
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
          iconName={upgradeNudge.iconName}
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
  // Third outcome again. A silent catch left `data` null, which fell through to
  // the empty state — and that empty state does not say "we couldn't ask", it
  // says "submit daily closes for multiple branches to see comparisons". So a
  // failed request told an owner with twelve branches of closes that they had
  // none. A failure gets its own state and its own words.
  const [failed, setFailed] = useState(false);

  const fetchSummary = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - (parseInt(range) - 1));
      const fmtD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const res = await api.get("/daily-close/branch-summary", { params: { from: fmtD(from), to: fmtD(to) } });
      setData(res.data);
    } catch {
      setData(null);
      setFailed(true);
    }
    setLoading(false);
  };

  useEffect(() => { fetchSummary(); }, [range]);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-200 dark:border-gray-700">
        <div className="flex justify-center mb-3 animate-pulse"><Icon name="Building2" size={32} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="text-[13px] text-gray-500 dark:text-gray-400">{t("dcLoadingBranchData", "Loading branch data…")}</p>
      </div>
    );
  }

  if (failed) {
    return (
      <SectionBanner severity="warn" icon="AlertTriangle" title={t("somethingWentWrong")}>
        <button type="button" onClick={fetchSummary}
          className="font-semibold underline underline-offset-2 hover:no-underline">
          {t("tryAgain")}
        </button>
      </SectionBanner>
    );
  }

  if (!data || !data.branches?.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-200 dark:border-gray-700">
        <div className="flex justify-center mb-3"><Icon name="Building2" size={32} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="text-[14px] font-semibold text-gray-900 dark:text-white">{t("noBranchData")}</p>
        <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-1">{t("noBranchDataHint", "Lock a kasserapport for more than one branch to see comparisons.")}</p>
      </div>
    );
  }

  const { branches, grand_total } = data;
  const topBranch = branches[0];

  return (
    <div className="space-y-4">
      {/* Range toggle */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-[13px] text-gray-900 dark:text-white flex items-center gap-1.5">
          <Icon name="Building2" size={15} /> {t("dcBranchComparison", "Branch Comparison")}
        </h3>
        <div className="flex gap-1.5">
          {[{ v: "1", l: t("dcRangeToday", "Today") }, { v: "7", l: t("dcRange7Days", "7 days") }, { v: "30", l: t("dcRange30Days", "30 days") }].map(r => (
            <Chip key={r.v} size="sm" selected={range === r.v} onClick={() => setRange(r.v)}>{r.l}</Chip>
          ))}
        </div>
      </div>

      {/* Grand totals — StatCard, a drop-in for exactly this shape (11px
          uppercase label, tabular-nums value, neutral surface, no gloss). The
          hand-rolled trio underneath it carried an emerald revenue figure and a
          BLUE tips figure, i.e. two accent families spent on three tiles that
          say the same kind of thing. The currency token moves inside the value
          (Amount whispers it) instead of sitting on its own third line. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label={t("totalRevenue")}
          value={<Amount value={grand_total.revenue_total} currency={currency} decimals={GLANCE_DECIMALS} />}
        />
        <StatCard
          label={t("cashVariance")}
          accent={grand_total.cash_diff_total < -200 ? "critical" : "neutral"}
          value={<Amount value={grand_total.cash_diff_total} currency={currency} decimals={GLANCE_DECIMALS} sign />}
        />
        <StatCard
          label={t("totalTips")}
          value={<Amount value={grand_total.tips_total} currency={currency} decimals={GLANCE_DECIMALS} />}
        />
      </div>

      {/* Branch cards */}
      {branches.map((b, i) => {
        const revShare = grand_total.revenue_total > 0 ? Math.round((b.revenue_total / grand_total.revenue_total) * 100) : 0;
        return (
          <div key={b.branch_id || i} className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-200 dark:border-gray-700 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-[14px] font-semibold text-gray-900 dark:text-white truncate">{b.branch_name}</h3>
                  {i === 0 && branches.length > 1 && (
                    <span className="text-[11px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg font-semibold">{t("dcTopBadge", "Top")}</span>
                  )}
                </div>
                <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5 tabular-nums">{b.days_count === 1
                  ? t("dcBranchClosesAvgOne", "{count} close · avg {avg}/day", { count: b.days_count, avg: formatOwnerMoney(b.avg_daily_revenue, currency, { decimals: GLANCE_DECIMALS }) })
                  : t("dcBranchClosesAvgMany", "{count} closes · avg {avg}/day", { count: b.days_count, avg: formatOwnerMoney(b.avg_daily_revenue, currency, { decimals: GLANCE_DECIMALS }) })}</p>
              </div>
              <div className="text-right shrink-0">
                <Amount value={b.revenue_total} currency={currency} decimals={GLANCE_DECIMALS} size="kpi" className="text-gray-900 dark:text-white" />
                <p className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums mt-0.5">{t("dcPctOfTotal", "{pct}% of total", { pct: revShare })}</p>
              </div>
            </div>

            {/* Revenue share bar */}
            <div className="mt-3 h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 dark:bg-emerald-500 rounded-full transition-all" style={{ width: `${revShare}%` }} />
            </div>

            {/* Metrics row */}
            <div className="flex gap-4 flex-wrap mt-3 text-[12px] text-gray-500 dark:text-gray-400 tabular-nums">
              <span>{t("dcCashLabel", "Cash")}: <span className={b.cash_diff_total < -100 ? "text-red-600 dark:text-red-400 font-semibold" : ""}><Amount value={b.cash_diff_total} currency={currency} decimals={GLANCE_DECIMALS} sign /></span></span>
              {b.tips_total > 0 && <span>{t("tipsLabel", "Tips")}: <Amount value={b.tips_total} currency={currency} decimals={GLANCE_DECIMALS} /></span>}
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

/* ONE RAMP, both themes.
   The old revenue scale had no ramp at all — it ran
   gray-200 → emerald-300 → emerald-500 → gray-800 in light, and
   gray-800 → gray-800 → gray-900 → emerald-500 in dark. Two of the four dark
   buckets were literally the same colour, and the p75 bucket — a GOOD day —
   painted dark:bg-gray-900, which IS the page ground (#111827, see `.dark body`
   in index.css). So in dark mode the owner's best days rendered as holes in the
   grid, and the legend swatch that was supposed to explain them was a hole too,
   which meant nothing on screen contradicted the misreading.
   Now: a monotone emerald ramp, four distinct steps in both themes, running
   light→dark in light mode and dark→light in dark mode, and no step equal to
   any surface behind the grid.
   Module scope, not component scope: these are frozen strings, and declaring
   them inside the component made them dependencies of the colour useMemo that
   React Compiler could not preserve. */
const HEAT_NO_CLOSE = "bg-gray-100 dark:bg-gray-700/60";
const HEAT_ZERO_DAY = "bg-gray-200 dark:bg-gray-600";
const HEAT_REVENUE_RAMP = [
  "bg-emerald-100 dark:bg-emerald-900",
  "bg-emerald-300 dark:bg-emerald-700",
  "bg-emerald-500 dark:bg-emerald-500",
  "bg-emerald-700 dark:bg-emerald-300",
];
/* Cash variance KEEPS colour, because here the colour is the data: emerald
   means the drawer balances and the shortage deepens through amber into red.
   Orange sat between amber and red as a fourth near-identical step — dropping
   it costs no information and removes a whole colour family from the page. */
const HEAT_CASH_RAMP = [
  "bg-emerald-500 dark:bg-emerald-500",
  "bg-amber-400 dark:bg-amber-500",
  "bg-red-400 dark:bg-red-500",
  "bg-red-600 dark:bg-red-600",
];

/**
 * The colour for one cell. Pure, and the single place the bucket boundaries
 * live — the legend reads the same `cuts` object, so a swatch can never stand
 * for a threshold the grid isn't using.
 *
 * @param {object|null} dc — the close filed for that day, or undefined
 * @param {"revenue"|"cash"} mode
 * @param {{p25:number,p50:number,p75:number}|null} cuts — this venue's own
 *        90-day revenue percentiles; null when there is no revenue history.
 */
function heatCellClass(dc, mode, cuts) {
  if (!dc) return HEAT_NO_CLOSE;
  if (mode === "revenue") {
    if (!cuts) return HEAT_NO_CLOSE;
    const v = dc.revenue_total;
    if (!v || v <= 0) return HEAT_ZERO_DAY;
    if (v <= cuts.p25) return HEAT_REVENUE_RAMP[0];
    if (v <= cuts.p50) return HEAT_REVENUE_RAMP[1];
    if (v <= cuts.p75) return HEAT_REVENUE_RAMP[2];
    return HEAT_REVENUE_RAMP[3];
  }
  const diff = dc.cash_difference;
  if (diff === null || diff === undefined) return HEAT_ZERO_DAY;
  if (diff >= 0) return HEAT_CASH_RAMP[0];
  if (diff >= -100) return HEAT_CASH_RAMP[1];
  if (diff >= -300) return HEAT_CASH_RAMP[2];
  return HEAT_CASH_RAMP[3];
}

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

  // Percentile cuts, computed once so the grid AND the legend read from the
  // same numbers — a legend that names a threshold the colouring doesn't use
  // is worse than no legend.
  const cuts = useMemo(() => {
    const vals = (data || []).map(dc => dc.revenue_total).filter(v => v > 0).sort((a, b) => a - b);
    if (!vals.length) return null;
    return {
      p25: vals[Math.floor(vals.length * 0.25)],
      p50: vals[Math.floor(vals.length * 0.5)],
      p75: vals[Math.floor(vals.length * 0.75)],
    };
  }, [data]);

  // Color logic based on mode + data percentiles. A plain call, not a useMemo
  // that RETURNS a closure: memoizing a closure factory saved nothing (the
  // closure is invoked 90 times either way) and React Compiler cannot preserve
  // that shape, so it bailed out of optimizing the whole component.
  const getColor = (dc) => heatCellClass(dc, mode, cuts);

  /* The legend names REAL VALUES, not adjectives.
     "Low / Mid / High" describes the swatch, which the owner can already see;
     what they cannot see is where the cuts fall, and those cuts are THEIR OWN
     90-day percentiles, different for every venue. The money goes through
     formatOwnerMoney like every other figure on the page. When there is no
     revenue history at all there are no thresholds to name, so the legend
     renders nothing rather than inventing buckets. */
  const money = (v) => formatOwnerMoney(v, currency, { decimals: GLANCE_DECIMALS });
  const legendItems = mode === "revenue"
    ? (cuts
        ? [
            { color: HEAT_NO_CLOSE, label: t("dcHeatmapNoClose", "No kasserapport") },
            { color: HEAT_REVENUE_RAMP[0], label: `≤ ${money(cuts.p25)}` },
            { color: HEAT_REVENUE_RAMP[1], label: `≤ ${money(cuts.p50)}` },
            { color: HEAT_REVENUE_RAMP[2], label: `≤ ${money(cuts.p75)}` },
            { color: HEAT_REVENUE_RAMP[3], label: `> ${money(cuts.p75)}` },
          ]
        : [])
    : [
        { color: HEAT_ZERO_DAY, label: t("dcLegendNA", "N/A") },
        { color: HEAT_CASH_RAMP[0], label: `≥ ${money(0)}` },
        { color: HEAT_CASH_RAMP[1], label: `< ${money(0)}` },
        { color: HEAT_CASH_RAMP[2], label: `< ${money(-100)}` },
        { color: HEAT_CASH_RAMP[3], label: `< ${money(-300)}` },
      ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-200 dark:border-gray-700 shadow-sm">
      {/* Header + mode toggle */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-semibold text-[13px] text-gray-900 dark:text-white flex items-center gap-1.5">
          <Icon name="Calendar" size={15} /> {t("dcHeatmap90DayOverview", "90-Day Overview")}
        </h3>
        <div className="flex gap-1.5">
          {[{ id: "revenue", label: t("dcHeatmapRevenueMode", "Revenue") }, { id: "cash", label: t("dcHeatmapCashMode", "Cash +/-") }].map(m => (
            <Chip key={m.id} size="sm" selected={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</Chip>
          ))}
        </div>
      </div>

      {/* Grid. Every cell is a real <button>: they were plain <div>s with
          onMouseEnter only, so the whole 90-day map was unreachable by keyboard
          and invisible to a screen reader — 90 pieces of the owner's own money
          history behind a mouse. onFocus mirrors onMouseEnter, so tabbing
          drives the same info line hovering does, and each cell carries an
          aria-label saying the date and the figure out loud. */}
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {/* Day-of-week labels */}
        <div className="flex flex-col gap-[3px] mr-0.5 shrink-0" aria-hidden="true">
          {["M", "", "W", "", "F", "", "S"].map((d, i) => (
            <div key={i} className="w-3 h-3 flex items-center justify-center text-[11px] leading-none text-gray-400 dark:text-gray-500 select-none">{d}</div>
          ))}
        </div>
        {/* Week columns */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((day, di) => {
              if (!day) return <div key={di} className="w-3 h-3" />;
              const ds = fmtDate(day);
              const dc = closeMap[ds];
              const dateLabel = new Date(ds + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
              const valueLabel = !dc
                ? t("dcHeatmapNoClose", "No kasserapport")
                : mode === "revenue"
                  ? money(dc.revenue_total)
                  : (dc.cash_difference == null
                      ? t("dcHeatmapNA", "N/A")
                      : `${t("dcHeatmapCashLabel", "Cash")}: ${formatOwnerMoney(dc.cash_difference, currency, { decimals: GLANCE_DECIMALS, sign: true })}`);
              return (
                <button key={di} type="button"
                  aria-label={`${dateLabel} — ${valueLabel}`}
                  className={`w-3 h-3 rounded-[2px] ${getColor(dc)} cursor-pointer transition-all hover:ring-2 hover:ring-gray-400 dark:hover:ring-gray-300 hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:scale-125`}
                  onMouseEnter={() => setHovered({ ds, dc })}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered({ ds, dc })}
                  onBlur={() => setHovered(null)}
                  onClick={() => setHovered({ ds, dc })}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Hover / focus info line */}
      <div className="min-h-[1.25rem] mt-1.5">
        {hovered ? (
          <p className="text-[12px] text-gray-500 dark:text-gray-400 tabular-nums">
            <span className="font-medium text-gray-700 dark:text-gray-300">
              {new Date(hovered.ds + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" })}
            </span>
            {hovered.dc ? (
              mode === "revenue"
                ? <> &mdash; <Amount value={hovered.dc.revenue_total} currency={currency} decimals={GLANCE_DECIMALS} /></>
                : <> &mdash; {t("dcHeatmapCashLabel", "Cash")}: {hovered.dc.cash_difference != null
                    ? <Amount value={hovered.dc.cash_difference} currency={currency} decimals={GLANCE_DECIMALS} sign />
                    : t("dcHeatmapNA", "N/A")}</>
            ) : <> &mdash; {t("dcHeatmapNoClose", "No kasserapport")}</>}
          </p>
        ) : (
          <p className="text-[11px] text-gray-400 dark:text-gray-500">{t("hoverDayForDetails")}</p>
        )}
      </div>

      {/* Legend — swatch + the threshold it actually stands for */}
      {legendItems.length > 0 && (
        <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap mt-2">
          {legendItems.map((l, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
              <span className={`w-2.5 h-2.5 rounded-[2px] shrink-0 ${l.color}`} aria-hidden="true" />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   INSIGHTS VIEW
   ═══════════════════════════════════════════════════════════ */
/* Insight glyphs, resolved HERE instead of rendered from the server string.
   WAS: the backend hands every insight an `icon` field holding a literal emoji
   (🍸 💰 🔍 ✅ 📦 🚨 ⚠️ 💡 — daily_close.py), and three sites on this surface
   printed that string straight through. The owner's revisor-facing close page
   showed a cocktail glass beside the drink ratio and a siren beside a cash
   shortage. The emoji is now ignored: the insight's own `type` already carries
   the meaning, and for the one glyph that varies, the number the card shows
   decides it — so the mark can never disagree with the text beside it. */
function insightIconName(ins) {
  switch (ins?.type) {
    case "drink_ratio": return "Wine";
    case "tip_trends": return "Coins";
    // The backend's own threshold: drift past −200 reads "investigate",
    // anything gentler reads "healthy". Same cut the summary StatCard uses.
    case "cash_drift": return Number(ins?.total_drift) < -200 ? "Search" : "CheckCircle2";
    case "takeaway_growth": return "Package";
    // One mark for all three streak severities — the card collapses info and
    // warning into the same amber (see StreakAlertCard), so a third glyph
    // would put back the level the colour deliberately dropped.
    case "cash_streak": return "AlertTriangle";
    default: return "Lightbulb";
  }
}

function InsightsView({ data, currency, t, loading = false, failed = false, isOnline = true, onRetry = null }) {
  /* Same order as History, same reason. "Not enough data yet — lock a few
     kasserapporter" is a judgement about the OWNER's record; a request that
     failed is a fact about ours, and only one of the two is theirs to act on.
     The failure branch sits in front of the empty state so the empty state
     can keep meaning what it says. */
  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-200 dark:border-gray-700">
        <div className="flex justify-center mb-3 animate-pulse"><Icon name="Lightbulb" size={32} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="text-[13px] text-gray-500 dark:text-gray-400">{t("dcLoadingInsights", "Loading your insights…")}</p>
      </div>
    );
  }

  if (failed && !data) {
    return (
      <LoadFailed
        onRetry={onRetry}
        title={isOnline ? null : t("dcOfflineCantLoad", "You're offline, so this couldn't be loaded.")}
      />
    );
  }

  if (!data || !data.has_data) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 text-center border border-gray-200 dark:border-gray-700">
        <div className="flex justify-center mb-3"><Icon name="Lightbulb" size={32} className="text-gray-400 dark:text-gray-500" /></div>
        <p className="text-[14px] font-semibold text-gray-900 dark:text-white">{t("notEnoughDataYet")}</p>
        <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-1">{t("notEnoughDataHint", "Lock a few kasserapporter to unlock insights about your revenue, tips, and cash handling.")}</p>
      </div>
    );
  }

  const { insights, summary } = data;
  const streakAlerts = insights.filter(i => i.type === "cash_streak");
  const regularInsights = insights.filter(i => i.type !== "cash_streak");

  return (
    <div className="space-y-4">
      {/* Stale insights, said out loud — same rule as the History list. */}
      {failed && (
        <LoadFailed
          onRetry={onRetry}
          title={isOnline ? null : t("dcOfflineCantLoad", "You're offline, so this couldn't be loaded.")}
          body={t("dcShowingLastLoadedInsights", "Showing the last insights we loaded — they may not be up to date.")}
        />
      )}

      {/* Streak alerts — prominent at top */}
      {streakAlerts.map((alert, i) => (
        <StreakAlertCard key={i} alert={alert} currency={currency} />
      ))}

      {/* Summary cards — the local SummaryCard is gone; StatCard is a drop-in
          with the same shape (11px uppercase label + tabular value) and it
          brings the product's accent vocabulary with it, so "cash drift is
          fine" stops being a green that drains to grey in dark mode. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label={t("dcInsightsAvgDailyRevenue", "Avg Daily Revenue")}
          value={<Amount value={summary.avg_daily_revenue} currency={currency} decimals={GLANCE_DECIMALS} />}
        />
        <StatCard
          label={t("dcInsightsTotalTips90d", "Total Tips (90d)")}
          value={<Amount value={summary.total_tips} currency={currency} decimals={GLANCE_DECIMALS} />}
        />
        <StatCard
          label={t("dcInsightsCashDrift90d", "Cash Drift (90d)")}
          accent={summary.total_cash_difference < -200 ? "critical" : "success"}
          value={<Amount value={summary.total_cash_difference} currency={currency} decimals={GLANCE_DECIMALS} sign />}
        />
      </div>

      {/* Regular insight cards */}
      {regularInsights.map((ins, i) => (
        <div key={i} className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-start gap-3">
            {/* WAS: ins.icon rendered straight through — server-authored text
                that is in practice an emoji. Resolved from the insight's type
                instead, so the mark is Lucide like the rest of the page. */}
            <Icon name={insightIconName(ins)} size={16} className="mt-0.5 shrink-0 text-gray-400 dark:text-gray-500" />
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-gray-900 dark:text-white">{ins.title}</h3>
              <p className="text-[13px] text-gray-500 dark:text-gray-400 mt-1">{ins.detail}</p>
              {ins.benchmark && (
                <p className="text-[12px] text-gray-400 dark:text-gray-500 mt-2">{t("dcInsightsIndustryBenchmark", "Industry benchmark")}: {ins.benchmark}</p>
              )}
            </div>
          </div>
        </div>
      ))}

      {insights.length === 0 && (
        <div className="text-center text-gray-400 dark:text-gray-500 text-[13px] py-8">
          {t("dcInsightsKeepLogging", "Keep locking a kasserapport each day to unlock more insights.")}
        </div>
      )}
    </div>
  );
}

function StreakAlertCard({ alert, currency }) {
  const { t } = useLanguage();
  /* TWO alarm levels, not three.
     `info` used to be its own YELLOW family sitting between amber and red —
     three warning colours for one axis, and yellow-500 on white measures 1.9:1
     so its badge text was unreadable at the moment it mattered. Amber already
     means "look at this"; a mild streak and a moderate streak differ in the
     WORDS, not in a fourth hue. `info` now maps to the same amber, which drops
     the yellow family from the page entirely. Red stays: it is the only level
     that means "money is going missing". */
  const styles = {
    critical: {
      border: "border-red-200 dark:border-red-800",
      bg: "bg-red-50 dark:bg-red-950/40",
      badge: "bg-red-600 text-white",
      title: "text-red-800 dark:text-red-200",
      detail: "text-red-700 dark:text-red-400",
      dot: "bg-red-600 dark:bg-red-400",
    },
    warning: {
      border: "border-amber-200 dark:border-amber-800",
      bg: "bg-amber-50 dark:bg-amber-950/40",
      badge: "bg-amber-600 text-white",
      title: "text-amber-800 dark:text-amber-200",
      detail: "text-amber-700 dark:text-amber-400",
      dot: "bg-amber-600 dark:bg-amber-400",
    },
  };
  styles.info = styles.warning;

  const s = styles[alert.severity] || styles.warning;

  return (
    <div className={`rounded-xl p-5 border ${s.border} ${s.bg} shadow-sm`}>
      <div className="flex items-start gap-3">
        {/* WAS: the server's raw emoji. Lucide, tinted with the card's own
            severity ink so it reads as one object with the title. */}
        <Icon name={insightIconName(alert)} size={16} className={`mt-0.5 shrink-0 ${s.title}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`text-[14px] font-semibold ${s.title}`}>{alert.title}</h3>
            {alert.is_active && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${s.badge}`}>
                {t("dcStreakActiveBadge", "Active")}
              </span>
            )}
          </div>
          <p className={`text-[13px] mt-1 ${s.detail}`}>{alert.detail}</p>

          {/* Streak dots visualization */}
          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            {Array.from({ length: alert.streak_length }).map((_, i) => (
              <div key={i} className={`w-2.5 h-2.5 rounded-full ${s.dot}`} aria-hidden="true" />
            ))}
            <span className="text-[12px] ml-1.5 text-gray-600 dark:text-gray-400 tabular-nums">
              {t("dcStreakConsecutiveDays", "{count} consecutive days", { count: alert.streak_length })} &middot;{" "}
              <Amount value={alert.streak_total} currency={currency} decimals={GLANCE_DECIMALS} />
            </span>
          </div>

          {alert.total_streaks > 1 && (
            <p className="text-[12px] mt-2 text-gray-500 dark:text-gray-400">
              {t("dcStreakSeparateShortages", "{count} separate shortage streaks detected in last 90 days", { count: alert.total_streaks })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
