import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { dateLocale, businessTodayIso, formatDateClear, formatDateClearFull, localIso } from "../utils/dateFormat";
import { Link, useLocation, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useBranch } from "../components/BranchSelector";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency, formatOwnerMoney, getTaxConfig, getVatTerms, isMoneyRejected, moneyInputText, moneyLocale, parseMoneyInput } from "../utils/currency";
import { trackEvent } from "../hooks/useEventLog";
import DismissibleTip from "../components/DismissibleTip";
import { safeImageUrl } from "../utils/safeUrl";
import { errText } from "../utils/errText";
import { HELD_CLAIM_OPEN, HELD_UNVERIFIED, heldReasonForUser, heldReasonFromError } from "../utils/senderGate";
import ClaimQuestionResend from "../components/ClaimQuestionResend";
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
  isDeletedLockedClose,
  isDraftChanged,
  draftChangedStamp,
  addFailedToOfflineQueue,
  QUEUE_ALREADY_SAVED,
  QUEUE_ERR_DELETED_LOCKED,
  QUEUE_ERR_DRAFT_CHANGED,
  QUEUE_CHANGED_EVENT,
  QUEUE_ERR_REJECTED,
  QUEUE_ERR_SERVER,
  QUEUE_FAILED,
  QUEUE_NEEDS_CONFIRMATION,
} from "../utils/dailyCloseQueue";
import {
  headlineTotal,
  scanBonTotal,
  scanSaveTotal,
  MERGE_REPLACE,
  MERGE_SUM,
  TOTAL_KEYS,
} from "../utils/dailyCloseScanMerge";
import {
  activeEntries,
  addScan,
  cardView,
  chooseTerminal,
  createTills,
  dateMoved,
  detachForm,
  dropPending,
  fieldOf,
  formTill,
  formValues,
  hasScanTills,
  hydrateScan,
  isDuplicateScan,
  lastStep,
  loadDraft,
  markApplied,
  momsOf,
  resetTills,
  oneSidedLines,
  savedTotal,
  sourceMetaOf,
  tillFromForm,
  tillGroups,
  TILL_SCAN,
  typeIntoForm,
  undo as undoTill,
} from "../utils/closeTills";
import { DEFAULT_CLOSE_CUTOFF_HOUR, findConfirmedCloseFor, resolveCutoffHour } from "../utils/dailyCloseDay";
import {
  buildShareMessage,
  buildShareTitle,
  formatDanishDateLabel,
  shareCloseSummary,
} from "../utils/shareClose";
import { sendDailyCloseRangeToAccountant } from "../utils/shareDailyCloseRange";
import {
  closeEmailState, emailErrorKey, newSendKey, resendCloseEmail, sentWhen, filenameFromResponse,
  announceCloseEmail, CLOSE_EMAIL_EVENT, isDemoClose, revisorAddress,
} from "../utils/closeEmail";

const FMT_LABEL = { xlsx: "Excel", pdf: "PDF", csv: "CSV" };
// An inline "Profil" link in an 11–13 px note measured 28×13 px on a phone — a
// thumb misses it. On a phone its box grows to ~40 px by padding alone: inline
// vertical padding takes no line space, and the negative side margin gives
// back the horizontal, so the sentence's lines keep their spacing (an
// inline-flex min-height made the last line of each note stand apart).
// `relative` lifts the link above the next note, so its padding takes the tap.
// On a tablet (768) the same links still measured 28×13 (the revisor link
// 194×16), so the tap area holds up to desktop width, as History and export.
const PROFILE_LINK_TAP = "max-sm:relative max-sm:py-3.5 max-sm:px-1.5 max-sm:-mx-1.5"
  + " sm:max-lg:relative sm:max-lg:py-3.5 sm:max-lg:px-1.5 sm:max-lg:-mx-1.5";
import { saveFile } from "../utils/download";
import { exportPieces, previousQuarter, spanDays } from "../utils/exportPieces";
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
import { PageHeader, TabPills, Button, Icon, SectionBanner, Amount, StatCard, LoadFailed } from "../components/ui";
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
// `t` is optional: without a catalogue the helper still reads English.
const englishOnly = (_key, fallback, vars) =>
  vars ? fallback.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m)) : fallback;

async function parseExportError(err, t = englishOnly) {
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
      // The owner's language, and the way forward — the server's English
      // "Upgrade to Pro…" reached the Danish UI word for word.
      message: t("dcRangeOverCapShort", "Your plan exports up to {cap} days at a time — get the period in parts.", { cap: inner.cap_days || "?" }),
      isPlanCap: true,
      capDays: inner.cap_days,
      planTier: inner.plan,
    };
  }

  if (status === 429) {
    return {
      message: typeof inner === "string"
        ? inner
        : (inner?.message || t("tooManyRequests", "Too many requests — please try again in a minute.")),
      isPlanCap: false,
    };
  }

  // Generic — try a string message, then fall back
  const msg = typeof inner === "string"
    ? inner
    : inner?.message || t("opsCloseExportFailed", "Could not export. Please try again.");
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
// The server's limits for the close's informational text (schemas/daily_close
// CLOSED_BY_MAX / NOTES_MAX). It cuts rather than refusing; the inputs and the
// payload stay inside them so nothing the owner sees is cut server-side.
const CLOSED_BY_MAX = 80;
const NOTES_MAX = 4000;

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
// Whole kroner at a glance, but a figure WITH øre shows them: History said
// 2.715 kr. and the bank drop "Læg 715 kr." for a close of 2.714,50.
const oreDecimals = (v) => (Number.isFinite(Number(v)) && Math.abs(Number(v) - Math.round(Number(v))) > 0.004 ? LEDGER_DECIMALS : GLANCE_DECIMALS);
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
  restaurant:  { hasTips: true,  hasCashDrawer: true,  hasCouverts: true,  stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory" },
  workshop:    { hasTips: false, hasCashDrawer: true,  hasCouverts: false, stepOneLabel: "Revenue by Service",  stepOneLabelKey: "stepOneRevenueByService" },
  retail:      { hasTips: false, hasCashDrawer: true,  hasCouverts: false, stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory" },
  grocery:     { hasTips: false, hasCashDrawer: true,  hasCouverts: false, stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory" },
  ecommerce:   { hasTips: false, hasCashDrawer: false, hasCouverts: false, stepOneLabel: "Revenue by Channel",  stepOneLabelKey: "stepOneRevenueByChannel" },
  // Phase A — salon: no couverts; service-vs-product split lives in the revenue
  // cats; gavekort gets its own line; tips kept (DK salons take tips).
  salon:       { hasTips: true,  hasCashDrawer: true,  hasCouverts: false, hasGavekort: true, stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory" },
  // Phase A — bakery: no couverts; Parti/Batch reference field.
  bakery:      { hasTips: false, hasCashDrawer: true,  hasCouverts: false, hasBatch: true, stepOneLabel: "Revenue by Category", stepOneLabelKey: "stepOneRevenueByCategory" },
  general:     { hasTips: false, hasCashDrawer: true,  hasCouverts: false, stepOneLabel: "Revenue",             stepOneLabelKey: "revenue" },
};

// Every category / payment key the forms can write, → its label. History
// chips printed the raw keys ("food:", "gift_card:", "mobilepay:").
// Restaurant labels win on shared keys (last write wins): built in type
// order, "card" read "Kort (online)" from the web-shop list.
const _typesRestaurantLast = (obj) =>
  Object.keys(obj).filter((k) => k !== "restaurant").concat(obj.restaurant ? ["restaurant"] : []);
const CAT_LABEL = Object.fromEntries(_typesRestaurantLast(REVENUE_CATS_BY_TYPE).flatMap((k) => REVENUE_CATS_BY_TYPE[k]).map((c) => [c.key, c]));
const PAY_LABEL = Object.fromEntries(_typesRestaurantLast(PAYMENT_METHODS_BY_TYPE).flatMap((k) => PAYMENT_METHODS_BY_TYPE[k]).map((c) => [c.key, c]));
function chipLabel(map, k, t) {
  // Case-insensitive: sample data stores "Food"/"Drinks".
  const c = map[k] || map[String(k).toLowerCase()];
  // A custom category keeps the owner's own word, capitalised — not "catering".
  if (!c) return String(k).charAt(0).toUpperCase() + String(k).slice(1).replace(/_/g, " ");
  return c.labelKey ? t(c.labelKey, c.label) : c.label;
}

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
  const { branchId, branchType: branchTypeRaw, branches } = useBranch();
  // A single-location account has no selected branch, so its branch type was
  // empty and every venue got the restaurant defaults — a restaurant lost its
  // tips step, a salon was offered Mad/Drikkevarer. The account's own
  // business type is the fallback.
  const branchType = branchTypeRaw || user?.business_type || null;
  const hasMultiBranch = branches?.length > 1;
  const currency = displayCurrency(user?.currency);

  const [tab, setTab] = useState("close"); // close | history | insights
  // The close "Åbn Historik" was tapped for: History opens on it, expanded,
  // instead of at the top with that day 1.000px down and collapsed.
  const [historyFocusId, setHistoryFocusId] = useState(null);
  const isPhone = useIsPhone();
  // Scan-first close (#close-funnel) — the one-tap front door. It opens the
  // camera and hands the photo to the wizard's own Z-bon scan. It used to
  // open the general Smart scan (receipt / kasserapport / invoice guesser) —
  // a second, different scan path from the wizard's scan card below it.
  // The input lives here so the click stays inside the tap (iOS refuses a
  // file picker opened later from an effect).
  const heroScanInputRef = useRef(null);
  const [heroScanFiles, setHeroScanFiles] = useState(null);
  // editDraft holds a DailyClose row when the user clicked "Edit" on a
  // draft in History. CloseForm reads it on mount and pre-fills all
  // fields so the owner doesn't have to re-type yesterday's numbers.
  // Cleared via onEditConsumed when the form has loaded the values.
  const [editDraft, setEditDraft] = useState(null);
  // The day the wizard is correcting (Rediger / Fortsæt / a ?date= draft).
  // While one is open the top card's "Snap your Z-report" did nothing — the
  // photo was dropped so it could not type over the draft — so the card
  // steps aside instead of offering a dead button.
  const [formEditingDate, setFormEditingDate] = useState(null);

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
  // Read once this page's own draft saves still on their way have landed
  // (round 21): listed before, a save from the visit before this one was
  // missing and the day's banner offered its older row.
  const historyQ = useAsyncData(() => closeSavesLanded().then(() => api.get("/daily-close")), [], { initial: [] });
  const insightsQ = useAsyncData(() => api.get("/daily-close/insights"), []);
  // useMemo, not a bare `|| []`: `history` is a dependency of the lock-status
  // useMemo below, and a fresh array identity every render would re-run it
  // every render.
  const history = useMemo(() => historyQ.data || [], [historyQ.data]);
  // A link can name the day: /tax's "Open it and lock it" (router state)
  // and the "you didn't close 29 Sep" / stale-draft rows (?date=). The page
  // ignored both and opened on today — an owner could type 29 Sep's Z-bon
  // in as 30 Sep.
  const wantDate = useMemo(() => {
    const d = location.state?.openCloseDate || new URLSearchParams(location.search).get("date");
    return /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : null;
  }, [location.state, location.search]);
  const openDateHandledRef = useRef(null);
  useEffect(() => {
    const d = wantDate;
    if (!d || openDateHandledRef.current === d) return;
    // Decide ONCE, on the first answer about the day, and remember the day
    // as handled even when it had no draft. It used to wait for a row: the
    // draft this very form autosaved for the day turned up in the next
    // history reload and was "opened" over the owner's typing — back to
    // Trin 1, focus gone, the numbers being typed wiped.
    if (historyQ.loading) return;
    openDateHandledRef.current = d;
    const row = history.find((dc) => String(dc.date || "").slice(0, 10) === d && dc.status !== "confirmed");
    if (!row) return;
    openDraftFresh(row, { tab: "close" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantDate, history, historyQ.loading]);
  const insights = insightsQ.data;
  const fetchHistory = historyQ.reload;
  const fetchInsights = insightsQ.reload;
  // The page is still here: a save answering after it was left does not
  // reload a list nobody will read (and a later visit lists for itself).
  const pageMountedRef = useRef(true);
  useEffect(() => {
    pageMountedRef.current = true;
    return () => { pageMountedRef.current = false; };
  }, []);
  // A draft opened to continue it (Fortsæt, Rediger, a link that names the
  // day) is read FRESH, by id, once this page's own saves on their way have
  // landed — never the history row listed earlier. That row could be older
  // than what is stored (a save landed after the list, another phone saved
  // since), and the next small edit filed it over the newer draft. Offline,
  // the listed row is what there is. Gone (deleted elsewhere) or locked
  // since: not opened — the list is read again and says what the day holds.
  const openSeqRef = useRef(0);
  // Says what came of it (round 22): "opened", "gone" (deleted since),
  // "locked" (locked since), or undefined (overtaken by a newer open, or the
  // page left) — the "saved somewhere else" question's "Hent den nyeste
  // kladde" answers itself on the last two.
  const openDraftFresh = async (dc, { tab: toTab = null } = {}) => {
    if (!dc) return undefined;
    const mine = ++openSeqRef.current;
    let fresh = dc;
    // Offline: the listed row at once (the read would only stall the tap).
    // Never retried, and never held long: the GET retry waited ~26 s on a
    // dropped café connection before falling back, with nothing on screen.
    if (dc.id != null && !(typeof navigator !== "undefined" && navigator.onLine === false)) {
      try {
        await closeSavesLanded();
        const r = await api.get(`/daily-close/${dc.id}`, { _noRetry: true, timeout: 8000 });
        if (r?.data && typeof r.data === "object" && !Array.isArray(r.data) && r.data.id != null) fresh = r.data;
      } catch (err) {
        if (err?.response?.status === 404) {
          if (mine === openSeqRef.current && pageMountedRef.current) fetchHistory();
          return "gone";
        }
      }
    }
    if (mine !== openSeqRef.current || !pageMountedRef.current) return undefined;
    if (fresh.is_deleted || ((fresh.status || "confirmed") === "confirmed" && (dc.status || "confirmed") !== "confirmed")) {
      fetchHistory();
      return fresh.is_deleted ? "gone" : "locked";
    }
    setEditDraft(fresh);
    if (toTab) setTab(toTab);
    return "opened";
  };
  const [loading, setLoading] = useState(false);
  // Lane A — when CloseForm successfully locks a close, the parent
  // captures the close_ritual block returned by the backend (auto-
  // email status, scan attached, bank-drop hint, etc.) so we can
  // render the locked-state card at the top of the History tab. The
  // card stays until the user dismisses it or navigates away.
  const [lastLockedClose, setLastLockedClose] = useState(null);
  // Tonight's card has its own X: it is also rebuilt from history, so clearing
  // lastLockedClose did not hide it — and with a past day's card beside it,
  // that X closed the other card.
  const [todayCardDismissed, setTodayCardDismissed] = useState(false);

  // Offline resilience
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  // The whole queue, not just its length: "waiting for the network" and
  // "waiting for YOUR confirmation" are two different promises to the owner
  // and a single count cannot tell them apart. A close blocked on the anomaly
  // guard used to be invisible (and, before that, deleted).
  const [queue, setQueue] = useState(() => getOfflineQueue());
  const queueCounts = useMemo(() => queueSummary(queue), [queue]);
  const retryableFailed = useMemo(() => queue.filter((it) => it?.state === QUEUE_FAILED
    && it.errorCode !== QUEUE_ERR_DRAFT_CHANGED).length, [queue]);
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
      // item awaiting confirmation may STILL have synced three others. And
      // whenever the server answered at all (round 23 — the round-22 review's
      // confusing item): a copy refused because the day was locked (409) or
      // saved elsewhere (412) is the server saying the day changed — History
      // read offline was never read again, so the wizard said "Vi kunne ikke
      // tjekke …" and offered a new close beside a queue saying "låst".
      if (res.synced > 0 || res.total === 0 || !res.stoppedOnNetwork) { fetchHistory(); fetchInsights(); }
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
      // Nothing of the day is in the books, and filing it again is refused
      // the same way: said as it is, never "check the numbers".
      : it?.errorCode === QUEUE_ERR_DELETED_LOCKED
        ? t("dcQueueErrDeletedLocked", "A deleted, locked kasserapport is kept for this date (bookkeeping law), so nothing was saved. This copy stays on this phone — contact support.")
        // The day's draft was saved somewhere else after this copy was made:
        // nothing was overwritten, and the newer draft is the stored one.
        : it?.errorCode === QUEUE_ERR_DRAFT_CHANGED
          ? t("dcQueueErrDraftChanged", "The draft for this date was saved somewhere else after this copy was made, so nothing was overwritten. Keep your numbers to save them over it — or remove this copy and open the date to see the newest draft.")
          : t("dcQueueErrRejected", "The kasserapport was refused. Check the numbers and file this date again.")
  );

  /** Drop a queued copy the owner no longer needs (it is already in the books). */
  const dropQueuedClose = (item) => {
    if (!item) return;
    setQueue(removeFromOfflineQueue(item.id));
  };
  // A copy kept by the wizard after it was left (a save refused as
  // draft_changed once the form was gone) — or by another tab: shown at once.
  useEffect(() => {
    const onChange = () => setQueue(getOfflineQueue());
    window.addEventListener(QUEUE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, onChange);
  }, []);
  /**
   * "Keep my numbers" on a copy refused as draft_changed: sent again on the
   * newer version it met — the owner's explicit choice to save theirs over
   * it. Changed yet again since: it stays, with that newer version's stamp.
   */
  const [keepingId, setKeepingId] = useState(null);
  const keepQueuedCopy = async (item) => {
    if (!item || keepingId) return;
    setKeepingId(item.id);
    // The version the owner chose to save over is written into the copy
    // itself: the anomaly check stopping this send (a lock far off the usual
    // day) left the old version in it, and "Ja, lås den" was refused as
    // draft_changed, "Behold mine tal" met the anomaly again — round and
    // round, the queued lock never locked (round 21 review).
    const base = item.conflictStamp || item.payload?.base_updated_at || null;
    const payload = { ...item.payload, base_updated_at: base };
    try {
      const res = await postClose(payload);
      if (res?.data?.requires_confirmation) {
        setQueue(updateQueueItem(item.id, { payload, state: QUEUE_NEEDS_CONFIRMATION, anomaly: res.data.anomaly || {}, errorCode: null, errorDetail: null }));
        return;
      }
      setQueue(removeFromOfflineQueue(item.id));
      fetchHistory();
      fetchInsights();
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch (err) {
      const status = err?.response?.status ?? null;
      if (!err?.response) {
        setQueue(updateQueueItem(item.id, { state: QUEUE_FAILED, lastTriedTs: Date.now() }));
      } else if (isDraftChanged(err)) {
        setQueue(updateQueueItem(item.id, { state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: draftChangedStamp(err), httpStatus: status, lastTriedTs: Date.now() }));
        // The day changed on the server: History is read again (round 23).
        fetchHistory();
      } else if (isDeletedLockedClose(err)) {
        setQueue(updateQueueItem(item.id, { state: QUEUE_FAILED, errorCode: QUEUE_ERR_DELETED_LOCKED, errorDetail: errText(err, ""), httpStatus: status }));
      } else if (status === 409) {
        setQueue(updateQueueItem(item.id, { state: QUEUE_ALREADY_SAVED, errorCode: null, errorDetail: errText(err, ""), httpStatus: status }));
        fetchHistory();
      } else {
        setQueue(updateQueueItem(item.id, { state: QUEUE_FAILED, errorCode: status >= 500 ? QUEUE_ERR_SERVER : QUEUE_ERR_REJECTED, errorDetail: errText(err, ""), httpStatus: status }));
      }
    } finally {
      setKeepingId(null);
    }
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
      // On the newest version the owner chose to save over, if any.
      await postClose({ ...item.payload, ...(item.conflictStamp ? { base_updated_at: item.conflictStamp } : {}), acknowledge_anomaly: true });
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
      } else if (isDeletedLockedClose(err)) {
        // A deleted, locked kasserapport holds the day: nothing is in the
        // books and this copy is the only one — never "already saved".
        const failed = { state: QUEUE_FAILED, errorCode: QUEUE_ERR_DELETED_LOCKED, errorDetail: errText(err, ""), httpStatus: status };
        setReviewError(queueErrorText(failed));
        setQueue(updateQueueItem(item.id, failed));
      } else if (isDraftChanged(err)) {
        // The day's draft changed elsewhere since this copy was made: nothing
        // was written — never "already saved" over a newer draft.
        const failed = { state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: draftChangedStamp(err), errorDetail: null, httpStatus: status };
        setReviewError(queueErrorText(failed));
        setQueue(updateQueueItem(item.id, failed));
        fetchHistory();
      } else if (status === 409) {
        // The owner already filed this date in the wizard (which is exactly
        // what our own "cancel and re-open the date" note tells them to do).
        // The money is in the books; this copy is now a duplicate.
        setReviewError(t("dcQueueErrLocked", "This date is already locked in your kasserapport, so nothing was changed. You can remove this copy."));
        setQueue(updateQueueItem(item.id, {
          state: QUEUE_ALREADY_SAVED, errorCode: null,
          errorDetail: errText(err, ""), httpStatus: status,
        }));
        fetchHistory();
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
    // The queue is synced after every "online" listener has run (round 22
    // review): an open form takes its offline copy back first and sends the
    // draft itself. Run at once, this listener — registered before a form
    // mounted after a visit to History — sent the copy before the form took
    // it back, and the form's own save then went too: one of the two was
    // refused as "saved somewhere else" over the owner's own figures (and a
    // date move waiting on the new day's save never finished).
    const goOn = () => { setIsOnline(true); setTimeout(doSync, 0); };
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
  // The venue's OWN cutoff (a bar can close its day at 04:00) — the top of
  // the page used the 06:00 default while the wizard used the venue's, so
  // between 04 and 06 the two disagreed about which day was "today".
  const bizQ = useAsyncData(() => api.get("/business"), []);
  const todayIso = businessTodayIso(resolveCutoffHour(bizQ.data?.day_cutoff_hour));
  const todaysConfirmedClose = useMemo(
    () => findConfirmedCloseFor(history, todayIso),
    [history, todayIso],
  );
  // We prefer the *fresh* lockResult from this session (it carries the
  // close_ritual block with email status / bank-drop / push). If absent
  // (page reload after a previous lock), we synthesize a minimal close
  // object from history so the locked banner still renders — without
  // the email-status row (because that ritual already played out).
  // Only a close FOR TODAY locks today. Locking a past day (27 Sep, done on
  // 30 Sep) set lastLockedClose and hid tonight's "Luk dagen" as if tonight
  // were done.
  const freshLockIsToday = Boolean(
    lastLockedClose && String(lastLockedClose.date || "").slice(0, 10) === todayIso,
  );
  // After a reload the lock response is gone, but the send status is
  // persisted on the close: the card rebuilds its email line from it.
  const lockedBannerClose = (freshLockIsToday ? lastLockedClose : null) || (todaysConfirmedClose
    ? {
        ...todaysConfirmedClose,
        close_ritual: todaysConfirmedClose.close_ritual || {
          email_status: todaysConfirmedClose.email_status || null,
          email_error: todaysConfirmedClose.email_error || null,
          sent_to: todaysConfirmedClose.email_sent_to || [],
        },
      }
    : null);
  const isLockedToday = Boolean(lockedBannerClose);
  // …but a past day locked from this page still gets its answer. Hiding it
  // with the rule above ended a back-filled close on today's live cards and
  // "Luk dagen", with no word that the day just locked.
  const pastLockClose = lastLockedClose && !freshLockIsToday ? lastLockedClose : null;
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
      closeWizardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
  };

  const todaySubtitleKey = TODAY_SUBTITLE_KEY[archetypeForUser(user).id] || "navTodaySubtitle";

  return (
    // Native date pickers and selects drew light chrome in dark mode — this
    // page only, so no other screen's controls change underneath it.
    // The whispered "kr." (Amount marks its token), set for this page's own
    // surfaces. Light: gray-600 — Amount's gray-500 clears 4.5:1 on white and
    // gray-50 but not on this page's gray-100 revenue chips or the red-50
    // expenses panel (4.4:1); gray-600 is ~7:1 on all of them. Dark: gray-400
    // — 4.6:1 on the gray-700/60 chips, 4.7:1 on the gray-700/50 cards, 5.5:1
    // on the red expenses panel (computed in Chromium, 8 Oct 2026).
    <PageShell width="default" className="dark:[color-scheme:dark] [&_[data-amount-token]]:text-gray-600 dark:[&_[data-amount-token]]:text-gray-400">
      <PageHeader
        // No eyebrow. It said "RAPPORTER" — the group this page has not been
        // in since the C5 nav diet moved it onto the core spine (navManifest
        // declares it pillar: null), so it was a stale label sitting above the
        // title and reading as a SECOND name for the same thing. The eyebrow's
        // job on sibling pages is to name the pillar; there is no pillar to
        // name here, so the page keeps one name and nothing above it.
        title={t("navToday", "Kasserapport")}
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
              {/* Only the copies a retry sends: one refused as draft_changed
                  waits for the owner's "Behold mine tal" (the sync never
                  sends it), and a retry chip for it alone did nothing. */}
              {retryableFailed > 0 && (
                <Button variant="secondary" size="sm" onClick={doSync} disabled={!isOnline || syncing}
                  className="!bg-red-50 dark:!bg-red-900/20 !text-red-600 dark:!text-red-400 !border-red-200 dark:!border-red-800"
                  iconLeft={<Icon name="AlertTriangle" size={14} />}>
                  {t("dcQueuedFailed", "{count} couldn't be saved — retry", { count: retryableFailed })}
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
              {it.state === QUEUE_FAILED && it.errorCode === QUEUE_ERR_DRAFT_CHANGED && (
                <Button variant="secondary" size="sm" onClick={() => keepQueuedCopy(it)} disabled={!isOnline || keepingId === it.id}
                  data-testid="dc-queue-keep-mine">
                  {t("dcDraftChangedKeep", "Keep my numbers")}
                </Button>
              )}
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
          currency={currency}
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
      {isLockedToday && !todayCardDismissed && (
        <JustLockedCard
          t={t}
          close={lockedBannerClose}
          currency={currency}
          profile={bizQ.data}
          profileLoaded={!bizQ.loading && !bizQ.failed}
          businessType={user?.business_type}
          onEmailSent={fetchHistory}
          onDismiss={() => {
            setTodayCardDismissed(true);
            if (freshLockIsToday) setLastLockedClose(null);
          }}
        />
      )}
      {/* A past day just locked: the same card, naming the day. Tonight's
          "Luk dagen" below stays — that day is still open. */}
      {pastLockClose && (
        <JustLockedCard
          t={t}
          close={pastLockClose}
          currency={currency}
          profile={bizQ.data}
          profileLoaded={!bizQ.loading && !bizQ.failed}
          businessType={user?.business_type}
          dateLabel={formatDateClearFull(String(pastLockClose.date || "").slice(0, 10))}
          onEmailSent={fetchHistory}
          onDismiss={() => setLastLockedClose(null)}
        />
      )}

      {/* ─── Live KPIs (always visible) ───
          The "Today's Floor" snapshot, hoisted to the top of the daily
          page. Self-contained — its own data fetch, its own fail-closed
          empty + error states. If it errors, the rest of the page below
          (close wizard, history, insights) still renders cleanly. */}
      {/* On a phone's close tab the live cards come AFTER the wizard: above
          it they put "Tag billede" ~950px down, below the fold. */}
      {!(isPhone && tab === "close") && <LiveKpisToday />}

      {/* "Close the day" CTA — the explicit handoff from "I'm running
          the shift" to "the shift is done, let's lock the books".
          Hidden once today is locked (no value showing a CTA that
          would just open an already-confirmed wizard). Emerald is the
          one DNA-approved money-moment accent. */}
      {/* On a phone, with the wizard open right below, this card repeated
          its two choices (snap / type) a second time — the wizard's own scan
          card carries them there. It stays when it has news (lock status
          unknown) and on the other tabs, where it is the way back. */}
      {/* On the close tab the wizard's own scan card is the way in — on a
          desktop this card repeated its two choices right above it (two
          "snap" buttons, two "type it" buttons). It stays when it has news
          (lock status unknown) and on the other tabs, where it is the way
          back. */}
      {!isLockedToday && !(tab === "close" && (formEditingDate || !lockStatusUnknown)) && (
        <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/50 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t("closeTheDayCta", "Close the day")}
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
              {t("closeScanHint", "Snap your Z-report and we fill in tonight's numbers — or enter them by hand.")}
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
            {/* Round 23 review — the gray "Snap your Z-report" says why on
                screen (a title= tooltip never shows on a phone, nor on a
                disabled button): on History and Insights the wizard's own
                line is not mounted. */}
            {!isOnline && (
              <p id="dc-hero-scan-offline" data-testid="dc-hero-scan-offline" role="status"
                className="text-[13px] text-amber-800 dark:text-amber-200 mt-2 flex items-start gap-1.5">
                <Icon name="Info" size={14} className="shrink-0 mt-0.5" />
                <span>{t("dcScanNeedsInternet", "Scanning needs internet — type the figures in, or scan when you're back online")}</span>
              </p>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2 shrink-0 w-full sm:w-auto">
            <Button
              variant="main"
              onClick={() => heroScanInputRef.current?.click()}
              // Round 23: scanning needs internet (said on the card, under
              // its text — the tooltip alone never showed on a phone).
              disabled={!isOnline}
              title={!isOnline ? t("dcScanNeedsInternet", "Scanning needs internet — type the figures in, or scan when you're back online") : undefined}
              aria-describedby={!isOnline ? "dc-hero-scan-offline" : undefined}
              className="w-full sm:w-auto max-lg:h-10"
            >
              {t("closeScanCta", "Snap your Z-report")}
            </Button>
            <input ref={heroScanInputRef} type="file" accept="image/*" multiple capture="environment" className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = "";
                if (files.length) { setHeroScanFiles({ files }); scrollToWizard(); }
              }} />
            <Button
              variant="secondary"
              onClick={() => scrollToWizard({ manual: true })}
              className="w-full sm:w-auto max-lg:h-10"
            >
              {t("closeManualCta", "Enter manually")}
            </Button>
          </div>
        </div>
      )}

      {/* 40px tap targets on a tablet: the X ("Skjul tip") was 28px, the
          tabs 32px. Daily close only — the shared components are untouched. */}
      <DismissibleTip
        id="daily-close-intro-v1"
        iconName="ClipboardList"
        title={t("whatIsDailyClose")}
        className="[&>button]:size-10 [&>button]:top-2 [&>button]:right-2"
      >
        <p>{t("dailyCloseTipBody")}</p>
      </DismissibleTip>

      {/* Tab bar */}
      <TabPills
        tabs={[
          { id: "close", label: t("newClose", "New kasserapport") },
          { id: "history", label: t("historyTab", "History") },
          { id: "insights", label: t("insightsTab", "Insights") },
          ...(hasMultiBranch ? [{ id: "branches", label: t("branches", "Branches") }] : []),
        ]}
        activeId={tab}
        onChange={setTab}
        ariaLabel={t("dcTabsAriaLabel", "Daily close view")}
        className="*:min-h-10"
      />

      {/* The wizard reads as a form, not a spreadsheet: number boxes ran
          958px wide on desktop. History keeps the full width. */}
      <div ref={closeWizardRef} className={tab === "close" ? "max-w-2xl" : ""}>
        {tab === "close" && <CloseForm businessProfile={bizQ.data} currency={currency} t={t} branchType={branchType} branchId={branchId} branches={branches} isOnline={isOnline}
          manualRequest={manualRequest}
          heroScanFiles={heroScanFiles}
          onHeroConsumed={() => setHeroScanFiles(null)}
          presetDate={wantDate}
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
              // Tonight locked again (after an unlock): its card comes back.
              if (String(lockResult.date || "").slice(0, 10) === todayIso) setTodayCardDismissed(false);
            }
            setTab("history");
            // The "locked" card is at the top of the page; the phone stayed
            // where the lock button was (~1.500px down) and showed the 26 Sep
            // row instead of the answer.
            requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
          }}
          onQueued={() => { setQueue(getOfflineQueue()); setTab("history"); }}
          existingCloses={history}
          onDraftSaved={() => { if (pageMountedRef.current) fetchHistory(); }}
          onContinueDraft={(dc) => openDraftFresh(dc)}
          onShowHistory={(id) => { setHistoryFocusId(id || null); setTab("history"); }}
          onEditingChange={setFormEditingDate} />}
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
          focusCloseId={historyFocusId}
          onFocusConsumed={() => setHistoryFocusId(null)}
          onDismissLastLocked={() => setLastLockedClose(null)}
          onEdit={(dc) => openDraftFresh(dc, { tab: "close" })} />}
        {tab === "insights" && <InsightsView data={insights} currency={currency} t={t}
          loading={insightsQ.loading} failed={insightsQ.failed} isOnline={isOnline}
          onRetry={fetchInsights} />}
        {tab === "branches" && <BranchSummaryView currency={currency} />}
      </div>
      {isPhone && tab === "close" && <LiveKpisToday />}
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
/**
 * A dialog that takes the focus — and gives it back. The anomaly check and
 * the unlock modal opened with focus left on <body>, so a keyboard or screen
 * reader was still "behind" them. Same rules as useConfirm: the given control
 * (the safe answer, or the field to fill) gets focus, Esc cancels, Tab stays
 * inside, and focus returns to whatever opened it.
 */
function useDialogFocus(boxRef, initialRef, onEscape) {
  const escRef = useRef(onEscape);
  useEffect(() => { escRef.current = onEscape; });
  useEffect(() => {
    const opener = document.activeElement;
    (initialRef?.current || boxRef.current)?.focus?.();
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); escRef.current?.(); return; }
      if (e.key !== "Tab" || !boxRef.current) return;
      const items = [...boxRef.current.querySelectorAll("button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]")];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** The dialog box itself, focused while it is mounted (see useDialogFocus). */
function FocusedDialog({ labelledBy, initialRef, onEscape, className, children, ...rest }) {
  const boxRef = useRef(null);
  useDialogFocus(boxRef, initialRef, onEscape);
  return (
    <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} className={className} {...rest}>
      {children}
    </div>
  );
}

function CloseAnomalyDialog({ t, anomaly, saving, onCancel, onConfirm, error = "", extraNote = "", dateLabel = "", currency = "DKK" }) {
  const a = anomaly || {};
  const pct = Math.abs(Math.round((a.delta_pct || 0) * 100));
  // The money primitive, with øre when there are any — the dialog said
  // "17.913 kr." for a row showing 17.912,75 kr. The *Money templates carry
  // no unit of their own (the old ones said "{today} kr").
  const today = formatOwnerMoney(a.today_total || 0, currency, { decimals: oreDecimals(a.today_total) });
  const avg = formatOwnerMoney(a.baseline_avg || 0, currency, { decimals: oreDecimals(a.baseline_avg) });
  // A dated close says "Totalen for 1. aug. 2026" — not "Dagens total" for
  // a day that is not today.
  const msgKey = dateLabel
    ? (a.reason === "high" ? "dcAnomalyHighOnDate" : "dcAnomalyLowOnDate")
    : (a.reason === "high" ? "closeAnomalyHighMoney" : "closeAnomalyLowMoney");
  const boxRef = useRef(null);
  const cancelRef = useRef(null);
  useDialogFocus(boxRef, cancelRef, () => { if (!saving) onCancel(); });
  return (
    // Above the phone's bottom bar (also z-50): the bar sat over this dialog
    // and stayed tappable. The app's confirm uses the same layer.
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
      {/* shadow-sm, not one of the heavy tiers: the unlock modal three hundred lines down
          already uses shadow-sm, the doctrine bans the heavy tiers, and the
          black/40 overlay is what actually lifts a dialog off the page. */}
      <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby="dc-anomaly-title" tabIndex={-1}
        className="bg-white dark:bg-gray-800 rounded-xl shadow-sm max-w-md w-full p-5 sm:p-6 animate-fadeIn focus:outline-none">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center"><Icon name="AlertTriangle" size={20} className="text-amber-600 dark:text-amber-400" /></div>
          <div className="min-w-0">
            <h3 id="dc-anomaly-title" className="text-[16px] font-semibold text-gray-900 dark:text-white">{t("closeAnomalyTitle")}</h3>
            {dateLabel && (
              <p className="mt-0.5 text-xs font-semibold text-gray-500 dark:text-gray-400">
                {t("dcAnomalyForDate", "Kasserapport for {date}", { date: dateLabel })}
              </p>
            )}
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 tabular-nums">{t(msgKey, dateLabel ? { date: dateLabel, today, pct, avg } : { today, pct, avg })}</p>
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
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={saving}>
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

// "25. sep." in the owner's own words — a range picker read ISO dates.
function shortRangeDay(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return iso || "";
  return new Date(iso + "T12:00:00").toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });
}

// The part of the saved total that no category line carries — a Z-bon read
// as a total (or one line), or a total corrected below its lines. Without it
// the review's rows did not add up to the total it was about to lock.
function UnsplitLine({ amount, show, currency, t, decimals = LEDGER_DECIMALS }) {
  if (!show || Math.abs(amount) < 0.005) return null;
  return (
    <div className="flex justify-between gap-3 text-[13px] py-0.5 text-gray-500 dark:text-gray-400 tabular-nums">
      <span>{amount > 0 ? t("dcUnsplitRevenue", "Not split by category") : t("dcCorrectedDown", "Corrected down by hand")}</span>
      <span><Amount value={amount} currency={currency} decimals={decimals} /></span>
    </div>
  );
}

const CASH_FLOAT_KEY = "bonbox.dc.cashFloat.v1";

// Phone width (Tailwind's sm breakpoint), live — to move a block, not just
// hide one: a CSS-hidden twin would still fetch and poll.
function useIsPhone() {
  const q = "(max-width: 639px)";
  const [is, setIs] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = typeof window !== "undefined" ? window.matchMedia?.(q) : null;
    if (!m) return undefined;
    const on = () => setIs(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return is;
}

// What an edited close looks like, field by field — compared before an
// autosave so opening "Rediger" is not a save, and any real change is.
// The money maps compare by content, not key order: applying the scan card
// again rebuilt them in the template's order, which read as an edit.
const sortedFilled = (m) => Object.entries(m || {})
  .filter(([, v]) => String(v ?? "").trim() !== "")
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const editSignature = (o) => JSON.stringify([
  sortedFilled(o.rev), sortedFilled(o.pay), o.cash, o.tips, o.staff, o.by, o.notes, o.momsMode, o.momsManual,
  o.cashFloat ?? "", o.gavekort ?? "", o.batch ?? "",
]);

// What a scan's MOMS was read against. A scan's MOMS goes into the form once
// per figure: a new photo or a corrected total puts it in again, while going
// back to the card and "Brug disse tal" again leaves the form's MOMS alone.
const scanMomsKey = (s) => JSON.stringify([
  s?.moms_total ?? null, s?.revenue_total ?? null, s?.revenue_total_text ?? null,
  (s?.merge_info?.incompleteFields || []).includes("moms_total"),
]);

// What a day of tills puts on the record: its total, its lines, its MOMS —
// and whether a photo still waits on the question. The scan card compares
// it with the filed ledger's to say "not saved yet".
const ledgerRecordSig = (lg) => (lg ? JSON.stringify([
  savedTotal(lg), formValues(lg), momsOf(lg).value, lg.pending.length,
]) : null);

// Two box texts that read as the same amount ("17030,0" and "17.030").
const sameAmount = (a, b, locale) => {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  if (sa === sb) return true;
  const na = parseMoneyInput(sa, locale);
  const nb = parseMoneyInput(sb, locale);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.005;
};

/**
 * A box on the scan card: what the owner types stays in it, as typed, while
 * they type. The card's boxes show the day's tills, and the tills read a
 * keystroke that lands on a figure already there as no change at all (the
 * bon's own 17.030 typed as "17030,0" is the read again, not a correction):
 * the box was rewritten to "17.030", the next key went onto that text —
 * "17.0300" — and the box turned red and held the lock. Leaving the box shows
 * the tills' figure. A figure changed from elsewhere meanwhile (Fortryd) is
 * shown at once: the typed text is kept only while it reads as the figure.
 */
function CardMoneyField({ value, onChange, onBlur, locale, ...rest }) {
  const [typed, setTyped] = useState(null);
  const shown = typed != null && sameAmount(typed, value, locale) ? typed : value;
  return (
    <MoneyField {...rest} locale={locale} value={shown}
      onChange={(e) => { setTyped(e.target.value); onChange?.(e); }}
      onBlur={(e) => { setTyped(null); onBlur?.(e); }} />
  );
}

/** A close row's day key, the way the form keys what it files: "date|branch". */
const closeRowKey = (dc) => `${String(dc?.date || "").slice(0, 10)}|${dc?.branch_id || ""}`;

/* ─── Which version of a day's draft the form holds (round 21) ────────────
   Every draft save sends every field, and the server replaced the stored row
   wholesale. A form holding an OLDER copy of the day — a save from the page's
   previous visit landed after it listed the day, or another phone saved since
   — filed that copy over the newer draft: a note typed on it erased a Kort
   2.000 already stored. So every save says which version it was built on
   (base_updated_at: the updated_at the form opened, or its own last save was
   answered with), and the server refuses an older one with draft_changed —
   the form then asks the owner: the newest draft, or theirs.
   A form that knew of no row for the day says so with a base far in the past:
   a draft filed since (by anyone) is newer. */
const NO_ROW_BASE = "1970-01-01T00:00:00";
// Round 23 review — the earliest close date the date field takes (a year
// typed digit by digit passes through 0002, 0020, 0202 …), and how long a
// typed date waits for the next key before it is taken.
const DATE_MIN = "2000-01-01";
const DATE_TYPING_PAUSE_MS = 900;
/** The page's own id for one save (kept on its audit row; base_save_id names it). */
const newSaveId = () => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through */ }
  return `dcs_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};
/** The later of two server stamps (ISO strings of one format compare as text). */
const laterStamp = (a, b) => (!a ? b || null : !b ? a : (String(b) > String(a) ? b : a));
/* Draft saves still on their way, from any visit of this page. The page is
   left and opened again inside the app while one is on its way: the new
   visit's history list (and the draft it opens) is read once those have
   landed — it listed the day before the save landed and opened the older
   row. Kept on the window: a full reload starts with none (the browser
   finishes a keepalive save on its own — the server's version check covers
   that one). Never waited on for long. */
const CLOSE_SAVES = Symbol.for("bonbox.closeSavesOnTheirWay");
const CLOSE_SAVES_WAIT_MS = 3000;
function closeSavesOnTheirWay() {
  try {
    if (!globalThis[CLOSE_SAVES]) globalThis[CLOSE_SAVES] = new Set();
    return globalThis[CLOSE_SAVES];
  } catch {
    return new Set();
  }
}
/** These promises settled — or `ms` passed (a stalled request never holds the page up for long). */
function settledWithin(promises, ms) {
  const list = [...promises];
  if (!list.length) return Promise.resolve();
  let timer;
  return Promise.race([
    Promise.allSettled(list),
    new Promise((r) => { timer = setTimeout(r, ms); }),
  ]).finally(() => clearTimeout(timer));
}
function closeSavesLanded() {
  return settledWithin(closeSavesOnTheirWay(), CLOSE_SAVES_WAIT_MS);
}
// How long a save (or the lock) waits for the day's save before it.
const SAVE_TURN_WAIT_MS = 12000;
// (Round 23: no take-back is retried on a timer any more — Start forfra and
// a date move delete a day's draft only when the owner said so, at once, and
// say so when it could not be done.)

/** What a draft's payments add up to (payment_total, else its lines). */
const paymentsOf = (dc) => {
  const t = Number(dc?.payment_total);
  if (Number.isFinite(t) && t > 0) return t;
  return Object.values(dc?.payment_breakdown || {}).reduce((a, v) => a + (Number(v) || 0), 0);
};
/** A draft that holds payments only — no revenue (a till typed as its payments). */
const isPaymentsOnly = (dc) => Boolean(dc) && !(Number(dc.revenue_total) > 0) && paymentsOf(dc) > 0;
/**
 * The form files the day: there is revenue to save, or payments typed — a
 * till of payments only is a till (closeTills.tillFromForm counts it at its
 * payments, and the terminal question adds it up as such). The autosave and
 * Start forfra ask this one question.
 */
const filesSomething = (revenue, payments) => revenue > 0 || payments > 0;
/** What a built payload was made of (not sent): the day it is for, and whether its source was read off photos. */
const payloadInfo = new WeakMap();

function CloseForm({ businessProfile = null, currency, t, branchType, branchId, branches = [], onDone, onQueued, isOnline, editDraft, onEditConsumed, smartScanPrefill, smartScanVerifyHints, onSmartScanConsumed, manualRequest = 0, heroScanFiles = null, onHeroConsumed, presetDate = null, existingCloses = [], onDraftSaved, onContinueDraft, onShowHistory, onEditingChange }) {
  const navigate = useNavigate();  // was undefined here → navigate("/connections") crashed (lines ~1029/1682)
  const { user, refreshUser } = useAuth();
  const { hasFeature, isReady: entReady } = useEntitlements();
  const askConfirm = useConfirm();
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
  // A figure back into the owner's own notation, grouped as they read it
  // ("2.350,50", not "2350.5" — a reopened close showed "12345,50").
  const toMoneyInput = (n) => moneyInputText(n, mLocale);
  // A box value from a scan or the server: a number is written in the owner's
  // notation, anything typed is kept exactly as typed.
  const asBox = (v) => (typeof v === "number" ? toMoneyInput(v) : String(v ?? ""));
  // Drawer − float = the takings the close saves. An unreadable drawer box is
  // passed through as typed, so the form's own money check flags it.
  const takingsFrom = (drawer, float) => {
    if (String(drawer ?? "").trim() === "") return "";
    const d = readMoney(drawer);
    if (!Number.isFinite(d)) return String(drawer);
    return toMoneyInput(Math.round((d - readMoney0(float)) * 100) / 100);
  };
  // The other way, for takings that arrive saved (Rediger) or scanned.
  const drawerFrom = (takings, float) => {
    if (String(takings ?? "").trim() === "") return "";
    const n = readMoney(takings);
    return Number.isFinite(n) ? toMoneyInput(Math.round((n + readMoney0(float)) * 100) / 100) : String(takings);
  };
  const onDrawerChange = (v) => { setDrawerCount(v); setCashCounted(takingsFrom(v, cashFloat)); };
  const onFloatChange = (v) => {
    setCashFloat(v);
    try { localStorage.setItem(CASH_FLOAT_KEY, v); } catch { /* private mode: just this session */ }
    if (String(drawerCount).trim() !== "") setCashCounted(takingsFrom(drawerCount, v));
  };

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
  // Næste, Tilbage and "Spring over" kept the scroll position: the next step
  // opened with its heading (and its first fields) under the sticky header.
  // After a step change the card's top is brought back into view — only when
  // it is above the header, never pulling a short page around.
  const formTopRef = useRef(null);
  const revealStepTop = () => {
    const run = () => {
      const el = formTopRef.current;
      if (el?.getBoundingClientRect && el.getBoundingClientRect().top < 64) {
        el.scrollIntoView?.({ block: "start", behavior: "smooth" });
      }
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
    else setTimeout(run, 0);
  };
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
  // What the owner actually counts is the WHOLE drawer, float included. The
  // close stores the day's cash TAKINGS (drawer − float): that is what the
  // cash difference compares with cash sales, and what the bank-drop card
  // tells them to bag. Before, one box meant both — counted with the float it
  // showed "+1.000 off"; counted without it, the bank-drop kept 1.000 kr. of
  // the day's takings back. The float is remembered on this device.
  const [drawerCount, setDrawerCount] = useState("");
  // This device's remembered float — the default for a close that has none
  // of its own. A reopened close counted with another float keeps THAT one
  // (the Rediger loader): rebuilt from this device's, the drawer and the
  // float on its kasserapport were figures nobody counted.
  const deviceFloat = () => {
    let v = "1000";
    try { v = localStorage.getItem(CASH_FLOAT_KEY) ?? "1000"; } catch { /* private mode */ }
    // Grouped like every other figure ("1.000"); a box it can't read stays as typed.
    const n = parseMoneyInput(v, mLocale);
    return Number.isFinite(n) ? toMoneyInput(n) : v;
  };
  const [cashFloat, setCashFloat] = useState(deviceFloat);
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
  // What the sales sync itself wrote into the revenue / payment boxes, so a
  // new day can take it back out. Only a box still holding exactly that figure
  // is the sync's — one the owner typed over (or a scan or a draft filled) is
  // theirs and stays.
  const salesFillRef = useRef(null);
  // Moves each time something other than the sync fills the boxes: the owner
  // typing, a Z-bon applied, a saved close loaded. A sync answer that lands
  // after such a fill is the day's POS figures, not the owner's — it must not
  // write over them.
  const boxFillEpochRef = useRef(0);
  // The boxes were last written from a ledger that held photos (an applied
  // scan or sum). Start forfra writes them back from what is left — also
  // after Fortryd took the photo out of the tills and back to the question,
  // when the ledger alone no longer says the boxes show it.
  const boxesHoldPhotosRef = useRef(false);

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
  // The date of the close being CORRECTED. While set, the date can't move:
  // re-dating a correction filed it under a new day and left the original
  // behind.
  const [editingDate, setEditingDate] = useState(null);
  // A saved draft opened (a ?date= link, Rediger, Fortsæt): the form says it
  // is that kladde — it opened prefilled with nothing saying whose numbers.
  const [editingDraft, setEditingDraft] = useState(false);
  // The branch the close is FILED under. Normally the one picked at the top
  // of the page; a close opened from History (Rediger / Fortsæt) or replaced
  // from the "already a draft" banner keeps its own. With "All branches"
  // picked, a Mirabelle draft was re-saved with no branch — a second close
  // for the same day beside the first. undefined = follow the picker.
  const [fileBranchOverride, setFileBranchOverride] = useState(undefined);
  const fileBranchId = fileBranchOverride !== undefined ? fileBranchOverride : (branchId || null);
  useEffect(() => {
    onEditingChange?.(editingDate);
    return () => onEditingChange?.(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingDate]);

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
  // (Round 23: figures typed for one day, the date then moved, are asked
  // about BEFORE the date changes — moveDate's question — so there is no
  // in-between state of figures on screen for a day they were not filed for.)
  // A day named by the link that opened the page (see DailyClosePage).
  const presetHandledRef = useRef(null);
  useEffect(() => {
    if (!presetDate || presetHandledRef.current === presetDate || editingDate) return;
    presetHandledRef.current = presetDate;
    dateChosenRef.current = true;
    setBusinessDate(presetDate);
  }, [presetDate, editingDate]);

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
  // Honoured ONCE per tap: with scanMode in the deps, every later return to
  // the scan card ("← Scan Z-bon") re-fired it and bounced the owner back to
  // step 1 — the scan button did nothing.
  const manualHandledRef = useRef(0);
  useEffect(() => {
    if (!manualRequest || manualHandledRef.current === manualRequest) return;
    if (scanMode === "idle") {
      manualHandledRef.current = manualRequest;
      setScanMode("skipped");
      setStep(1);
    }
  }, [manualRequest, scanMode]);
  // ─── The day's tills — ONE place (utils/closeTills) ─────────────────
  //
  // The scan card used to be its own state (one merged scan) beside the
  // form's boxes, and the figures were folded back and forth between the two
  // ("← Scan Z-bon" folded the form into the card, "Brug disse tal" copied
  // the card into the form, a new photo seeded the form as the first side).
  // Every round fixed one fold and opened another: Start forfra after an
  // applied sum left the bon in the boxes, the next photo took them as the
  // owner's own till, and the same bon was counted twice.
  //
  // Now the day is a ledger of tills, each with its own figures and the
  // owner's edits on top. The card is a view of it (scanResult below), the
  // boxes are written from it when they show it, and every edit — on the card
  // or on the form — goes into it. The ref mirrors the state because
  // handleFileSelect is awaited in a loop (several photos in one pick).
  const [ledger, setLedger] = useState(() => createTills(mLocale));
  const ledgerRef = useRef(ledger);
  const act = (fn, ...args) => {
    const next = fn(ledgerRef.current, ...args);
    if (next !== ledgerRef.current) {
      ledgerRef.current = next;
      setLedger(next);
    }
    return next;
  };
  useEffect(() => {
    if (ledgerRef.current.locale !== mLocale) act((s) => ({ ...s, locale: mLocale }));
  }, [mLocale]);
  // The ledger the stored draft holds (or the waiting save will send): set
  // when the autosave files the form, and when a draft is opened. The card
  // says "not saved yet" while what it shows differs from it — a Fortryd, a
  // photo, a correction made on the card is filed by "Brug disse tal".
  const filedLedgerRef = useRef(null);
  // The scan card: the tills folded with the merge rules (memoised per state).
  const scanResult = useMemo(() => cardView(ledger), [ledger]);
  // What the day saves when a card is in it: what each till saves, added up.
  const ledgerSaved = useMemo(() => savedTotal(ledger), [ledger]);
  // A day of several tills (another terminal summed in).
  const severalTills = useMemo(() => tillGroups(ledger).length > 1, [ledger]);
  // The day's total emptied on the card of several tills: no figure — the
  // tills keep theirs, and the box is red and holds the lock until the
  // owner types one (or the review would show one figure and lock another).
  const scanTotalEmptied = Boolean(scanResult) && severalTills && scanResult.revenue_total_text != null
    && String(scanResult.revenue_total_text).trim() === "";
  const [scanPhotos, setScanPhotos] = useState([]); // [{url, name, ref}]
  // The photos still in the day: one thrown away with "brug det ikke" goes
  // from the card's thumbnails (and from Start forfra's count) with it.
  const dayPhotos = useMemo(() => {
    const refs = new Set([...ledger.entries.map((e) => e.photo), ...ledger.pending.map((p) => p.photo)]);
    return scanPhotos.filter((p) => !p.ref || refs.has(p.ref));
  }, [scanPhotos, ledger]);
  // First scanned Z-report photo URL (Supabase signed URL or local path).
  // Persisted on the close row as receipt_photo so the owner can re-view
  // the source document later (Bogføringsloven §10 retention).
  const [receiptPhotoUrl, setReceiptPhotoUrl] = useState(null);
  // ─── What the server holds for each day this form files ────────────
  //
  // The server reads a null source_meta / receipt_photo as "keep what is
  // stored". That only holds while the stored row is still what the day was
  // when the form opened it. A bon summed in and filed (source "Z-bon", its
  // photo), then thrown away with Start forfra, left a typed close filed —
  // and locked — as "Z-bon (scannet)" with the thrown-away bon's photo sent
  // to the revisor. So the form keeps, per day (`date|branch`):
  //   loadedPhotoRef   the reopened close's own photo (Start forfra gives it
  //                    back with the draft's till; null for a close typed here)
  //   serverSrcRef     the source and photo the server answered with
  //   filedScanKeysRef days this form filed a source read off photos for —
  //                    with no photo left, the record is told again what it is
  //   filedPhotosRef   the photos this form filed (never the reopened close's
  //                    own): with no photo left in the day, a stored photo is
  //                    cleared only when it is one of these. Any other photo
  //                    is another device's, and a null keeps it.
  //   ownRowsRef       the row id each save answered with, and the row as the
  //                    server stored it (`row`): what Start forfra's question
  //                    names. Round 23 — no draft is ever taken back on a
  //                    guess of whose it is: a day's draft is deleted only
  //                    when the owner chose it (Start forfra, a date move),
  //                    on the version this form holds (deleteDayDraft).
  const loadedPhotoRef = useRef(null);
  const loadedUnlockedRef = useRef(false);
  const serverSrcRef = useRef({});
  const filedScanKeysRef = useRef(new Set());
  const filedPhotosRef = useRef(new Set());
  const ownRowsRef = useRef({});
  // Round 21 — which version of each day's draft this form holds (see
  // NO_ROW_BASE): `baseRef` the updated_at it opened, or its own last save
  // was answered with (sent as base_updated_at); `ownStampsRef` every version
  // its own saves were answered with (a refusal over one of those is the
  // form's own save landing first, never another device's); `keyInflightRef`
  // its saves on their way per day (the next one waits for them).
  const baseRef = useRef({});
  const ownStampsRef = useRef({});
  const keyInflightRef = useRef({});
  // …and those of them already sent (past their turn): a refusal waits for
  // these to answer — never for a save queued behind the refused one.
  const keyWireRef = useRef({});
  // Each save on its way → its id (base_save_id of the save that follows it).
  const saveIdOfRef = useRef(new Map());
  // Round 21 review — every save's body is numbered as it is BUILT
  // (runNoRef); `sentNoRef` per day: the newest of those already SENT. A save
  // that waited its turn while a newer one went at once (the page going
  // away) is not sent after it — on the newer one's own version it was
  // stored over the owner's last change — and a refusal of a save older than
  // one already sent is not acted on (re-posted or kept, older figures
  // replaced newer ones).
  const runNoRef = useRef(0);
  const sentNoRef = useRef({});
  // Per day, the save that got no answer ({ id, runNo }: sent; a dropped
  // socket, a 4G handoff, the timeout — it may well have landed): the next
  // save of the day, the lock and a delete follow it (base_save_id), so the
  // version it wrote is the form's own — never "saved somewhere else".
  // Cleared when a save built after it is answered.
  // A save whose answer was lost MAY be the form's own: before the form
  // deletes the day's draft it asks the server (deleteDayDraft).
  const lostSaveRef = useRef({});
  // Every save id this form sent: a stored row whose last save is one of
  // these is the form's own (the server's last_save_id).
  const mySaveIdsRef = useRef(new Set());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Round 23 — the form emptied by Start forfra: bumped, so a follow-up
  // started before (a move finishing) never writes onto the empty form.
  const formEpochRef = useRef(0);
  // The day Start forfra is deleting right now: nothing is filed for it
  // while the delete is on its way (the form is about to be emptied).
  const startingOverRef = useRef(null);
  // Round 23 — a draft save that got NO answer, per day, exactly as it was
  // sent ({ body, runNo }): the owner's figures on no server for sure. It is
  // sent again on the way out and once online — also when the form has gone
  // back to the scan card since (the card is not the day until applied, and
  // the waiting save was dropped with it: a figure typed offline, then
  // "← Scan Z-bon", was never sent). Cleared by an answered save of the day
  // built after it, and when the day's draft is deleted.
  const failedBodyRef = useRef({});
  // The draft body this form last sent per day: what Start forfra's question
  // names (the version the delete waits for, once it has answered).
  const sentBodyRef = useRef({});
  // "Keep my numbers" answered: the save goes now, not two seconds later.
  const sendNowRef = useRef(false);
  // Round 22 — offline. A draft save that got no answer at all (offline, a
  // dead connection — or stored with its answer lost) is not dropped: the
  // same draft waits, armed with no timer (`retryArmedRef`: the draft as it
  // was built), and goes when the page is left, when the browser says it is
  // online again, or with the next change. It was dropped: a blip during the
  // last edit, the page left later with the network back — that edit was on
  // no server and on no device. Left while the browser is OFFLINE, the draft
  // is kept on this device instead (`offlineCopyRef`, the offline queue,
  // sent when it is online again) — a request then could only fail.
  const retryArmedRef = useRef(null);
  const offlineCopyRef = useRef(null);
  // The day's draft was saved somewhere else after this form read it, and a
  // save of the form's was refused for it (draft_changed): nothing was
  // overwritten, and the owner is asked which wins — the newest draft, or
  // theirs. { key, current, stamp, via: "draft" | "lock" } or null.
  const [draftConflict, setDraftConflict] = useState(null);
  // …for the leave handlers (mounted once); and the copy of the owner's
  // figures kept on this device when the page went away with that question
  // still open ({ conflict, id }): the autosave sends nothing while it is
  // open, so leaving lost the figures — they existed only on screen.
  const draftConflictRef = useRef(null);
  draftConflictRef.current = draftConflict;
  const conflictCopyRef = useRef(null);
  // Whether the form, as it stands, files something (the autosave's rule).
  const formFilesRef = useRef(false);
  // Saves on their way: a draft is deleted only once they have answered.
  const inflightRef = useRef(new Set());
  // How many saves this form has sent per day: a draft taken back is taken
  // back only if nothing was filed for the day since that was asked (an
  // older answer must never undo a newer action on the same day).
  const sendGenRef = useRef({});
  // The day (and branch) the form is on, read by follow-ups that finish
  // after a render (a move answered while a delete waited).
  const rowKeyRef = useRef("");
  // A row as the server holds it now (a delete refused for another device's
  // newer version carries it): History lists the old version until it
  // refetches, and the day's banner showed that amount.
  // Held only over the list it was made against (`listed`): the next list
  // History answers with is the server's own word.
  const [rowOverrides, setRowOverrides] = useState({});
  const existingClosesRef = useRef(existingCloses);
  existingClosesRef.current = existingCloses;
  // Bumped when what is stored for the day may no longer be what the form
  // would file (a delete that did not go through): the autosave looks again.
  const [refile, setRefile] = useState(0);
  // Drafts this form deleted: History may list them until it refetches.
  const [droppedIds, setDroppedIds] = useState(() => new Set());
  const droppedIdsRef = useRef(droppedIds);
  droppedIdsRef.current = droppedIds;
  /** The version a save of `key` is built on: the form's own, else the listed row's, else "no row known". */
  const baseFor = (key) => {
    if (Object.prototype.hasOwnProperty.call(baseRef.current, key)) return baseRef.current[key];
    const listed = (existingClosesRef.current || []).find((dc) => closeRowKey(dc) === key && !dc.is_deleted && !droppedIdsRef.current.has(dc.id));
    if (listed) return listed.updated_at || null;
    return NO_ROW_BASE;
  };
  /** A save of the form's was answered with this version of the day. */
  const noteStamp = (key, stamp) => {
    if (!stamp) return;
    baseRef.current[key] = laterStamp(baseRef.current[key], stamp);
    if (!ownStampsRef.current[key]) ownStampsRef.current[key] = new Set();
    ownStampsRef.current[key].add(stamp);
  };
  // Round 23 — a date move WITH figures is asked first ("Flyt tallene til
  // {to}? Kladden for {from} slettes."). Answered yes: the figures are saved
  // to the new day, then the old day's draft is deleted on the version this
  // form holds. { from, to, keys }: the day the figures came from (named by
  // the note), the new day, and the days whose draft goes once the new day's
  // save has landed (the first day, and a day passed on the way — moved
  // again before the new day was filed).
  const moveFromRef = useRef(null);
  // What the move did, said once under the date: { from, to, state, keys,
  // canDelete, failed } — state "moved" (the old draft is gone: "Flyttet
  // fra …") or "copy" ("Kopieret til … — kladden for … står der stadig", with
  // "Slet den" while it can still be deleted). Never "moved" unless the old
  // day's draft is gone.
  const [movedNote, setMovedNote] = useState(null);
  // A move's question (or its "Slet den") is being answered: the date picker
  // waits for it.
  const [moveBusy, setMoveBusy] = useState(false);
  const moveBusyRef = useRef(false);
  // The new day's prefill as the move's question read it: { date, branch,
  // type, data, at } — the prefill effect uses it instead of a second read.
  const movePrefetchRef = useRef(null);
  // The scan MOMS the form last took ({ key: scanMomsKey, manual }), so a
  // second "Brug disse tal" keeps the MOMS the form already has. And the
  // Z-bon's one-off extras (drawer count, clerk notes), applied once per scan:
  // every re-apply appended the clerk notes again and reset a typed count.
  const [appliedMoms, setAppliedMoms] = useState(null);
  // A reopened draft's typed MOMS and the total it was saved with ({ moms,
  // total, followed }). The bon's MOMS comes back from the row as a typed
  // figure with no photo behind it, so the "follows the total" rule below
  // never saw the total move: 3.406 stayed under a corrected 17.130.
  const [draftMoms, setDraftMoms] = useState(null);
  const appliedPrefillRef = useRef(null);
  // What a Z-report's own prefill put in the form (applyScanValues): the
  // drawer its denomination count set (and the drawer before it), and each
  // note it appended (per-clerk lines, the read's ambiguity notes). Read off
  // a photo, not typed: while unchanged they never keep a thrown-away photo's
  // draft as "your count / your note", and Start forfra takes them away with
  // the photo. { drawer, drawerBefore, notes: [] } or null.
  const scanPrefillRef = useRef(null);

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
    boxFillEpochRef.current += 1;
    // A move answered but not filed yet is not this draft's: nothing of it
    // was filed for this day, and the day it came from keeps its draft.
    moveFromRef.current = null;
    setMovedNote(null);
    // (Round 23 review: what Start forfra said is not said over the draft
    // loaded now.)
    setStartOverFailed(null);
    // An edited close is filed against ITS OWN date, never today — mark the
    // date as chosen before the prefill for that date can resolve.
    if (dc.date) {
      dateChosenRef.current = true;
      const d = typeof dc.date === "string" ? dc.date.slice(0, 10) : dc.date;
      setBusinessDate(d);
      setEditingDate(d);
    }
    setEditingDraft((dc.status || "confirmed") === "draft");
    setFileBranchOverride(dc.branch_id || null);
    // Saved amounts come back as numbers; the boxes take the owner's own
    // notation, grouped ("1.234,50"), not the API's "1234.5".
    const asInput = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? toMoneyInput(n) : String(v ?? "");
    };
    // Every saved key comes back as a field. A custom category ("Catering")
    // that isn't in the venue's default list was loaded into state but had no
    // field — and the draft autosave then re-saved the close WITHOUT it.
    const rev = {};
    const pay = {};
    // Saved keys meet the built-in fields case-insensitively: a draft stored
    // as "Food"/"Drinks" opened six revenue boxes — English ones beside empty
    // Mad/Drikkevarer.
    const canonRev = (k) => (revCats.find((c) => c.key.toLowerCase() === String(k).toLowerCase())?.key) || k;
    const canonPay = (k) => (payMethods.find((m) => m.key.toLowerCase() === String(k).toLowerCase())?.key) || k;
    if (dc.revenue_breakdown) {
      Object.entries(dc.revenue_breakdown).forEach(([k, v]) => { rev[canonRev(k)] = asInput(v); });
      setRevAmounts(rev);
      setRevCats((prev) => {
        const have = new Set(prev.map((c) => c.key));
        const extra = Object.keys(rev)
          .filter((k) => !have.has(k))
          .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "), icon: "Tag" }));
        return extra.length ? [...prev, ...extra] : prev;
      });
    }
    if (dc.payment_breakdown) {
      Object.entries(dc.payment_breakdown).forEach(([k, v]) => { pay[canonPay(k)] = asInput(v); });
      setPayAmounts(pay);
      setPayMethods((prev) => {
        const have = new Set(prev.map((c) => c.key));
        const extra = Object.keys(pay)
          .filter((k) => !have.has(k))
          .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "), icon: "Wallet" }));
        return extra.length ? [...prev, ...extra] : prev;
      });
    }
    setScanPhotos([]);
    // The boxes hold the saved close now, not a sales sync.
    salesFillRef.current = null;
    // Every field takes the SAVED value, empty included: a field the close
    // never had kept whatever this form held before, and the next save
    // filed it under the edited day.
    const loaded = {
      cash: dc.cash_counted != null ? asInput(dc.cash_counted) : "",
      tips: dc.tips_total != null ? asInput(dc.tips_total) : "",
      staff: dc.tips_staff_count != null ? String(dc.tips_staff_count) : "",
      by: dc.closed_by || "",
      notes: dc.notes || "",
      // A typed (or scanned) MOMS comes back as typed. Opening it in Auto
      // re-saved a different MOMS the moment anything else changed.
      momsMode: dc.moms_mode === "manual" && dc.moms_total != null ? "manual" : "auto",
      momsManual: dc.moms_mode === "manual" && dc.moms_total != null ? asInput(dc.moms_total) : "",
      gavekort: "",
      batch: "",
    };
    // The reopened close is the day's one till now: a "draft" till with the
    // saved lines, its saved total when that is not its lines (a total above
    // them was the Z-bon's — the card's floor; one below them was typed), its
    // MOMS and the source it was saved with. It is never a Z-bon read ("0/8
    // felter fundet", "aflæst"), and a photo read before it (abandoned, or
    // for another day) does not come back behind "← Scan Z-bon".
    const draftLedger = act(loadDraft, {
      revenue: rev,
      payments: pay,
      tips: config.hasTips ? loaded.tips : null,
      total: Number(dc.revenue_total),
      totalText: asInput(dc.revenue_total),
      moms: loaded.momsMode === "manual" ? loaded.momsManual : null,
      meta: dc.source_meta && typeof dc.source_meta === "object" ? dc.source_meta : null,
    });
    // The boxes show the reopened close now, not a photo.
    boxesHoldPhotosRef.current = false;
    // The float the close was counted with, when it has one — never this
    // device's: a draft saved with 1.000 reopened as "Optalt 3.004,75 ·
    // Byttepenge 1.500" (this device's), and the next save — a note — filed
    // 1.500 on its kasserapport. Not written to this device's default: that
    // stays the owner's own choice (onFloatChange). A close with none of its
    // own takes this device's default, never the last close opened here.
    const savedFloat = dc.cash_float != null && Number.isFinite(Number(dc.cash_float))
      ? asInput(dc.cash_float) : deviceFloat();
    setCashFloat(savedFloat);
    setCashCounted(loaded.cash);
    setDrawerCount(drawerFrom(loaded.cash, savedFloat));
    setMomsMode(loaded.momsMode);
    setMomsManual(loaded.momsManual);
    // The saved MOMS is the form's: going back to the card and applying it
    // again dropped a typed MOMS to Auto.
    setAppliedMoms({ key: scanMomsKey(cardView(draftLedger)), manual: loaded.momsManual, owner: false });
    setDraftMoms(loaded.momsMode === "manual" && Number(dc.revenue_total) > 0
      ? { moms: Number(dc.moms_total), total: Number(dc.revenue_total), followed: false }
      : null);
    appliedPrefillRef.current = null;
    scanPrefillRef.current = null;
    // Autosave waits for a real change: opening "Rediger" re-saved the close
    // within two seconds, before the owner had touched anything. Every field
    // counts as a change — a note, a staff count or the MOMS alone was never
    // saved, because only the money fields were compared — and so does the
    // day's ledger (a total typed on the card moves no box).
    // The baseline is what the form holds once loaded — Gavekort and Batch
    // included (emptied below), so opening the draft is not a change.
    editBaselineRef.current = editSignature({ rev, pay, ...loaded, cashFloat: savedFloat });
    editOpenLedgerRef.current = draftLedger;
    // The stored draft is this ledger: the card says so until it moves.
    filedLedgerRef.current = draftLedger;
    // NOTE: registerCash (the "Expected (from register)" baseline) is NOT set
    // from the saved close here — a close row can't tell us whether its stored
    // cash_expected was register- or typed-derived. Instead the prefill effect
    // re-derives it from live Sale rows for this date (authoritative, and what
    // the backend will use on re-save), so the label stays honest on edit.
    setTipsTotal(loaded.tips);
    setStaffCount(loaded.staff);
    setClosedBy(loaded.by);
    setNotes(loaded.notes);
    // The salon's Gavekort solgt and the bakery's Parti/Batch are not columns
    // of the close: the saved note already carries their line. A figure typed
    // for another day stayed in the box, and opening this draft re-saved it
    // with that day's "Gavekort solgt: 500,00 kr." on its kasserapport.
    setGavekortSold(loaded.gavekort);
    setBatchRef(loaded.batch);
    // This close's own photo, or none: a Z-bon read earlier for another day
    // stayed behind and was filed as this day's source document.
    setReceiptPhotoUrl(dc.receipt_photo || null);
    // …and what the server holds for it is what was just opened.
    loadedPhotoRef.current = dc.receipt_photo || null;
    // An unlocked close reopened: its own source told again after Start
    // forfra says it was changed after the unlock (closeTills.sourceMetaOf).
    loadedUnlockedRef.current = Boolean(dc.unlock_reason);
    {
      const loadedKey = closeRowKey(dc);
      serverSrcRef.current[loadedKey] = {
        meta: dc.source_meta && typeof dc.source_meta === "object" ? dc.source_meta : null,
        photo: dc.receipt_photo || null,
      };
      filedScanKeysRef.current.delete(loadedKey);
      // The version opened: the next save is built on it.
      baseRef.current[loadedKey] = dc.updated_at || null;
      // Opened (the newest draft, or a close from History): a draft of the
      // day that got no answer is not sent over what the owner chose to open.
      delete failedBodyRef.current[loadedKey];
      // …nor named as the day's draft by Start forfra: what is stored is
      // what was just opened — on exactly that version (a save of the day
      // that got no answer before is not followed any more: the owner chose
      // the version the server holds now).
      delete sentBodyRef.current[loadedKey];
      delete lostSaveRef.current[loadedKey];
    }
    // Opened (the newest draft, or another day): nothing is waiting on the
    // owner's answer any more.
    setDraftConflict(null);
    // Skip scan UI (the user already has values) and jump to step 1.
    setScanMode("skipped");
    setStep(1);
    onEditConsumed?.();
    // Rediger / Fortsæt / a link that names the day: the loaded form sat
    // below the fold and nothing moved.
    setTimeout(() => document.getElementById("close-date")?.scrollIntoView?.({ behavior: "smooth", block: "center" }), 60);
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
    act(hydrateScan, smartScanPrefill);
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
  const pendingScans = useMemo(() => ledger.pending.map((p) => p.scan), [ledger]);
  const pendingScan = pendingScans[0] || null;
  // The question mounts at the TOP of the scan card, but the photo that raises
  // it comes from "+ Tilføj" at the BOTTOM — and the scan spinner collapses the
  // card, so Chrome's scroll anchoring put the owner back down there with the
  // question 700–1.400 px above the screen while the two buttons in view went
  // gray. Each time a question appears (a new photo, Fortryd, the next one in
  // the queue, a photo added while it is open) it is brought into view and
  // takes focus; the reason line above the gray buttons does the same on a tap.
  const terminalQRef = useRef(null);
  const showTerminalQuestion = () => {
    const el = terminalQRef.current;
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    el?.focus?.({ preventScroll: true });
  };
  useEffect(() => {
    if (!pendingScan || scanMode !== "result") return;
    // After the card has laid out again (the spinner is gone by then).
    if (typeof window.requestAnimationFrame === "function") {
      const raf = window.requestAnimationFrame(showTerminalQuestion);
      return () => window.cancelAnimationFrame?.(raf);
    }
    const timer = setTimeout(showTerminalQuestion, 0);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScan, scanMode]);
  // Fortryd: exactly one step back on the ledger — a sum, a "same
  // terminal", or a page added since — so a wrong tap is catchable before
  // anything is locked. It restores the unanswered queue too: an undo means
  // "I answered that wrong", so the question comes back.
  const undoStep = lastStep(ledger);
  const canUndoChoice = undoStep === "sum" || undoStep === "replace" || undoStep === "page" || undoStep === "drop";

  /** The owner answered "another terminal" (sum) or "same terminal" (replace). */
  const resolveTerminalChoice = (mode) => {
    // Whatever is still queued and NOT ambiguous against the new day folds in
    // straight away (closeTills.chooseTerminal): one till photo plus two
    // detail pages costs exactly one tap.
    act(chooseTerminal, mode);
  };

  // The day's first photo still in it, for the close's receipt_photo.
  const firstPhotoUrl = (lg) => [...activeEntries(lg).filter((e) => e.origin === TILL_SCAN), ...lg.pending]
    .map((e) => e.scan?.image_url).find((u) => typeof u === "string" && u) || null;
  const undoMerge = () => {
    if (!canUndoChoice) return;
    const after = act(undoTill);
    // A photo thrown away with "brug det ikke" and brought back: its stored
    // image is the close's source document again.
    if (!receiptPhotoUrl) { const u = firstPhotoUrl(after); if (u) setReceiptPhotoUrl(u); }
    // Taken back from the scan's start (the only photo was thrown away
    // there): the question is on the card again.
    if (cardView(after)) setScanMode("result");
  };

  /** "Det er det samme billede — brug det ikke": the waiting photo goes, nothing else. */
  const dropWaitingPhoto = () => {
    const before = ledgerRef.current;
    const head = before.pending[0];
    const after = act(dropPending);
    if (head && receiptPhotoUrl && head.scan?.image_url === receiptPhotoUrl) setReceiptPhotoUrl(firstPhotoUrl(after));
    // The only photo in the day thrown away (the first over a typed close or
    // a reopened draft, or a retake whose sum was taken back with Fortryd):
    // there is no card left to show. The page went blank — no card, no form,
    // no Fortryd — and the boxes kept the sum just taken back, which stayed
    // the draft. Back to where the photo was taken, with the owner's own till
    // in the boxes, filed from there; the drop stays undoable.
    // No photo left in the day, but the owner's till is a card of its own (a
    // reopened draft's total emptied before the photo): the same. It stayed
    // on the card, not filed — while the draft kept the bon just dropped
    // ("brug det ikke"), its figures and its photo, and "Fortsæt kladden"
    // brought that bon back. From the scan's start the owner's till is the
    // day again and is filed (its own source, no photo — closeTills restore).
    if (!cardView(after) || (!hasScanTills(after) && !after.pending.length)) {
      ownTillBack(before, after);
      setScanMode("idle");
    }
  };

  const handleFileSelect = async (rawFile) => {
    if (!rawFile) return;
    // Start forfra is emptying the day (its delete on its way): not now.
    if (startingOverRef.current) return;
    // Round 23 — a scan needs the server: offline nothing is read, nothing
    // changes, and the owner is told to type the figures (or scan once
    // online). A scan already on its way when the connection drops fails
    // the same way (below).
    const offlineNow = () => typeof navigator !== "undefined" && navigator.onLine === false;
    const offlineMsg = t("dcScanNeedsInternet", "Scanning needs internet — type the figures in, or scan when you're back online");
    if (offlineNow()) { setScanError(offlineMsg); return; }
    // The form as it stood before the photo is saved first (the hero camera
    // takes a photo from the form itself).
    flushWaitingSave();
    // The photo as the camera roll knows it: picked again, it is the same photo.
    const photoRef = `${rawFile.name || ""}|${rawFile.size ?? ""}|${rawFile.lastModified ?? ""}`;
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
    let droppedOffline = false;
    const onOffline = () => { droppedOffline = true; };
    try { window.addEventListener("offline", onOffline); } catch { /* no window */ }
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
      // The connection dropped while it was read: the read is not used —
      // nothing on the card or in the day changes.
      if (droppedOffline || offlineNow()) throw Object.assign(new Error("offline"), { scanOffline: true });
      // Add thumbnail (use the resized file so the preview matches what
      // the backend actually saw)
      const before = ledgerRef.current;
      // The stored image's path (the server keys it by the photo's bytes;
      // the signed URL's token is not part of it): the same photo picked
      // again — renamed, or read a little differently by the OCR — is
      // already in the day. Never a second till: nothing is added, and the
      // owner is told why.
      const scanId = typeof res.data?.image_url === "string" && res.data.image_url
        ? res.data.image_url.split("?")[0] : null;
      if (isDuplicateScan(before, { photo: photoRef, id: scanId })) {
        setScanError(t("dcScanSamePhoto", "That photo is already in today's close — nothing was added."));
        setScanMode(cardView(before) ? "result" : "idle");
        return;
      }
      const thumbUrl = URL.createObjectURL(file);
      setScanPhotos(prev => [...prev, { url: thumbUrl, name: file.name, ref: photoRef }]);
      // Before the day's first photo the form is the truth: a close typed by
      // hand, or a reopened draft, becomes the first till ("the one on
      // screen") — so a second Z-bon is asked about instead of silently
      // becoming the whole close. An untouched POS sync is not a till.
      // Whether to ask, to queue behind a question already open, or to fill
      // in a page: closeTills.addScan.
      const form = hasScanTills(before) ? undefined : formAsTill();
      act(addScan, res.data, { photo: photoRef, id: scanId, form });
      if (form?.moms_total != null) {
        // The MOMS the owner typed is on their till now, and a sum adds the
        // bon's to it: applying takes the day's figure — not the typed one
        // alone as "typed since the last apply" (3.000 under 21.130).
        setAppliedMoms((prev) => ({ ...(prev || {}), manual: momsManual, owner: false, fromScan: false }));
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
      // The connection dropped (round 23): said as such — the photo is fine.
      const lostLine = err?.scanOffline || (!err?.response && (droppedOffline || offlineNow()));
      if (lostLine) setScanError(offlineMsg);
      else setScanError(errText(err, t("dcScanFailed", "We couldn't read that photo. Take another one, or type the numbers in yourself.")));
      setScanMode(cardView(ledgerRef.current) ? "result" : "idle"); // keep results if we already have some
    } finally {
      try { window.removeEventListener("offline", onOffline); } catch { /* no window */ }
    }
  };

  // A photo taken from the page's hero button runs through this same scan.
  // Consumed once: the page clears it at once, or every return to this tab
  // re-scanned the same photo — over a draft opened with Rediger.
  const heroHandledRef = useRef(null);
  useEffect(() => {
    if (!heroScanFiles || heroHandledRef.current === heroScanFiles) return;
    heroHandledRef.current = heroScanFiles;
    onHeroConsumed?.();
    if (editingDate) return;
    // A Mad corrected on Trin 1 is already in the ledger (every box edit goes
    // there), so a photo from the hero sums with it; with no photo yet, a
    // close typed by hand is the first till (handleFileSelect).
    (async () => { for (const f of heroScanFiles.files) await handleFileSelect(f); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroScanFiles]);

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

  // The form as a till, the moment the day's first photo comes in: what the
  // owner typed or a reopened draft holds — not the sales sync's own
  // untouched figures — with the MOMS they typed. Null when the form holds
  // nothing of the owner's (closeTills.tillFromForm). `o` overrides a box
  // that has just been typed into (state is one render behind).
  const formAsTill = (o = {}) => tillFromForm({
    revenue: o.rev || revAmounts,
    payments: o.pay || payAmounts,
    tips: config.hasTips ? (o.tips !== undefined ? o.tips : tipsTotal) : null,
    moms: momsTyped ? readMoney(momsManual) : null,
    synced: salesFillRef.current,
    locale: mLocale,
  });
  // A box the owner typed in on the form: the ledger takes it — into their
  // own till, or the till it belongs to — so the card, the saved total, the
  // revisor's source and Start forfra all see the same figure. Nothing is
  // folded back later.
  const typeInForm = (field, value, o = {}) => {
    act(typeIntoForm, field, value, { fromForm: true, form: formAsTill(o) || undefined });
  };
  // The boxes written from the ledger: after Start forfra, what is left is
  // the owner's own till (or nothing) — never the photos' figures.
  const writeBoxesFromLedger = (lg) => {
    const fv = formValues(lg);
    const pick = (src, list) => {
      const out = {};
      list.forEach((c) => { if (src[c.key] != null && String(src[c.key]).trim() !== "") out[c.key] = asBox(src[c.key]); });
      Object.entries(src).forEach(([k, v]) => {
        if (!TOTAL_KEYS.includes(k) && v != null && String(v).trim() !== "" && !(k in out)) out[k] = asBox(v);
      });
      return out;
    };
    salesFillRef.current = null;
    boxFillEpochRef.current += 1;
    boxesHoldPhotosRef.current = false;
    setRevAmounts(pick(fv.revenue, revCats));
    setPayAmounts(pick(fv.payments, payMethods));
    if (config.hasTips) setTipsTotal(fv.tips != null && String(fv.tips).trim() !== "" ? asBox(fv.tips) : "");
  };

  // What is left of the day is the owner's own till, or nothing (Start
  // forfra; the only photo thrown away): when the boxes showed photos they
  // show what is left — so the next photo is asked about against the owner's
  // own figures, never against a bon already thrown away (the same 3.000
  // counted twice) — and the MOMS goes back with them.
  const ownTillBack = (before, after) => {
    // Whether the boxes show photos is not only what the tills hold right
    // now: after Fortryd the bon is back on the question (out of the tills)
    // while the boxes still hold the applied sum — left there, it was filed
    // as typed and counted again by the retake.
    const boxesShowedPhotos = before.mirror
      && (hasScanTills(before) || before.pending.length > 0 || boxesHoldPhotosRef.current);
    if (boxesShowedPhotos) writeBoxesFromLedger(after);
    // The MOMS goes back with them: the owner's till's own MOMS, or worked
    // out. A MOMS the owner typed since is theirs and stays — unless it rode
    // on photos alone (a photo-only day, or a scan's MOMS put in the form):
    // then it belongs to no till that is left, and was filed as "indtastet"
    // on the next day's bon.
    const ownerTypedMoms = momsTyped && Boolean(appliedMoms)
      && (appliedMoms.owner || momsManual !== appliedMoms.manual);
    const momsRodeOnPhotos = Boolean(appliedMoms?.fromScan) || (boxesShowedPhotos && !formTill(before));
    if (boxesShowedPhotos && (!ownerTypedMoms || momsRodeOnPhotos)) {
      const left = momsOf(after);
      if (left.source === "typed") { setMomsMode("manual"); setMomsManual(asBox(left.value)); } else { setMomsMode("auto"); setMomsManual(""); }
      setAppliedMoms(null);
    } else if (momsRodeOnPhotos) {
      setMomsMode("auto"); setMomsManual(""); setAppliedMoms(null);
    }
    appliedPrefillRef.current = null;
  };

  const applyScanValues = (jumpToReview = false) => {
    if (startingOverRef.current) return;
    const lg = ledgerRef.current;
    const card = cardView(lg);
    if (!card) return;
    // What the boxes show: the tills' lines added up (the card's own lines).
    const fv = formValues(lg);
    const r = fv.revenue || {};
    const p = fv.payments || {};
    // Fill revenue — match against current template cats + any extras from OCR
    const newRev = {};
    revCats.forEach(c => { if (r[c.key]) newRev[c.key] = asBox(r[c.key]); });
    Object.entries(r).forEach(([k, v]) => { if (v && !newRev[k]) newRev[k] = asBox(v); });
    // The scan's figures replace the previous scan's outright: merging kept a
    // first photo's Drikkevarer/Kontant/MobilePay under a re-scan that read
    // only Mad and Kort (22.060 paid against a 17.030 Z-bon).
    // The boxes are the Z-bon's from here on, not the day's sales sync.
    salesFillRef.current = null;
    boxFillEpochRef.current += 1;
    // The owner's own till is in the day (a typed close, a reopened draft).
    const formSide = Boolean(formTill(lg));
    // The boxes show the ledger from here on: Start forfra writes them back.
    act(markApplied);
    boxesHoldPhotosRef.current = hasScanTills(lg) || lg.pending.length > 0;
    setRevAmounts(newRev);
    // Fill payments — match against current template methods + extras
    const newPay = {};
    payMethods.forEach(m => { if (p[m.key]) newPay[m.key] = asBox(p[m.key]); });
    Object.entries(p).forEach(([k, v]) => { if (v && !newPay[k]) newPay[k] = asBox(v); });
    setPayAmounts(newPay);
    // Fill tips (only for types that have tips). Z-reports often show
    // tips as negative (paid out) — keep the sign for accountant clarity.
    if (config.hasTips && fv.tips) setTipsTotal(asBox(fv.tips));
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
    // Once per figure (scanMomsKey). Back on the card and "Brug disse tal"
    // again is the same figure: the form keeps the MOMS it has — a reopened
    // draft's typed MOMS was dropped to Auto. A MOMS the owner typed since
    // the last apply is theirs and stays even when the figure moves.
    const momsKey = scanMomsKey(card);
    const ownerTypedMoms = Boolean(appliedMoms) && momsTyped
      && (appliedMoms.owner || momsManual !== appliedMoms.manual);
    let nextManual = momsMode === "manual" ? momsManual : "";
    // A card that is only the owner's own till (a reopened draft whose total
    // was corrected on the card, a typed close) brings no MOMS of a photo:
    // the form's MOMS stays as it is. The draft's saved MOMS on its till is
    // not "typed" for a total it was never saved with — the reopened-draft
    // rule (draftMoms, below) already lets it follow the corrected total.
    const photoMoms = hasScanTills(lg);
    if (photoMoms && (!appliedMoms || (appliedMoms.key !== momsKey && !ownerTypedMoms))) {
      // The day's MOMS by the ledger's one rule: the tills' own MOMS added
      // up when EVERY till's is known — the owner's typed MOMS on their till
      // (kept as theirs, never dropped to Auto, never called the Z-bon's), or
      // a bon's MOMS that still belongs to what that till saves. A corrected
      // total, a category raised past the bon, one till of two: worked out.
      const lm = momsOf(lg);
      if (lm.source !== "auto") {
        nextManual = asBox(lm.value);
        setMomsMode("manual");
      } else {
        // This scan carries no MOMS of its own (none read, one till of two, or
        // a corrected total): an EARLIER scan's MOMS must not stay behind. It
        // was saved "fra bon" 3.406 against a re-scanned, corrected 16.500.
        nextManual = "";
        setMomsMode("auto");
      }
      setMomsManual(nextManual);
    }
    // fromScan: the MOMS in the form is this scan's doing (not the form's own,
    // carried) — "Start forfra" takes it away with the scan.
    setAppliedMoms({ key: momsKey, manual: nextManual, owner: ownerTypedMoms, fromScan: !formSide });
    // ── Z-report specialized prefill (Part D) ───────────────────────
    // When the backend ran the kasserapport-specialized extractor it
    // returns a `prefill` block with cash-drawer counts, per-clerk
    // earnings, and the full payment-method split. Pre-populate the
    // cash-drawer step and drop the clerk summary into notes so the
    // owner spots schedule mismatches before locking the close.
    const pf = card.prefill;
    if (pf && appliedPrefillRef.current !== pf) {
      appliedPrefillRef.current = pf;
      const mark = { drawer: null, drawerBefore: drawerCount, notes: [], ...(scanPrefillRef.current || {}) };
      // Step 3 — Cash drawer counted total (from denomination math)
      if (pf.cash_drawer?.counted_total != null) {
        // A denomination count of the drawer — float included.
        const drawer = toMoneyInput(Number(pf.cash_drawer.counted_total));
        // The drawer before the photos' count: what was in the box unless it
        // is still an earlier photo's count.
        if (mark.drawer == null || drawerCount !== mark.drawer) mark.drawerBefore = drawerCount;
        mark.drawer = drawer;
        setDrawerCount(drawer);
        setCashCounted(takingsFrom(drawer, cashFloat));
      }
      // Notes — per-clerk earnings + any kasserapport notes
      const noteParts = [];
      if (pf.per_clerk_notes) noteParts.push(pf.per_clerk_notes);
      if (card.claude_notes) noteParts.push(card.claude_notes);
      if (noteParts.length > 0) {
        mark.notes = [...mark.notes, noteParts.join("\n")];
        setNotes(prev => prev ? prev + "\n" + noteParts.join("\n") : noteParts.join("\n"));
      }
      scanPrefillRef.current = mark;
    }
    // Jump to review or step 1 — from the bottom of a long scan card, so the
    // step's top is brought into view too.
    setScanMode("skipped");
    setStep(jumpToReview ? totalSteps : 1);
    revealStepTop();
  };

  // What the day's computed split says, for the hint above the categories and
  // "Nulstil til beregnet fordeling": null for a single-category vertical,
  // the owner's own historical mix when there is enough history, "none" (a
  // calm first-time line) when there is not.
  const splitMetaFrom = (data) => {
    if (defaultRevCats.length === 1 || branchType === "general") return null;
    const split = data?.category_split;
    if (split && split.categories && Object.keys(split.categories).length > 0) {
      return {
        source: split.source,
        confidence: split.confidence,
        sampleSize: split.sample_size,
        categories: split.categories,
      };
    }
    return { source: "none" };
  };

  // The day's sales sync written into the boxes. Payment methods the venue's
  // list lacks are added. Revenue: a single-category vertical gets the whole
  // total in its one category; a multi-category one gets the HONEST computed
  // split ("beregnet fordeling") from the owner's own historical mix when the
  // backend has enough confirmed closes — the owner confirms or corrects —
  // and blank categories when there is no signal (never an invented split).
  // `replace`: the boxes become exactly the sync's, emptied where the sync has
  // nothing — the owner chose the day's POS figures over what they had typed.
  const fillBoxesFromSync = (data, { replace = false } = {}) => {
    // The sync is not a till: the boxes no longer show the ledger.
    act(detachForm);
    boxesHoldPhotosRef.current = false;
    const payPrefill = data?.suggested_prefill?.payment_breakdown || {};
    if (Object.keys(payPrefill).length > 0) {
      const newPay = {};
      // Add any payment methods from data that aren't in the default list
      const existingKeys = new Set(defaultPayMethods.map(m => m.key));
      Object.entries(payPrefill).forEach(([k, v]) => {
        newPay[k] = asBox(v);
        if (!existingKeys.has(k) && k !== "other") {
          setPayMethods(prev => {
            if (prev.find(m => m.key === k)) return prev;
            return [...prev, { key: k, label: k.charAt(0).toUpperCase() + k.slice(1), icon: "Coins" }];
          });
        }
      });
      setPayAmounts(newPay);
      salesFillRef.current = { ...salesFillRef.current, pay: newPay };
    } else if (replace) {
      setPayAmounts({});
    }
    const salesTotal = data?.suggested_prefill?.revenue_total || 0;
    const split = data?.category_split;
    let nextRev = null;
    if (defaultRevCats.length === 1 || branchType === "general") {
      const firstCat = defaultRevCats[0]?.key;
      if (salesTotal > 0 && firstCat) nextRev = { [firstCat]: String(salesTotal) };
    } else if (split && split.categories && Object.keys(split.categories).length > 0) {
      nextRev = {};
      Object.entries(split.categories).forEach(([k, v]) => { nextRev[k] = asBox(v); });
    }
    if (nextRev) {
      setRevAmounts(nextRev);
      salesFillRef.current = { ...salesFillRef.current, rev: nextRev };
    } else if (replace) {
      setRevAmounts({});
    }
  };

  // The owner moves the date (the picker, "Nulstil til i dag"). Round 23 —
  // with figures on the form (typed, a Z-bon on the card, a count, tips, a
  // MOMS, gavekort) the move is ASKED FIRST, one question for every kind of
  // day: "Flyt tallene til {to}? Kladden for {from} slettes." Yes: the
  // figures are saved to the new day at once, then the old day's draft is
  // deleted on the version this form holds (finishMove) — "Flyttet fra" only
  // once it is gone, else "Kopieret til … — kladden for … står der stadig"
  // with "Slet den". No: the form stays on the old day with its figures.
  // "Hent {dag}s salg" (the new day has POS sales): the new day's own
  // figures instead — nothing moves. A day that already holds a close that
  // is not this form's is never moved onto: said, with History one tap away.
  // Untouched POS figures are the day's own and go with it (no question).
  const moveDate = async (next) => {
    if (!next) return;
    dateChosenRef.current = true;
    if (next === businessDate || moveBusyRef.current) return;
    const synced = salesFillRef.current;
    const owners = (boxes, fill) => Object.entries(boxes || {}).some(([k, v]) =>
      String(v ?? "").trim() !== "" && !(fill && fill[k] === v));
    // Not only sales: a drawer count, tips, a MOMS or gavekort typed for the
    // old day belong to it the same way.
    const filled = (v) => String(v ?? "").trim() !== "";
    const typedExtras = filled(drawerCount) || filled(cashCounted) || filled(tipsTotal)
      || filled(gavekortSold) || momsTyped;
    const figures = !editLoadedRef.current && (Boolean(cardView(ledgerRef.current))
      || owners(revAmounts, synced?.rev) || owners(payAmounts, synced?.pay) || typedExtras);
    const pending = moveFromRef.current;
    if (!figures) {
      // Nothing of the owner's goes with the date.
      moveFromRef.current = null;
      setMovedNote(null);
      act(dateMoved, next);
      setBusinessDate(next);
      return;
    }
    // (With the year when the two days are not in the same one: "8. oktober
    // 2025", never a question that reads like today's.)
    const sameYear = String(next).slice(0, 4) === String(businessDate).slice(0, 4);
    const dayName = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(),
      sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
    const curKey = `${businessDate}|${fileBranchId || ""}`;
    // The new day is filed under the branch picked at the top of the page (a
    // new day lets go of a branch the banner set — see the effect on
    // [businessDate, branchId]).
    const nextBranch = branchId || null;
    const branchPart = nextBranch || "";
    const nextKey = `${next}|${branchPart}`;
    // A close already filed for the new day that is not this form's own.
    const target = (existingClosesRef.current || []).find((dc) => String(dc.date || "").slice(0, 10) === next
      && (!branchId || (dc.branch_id || null) === nextBranch)
      && !dc.is_deleted && !droppedIdsRef.current.has(dc.id));
    const targetKey = target ? closeRowKey(target) : null;
    const targetOwn = Boolean(target) && (ownDraftKeys.has(targetKey) || Boolean(ownRowsRef.current[targetKey])
      || (pending?.keys || []).includes(targetKey));
    moveBusyRef.current = true;
    setMoveBusy(true);
    try {
      if (target && !targetOwn) {
        const locked = (target.status || "confirmed") === "confirmed";
        // A draft there: "Fortsæt kladden" is the one tap (round 23 review —
        // it was a detour through History). The figures on the form stay
        // with {from} (the save waiting for it goes first); nothing is moved
        // onto that draft. A locked day: opened from History.
        const ans = await askConfirm(locked ? {
          title: t("dcMoveTargetLockedTitle", "{to} is already closed and locked", { to: dayName(next) }),
          message: t("dcMoveTargetBody", "Your figures stay on {from} — nothing is moved. Open the {to} close from History, or pick another day.", {
            from: dayName(businessDate), to: dayName(next),
          }),
          confirmLabel: t("dcOpenHistory", "Open History"),
          cancelLabel: t("dcMoveConfirmNo", "Stay on {from}", { from: dayName(businessDate) }),
        } : {
          title: t("dcMoveTargetDraftTitle", "{to} already has a draft", { to: dayName(next) }),
          message: t("dcMoveTargetDraftBody", "Your figures stay on {from} — nothing is moved. Continue the {to} draft, or stay on {from}.", {
            from: dayName(businessDate), to: dayName(next),
          }),
          confirmLabel: t("dcContinueDraft", "Continue the draft"),
          cancelLabel: t("dcMoveConfirmNo", "Stay on {from}", { from: dayName(businessDate) }),
        });
        if (ans !== true || !mountedRef.current) return;
        if (locked) { onShowHistory?.(target.id); return; }
        flushWaitingSave();
        onContinueDraft?.(target);
        return;
      }
      // The new day's POS sales: "Hent {dag}s salg" is offered when it has
      // some — never over a card (the boxes under a bon's total).
      let sync = null;
      if (!cardView(ledgerRef.current) && !(typeof navigator !== "undefined" && navigator.onLine === false)) {
        try {
          const params = { date: next };
          if (nextBranch) params.branch_id = nextBranch;
          if (branchType) params.branch_type = branchType;
          const res = await api.get("/daily-close/prefill", { params, _noRetry: true, timeout: 6000 });
          const sp = res?.data?.suggested_prefill;
          if (res?.data?.has_data && (Object.keys(sp?.payment_breakdown || {}).length > 0 || Number(sp?.revenue_total) > 0)) sync = res.data;
          // Kept for the new day's own prefill read (never asked twice).
          if (res?.data && typeof res.data === "object") {
            movePrefetchRef.current = { date: next, branch: nextBranch, type: branchType || null, data: res.data, at: Date.now() };
          }
        } catch { /* not offered */ }
        if (!mountedRef.current) return;
      }
      // The days whose draft goes once the new day is filed: the one the
      // figures were typed for (and a day they passed through on the way,
      // moved again before it was filed) — never the day they go to.
      const keys = [...(pending?.keys || [])];
      const curHolds = Boolean(ownRowsRef.current[curKey] || lostSaveRef.current[curKey]
        || keyInflightRef.current[curKey]?.size || failedBodyRef.current[curKey]
        || pendingSaveRef.current?.key === curKey || ownDraftKeys.has(curKey));
      if (curHolds && !keys.includes(curKey)) keys.push(curKey);
      const goes = keys.filter((k) => k !== nextKey);
      const from = pending?.from && !String(nextKey).startsWith(`${pending.from}|`) ? pending.from : businessDate;
      const named = goes.map((k) => dayName(k.split("|")[0]));
      const listOf = (arr) => {
        try { return new Intl.ListFormat(dateLocale(), { style: "long", type: "conjunction" }).format(arr); } catch { return arr.join(", "); }
      };
      const to = dayName(next);
      // "1. augusts salg" / "1. marts' salg"; "1 August's sales".
      const toGen = dateLocale().startsWith("da") ? (/[sxz]$/i.test(to) ? `${to}'` : `${to}s`) : `${to}'s`;
      const ans = await askConfirm({
        title: t("dcMoveConfirmTitle", "Move the figures to {to}?", { to }),
        message: !named.length
          ? t("dcMoveConfirmBodyNothing", "Nothing is saved for {from} yet.", { from: dayName(businessDate) })
          : named.length === 1
            ? t("dcMoveConfirmBody", "The draft for {from} is deleted.", { from: named[0] })
            : t("dcMoveConfirmBodyMany", "The drafts for {days} are deleted.", { days: listOf(named) }),
        confirmLabel: t("dcMoveConfirmYes", "Move the figures"),
        cancelLabel: t("dcMoveConfirmNo", "Stay on {from}", { from: dayName(businessDate) }),
        extraLabel: sync ? t("dcDateMoveFetch", "Fetch {toGen} sales", { toGen }) : undefined,
      });
      if (!mountedRef.current) return;
      if (ans === true) {
        moveFromRef.current = goes.length ? { from, to: next, toKey: nextKey, keys: goes, epoch: formEpochRef.current } : null;
        // The figures are the new day's now: a draft of them that got no
        // answer on the old day is never sent there again.
        goes.forEach((k) => { delete failedBodyRef.current[k]; });
        // The new day is filed at once, not two seconds later — its answer
        // finishes the move.
        sendNowRef.current = true;
        setMovedNote(null);
        // The tills move with the date (closeTills.dateMoved never changes them).
        act(dateMoved, next);
        setBusinessDate(next);
      } else if (ans === "extra") {
        // The new day's own POS figures instead: nothing moves. The old day
        // keeps its draft (an edit still waiting for it is filed there
        // first), and its other typed figures stay with it — a MOMS typed for
        // 17.130 was saved as "indtastet" on a 1.850 day, a drawer count
        // against another day's register. The new day's sync fills the boxes.
        flushWaitingSave();
        act(resetTills);
        boxesHoldPhotosRef.current = false;
        salesFillRef.current = null;
        boxFillEpochRef.current += 1;
        setRevAmounts({});
        setPayAmounts({});
        setMomsMode("auto"); setMomsManual(""); setAppliedMoms(null);
        setDrawerCount(""); setCashCounted("");
        setTipsTotal(""); setGavekortSold("");
        setMovedNote(null);
        act(dateMoved, next);
        setBusinessDate(next);
      }
      // No: the form stays on the day the figures were typed for (and the
      // other day's prefill read is not kept).
      else movePrefetchRef.current = null;
    } finally {
      moveBusyRef.current = false;
      if (mountedRef.current) setMoveBusy(false);
    }
  };

  // Round 23 review — a date TYPED is asked about once it is the date the
  // owner means, not on every segment: a type=date input reports a value as
  // soon as one keystroke makes a valid date ("1" of "15" → the 1st; a year
  // typed reads 0002, 0020, 0202…), and the move's question popped after one
  // key, the field disabled under it. Typed (a key went down in the field):
  // the date is taken on Enter, on leaving the field, or once the typing has
  // paused; a pick from the calendar (no key) is taken at once, as before.
  // A date outside DATE_MIN … today is never taken.
  const [dateTyped, setDateTyped] = useState(null);
  const dateKeyRef = useRef(false);
  const dateTimerRef = useRef(null);
  const moveDateRef = useRef(moveDate);
  moveDateRef.current = moveDate;
  useEffect(() => () => clearTimeout(dateTimerRef.current), []);
  const takeDate = (v) => {
    clearTimeout(dateTimerRef.current);
    setDateTyped(null);
    if (!v || v < DATE_MIN || v > businessTodayIso(cutoffHour)) return;
    moveDateRef.current(v);
  };
  const onDateKeyDown = (e) => {
    if (e.key === "Enter") {
      if (dateTyped != null) { e.preventDefault(); takeDate(dateTyped); }
      return;
    }
    if (e.key !== "Tab") dateKeyRef.current = true;
  };
  const onDateChange = (e) => {
    const v = e.target.value;
    if (!dateKeyRef.current) { takeDate(v); return; }
    setDateTyped(v);
    clearTimeout(dateTimerRef.current);
    dateTimerRef.current = setTimeout(() => takeDate(v), DATE_TYPING_PAUSE_MS);
  };
  const onDateBlur = () => {
    dateKeyRef.current = false;
    if (dateTyped != null) takeDate(dateTyped);
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
    // Everything this effect derived belongs to the day (and branch) it was
    // fetched for. Changing the date kept the previous day's: the sync card
    // and the review's "Dagens udgifter" showed 26 Sep's −4.250 on a 1 Aug
    // with no expenses, and the register's cash, the POS variance and the
    // computed split followed the old day the same way. So it is cleared the
    // moment the key changes, before the new day's answer is in.
    let stale = false;
    setPrefill(null);
    setRegisterCash(null);
    setSplitMeta(null);
    setPrefillStatus("idle");
    const synced = salesFillRef.current;
    salesFillRef.current = null;
    if (synced) {
      // The old day's sales in the boxes, untouched since the sync put them
      // there: gone with the day. Typed figures are not touched.
      const unsync = (prev, fill) => {
        if (!fill) return prev;
        let changed = false;
        const next = { ...prev };
        Object.entries(fill).forEach(([k, v]) => {
          if (next[k] === v) { delete next[k]; changed = true; }
        });
        return changed ? next : prev;
      };
      setPayAmounts((prev) => unsync(prev, synced.pay));
      setRevAmounts((prev) => unsync(prev, synced.rev));
    }
    // The other half: the new day's sync writes only into a form that holds
    // nothing but the old sync's own figures (taken out above) or nothing at
    // all. A Z-bon applied, a draft loaded or a figure typed — before this
    // request, or while it is on its way — is the owner's, and stays. Moving
    // the date onto a sales day replaced a Z-bon's Mad 9.000 / Kort 12.000
    // with the POS's 1.100 / 1.250, under the bon's 17.030 total, and the
    // kasserapport then called every line an owner correction.
    const ownBox = (boxes, fill) => Object.entries(boxes || {}).some(([k, v]) =>
      String(v ?? "").trim() !== "" && !(fill && fill[k] === v));
    const boxesTaken = ownBox(revAmounts, synced?.rev) || ownBox(payAmounts, synced?.pay);
    const fillEpoch = boxFillEpochRef.current;
    const fetchPrefill = async () => {
      setPrefillLoading(true);
      try {
        const today = businessDate;
        const params = { date: today };
        // The branch the close is filed under (a close opened from History
        // keeps its own), so its sales are the ones compared.
        if (fileBranchId) params.branch_id = fileBranchId;
        // branch_type lets the backend resolve THIS vertical's revenue category
        // keys for the computed split (restaurant food/drinks/takeaway, etc.).
        if (branchType) params.branch_type = branchType;
        // The move's question already read this day's prefill (round 23 —
        // "Hent {dag}s salg" is offered only when there are sales): that
        // answer is used, not asked for twice.
        const pre = movePrefetchRef.current;
        movePrefetchRef.current = null;
        const res = pre && pre.date === today && pre.branch === (fileBranchId || null) && pre.type === (branchType || null)
          && Date.now() - pre.at < 60000
          ? { data: pre.data }
          : await api.get("/daily-close/prefill", { params });
        // The owner has moved on (another date or branch) while this was in
        // flight: an older answer landing after a newer one must not write the
        // day the owner left over the day they are on.
        if (stale) return;
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
          // The computed split's hint and "Nulstil til beregnet fordeling"
          // follow the day's answer, not whether the boxes could be filled:
          // inside the fill gate below they vanished on every day whose boxes
          // already held the owner's or a Z-bon's figures. Not on an edited
          // close (as before): its own split is the saved one.
          if (!editLoadedRef.current) setSplitMeta(splitMetaFrom(res.data));
          // Auto-fill payment methods + revenue from sales data — but ONLY
          // for a brand-new close. When the owner unlocked + is editing an
          // existing close (editLoadedRef), this sales-sync would clobber the
          // saved breakdown (e.g. cash 400/card 500/mp 170 → card 1850), so
          // we skip the writes. `prefill` is still set above so the
          // informational sync banner + expenses summary keep rendering.
          if (!editLoadedRef.current && !boxesTaken && boxFillEpochRef.current === fillEpoch) {
            fillBoxesFromSync(res.data);
          }
        }
        setPrefillStatus("ok");
      } catch {
        // A failure for a day the owner has already left says nothing about
        // the day they are on.
        if (stale) return;
        // Manual entry still works — but say so. Failing closed and QUIET
        // meant the POS cross-check just wasn't there, which looks identical
        // to "this date had no sales".
        setPrefillStatus("failed");
      }
      setPrefillLoading(false);
    };
    fetchPrefill();
    return () => { stale = true; };
  // The boxes are read as they stand when the day changes; they are not a key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileBranchId, branchType, businessDate]);

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
  // The revenue this close will SAVE: an owner-typed total when there is one
  // (the backend saves exactly that), else the category sum. MOMS followed
  // the category sum — a close corrected from 16.540 to 16.450 kept the
  // 16.540 MOMS.
  // Mirrors the server exactly: the owner's typed total, else the larger of
  // the category sum and the scanned total. A partly read Z-bon (Mad 10.000,
  // total 17.030) saved 17.030 while MOMS and the day check ran on 10.000.
  // With tills in the day it is the ledger's figure — what each till saves,
  // added up (closeTills.savedTotal): a category raised past one till's bon
  // counts for that till, and comes back out when it is lowered. The boxes
  // show the same tills' lines, so the review, the card and the payload read
  // one number. With no card (a close typed by hand) it is the categories.
  // Boxes the sales sync filled while a card is in the day (a total-only bon
  // applied, then the date moved onto a synced day) are not the tills' lines:
  // the server saves the larger of them and the tills' figure, and so does
  // the review (it showed the bon's 4.000 while 5.000 was saved). A total the
  // owner typed is the figure either way.
  // (One function of the ledger and the boxes' own revenue: Start forfra asks
  // it of the ledger it leaves, before the boxes show that ledger.)
  const savedRevenueOf = (lg, boxesRevenue) => {
    const card = cardView(lg);
    if (!card) return Math.max(0, boxesRevenue);
    if (lg.mirror) return savedTotal(lg);
    if (String(card.revenue_total_text ?? "").trim() !== "") return savedTotal(lg);
    return Math.max(savedTotal(lg), boxesRevenue);
  };
  const savedRevenue = useMemo(() => savedRevenueOf(ledger, revenueTotal), [ledger, revenueTotal]);
  // A total read off the Z-bon IS revenue, split by category or not: a
  // total-only read said "can't be checked" while it locked 17.030.
  const revenueKnown = hasRevenueEntry || savedRevenue > 0;
  // Saved total minus the category lines: the part nobody split (a partly
  // read Z-bon), or a hand-corrected total below the lines (negative).
  const unsplitRevenue = Math.round((savedRevenue - revenueTotal) * 100) / 100;
  const tieOut = useMemo(() => {
    if (!revenueKnown || !hasPaymentEntry) return { state: "unknown", diff: null };
    const diff = savedRevenue - paymentTotal;
    // Under 1 kr is rounding, not a discrepancy — same threshold the
    // payments step has always used, now defined once.
    return { state: Math.abs(diff) < 1 ? "balanced" : "off", diff };
  }, [revenueKnown, hasPaymentEntry, savedRevenue, paymentTotal]);
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
  // An unreadable count is no count: it showed "0 kr." takings, a −2.000
  // difference and the >100 kr. warning beside "Vi kan ikke læse beløbet".
  const cashCountReadable = String(cashCounted ?? "").trim() !== "" && !isMoneyRejected(cashCounted, mLocale);
  // Against an expected figure only — the server's rule (no expected cash, no
  // cash_difference). With no cash sale anywhere the step showed "3.500 kr.
  // for meget i kassen" against a fallback 0, and the record stored none.
  const cashDiff = cashCountReadable && hasCashBaseline ? Math.round((cashCountedVal - cashExpected) * 100) / 100 : null;
  const cashNoBaseline = cashCountReadable && !hasCashBaseline;
  // Whole kroner at a glance — but a figure with øre shows them, or the step
  // says −50 while the review and the kasserapport say −50,25.
  const oreIfAny = (v) => (Number.isFinite(v) && Math.abs(v - Math.round(v)) > 0.004 ? LEDGER_DECIMALS : GLANCE_DECIMALS);
  // One precision for figures shown as a pair: øre on all of them when any
  // has øre — "17.130 kr." sat over "Ikke fordelt 17.130,00 kr.".
  const pairDecimals = (...vs) => (vs.some((v) => oreIfAny(v) === LEDGER_DECIMALS) ? LEDGER_DECIMALS : GLANCE_DECIMALS);
  // The cash difference in words, so its sign can't be read the wrong way.
  const cashDirection = (diff, decimals = oreIfAny(diff)) => {
    if (Math.abs(diff) < 0.005) return t("dcCashMatches", "The drawer matches");
    const amount = formatOwnerMoney(Math.abs(diff), currency, { decimals });
    return diff < 0
      ? t("dcCashShortBy", "The drawer is {amount} short", { amount })
      : t("dcCashOverBy", "The drawer is {amount} over", { amount });
  };
  // staffCount stays parseInt: it is a HEAD COUNT, not money. tipsTotal is
  // money and reads strictly, so an unreadable tips box yields no per-person
  // figure at all rather than a confident wrong one.
  // Scan lines that already add up to the total are complete: an empty
  // category was 0 that night, not "missing".
  const scanTotalNow = scanResult ? (headlineTotal(scanResult, mLocale) || 0) : 0;
  // The total the scan card SAVES (its total box shows it): a typed total, or
  // the larger of the printed total and the card's lines (closeSaveTotal).
  const cardSaveTotal = !scanResult ? 0 : ledgerSaved;
  // The owner's own till (a typed close, a reopened draft) is in the day: its
  // lines are theirs, never "found on this bon" and never "missing" from it.
  const cardOwnTill = useMemo(() => Boolean(formTill(ledger)), [ledger]);
  // Every category the card carries — a custom one ("Catering") the owner's
  // till brought in too — so its lines add up to the total it saves.
  const cardRevCats = useMemo(() => {
    const extra = Object.entries(scanResult?.revenue || {})
      .filter(([k, v]) => !TOTAL_KEYS.includes(k) && !defaultRevCats.some((c) => c.key === k)
        && v != null && String(v).trim() !== "")
      .map(([k]) => revCats.find((c) => c.key === k)
        || { key: k, label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "), icon: "Tag" });
    return extra.length ? [...defaultRevCats, ...extra] : defaultRevCats;
  }, [scanResult, defaultRevCats, revCats]);
  const cardUnsplit = !scanResult ? 0 : Math.round((cardSaveTotal - Object.entries(scanResult.revenue || {})
    .filter(([k]) => !TOTAL_KEYS.includes(k)).reduce((a, [, v]) => a + readMoney0(v), 0)) * 100) / 100;
  const scanLinesAddUp = (bucket, lines, total = scanTotalNow) => total > 0
    && Math.abs(lines.reduce((a, c) => a + readMoney0(bucket?.[c.key]), 0) - total) < 1;
  // The categories against the printed total (lines that add up to it ARE
  // the split); the payments against the total the box shows and the day
  // saves — they passed as complete at 17.030 beside a box reading 17.530.
  const scanRevComplete = scanLinesAddUp(scanResult?.revenue, defaultRevCats);
  const scanPayTotal = cardSaveTotal > 0 ? cardSaveTotal : scanTotalNow;
  const scanPayComplete = scanLinesAddUp(scanResult?.payments, defaultPayMethods, scanPayTotal);
  const scanPaySum = defaultPayMethods.reduce((a, m) => a + readMoney0(scanResult?.payments?.[m.key]), 0);
  const tipsPP = tipsTotal && staffCount && parseInt(staffCount) > 0
    && Number.isFinite(readMoney(tipsTotal))
    ? Math.round((readMoney(tipsTotal) * 100) / parseInt(staffCount)) / 100 : null;

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
        if (fileBranchId) params.branch_id = fileBranchId;
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
    // The day before's MOMS-free total must not shape this day's MOMS while
    // this day's answer is on its way.
    setExemptSalesTotal(0);
    setExemptStatus("loading");
    fetchExempt();
    return () => { cancelled = true; };
  }, [businessDate, fileBranchId, cutoffHour]);

  // MOMS / VAT — toggle between auto-calc and manual entry from receipt
  const [momsMode, setMomsMode] = useState("auto"); // "auto" | "manual"
  const [momsManual, setMomsManual] = useState("");
  // The owner's own MOMS: "Fra kvittering" holding a figure that reads. An
  // empty box is NOT a typed 0 — nobody has typed yet. The review printed
  // "MOMS (fra bon) 0,00" over an empty box while the payload sent null and
  // the server saved its own 3.426, labelled manual. One rule for the review,
  // its label, the scan card and the payload: until a figure is typed, the
  // MOMS is the scanned or worked-out one, shown and saved as what it is.
  const momsTyped = momsMode === "manual" && Number.isFinite(readMoney(momsManual));

  // Any money box on the page holding text that is not an amount. This is the
  // save gate: a close writes to the ledger and prints a kasserapport, so it
  // must not go out while one of its figures is a question mark. Each field
  // shows its own refusal; this is what stops the button.
  //
  // Declared HERE rather than beside the totals above because momsManual is
  // declared on the line above it — reading it earlier would be a TDZ
  // ReferenceError at render, not a lint warning.
  // A drawer can't hold minus 50 kr. — a negative count is a typo, not a fact.
  const cashCountedNegative = useMemo(() => {
    const n = parseMoneyInput(cashCounted, mLocale);
    return Number.isFinite(n) && n < 0;
  }, [cashCounted, mLocale]);
  const moneyRejected = useMemo(
    () => cashCountedNegative || scanTotalEmptied ||
      [
        ...Object.values(revAmounts),
        ...Object.values(payAmounts),
        cashCounted,
        tipsTotal,
        gavekortSold,
        momsMode === "manual" ? momsManual : "",
        scanResult?.revenue_total_text ?? "",
      ].some((v) => isMoneyRejected(v, mLocale)),
    [cashCountedNegative, scanTotalEmptied, revAmounts, payAmounts, cashCounted, tipsTotal, gavekortSold, momsManual, momsMode, mLocale, scanResult],
  );

  // WHICH group holds it. The lock button sits on the review step, three
  // screens past the box that refused — so "one amount can't be read" with no
  // location is a dead end at 22:30. The field still says so in place; this
  // says where in place IS. Order matches the wizard, so the first hit is the
  // earliest step the owner has to go back to.
  const rejectedArea = useMemo(() => {
    const groups = [
      ["revenue", [...Object.values(revAmounts), scanResult?.revenue_total_text ?? ""]],
      ["payments", Object.values(payAmounts)],
      ["cash", [cashCounted]],
      ["tips", [tipsTotal]],
      ["gavekort", [gavekortSold]],
      ["moms", [momsMode === "manual" ? momsManual : ""]],
    ];
    for (const [name, values] of groups) {
      if (name === "revenue" && scanTotalEmptied) return name;
      if (name === "cash" && cashCountedNegative) return name;
      if (values.some((v) => isMoneyRejected(v, mLocale))) return name;
    }
    return null;
  }, [cashCountedNegative, scanTotalEmptied, revAmounts, payAmounts, cashCounted, tipsTotal, gavekortSold, momsManual, momsMode, mLocale, scanResult]);
  // The lock is held by the count against the float alone (every amount
  // reads fine): its own reason, never "kan ikke læses".
  const belowFloatBlocks = rejectedArea === "cash" && cashCountedNegative
    && !isMoneyRejected(drawerCount, mLocale) && !isMoneyRejected(cashFloat, mLocale)
    && stepSequence.includes("cash");

  // Taxable base = entered revenue MINUS today's exempt sales total.
  // Clamp at 0: if the user only entered a placeholder and the exempt
  // total exceeds it, we'd otherwise show a negative MOMS amount which
  // confuses the owner more than a zero.
  const taxableBase = useMemo(() => {
    return Math.max(0, Math.round((savedRevenue - exemptSalesTotal) * 100) / 100);
  }, [savedRevenue, exemptSalesTotal]);

  // The day's MOMS by ONE rule, read off the tills (closeTills.momsOf): the
  // tills' own MOMS added up when EVERY till's MOMS is known — the owner's
  // typed MOMS on their own till, or a bon's MOMS that still belongs to the
  // total that till saves — else worked out from the saved total. A
  // corrected total, a category raised past the bon, one till of two, or a
  // page whose MOMS belongs to no total anybody read: worked out, and said.
  const ledgerMoms = useMemo(() => momsOf(ledger), [ledger]);
  // The tills' figure is the day's — or boxes the sales sync filled over a
  // card raised it, and a bon's MOMS then belongs to another total.
  const tillsAreTheDay = !scanResult || Math.abs(savedRevenue - ledgerSaved) < 0.005;
  const momsFor = (total) => {
    const base = Math.max(0, Math.round((total - exemptSalesTotal) * 100) / 100);
    return base > 0 && vatRate > 0 ? Math.round((base * vatRate / vatDivisor) * 100) / 100 : 0;
  };

  const momsTotal = useMemo(() => {
    if (momsTyped) return readMoney0(momsManual);
    // Same rule as applyScanValues: a scanned MOMS that covers one of two
    // summed tills is not "the MOMS from the receipt". Without this, flipping
    // the toggle back to Auto did NOT recover — this branch returned the
    // one-till figure while the UI printed "Auto-calculated: Revenue × 25% /
    // 125%", a computation that had not happened. A corrected total (or a
    // category raised past the bon's total) makes it stale the same way.
    const scannedMoms = ledgerMoms.source === "zbon" && ledgerMoms.value > 0 && tillsAreTheDay ? ledgerMoms.value : null;
    if (scannedMoms) return scannedMoms;
    return taxableBase > 0 && vatRate > 0 ? Math.round((taxableBase * vatRate / vatDivisor) * 100) / 100 : 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [momsTyped, momsManual, ledgerMoms, taxableBase, tillsAreTheDay]);

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
  // "recomputed": the bon had a MOMS, but for another total — said in words.
  const momsSource = useMemo(() => {
    if (momsTyped) return "manual";
    const scannedMoms = ledgerMoms.source === "zbon" && ledgerMoms.value > 0 && tillsAreTheDay ? ledgerMoms.value : null;
    if (!scannedMoms && (ledgerMoms.recomputed || (ledgerMoms.source === "zbon" && !tillsAreTheDay))) return "recomputed";
    return scannedMoms ? "scanned" : "computed";
  }, [momsTyped, ledgerMoms, tillsAreTheDay]);
  const revenueExMoms = useMemo(() => Math.round((savedRevenue - momsTotal) * 100) / 100, [savedRevenue, momsTotal]);

  // The bon's MOMS put in as "Fra kvittering" follows the total once the total
  // moves off the bon's: a category corrected by hand after a full read kept
  // 3.406 under 17.130, and Auto gave the same 3.406. A MOMS the owner typed
  // is theirs and stays.
  const savedRevenueSeenRef = useRef(savedRevenue);
  // The reopened draft's MOMS still in the box, under a total that moved off
  // the one it was saved with.
  const draftMomsMoved = Boolean(draftMoms) && Math.abs(savedRevenue - draftMoms.total) >= 0.005;
  const draftMomsKept = draftMomsMoved && momsTyped
    && Math.abs(readMoney0(momsManual) - draftMoms.moms) < 0.015;
  useEffect(() => {
    const moved = Math.abs(savedRevenueSeenRef.current - savedRevenue) >= 0.005;
    savedRevenueSeenRef.current = savedRevenue;
    if (!moved || momsMode !== "manual") return;
    if ((ledgerMoms.source === "auto" && ledgerMoms.recomputed) || (ledgerMoms.source === "zbon" && !tillsAreTheDay)) {
      if (Math.abs(readMoney0(momsManual) - Number(scanResult.moms_total)) < 0.005) {
        setMomsMode("auto");
        setMomsManual("");
      }
      return;
    }
    // After a reopen nobody knows whether the saved MOMS came off the bon or
    // was typed. It follows only when it was the plain one-rate MOMS of the
    // total it was saved with — what Auto gives, so nothing the owner typed is
    // lost. Any other figure stays theirs, and the review says it belongs to
    // the old total.
    if (draftMomsKept && Math.abs(momsFor(draftMoms.total) - draftMoms.moms) < 0.015) {
      setMomsMode("auto");
      setMomsManual("");
      setDraftMoms({ ...draftMoms, followed: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedRevenue]);

  const addCustomRevCat = () => {
    if (!customRevName.trim()) return;
    const key = customRevName.toLowerCase().replace(/\s+/g, "_");
    // "Mad" typed as a custom category is the built-in Mad, not a second one.
    const typed = customRevName.trim().toLowerCase();
    const same = revCats.find(c => c.key === key || String(catLabel(t, c) || "").trim().toLowerCase() === typed);
    if (!same) {
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
    // What the tills save, added up (the ledger) — the figure the review
    // shows. The server's max(breakdown, override) then saves exactly it: a
    // till's categories raised past its bon count for that till, and lowering
    // them again takes it back out.
    // On a day of several tills it is sent whatever the card's box holds:
    // an emptied total left the tills' 21.030 in the review while the server
    // saved the categories' 17.030 (with the 21.030's MOMS).
    // And whenever the boxes do not show the tills (filled by the sales sync):
    // the server's max(boxes, tills) is then the figure the review shows.
    const revenue_total_override = (ocrTotal && ocrTotal > 0) || (scanResult && severalTills && ledgerSaved > 0)
      || (scanResult && !ledger.mirror && ledgerSaved > 0)
      ? ledgerSaved : null;
    // Only override when the user actually scanned with the toggle —
    // otherwise leave null and let the user's account-level
    // prices_include_moms preference apply.
    // The empty scan card's own save (Start forfra, the owner's till alone)
    // sends what the same form sends past it.
    const prices_include_moms_override = scanMode === "skipped" || scanMode === "result" || scanMode === "idle"
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

    // Where the figures came from, for the revisor's kasserapport — read off
    // the tills (closeTills.sourceMetaOf): read off a Z-bon (and the tills
    // added together), typed, and which lines the owner changed after a
    // photo. A typed till is never a Z-bon read: it is listed in typed_tills,
    // its own lines in `typed`. A reopened draft with no new photo sends
    // nothing, so the server keeps what it already knows.
    // The day this payload files. With no photo left in it, a day this form
    // filed a photo's source for is told again what it is (`restore`): the
    // reopened draft's own source, or typed — null would keep the Z-bon.
    const dayKey = `${businessDate}|${fileBranchId || ""}`;
    const source_meta = sourceMetaOf(ledger, {
      revenue_breakdown,
      payment_breakdown,
      momsTyped,
      // The MOMS typed, held against the one a reopened Z-bon read was
      // opened with: changed, it is the owner's — never "aflæst fra Z-bon".
      momsValue: momsTyped ? readMoney0(momsManual) : null,
      tipsSaved: Boolean(tipsTotal && Number.isFinite(readMoney(tipsTotal))),
      photo: receiptPhotoUrl,
      restore: filedScanKeysRef.current.has(dayKey),
      afterUnlock: loadedUnlockedRef.current,
    });
    // The photo: the day's own (the first photo still in it, or the reopened
    // close's), else none. A null keeps whatever the server holds, so when it
    // holds a photo of no bon in the day any more (thrown away with Fortryd,
    // "brug det ikke") it is cleared explicitly with "" — that photo only.
    // One this form never filed is another device's (a bon scanned there
    // since): "" sent for any stored photo, or for a day this form had once
    // cleared, threw it away.
    const storedPhoto = serverSrcRef.current[dayKey]
      ? serverSrcRef.current[dayKey].photo
      : ((existingCloses || []).find((dc) => closeRowKey(dc) === dayKey && !dc.is_deleted && !droppedIds.has(dc.id))?.receipt_photo || null);
    const photoIsOurs = Boolean(storedPhoto) && filedPhotosRef.current.has(storedPhoto);
    const receipt_photo = receiptPhotoUrl || (photoIsOurs ? "" : null);
    // A drawer counted below its float is no count of the day's takings (it
    // holds the lock until the count or the float is fixed): the draft does
    // not file "Optalt −300" as if counted — the drawer typed stays in the box.
    const countedNum = cashCounted && Number.isFinite(readMoney(cashCounted)) && readMoney(cashCounted) >= 0 ? readMoney(cashCounted) : null;

    const body = {
      date: businessDate,
      branch_id: fileBranchId,
      status,
      revenue_breakdown,
      payment_breakdown,
      // A typed figure goes as typed — 0 included (`|| null` nulled it, and
      // the server put its own figure under the owner's "0,00"). The bon's own
      // MOMS (still fitting the total, box emptied or Auto tapped) goes as the
      // bon's, the way applying the scan sends it: "manual" with source_meta
      // "zbon" is what the kasserapport prints "fra Z-bon" and the server keeps
      // as is. Sent as "auto" it was labelled "beregnet af BonBox", and the
      // server's stale-auto rule could swap 2.906 for 3.406. Anything else
      // goes as the auto figure it is: never "manual" over a number nobody
      // typed or read, which the kasserapport would print as "indtastet".
      // The auto figure goes too — 0 included — whenever there is revenue:
      // on a day whose MOMS-free sales cover the close the review said MOMS
      // 0,00 while `|| null` let the server work out 25/125 of the revenue
      // (150 kr. on 750). The server keeps that 0 only when its own MOMS-free
      // sales for the day say the same.
      moms_total: momsTyped ? momsTotal : (savedRevenue > 0 ? momsTotal : (momsTotal || null)),
      moms_mode: (momsTyped || momsSource === "scanned") ? "manual" : "auto",
      tips_total: tipsTotal && Number.isFinite(readMoney(tipsTotal)) ? readMoney(tipsTotal) : null,
      tips_staff_count: staffCount ? parseInt(staffCount) : null,
      cash_counted: countedNum,
      // The byttepenge taken off the drawer count — so the kasserapport can
      // show "Optalt (uden byttepenge)" the way this screen does.
      // Informational only (printed on the kasserapport). Out of range — a
      // stray "-500" or a mistyped huge float — is not sent at all, so it can
      // never fail the lock.
      cash_float: (() => {
        if (countedNum == null) return null;
        const f = readMoney0(cashFloat);
        return Number.isFinite(f) && f >= 0 && f <= 1_000_000 ? f : null;
      })(),
      source_meta,
      closed_by: closedBy ? closedBy.slice(0, CLOSED_BY_MAX) : null,
      // A scan appends to the notes (and the extras above add more), past the
      // textarea's maxLength — keep the payload inside the server's limit.
      notes: notesWithExtras ? notesWithExtras.slice(0, NOTES_MAX) : null,
      // Phase A forward-compat fields — the backend ignores unknown keys today
      // (Pydantic v2 default), so these are safe to send and become available
      // the moment DailyCloseCreate grows columns. Gavekort is deliberately a
      // SEPARATE field, never merged into revenue_breakdown (which feeds MOMS).
      gift_cards_sold: gavekortNum > 0 ? gavekortNum : null,
      batch_ref: (config.hasBatch && batchRef.trim()) ? batchRef.trim() : null,
      // Z-report photo URL — backend stores on DailyClose.receipt_photo.
      // Only sent if the owner actually scanned a photo this session;
      // null preserves the existing value on update (server-side guard), and
      // "" clears a stored photo of a bon that is no longer in the day.
      receipt_photo,
      // Total-only fallback (banner-driven) and per-close MOMS-mode
      // override. Both are accepted by the backend in DailyCloseCreate.
      revenue_total_override,
      // The owner corrected the scanned total by hand → it is the figure.
      // So is the tills' figure whenever the boxes show the tills and it is
      // below their lines: the server's max(lines, total) saved 16.800 under
      // a review of 12.000.
      revenue_total_owner_set: revenue_total_override != null && (Boolean(scanResult?.revenue_total_text)
        || (ledger.mirror && revenue_total_override < Object.values(revenue_breakdown).reduce((a, v) => a + v, 0) - 0.005)),
      prices_include_moms_override,
      // Tax-exempt total for the day. Pydantic schemas/daily_close.py
      // does NOT accept this field yet — sending it is forward-compat
      // for when the audit row + MOMS PDF want to display the split.
      // Until the schema is extended, FastAPI ignores unknown fields
      // (Pydantic v2 default), so this is safe to send today.
      exempt_sales_total: exemptSalesTotal || null,
    };
    payloadInfo.set(body, {
      key: dayKey,
      // Read off photos still in the day: once filed, a Start forfra that
      // leaves none has to say the source again. So does a reopened Z-bon
      // read filed with a hand correction: put back to what it was opened
      // with, a null kept the stored "rettet af ejeren: Mad" for a Mad no
      // longer changed — told again, its corrections are what they are now.
      scanSource: source_meta?.kind === "zbon",
    });
    return body;
  };

  // Draft auto-save — fires on step change (silent, no loading state)
  const [draftSaved, setDraftSaved] = useState(false);
  // A save is waiting or on its way: the step slot says "Gemmer…" until the
  // server has answered, so "Gemt" only ever means saved.
  const [draftSavingState, setDraftSavingState] = useState(false);
  const draftSaving = draftSavingState;
  // Set only when it changes: the autosave effect said "nothing to save" on
  // every keystroke on the scan card, and each setState(false) over a false
  // still cost a (bail-out) render of this whole form.
  const draftSavingRef = useRef(false);
  const setDraftSaving = (v) => {
    if (draftSavingRef.current === v) return;
    draftSavingRef.current = v;
    setDraftSavingState(v);
  };
  const autoSaveRef = useRef(null);
  // The latest render's payload builder. The 2 s timer (and the flush on
  // leaving) was set in a render that could still hold the old day's MOMS-free
  // total: a date move posted 1 Jun's draft with 25 Sep's 5.000 subtracted
  // (MOMS 2.426 saved, 3.426 on the review). The save sends what the form
  // holds when it goes.
  const buildPayloadRef = useRef(buildPayload);
  buildPayloadRef.current = buildPayload;
  // The save the 2 s debounce is holding. Leaving the form (another tab,
  // another page, the phone locked) CANCELLED it, so an edit made just before
  // leaving never reached the server. Leaving now sends it instead.
  const pendingSaveRef = useRef(null);
  const savesInFlightRef = useRef(0);
  // A save still waiting on the form goes now — before the scan card takes
  // over (a waiting timer is cancelled there, and the edit typed just before
  // the tap was never saved).
  const flushWaitingSave = () => {
    const waiting = pendingSaveRef.current;
    if (!waiting) return;
    clearTimeout(autoSaveRef.current);
    waiting();
  };
  // A reopened close as it was opened (its fields, and its ledger): nothing
  // is saved until the owner changes something. Once they have, every change
  // is saved — a change back to the opened figures too.
  const editBaselineRef = useRef(null);
  const editOpenLedgerRef = useRef(null);
  // The draft (as JSON) the last autosave sent: the same one is not sent again.
  const lastSentRef = useRef(null);
  // "The server told us this exact row is locked." NOT a guess from page state.
  //
  // The obvious guard here is a `dayLocked` prop fed from the page's
  // `isLockedToday`, and it is wrong three ways: that flag is derived from
  // `findConfirmedCloseFor(history, todayIso)` so it only knows about TODAY,
  // while this form posts `businessDate`, which the owner can point at an
  // earlier day; it is not scoped to `branchId`, so locking one branch would
  // mute auto-save for every other branch; and it would stay true after a
  // legitimate unlock until history happened to refresh, killing auto-save in
  // the very flow the unlock exists to enable.
  //
  // The server already knows the answer for the actual (branch, date) row and
  // now answers 409. So ask it, believe it, and forget it the moment the
  // target row changes.
  const [lockedRowRejected, setLockedRowRejected] = useState(false);
  // A deleted, LOCKED kasserapport holds this (branch, day): the server keeps
  // it (bogføringsloven) and refuses the day (423 deleted_locked_close). Not
  // the lock above — nothing is in the books, History lists nothing to
  // unlock — so the owner is told so, with the server's own words, and the
  // autosave stops knocking. Holds the server's text ("" when it gave none).
  const [deletedLockedRow, setDeletedLockedRow] = useState(null);
  useEffect(() => {
    setLockedRowRejected(false);
    setDeletedLockedRow(null);
  }, [businessDate, fileBranchId]);

  // A close already filed for the chosen day. A fresh close typed over a
  // draft replaced it two seconds later without a word (a Catering line, a
  // cash count and a staff count gone), and a locked day only said so at the
  // final tap, as "check your connection". Ask first — and never count the
  // draft this form itself just saved.
  const rowKey = `${businessDate}|${fileBranchId || ""}`;
  // A new day or another branch picked: the form follows the picker again.
  useEffect(() => {
    if (!editingDate) setFileBranchOverride(undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessDate, branchId]);
  // Every day (and branch) this form has saved a draft for — not only the
  // last one answered. Two days' saves in flight answer in any order: today's
  // slow answer landing after yesterday's made yesterday's own new draft
  // "a draft already filed for this day", the banner covered the owner's own
  // figures and the autosave stopped (the next edit was never saved).
  const [ownDraftKeys, setOwnDraftKeys] = useState(() => new Set());
  rowKeyRef.current = rowKey;
  const existingForDate = useMemo(() => {
    // Locked on another device while this form had the day open (a save of
    // it met the lock — round 22): the day is a locked day here too, even a
    // draft this form saved or is continuing. Its amount once History lists
    // the locked row; until then none is named (never "Låst med 0 kr.").
    if (lockedRowRejected) {
      return (existingCloses || []).find((dc) => closeRowKey(dc) === rowKey && !dc.is_deleted
        && (dc.status || "confirmed") === "confirmed")
        || { date: businessDate, branch_id: fileBranchId || null, status: "confirmed", revenue_total: null };
    }
    if (editingDate || ownDraftKeys.has(rowKey)) return null;
    const fresh = (dc) => {
      const o = rowOverrides[dc.id];
      return o && o.listed === existingCloses ? { ...dc, ...o.row } : dc;
    };
    return (existingCloses || []).map(fresh).find((dc) =>
      String(dc.date || "").slice(0, 10) === businessDate
      // "All branches" picked: any branch's close for the day is the one
      // the owner means. The strict compare missed it, and typing then saved
      // a second close for that day with no branch.
      && (!branchId || (dc.branch_id || null) === fileBranchId)
      // A draft this form deleted is gone, whatever History still lists.
      && !dc.is_deleted && !droppedIds.has(dc.id)) || null;
  }, [existingCloses, businessDate, branchId, fileBranchId, editingDate, ownDraftKeys, rowKey, droppedIds, rowOverrides, lockedRowRejected]);

  // The removal audit's B2, restored: a draft this form filed that is gone
  // from History (deleted in another tab or on another phone) is filed
  // again by the next change or step — "the same draft as last sent" kept
  // the figures on screen off every server, and leaving lost them.
  useEffect(() => {
    if (!lastSentRef.current || !ownDraftKeys.has(rowKey)) return;
    const there = (existingCloses || []).some((dc) => closeRowKey(dc) === rowKey && !dc.is_deleted);
    if (!there) lastSentRef.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingCloses]);

  // Every save still on its way has answered (a draft is deleted only then:
  // a save landing after the delete filed the day again).
  const savesSettled = async () => {
    while (inflightRef.current.size) await Promise.allSettled([...inflightRef.current]);
  };
  // What a save answered: the row's id and the row as stored, and the source
  // and photo the server now holds for the day.
  const noteSaved = (key, body, res) => {
    const data = res?.data && typeof res.data === "object" ? res.data : {};
    const prev = serverSrcRef.current[key] || {};
    serverSrcRef.current[key] = {
      meta: "source_meta" in data ? (data.source_meta ?? null) : (body.source_meta != null ? body.source_meta : (prev.meta ?? null)),
      photo: "receipt_photo" in data ? (data.receipt_photo || null)
        : (body.receipt_photo === "" ? null : (body.receipt_photo || prev.photo || null)),
    };
    if (payloadInfo.get(body)?.scanSource) filedScanKeysRef.current.add(key);
    // A photo of this session filed (not the reopened close's own, sent back
    // as it was): if no photo is left in the day later, it goes.
    if (body.receipt_photo && body.receipt_photo !== loadedPhotoRef.current) {
      filedPhotosRef.current.add(body.receipt_photo);
    }
    // The version the server stored: the next save is built on it.
    noteStamp(key, data.updated_at);
    const own = ownRowsRef.current[key];
    const id = data.id ?? own?.id ?? null;
    // The row as stored (its total — or payments — is what Start forfra's
    // question names); a save answered with no row keeps the one before.
    const row = data.id != null ? data : (own?.row || null);
    ownRowsRef.current[key] = { id, row };
    // The row lives (again): a draft deleted earlier this session is filed
    // anew under the same id (the server takes the deleted row back).
    if (id != null) {
      setDroppedIds((p) => { if (!p.has(id)) return p; const n = new Set(p); n.delete(id); return n; });
      setRowOverrides((p) => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n; });
    }
  };
  /**
   * A save of the form's met draft_changed: the day's draft was saved
   * somewhere else after the version the save was built on, and nothing was
   * written. When that newer version is one of the form's OWN saves (two of
   * its saves crossed), the save goes again on it. Otherwise the owner is
   * asked — the newest draft, or theirs — never in silence: when the form is
   * gone (the page was left), the change is kept on this device as a failed
   * copy ("Ikke gemt endnu") with the newer version's stamp.
   */
  const draftRefused = async (key, body, err, tracker = null, via = "draft", runNo = null) => {
    const d = err?.response?.data?.detail || {};
    const current = d.current && typeof d.current === "object" ? d.current : null;
    const stamp = draftChangedStamp(err);
    // A newer save of the day (built after this one) has been sent already:
    // it carries the owner's newer figures and answers for them. This older
    // one is never re-posted, kept, or asked about — re-posted on the newer
    // version (the form's own), its older body replaced the newest figures.
    const superseded = () => via !== "lock" && runNo != null && (sentNoRef.current[key] || 0) > runNo;
    if (superseded()) return "superseded";
    // The form's other saves of the day already sent answer first: the
    // newer version may be its own. (Not one queued behind this one: that
    // waits for this one — waiting for it here would wait forever.)
    // Only those sent BEFORE it: two refused saves waiting on each other
    // waited out the whole cap.
    const wire = [...(keyWireRef.current[key] || [])];
    const at = tracker ? wire.indexOf(tracker) : -1;
    const sentBefore = at >= 0 ? wire.slice(0, at) : wire;
    if (sentBefore.length) await settledWithin(sentBefore, SAVE_TURN_WAIT_MS);
    if (superseded()) return "superseded";
    if (stamp && ownStampsRef.current[key]?.has(stamp)) {
      noteStamp(key, stamp);
      if (via === "lock" || mountedRef.current) {
        if (via !== "lock" && key === rowKeyRef.current) { sendNowRef.current = true; requestRefile(true); }
        return "own";
      }
      // Left already: the change goes again on its own newer version.
      try {
        await api.post("/daily-close", { ...body, base_updated_at: stamp });
        return "own";
      } catch { /* kept as a copy below */ }
    }
    if (mountedRef.current) {
      if (key === rowKeyRef.current) {
        // The refused body rides along: kept as the owner's copy if the page
        // is left with the question open and the form files nothing then.
        setDraftConflict({ key, current, stamp, via, body });
        return "asked";
      }
      return "other";
    }
    // The page was left with the question open: the form's own figures,
    // newer than this body, are kept on the device already.
    const cc = conflictCopyRef.current;
    if (cc && cc.conflict?.key === key && getOfflineQueue().some((it) => it.id === cc.id)) return "kept";
    const kept = addFailedToOfflineQueue(body, {
      errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: stamp, httpStatus: err?.response?.status ?? null,
    });
    if (kept) { try { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); } catch { /* no window */ } }
    return "kept";
  };
  /**
   * Round 22 — the day's row as the server holds it NOW, read fresh by date
   * (and branch), with the id of the save that wrote it last
   * (`last_save_id`); null when nothing is stored for the day. A save whose
   * answer was lost MAY be the form's own: before the form deletes, files
   * back, or releases a day on which one went, it asks — and the row is its
   * own exactly when that last save is one it sent. Throws when it cannot
   * ask (offline): nothing is then decided as if nothing were stored.
   */
  const readDayFresh = async (key) => {
    const [date, branch] = String(key).split("|");
    const params = { from: date, to: date, with_save_id: true };
    if (branch) params.branch_id = branch;
    const res = await api.get("/daily-close", { params, _noRetry: true, timeout: 8000 });
    const rows = Array.isArray(res?.data) ? res.data : [];
    return rows.find((r) => closeRowKey(r) === key && !r.is_deleted) || null;
  };
  /** The stored row's last save is one this form sent. */
  const lastSaveIsMine = (row) => Boolean(row?.last_save_id) && mySaveIdsRef.current.has(row.last_save_id);
  /** The autosave looks again; `force`: whatever it holds is sent (the row may be gone or stale). */
  const requestRefile = (force = false) => {
    if (force) lastSentRef.current = null;
    setRefile((n) => n + 1);
  };
  /** What the form knew of a day's draft goes (deleted, or never the form's to file over). */
  const forgetDay = (key) => {
    delete ownRowsRef.current[key];
    delete serverSrcRef.current[key];
    delete baseRef.current[key];
    delete lostSaveRef.current[key];
    delete sentBodyRef.current[key];
    filedScanKeysRef.current.delete(key);
    setOwnDraftKeys((prev) => { if (!prev.has(key)) return prev; const n = new Set(prev); n.delete(key); return n; });
  };
  const undropId = (rid) => {
    if (rid == null) return;
    setDroppedIds((prev) => { if (!prev.has(rid)) return prev; const n = new Set(prev); n.delete(rid); return n; });
  };
  /**
   * Round 23 — the ONE way this form deletes a day's draft, and only because
   * the owner said so (Start forfra, a date move answered "Flyt tallene",
   * "Slet den"). It never guesses whose the draft is. The saves on their way
   * answer first; then the draft is deleted on the version this form holds
   * (base_updated_at — and base_save_id, the save whose answer was lost): a
   * version saved anywhere else since is refused (412 draft_changed) and
   * never deleted. A save whose answer was lost MAY have made (or changed)
   * the row, so the server is asked first (the day read fresh, with the id of
   * the save that wrote it last).
   *   "deleted"  gone (or already gone: 404)
   *   "none"     nothing is stored for the day
   *   "changed"  saved somewhere else since: kept, the day's banner shows it
   *   "locked"   locked (on another device): kept
   *   "offline"  no answer (offline, a dead connection): nothing changed here
   *   "error"    refused for another reason: kept
   *   "refiled"  (`forMove`) the form is on that day again, or filed it again
   *              while the saves before answered: it holds the figures now
   * `shown` (the banner's Start forfra): the draft the owner saw and chose —
   * deleted on exactly that version, whoever wrote it.
   */
  const deleteDayDraft = async (key, { forMove = false, shown = null, out = null } = {}) => {
    const gen0 = sendGenRef.current[key] || 0;
    await savesSettled();
    // A move's old day the owner went back to (or filed again) meanwhile:
    // its draft is the owner's figures again — never deleted for the move.
    if (forMove && (key === rowKeyRef.current || (sendGenRef.current[key] || 0) !== gen0)) return "refiled";
    const own = ownRowsRef.current[key];
    const lost = shown ? null : lostSaveRef.current[key];
    const listed = (existingClosesRef.current || []).find((dc) => closeRowKey(dc) === key && !dc.is_deleted && !droppedIdsRef.current.has(dc.id));
    let id = shown?.id ?? own?.id ?? listed?.id ?? null;
    if (id == null && !lost) return "none";
    // Round 23 review — deleted only on a version this form HOLDS (the one
    // it opened, or its own save was answered with) — or, from the banner,
    // the version shown: never on History's listed version (that is whoever
    // wrote it last — another phone's), and never with no version at all
    // (the server checks nothing without one: a row read with no updated_at
    // would have deleted whatever is stored now). A form that holds none
    // sends NO_ROW_BASE: only its own lost save's version (base_save_id) can
    // then be deleted; anything else is refused (412) and kept.
    const held = Object.prototype.hasOwnProperty.call(baseRef.current, key) ? baseRef.current[key] : null;
    const params = { base_updated_at: (shown ? shown.updated_at : held) || NO_ROW_BASE };
    if (lost?.id) params.base_save_id = lost.id;
    // The row as stored now, when the server kept it (out.row): the page
    // says what it holds ("Ikke slettet … nu 15.000 kr.").
    const kept = (row) => { if (out && row) out.row = row; };
    if (lost) {
      let row;
      try {
        row = await readDayFresh(key);
      } catch (err) {
        return err?.response ? "error" : "offline";
      }
      if (!row) { forgetDay(key); onDraftSaved?.(); return "none"; }
      if ((row.status || "confirmed") !== "draft") { kept(row); forgetDay(key); onDraftSaved?.(); return "locked"; }
      // Written last by a save of someone else's (the server said so): it is
      // that version now — kept, and shown; no delete is even tried.
      if (row.last_save_id && !lastSaveIsMine(row)) {
        kept(row);
        forgetDay(key);
        setRowOverrides((prev) => ({ ...prev, [row.id]: { row, listed: existingClosesRef.current } }));
        onDraftSaved?.();
        return "changed";
      }
      id = row.id;
      if (lastSaveIsMine(row)) {
        // Written last by a save of this form's: that very version is the
        // form's own (anyone else's since is refused by the server).
        if (row.updated_at) params.base_updated_at = row.updated_at;
        params.base_save_id = row.last_save_id;
      } else {
        // Round 23 review — written last by a save with no id (an offline
        // queue's copy, the review's lock, another phone's queued copy), or
        // who wrote it could not be checked (no last_save_id: the audit read
        // failed). Never "the form's" on a guess, and never deleted on the
        // version History lists (that is the other writer's own): only the
        // version this form holds — or the one its own lost save wrote
        // (base_save_id) — is deleted. Anything else is refused (412) and
        // kept, and the page shows it.
        params.base_updated_at = held || NO_ROW_BASE;
      }
    }
    // Off the list before the delete goes: the day's banner never offers the
    // draft being deleted.
    setDroppedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    try {
      await api.delete(`/daily-close/${id}`, { params });
    } catch (err) {
      if (err?.response?.status !== 404) {
        undropId(id);
        if (!err?.response) return "offline";
        if (isDraftChanged(err)) {
          // Never deleted: the banner shows it as it is NOW (the refusal
          // carries it), not the amount History listed earlier.
          const cur = err.response.data?.detail?.current;
          forgetDay(key);
          if (cur && typeof cur === "object" && cur.id != null) {
            kept(cur);
            setRowOverrides((prev) => ({ ...prev, [cur.id]: { row: cur, listed: existingClosesRef.current } }));
          }
          onDraftSaved?.();
          return "changed";
        }
        if (err.response.status === 409) {
          forgetDay(key);
          if (key === rowKeyRef.current) setLockedRowRejected(true);
          onDraftSaved?.();
          return "locked";
        }
        return "error";
      }
    }
    forgetDay(key);
    delete failedBodyRef.current[key];
    // What an earlier Start forfra said of this draft is no longer true.
    setStartOverFailed((cur) => (cur && cur.key === key ? null : cur));
    // Nothing of the day is filed now: the next figures typed for it go.
    if (key === rowKeyRef.current) lastSentRef.current = null;
    onDraftSaved?.();
    return "deleted";
  };
  /**
   * A day's draft is KNOWN to be stored: a save of this form's was answered
   * for it, or History lists it. (A save that got no answer — offline, a
   * dropped line — may or may not have made one: "maybe".)
   */
  const draftKnownStored = (k) => Boolean(ownRowsRef.current[k])
    || (existingClosesRef.current || []).some((dc) => closeRowKey(dc) === k && !dc.is_deleted && !droppedIdsRef.current.has(dc.id));
  /** A move's outcome, as the line under the date says it. */
  const moveNoteOf = (m, outcomes) => {
    const stuck = outcomes.filter((o) => o.outcome !== "deleted" && o.outcome !== "none").map((o) => ({
      ...o,
      // Said "står der stadig" only when it is known to be there: the server
      // said so (refused, locked), or the form knows it is stored.
      known: o.outcome === "changed" || o.outcome === "locked" || draftKnownStored(o.key),
    }));
    if (!stuck.length) return { from: m.from, to: m.to, state: "moved" };
    return { from: m.from, to: m.to, state: "copy", stuck };
  };
  // A move answered "Flyt tallene", and the new day's save landed: the old
  // day's draft goes now — deleted on the version this form holds, or the
  // line under the date says it is still there ("Slet den" when it can).
  const finishMove = async (savedKey) => {
    const m = moveFromRef.current;
    if (!m || savedKey !== m.toKey) return;
    moveFromRef.current = null;
    const outcomes = [];
    for (const k of m.keys) {
      // Moved back onto it: it holds the figures again.
      if (k === rowKeyRef.current) continue;
      const outcome = await deleteDayDraft(k, { forMove: true });
      if (outcome !== "refiled") outcomes.push({ key: k, outcome });
    }
    // Emptied by Start forfra meanwhile: nothing is said on the empty form.
    if (!mountedRef.current || formEpochRef.current !== m.epoch) return;
    setMovedNote(moveNoteOf(m, outcomes));
  };
  // "Slet den": the old day's draft a move could not delete, deleted now —
  // the owner's one tap. Never a version saved elsewhere since (refused) or
  // a locked day.
  const deleteMovedOld = async () => {
    const n = movedNote;
    if (!n || n.state !== "copy" || moveBusyRef.current) return;
    // Round 23 review — never while the new day's save is unconfirmed
    // ("pending": no answer, and the day read did not show it landed): the
    // old day's draft may be the only stored copy of the figures.
    if (n.stuck.some((s) => s.outcome === "pending")) return;
    moveBusyRef.current = true;
    setMoveBusy(true);
    const epoch = formEpochRef.current;
    const outcomes = [];
    try {
      for (const s of n.stuck) {
        if (s.outcome === "changed" || s.outcome === "locked" || s.key === rowKeyRef.current) { outcomes.push(s); continue; }
        const outcome = await deleteDayDraft(s.key, { forMove: true });
        if (outcome !== "refiled") outcomes.push({ key: s.key, outcome });
      }
    } finally {
      moveBusyRef.current = false;
      if (mountedRef.current) setMoveBusy(false);
    }
    if (!mountedRef.current || formEpochRef.current !== epoch) return;
    const next = moveNoteOf(n, outcomes);
    setMovedNote(next.state === "copy" ? { ...next, tried: true } : next);
  };
  // Round 23 review — the new day's save of a move got no answer and was not
  // seen landing ("pending"): "Prøv igen" sends the figures for it now. Its
  // answer finishes the move (the old day's draft goes then, never before).
  const retryMovedSave = () => {
    const m = moveFromRef.current;
    if (!m || m.toKey !== rowKeyRef.current) return;
    if (pendingSaveRef.current) { flushWaitingSave(); return; }
    retryArmedRef.current = null;
    sendNowRef.current = true;
    requestRefile(true);
  };
  /** A stored draft's figure, as the banner says it ("12.000 kr.", or "kun betalinger på 1.234,50 kr."). */
  const draftFigureOf = (row) => {
    if (!row) return "";
    if (isPaymentsOnly(row)) {
      const p = paymentsOf(row);
      return t("dcDraftFigurePaymentsOnly", "only payments of {amount}", { amount: formatOwnerMoney(p, currency, { decimals: oreDecimals(p) }) });
    }
    const v = Number(row.revenue_total) || 0;
    return formatOwnerMoney(v, currency, { decimals: oreDecimals(v) });
  };
  /** A draft body as the server stores its total (the backend's override rule). */
  const rowOfBody = (b) => {
    const lines = Object.values(b?.revenue_breakdown || {}).reduce((a, v) => a + (Number(v) || 0), 0);
    const ov = Number(b?.revenue_total_override);
    const total = ov > 0 ? (b.revenue_total_owner_set ? ov : Math.max(lines, ov)) : lines;
    return { revenue_total: Math.round(total * 100) / 100, payment_breakdown: b?.payment_breakdown || {} };
  };
  // Round 23 — Start forfra could not reach the server ("offline") or was
  // refused ("error"): nothing changed, and the page says so. Round 23
  // review — also when the server KEPT the draft: saved on another device
  // meanwhile ("changed", with what it holds now) or locked there ("locked").
  // { outcome, key, amount } — said only where that day's draft is (its
  // banner, or the card of that day), never under another day's.
  const [startOverFailed, setStartOverFailed] = useState(null);
  // …and while its delete is on its way the card and the banner wait: a
  // photo or "Brug disse tal" now would be emptied the moment it answers.
  const [startOverBusy, setStartOverBusy] = useState(false);
  /**
   * Round 23 — Start forfra empties the form: every figure, photo, note and
   * field, the scan card, the step — a new close for the same day. (The
   * owner's own till coming back, the replaced draft put back, the fields
   * kept beside the photo — every guess of what Start forfra should leave —
   * is gone: it starts over.)
   */
  const resetFormEmpty = () => {
    formEpochRef.current += 1;
    clearTimeout(autoSaveRef.current);
    pendingSaveRef.current = null;
    retryArmedRef.current = null;
    lastSentRef.current = null;
    moveFromRef.current = null;
    act(resetTills);
    setScanPhotos([]);
    setReceiptPhotoUrl(null);
    loadedPhotoRef.current = null;
    loadedUnlockedRef.current = false;
    scanPrefillRef.current = null;
    appliedPrefillRef.current = null;
    setAppliedMoms(null);
    setDraftMoms(null);
    salesFillRef.current = null;
    boxesHoldPhotosRef.current = false;
    boxFillEpochRef.current += 1;
    setRevAmounts({});
    setPayAmounts({});
    setRevCats(defaultRevCats);
    setPayMethods(defaultPayMethods);
    setCustomRevName("");
    setDrawerCount("");
    setCashCounted("");
    setCashFloat(deviceFloat());
    setTipsTotal("");
    setStaffCount("");
    setGavekortSold("");
    setBatchRef("");
    setClosedBy("");
    setNotes("");
    setMomsMode("auto");
    setMomsManual("");
    editLoadedRef.current = false;
    editBaselineRef.current = null;
    editOpenLedgerRef.current = null;
    filedLedgerRef.current = null;
    setEditingDate(null);
    setEditingDraft(false);
    setDraftConflict(null);
    setMovedNote(null);
    setScanError("");
    setSmartScanVerifyState([]);
    setChipDismissed(false);
    setChipConfirmed(false);
    setChipError("");
    setUnlinkOpenForTerminalId(null);
    setConflictDismissed(false);
    setCardHeld(null);
    setError("");
    setErrorDetail("");
    setStartOverFailed(null);
    setStartOverBusy(false);
    setScanMode("idle");
    setStep(1);
    if (!savesInFlightRef.current) setDraftSaving(false);
  };
  /**
   * Round 23 — "Start forfra", the same explicit action wherever it is (the
   * day's draft banner, the scan card). A question in plain Danish says
   * exactly what happens — "Kladden for {dato} med {beløb} slettes, og du
   * starter forfra. Det kan ikke fortrydes." — or, with nothing filed for the
   * day, that what is on screen is cleared (one tap for a photo nobody
   * touched, as before). Then the SERVER does it in one step: the day's draft
   * deleted on the version this form holds (deleteDayDraft — saved elsewhere
   * since: never deleted, the banner shows it), and the form is emptied. A
   * delete that could not be done (offline, an error) changes nothing here
   * and says so.
   */
  const startOverReadingRef = useRef(false);
  const startOverDay = async (source) => {
    if (startingOverRef.current || startOverReadingRef.current) return;
    const bannerRow = source === "banner" ? existingForDate : null;
    const key = bannerRow ? closeRowKey(bannerRow) : rowKey;
    const own = ownRowsRef.current[key];
    const listed = (existingCloses || []).find((dc) => closeRowKey(dc) === key && !dc.is_deleted && !droppedIds.has(dc.id));
    const sentBody = sentBodyRef.current[key];
    // Something of the day is stored (or on its way): the form's own saves,
    // a reopened draft — or the draft on the banner.
    const filed = Boolean(bannerRow) || Boolean(own || sentBody || lostSaveRef.current[key]
      || keyInflightRef.current[key]?.size || failedBodyRef.current[key])
      || (Boolean(listed) && (Boolean(editingDate) || ownDraftKeys.has(key)));
    let figure = bannerRow ? draftFigureOf(bannerRow)
      : sentBody ? draftFigureOf(rowOfBody(sentBody))
        : own?.row ? draftFigureOf(own.row)
          : listed ? draftFigureOf(listed) : "";
    // Round 23 review — a save of the day got no answer: what is stored may
    // not be what the form last sent (an earlier save of its own landed, the
    // last one never did). Read first when it can be: the question names the
    // draft as STORED when it is the form's own — the one the delete removes.
    // (Anyone else's is never deleted: refused, and said after.)
    if (!bannerRow && lostSaveRef.current[key] && !(typeof navigator !== "undefined" && navigator.onLine === false)) {
      startOverReadingRef.current = true;
      try {
        const row = await readDayFresh(key);
        if (row && (row.status || "confirmed") === "draft" && lastSaveIsMine(row)) figure = draftFigureOf(row);
      } catch { /* the delete asks again (and says so when it cannot) */ } finally {
        startOverReadingRef.current = false;
      }
      if (!mountedRef.current) return;
    }
    const day = String(key).split("|")[0];
    let ok = true;
    if (filed) {
      ok = await askConfirm({
        title: t("dcScanStartOverTitle", "Start over?"),
        message: t("dcStartOverDeleteBody", "The draft for {date} with {amount} is deleted, and you start over. This can't be undone.", {
          date: formatDateClear(day) || day, amount: figure || "—",
        }),
        confirmLabel: t("startOver", "Start over"),
        cancelLabel: t("cancel", "Cancel"),
        destructive: true,
      });
    } else {
      // Nothing filed: what is on screen is cleared. Asked when the owner
      // has put anything of their own into it (a correction on the card,
      // two photos, figures typed, a note) — one tap threw corrections away
      // unasked; an untouched photo still goes in one tap.
      const typed = (v) => typeof v === "string" && v.trim() !== "";
      const filledIn = (v) => String(v ?? "").trim() !== "";
      const card = scanResult;
      const severalPhotos = card?.merge_info?.mode === MERGE_SUM || dayPhotos.length > 1;
      const corrected = Boolean(card) && (severalPhotos || card.revenue_total_text != null || typed(card.tips)
        || [...Object.values(card.revenue || {}), ...Object.values(card.payments || {})].some(typed));
      const ownWork = corrected || Boolean(formTill(ledgerRef.current))
        || [closedBy, notes, drawerCount, tipsTotal, gavekortSold, staffCount, batchRef].some(filledIn);
      if (ownWork) {
        ok = await askConfirm({
          title: t("dcScanStartOverTitle", "Start over?"),
          message: t("dcStartOverClearBody", "What you typed and scanned here is cleared, and you start over. Nothing is saved yet."),
          confirmLabel: t("startOver", "Start over"),
          cancelLabel: t("cancel", "Cancel"),
          destructive: true,
        });
      }
    }
    if (ok !== true || !mountedRef.current) return;
    // Filed while the question was open (a save that was waiting went): it
    // goes too — the owner chose to start over.
    const filedNow = filed || Boolean(ownRowsRef.current[key] || sentBodyRef.current[key] || lostSaveRef.current[key]
      || keyInflightRef.current[key]?.size || failedBodyRef.current[key]);
    startingOverRef.current = key;
    setStartOverBusy(true);
    // Thrown away: a draft of the day that got no answer is never sent again.
    delete failedBodyRef.current[key];
    // Nothing waiting is filed for the day any more.
    clearTimeout(autoSaveRef.current);
    if (pendingSaveRef.current?.key === key) pendingSaveRef.current = null;
    retryArmedRef.current = null;
    setStartOverFailed(null);
    let outcome = "none";
    const out = {};
    try {
      if (filedNow) outcome = await deleteDayDraft(key, { shown: bannerRow, out });
    } finally {
      startingOverRef.current = null;
      if (mountedRef.current) setStartOverBusy(false);
    }
    if (!mountedRef.current) return;
    if (outcome === "offline" || outcome === "error") {
      // Not deleted: nothing changes, and the page says so. What the form
      // holds is what the day keeps (sent again — the delete may have gone
      // through with its answer lost).
      setStartOverFailed({ outcome, key });
      requestRefile(true);
      return;
    }
    // The banner's draft was another branch's ("Alle afdelinger"): the new
    // close is filed under that branch, not beside it.
    if (bannerRow) setFileBranchOverride(bannerRow.branch_id || null);
    resetFormEmpty();
    // Round 23 review — the server kept it (saved on another device
    // meanwhile, or locked there): the form starts over as asked, and the
    // day's banner shows that draft — with why it was not deleted, and what
    // it holds now (the owner was told "slettes").
    if (outcome === "changed" || outcome === "locked") {
      setStartOverFailed({ outcome, key, amount: outcome === "changed" && out.row ? draftFigureOf(out.row) : "" });
    }
  };
  // Named when the venue has several, so "a draft for this day" says whose.
  const existingBranchName = existingForDate?.branch_id && (branches || []).length > 1
    ? (branches.find((b) => String(b.id) === String(existingForDate.branch_id))?.name || "")
    : "";
  const existingLocked = existingForDate?.status === "confirmed";
  // A close already filed for the day that is not this form's: the banner
  // stands in front of the form (continue it, or Start forfra — which deletes
  // it). Round 23: nothing is ever filed OVER another draft any more.
  const existingBlocks = Boolean(existingForDate);

  // The form is the day past the scan card ("skipped") — and on an empty
  // scan card when the day is the owner's own till and nothing else: Start
  // forfra put their figures back in the boxes, and leaving from there kept
  // the photo's figures in the draft (24.412,50 saved under a 21.412,50
  // form). A card with photos on it is not filed until it is applied (and
  // says so while it differs from what is filed — dc-scan-unsaved).
  const formIsTheDay = scanMode === "skipped"
    || (scanMode === "idle" && Boolean(formTill(ledger)) && !hasScanTills(ledger) && !ledger.pending.length);
  // The ledger as the autosave reads it: only while the form is the day. On
  // the card every keystroke makes a new ledger, and none of them is saved.
  const autosaveLedger = formIsTheDay ? ledger : null;
  formFilesRef.current = formIsTheDay && filesSomething(savedRevenue, paymentTotal);

  useEffect(() => {
    // Nothing to save — and nothing a flush on leaving may send either.
    const nothingToSave = () => {
      pendingSaveRef.current = null;
      if (!savesInFlightRef.current) setDraftSaving(false);
    };
    // Stop re-asking to overwrite a signed kasserapport. The 409 below is the
    // real barrier; this only stops the timer knocking every two seconds after
    // the server has already said no for this row.
    if (lockedRowRejected || deletedLockedRow != null || existingBlocks) return nothingToSave();
    // The day's draft changed elsewhere and the owner has not said which
    // wins: nothing is sent over it (it would only be refused again).
    if (draftConflict && draftConflict.key === rowKey) return nothingToSave();
    // Start forfra is deleting the day's draft: nothing is filed for it
    // meanwhile (the form is emptied once the delete has answered).
    if (startingOverRef.current === rowKey) return nothingToSave();
    // Only auto-save if user has entered some data and is past scan UI
    // On the total that will be SAVED: a Z-bon read as a total only was
    // never autosaved, because its categories summed to zero. And on the
    // payments typed (round 21): a till of payments only is a till — the
    // terminal question counts it at its payments (closeTills.tillFromForm)
    // — and it was never saved: MobilePay 1.234,50 typed, the page left,
    // nothing on any server. One rule, filesSomething, here and at Start
    // forfra.
    if (!formIsTheDay || !filesSomething(savedRevenue, paymentTotal)) return nothingToSave();
    // A reopened close not touched yet is not a save. The first change ends
    // that for good: the stored draft then holds the change, so going back to
    // the figures it was opened with is a change too — it was skipped, and
    // the server kept the version in between (a Kort of 21.000 lost).
    if (editBaselineRef.current) {
      const untouched = autosaveLedger === editOpenLedgerRef.current && editBaselineRef.current === editSignature({
        rev: revAmounts, pay: payAmounts, cash: cashCounted, tips: tipsTotal,
        staff: staffCount, by: closedBy, notes, momsMode, momsManual,
        cashFloat, gavekort: gavekortSold, batch: batchRef,
      });
      if (untouched) return nothingToSave();
      editBaselineRef.current = null;
      editOpenLedgerRef.current = null;
    }
    // The draft this form last sent, exactly: nothing to send again. "← Scan
    // Z-bon" and "Spring over" back with nothing changed posted the same
    // draft twice — an append-only audit row, a history refetch and a
    // "Gemmer…/Gemt" each time. A change back to figures saved before is
    // not this: the last draft sent holds the change in between.
    const sig = JSON.stringify(buildPayload("draft"));
    // Round 23 — the ledger the stored draft holds is set when a save is
    // ANSWERED (below), not when it is built: built and then not sent (no
    // answer — offline, a dead line) it made the card say these figures were
    // saved, and "Ikke gemt endnu" never showed. The same draft already sent
    // (and not failed since): that one holds these figures.
    if (sig === lastSentRef.current) {
      filedLedgerRef.current = autosaveLedger;
      clearTimeout(autoSaveRef.current);
      return nothingToSave();
    }
    const ledgerAtBuild = autosaveLedger;
    // Debounce: save 2s after last step change
    clearTimeout(autoSaveRef.current);
    const savingKey = rowKey;
    // `keepalive` when the page itself is going away (pagehide / hidden): a
    // plain request can die with the page, a keepalive fetch is finished by
    // the browser.
    const run = async ({ keepalive = false } = {}) => {
      pendingSaveRef.current = null;
      savesInFlightRef.current += 1;
      sendGenRef.current[savingKey] = (sendGenRef.current[savingKey] || 0) + 1;
      const body = buildPayloadRef.current("draft");
      const runNo = ++runNoRef.current;
      const sent = JSON.stringify(body);
      lastSentRef.current = sent;
      sentBodyRef.current[savingKey] = body;
      // A source read off photos (or a reopened read told with a hand
      // correction) is on its way: from now on the day is told again what it
      // is. Marked when it is SENT — marked on the answer, a change put back
      // while it was on its way sent null, and the server kept the
      // correction ("rettet af ejeren: Kort") for a Kort no longer changed.
      if (payloadInfo.get(body)?.scanSource) filedScanKeysRef.current.add(savingKey);
      // The photo too (round 21): marked on the answer, a Start forfra
      // decided while the photo's save was on its way sent null (keep) and
      // the thrown-away bon's photo stayed on the typed draft. From now on
      // it is the photo this form filed, so the next draft without it clears
      // it ("") — a save that fails leaves at most a "" for no photo.
      if (body.receipt_photo && body.receipt_photo !== loadedPhotoRef.current) {
        filedPhotosRef.current.add(body.receipt_photo);
        serverSrcRef.current[savingKey] = { ...(serverSrcRef.current[savingKey] || {}), photo: body.receipt_photo };
      }
      let answered;
      const tracker = new Promise((r) => { answered = r; });
      inflightRef.current.add(tracker);
      // The day's saves still on their way, before this one.
      const ahead = [...(keyInflightRef.current[savingKey] || [])];
      if (!keyInflightRef.current[savingKey]) keyInflightRef.current[savingKey] = new Set();
      keyInflightRef.current[savingKey].add(tracker);
      // Any later visit of this page lists the day once this has landed.
      const onTheirWay = closeSavesOnTheirWay();
      onTheirWay.add(tracker);
      let saveId = null;
      try {
        // One at a time per day, each on the version the one before was
        // answered with: two on their way at once, the second was built on a
        // version the first replaced, and the server refused the owner's own
        // newer change. Not when the page is going away (keepalive): it goes
        // now, as it always did — on the version it knows, naming the save
        // still on its way it follows (base_save_id): the version THAT save
        // writes is the form's own and does not refuse this one; anyone
        // else's in between still does.
        let followsId = null;
        if (ahead.length && keepalive) {
          const wire = [...(keyWireRef.current[savingKey] || [])];
          followsId = wire.length ? saveIdOfRef.current.get(wire[wire.length - 1]) || null : null;
        } else if (ahead.length) {
          await settledWithin(ahead, SAVE_TURN_WAIT_MS);
          // A newer save of the day went while this one waited (the page
          // going away sends at once, and its answer can come first): this
          // older body is not sent after it. On that one's version it was
          // accepted and stored over the owner's last change, and nothing
          // sent the change again (round 21 review).
          if ((sentNoRef.current[savingKey] || 0) > runNo) return;
        }
        body.base_updated_at = baseFor(savingKey);
        saveId = newSaveId();
        body.save_id = saveId;
        mySaveIdsRef.current.add(saveId);
        if (followsId) body.base_save_id = followsId;
        // A save of the day got no answer (it may have landed): this one
        // follows it — the version it wrote is the form's own.
        else if (lostSaveRef.current[savingKey]?.id) body.base_save_id = lostSaveRef.current[savingKey].id;
        sentNoRef.current[savingKey] = Math.max(sentNoRef.current[savingKey] || 0, runNo);
        saveIdOfRef.current.set(tracker, saveId);
        if (!keyWireRef.current[savingKey]) keyWireRef.current[savingKey] = new Set();
        keyWireRef.current[savingKey].add(tracker);
        const res = await api.post("/daily-close", body,
          keepalive && typeof fetch === "function" ? { adapter: "fetch", fetchOptions: { keepalive: true } } : undefined);
        noteSaved(savingKey, body, res);
        // Answered, and built after the save that got no answer: the day's
        // version is this one's now.
        if (lostSaveRef.current[savingKey] && lostSaveRef.current[savingKey].runNo < runNo) delete lostSaveRef.current[savingKey];
        // …and a draft that got no answer before it is on the server now (this
        // one carries the owner's later figures).
        if (failedBodyRef.current[savingKey] && failedBodyRef.current[savingKey].runNo <= runNo) delete failedBodyRef.current[savingKey];
        // What the stored draft holds now (the card compares with it).
        if (savingKey === rowKeyRef.current && (sentNoRef.current[savingKey] || 0) <= runNo) filedLedgerRef.current = ledgerAtBuild;
        // The photo it cleared is gone: the next draft of the same figures
        // says null ("keep" — nothing of ours is stored any more), and that
        // is no change to send again.
        if (body.receipt_photo === "" && lastSentRef.current === sent) {
          // (The draft as built — the version it was sent on is not part of it.)
          const { base_updated_at: _base, save_id: _sid, base_save_id: _follows, ...built } = body;
          lastSentRef.current = JSON.stringify({ ...built, receipt_photo: null });
        }
        setOwnDraftKeys((prev) => (prev.has(savingKey) ? prev : new Set(prev).add(savingKey)));
        onDraftSaved?.();
        setDraftSaved(true);
        setTimeout(() => setDraftSaved(false), 3000);
        // The new day of a date move is filed: the old day's draft goes.
        finishMove(savingKey);
      } catch (err) {
        // Not on the server: the same draft is sent again on the next change.
        if (lastSentRef.current === sent) lastSentRef.current = null;
        // No answer at all: it may have landed — the next save (and a delete
        // of the day) follows it, and a delete asks the server first.
        if (!err?.response && saveId) {
          const was = lostSaveRef.current[savingKey];
          if (!was || was.runNo < runNo) lostSaveRef.current[savingKey] = { id: saveId, runNo };
          // Round 23 — the owner's figures as sent, kept until a save of the
          // day answers: sent again on the way out and once online, also when
          // the form has gone back to the scan card since (the waiting save
          // was dropped there — a figure typed offline, then "← Scan Z-bon",
          // was never sent).
          const f = failedBodyRef.current[savingKey];
          if (!f || f.runNo <= runNo) {
            const { base_updated_at: _b, save_id: _s, base_save_id: _f, ...built } = body;
            failedBodyRef.current[savingKey] = { body: built, runNo, ledger: ledgerAtBuild };
          }
          // Still the form's latest for the day (nothing newer waiting or
          // sent): the same draft waits for the page to be left, the
          // network to come back, or the next change (round 22, offline).
          if (mountedRef.current && savingKey === rowKeyRef.current && !pendingSaveRef.current
            && (sentNoRef.current[savingKey] || 0) <= runNo) {
            retryArmedRef.current = sent;
            requestRefile(true);
          }
          // The new day of a date move, filed — perhaps. Asked, never
          // assumed: when the save that wrote the day last is THIS one (the
          // one carrying the moved figures), the move finishes as on an
          // answer (the old day's draft goes); otherwise it waits for the
          // next answered save of the day. Any save of the form's was not
          // proof (round 22 review): an earlier one already on the new day
          // finished the move while the moved figures were on no server.
          const m = moveFromRef.current;
          if (m && savingKey === m.toKey) {
            const landed = saveId;
            const sayCopy = () => {
              // Not known to be filed (offline, or not landed): the old day
              // still holds the figures — said so, never "moved" — until the
              // new day's save lands (then the old draft goes, as answered).
              if (!mountedRef.current || moveFromRef.current !== m || formEpochRef.current !== m.epoch) return;
              setMovedNote(moveNoteOf(m, m.keys.map((k) => ({ key: k, outcome: "pending" }))));
            };
            readDayFresh(savingKey)
              .then((row) => {
                if (!row || row.last_save_id !== landed) { sayCopy(); return; }
                // Landed: an answered save in all but the answer — the day is
                // the form's own (never "Der er allerede en kladde" over the
                // owner's own moved figures), and the move finishes.
                noteSaved(savingKey, body, { data: row });
                setOwnDraftKeys((p) => (p.has(savingKey) ? p : new Set(p).add(savingKey)));
                if (lostSaveRef.current[savingKey]?.id === landed) delete lostSaveRef.current[savingKey];
                if (retryArmedRef.current === sent) { retryArmedRef.current = null; lastSentRef.current = sent; }
                finishMove(savingKey);
              })
              .catch(sayCopy);
          }
        }
        // Refused (answered: nothing written): this body is not what the day
        // holds — Start forfra's question never names it.
        if (err?.response && sentBodyRef.current[savingKey] === body) delete sentBodyRef.current[savingKey];
        // Still best-effort for every other failure (offline, 500, flaky
        // connection) — but a 409 is not a transient error, it is the lock
        // saying this row is final. A day held by a deleted, locked
        // kasserapport is not that lock: said on the wizard, in the server's
        // words — the figures exist only on this screen.
        if (isDraftChanged(err)) {
          await draftRefused(savingKey, body, err, tracker, "draft", runNo);
        } else if (isDeletedLockedClose(err)) {
          if (savingKey === rowKeyRef.current) setDeletedLockedRow(errText(err, ""));
        } else if (err?.response?.status === 409) {
          // Locked on another device while this form had the day open (round
          // 22): said at once — the day's "already closed and locked" banner,
          // with the amount once History has the locked row — never the
          // owner's next edits refused in silence until the lock tap.
          // Only for the day the form is on (round 22 review): the OLD day's
          // save answering 409 after a date move marked the NEW day locked —
          // its banner, "Ikke gemt", and the moved figures never saved.
          if (savingKey === rowKeyRef.current) {
            setLockedRowRejected(true);
            onDraftSaved?.();
          }
          // The day the figures were moved to is locked: nothing moved, and
          // the day they came from keeps its draft.
          if (moveFromRef.current?.toKey === savingKey) moveFromRef.current = null;
        }
      } finally {
        inflightRef.current.delete(tracker);
        keyInflightRef.current[savingKey]?.delete(tracker);
        keyWireRef.current[savingKey]?.delete(tracker);
        saveIdOfRef.current.delete(tracker);
        onTheirWay.delete(tracker);
        answered();
        savesInFlightRef.current -= 1;
        // A newer edit may already be waiting behind this one.
        if (!pendingSaveRef.current && !savesInFlightRef.current) setDraftSaving(false);
      }
    };
    // The day it files, for a Start forfra waiting on the saves before it.
    run.key = savingKey;
    pendingSaveRef.current = run;
    // The same draft whose save got no answer (round 22): it waits — sent on
    // leaving, on "online", or with the next change — never on a timer (a
    // dead connection would be knocked every two seconds).
    const armedOnly = retryArmedRef.current != null && retryArmedRef.current === sig;
    retryArmedRef.current = null;
    if (armedOnly) return undefined;
    setDraftSaving(true);
    // "Keep my numbers" (or the form's own newer save landing first): sent
    // now, not after the debounce.
    const now = sendNowRef.current;
    sendNowRef.current = false;
    autoSaveRef.current = setTimeout(run, now ? 0 : 2000);
    return () => clearTimeout(autoSaveRef.current);
  // closedBy / notes / staff / MOMS typed on the review step were never
  // autosaved — "Kladde gemt" and then lost on the next open.
  // momsTotal / exemptSalesTotal: the day's MOMS-free answer landing after
  // the save went out changes the MOMS, and that is saved too.
  // formIsTheDay / autosaveLedger: Start forfra changes the day on the scan
  // card, and "Spring over" back to the form moved no step — nothing re-ran,
  // and the draft kept the photo the owner had thrown away.
  // refile: the day may hold something else than the form now (a delete
  // that did not go through, a lost answer).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, formIsTheDay, autosaveLedger, revAmounts, payAmounts, cashCounted, cashFloat, tipsTotal, closedBy, notes, staffCount, momsMode, momsManual, gavekortSold, batchRef, receiptPhotoUrl, lockedRowRejected, deletedLockedRow, existingBlocks, businessDate, fileBranchId, savedRevenue, paymentTotal, momsTotal, exemptSalesTotal, refile, draftConflict]);

  // The "draft saved somewhere else" question is open and the page goes away:
  // what the form holds now (the lock, via "lock"; else the draft — or, when
  // the form files nothing any more, the refused save itself) is kept as a
  // failed copy, refused as draft_changed on the newer version it met — the
  // same copy draftRefused keeps for a refusal after the form was gone. One
  // copy per question, holding the latest figures.
  const keepConflictCopy = () => {
    const c = draftConflictRef.current;
    if (!c || c.key !== rowKeyRef.current) return;
    let built = null;
    try {
      built = c.via === "lock" ? buildPayloadRef.current("confirmed")
        : (formFilesRef.current ? buildPayloadRef.current("draft") : null);
    } catch { built = null; }
    const src = built || c.body;
    if (!src) return;
    // (Never an anomaly acknowledged for the owner, never a save's own ids.)
    const { save_id: _sid, base_save_id: _follows, acknowledge_anomaly: _ack, ...rest } = src;
    const payload = { ...rest, base_updated_at: c.stamp || rest.base_updated_at || null };
    const prev = conflictCopyRef.current;
    let kept = false;
    if (prev && prev.conflict === c && getOfflineQueue().some((it) => it.id === prev.id)) {
      updateQueueItem(prev.id, { payload });
      kept = true;
    } else {
      const item = addFailedToOfflineQueue(payload, {
        errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: c.stamp || null, httpStatus: 412,
      });
      if (item) { conflictCopyRef.current = { conflict: c, id: item.id }; kept = true; }
    }
    if (kept) { try { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); } catch { /* no window */ } }
  };
  // Offline (round 22): the draft waiting to be sent, kept on this device as
  // a copy the offline queue sends once online — on the version this form
  // holds (and following its own save whose answer was lost). One copy per
  // way out, holding the latest figures. False when nothing was kept (online,
  // or nothing waiting): the caller sends as before.
  const keepOfflineCopy = () => {
    if (typeof navigator === "undefined" || navigator.onLine !== false) return false;
    const run = pendingSaveRef.current;
    if (!run || run.key !== rowKeyRef.current || !formFilesRef.current) return false;
    let built = null;
    try { built = buildPayloadRef.current("draft"); } catch { built = null; }
    if (!built) return false;
    // (Round 23: a date move is confirmed before the date changes — the copy
    // is the day the form is on, the one the owner chose.)
    const dayKey = run.key;
    const payload = { ...built, base_updated_at: baseFor(dayKey) };
    const lost = lostSaveRef.current[dayKey];
    if (lost?.id) payload.base_save_id = lost.id;
    const prev = offlineCopyRef.current;
    if (prev && getOfflineQueue().some((it) => it.id === prev.id)) {
      updateQueueItem(prev.id, { payload });
    } else {
      const item = addToOfflineQueue(payload);
      if (!item) return false;
      offlineCopyRef.current = { id: item.id };
    }
    try { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); } catch { /* no window */ }
    return true;
  };
  // Round 23 — the drafts sent with no answer (failedBodyRef) of the days the
  // waiting save does not file itself: kept on this device too when the page
  // goes away offline (one copy per day), and sent once online.
  const failedCopiesRef = useRef({});
  const keepFailedCopies = () => {
    if (typeof navigator === "undefined" || navigator.onLine !== false) return false;
    let kept = false;
    for (const [key, f] of Object.entries(failedBodyRef.current)) {
      // The waiting save files this day itself (its own copy, above).
      if (pendingSaveRef.current?.key === key && formFilesRef.current) continue;
      const payload = { ...f.body, base_updated_at: baseFor(key) };
      const lost = lostSaveRef.current[key];
      if (lost?.id) payload.base_save_id = lost.id;
      const prevId = failedCopiesRef.current[key];
      if (prevId && getOfflineQueue().some((it) => it.id === prevId)) {
        updateQueueItem(prevId, { payload });
        kept = true;
        continue;
      }
      const item = addToOfflineQueue(payload);
      if (item) { failedCopiesRef.current[key] = item.id; kept = true; }
    }
    if (kept) { try { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); } catch { /* no window */ } }
    return kept;
  };
  const dropFailedCopies = () => {
    const ids = Object.values(failedCopiesRef.current);
    if (!ids.length || !mountedRef.current) return;
    failedCopiesRef.current = {};
    const queued = new Set(getOfflineQueue().map((it) => it.id));
    let dropped = false;
    ids.forEach((id) => { if (queued.has(id)) { removeFromOfflineQueue(id); dropped = true; } });
    if (dropped) { try { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); } catch { /* no window */ } }
  };
  /**
   * Round 23 — a draft sent with no answer (offline, a dead line) is sent
   * again: on the way out and once online — also when the form has left that
   * day's boxes since (the scan card), where nothing else would send it.
   * Exactly the figures sent then, on the version the form holds now (and
   * following that save, which may have landed). Never over a save of the day
   * still waiting or on its way (it carries the owner's later figures), and
   * never for a day Start forfra is deleting.
   */
  const sendFailedBodies = ({ keepalive = false } = {}) => {
    for (const [key, f] of Object.entries(failedBodyRef.current)) {
      if (pendingSaveRef.current?.key === key || keyInflightRef.current[key]?.size || startingOverRef.current === key) continue;
      const payload = { ...f.body, base_updated_at: baseFor(key) };
      const saveId = newSaveId();
      payload.save_id = saveId;
      mySaveIdsRef.current.add(saveId);
      const lost = lostSaveRef.current[key];
      if (lost?.id) payload.base_save_id = lost.id;
      let answered;
      const tracker = new Promise((r) => { answered = r; });
      inflightRef.current.add(tracker);
      if (!keyInflightRef.current[key]) keyInflightRef.current[key] = new Set();
      keyInflightRef.current[key].add(tracker);
      const onTheirWay = closeSavesOnTheirWay();
      onTheirWay.add(tracker);
      sendGenRef.current[key] = (sendGenRef.current[key] || 0) + 1;
      (async () => api.post("/daily-close", payload,
        keepalive && typeof fetch === "function" ? { adapter: "fetch", fetchOptions: { keepalive: true } } : undefined))()
        .then((res) => {
          noteSaved(key, payload, res);
          if (failedBodyRef.current[key] === f) delete failedBodyRef.current[key];
          if (lostSaveRef.current[key] && lostSaveRef.current[key].runNo <= f.runNo) delete lostSaveRef.current[key];
          if (key === rowKeyRef.current && !pendingSaveRef.current) {
            filedLedgerRef.current = f.ledger || filedLedgerRef.current;
            if (lastSentRef.current == null) lastSentRef.current = JSON.stringify(f.body);
          }
          if (mountedRef.current) {
            setOwnDraftKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
            onDraftSaved?.();
          }
        })
        .catch(async (err) => {
          if (!err?.response) {
            // Still no answer: it waits for the next way out, or "online".
            lostSaveRef.current[key] = { id: saveId, runNo: f.runNo };
            return;
          }
          if (failedBodyRef.current[key] === f) delete failedBodyRef.current[key];
          if (isDraftChanged(err)) {
            await draftRefused(key, payload, err, null, "draft", f.runNo);
          } else if (err.response.status === 409 && key === rowKeyRef.current && mountedRef.current) {
            setLockedRowRejected(true);
            onDraftSaved?.();
          }
        })
        .finally(() => {
          inflightRef.current.delete(tracker);
          keyInflightRef.current[key]?.delete(tracker);
          onTheirWay.delete(tracker);
          answered();
        });
    }
  };
  const dropOfflineCopy = () => {
    const oc = offlineCopyRef.current;
    if (!oc || !mountedRef.current) return;
    offlineCopyRef.current = null;
    // Already sent by the queue (online came while hidden): nothing to drop.
    if (!getOfflineQueue().some((it) => it.id === oc.id)) return;
    removeFromOfflineQueue(oc.id);
    try { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); } catch { /* no window */ }
  };
  const dropConflictCopy = () => {
    const cc = conflictCopyRef.current;
    if (!cc || !mountedRef.current) return;
    conflictCopyRef.current = null;
    removeFromOfflineQueue(cc.id);
    try { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); } catch { /* no window */ }
  };

  // Leaving sends the waiting save instead of dropping it: the form unmounts on
  // every tab switch and route change, and a phone can be locked or the tab
  // closed with the 2 s debounce still running.
  useEffect(() => {
    const flush = (opts) => {
      const run = pendingSaveRef.current;
      if (!run) return;
      clearTimeout(autoSaveRef.current);
      run(opts);
    };
    // Going away with "the draft was saved somewhere else" still open: the
    // owner's figures are kept on this device as a failed copy (round 21
    // review) — the autosave sends nothing over the newer draft, so they
    // existed only on screen and were gone with the form.
    // Going away OFFLINE (round 22): the waiting draft is kept on this device
    // (the offline queue sends it once online) — a request now only fails,
    // and a closing tab leaves no JS to keep it afterwards.
    // The copy kept, the autosave's timer stops too (round 22 review), as the
    // flush stopped it: the draft still waits here (pendingSaveRef) for the
    // "online" event, the next change or the way out — never a request of
    // its own while the copy is on the queue.
    const onHide = () => {
      if (keepOfflineCopy()) clearTimeout(autoSaveRef.current);
      else flush({ keepalive: true });
      // (Round 23: a draft sent with no answer goes too — or is kept here.)
      if (!keepFailedCopies()) sendFailedBodies({ keepalive: true });
      keepConflictCopy();
    };
    // Back (the tab shown again): the question is on screen again, and the
    // copy kept for the way out is not a second place to answer it — nor is
    // the offline copy (the draft is still waiting here).
    const onBack = () => { dropConflictCopy(); dropOfflineCopy(); dropFailedCopies(); };
    // Online again: the waiting draft goes now (its copy, if any, is taken
    // off the queue first — it would be sent twice).
    const onOnline = () => { dropOfflineCopy(); dropFailedCopies(); flush(); sendFailedBodies(); };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
      else if (document.visibilityState === "visible") onBack();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onBack);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onBack);
      window.removeEventListener("online", onOnline);
      if (!keepOfflineCopy()) flush();
      if (!keepFailedCopies()) sendFailedBodies();
      keepConflictCopy();
    };
  }, []);
  // The question answered (or a new one asked): the copy kept for it goes —
  // "Behold mine tal" saved those figures, "Hent den nyeste kladde" let them go.
  useEffect(() => {
    const cc = conflictCopyRef.current;
    if (cc && cc.conflict !== draftConflict) dropConflictCopy();
  }, [draftConflict]);

  // Final submit — locks the close (with offline queue fallback).
  // opts.acknowledgeAnomaly=true is passed by the "Yes, lock it" button
  // in the close_sanity double-check dialog to skip the guard and commit.
  const handleSubmit = async (opts = {}) => {
    // The lock carries every field itself. A draft still waiting would be
    // flushed when the form closes after the lock — a stale draft POSTed over
    // the confirmed row. Held back, not dropped: a lock that does not happen
    // (the double-check, a refusal) leaves the form open, and the edit typed
    // just before the tap was then never saved — "Gemmer…" with nothing on
    // its way.
    const heldSave = pendingSaveRef.current;
    clearTimeout(autoSaveRef.current);
    pendingSaveRef.current = null;
    // A draft copy kept on this device while offline (round 22) is not sent
    // beside the lock: the lock carries every field itself.
    dropOfflineCopy();
    const dropHeldSave = () => {
      clearTimeout(autoSaveRef.current);
      pendingSaveRef.current = null;
      if (!savesInFlightRef.current) setDraftSaving(false);
    };
    const restoreHeldSave = () => {
      // An edit made while the lock was on its way is newer — it wins.
      if (pendingSaveRef.current || !heldSave) return;
      pendingSaveRef.current = heldSave;
      autoSaveRef.current = setTimeout(heldSave, 2000);
    };
    setSaving(true);
    setError("");
    setErrorDetail("");
    // A draft save still on its way answers first (round 21): the lock is
    // built on what it stored — its photo (a lock tapped before the photo's
    // save answered sent null and kept a thrown-away bon's photo) and its
    // version. (Never held up long by a stalled request.)
    await settledWithin(inflightRef.current, SAVE_TURN_WAIT_MS);
    const payload = buildPayload("confirmed");
    if (opts.acknowledgeAnomaly) payload.acknowledge_anomaly = true;
    // The version of the day's draft this lock is built on: a draft saved
    // on another phone since is never locked over in silence — the owner is
    // asked, and an offline-queued lock that meets one stays as a failed copy.
    const lockKey = `${payload.date}|${payload.branch_id || ""}`;
    payload.base_updated_at = baseFor(lockKey);
    // A draft save of the day got no answer (it may have landed): the lock —
    // queued offline too — follows it; its version is the form's own.
    if (lostSaveRef.current[lockKey]?.id) payload.base_save_id = lostSaveRef.current[lockKey].id;

    if (!navigator.onLine) {
      // A queue write can be refused (quota, Safari private mode). Saying
      // "queued" when nothing was stored would be the same lie the old sync
      // loop told — tell the owner instead, so they can write the numbers down.
      const queued = addToOfflineQueue(payload);
      setSaving(false);
      if (!queued) { restoreHeldSave(); setError(t("dcQueueStoreFailed", "This phone could not store the kasserapport offline. Note the numbers down and try again when you're back online.")); return; }
      dropHeldSave();
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
        restoreHeldSave();
        setAnomalyCheck(resp.data.anomaly || {});
        setSaving(false);
        return;
      }
      dropHeldSave();
      setAnomalyCheck(null);
      // Locked for the day the figures were moved to: the old day's draft
      // this form made goes (a move, not a copy).
      finishMove(`${payload.date}|${payload.branch_id || ""}`);
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
        if (!queued) { restoreHeldSave(); setError(t("dcQueueStoreFailed", "This phone could not store the kasserapport offline. Note the numbers down and try again when you're back online.")); return; }
        dropHeldSave();
        onQueued?.();
        return;
      }
      restoreHeldSave();
      // The day's draft was saved somewhere else since this form read it:
      // nothing was locked or overwritten. The owner is asked which wins.
      if (isDraftChanged(err)) {
        const outcome = await draftRefused(lockKey, payload, err, null, "lock");
        // The form's own save had landed first: the lock goes again on it.
        if (outcome === "own" && !opts.lockRetried) await handleSubmit({ ...opts, lockRetried: true });
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
      if (isDeletedLockedClose(err)) {
        // Not "already locked — unlock it from History": History lists no
        // deleted row, and nothing of the day is in the books.
        setDeletedLockedRow(errText(err, ""));
        setError(t("dcDeletedLockedClose", "This day can't be saved: a deleted, locked kasserapport is kept for it (bookkeeping law). Nothing was saved — your numbers are still on this screen. Contact support."));
        setErrorDetail(errText(err, ""));
        return;
      }
      if (err.response.status === 409) {
        // Locked elsewhere: the day is a locked day here from now on (the
        // banner, the form read-only), and History is read again for its
        // amount (round 22).
        if (lockKey === rowKeyRef.current) { setLockedRowRejected(true); onDraftSaved?.(); }
        // The amount only when this form knows it: editing a draft whose day
        // was locked elsewhere said "Locked at 0 kr.", a figure nobody locked.
        setError(existingForDate && existingForDate.revenue_total != null
          ? t("dcDayAlreadyLockedBody", "Locked at {amount} — to correct it, unlock it from History first.", {
            amount: formatOwnerMoney(existingForDate.revenue_total ?? 0, currency, { decimals: GLANCE_DECIMALS }),
          })
          : t("dcDayLockedNoAmount", "This day is already locked — unlock it from History first if it needs correcting."));
        setErrorDetail("");
        return;
      }
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

  // Count how many fields OCR detected — what the SCANNER read (its figures
  // are numbers; a box the owner typed holds a string). The total and the
  // MOMS count too: a read of total, MOMS and Kort said "1/8 felter".
  // Lines on the card that nobody read off a photo — the owner's own, or the
  // form's when it was the first side of a sum. A sum makes them numbers; they
  // still must not read as "aflæst" or count as found.
  const typedOnCard = useMemo(() => new Set(scanResult?.merge_info?.typedFields || []), [scanResult]);
  const readOnCard = (field, v) => typeof v === "number" && v !== 0 && !typedOnCard.has(field);
  const scanFieldsTotal = defaultRevCats.length + defaultPayMethods.length + (config.hasTips ? 1 : 0) + 2;
  // The confidence is a READ's: per till, what its own photos read off the
  // paper (a figure the owner changed is not "found"). Counted on the merged
  // card, a fully read bon summed with a typed close or a draft said "Lav
  // sikkerhed — 2/10" — the typed lines, the bon's own among them, dropped
  // out of the count. One figure per till read off a photo.
  const tillReads = useMemo(() => {
    const fields = [
      ...defaultRevCats.map((c) => `revenue.${c.key}`),
      ...defaultPayMethods.map((m) => `payments.${m.key}`),
      ...(config.hasTips ? ["tips"] : []),
      "revenue_total", "moms_total",
    ];
    return tillGroups(ledger)
      .map((g) => g.filter((e) => e.origin === TILL_SCAN))
      .filter((photos) => photos.length > 0)
      .map((photos) => fields.filter((f) => photos.some((e) => {
        const v = fieldOf(e.scan, f);
        return typeof v === "number" && v !== 0 && !Object.prototype.hasOwnProperty.call(e.edits || {}, f);
      })).length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger, defaultRevCats, defaultPayMethods]);
  // A card rebuilt from a reopened draft carries no read at all — no
  // confidence, no "missing", no "we couldn't read the split".
  const cardIsRead = Boolean(scanResult) && !scanResult.from_draft;

  /**
   * Owner-facing names for the lines a sum could NOT add up.
   *
   * "Some lines were only on one of the receipts" is true but useless: the
   * owner cannot check a line we refuse to name, and the one that matters
   * most (MOMS) is the one that would otherwise be filed one-till-short.
   * Per-terminal documents (cash denominations, per-clerk splits) are left
   * out on purpose — they are not money lines the owner types.
   */
  const mergeIncompleteNames = useMemo(() => {
    // Lines only some tills carried (closeTills.oneSidedLines). MOMS is named
    // only when the day's MOMS is a figure the owner typed: otherwise the MOMS
    // shown is worked out for the whole day, and "MOMS stood on one bon only —
    // check it" contradicted the very figure beside it.
    const sides = oneSidedLines(ledger, { listMoms: momsTyped });
    if (!sides.read.length && !sides.own.length) return { read: [], own: [] };
    const label = (f) => {
      if (f === "moms_total") return vatName;
      if (f === "tips") return t("tipsLabel", "Tips");
      if (f === "revenue_total") return t("totalRevenue", "Total revenue");
      if (f === "cash_counted_total") return t("cashCounted", "Cash counted");
      // Built-ins read their catalogue word (catLabel), not the English
      // fallback `label` — that printed "Food" on a Danish screen.
      if (f.startsWith("revenue.")) {
        const k = f.slice("revenue.".length);
        const cat = revCats.find((c) => c.key === k);
        return cat ? catLabel(t, cat) : k;
      }
      if (f.startsWith("payments.")) {
        const k = f.slice("payments.".length);
        const pm = payMethods.find((m) => m.key === k);
        return pm ? catLabel(t, pm) : k;
      }
      return null;
    };
    const names = (list) => Array.from(new Set(list.map(label).filter(Boolean)));
    // A line the owner typed (or the form brought in) is theirs, not one
    // bon's: "Stod kun på den ene bon: Kontant" named a figure on no bon. It
    // is still not added up — the new bon's cash, say, is in no line — so it
    // is named on its own line, in words that do not call it a bon's.
    return { read: names(sides.read), own: names(sides.own) };
  }, [ledger, momsTyped, revCats, payMethods, vatName, t]);

  /**
   * The MOMS the card shows is the MOMS "Brug disse tal" leaves in the form —
   * one figure on the card, the review and the saved row. The scanned figure
   * only while it describes ALL the revenue the card will save: after a sum
   * whose second Z-bon had no readable MOMS line it covers one till of two,
   * and after a corrected total the card kept "3.406 kr. read" while the
   * review and the save used 3.290. Back on the card after applying, it is
   * the form's own MOMS (a reopened draft's typed figure, say).
   */
  // (cardSaveTotal — the total the card saves — is worked out above, beside
  // the payments check that compares against it.)
  // The Z-bon's printed total beside the one saved, when they differ — in
  // either direction (a category raised past it, or a total typed over it).
  // Not while the typed box is unreadable: that is a red field, not a figure.
  const cardBonGap = (() => {
    if (!scanResult) return null;
    if (scanResult.revenue_total_text && isMoneyRejected(scanResult.revenue_total_text, mLocale)) return null;
    const bon = scanBonTotal(scanResult, mLocale);
    if (!(bon > 0) || !(cardSaveTotal > 0)) return null;
    const diff = Math.round(Math.abs(cardSaveTotal - bon) * 100) / 100;
    if (diff < 0.005) return null;
    // One precision for the pair: øre on both when either has them.
    const decimals = [bon, cardSaveTotal].some((v) => oreIfAny(v) === LEDGER_DECIMALS) ? LEDGER_DECIMALS : GLANCE_DECIMALS;
    return { bon, diff, decimals };
  })();
  const cardMomsApplied = Boolean(scanResult) && Boolean(appliedMoms) && appliedMoms.key === scanMomsKey(scanResult);
  const cardMoms = (() => {
    // A card with no photo in the day (a reopened draft, a typed total) is
    // the form's own till: its MOMS is the form's — the one the review shows
    // and the payload sends. It kept the draft's saved 2.652,90 after the
    // total moved, under a review of 4.452,90.
    if (!hasScanTills(ledger)) return { value: momsTotal, read: false, moved: false };
    const bon = Number(scanResult?.moms_total);
    const fits = ledgerMoms.source === "zbon";
    // The form's MOMS is what applying leaves: the figure already applied, or
    // one the owner typed (kept even when a new figure arrives).
    const formKept = momsTyped && Boolean(appliedMoms)
      && (cardMomsApplied || appliedMoms.owner || momsManual !== appliedMoms.manual);
    if (formKept) {
      const kept = readMoney0(momsManual);
      const isBon = Math.abs(kept - bon) < 0.005;
      // The bon's own figure under a total that moved off it follows the total.
      if (!(isBon && !fits)) return { value: kept, read: isBon && fits, moved: false };
    }
    // The form's own MOMS (plus the bons' on a sum, when every till's is
    // known): what applying leaves, and nobody read it off a photo.
    if (ledgerMoms.source === "typed") return { value: ledgerMoms.value, read: false, moved: false };
    if (fits) return { value: ledgerMoms.value, read: true, moved: false };
    return { value: momsFor(cardSaveTotal), read: false, moved: ledgerMoms.recomputed, oneTill: ledgerMoms.oneTill };
  })();

  // ─── Nothing above the box being typed in moves while typing ─────────
  // The card's hints are worked out on every keystroke ("i alt er 2 kr.",
  // "Rettet ned i hånden −20.128 kr." on the way to 20.130,50) and mounted
  // above the boxes. While a box on the card has focus they hold what they
  // said when typing began; leaving the box shows the final state once.
  // The hints as they were when a box on the card took focus (null: live).
  // A hint that comes and goes with every keystroke above the box being
  // typed in moved that box 138–174 px under the caret on a phone; held, it
  // settles once, when the owner leaves the box.
  // The wizard's steps hold the same way: the "two tills added together"
  // summary sits above every step's boxes, and its "Stod kun på den ene bon"
  // notice turned into the longer "Dine egne tal …" on the first keystroke
  // in Kontant — the box moved 16 px under the caret on a phone. A hold is
  // for the screen it was taken on: a step or the card left with a box still
  // focused (no blur) never holds the next one.
  const [cardHeld, setCardHeld] = useState(null);
  const heldHere = `${scanMode}|${step}`;
  const held = (scanMode === "result" || scanMode === "skipped") && cardHeld?.at === heldHere ? cardHeld : null;
  const cardGapLive = (() => {
    if (!scanResult) return null;
    const hasTotal = (scanResult.revenue_total || 0) > 0;
    // Lines that add up to the total ARE the split: an empty Takeaway was 0
    // that night, not something to ask for. The owner's own till on the card
    // (a typed close, a reopened draft): its categories are theirs, not
    // "found on this bon", and the bon's unsplit part is the "Ikke fordelt"
    // line — no category is asked for.
    if (!hasTotal || scanRevComplete || !cardIsRead || cardOwnTill) return null;
    // Found = read off the photo; a line the owner typed is not.
    const detected = defaultRevCats.filter((c) => readOnCard(`revenue.${c.key}`, scanResult.revenue?.[c.key])).length;
    const missing = defaultRevCats
      .filter((c) => { const v = scanResult.revenue?.[c.key]; return !(v != null && v !== 0 && v !== ""); })
      .map((c) => String(catLabel(t, c) || "").split(" / ")[0]);
    if (!missing.length) return null;
    // The total the box shows and the day saves — it said "i alt er 20.030"
    // beside a box reading 20.130.
    return { detected, missing, allEmpty: detected === 0, amount: cardSaveTotal > 0 ? cardSaveTotal : scanResult.revenue_total };
  })();
  const cardLive = {
    gap: cardGapLive,
    unsplit: { amount: cardUnsplit, show: cardSaveTotal > 0, decimals: pairDecimals(cardSaveTotal, cardUnsplit) },
    reads: tillReads,
    mergeNow: cardSaveTotal > 0 ? cardSaveTotal : null,
    mergeNames: mergeIncompleteNames,
    // What the wizard's summary says the day saves ("Med dine rettelser …").
    wizardNow: revenueKnown ? savedRevenue : null,
  };
  const cardShown = held || cardLive;
  const cardGap = cardShown.gap;
  // The "Ikke fordelt" line sits BELOW the category boxes: typing a category
  // moves nothing above the caret, so it follows each keystroke there (held,
  // the lines, the unsplit figure and the total did not add up while typing).
  // Held only for the boxes below it (the total, payments, tips).
  const cardUnsplitShown = (held && !held.unsplitLive ? held : cardLive).unsplit;
  const heldReads = cardShown.reads;
  const heldMergeNow = cardShown.mergeNow;
  const heldMergeNames = cardShown.mergeNames;
  // Focus moving straight on from one box to the next (Tab, a tap on the
  // next box) keeps the hold (round 22): released on the blur and taken again
  // on the focus, a line the box just left added ("ikke lagt sammen: …",
  // "Med dine rettelser …") appeared above the box now focused and pushed it
  // down 20–52 px. It settles once focus leaves the boxes (Næste, a tap
  // outside) — or the step changes.
  const onCardFocus = (e) => {
    if (e.target?.tagName !== "INPUT") return;
    const unsplitLive = String(e.target.id || "").startsWith("scan-rev-");
    setCardHeld((prev) => (prev && prev.moving && prev.at === heldHere
      ? { ...prev, moving: false, unsplitLive }
      : { ...cardLive, at: heldHere, unsplitLive }));
  };
  const onCardBlur = (e) => {
    if (e.target?.tagName !== "INPUT") return;
    const next = e.relatedTarget;
    if (next && next.tagName === "INPUT" && e.currentTarget?.contains?.(next)) {
      setCardHeld((prev) => (prev ? { ...prev, moving: true } : prev));
      return;
    }
    setCardHeld(null);
  };

  // The card differs from the draft that is filed (or about to be): its
  // figures are saved by applying it, and it says so.
  const cardUnsaved = scanMode === "result" && Boolean(scanResult) && Boolean(filedLedgerRef.current)
    && ledgerRecordSig(ledger) !== ledgerRecordSig(filedLedgerRef.current);

  // "Det nye billede blev ikke brugt · Fortryd" — on the card, or on the
  // scan's start when the thrown-away photo was the only one in the day.
  const droppedNote = undoStep === "drop" ? (
    <div className="rounded-xl p-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/40 text-sm flex items-center justify-between gap-3" data-testid="dc-scan-dropped">
      <span className="text-gray-700 dark:text-gray-200 inline-flex items-center gap-1.5">
        <Icon name="X" size={15} />
        {t("dcScanPhotoDropped", "The new photo was not used.")}
      </span>
      <button onClick={undoMerge}
        className="min-h-10 text-xs text-gray-500 dark:text-gray-400 underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200">
        {t("scanMergedUndo", "Undo")}
      </button>
    </div>
  ) : null;

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
  const renderMergeSummary = ({ withUndo = false, nowTotal = null } = {}) => {
    if (scanResult?.merge_info?.mode !== MERGE_SUM) return null;
    const info = scanResult.merge_info;
    const mergedTillSum = Math.round((info.terminalTotals || []).reduce((a, v) => a + (Number(v) || 0), 0) * 100) / 100;
    // What THIS surface saves (the card's total, or the form's): the bons'
    // printed sum would read as a correction nobody made.
    const typedTotal = Boolean(scanResult.revenue_total_text);
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
          {/* Its own step only: after "brug det ikke" this Fortryd undid the
              drop (the thrown-away photo's question came back, the sum stayed). */}
          {withUndo && canUndoChoice && undoStep !== "drop" && (
            <button onClick={undoMerge}
              className="text-xs text-gray-500 dark:text-gray-400 underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200">
              {t("scanMergedUndo", "Undo")}
            </button>
          )}
        </div>
        {/* The sum of the tills, always — after "=" it printed the box's
            current figure, so a later hand edit made "16.450 + 5.000 =
            16.500". A total corrected after the sum is said on its own line. */}
        <div className="text-xs text-gray-600 dark:text-gray-300">
          {(info.terminalTotals || []).map((v) => formatOwnerMoney(v, currency, { decimals: oreIfAny(v) })).join("  +  ")}
          {" = "}
          <strong>{formatOwnerMoney(mergedTillSum, currency, { decimals: oreIfAny(mergedTillSum) })}</strong>
        </div>
        {nowTotal != null && Math.abs(nowTotal - mergedTillSum) >= 0.01 && (
          <p className="text-xs text-gray-600 dark:text-gray-300">
            {typedTotal
              ? t("dcMergeCorrectedTo", "You corrected the total to {amount}", {
                  amount: formatOwnerMoney(nowTotal, currency, { decimals: oreIfAny(nowTotal) }),
                })
              // A category changed since the sum, not the total.
              : t("dcMergeNowSaves", "With your corrections the day saves {amount}", {
                  amount: formatOwnerMoney(nowTotal, currency, { decimals: oreIfAny(nowTotal) }),
                })}
          </p>
        )}
        {/* Honest about what could NOT be added, BY NAME. "Terminal 2's MOMS
            line was unreadable" and "terminal 2 had no MOMS" look the same on
            a photo, so we say which lines instead of inventing a sum. */}
        {heldMergeNames.read.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("scanMergedIncompleteNamed", "Only on one of the receipts, so not added up: {fields}. Check them before you lock.", {
              fields: heldMergeNames.read.join(", "),
            })}
          </p>
        )}
        {heldMergeNames.own.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("scanMergedIncompleteOwn", "Your own figures that were not on the new receipt are not added up: {fields}. Check them before you lock.", {
              fields: heldMergeNames.own.join(", "),
            })}
          </p>
        )}
      </div>
    );
  };

  // "There's already a close for this day" — on the scan screen too. It
  // only appeared after a photo had been read, so a locked day offered a
  // camera whose numbers could never be saved, and a draft was found only
  // once the new figures were on screen.
  // The day's draft was saved somewhere else since this form read it, and a
  // save was refused for it (round 21). The owner says which wins: the
  // newest draft (opened fresh, by id — what was typed here goes) or theirs
  // (sent again on that newer version, saved over it). Never decided in
  // silence either way.
  const conflictHere = Boolean(draftConflict) && draftConflict.key === rowKey;
  // The question is rendered at the top of the wizard (or the card), and on
  // the review step that is 500–1.200 px above Noter and "Bekræft & lås":
  // a refused lock changed only the off-screen card (round 22). Raised by a
  // lock TAP it is brought into view and takes focus (nothing is being
  // typed); raised by an autosave it never steals the caret — the fixed
  // save slot says "Ikke gemt" and brings it into view on a tap.
  const draftConflictBoxRef = useRef(null);
  const showDraftConflict = () => {
    const el = draftConflictBoxRef.current;
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    el?.focus?.({ preventScroll: true });
  };
  // Round 23 — raised by an autosave while the owner types, the question is
  // put in above the field being typed in: it pushed that field 209–361 px
  // down (under the phone's bottom bar at 390). Inserted, the page scrolls
  // by exactly its height in the same frame, so the focused field stays
  // where it was; the amber "Ikke gemt" slot brings the question into view
  // on a tap. The same for the day's lock banner arriving while typing.
  // Round 23 review — by how far the field MOVED, not by the box's height:
  // inserted above the viewport (the review step, 500–1.200 px below), the
  // browser's own scroll anchoring (Chrome, Firefox, Android) already keeps
  // the field in place, and scrolling by the height on top moved it up under
  // the header. Measured before the commit that inserts the box (the render
  // that raises it — `typingTopRef`) and after it, in the same frame: 0 when
  // the browser anchored, the full shift where it does not (iOS WebKit).
  const typingTopRef = useRef(null);
  const typingField = () => {
    if (typeof document === "undefined") return null;
    const f = document.activeElement;
    return f && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName) ? f : null;
  };
  const noteTypingTop = () => {
    if (typingTopRef.current != null) return;
    const f = typingField();
    try { typingTopRef.current = f ? { el: f, top: f.getBoundingClientRect().top } : null; } catch { typingTopRef.current = null; }
  };
  const keepFocusedInPlace = (box) => {
    const before = typingTopRef.current;
    typingTopRef.current = null;
    if (!box || !before) return;
    const f = typingField();
    if (!f || f !== before.el) return;
    // Only a field BELOW the inserted box moves.
    if (!(box.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
    let shift = 0;
    try { shift = f.getBoundingClientRect().top - before.top; } catch { shift = 0; }
    if (Math.abs(shift) >= 1) window.scrollBy?.(0, shift);
  };
  const conflictWhileTyping = conflictHere && draftConflict?.via !== "lock";
  const conflictShownRef = useRef(false);
  // (The render that puts the question in: where the field is now.)
  if (conflictWhileTyping && !conflictShownRef.current) noteTypingTop();
  useLayoutEffect(() => {
    const was = conflictShownRef.current;
    conflictShownRef.current = conflictWhileTyping;
    if (conflictWhileTyping && !was) keepFocusedInPlace(draftConflictBoxRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflictWhileTyping]);
  useEffect(() => {
    if (!conflictHere || draftConflict?.via !== "lock") return undefined;
    if (typeof window.requestAnimationFrame === "function") {
      const raf = window.requestAnimationFrame(showDraftConflict);
      return () => window.cancelAnimationFrame?.(raf);
    }
    const timer = setTimeout(showDraftConflict, 0);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftConflict, conflictHere]);
  const reloadNewestDraft = () => {
    const c = draftConflict;
    if (!c) return;
    const row = c.current && c.current.id != null ? c.current
      : (existingCloses || []).find((dc) => closeRowKey(dc) === c.key && !dc.is_deleted) || null;
    // What was waiting to be sent for the day is not sent over it.
    clearTimeout(autoSaveRef.current);
    pendingSaveRef.current = null;
    if (!row) { setDraftConflict(null); onDraftSaved?.(); return; }
    // Deleted or LOCKED elsewhere since (round 22, the removal audit's #11):
    // nothing opens, so the question is answered by the day itself — never a
    // button that does nothing while the "already locked" banner stays
    // hidden behind it. Locked: the day is a locked day here (its banner,
    // with the amount once History is read again).
    Promise.resolve(onContinueDraft?.(row)).then((outcome) => {
      if ((outcome !== "gone" && outcome !== "locked") || !mountedRef.current) return;
      setDraftConflict((cur) => (cur && cur.key === c.key ? null : cur));
      if (outcome === "locked" && c.key === rowKeyRef.current) setLockedRowRejected(true);
      onDraftSaved?.();
    }).catch(() => { /* the open itself fell back to the listed row, or reloaded History */ });
  };
  const keepMyDraft = () => {
    const c = draftConflict;
    if (!c) return;
    // Nothing of the owner's on this screen to save (everything thrown away
    // since, Start forfra): there is no "mine" to put over that draft, and it
    // is not this form's to delete. The day's banner shows it — continue it,
    // or start over (which replaces it) — never an empty form over a stored
    // draft in silence.
    const nothingHere = c.via !== "lock" && !filesSomething(savedRevenue, paymentTotal)
      && !hasScanTills(ledger) && !ledger.pending.length;
    if (nothingHere) {
      delete baseRef.current[c.key];
      delete ownRowsRef.current[c.key];
      setOwnDraftKeys((prev) => { if (!prev.has(c.key)) return prev; const n = new Set(prev); n.delete(c.key); return n; });
      setDraftConflict(null);
      onDraftSaved?.();
      return;
    }
    // Sent again on the version it met: the owner's figures are saved over it.
    baseRef.current[c.key] = c.stamp || baseRef.current[c.key] || null;
    if (c.current) {
      // What the server holds for the day now (its photo, its source): ""
      // never clears a photo this form did not file.
      serverSrcRef.current[c.key] = {
        meta: c.current.source_meta && typeof c.current.source_meta === "object" ? c.current.source_meta : null,
        photo: c.current.receipt_photo || null,
      };
      if (!ownRowsRef.current[c.key] && c.current.id != null) ownRowsRef.current[c.key] = { id: c.current.id, row: c.current };
      // That version's photo goes with it (round 21 review): kept, a 15.000
      // Z-bon stood as the source document of a 3.500 typed day. The form's
      // own photo replaces it; with none, "" clears it (the server keeps its
      // path in the audit row). The banner says so before the tap.
      if (c.current.receipt_photo && !receiptPhotoUrl) filedPhotosRef.current.add(c.current.receipt_photo);
    }
    // The stored source is that other version's ("rettet af ejeren: Mad,
    // MobilePay" for corrections not on this form): the form says its own
    // again — a null would keep theirs beside the owner's figures.
    filedScanKeysRef.current.add(c.key);
    // The day's draft is the form's own from here: the "there is already a
    // draft" banner does not stand in front of the save the owner chose.
    setOwnDraftKeys((prev) => (prev.has(c.key) ? prev : new Set(prev).add(c.key)));
    setDraftConflict(null);
    if (c.via === "lock") { handleSubmit(); return; }
    sendNowRef.current = true;
    requestRefile(true);
  };
  const conflictFigure = (() => {
    const cur = draftConflict?.current;
    if (!cur) return "";
    if (isPaymentsOnly(cur)) {
      const p = paymentsOf(cur);
      return t("dcDraftFigurePaymentsOnly", "only payments of {amount}", { amount: formatOwnerMoney(p, currency, { decimals: oreDecimals(p) }) });
    }
    return formatOwnerMoney(Number(cur.revenue_total) || 0, currency, { decimals: oreDecimals(cur.revenue_total) });
  })();
  const draftConflictEl = conflictHere ? (
    <div data-testid="dc-draft-changed" className="mb-4 rounded-xl focus:outline-none" ref={draftConflictBoxRef} tabIndex={-1}>
      <SectionBanner severity="warn" icon="AlertTriangle"
        title={t("dcDraftChangedTitle", "The draft was saved somewhere else")}>
        {conflictFigure
          ? t("dcDraftChangedBody", "The draft for {date} was saved somewhere else after you opened it (another phone or tab — or just before you left the page). The saved draft has {amount} — nothing was overwritten. Load the newest draft, or keep your numbers and they are saved over it.", {
            date: formatDateClear(String(draftConflict.key).slice(0, 10)) || String(draftConflict.key).slice(0, 10),
            amount: conflictFigure,
          })
          : t("dcDraftChangedBodyNoAmount", "The draft for {date} was saved somewhere else after you opened it. Nothing was overwritten. Load the newest draft, or keep your numbers and they are saved over it.", {
            date: formatDateClear(String(draftConflict.key).slice(0, 10)) || String(draftConflict.key).slice(0, 10),
          })}
        {/* Its photo goes with it on "keep" (keepMyDraft): said before the tap. */}
        {draftConflict.current?.receipt_photo && !receiptPhotoUrl
          && (draftConflict.via === "lock" || filesSomething(savedRevenue, paymentTotal) || hasScanTills(ledger) || ledger.pending.length > 0) && (
          <span className="block mt-1" data-testid="dc-draft-changed-photo">
            {t("dcDraftChangedPhotoGoes", "Keeping your numbers also takes its Z-bon photo off the day.")}
          </span>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="md" variant="primary" onClick={reloadNewestDraft}>{t("dcDraftChangedReload", "Load the newest draft")}</Button>
          <Button size="md" variant="secondary" onClick={keepMyDraft}>
            {draftConflict.via === "lock" ? t("dcDraftChangedKeepLock", "Keep my numbers and lock") : t("dcDraftChangedKeep", "Keep my numbers")}
          </Button>
        </div>
      </SectionBanner>
    </div>
  ) : null;
  // Round 23 — scanning needs the server (the photo is read there): offline,
  // every way to a scan is gray and says why. Typing works as always (queued,
  // never lost).
  const scanOffline = isOnline === false;
  const scanOfflineEl = scanOffline ? (
    <p id="dc-scan-offline" role="status" data-testid="dc-scan-offline"
      className="text-[13px] text-amber-800 dark:text-amber-200 flex items-start gap-1.5">
      <Icon name="Info" size={14} className="shrink-0 mt-0.5" />
      <span>{t("dcScanNeedsInternet", "Scanning needs internet — type the figures in, or scan when you're back online")}</span>
    </p>
  ) : null;
  // The day's banner (a lock met while typing — round 22 — arrives above the
  // field being typed in): kept from moving the field like the question.
  const existingBannerBoxRef = useRef(null);
  const lockWhileTyping = Boolean(lockedRowRejected) && existingBlocks && !conflictHere;
  const lockShownRef = useRef(false);
  if (lockWhileTyping && !lockShownRef.current) noteTypingTop();
  useLayoutEffect(() => {
    const was = lockShownRef.current;
    lockShownRef.current = lockWhileTyping;
    if (lockWhileTyping && !was) keepFocusedInPlace(existingBannerBoxRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockWhileTyping]);
  // Start forfra could not be done (round 23): said where it was tapped —
  // and only there (round 23 review: keyed to the day it was tapped for; it
  // showed under another day's banner, or a later scan card).
  const startOverFailedFor = (k) => (startOverFailed && k && startOverFailed.key === k ? (
    <p role="alert" data-testid="dc-start-over-failed" data-outcome={startOverFailed.outcome}
      className="mt-2 text-[13px] text-red-700 dark:text-red-300 flex items-start gap-1.5">
      <Icon name="AlertTriangle" size={14} className="shrink-0 mt-0.5" />
      <span>
        {startOverFailed.outcome === "offline"
          ? t("dcStartOverNotDeletedOffline", "The draft was not deleted — there is no connection. Try again when you're online.")
          : startOverFailed.outcome === "changed"
            ? (startOverFailed.amount
              ? t("dcStartOverNotDeletedChanged", "Not deleted — the draft was saved on another device meanwhile (now {amount}). Continue it, or start over again.", { amount: startOverFailed.amount })
              : t("dcStartOverNotDeletedChangedNoAmount", "Not deleted — the draft was saved on another device meanwhile. Continue it, or start over again."))
            : startOverFailed.outcome === "locked"
              ? t("dcStartOverNotDeletedLocked", "Not deleted — the day was locked on another device.")
              : t("dcStartOverNotDeleted", "The draft was not deleted. Try again.")}
      </span>
    </p>
  ) : null);
  // A day moved to (or another branch picked, or a draft loaded): what Start
  // forfra said about another day is not said here any more.
  useEffect(() => { setStartOverFailed(null); }, [businessDate, branchId]);
  const existingBannerEl = existingBlocks && !conflictHere ? (
          <div ref={existingBannerBoxRef} className="mb-4">
          <SectionBanner
            severity={existingLocked ? "info" : "warn"}
            icon={existingLocked ? "Lock" : "FileText"}
            title={existingLocked
              ? t("dcDayAlreadyLocked", "This day is already closed and locked")
              : t("dcDayHasDraft", "There's already a draft for this day")}
          >
            {existingBranchName && <span className="font-semibold">{existingBranchName}: </span>}
            {existingLocked
              ? (existingForDate.revenue_total == null
                // Locked elsewhere, History not read again yet: no amount.
                ? t("dcDayLockedNoAmount", "This day is already locked — unlock it from History first if it needs correcting.")
                : t("dcDayAlreadyLockedBody", "Locked at {amount} — to correct it, unlock it from History first.", { amount: formatOwnerMoney(existingForDate.revenue_total ?? 0, currency, { decimals: oreDecimals(existingForDate.revenue_total) }) }))
              // A draft of payments only (no revenue): said as such, never
              // "Gemt med 0 kr.".
              : isPaymentsOnly(existingForDate)
                ? t("dcDayHasDraftBodyPaymentsOnly", "Saved with only payments of {amount} — continue it, or start over, which deletes it.", { amount: formatOwnerMoney(paymentsOf(existingForDate), currency, { decimals: oreDecimals(paymentsOf(existingForDate)) }) })
                : t("dcDayHasDraftBody", "Saved at {amount} — continue it, or start over, which deletes it.", { amount: formatOwnerMoney(existingForDate.revenue_total ?? 0, currency, { decimals: oreDecimals(existingForDate.revenue_total) }) })}
            <div className="mt-3 flex flex-wrap gap-2">
              {existingLocked ? (
<>
                <Button size="md" variant="secondary" onClick={() => onShowHistory?.(existingForDate?.id)}>{t("dcOpenHistory", "Open History")}</Button>
                {showScanUI && (
                  <Button size="md" variant="secondary" onClick={() => {
                    setScanMode("skipped"); setStep(1);
                    setTimeout(() => document.getElementById("close-date")?.focus(), 60);
                  }}>{t("dcPickAnotherDay", "Pick another day")}</Button>
                )}
                </>
              ) : (<>
                <Button size="md" variant="primary" disabled={startOverBusy} onClick={() => onContinueDraft?.(existingForDate)}>{t("dcContinueDraft", "Continue the draft")}</Button>
                {/* Round 23: deletes that draft — asked first, done by the
                    server on the version shown (startOverDay). */}
                <Button size="md" variant="secondary" disabled={startOverBusy} onClick={() => startOverDay("banner")}>
                  {startOverBusy ? t("dcStartOverDeleting", "Deleting the draft…") : t("dcStartOverDraft", "Start over")}
                </Button>
              </>)}
            </div>
            {startOverFailedFor(existingForDate ? closeRowKey(existingForDate) : null)}
          </SectionBanner>
          </div>
  ) : null;
  const businessDateLabel = new Date(businessDate + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long" });

  return (
    <div ref={formTopRef} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden scroll-mt-16">
      {/* ─── Close anomaly double-check (close_sanity soft guard) ───
          Shown when today's total is far off the recent same-weekday
          baseline — catches a misread Z-report total before it locks. */}
      {anomalyCheck && (
        <CloseAnomalyDialog
          t={t}
          currency={currency}
          anomaly={anomalyCheck}
          saving={saving}
          // A past day's double-check names the day it locks.
          dateLabel={businessDate !== businessTodayIso(cutoffHour) ? formatDateClearFull(businessDate) : ""}
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

        {/* The day's draft changed elsewhere (a save was refused): asked on the
            scan card too — the card's figures are not filed until answered. */}
        {(scanMode === "result" || scanMode === "scanning") && draftConflictEl}
        {/* Locked on another device (a save of the day met the lock): said on
            the card too — its figures can no longer be filed for the day. */}
        {(scanMode === "result" || scanMode === "scanning") && lockedRowRejected && existingBannerEl}

        {/* ─── SCAN BANNER (Step 0) ─── */}
        {scanMode === "idle" && (
          <div className="space-y-4">
            <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
              <Icon name="Calendar" size={14} className="text-gray-500 dark:text-gray-400" />
              {t("dcCloseForDate", "Kasserapport for {date}", { date: businessDateLabel })}
            </p>
            {draftConflictEl}
            {existingBannerEl}
            {/* The only photo thrown away with "brug det ikke": back here, and
                as undoable as on the card. */}
            {droppedNote}
            {!existingBlocks && (<>
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
                  disabled={scanOffline}
                  aria-describedby={scanOffline ? "dc-scan-offline" : undefined}
                  onClick={() => { if (fileInputRef.current) { fileInputRef.current.setAttribute("capture", "environment"); fileInputRef.current.click(); } }}
                  iconLeft={<Icon name="Image" size={16} />}>
                  {t("takePhoto", "Take Photo")}
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full sm:w-auto"
                  disabled={scanOffline}
                  aria-describedby={scanOffline ? "dc-scan-offline" : undefined}
                  onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
                  iconLeft={<Icon name="FolderOpen" size={16} />}>
                  {t("uploadImage", "Upload Image")}
                </Button>
              </div>
              {scanOfflineEl}
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
                <Chip size="sm" className="min-h-10" selected={scanMomsMode === "with-moms"} onClick={() => setScanMomsMode("with-moms")}>
                  {t("withVatGross", "with {vat} (gross)", { vat: vatName })}
                </Chip>
                <Chip size="sm" className="min-h-10" selected={scanMomsMode === "without-moms"} onClick={() => setScanMomsMode("without-moms")}>
                  {t("withoutVatNet", "without {vat} (net)", { vat: vatName })}
                </Chip>
              </div>
            </div>
            {/* Upload zone — desktop only: a phone has nothing to drag, and it
                repeated the two buttons right above it. */}
            <div className={"hidden sm:block border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-6 text-center transition-colors " + (scanOffline ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:border-gray-300 dark:hover:border-gray-300")}
              aria-disabled={scanOffline || undefined}
              onClick={() => { if (scanOffline) return; if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
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
              <button onClick={() => { setScanMode("skipped"); setStep(1); revealStepTop(); }}
                className="inline-flex items-center min-h-10 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline underline-offset-2 transition">
                {t("skipEnterManually", "Skip — enter manually")}
              </button>
            </div>
            </>)}
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
          <div className="space-y-5" onFocus={onCardFocus} onBlur={onCardBlur}>
            {/* The day the scan is for — the idle card said it, the result
                card dropped it until Trin 5. */}
            <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5" data-testid="dc-scan-result-date">
              <Icon name="Calendar" size={14} className="text-gray-500 dark:text-gray-400" />
              {t("dcCloseForDate", "Kasserapport for {date}", { date: businessDateLabel })}
            </p>
            {/* A photo that could not be read, or one already in the day, is
                said here too — on the card it was added from. */}
            {scanError && (
              <p role="status" className="text-[13px] text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-3 py-2">
                {scanError}
              </p>
            )}
            {/* ─── "Another terminal, or a better photo?" ───────────────
                The only question we ask, asked only when it is real: both
                scans carry a headline total, so the numbers either ADD UP
                or REPLACE and we cannot tell which. One tap either way,
                with both totals on the buttons so the owner answers by
                looking at the numbers, not by parsing a sentence. Nothing
                is merged until they answer. */}
            {pendingScan && (() => {
              // What each card SAVES — the figure "du gemmer" on the card —
              // not its printed total: a Mad corrected to 9.500 on a 17.030
              // bon is 17.530 on screen, and the sum must carry it.
              const existingTotal = ledgerSaved;
              const incomingTotal = scanSaveTotal(pendingScan, mLocale) ?? headlineTotal(pendingScan, mLocale);
              // Øre as on the form: "14.000,50 kr.", never a rounded "14.001".
              const qDec = pairDecimals(existingTotal, incomingTotal, (existingTotal || 0) + (incomingTotal || 0));
              return (
                <div ref={terminalQRef} tabIndex={-1} role="group" aria-labelledby="dc-terminal-q"
                  data-testid="dc-terminal-question"
                  className="rounded-xl p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 space-y-3 scroll-mt-20 focus:outline-none">
                  <p id="dc-terminal-q" className="text-sm font-semibold text-amber-900 dark:text-amber-100 flex items-center gap-1.5">
                    <Icon name="HelpCircle" size={16} />
                    {t("scanSecondTotalTitle", "Is this another terminal?")}
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    {t("scanSecondTotalBody", "This scan has its own total of {incoming}. The one on screen is {existing}.", {
                      incoming: formatOwnerMoney(incomingTotal, currency, { decimals: qDec }),
                      existing: formatOwnerMoney(existingTotal, currency, { decimals: qDec }),
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
                    <Button variant="primary" size="sm" className="flex-1 h-auto! min-h-11 py-2 whitespace-normal! text-left leading-snug"
                      onClick={() => resolveTerminalChoice(MERGE_SUM)}
                      iconLeft={<Icon name="Plus" size={15} />}>
                      {t("scanSecondTotalSum", "Another terminal — add them up ({sum})", {
                        sum: formatOwnerMoney((existingTotal || 0) + (incomingTotal || 0), currency, { decimals: qDec }),
                      })}
                    </Button>
                    <Button variant="secondary" size="sm" className="flex-1 h-auto! min-h-11 py-2 whitespace-normal! text-left leading-snug"
                      onClick={() => resolveTerminalChoice(MERGE_REPLACE)}
                      iconLeft={<Icon name="RefreshCw" size={15} />}>
                      {t("scanSecondTotalReplace", "Same terminal — use the new photo ({incoming})", {
                        incoming: formatOwnerMoney(incomingTotal, currency, { decimals: qDec }),
                      })}
                    </Button>
                  </div>
                  {/* A retake of a bon already in the day (a new photo of the
                      same paper) had no right answer: "add" counted it twice,
                      "same terminal" dropped every other till. The photo goes;
                      the day stays exactly as it was. */}
                  <Button variant="ghost" size="sm" className="w-full h-auto! min-h-11 py-2 whitespace-normal! text-left leading-snug"
                    onClick={dropWaitingPhoto}
                    iconLeft={<Icon name="X" size={15} />}>
                    {t("dcScanSamePhotoDiscard", "It's the same photo — don't use it")}
                  </Button>
                </div>
              );
            })()}

            {!pendingScan && renderMergeSummary({ withUndo: true, nowTotal: heldMergeNow })}
            {/* The photo thrown away — as undoable as an answer. */}
            {!pendingScan && droppedNote}
            {/* "Same terminal" replaced the figures — as undoable as a sum. */}
            {!pendingScan && canUndoChoice && undoStep !== "drop" && scanResult?.merge_info?.mode === MERGE_REPLACE && (
              <div className="rounded-xl p-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800/40 text-sm flex items-center justify-between gap-3">
                <span className="text-gray-700 dark:text-gray-200 inline-flex items-center gap-1.5">
                  <Icon name="RefreshCw" size={15} />
                  {t("scanReplacedWithNew", "Using the new photo ({total})", { total: formatOwnerMoney(ledgerSaved, currency, { decimals: oreIfAny(ledgerSaved) }) })}
                </span>
                <button onClick={undoMerge}
                  className="text-xs text-gray-500 dark:text-gray-400 underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200">
                  {t("scanMergedUndo", "Undo")}
                </button>
              </div>
            )}
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
              {cardIsRead && heldReads.length > 0 && (
              <span className="flex flex-wrap gap-1.5" data-testid="dc-scan-confidence">
              {heldReads.map((detected, i) => (
              <span key={i} className={`text-[12px] font-medium px-3 py-1 rounded-full ${
                // Few fields read is "check this" (amber), not money lost (red).
                detected >= 5 ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                  : "bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300"
              }`}>
                {/* Several tills: whose read this is ("Bon 2"). */}
                {severalTills && <span className="font-semibold">{t("dcScanBonN", "Receipt {n}:", { n: i + 1 })} </span>}
                {/* confidenceLevel*, not confidence*. The template already ends
                    in the noun ("… sikkerhed — 5/7 felter"), and the standalone
                    pill keys carry it too, so interpolating one into the other
                    printed "Høj sikkerhed sikkerhed — 5/7 felter" to every
                    Danish owner who scanned a kasserapport. The bare level word
                    has its own three keys now. */}
                <Icon name="Target" size={14} className="inline align-text-bottom mr-1" /> {t("scanConfidenceLevel", "{level} confidence — {detected}/{total} fields detected", {
                  level: detected >= 5 ? t("confidenceLevelHigh", "High") : detected >= 3 ? t("confidenceLevelMedium", "Medium") : t("confidenceLevelLow", "Low"),
                  detected,
                  total: scanFieldsTotal,
                })}
              </span>
              ))}
              </span>
              )}
            </div>

            {/* Detection-gap banner — fires when the total is detected
                but ANY revenue category is missing or zero. Two flavors:
                  • "all empty"   → save total via revenue_total_override
                  • "partial"     → tell owner which categories to fill
                Both keep the close save-able instead of silently writing
                the wrong number (was the original bug). */}
            {cardGap && (
                <div className="rounded-xl p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200 space-y-1">
                  <div>
                    <Icon name="Info" size={14} className="inline align-text-bottom mr-1" /> <strong>
                      {cardGap.allEmpty
                        ? t("scanGapNoBreakdown", "We couldn't detect the per-category breakdown")
                        : t("scanGapDetectedSome", "We detected {detected} of {total} revenue categories", { detected: cardGap.detected, total: defaultRevCats.length })}
                    </strong>
                    {" "}{t("scanGapTotalIs", "from this receipt — total is {amount}", { amount: formatOwnerMoney(cardGap.amount, currency, { decimals: oreIfAny(cardGap.amount) }) })}
                  </div>
                  <div className="text-xs opacity-90">
                    {cardGap.allEmpty
                      ? t("scanGapSavingTotal", "Saving the total revenue anyway. Enter the per-category split below if you need it for reports.")
                      : <>{t("scanGapEnterActualFor", "Please enter the actual amount for:")} <strong>{cardGap.missing.join(", ")}</strong>. {t("scanGapOrSkip", "Or skip — the total above will save correctly either way.")}</>}
                  </div>
                </div>
            )}

            {/* Revenue (med moms) */}
            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-3">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
                {t("revenueMedMoms", "Revenue (med moms)")}
              </h3>
              {cardRevCats.map(c => {
                const val = scanResult.revenue?.[c.key];
                const isEmpty = !val && !scanRevComplete && cardIsRead && !cardOwnTill;
                return (
                  <div key={c.key} className="flex flex-col items-stretch gap-1 sm:flex-row sm:items-center sm:gap-3">
                    {/* Icons and badges keep their size; the label gives way. In the
                        fixed-width column a "missing" row squeezed its icons to 0px. */}
                    <span className="text-sm sm:w-52 sm:shrink-0 flex items-center gap-2 min-w-0 dark:text-gray-300">
                      {val ? <Icon name="Check" size={14} className="text-emerald-600 shrink-0" /> : <span className="text-gray-500 dark:text-gray-400 shrink-0">—</span>}
                      <Icon name={c.icon} size={14} className="shrink-0 text-gray-500 dark:text-gray-400" /> <span className="min-w-0 truncate">{catLabel(t, c)}</span>
                      {readOnCard(`revenue.${c.key}`, val) && <span className="shrink-0 text-[11px] font-medium px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg">{t("scanBadgeRead", "read")}</span>}
                      {isEmpty && <span className="shrink-0 text-[11px] font-medium px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-lg">{t("scanBadgeMissing", "missing")}</span>}
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
                    <CardMoneyField
                      id={`scan-rev-${c.key}`}
                      locale={mLocale}
                      // The field IS the flex child of the row above, so the
                      // wrapper has to carry the growth or the box collapses.
                      wrapperClassName="flex-1 min-w-0"
                      className={`${inputClass} ${isEmpty ? "border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/10" : ""}`}
                      value={asBox(val)}
                      placeholder={isEmpty ? t("enterActualAmount", "enter actual amount") : ""}
                      onChange={e => act(typeIntoForm, `revenue.${c.key}`, e.target.value)} />
                  </div>
                );
              })}
              {/* The card's lines add up to the total it saves: the part no
                  category carries (a bon read as a total) is its own line. */}
              <UnsplitLine amount={cardUnsplitShown.amount} show={cardUnsplitShown.show} currency={currency} t={t}
                decimals={cardUnsplitShown.decimals} />
              {/* Money on this card goes through formatOwnerMoney. It used to
                  be a bare `toLocaleString() + currency code`, which uses the
                  BROWSER locale: a Danish owner on an English phone read
                  17.030 kr as "17,030 DKK", and in Danish the comma is the
                  DECIMAL separator — seventeen kroner. This is the figure the
                  "another terminal?" question is asked about, so it has to be
                  the one the owner would recognise. */}
              {/* The scanned TOTAL is editable. The close saves the larger of
                  this and the categories (so a half-read breakdown never saves
                  too little), which made a misread total impossible to correct
                  DOWNWARD: 17.300 read for 17.030 stayed 17.300 whatever the
                  owner typed in the categories. Now the owner fixes the total
                  itself. Kept as typed (like the category boxes) and read by
                  the strict parser; an unreadable entry blocks the save. */}
              {(scanResult.revenue_total || scanResult.revenue_total_text != null) && (<>
                <div className="flex items-center justify-between gap-3 pt-2 border-t border-gray-200 dark:border-gray-600">
                  <label htmlFor="scan-total" className="text-[14px] font-semibold text-gray-900 dark:text-white">
                    {t("totalRevenue")}
                  </label>
                  {/* The total this card SAVES. Categories raised past the
                      bon's total are saved, so the box follows them — it
                      kept "17.030" beside a MOMS and a note for 17.130. The
                      bon's own figure is said on the line below. */}
                  <CardMoneyField
                    id="scan-total"
                    locale={mLocale}
                    wrapperClassName="w-40 shrink-0"
                    className={`${inputClass} font-semibold`}
                    value={scanResult.revenue_total_text ?? asBox(cardSaveTotal > 0 ? cardSaveTotal : scanResult.revenue_total)}
                    // The printed figure is kept once the owner types over it
                    // (bon_total): the card says how far the saved total is
                    // off it. On a day of several tills the difference goes
                    // to the owner's own till, or the last.
                    onChange={(e) => act(typeIntoForm, "revenue_total", e.target.value)}
                    {...(scanTotalEmptied ? { "aria-invalid": true, "aria-describedby": "scan-total-empty" } : {})}
                  />
                </div>
                {scanTotalEmptied && (
                  <p id="scan-total-empty" role="alert" className="text-[11px] text-red-600 dark:text-red-400 text-right">
                    {t("dcScanTotalEmptySum", "Type the day's total revenue — with several terminals added together it can't be left empty.")}
                  </p>
                )}
                {cardBonGap && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400 tabular-nums">
                    <span className="font-semibold">
                      {/* The sentence's full stop after "kr." printed
                          "du gemmer 17.130 kr.." — one stop, whatever the
                          currency's own ending. */}
                      {t("dcScanBonVsSaved", "Z-report: {bon} · you save {saved}", {
                        bon: formatOwnerMoney(cardBonGap.bon, currency, { decimals: cardBonGap.decimals }),
                        saved: formatOwnerMoney(cardSaveTotal, currency, { decimals: cardBonGap.decimals }),
                      }).replace(/\.\.$/, ".")}
                    </span>{" "}
                    {scanResult.revenue_total_text
                      ? t("dcScanBonVsSavedTyped", "You corrected the total yourself.")
                      : scanResult.merge_info?.mode === MERGE_SUM
                        // On a summed day the excess is usually the owner's own
                        // category correction (the card says "Med dine rettelser
                        // gemmer dagen …" just above): it is said as theirs —
                        // never blamed on the bons. Only when the tills still
                        // save what they did when added are the bons' own
                        // categories over their totals.
                        ? (Math.abs(cardSaveTotal - (scanResult.merge_info.terminalTotals || []).reduce((a, v) => a + (Number(v) || 0), 0)) >= 0.01
                          ? t("dcScanTillsOverBonEdited", "With your corrections the categories add up to {diff} more than the Z-reports' totals.", {
                              diff: formatOwnerMoney(cardBonGap.diff, currency, { decimals: cardBonGap.decimals }),
                            })
                          : t("dcScanTillsOverBon", "The categories add up to {diff} more than the Z-reports' totals. If the Z-reports are right, fix a category.", {
                              diff: formatOwnerMoney(cardBonGap.diff, currency, { decimals: cardBonGap.decimals }),
                            }))
                        : t("dcScanLinesOverBon", "The categories add up to {diff} more than the Z-report's total. If the Z-report is right, fix a category.", {
                            diff: formatOwnerMoney(cardBonGap.diff, currency, { decimals: cardBonGap.decimals }),
                          })}
                  </p>
                )}
              </>)}
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
                {cardMoms.read && <span className="text-[11px] font-medium px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg">{t("scanBadgeRead", "read")}</span>}
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
                  {formatOwnerMoney(cardMoms.value, currency, { decimals: oreIfAny(cardMoms.value) })}
                </span>
              </div>
              {cardMoms.oneTill && !cardMoms.moved && (
                <p className="text-[12px] text-amber-700 dark:text-amber-400" data-testid="dc-moms-one-till">
                  {t("dcMomsOneTillRecomputed", "Only some of the tills had a MOMS line, so MOMS is worked out from the combined total ({saved}). If a receipt has more than one MOMS rate, tap From receipt and type the right figure.", {
                    saved: formatOwnerMoney(cardSaveTotal, currency, { decimals: oreIfAny(cardSaveTotal) }),
                  })}
                </p>
              )}
              {cardMoms.moved && (
                <p className="text-[12px] text-amber-700 dark:text-amber-400">
                  {t("dcMomsRecomputed", "The Z-report's MOMS ({bon}) belongs to another total than the {saved} you save, so MOMS is worked out again from that total. If the report has more than one MOMS rate, tap From receipt and type the right figure.", {
                    bon: formatOwnerMoney(Number(scanResult.moms_total), currency, { decimals: oreIfAny(Number(scanResult.moms_total)) }),
                    saved: formatOwnerMoney(cardSaveTotal, currency, { decimals: oreIfAny(cardSaveTotal) }),
                  })}
                </p>
              )}
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
                    <span>{catLabel(t, c).split(" / ")[0]} {t("udenMomsSuffix", "(excl. MOMS)")}</span>
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
                return (
                  <div key={m.key} className="flex flex-col items-stretch gap-1 sm:flex-row sm:items-center sm:gap-3">
                    {/* Icons and badges keep their size; the label gives way. In the
                        fixed-width column a "missing" row squeezed its icons to 0px. */}
                    <span className="text-sm sm:w-52 sm:shrink-0 flex items-center gap-2 min-w-0 dark:text-gray-300">
                      {val ? <Icon name="Check" size={14} className="text-emerald-600 shrink-0" /> : <span className="text-gray-500 dark:text-gray-400 shrink-0">—</span>}
                      <Icon name={m.icon} size={14} className="shrink-0 text-gray-500 dark:text-gray-400" /> <span className="min-w-0 truncate">{catLabel(t, m)}</span>
                      {readOnCard(`payments.${m.key}`, val) && <span className="shrink-0 text-[11px] font-medium px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg">{t("scanBadgeRead", "read")}</span>}
                    </span>
                    {/* Raw string kept, same reason as the revenue field above. */}
                    <CardMoneyField
                      id={`scan-pay-${m.key}`}
                      locale={mLocale}
                      // The field IS the flex child of the row above, so the
                      // wrapper has to carry the growth or the box collapses.
                      wrapperClassName="flex-1 min-w-0"
                      className={inputClass}
                      value={asBox(val)}
                      placeholder=""
                      onChange={e => act(typeIntoForm, `payments.${m.key}`, e.target.value)} />
                  </div>
                );
              })}
              {/* ONE line for a short payments column. Every unread method
                  used to wear an amber "missing" — Faktura and MobilePay on a
                  card-and-cash night — when only the shortfall is known.
                  BELOW the payment boxes: it comes and goes with the keystroke
                  that unbalances (or balances) the column, and above them it
                  pushed the box being typed in 48–66 px down under the caret.
                  Nothing typed in sits below it, so it can follow every key. */}
              {!scanPayComplete && scanPaySum > 0 && scanPayTotal > 0 && (
                <p className="text-[12px] text-gray-600 dark:text-gray-300" data-testid="dc-scan-pay-short">
                  <Icon name="AlertTriangle" size={13} className="inline align-text-bottom mr-1" />
                  {/* Øre as the boxes have them: "31.031 kr." stood for
                      boxes adding up to 31.030,50. One precision for both. */}
                  {(() => {
                    const sum = Math.round(scanPaySum * 100) / 100;
                    const diff = Math.round(Math.abs(scanPayTotal - scanPaySum) * 100) / 100;
                    const decimals = pairDecimals(sum, diff);
                    return t("dcScanPayShort", "The payments add up to {sum} — {diff} short of the total. Fill in the one that's missing.", {
                      sum: formatOwnerMoney(sum, currency, { decimals }),
                      diff: formatOwnerMoney(diff, currency, { decimals }),
                    });
                  })()}
                </p>
              )}
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
                        ? t("brandBetalingskort", "Payment card (terminal)")
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
              <div className="flex flex-col items-stretch gap-1 sm:flex-row sm:items-center sm:gap-3">
                {/* Most Z-bons carry no tips line, so an unread one is not
                    "missing" — it is simply not on the receipt. */}
                <span className="text-sm sm:w-52 sm:shrink-0 flex items-center gap-2 min-w-0 dark:text-gray-300">
                  {scanResult.tips ? <Icon name="Check" size={14} className="text-emerald-600 shrink-0" /> : <span className="text-gray-500 dark:text-gray-400 shrink-0">—</span>}
                  <Icon name="Coins" size={14} className="shrink-0 text-gray-500 dark:text-gray-400" /> <span className="min-w-0 truncate">{t("tipsLabel", "Tips")}</span>
                  {readOnCard("tips", scanResult.tips) && <span className="shrink-0 text-[11px] font-medium px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-emerald-700 dark:text-emerald-400 rounded-lg">{t("scanBadgeRead", "read")}</span>}
                </span>
                {/* Raw string kept, same reason as the revenue field above. */}
                <CardMoneyField
                  locale={mLocale}
                  wrapperClassName="flex-1 min-w-0"
                  className={inputClass}
                  value={asBox(scanResult.tips)}
                  placeholder={!scanResult.tips ? t("dcNotOnReceipt", "not on the receipt") : ""}
                  onChange={e => act(typeIntoForm, "tips", e.target.value)} />
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
            {dayPhotos.length > 0 && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 inline-flex items-center gap-1.5">
                    <Icon name="Image" size={14} /> {dayPhotos.length > 1 ? t("receiptPhotosLabel", "Receipt photos") : t("receiptPhotoLabel", "Receipt photo")}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t("tapToViewFullSize", "Tap to view full size")}
                  </span>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {dayPhotos.map((p, i) => {
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
                loss this flow exists to stop. Gray with no reason read as a
                dead end, so the reason sits right above them, and a tap takes
                the owner to the question. */}
            {pendingScan && (
              <button type="button" id="dc-terminal-q-reason" onClick={showTerminalQuestion}
                className="w-full min-h-10 flex items-center justify-center gap-1.5 text-[13px] font-medium text-amber-800 dark:text-amber-200 underline underline-offset-2">
                <Icon name="ChevronUp" size={14} className="shrink-0" />
                {t("dcScanAnswerQuestionFirst", "Answer the question above first — is this another terminal?")}
              </button>
            )}
            {/* What the card shows is filed when it is applied — not by a
                Fortryd, a photo or a correction made here. Taken back with
                Fortryd, a sum stayed in the draft while the card showed the
                day without it, and nothing said so. Said here, beside the
                buttons that file it, below every box (nothing moves under
                the caret). */}
            {cardUnsaved && (
              <p role="status" data-testid="dc-scan-unsaved"
                className="text-[13px] text-gray-600 dark:text-gray-300 flex items-start gap-1.5">
                <Icon name="Info" size={14} className="shrink-0 mt-0.5" />
                {t("dcScanNotSavedYet", "Not saved yet — what you see here is saved when you tap “Use these values” or “Continue step-by-step”.")}
              </p>
            )}
            <div className="flex flex-col sm:flex-row gap-3">
              <Button variant="primary" size="lg" className="flex-1" onClick={() => applyScanValues(true)}
                disabled={Boolean(pendingScan) || startOverBusy}
                aria-describedby={pendingScan ? "dc-terminal-q-reason" : undefined}
                iconLeft={<Icon name="CheckCircle2" size={16} />}>
                {t("useTheseValuesJumpReview", "Use these values — jump to review")}
              </Button>
              <Button variant="secondary" size="lg" className="flex-1" onClick={() => applyScanValues(false)}
                disabled={Boolean(pendingScan) || startOverBusy}
                aria-describedby={pendingScan ? "dc-terminal-q-reason" : undefined}
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
                  disabled={scanOffline || startOverBusy}
                  aria-describedby={scanOffline ? "dc-scan-offline" : undefined}
                  className="text-[13px] text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white font-medium underline underline-offset-2 disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed">
                  + {t("addAnotherPhoto", "Add another page or terminal")}
                </button>
              )}
              {/* Round 23: one explicit action — asked, then the day's draft
                  is deleted by the server and the form starts over empty
                  (startOverDay). Fortryd and "Det er det samme billede" are
                  the card's ways to take back one photo. */}
              <button onClick={() => startOverDay("card")} disabled={startOverBusy}
                className="text-[13px] whitespace-nowrap text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 underline underline-offset-2 disabled:opacity-50 disabled:no-underline">
                {startOverBusy ? t("dcStartOverDeleting", "Deleting the draft…") : t("startOver", "Start over")}
              </button>
            </div>
            {!pendingScan && scanOfflineEl}
            {startOverFailedFor(rowKey)}
          </div>
        )}

        {/* ─── NORMAL STEP FLOW ─── */}
        {!showScanUI && (<>
        {/* Date selector — defaults to today, allows past dates */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <label htmlFor="close-date" className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
            <Icon name="Calendar" size={14} /> {t("dateLabel", "Date")}
          </label>
          <input id="close-date" type="date" value={dateTyped ?? businessDate}
            disabled={Boolean(editingDate) || moveBusy}
            min={DATE_MIN}
            max={businessTodayIso(cutoffHour)}
            onKeyDown={onDateKeyDown}
            onChange={onDateChange}
            onBlur={onDateBlur}
            className="px-3 py-1.5 min-h-10 max-sm:h-11 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
          {businessDate !== businessTodayIso(cutoffHour) && (
            <span className="text-[11px] px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full font-semibold">
              {t("pastDate")}
            </span>
          )}
          {editingDate && editingDraft && (
            <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 bg-gray-100 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200 rounded-full font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
              {t("dcEditingSavedDraft", "Draft · you're continuing the saved draft")}
            </span>
          )}
          {businessDate !== businessTodayIso(cutoffHour) && !editingDate && (
            <button onClick={() => moveDate(businessTodayIso(cutoffHour))}
              className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline">
              {t("resetToToday", "Reset to today")}
            </button>
          )}
        </div>

        {/* What a move answered "Flyt tallene" did, once the new day was
            filed (round 23): the figures moved — the old day's draft is gone
            ("Flyttet fra 8. okt."); or it could not be deleted (offline, an
            error, saved or locked elsewhere since) and the old day still has
            it — said so, with "Slet den" while it can still be deleted.
            Never "Flyttet" unless the old draft is gone. */}
        {movedNote && movedNote.to === businessDate && (() => {
          const short = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });
          if (movedNote.state !== "copy") {
            return (
              <p data-testid="dc-date-moved" className="mb-4 -mt-1 text-[13px] text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
                <Icon name="CalendarCheck" size={14} className="shrink-0" />
                <span>{t("dcDateMovedFrom", "Moved from {from}", { from: short(movedNote.from) })}</span>
              </p>
            );
          }
          // Round 23 review — the new day's save is not confirmed ("pending":
          // no answer, not seen landing): nothing was copied, and nothing may
          // be deleted — said so ("Ikke gemt for {to} endnu — intet er slettet
          // for {from}"), with "Prøv igen" (its answer finishes the move).
          if (movedNote.stuck.some((x) => x.outcome === "pending")) {
            return (
              <div data-testid="dc-date-moved" data-state="pending" className="mb-4 -mt-1 text-[13px] text-amber-900 dark:text-amber-100 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <Icon name="CalendarClock" size={14} className="shrink-0" />
                  {t("dcDateMovedNotSavedYet", "Not saved for {to} yet — nothing is deleted for {from}", { to: short(movedNote.to), from: short(movedNote.from) })}
                </span>
                <Button size="sm" variant="secondary" className="min-h-10" disabled={moveBusy || isOnline === false} onClick={retryMovedSave}>
                  {t("dcDateMovedRetry", "Try again")}
                </Button>
              </div>
            );
          }
          // The first day known to still hold a draft is named; when none is
          // known (its save got no answer), the line says it MAY still be there.
          const knownStuck = movedNote.stuck.find((x) => x.known);
          const named = knownStuck || movedNote.stuck[0];
          const stays = named?.key ? String(named.key).split("|")[0] : movedNote.from;
          const canDelete = movedNote.stuck.some((x) => x.outcome !== "changed" && x.outcome !== "locked");
          const stillOffline = movedNote.tried && movedNote.stuck.some((x) => x.outcome === "offline");
          return (
            <div data-testid="dc-date-moved" data-state="copy" className="mb-4 -mt-1 text-[13px] text-amber-900 dark:text-amber-100 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5">
                <Icon name="CalendarClock" size={14} className="shrink-0" />
                {knownStuck
                  ? t("dcDateMovedCopied", "Copied to {to} — the draft for {from} is still there", { to: short(movedNote.to), from: short(stays) })
                  : t("dcDateMovedMaybeCopied", "Copied to {to} — the draft for {from} may still be there", { to: short(movedNote.to), from: short(stays) })}
              </span>
              {canDelete && (
                <Button size="sm" variant="secondary" className="min-h-10" disabled={moveBusy} onClick={deleteMovedOld}>
                  {t("dcDateMovedDeleteOld", "Delete it")}
                </Button>
              )}
              {stillOffline && (
                <span className="basis-full text-[12px] text-red-700 dark:text-red-300">
                  {t("dcDateMovedDeleteOffline", "Not deleted — there is no connection. Try again when you're online.")}
                </span>
              )}
            </div>
          );
        })()}

        {draftConflictEl}
        {existingBannerEl}

        {/* A locked day is read-only here: the form under the "already locked"
            banner could still be filled in, only to be refused at the end.
            So is a day whose draft question is still open: what was typed
            under "Fortsæt kladden / Start forfra" was never saved, and
            nothing said so. */}
        <fieldset disabled={existingBlocks} className={"min-w-0 m-0 p-0 border-0 " + (existingBlocks ? "opacity-50 pointer-events-none select-none" : "")} aria-hidden={existingBlocks || undefined}
          onFocus={onCardFocus} onBlur={onCardBlur}>

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
        {/* "Synkroniseret fra 0 salg" announced a sync of nothing. */}
        {prefill && !prefillLoading && (prefill.sales.count > 0 || prefill.expenses.count > 0) && (
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
          <div className="mb-3">{renderMergeSummary({ nowTotal: held ? held.wizardNow : (revenueKnown ? savedRevenue : null) })}</div>
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
        {/* Only in the after-midnight window, closing the business day that
            is still "tonight": at 10:50 on a past date the old condition
            told the owner they were on a night shift. */}
        {cutoffHour > 0
          && businessDate === businessTodayIso(cutoffHour)
          && businessDate !== localIso() && (
          <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl px-3 py-2 flex items-center gap-2 mb-3 border border-gray-200 dark:border-gray-700">
            <Icon name="Moon" size={14} className="text-gray-500 dark:text-gray-400" />
            <p className="text-[12px] text-gray-600 dark:text-gray-300">
              <strong>{t("nightShiftLabel", "Night shift:")}</strong> {t("nightShiftClosingFor", "closing for {date} (cutoff {hour}:00 AM)", { date: new Date(businessDate + "T12:00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" }), hour: cutoffHour })}
            </p>
          </div>
        )}

        {/* The day is held by a deleted, locked kasserapport (the autosave was
            refused): said on every step, not only at Bekræft & lås. */}
        {deletedLockedRow != null && !error && (
          <div className="mb-4" data-testid="dc-deleted-locked">
            <SectionBanner severity="critical" icon="AlertCircle">
              {t("dcDeletedLockedClose", "This day can't be saved: a deleted, locked kasserapport is kept for it (bookkeeping law). Nothing was saved — your numbers are still on this screen. Contact support.")}
              {deletedLockedRow && (
                <span className="block mt-1 text-[12px] opacity-70">{deletedLockedRow}</span>
              )}
            </SectionBanner>
          </div>
        )}

        {/* Step header. From 768 to 1023 px the wizard reaches the right edge
            and the floating AI button (fixed, 64 px in from the right) sat
            over the step counter; the counter keeps out of that column. */}
        <div className="flex items-center justify-between gap-3 mb-5 md:max-lg:pr-8">
          <h2 className="text-[16px] font-semibold text-gray-900 dark:text-white">
            {currentStepId === "revenue" && t("stepNRevenue", "Step {n} — {label}", { n: step, label: t(config.stepOneLabelKey, config.stepOneLabel) })}
            {currentStepId === "payments" && t("stepNPayments", "Step {n} — Payment Methods", { n: step })}
            {currentStepId === "cash" && t("stepNCash", "Step {n} — Cash Drawer Count", { n: step })}
            {currentStepId === "tips" && t("stepNTips", "Step {n} — Tips", { n: step })}
            {currentStepId === "review" && t("stepNReview", "Step {n} — Review & lock", { n: step })}
          </h2>
          {/* Draft auto-save says so HERE, in a fixed-width slot. It was a
              banner above the step that pushed every field down ~44px and
              pulled them back 3s later — a tap meant for Catering typed
              1.500 into "Add category". */}
          {/* "Gemmer…" while a save is waiting or on its way; "Gemt" only once
              the server has it. */}
          {/* Not saved — the day's draft was saved somewhere else (the question
              is open; a tap brings it into view), or the day was locked on
              another device (its banner is above the read-only form): the
              slot says so, never the step counter over edits nobody saves
              (round 22). The hit area is 40 px; the negative margin keeps the
              row's height, so nothing moves. */}
          <span aria-live="polite" title={draftSaved && !draftSaving ? t("draftSavedResumeLater", "Draft saved — you can leave and resume later") : undefined}
            className="text-[13px] text-gray-500 dark:text-gray-400 tabular-nums shrink-0 min-w-[3.75rem] text-right">
            {conflictHere && !draftSaving
              ? (
                <button type="button" data-testid="dc-save-slot-unsaved" onClick={showDraftConflict}
                  aria-label={t("dcDraftNotSavedWhy", "Not saved — the draft was saved somewhere else. Show the question")}
                  className="inline-flex items-center gap-1 min-h-10 -my-2 px-1 -mx-1 font-medium text-amber-700 dark:text-amber-400 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded">
                  <Icon name="AlertTriangle" size={13} className="shrink-0" />{t("dcDraftNotSavedShort", "Not saved")}
                </button>
              )
              : lockedRowRejected
              ? (
                <span data-testid="dc-save-slot-unsaved" title={t("dcDraftNotSavedLocked", "Not saved — the day was locked on another device")}
                  className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                  <Icon name="Lock" size={13} className="shrink-0" />{t("dcDraftNotSavedShort", "Not saved")}
                </span>
              )
              : draftSaving
              ? t("savingEllipsis", "Saving…")
              : draftSaved
              ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><Icon name="Check" size={13} />{t("dcDraftSavedShort", "Saved")}</span>
              : `${step}/${totalSteps}`}
          </span>
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
                        Object.entries(splitMeta.categories).forEach(([k, v]) => { next[k] = asBox(v); });
                        // With photos in the day the boxes are their tills'
                        // figures: the split goes into the ledger like any
                        // typed change. Without, it is the sync's own split.
                        if (hasScanTills(ledgerRef.current)) {
                          new Set([...Object.keys(revAmounts), ...Object.keys(next)]).forEach((k) => {
                            if ((revAmounts[k] ?? "") !== (next[k] ?? "")) act(typeIntoForm, `revenue.${k}`, next[k] ?? "", { fromForm: true });
                          });
                        } else {
                          act(detachForm);
                        }
                        setRevAmounts(next);
                        salesFillRef.current = { ...salesFillRef.current, rev: next };
                      }}
                    >
                      {t("dcResetToComputed", "Reset to computed split")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Variance warning — fire if user-entered total diverges from POS by >10% */}
            {prefill && prefill.sales.total > 0 && savedRevenue > 0 && (() => {
              const variance = savedRevenue - prefill.sales.total;
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
                    {t("closeDiffersBy", "Your close ({close}) differs by {pct}% from your POS total ({pos}). Double-check before locking — this number will be on your revisor's report.", { close: formatOwnerMoney(savedRevenue, currency, { decimals: GLANCE_DECIMALS }), pct: Math.round(pctOff * 100), pos: formatOwnerMoney(prefill.sales.total, currency, { decimals: GLANCE_DECIMALS }) })}
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
                <label htmlFor={`dc-rev-${cat.key}`} className={labelClass}><Icon name={cat.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, cat)}</label>
                <MoneyField id={`dc-rev-${cat.key}`} locale={mLocale} placeholder="0" className={inputClass}
                  value={revAmounts[cat.key] || ""}
                  onChange={e => {
                    boxFillEpochRef.current += 1;
                    const next = { ...revAmounts, [cat.key]: e.target.value };
                    setRevAmounts(next);
                    typeInForm(`revenue.${cat.key}`, e.target.value, { rev: next });
                  }} />
              </div>
            ))}
            <div className="flex gap-2">
              <input type="text" placeholder={t("addCategory", "Add category...")} className="flex-1 min-w-0 h-11 px-4 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-[13px]"
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
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("total", "Total")}</span>
              {/* The total that will be SAVED: a partly read Z-bon showed the
                  10.000 typed into Mad here while 17.030 was locked. */}
              <Amount
                value={revenueKnown ? savedRevenue : null}
                currency={currency}
                decimals={pairDecimals(savedRevenue, unsplitRevenue)}
                size="kpi"
                className="text-gray-900 dark:text-white"
              />
            </div>
            <UnsplitLine amount={unsplitRevenue} show={revenueKnown} currency={currency} t={t} decimals={pairDecimals(savedRevenue, unsplitRevenue)} />
          </div>
        )}

        {/* ─── STEP: Payments ─── */}
        {currentStepId === "payments" && (
          <div className="space-y-4">
            {payMethods.map(m => (
              <div key={m.key}>
                <label htmlFor={`dc-pay-${m.key}`} className={labelClass}><Icon name={m.icon} size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {catLabel(t, m)}</label>
                <MoneyField id={`dc-pay-${m.key}`} locale={mLocale} placeholder="0" className={inputClass}
                  value={payAmounts[m.key] || ""}
                  onChange={e => {
                    boxFillEpochRef.current += 1;
                    const next = { ...payAmounts, [m.key]: e.target.value };
                    setPayAmounts(next);
                    typeInForm(`payments.${m.key}`, e.target.value, { pay: next });
                  }} />
              </div>
            ))}
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("paymentTotal")}</span>
                <Amount
                  value={hasPaymentEntry ? paymentTotal : null}
                  currency={currency}
                  decimals={pairDecimals(paymentTotal, savedRevenue)}
                  size="kpi"
                  className="text-gray-900 dark:text-white"
                />
              </div>
              <div className="flex justify-between items-baseline gap-3 mt-1.5">
                <span className="text-[12px] text-gray-500 dark:text-gray-400">{t("revenueTotal")}</span>
                {/* The total that will be SAVED — the verdict below compares
                    against it, so the line it explains must show it too. */}
                <span className="text-[13px] text-gray-600 dark:text-gray-300">
                  <Amount value={hasRevenueEntry || savedRevenue > 0 ? savedRevenue : null} currency={currency} decimals={pairDecimals(paymentTotal, savedRevenue)} />
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
                    // Amber, as on the review — the same verdict was red here
                    // and amber there. It needs a look; it isn't money lost.
                    : "bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300"
                }`}>
                  {/* The direction in words: "Difference: +2.912,75 kr." when the
                      payments were SHORT read either way. */}
                  {tieOut.state === "balanced"
                    ? <><Icon name="CheckCircle2" size={14} className="inline align-text-bottom mr-1" />{t("balanced", "Balanced!")}</>
                    : <><Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" />{tieOut.diff > 0
                      ? t("dcPayBelowRevenue", "Payments are {amount} below revenue", { amount: formatOwnerMoney(Math.abs(tieOut.diff), currency, { decimals: pairDecimals(paymentTotal, savedRevenue, tieOut.diff) }) })
                      : t("dcPayAboveRevenue", "Payments are {amount} above revenue", { amount: formatOwnerMoney(Math.abs(tieOut.diff), currency, { decimals: pairDecimals(paymentTotal, savedRevenue, tieOut.diff) }) })}</>}
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
              {t("dcCashCountIntro", "Count everything in the drawer. We take the float off and compare the rest with today's cash sales.")}
            </SectionBanner>
            <div>
              <label htmlFor="cash-counted" className={labelClass}><Icon name="Banknote" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("dcDrawerCounted", "Counted in the drawer")}</label>
              {/* Below the float: the count (and the float beside it) is the
                  red field the lock step points back to — the hint below said
                  so in red while both boxes stayed gray. */}
              <MoneyField id="cash-counted" locale={mLocale} placeholder={t("countYourDrawer")} className={inputClass}
                value={drawerCount} onChange={e => onDrawerChange(e.target.value)}
                aria-invalid={cashCountedNegative || isMoneyRejected(drawerCount, mLocale) || undefined}
                aria-describedby={[isMoneyRejected(drawerCount, mLocale) ? "cash-counted-err" : null, cashCountedNegative ? "dc-drawer-below-float" : null].filter(Boolean).join(" ") || undefined} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="cash-float" className={labelClass}>{t("dcCashFloat", "Float (stays in the drawer)")}</label>
              <MoneyField id="cash-float" locale={mLocale} placeholder="0" wrapperClassName="w-36 shrink-0"
                className="w-full h-11 px-3 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-400 text-right text-[16px] tabular-nums"
                value={cashFloat} onChange={e => onFloatChange(e.target.value)}
                aria-invalid={cashCountedNegative || isMoneyRejected(cashFloat, mLocale) || undefined}
                aria-describedby={[isMoneyRejected(cashFloat, mLocale) ? "cash-float-err" : null, cashCountedNegative ? "dc-drawer-below-float" : null].filter(Boolean).join(" ") || undefined} />
            </div>
            <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 px-4 py-3 space-y-1.5 tabular-nums">
              <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300">
                <span>{t("dcCashTakings", "Cash from today's sales")}</span>
                <span className="font-semibold text-gray-900 dark:text-gray-100"><Amount value={cashCountReadable ? cashCountedVal : null} currency={currency} decimals={pairDecimals(cashCountedVal, cashExpected)} /></span>
              </div>
              <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300">
                <span>
                  {cashExpectedFromRegister
                    ? t("expectedFromRegister", "Expected (from register)")
                    : t("expectedFromEntry", "Expected (from your entry)")}
                </span>
                <span><Amount value={hasCashBaseline ? cashExpected : null} currency={currency} decimals={pairDecimals(cashCountedVal, cashExpected)} /></span>
              </div>
              {cashExpectedFromRegister && (
                <p className="text-[12px] text-gray-500 dark:text-gray-400">
                  {t("expectedFromRegisterHint", "From your synced POS register — counting against this flags a real cash shortage, not just a typo.")}
                </p>
              )}
              {cashCountedNegative && (
                <p id="dc-drawer-below-float" className="text-[12px] text-red-600 dark:text-red-400">
                  {t("dcDrawerBelowFloat", "Less than the float — check the count or the float.")}
                </p>
              )}
            </div>
            {/* Kassedifference, named as History names it, and the direction
                in words. Red for a real shortage; over is "check it" (amber). */}
            {cashDiff !== null && (
              <div className={`px-4 py-3 rounded-xl text-center ${
                Math.abs(cashDiff) <= 100 ? "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
                  : cashDiff < 0 ? "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400"
                    : "bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300"
              }`}>
                <p className="text-[12px] font-medium">{t("dcCashDiffLabel", "Cash difference")}</p>
                <p className="font-semibold text-[16px] tabular-nums">{cashDirection(cashDiff, pairDecimals(cashCountedVal, cashExpected, cashDiff))}</p>
                {Math.abs(cashDiff) > 100 && <p className="text-[13px] font-normal mt-1"><Icon name="AlertTriangle" size={14} className="inline align-text-bottom mr-1" /> {t("offByMoreThanAmount", "Off by more than {amount} — double-check your count", { amount: formatOwnerMoney(100, currency, { decimals: GLANCE_DECIMALS }) })}</p>}
              </div>
            )}
            {/* `!cashExpected` was true for a REGISTER-DERIVED 0 as well as for
                "no baseline at all" — so a till that genuinely took no cash was
                told there was no cash figure to compare against, which is the
                opposite of true and hides a real 0-vs-counted variance. Only the
                no-baseline case gets the hint now. */}
            {/* A count with nothing to hold it against: said, never a difference. */}
            {cashNoBaseline ? (
              <p className="text-[13px] text-gray-500 dark:text-gray-400 text-center" data-testid="dc-cash-no-baseline">{t("dcCashNoBaseline", "No cash sales to compare with — the count is saved without a cash difference.")}</p>
            ) : !cashExpectedFromRegister && !typedCash && (
              <p className="text-[13px] text-gray-500 dark:text-gray-400 text-center">{t("noCashStep2")}</p>
            )}
          </div>
        )}

        {/* ─── STEP: Tips (only for types with tips) ─── */}
        {currentStepId === "tips" && (
          <div className="space-y-4">
            <div>
              <label htmlFor="dc-tips-total" className={labelClass}><Icon name="Coins" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("totalTipsLabel", "Total Tips")}</label>
              <MoneyField id="dc-tips-total" locale={mLocale} placeholder="0" className={inputClass}
                value={tipsTotal} onChange={e => {
                  setTipsTotal(e.target.value);
                  if (config.hasTips) typeInForm("tips", e.target.value, { tips: e.target.value });
                }} />
            </div>
            <div>
              <label htmlFor="dc-staff-count" className={labelClass}><Icon name="Users" size={14} className="inline align-text-bottom mr-1 text-gray-500 dark:text-gray-400" /> {t("staffCountLabel", "Staff Count")}</label>
              <input id="dc-staff-count" type="number" inputMode="numeric" placeholder={businessDate !== businessTodayIso(cutoffHour) ? t("dcStaffCountPromptPast", "How many staff that day?") : t("staffCountPrompt")} className={inputClass}
                value={staffCount} onChange={e => setStaffCount(e.target.value)} />
            </div>
            {tipsPP !== null && (
              <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 text-center">
                {/* Was text-emerald-600 dark:text-gray-300 — the accent drained
                    to grey in dark. It is a LABEL, so it is neutral in both. */}
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t("perPerson")}</p>
                <Amount value={tipsPP} currency={currency} decimals={oreIfAny(tipsPP)} size="kpi" className="mt-1 text-gray-900 dark:text-white" />
              </div>
            )}
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-[12px] text-amber-700 dark:text-amber-300">
              <strong>{t("tipsTaxNoteLabel", "Danish tax note:")}</strong> {t("tipsTaxNoteBody", "Tips must be reported via eIndkomst. Share this data with your revisor.")}
            </div>
          </div>
        )}

        {/* ─── REVIEW STEP ─── */}
        {/* 768–1023 px: the floating AI button (fixed bottom-right) sat on
            the ledger's right-aligned figures as they scrolled under it. */}
        {currentStepId === "review" && (
          <div className="space-y-4 md:max-lg:pr-8">
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
                  <span data-testid={`dc-review-rev-${c.key}`}><Amount value={readMoney(revAmounts[c.key])} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
              ))}
              {/* So the rows add up to the total the kasserapport will carry. */}
              <UnsplitLine amount={unsplitRevenue} show={revenueKnown} currency={currency} t={t} />
              <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-2 text-gray-900 dark:text-white tabular-nums">
                <span>{t("total")}</span><span data-testid="dc-review-total"><Amount value={revenueKnown ? savedRevenue : null} currency={currency} decimals={LEDGER_DECIMALS} /></span>
              </div>
            </div>

            {/* MOMS (VAT) summary — with auto/manual toggle.
                The second indigo→violet gradient, gone for the same reason as
                the first: two colour families and a hardcoded #6366f1 that
                appear nowhere else in the product and carry no data. This is
                the block the revisor's MOMS number comes out of, so it now
                reads like a ledger — neutral ground, ø-aligned tabular figures,
                and the one bold line reserved for the total. */}
            {savedRevenue > 0 && (
              <div className="rounded-xl p-4 space-y-3 bg-gray-50 dark:bg-gray-700/50">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-[13px] text-gray-500 dark:text-gray-400">{vatName} ({vatRatePct}%)</h3>
                  {/* Toggle: Auto vs Manual — the Chip primitive, so it shares
                      the product's single selected-state treatment with every
                      other pick-one row and is a real aria-pressed button. */}
                  <div className="flex gap-1.5">
                    <Chip size="sm" className="min-h-10" selected={momsMode === "auto"} onClick={() => setMomsMode("auto")}>
                      {t("autoLabel")}
                    </Chip>
                    <Chip size="sm" className="min-h-10" selected={momsMode === "manual"} onClick={() => setMomsMode("manual")}>
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
                    {/* Nothing typed yet: say which figure is saved — the same
                        one as the line below, whose caption names its source. */}
                    {String(momsManual ?? "").trim() === "" && (
                      <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-1.5">
                        {t("dcMomsManualEmpty", "Nothing typed yet, so we save {moms}, as shown below. Type the receipt's MOMS here if it is different.", {
                          moms: formatOwnerMoney(momsTotal, currency, { decimals: oreIfAny(momsTotal) }),
                        })}
                      </p>
                    )}
                  </div>
                )}
                {/* A reopened draft's MOMS kept under a total that moved. */}
                {draftMomsKept && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                    <Icon name="AlertTriangle" size={13} className="shrink-0 mt-0.5" />
                    <span>{t("dcMomsDraftOtherTotal", "This MOMS ({moms}) was saved for a total of {old}, not the {saved} you save now. Check it against the Z-report, or tap Auto.", {
                      moms: formatOwnerMoney(draftMoms.moms, currency, { decimals: oreIfAny(draftMoms.moms) }),
                      old: formatOwnerMoney(draftMoms.total, currency, { decimals: oreIfAny(draftMoms.total) }),
                      saved: formatOwnerMoney(savedRevenue, currency, { decimals: oreIfAny(savedRevenue) }),
                    }).replace(/kr\.\./g, "kr.")}</span>
                  </p>
                )}
                {!momsTyped && momsSource === "computed" && draftMoms?.followed && draftMomsMoved && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                    <Icon name="AlertTriangle" size={13} className="shrink-0 mt-0.5" />
                    <span>{t("dcMomsDraftFollowed", "The draft was saved with MOMS {moms} for a total of {old} — the total is now {saved}, so MOMS is worked out again from it. If the Z-report has more than one MOMS rate, tap From receipt and type the right figure.", {
                      moms: formatOwnerMoney(draftMoms.moms, currency, { decimals: oreIfAny(draftMoms.moms) }),
                      old: formatOwnerMoney(draftMoms.total, currency, { decimals: oreIfAny(draftMoms.total) }),
                      saved: formatOwnerMoney(savedRevenue, currency, { decimals: oreIfAny(savedRevenue) }),
                    }).replace(/kr\.\./g, "kr.")}</span>
                  </p>
                )}
                {/* Some tills had a MOMS line and some did not: worked out for
                    the whole day — said once, the same as on the card. */}
                {!momsTyped && momsSource === "computed" && ledgerMoms.oneTill && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5" data-testid="dc-review-moms-one-till">
                    <Icon name="AlertTriangle" size={13} className="shrink-0 mt-0.5" />
                    <span>{t("dcMomsOneTillRecomputed", "Only some of the tills had a MOMS line, so MOMS is worked out from the combined total ({saved}). If a receipt has more than one MOMS rate, tap From receipt and type the right figure.", {
                      saved: formatOwnerMoney(savedRevenue, currency, { decimals: oreIfAny(savedRevenue) }),
                    })}</span>
                  </p>
                )}
                {!momsTyped && momsSource !== "recomputed" && (
                  <p className="text-[12px] text-gray-500 dark:text-gray-400">
                    {momsSource === "scanned"
                      ? t("momsFromZReport", "Read from your Z-report — not recalculated from revenue.")
                      : t("momsAutoCalc", "Auto-calculated: Revenue × {pct}% / {div}%", { pct: vatRatePct, div: 100 + vatRatePct })}
                  </p>
                )}
                {/* The bon's MOMS belongs to another total than the one saved —
                    said, with the way back for a mixed-rate day. */}
                {!momsTyped && momsSource === "recomputed" && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                    <Icon name="AlertTriangle" size={13} className="shrink-0 mt-0.5" />
                    <span>{t("dcMomsRecomputed", "The Z-report's MOMS ({bon}) belongs to another total than the {saved} you save, so MOMS is worked out again from that total. If the report has more than one MOMS rate, tap From receipt and type the right figure.", {
                      bon: formatOwnerMoney(Number(scanResult?.moms_total), currency, { decimals: oreIfAny(Number(scanResult?.moms_total)) }),
                      saved: formatOwnerMoney(savedRevenue, currency, { decimals: oreIfAny(savedRevenue) }),
                    })}</span>
                  </p>
                )}
                <div className="flex justify-between text-[13px] text-gray-700 dark:text-gray-300 py-0.5 tabular-nums">
                  <span>{t("revenueMedMoms", "Revenue (med moms)")}</span>
                  <span><Amount value={savedRevenue} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
                {/* Salg uden moms i dag — exempt rows the owner already
                    flagged via Quick Sale MOMS-fri or the Sales page.
                    Pulled from /property-report (taxable_sales vs
                    total_revenue) so the close MOMS calc matches the
                    SKAT MOMS-angivelse PDF. DK term locked. */}
                {exemptStatus === "ok" && exemptSalesTotal > 0 && (
                  <div className="flex justify-between text-[12px] text-amber-700 dark:text-amber-300 py-0.5 tabular-nums">
                    <span>{t("salgUdenMomsToday", "MOMS-exempt sales today")}</span>
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
                    <span>{t("salgUdenMomsToday", "MOMS-exempt sales today")}</span>
                    <span className="text-right">
                      <span className="tabular-nums">—</span>
                      <span className="block text-gray-500 dark:text-gray-400">{t("somethingWentWrong")}</span>
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-[13px] font-semibold py-0.5 text-gray-900 dark:text-gray-100 tabular-nums">
                  <span>{vatName} {vatRatePct}%{momsTyped ? ` ${t("fromReceiptSuffix", "(from receipt)")}` : ""}</span>
                  <span data-testid="dc-review-moms"><Amount value={momsTotal} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
                <div className="flex justify-between text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-1 text-gray-900 dark:text-white tabular-nums">
                  <span>{t("revenueUdenMoms", "Revenue (excl. MOMS)")}</span>
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
                  <span data-testid={`dc-review-pay-${m.key}`}><Amount value={readMoney(payAmounts[m.key])} currency={currency} decimals={LEDGER_DECIMALS} /></span>
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
                <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300 tabular-nums"><span>{t("dcCashTakingsCounted", "Counted (float taken off)")}</span><span><Amount value={cashCountedVal} currency={currency} decimals={LEDGER_DECIMALS} /></span></div>
                <div className={`flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-2 tabular-nums ${cashDiff < -100 ? "text-red-700 dark:text-red-400" : "text-gray-900 dark:text-white"}`}>
                  <span>{t("dcCashDiffLabel", "Cash difference")}</span><span><Amount value={cashDiff} currency={currency} decimals={LEDGER_DECIMALS} sign /></span>
                </div>
                {cashDiff !== null && Math.abs(cashDiff) >= 0.005 && (
                  <p className={`text-[12px] mt-1 text-right ${cashDiff < -100 ? "text-red-700 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>{cashDirection(cashDiff, LEDGER_DECIMALS)}</p>
                )}
                {cashNoBaseline && (
                  <p className="text-[12px] mt-1 text-right text-gray-500 dark:text-gray-400">{t("dcCashNoBaseline", "No cash sales to compare with — the count is saved without a cash difference.")}</p>
                )}
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
                    <span>{String(cat).trim().toLowerCase() === "waste" ? t("expCatWaste", "Waste") : cat}</span>
                    <span><Amount value={-val} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                  </div>
                ))}
                <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-red-200 dark:border-red-800 mt-2 text-red-700 dark:text-red-300 tabular-nums">
                  <span>{t("totalExpenses")}</span><span><Amount value={-prefill.expenses.total} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
                <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 mt-1 text-gray-900 dark:text-gray-100 tabular-nums">
                  <span>{t("dcSalesMinusExpenses", "Sales minus expenses")}</span><span><Amount value={hasRevenueEntry || savedRevenue > 0 ? savedRevenue - prefill.expenses.total : null} currency={currency} decimals={LEDGER_DECIMALS} /></span>
                </div>
              </div>
            )}

            {/* Tips */}
            {tipsTotal && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4">
                <h3 className="font-semibold text-[13px] text-gray-500 dark:text-gray-400 mb-2">{t("tipsLabel", "Tips")}</h3>
                <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300 tabular-nums"><span>{t("total")}</span><span><Amount value={readMoney(tipsTotal)} currency={currency} decimals={LEDGER_DECIMALS} /></span></div>
                {parseInt(staffCount) > 0 && <div className="flex justify-between gap-3 text-[13px] text-gray-700 dark:text-gray-300 tabular-nums"><span>{t("staffCountLabel", "Staff Count")}</span><span>{staffCount}</span></div>}
                {tipsPP > 0 && <div className="flex justify-between gap-3 text-[14px] font-semibold pt-2 border-t border-gray-200 dark:border-gray-600 mt-2 text-gray-900 dark:text-white tabular-nums"><span>{t("perPerson")}</span><span><Amount value={tipsPP} currency={currency} decimals={LEDGER_DECIMALS} /></span></div>}
              </div>
            )}

            {/* Phase A — salon Gavekort solgt. Its own line, EXCLUDED from the
                day-of-sale service MOMS base, flagged for the revisor (we never
                auto-decide single- vs multi-purpose voucher MOMS). */}
            {config.hasGavekort && (
              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 space-y-2">
                <label className="text-sm font-medium text-gray-600 dark:text-gray-300 flex items-center gap-1.5">
                  <Icon name="Gift" size={14} className="text-gray-500 dark:text-gray-400" />
                  {t("closeGavekortSoldLabel", "Gavekort sold")}
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
                  {t("opsCloseBatch", "Batch")}
                </label>
                <input type="text" placeholder={t("closeBatchPlaceholder", "fx morgenbatch #2")}
                  className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl"
                  value={batchRef} onChange={e => setBatchRef(e.target.value)} />
              </div>
            )}

            {/* Closed by + notes */}
            <div className="space-y-3">
              <div>
                <label htmlFor="dc-closed-by" className="text-sm font-medium text-gray-600 dark:text-gray-300">{t("closedBy")}</label>
                <input id="dc-closed-by" type="text" maxLength={CLOSED_BY_MAX} placeholder={t("managerNamePlaceholder", "Manager name…")} className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-gray-400"
                  value={closedBy} onChange={e => setClosedBy(e.target.value)} />
              </div>
              <div>
                <label htmlFor="dc-notes" className="text-sm font-medium text-gray-600 dark:text-gray-300">{t("notes")}</label>
                <textarea id="dc-notes" maxLength={NOTES_MAX} placeholder={t("notesPlaceholderTonight", "Any notes for tonight…")} rows={2} className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-gray-400"
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
                      className="mt-1 h-4 w-4 rounded accent-gray-900 dark:accent-gray-100 focus:ring-gray-400"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-100 inline-flex items-center gap-1.5">
                        <Icon name="Mail" size={14} className="text-gray-500 dark:text-gray-400" /> {t("autoEmailToggleLabelLock", "Mail the kasserapport when you lock")}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {/* The REAL recipients — it said "owner + revisor" even
                            when no revisor address existed. */}
                        {(() => {
                          // The owner's copy goes to the LOGIN address (the
                          // server never mails the unverified Profile e-mail).
                          const owner = user?.email || "";
                          // The demo seeder's sample revisor is never mailed
                          // — never named as "your revisor" either.
                          // A demo seeder's sample day is never sent to the
                          // revisor (the server: skip demo_close) — said
                          // here, before Lås, not only after it.
                          if (isDemoClose({ notes })) return t("autoEmailDemoDay", "To {owner}. This day is sample data and is never sent to your revisor.", { owner });
                          if (businessProfile?.accountant_is_demo) return t("autoEmailToDemoRevisor", "To {owner}. The revisor is sample data — save your own revisor's name and e-mail on Profile.", { owner });
                          const acct = businessProfile?.accountant_email || "";
                          if (!acct) return t("autoEmailToNoRevisor", "To {owner}. No revisor e-mail is saved — add it on Profile if they should get it too.", { owner });
                          // A real revisor, but the business is still the
                          // demo's sample company: nothing goes to them yet.
                          if (businessProfile?.identity_is_demo) return t("autoEmailToDemoIdentity", "To {owner}. Your business is still set up as the sample company (Mirabelle ApS). Correct the name, CVR and address on Profile before we send anything to your revisor.", { owner });
                          if (businessProfile?.accountant_opted_out) return t("autoEmailToOptedOut", "To {owner}. Your revisor ({acct}) has unsubscribed from BonBox mail and won't get it.", { owner, acct });
                          // Mail to the revisor waits for the owner's own
                          // confirmed e-mail (the server: skip
                          // "email_unverified") — said before Lås too.
                          if ((businessProfile?.accountant_auto_send_effective ?? true) && user?.email_verified === false) return t("autoEmailToUnverified", "To {owner}. Not to your revisor ({acct}) — confirm your e-mail first.", { owner, acct });
                          // …or while "did you create this account?" waits
                          // for an answer (the server: skip
                          // "claim_question_open") — the true reason.
                          if ((businessProfile?.accountant_auto_send_effective ?? true) && user?.claim_question_open === true) return t("autoEmailToClaimOpen", "To {owner}. Not to your revisor ({acct}) — BonBox is waiting for your answer to the question we e-mailed you.", { owner, acct });
                          // An older server has no such field and mails a saved revisor on lock.
                          if (businessProfile?.accountant_auto_send_effective ?? true) return t("autoEmailToBoth", "To {owner} and your revisor {acct}: the kasserapport as a PDF.", { owner, acct });
                          return t("autoEmailToOwnerOnly", "To {owner}. Your revisor ({acct}) only gets it when you tap Send — you can change that on Profile.", { owner, acct });
                        })()}
                        {/* The photo only when there is one — a typed close has none. */}
                        {receiptPhotoUrl ? " " + t("autoEmailPhotoToo", "The scanned Z-bon photo is attached too.") : ""}
                      </p>
                    </div>
                  </label>
                ) : (
                  <div className="flex items-start gap-3">
                    <Icon name="Lock" size={14} className="text-gray-400 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                        {t("autoEmailToggleStarterGate", "Auto-email on lock is on Starter+")}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t("autoEmailToggleStarterGateBodyHonest", "On Free you send it yourself: tap PDF on the day in History, or Send to revisor — the file downloads and your own mail opens. Starter mails it the moment you lock.")}
                      </p>
                      {canPurchaseInApp() && (
                        <Link
                          to="/subscription"
                          className="inline-block mt-2 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
                        >
                          {t("pricingUpgradeStarter", "Upgrade to Starter")} →
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* The lock was refused because the day's draft was saved somewhere
                else (round 22): said HERE, beside the button that was tapped —
                it changed only the question at the top of the wizard. */}
            {!error && conflictHere && draftConflict.via === "lock" && (
              <SectionBanner severity="warn" icon="AlertTriangle">
                <span data-testid="dc-lock-not-done">
                  {t("dcLockNotDoneDraftChanged", "Not locked: the draft was saved somewhere else after you opened it. Choose in the question above which numbers count.")}
                </span>
                <button type="button" onClick={showDraftConflict}
                  className="block mt-1 min-h-10 font-semibold underline underline-offset-2 text-left">
                  {t("dcShowQuestion", "Show the question")}
                </button>
              </SectionBanner>
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
            {/* revenueKnown, not hasRevenueEntry: a total read off the Z-bon is
                revenue, and with no payments read the review said nothing at
                all — not even "can't tell". */}
            {(revenueKnown || hasPaymentEntry) && (
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
                        {/* Which way, in words — a signed "+4.450,00 kr." left the
                            owner guessing whether payments were short or over. */}
                        <p className="text-[13px] font-semibold text-amber-800 dark:text-amber-300 tabular-nums">
                          {tieOut.diff > 0
                            ? t("dcPayBelowRevenue", "Payments are {amount} below revenue", {
                              amount: formatOwnerMoney(Math.abs(tieOut.diff), currency, { decimals: LEDGER_DECIMALS }),
                            })
                            : t("dcPayAboveRevenue", "Payments are {amount} above revenue", {
                              amount: formatOwnerMoney(Math.abs(tieOut.diff), currency, { decimals: LEDGER_DECIMALS }),
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

        {/* Navigation buttons — clear of the floating AI button's column
            from 768 to 1023 px (it clipped Næste's corner). */}
        <div className="flex justify-between mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 md:max-lg:pr-8">
          {step > 1 ? (
            <Button variant="ghost" size="lg" onClick={() => { setStep(step - 1); revealStepTop(); }}>
              ← {t("back", "Back")}
            </Button>
          ) : (
            // Back to the scan card WITH the scan, to correct it — it threw the
            // read Z-bon and its photo away without asking.
            <Button variant="ghost" size="lg"
              // Round 23: the scan card is not reached offline (scanning needs
              // the server) — the figures are typed here, and saved as typed.
              disabled={scanOffline}
              aria-describedby={scanOffline ? "dc-scan-offline" : undefined}
              onClick={() => {
              flushWaitingSave();
              if (scanResult) {
                // The card shows what the form holds NOW — every box edit is
                // already in the ledger, nothing is folded back.
                setScanMode("result");
                return;
              }
              setScanMode("idle"); setScanPhotos([]);
            }}>
              ← {t("scanZReportBack", "Scan Z-report")}
            </Button>
          )}

          {step < totalSteps ? (
            <Button variant="primary" size="lg" onClick={() => { setStep(step + 1); revealStepTop(); }}>
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
              // A total the owner typed is saved exactly; only an OCR figure
              // competes with the breakdown via max().
              const ownerSet = Boolean(scanResult?.revenue_total_text) && ocrTotal > 0;
              // What the tills save, added up — the same figure as the
              // payload's override and the review's total.
              const willSave = savedRevenue;
              const usingOverride = ocrTotal > 0 && (ownerSet ? ocrTotal !== revenueTotal : willSave - revenueTotal >= 0.005);
              const summedDay = scanResult?.merge_info?.mode === MERGE_SUM;
              // A summed day's categories raised past their bons, on top of
              // the bons' totals.
              const overBon = summedDay && !ownerSet && ocrTotal > 0 ? Math.max(0, Math.round((willSave - ocrTotal) * 100) / 100) : 0;
              // The owner's own till summed with a Z-bon: their figure and
              // the bon's, never all of it "fra bon". Read off the same record
              // the lock sends (closeTills.sourceMetaOf): only tills it files
              // as typed are "indtastet" — a reopened draft that was itself
              // read off a Z-bon is a bon, as the kasserapport prints it.
              const ownTotals = (() => {
                if (!summedDay || !cardOwnTill) return null;
                const meta = sourceMetaOf(ledger);
                const typedIdx = new Set(meta?.typed_tills || []);
                if (!typedIdx.size) return null;
                const tt = meta.terminal_totals || [];
                const typed = tt.reduce((a, v, i) => (typedIdx.has(i) ? a + (Number(v) || 0) : a), 0);
                const bon = tt.reduce((a, v, i) => (typedIdx.has(i) ? a : a + (Number(v) || 0)), 0);
                return { typed: Math.round(typed * 100) / 100, bon: Math.round(bon * 100) / 100 };
              })();
              // The other direction had no note: categories raised past the
              // bon's total are what is saved, and "Gemmer total" said nothing.
              // No bon known (a reopened draft's saved total) is no "Z-bon".
              const bonTotal = scanBonTotal(scanResult, mLocale);
              const splitOverBon = !ownerSet && ocrTotal > 0 && bonTotal != null && revenueTotal - Math.max(ocrTotal, bonTotal) >= 0.005;
              // A summed total that moved off the bons (a till's corrected
              // category) is not "from the receipt".
              const bonMoved = !ownerSet && bonTotal != null && Math.abs(bonTotal - ocrTotal) >= 0.005;
              return (
                <div className="flex flex-col items-end gap-1">
                  {/* moneyRejected: one of the amount boxes holds text that is
                      not an amount. This close writes a ledger row and prints
                      a kasserapport, so it does not go out on a figure nobody
                      could read — the offending field says so in place. */}
                  {/* Not while the day's existing draft/lock question is open —
                      locking then would replace that draft unasked. */}
                  <Button variant="primary" size="lg" onClick={() => handleSubmit()} disabled={saving || willSave === 0 || moneyRejected || existingBlocks}>
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
                          ? (belowFloatBlocks
                              // Every amount reads fine: the cause is the
                              // count against the float, said with both
                              // figures and the step to fix it on — "kan ikke
                              // læses … det røde felt" was not true.
                              ? (<>
                                  {t("dcLockBlockedBelowFloat", "The drawer count ({counted}) is less than the float ({float}) — fix it under Cash Drawer Count.", {
                                    counted: formatOwnerMoney(readMoney(drawerCount), currency, { decimals: pairDecimals(readMoney(drawerCount), readMoney(cashFloat)) }),
                                    float: formatOwnerMoney(readMoney(cashFloat), currency, { decimals: pairDecimals(readMoney(drawerCount), readMoney(cashFloat)) }),
                                  })}{" "}
                                  <button type="button" data-testid="dc-go-to-cash"
                                    onClick={() => { setStep(stepSequence.indexOf("cash") + 1); revealStepTop(); setTimeout(() => document.getElementById("cash-counted")?.focus?.(), 60); }}
                                    className="min-h-10 underline underline-offset-2 font-medium">
                                    {t("dcGoToCashCount", "Go to the count")}
                                  </button>
                                </>)
                              : rejectedArea
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
                        {ownerSet
                          // The owner typed this total — "from the receipt" was untrue.
                          ? t("dcSavesYourTotal", "(your corrected total — the categories add up to {sum})", { sum: formatOwnerMoney(revenueTotal, currency, { decimals: LEDGER_DECIMALS }) })
                          // A typed (or reopened) till plus a Z-bon: the
                          // figures said for what they are, the way the
                          // revisor's line reads "… (indtastet) + …".
                          : ownTotals
                            ? t("dcSavesTypedPlusBon", "(you typed {typed} + Z-report {bon} — your breakdown sums to {sum})", {
                                typed: formatOwnerMoney(ownTotals.typed, currency, { decimals: LEDGER_DECIMALS }),
                                bon: formatOwnerMoney(ownTotals.bon, currency, { decimals: LEDGER_DECIMALS }),
                                sum: formatOwnerMoney(revenueTotal, currency, { decimals: LEDGER_DECIMALS }),
                              })
                          // A sum the tills' corrected categories moved off
                          // the bons: the bons' figure, the amount and which
                          // way, then the split — three figures that add up.
                          : overBon > 0
                            ? t("dcSavesBonsPlusCorrected", "(Z-reports: {bon} + {over} corrected in the categories; split: {sum})", {
                                bon: formatOwnerMoney(ocrTotal, currency, { decimals: LEDGER_DECIMALS }),
                                over: formatOwnerMoney(overBon, currency, { decimals: LEDGER_DECIMALS }),
                                sum: formatOwnerMoney(revenueTotal, currency, { decimals: LEDGER_DECIMALS }),
                              })
                          : bonMoved
                            ? t("dcSavesBonAndSplit", "(Z-report: {bon} — your breakdown sums to {sum})", {
                                bon: formatOwnerMoney(bonTotal, currency, { decimals: LEDGER_DECIMALS }),
                                sum: formatOwnerMoney(revenueTotal, currency, { decimals: LEDGER_DECIMALS }),
                              })
                            // "From the receipt" only when a bon's figure is
                            // known — a reopened draft's saved total is not one.
                            : bonTotal == null
                              ? t("dcSavesSplitSums", "(your breakdown sums to {sum})", { sum: formatOwnerMoney(revenueTotal, currency, { decimals: LEDGER_DECIMALS }) })
                              : t("fromReceiptBreakdownSums", "(from receipt — your breakdown sums to {sum})", { sum: formatOwnerMoney(revenueTotal, currency, { decimals: LEDGER_DECIMALS }) })}
                      </span>
                    )}
                    {splitOverBon && (
                      <span className="ml-1 text-amber-700 dark:text-amber-400">
                        {t("dcSavesSplitOverBon", "(your breakdown is {diff} above the Z-report's {bon})", {
                          diff: formatOwnerMoney(revenueTotal - bonTotal, currency, { decimals: LEDGER_DECIMALS }),
                          bon: formatOwnerMoney(bonTotal, currency, { decimals: LEDGER_DECIMALS }),
                        })}
                      </span>
                    )}
                  </p>
                </div>
              );
            })()}
        </div>
        {/* Why "← Scan Z-bon" is gray (round 23): scanning needs internet. */}
        {step === 1 && <div className="mt-2">{scanOfflineEl}</div>}
        </fieldset>
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
/* The lasting "did it reach the revisor?" line — on the lock card and on every
   History row. It reads the status PERSISTED on the close, so it survives a
   reload, and it never fakes a "sent". A failed send offers the real resend
   (POST /daily-close/{id}/resend-email, one idempotency key per click); there
   is no background retry and nothing here says there is. */
function CloseEmailStatus({ t, close, ritual = null, profile = null, profileLoaded = false, compact = false, onSent = null, canSend = true }) {
  const confirm = useConfirm();
  const { user } = useAuth();
  // Send igen answered 403 email_unverified: the server's word wins over the
  // session's copy of the user (a team login sees its OWN email_verified).
  // Its reason too: "claim_question_open" — the address is confirmed and the
  // answer to the mailed question is missing (release gate, 9 Oct).
  const [heldByServer, setHeldByServer] = useState(null);
  const ownerConfirmed = heldByServer !== HELD_UNVERIFIED && user?.email_verified === true;
  const claimOpen = heldByServer === HELD_CLAIM_OPEN
    || (heldByServer !== HELD_UNVERIFIED && user?.claim_question_open === true);
  const [st, setSt] = useState(() => ({
    status: ritual?.email_status ?? close.email_status ?? null,
    error: ritual?.email_error ?? close.email_error ?? null,
    sentTo: close.email_sent_to?.length ? close.email_sent_to : (ritual?.sent_to || []),
    sentAt: close.email_sent_at ?? null,
    skip: ritual?.accountant_skip_reason ?? null,
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Kept across a lost response so a second tap replays the SAME key and the
  // server answers with what happened instead of mailing twice.
  const keyRef = useRef(null);
  // A settled null profile means the owner has no BusinessProfile row — read
  // as {} (no revisor saved), so the "Ikke sendt" lines still show.
  const { kind, acct, demo, identity, ownerSent } = closeEmailState({ status: st.status, sentTo: st.sentTo, skip: st.skip,
    error: st.error, profile: profileLoaded ? (profile ?? {}) : null, ownerConfirmed, claimOpen });
  const when = sentWhen(st.sentAt);
  const whenText = when ? t("dcMailWhen", "{date} at {time}", when) : "";
  // The lock card and the History row render the same close, each with its
  // own state: a send from one is announced so the other never disagrees.
  useEffect(() => {
    const on = (ev) => {
      const d = ev?.detail;
      if (!d || d.id !== close.id) return;
      setSt({ status: d.status ?? null, error: d.error ?? null, sentTo: d.sentTo || [],
        sentAt: d.sentAt ?? null, skip: d.skip ?? null });
    };
    window.addEventListener(CLOSE_EMAIL_EVENT, on);
    return () => window.removeEventListener(CLOSE_EMAIL_EVENT, on);
  }, [close.id]);

  const send = async (force = false) => {
    setBusy(true);
    setErr("");
    if (!keyRef.current) keyRef.current = newSendKey();
    try {
      const r = await resendCloseEmail(api, close.id, { key: keyRef.current, force });
      keyRef.current = null;
      const d = r.data || {};
      const next = {
        status: d.email_status ?? d.close_ritual?.email_status ?? null,
        error: d.email_error ?? d.close_ritual?.email_error ?? null,
        sentTo: d.email_sent_to || d.close_ritual?.sent_to || [],
        sentAt: d.email_sent_at ?? null,
        skip: d.close_ritual?.accountant_skip_reason ?? null,
      };
      setSt(next);
      announceCloseEmail(close.id, next);
      // The persisted status changed — let the page re-read History.
      onSent?.();
    } catch (e) {
      const code = e?.response?.data?.detail?.code;
      const status = e?.response?.status;
      if (!e?.response) {
        // We do not know whether it went. Same key on the next tap.
        setErr(t("dcMailUnknownOutcome", "We couldn't confirm whether it was sent. Check your own inbox (you get a copy) before sending again."));
        return;
      }
      keyRef.current = null;
      if (status === 409 && code === "already_sent") {
        // The server knows when (this instance may be showing an old state).
        const sw = sentWhen(e.response.data.detail?.sent_at);
        const sentText = sw ? t("dcMailWhen", "{date} at {time}", sw) : whenText;
        const ok = await confirm({
          title: t("dcMailAlreadyTitle", "Your revisor already has this kasserapport"),
          message: sentText
            ? t("dcMailAlreadyBody", "It was sent {when}. Send it again?", { when: sentText })
            : t("dcMailAlreadyBodyNoWhen", "It has already been sent. Send it again?"),
          confirmLabel: t("dcMailSendAgain", "Send again"),
          cancelLabel: t("cancel", "Cancel"),
          // A mail to a third party cannot be called back: focus on Cancel,
          // Enter does not send.
          irreversible: true,
        });
        if (ok) { setBusy(false); return send(true); }
      } else if (status === 409 && code === "accountant_opted_out") {
        setSt((s0) => ({ ...s0, skip: "opted_out" }));
        setErr(t("dcMailOptedOutErr", "Your revisor has unsubscribed from BonBox mail. Download the PDF and send it from your own mail."));
      } else if (status === 409 && code === "demo_close") {
        setErr(t("dcMailDemoClose", "This is a sample day (demo data) — it is never sent to your revisor."));
      } else if (status === 409 && code === "demo_recipient") {
        setSt((s0) => ({ ...s0, skip: "demo_recipient" }));
        setErr(t("dcRevisorIsDemo", "The revisor is sample data — save your own revisor's name and e-mail on Profile."));
      } else if (status === 409 && code === "demo_identity") {
        setSt((s0) => ({ ...s0, skip: "demo_identity" }));
        setErr(t("identityIsDemoNotice", "Your business is still set up as the sample company (Mirabelle ApS). Correct the name, CVR and address on Profile before we send anything to your revisor."));
      } else if (status === 409 && code === "in_progress") {
        setErr(t("dcMailInProgress", "It is being sent right now (from another tab or button). Wait a moment — it will not go twice."));
      } else if (status === 403 && code === "email_unverified") {
        // Mail to the revisor waits for the owner's own confirmed e-mail —
        // or for the answer to "did you create this account?" (reason
        // claim_question_open). Nothing was sent; the line below says which,
        // with "Bekræft nu" or "Send spørgsmålet igen".
        const held = heldReasonFromError(e) || HELD_UNVERIFIED;
        setHeldByServer(held);
        setSt((s0) => ({ ...s0, skip: held }));
      } else if (status === 429) {
        setErr(t("dcSendDailyCap", "BonBox has sent your revisor the most mails it sends in a day. Send this one from your own mail, or try tomorrow."));
      } else if (status === 400 && code === "no_accountant_email") {
        setErr(t("dcMailNoRevisorErr", "No revisor e-mail is saved. Add it on Profile first."));
      } else if (status === 402) {
        setErr(t("dcMailFreeErr", "Sending from BonBox is on Starter. Download the PDF and send it from your own mail."));
      } else {
        setErr(errText(e, t("dcMailResendFailed", "Couldn't send it. Try again in a moment.")));
      }
    } finally {
      setBusy(false);
    }
  };

  // A close locked before the status was kept and that the audit trail
  // knows nothing about either: it may already have been sent, so the send
  // ASKS first — recipient, day, and that it may be a second copy. The
  // server still answers 409 already_sent when its trail shows a delivery.
  const sendUnrecorded = async () => {
    const day = shortRangeDay(String(close.date || "").slice(0, 10));
    const ok = await confirm({
      title: t("dcMailUnrecordedConfirmTitle", "Send this kasserapport to your revisor?"),
      message: t("dcMailUnrecordedConfirmBody", "The kasserapport for {day} goes to {email}. BonBox has no record of whether it was sent when the day was locked — your revisor may already have it.", { day, email: acct }),
      confirmLabel: t("dcMailSendToRevisor", "Send to revisor"),
      cancelLabel: t("cancel", "Cancel"),
      irreversible: true,
    });
    if (ok) await send(false);
  };

  // No claim about the revisor until GET /business has settled — "ingen
  // revisor-mail gemt" from a profile still loading (or a failed read) would
  // be false. A settled null is no profile row, treated as {} above.
  if (kind === "none" || !profileLoaded) return null;
  // "Ikke registreret" only where BonBox could have sent it: a plan that
  // sends, a saved revisor, and a real day — never a seeded demo close.
  if (kind === "unrecorded" && (!acct || !canSend || isDemoClose(close))) return null;
  const reason = t(emailErrorKey(st.error), "unknown error");
  // A sample (demo) day is never sent to the revisor — the server refuses
  // every send of it (409 demo_close). No button offers one: the row says
  // so instead, under whatever it says about the owner's own copy.
  const demoDay = isDemoClose(close);
  const btn = (label, onClick = () => send(false)) => demoDay ? null : (
    <button type="button" onClick={onClick} disabled={busy}
      className="text-xs px-2.5 min-h-8 max-lg:min-h-10 bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 rounded-lg font-semibold disabled:opacity-50 inline-flex items-center gap-1">
      <Icon name="Send" size={12} /> {busy ? t("sendingBtn", "Sending…") : label}
    </button>
  );
  const textCls = compact ? "text-[12px]" : "text-sm";
  let line;
  if (kind === "sending") {
    // A send in flight elsewhere (another tab). The button stays: if that
    // send died, the server lets a new one take over; while it is live the
    // server answers in_progress — never a second mail, never a dead end.
    line = (
      <span className={`${textCls} text-gray-600 dark:text-gray-400 inline-flex items-center gap-2 flex-wrap`}>
        <span className="inline-flex items-center gap-1"><Icon name="Loader" size={13} className="animate-spin" /> {t("dcMailSending", "Sending to your revisor…")}</span>
        {acct && btn(t("dcMailSendAgain", "Send again"))}
      </span>
    );
  } else if (kind === "revisor") {
    // "Afleveret til mailserveren": the mail service accepted it. BonBox
    // hears nothing about delivery into the revisor's inbox, so the line
    // never claims more than that.
    line = (
      <span className={`${textCls} text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1`}>
        <Icon name="CheckCircle2" size={13} /> {whenText
          ? t("dcMailSentRevisorAt", "Handed to the mail server for your revisor ({email}) {when}", { email: acct, when: whenText })
          : t("dcMailSentRevisor", "Handed to the mail server for your revisor ({email})", { email: acct })}
      </span>
    );
  } else if (kind === "unrecorded") {
    // Locked before BonBox kept the send status: it may or may not have
    // gone — said so, with a way to send this one day now.
    line = (
      <span className={`${textCls} text-gray-600 dark:text-gray-400 inline-flex items-center gap-2 flex-wrap`}>
        <span className="inline-flex items-center gap-1"><Icon name="Mail" size={13} /> {t("dcMailUnrecorded", "Send to revisor: not recorded")}</span>
        {!profile?.accountant_opted_out && btn(t("dcMailSendToRevisor", "Send to revisor"), sendUnrecorded)}
      </span>
    );
  } else if (kind === "failed_owner") {
    // No revisor saved: the only mail was the owner's own copy, and it failed.
    line = (
      <span className={`${textCls} text-amber-700 dark:text-amber-300 inline-flex items-center gap-2 flex-wrap`}>
        <span className="inline-flex items-center gap-1"><Icon name="AlertTriangle" size={13} /> {t("dcMailOwnerCopyFailed", "Your copy was not sent — {reason}", { reason })}</span>
        {btn(t("dcMailSendAgain", "Send again"))}
      </span>
    );
  } else if (kind === "opted_out") {
    line = (
      <span className={`${textCls} text-gray-600 dark:text-gray-400 inline-flex items-center gap-1`}>
        <Icon name="BellOff" size={13} /> {t("dcMailOptedOut", "Your revisor ({email}) has unsubscribed from BonBox mail — send it from your own mail.", { email: acct || "—" })}
      </span>
    );
  } else if (kind === "claim_open" || kind === "claim_open_owner_failed") {
    // The revisor got nothing: the address IS confirmed, but the answer to
    // "Har du selv oprettet denne konto?" (mailed to the owner) is missing.
    // No Send button (it would be refused) and no "Bekræft nu" (it leads
    // nowhere): "Send spørgsmålet igen". The owner's OWN copy is said too.
    line = (
      <span className="inline-flex flex-col gap-1">
        {kind === "claim_open_owner_failed" && (
          <span className={`${textCls} text-amber-700 dark:text-amber-300 inline-flex items-center gap-1`} data-testid="dc-mail-owner-copy-failed">
            <Icon name="AlertTriangle" size={13} /> {t("dcMailOwnerCopyFailed", "Your copy was not sent — {reason}", { reason })}
          </span>
        )}
        <span className={`${textCls} text-amber-700 dark:text-amber-300 inline-flex items-center gap-2 flex-wrap`} data-testid="dc-mail-held-claim-open">
          <span className="inline-flex items-center gap-1"><Icon name="AlertTriangle" size={13} /> {ownerSent
            ? t("dcMailHeldClaimOpenSentYou", "Sent to you {when} — not to your revisor: BonBox is waiting for your answer to the question we e-mailed you", { when: whenText })
            : t("dcMailHeldClaimOpen", "Not sent to your revisor — BonBox is waiting for your answer to the question we e-mailed you (did you create this account yourself?)")}</span>
          <ClaimQuestionResend className="text-xs" testId="dc-mail-claim-resend" />
        </span>
      </span>
    );
  } else if (kind === "unverified" || kind === "unverified_owner_failed") {
    // The revisor got nothing: the owner's own e-mail is not confirmed yet.
    // No Send button (it would be refused) — the one tap that fixes it. What
    // happened to the owner's OWN copy is said too: it went ("Sendt til dig
    // …"), or it failed (its own line, with the cause).
    line = (
      <span className="inline-flex flex-col gap-1">
        {kind === "unverified_owner_failed" && (
          <span className={`${textCls} text-amber-700 dark:text-amber-300 inline-flex items-center gap-1`} data-testid="dc-mail-owner-copy-failed">
            <Icon name="AlertTriangle" size={13} /> {t("dcMailOwnerCopyFailed", "Your copy was not sent — {reason}", { reason })}
          </span>
        )}
        <span className={`${textCls} text-amber-700 dark:text-amber-300 inline-flex items-center gap-2 flex-wrap`} data-testid="dc-mail-held-unverified">
          <span className="inline-flex items-center gap-1"><Icon name="AlertTriangle" size={13} /> {ownerSent
            ? t("dcMailHeldUnverifiedSentYou", "Sent to you {when} — not to your revisor: confirm your e-mail first", { when: whenText })
            : t("dcMailHeldUnverified", "Not sent to your revisor — confirm your e-mail first")}</span>
          <Link to="/verify-email?now=1" className="text-xs font-semibold underline underline-offset-2">{t("verifyEmailNowCta", "Confirm now")}</Link>
        </span>
      </span>
    );
  } else if (kind === "unchanged") {
    // Re-locked with nothing changed: the revisor already holds these exact
    // figures, so BonBox sent them no "Rettet" mail. Send again stays here.
    line = (
      <span className={`${textCls} text-gray-700 dark:text-gray-300 inline-flex items-center gap-2 flex-wrap`}>
        <span className="inline-flex items-center gap-1"><Icon name="CheckCircle2" size={13} /> {t("dcMailUnchanged", "Locked again unchanged — your revisor already has these figures, so no new mail was sent")}</span>
        {acct && btn(t("dcMailSendAgain", "Send again"))}
      </span>
    );
  } else if (kind === "owner_only") {
    // Named by its address: "Sendt til dig" alone said nowhere which of the
    // owner's addresses got it (removal audit U4 — the lock card names the
    // owner's own address when it is the recipient).
    const ownerTo = (st.sentTo || []).join(", ");
    line = (
      <span className={`${textCls} text-gray-700 dark:text-gray-300 inline-flex items-center gap-2 flex-wrap`}>
        <span className="inline-flex items-center gap-1"><Icon name="Mail" size={13} /> {acct || identity
          ? t("dcMailOwnerOnly", "Sent to you ({to}) {when} — not to your revisor", { when: whenText, to: ownerTo })
          : demo
            ? t("dcMailOwnerOnlyDemoRevisor", "Sent to you ({to}) {when} — the revisor is sample data", { when: whenText, to: ownerTo })
            : t("dcMailOwnerOnlyNoRevisor", "Sent to you ({to}) {when} — no revisor e-mail saved", { when: whenText, to: ownerTo })}</span>
        {acct ? btn(t("dcMailSendToRevisor", "Send to revisor")) : (
          <Link to="/profile" className={`text-xs font-semibold underline ${PROFILE_LINK_TAP}`}>{identity
            ? t("identityIsDemoCta", "Correct your business on Profile")
            : demo
              ? t("dcRevisorIsDemoCta", "Save your own revisor on Profile")
              : t("dcMailAddRevisor", "Add revisor e-mail")}</Link>
        )}
      </span>
    );
  } else if (kind === "pref_off") {
    line = (
      <span className={`${textCls} text-gray-700 dark:text-gray-300 inline-flex items-center gap-2 flex-wrap`}>
        <span className="inline-flex items-center gap-1"><Icon name="BellOff" size={13} /> {t("dcMailPrefOff", "Not sent — automatic mail on lock is off")}</span>
        {acct && btn(t("dcMailSendToRevisor", "Send to revisor"))}
      </span>
    );
  } else if (kind === "no_recipient") {
    line = (
      <span className={`${textCls} text-amber-700 dark:text-amber-300 inline-flex items-center gap-1`}>
        <Icon name="AlertTriangle" size={13} /> {t("dcMailNoRecipientLine", "Not sent — no e-mail address on file.")} <Link to="/profile" className={`underline font-semibold ${PROFILE_LINK_TAP}`}>{t("profileLinkLabel", "Profile")}</Link>
      </span>
    );
  } else {
    // failed
    line = (
      <span className={`${textCls} text-amber-700 dark:text-amber-300 inline-flex items-center gap-2 flex-wrap`}>
        <span className="inline-flex items-center gap-1"><Icon name="AlertTriangle" size={13} /> {t("dcMailNotSent", "Not sent to your revisor — {reason}", { reason })}</span>
        {acct && btn(t("dcMailSendAgain", "Send again"))}
      </span>
    );
  }
  return (
    <div className="space-y-1">
      {line}
      {demoDay && kind !== "revisor" && (
        <p className={`${textCls} text-gray-600 dark:text-gray-400 flex items-center gap-1`} data-testid="dc-mail-demo-day">
          <Icon name="Info" size={13} className="shrink-0" /> {t("dcMailDemoDayNever", "Sample day — never sent to your revisor")}
        </p>
      )}
      {/* A real day, a real revisor — but the business is still the demo's
          sample company: nothing goes to the revisor until Profile says who
          the owner really is (the server: skip / 409 demo_identity). */}
      {identity && !demoDay && kind !== "revisor" && (
        <p className={`${textCls} text-amber-700 dark:text-amber-300 flex items-start gap-1`} data-testid="dc-mail-identity-demo">
          <Icon name="AlertTriangle" size={13} className="shrink-0 mt-0.5" /> <span>{t("identityIsDemoNotice", "Your business is still set up as the sample company (Mirabelle ApS). Correct the name, CVR and address on Profile before we send anything to your revisor.")}{kind !== "owner_only" && (
            <>{" "}<Link to="/profile" className={`font-semibold underline ${PROFILE_LINK_TAP}`}>{t("identityIsDemoCta", "Correct your business on Profile")}</Link></>
          )}</span>
        </p>
      )}
      {err && <p className="text-xs text-red-600 dark:text-red-400" role="alert">{err}</p>}
    </div>
  );
}

function JustLockedCard({ t, close, currency, onDismiss, businessType, dateLabel = "", profile = null, profileLoaded = false, onEmailSent = null }) {
  const ritual = close.close_ritual || {};
  // The server stores closed_at in UTC without a zone suffix; read bare, the
  // browser took it as LOCAL time and "låst kl. 08:55" appeared at 10:55.
  // The same clock as every send line on this page (sentWhen: "06.31").
  const closedAt = sentWhen(close.closed_at)?.time || "—";
  // Nobody typed "Lukket af": only the owner's own session can lock a day
  // (team seats are read-only), so it was the owner — named as BonBox names
  // the owner elsewhere (the account's business name), never "Staff"
  // (release gate, 9 Oct).
  const { user: lockUser } = useAuth();
  const closedBy = close.closed_by || lockUser?.business_name || t("dcLockedByOwner", "the owner");
  const recipientsList = close.email_sent_to?.length ? close.email_sent_to : (ritual.sent_to || []);
  const recipients = recipientsList.join(", ");

  // Local dismiss state for bank-drop — POST to backend so the
  // dismissal sticks across reloads/devices.
  const [bankDropDone, setBankDropDone] = useState(false);
  const emailStatus = ritual.email_status ?? close.email_status;
  // Whether CloseEmailStatus's own line names the recipients (the same state
  // it reads): only then is the plain "Sendt til …" line a repeat.
  const { kind: mailKind, acct: mailAcct } = closeEmailState({
    status: emailStatus ?? null,
    sentTo: recipientsList,
    skip: ritual.accountant_skip_reason ?? null,
    error: ritual.email_error ?? close.email_error ?? null,
    profile: profileLoaded ? (profile ?? {}) : null,
  });
  // The revisor line names the revisor's address only: when the owner's own
  // copy went too, the plain line is what names the owner's address — left
  // out, the card never said the owner got one (removal audit U4). The
  // owner-only line names the owner's own address itself ("Sendt til dig
  // (ejer@…)"), so there the plain line would only repeat it.
  const statusNamesWho = profileLoaded && (mailKind === "owner_only"
    || (mailKind === "revisor" && recipientsList.every((a) => String(a).toLowerCase() === mailAcct)));

  const handleBankDropDone = async () => {
    setBankDropDone(true);  // optimistic
    try {
      await api.post(`/daily-close/${close.id}/bank-drop-dismiss`);
    } catch {
      // Non-critical — UI already showed done; let it stand. Worst
      // case: the reminder re-appears on next reload.
    }
  };

  // The email status row — honest about every state, and the same component
  // History uses, so the card and the row can never disagree.
  let emailLine = null;
  if (emailStatus === "skipped_feature_locked") {
    // App Store compliance (Apple 3.1.1): on native, show a neutral status line
    // with NO upgrade pitch / tier name / CTA. Web keeps the "Upgrade to
    // Starter" conversion nudge below.
    emailLine = isNativeApp() ? (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        <Icon name="Info" size={14} className="inline align-text-bottom mr-1" /> {t("closeLockedAutoSendNativeNote", "Auto-send on lock isn't part of your current plan. You can still tap Send to revisor manually.")}
      </p>
    ) : (
      <div className="text-sm bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-200 dark:border-amber-800">
        <p className="text-amber-800 dark:text-amber-200 font-medium">
          <Icon name="Lightbulb" size={14} className="inline align-text-bottom mr-1" /> {t("closeLockedFreeUpgradeNudge", "Want the kasserapport auto-sent to your accountant the moment you lock? Upgrade to Starter.")}
        </p>
        {canPurchaseInApp() && (
          <Link to="/subscription" className="inline-block mt-2 text-[12px] font-semibold text-amber-800 dark:text-amber-300 hover:underline">
            {t("pricingUpgradeStarter", "Upgrade to Starter")} →
          </Link>
        )}
      </div>
    );
  } else if (emailStatus) {
    emailLine = (
      <div className="space-y-1">
        {/* Said once: when the status line below names who got it ("Sendt
            til dig — revisoren er eksempeldata", "Sendt til revisoren …")
            this plain line is left out. Every other state keeps it — a
            revisor send that failed, an unchanged or opted-out close: the
            status line names nobody there, and the owner's own copy that
            DID go would be said nowhere. */}
        {(emailStatus === "sent" || emailStatus === "partial") && recipients && !statusNamesWho && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            <Icon name="Mail" size={13} className="inline align-text-bottom mr-1" /> {t("closeLockedEmailSent", "Sent to {recipients}").replace("{recipients}", recipients)}
          </p>
        )}
        <CloseEmailStatus t={t} close={close} ritual={ritual} profile={profile} profileLoaded={profileLoaded} onSent={onEmailSent} />
        {ritual.scan_degraded && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            <Icon name="AlertTriangle" size={13} className="inline align-text-bottom mr-1" /> {t("closeLockedScanDegraded", "Z-report photo couldn't be fetched right now — your accountant got the PDF, no photo attached. We'll keep the original on file.")}
          </p>
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
          // A 44px target in the corner; it sat on top of the title's last
          // words on a phone.
          className="absolute top-1.5 right-1.5 w-11 h-11 inline-flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100"
        >
          <Icon name="X" size={18} />
        </button>
        <div className="flex items-start gap-3">
          <Icon name="CheckCircle2" size={26} className="text-emerald-600 dark:text-emerald-500 shrink-0" />
          <div className="flex-1 min-w-0 space-y-3">
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 pr-9">
              <Icon name="Lock" size={14} className="inline align-text-bottom mr-1" /> {dateLabel
                // "Tonight's" is only true of tonight: a back-filled day is named.
                // …with the figure it was locked at: a back-filled day has no
                // other trace of its amount on this card.
                ? (Number.isFinite(Number(close.revenue_total)) && close.revenue_total != null
                  ? t("dcPastDayLockedTitleAmount", "The kasserapport for {date} is locked at {amount} · {time} by {who}", {
                      date: dateLabel,
                      amount: formatOwnerMoney(Number(close.revenue_total), currency, { decimals: oreDecimals(close.revenue_total) }),
                      time: closedAt,
                      who: closedBy,
                    })
                  : t("dcPastDayLockedTitle", "The kasserapport for {date} is locked · {time} by {who}", { date: dateLabel, time: closedAt, who: closedBy }))
                : t(closeTitleKeyFor(businessType), "Tonight's kasserapport is locked · {time} by {who}", { time: closedAt, who: closedBy })}
            </p>
            {emailLine}
            {ritual.push_status === "sent" && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <Icon name="Bell" size={13} className="inline align-text-bottom mr-1" /> {t("closeLockedPushSent", "Owner notified via push")}
              </p>
            )}
            {showBankDrop && (
              <div className="bg-white dark:bg-gray-800 rounded-xl p-3 border border-amber-200 dark:border-amber-800 flex items-start gap-3">
                <Icon name="Landmark" size={20} className="text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t("bankDropReminderTitle", "Bank-drop reminder")}
                  </p>
                  <p className="text-[12px] text-gray-600 dark:text-gray-300 mt-0.5 tabular-nums">
                    {/* The template carries "{currency}" of its own and
                        formatOwnerMoney already appends a token, so both would
                        print "4.200 kr. DKK". The formatted amounts go in and
                        the template's token (with the space before it) comes
                        out — one token per figure, "kr." everywhere. */}
                    {/* The close stores the day's takings (the float already
                        taken off), so all of it goes in the bag. */}
                    {t("bankDropReminderTakings", "Put {amount} in the safe or drop bag — the float stays in the drawer.", {
                      amount: formatOwnerMoney(bankDrop.to_drop_dkk ?? 0, currency, { decimals: oreDecimals(bankDrop.to_drop_dkk) }),
                    })}
                  </p>
                  {/* A secondary button: white on amber-500 read at ~2:1. */}
                  <Button size="md" variant="secondary" onClick={handleBankDropDone} className="mt-2">
                    {t("bankDropMarkDone", "Marked as done")}
                  </Button>
                </div>
              </div>
            )}
            {bankDropDone && (
              <p className="text-xs text-gray-700 dark:text-gray-300">
                {t("bankDropDone", "✓ In safe")}
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
  loading = false, failed = false, isOnline = true, focusCloseId = null, onFocusConsumed }) {
  const { user, refreshUser } = useAuth();
  const confirm = useConfirm();
  // Tri-state: null while /billing/me is loading. Only a KNOWN "no" changes
  // the send path — a Free owner is never promised a BonBox send.
  const { hasFeature: hasEntitlement, isReady: entitlementsReady } = useEntitlements();
  const directSendEntitled = entitlementsReady ? hasEntitlement("direct_accountant_email") : null;
  const [downloading, setDownloading] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [sharing, setSharing] = useState(null);
  const [shareToast, setShareToast] = useState("");
  const [unlockId, setUnlockId] = useState(null);
  // A close opened to READ — a locked one had nothing to tap but Lås op,
  // Send and PDF; its MOMS, cash count and notes were nowhere in the app.
  const [openId, setOpenId] = useState(null);
  // Ten at a time: 30+ cards made History a 14.000px scroll on a phone.
  const [shownCount, setShownCount] = useState(10);
  // One precision for every card in the list, the way a ledger prints:
  // øre on every figure of every card shown when any of them has øre —
  // "28.469,00 kr." sat beside "20.315 kr." on the next card. Decided by all
  // of a card's figures (the open ledger's MOMS and ex-MOMS included), never
  // by whether it is open: "Vis detaljer" turned "28.469 kr." into
  // "28.469,00 kr." (round 16). "Vis flere" can bring øre in for the list.
  const listDec = useMemo(() => ((data || []).slice(0, shownCount).some((dc) => {
    const rev = dc.revenue_breakdown || {};
    const pay = dc.payment_breakdown || {};
    const revLinesSum = Object.values(rev).reduce((a, v) => a + (Number(v) || 0), 0);
    const unsplit = Object.keys(rev).length && Number(dc.revenue_total) > 0
      ? Math.round((Number(dc.revenue_total) - revLinesSum) * 100) / 100 : 0;
    return [dc.revenue_total, ...Object.values(rev), ...Object.values(pay), dc.cash_difference, dc.tips_total, unsplit,
      dc.moms_total, dc.revenue_ex_moms, dc.payment_total, dc.cash_expected, dc.cash_counted]
      .some((v) => v != null && oreDecimals(v) === LEDGER_DECIMALS);
  }) ? LEDGER_DECIMALS : GLANCE_DECIMALS), [data, shownCount]);
  // Opened for one close (the locked day's "Åbn Historik"): show it, open
  // its details and bring it into view — once.
  useEffect(() => {
    if (!focusCloseId || !data?.length) return;
    const idx = data.findIndex((dc) => dc.id === focusCloseId);
    onFocusConsumed?.();
    if (idx < 0) return;
    if (idx >= shownCount) setShownCount(idx + 1);
    setOpenId(focusCloseId);
    requestAnimationFrame(() => {
      const el = [...document.querySelectorAll("[data-close-id]")].find((n) => n.dataset.closeId === String(focusCloseId));
      el?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCloseId, data]);
  const [unlockReason, setUnlockReason] = useState("");
  const unlockReasonRef = useRef(null);
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
  const [rangePreset, setRangePreset] = useState("7d"); // 7d | 14d | 1m | prev | prevq | 3m | custom
  // A 7-day span (today and the six before it) — the old default was 8 days,
  // already over the Free window the moment "Brugerdefineret" was tapped.
  const [customFrom, setCustomFrom] = useState(isoDaysAgo(6));
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
  // The address a send may go to. The demo seeder's sample revisor is NOT
  // SAVED for every send (the server refuses it: 409 demo_recipient) — it is
  // never pre-filled, named as "your revisor" or mailed from here.
  const revisorEmail = revisorAddress(businessProfile);
  const revisorIsDemo = Boolean(businessProfile?.accountant_is_demo);
  // The business is still the demo's sample company (Mirabelle ApS): BonBox
  // sends the revisor nothing (409 demo_identity) until Profile holds the
  // owner's own name, CVR and address. The owner's own mail stays open — it
  // is not BonBox sending — but never pre-filled with the revisor.
  const identityDemo = Boolean(businessProfile?.identity_is_demo);
  // Plan caps from /billing/me — drives the cap-aware preset
  // buttons (Free=7d / Starter=31d / Pro=full year). Defaults to
  // 366 (the hard ceiling) so before /billing/me responds the UI
  // is permissive rather than restrictive — backend is the
  // authoritative gate either way.
  const [exportCapDays, setExportCapDays] = useState(366);
  const [planTier, setPlanTier] = useState("free");
  // A direct send that did not (or may not have) gone: what happened, and the
  // owner's choice of what to do next. Never a silent switch to mailto.
  const [sendIssue, setSendIssue] = useState(null);
  // The period send's key: kept across a lost response, so a second tap
  // replays the same send instead of mailing the revisor twice.
  const periodSendKeyRef = useRef(null);
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
    if (rangePreset === "prevq") {
      // The calendar quarter before this one — the MOMS period.
      return previousQuarter(to);
    }
    if (rangePreset === "prev") {
      // The calendar month before this one — what a revisor books.
      const [y, m] = to.split("-").map(Number);
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
      const mm = String(pm).padStart(2, "0");
      return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(last).padStart(2, "0")}` };
    }
    // Custom: use whatever the user typed; basic guard against
    // inverted ranges so the API doesn't bounce a 422 visibly.
    const f = customFrom > customTo ? customTo : customFrom;
    const t = customFrom > customTo ? customFrom : customTo;
    return { from: f, to: t };
  }, [rangePreset, customFrom, customTo]);

  // The range's counts come from the SERVER (GET /daily-close/range-counts —
  // the same rows the export and the send select). History's `data` holds
  // only the newest 90 closes, so "Forrige kvartal" counted 76 where the
  // mail counted 184. The cache is only the first paint until it answers,
  // and re-read whenever History reloads (a lock or unlock changes them).
  const rangeKey = `${activeRange.from}|${activeRange.to}`;
  const [rangeServer, setRangeServer] = useState(null);
  const latestRangeKey = useRef(rangeKey);
  latestRangeKey.current = rangeKey;
  const fetchRangeCounts = useCallback(async (from, to) => {
    const r = await api.get("/daily-close/range-counts", { params: { from, to } });
    const d = r?.data;
    if (!d || typeof d.n_locked !== "number") return null;
    const out = { key: `${from}|${to}`, nLocked: d.n_locked, nDrafts: d.n_drafts || 0,
      nDemo: d.n_demo || 0, locked: Array.isArray(d.locked) ? d.locked : [] };
    // A late answer for a range the owner already left never overwrites
    // the current one.
    if (out.key === latestRangeKey.current) setRangeServer(out);
    return out;
  }, []);
  useEffect(() => {
    fetchRangeCounts(activeRange.from, activeRange.to)
      .catch(() => { /* the cache below stays the fallback */ });
  }, [rangeKey, data]); // eslint-disable-line react-hooks/exhaustive-deps
  const serverCounts = rangeServer && rangeServer.key === rangeKey ? rangeServer : null;
  // What a send to the revisor actually counts: LOCKED closes. The confirm
  // said "4 lukninger" where the mail said "3 låste" — and a drafts-only
  // range could mail the revisor a "0,00 kr." bundle.
  // Demo (sample) closes are in no period export and never sent: counted
  // apart, the same rule as the server's range-counts (n_demo).
  const cachedAllInRange = useMemo(
    () => data.filter(dc => dc.date >= activeRange.from && dc.date <= activeRange.to),
    [data, activeRange],
  );
  const cachedInRange = useMemo(
    () => cachedAllInRange.filter(dc => !isDemoClose(dc)),
    [cachedAllInRange],
  );
  const lockedInRange = useMemo(
    () => (serverCounts ? serverCounts.locked
      : cachedInRange.filter(dc => (dc.status || "confirmed") === "confirmed")),
    [serverCounts, cachedInRange],
  );
  const lockedRangeCount = serverCounts ? serverCounts.nLocked : lockedInRange.length;
  const draftRangeCount = serverCounts ? serverCounts.nDrafts : cachedInRange.length - lockedInRange.length;
  const demoRangeCount = serverCounts ? serverCounts.nDemo : cachedAllInRange.length - cachedInRange.length;
  // Count closes that match the chosen range — gives the user
  // confidence ("Export 14 closes for this range") before they tap.
  const rangeCount = lockedRangeCount + draftRangeCount;

  // The plan's export window against the chosen range — said BEFORE anything
  // is generated, with the pieces the plan allows as one-tap buttons. The cap
  // UI stays silent until /billing/me has answered (exportCapDays < 366).
  const rangeSpan = spanDays(activeRange.from, activeRange.to);
  const overCap = exportCapDays < 366 && rangeSpan > exportCapDays;
  const pieces = useMemo(
    () => (overCap ? exportPieces(activeRange.from, activeRange.to, exportCapDays) : { kind: "fits", pieces: [] }),
    [overCap, activeRange, exportCapDays],
  );
  const [pieceBusy, setPieceBusy] = useState(null);

  // The period sends to the revisor — a lasting record (who/when/what) read
  // back from the server, not an 8-second toast.
  const [recentSends, setRecentSends] = useState([]);
  const loadRecentSends = () => {
    api.get("/daily-close/accountant-sends", { params: { limit: 3 } })
      .then((r) => setRecentSends(Array.isArray(r.data) ? r.data : []))
      .catch(() => {
        // A side record, never a claim: on a failed read the panel simply
        // shows no "Sidst sendt" line (it does not say "never sent").
      });
  };
  useEffect(() => { loadRecentSends(); }, []);

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

  const downloadRange = async (fmt, range = activeRange) => {
    setExportingFmt(fmt);
    setExportError("");
    try {
      const url = `/daily-close/export.${fmt}?from=${range.from}&to=${range.to}`;
      const res = await api.get(url, { responseType: "blob" });
      const blob = new Blob([res.data], { type: _MIME[fmt] || "application/octet-stream" });
      // Through the one delivery helper: this block revoked the blob URL in the
      // same tick as the click and never appended the anchor, which is a 0-byte
      // file on Safari and an ignored click on Firefox. A not-ok outcome is the
      // only signal the owner gets, so it reaches the same banner as a 402.
      // The server's name: "Kasserapporter <firma> <fra>–<til>.xlsx".
      const out = await saveFile(blob, filenameFromResponse(res, `Kasserapporter ${range.from}–${range.to}.${fmt}`), {
        type: _MIME[fmt] || "application/octet-stream",
      });
      if (!out.ok) setExportError(t("dcExportFailed"));
    } catch (e) {
      // Surface plan-cap (402) with the upgrade CTA distinctly from
      // other failures. The backend returns a structured detail with
      // {code: "plan_cap_exceeded", message, cap_days, plan} that we
      // parse via parseExportError() so the error banner contains
      // the upgrade link inline.
      const parsed = await parseExportError(e, t);
      setExportError(parsed.message);
      setExportErrorIsCap(parsed.isPlanCap);
      setTimeout(() => { setExportError(""); setExportErrorIsCap(false); }, 8000);
    } finally {
      setExportingFmt(null);
    }
  };

  // One piece of an over-window period, in the format chosen for the revisor.
  const downloadPiece = async (piece) => {
    setPieceBusy(`${piece.from}_${piece.to}`);
    try {
      await downloadRange(accountantFmt, piece);
    } finally {
      setPieceBusy(null);
    }
  };
  // One day's own kasserapport (the single-close PDF) — on every plan.
  const downloadDayPdf = async (dc) => {
    setPieceBusy(`day_${dc.id}`);
    setExportError("");
    try {
      const res = await api.get(`/daily-close/${dc.id}/pdf`, { responseType: "blob" });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const out = await saveFile(blob, filenameFromResponse(res, `Kasserapport ${dc.date}.pdf`), { type: "application/pdf" });
      if (!out.ok) setExportError(t("dcExportFailed"));
    } catch (e) {
      const parsed = await parseExportError(e, t);
      setExportError(parsed.message);
    } finally {
      setPieceBusy(null);
    }
  };
  const pieceLabel = (piece) => {
    if (piece.wholeMonth) {
      const month = new Date(`${piece.from}T12:00:00`).toLocaleDateString(dateLocale(), { month: "long" });
      return t("dcPieceMonth", "Get {month}", { month });
    }
    return t("dcPieceRange", "Get {from} – {to}", { from: shortRangeDay(piece.from), to: shortRangeDay(piece.to) });
  };

  /**
   * "Send to revisor" for the chosen date range.
   *
   * Starter+: BonBox mails the file to the SAVED revisor address (the owner
   * confirms recipient, period and format first). Free: the honest path — the
   * file downloads and the owner's own mail opens; no upgrade wall in front of
   * a promise the plan does not keep.
   *
   * A failed direct send NEVER silently switches to mailto any more: the
   * revisor could get it twice (the server may have sent before the response
   * was lost). The owner is told what happened and chooses.
   */
  const sendViaOwnMail = async (fmt, { freePath = false } = {}) => {
    setSendIssue(null);
    try {
      const url = `/daily-close/export.${fmt}?from=${activeRange.from}&to=${activeRange.to}`;
      const res = await api.get(url, { responseType: "blob" });
      const blob = new Blob([res.data], { type: _MIME[fmt] || "application/octet-stream" });
      const filename = filenameFromResponse(res, `Kasserapporter ${activeRange.from}–${activeRange.to}.${fmt}`);

      // Inherit language from user.language (set in Profile) — defaults
      // to Danish since the recipient is typically a DK accountant.
      const lang = (user?.language === "en") ? "en" : "da";

      // Never pre-fill an address that asked BonBox to stop — nor the
      // revisor at all while the business is still the sample company: the
      // file names "Mirabelle ApS", so the owner picks who gets it.
      const toAddr = businessProfile?.accountant_opted_out || identityDemo ? "" : revisorEmail;
      const result = await sendDailyCloseRangeToAccountant({
        blob, filename,
        accountantEmail: toAddr,
        // Never the demo's sample revisor's name (revisorEmail is "" for
        // it) — a real revisor keeps theirs, also when they opted out of
        // BonBox mail and the owner sends this from their own mail instead.
        accountantName: revisorEmail && !identityDemo ? (businessProfile?.accountant_name || "") : "",
        businessName: businessProfile?.company_name || user?.business_name || "",
        fromIso: activeRange.from,
        toIso: activeRange.to,
        // What the attached file counts: locked closes (drafts are listed,
        // never summed).
        closeCount: lockedRangeCount,
        language: lang,
      });

      if (result.ok) {
        if (freePath) {
          setSendStatus(t("dcSendFreeOwnMail", "On your plan you send it yourself: the file is downloaded and your mail app is open."));
        } else if (result.channel === "share") {
          setSendStatus(t("sentViaShare", "Share sheet opened — pick Mail / WhatsApp"));
        } else if (result.channel === "mailto") {
          setSendStatus(
            // What the mail app was opened with: no address pre-filled (none
            // saved, opted out, or the business still the sample company)
            // says "add the address".
            toAddr
              ? (t("sentViaMailto", "Email opened — attach the downloaded PDF and send"))
              : (t("sentViaMailtoNoTo", "Email opened — add revisor address, attach PDF, send")),
          );
        } else {
          setSendStatus(t("downloadedFallback", "Downloaded — attach manually to email"));
        }
        setTimeout(() => setSendStatus(""), 8000);
      } else {
        setExportError(result.reason || t("opsCloseShareFailed", "Could not start the share. Please try the PDF download instead."));
        setTimeout(() => setExportError(""), 5000);
      }
    } catch (e) {
      const parsed = await parseExportError(e, t);
      setExportError(parsed.message);
      setExportErrorIsCap(parsed.isPlanCap);
      setTimeout(() => { setExportError(""); setExportErrorIsCap(false); }, 8000);
    }
  };

  const sendToAccountant = async () => {
    setExportError("");
    setSendStatus("");
    setSendIssue(null);
    const fmt = accountantFmt; // honour the user's saved choice
    // Never the demo seeder's sample revisor (revisorAddress → "").
    const acct = revisorEmail;
    const optedOut = Boolean(businessProfile?.accountant_opted_out);

    if (identityDemo && acct && !optedOut && directSendEntitled !== false) {
      // A real revisor, but the business is still the sample company: BonBox
      // sends nothing (the server: 409 demo_identity). Only THIS send is
      // fenced — no revisor, the sample revisor, an opted-out revisor and the
      // Free plan's own-mail path download the file as before (never
      // pre-filled with the revisor while the identity is the sample's).
      setExportError(t("identityIsDemoNotice", "Your business is still set up as the sample company (Mirabelle ApS). Correct the name, CVR and address on Profile before we send anything to your revisor."));
      return;
    }

    if (acct && !optedOut && directSendEntitled === false) {
      // Free: BonBox does not send. No "goes to {email}. You get a copy."
      // confirm in front of a path that then downloads and opens the owner's
      // own mail — straight to the plan's honest path.
      setSendingToAccountant(true);
      try {
        await sendViaOwnMail(fmt, { freePath: true });
      } finally {
        setSendingToAccountant(false);
      }
      return;
    }

    if (acct && !optedOut) {
      // Who, what, which days — before one tap mails a third party. LOCKED
      // closes only (what the mail and the file count), the drafts named as
      // left out, and the address the owner's copy goes to. Counted by the
      // server at this moment — never from History's 90-row cache.
      let nLocked = lockedRangeCount;
      let nDrafts = draftRangeCount;
      let nDemo = demoRangeCount;
      try {
        const fresh = await fetchRangeCounts(activeRange.from, activeRange.to);
        if (fresh) { nLocked = fresh.nLocked; nDrafts = fresh.nDrafts; nDemo = fresh.nDemo || 0; }
      } catch { /* the server refuses an empty period on its own */ }
      if (nLocked === 0) {
        setExportError(nDemo > 0
          ? t("dcSendOnlyDemo", "This period only has sample days (demo data) — they are never sent to your revisor. Lock your real days first.")
          : t("dcSendNothingLocked", "There are no locked closes in this period — lock the days before you send them to your revisor."));
        return;
      }
      const closesTxt = nLocked === 1
        ? t("dcSendLockedOne", "1 locked close")
        : t("dcSendLockedMany", "{n} locked closes", { n: nLocked });
      const draftsTxt = nDrafts <= 0 ? ""
        : nDrafts === 1
          ? t("dcSendDraftLeftOne", " · 1 draft is not counted")
          : t("dcSendDraftLeftMany", " · {n} drafts are not counted", { n: nDrafts });
      // Sample days are named as left out — the revisor gets only real days.
      const demoTxt = nDemo <= 0 ? ""
        : nDemo === 1
          ? t("dcSendDemoLeftOne", " · 1 sample day (demo) is not sent")
          : t("dcSendDemoLeftMany", " · {n} sample days (demo) are not sent", { n: nDemo });
      // Held for this account right now (unconfirmed e-mail, or the "did you
      // create this account?" question open): BonBox would send the revisor
      // nothing — and no copy. Say that BEFORE the send, instead of a
      // confirm that promises "goes to {email}" (release gate, 9 Oct). Only
      // on a FRESH read of the account (an address confirmed in another tab
      // is not held here); without one, the server decides (403 → the same
      // notice below). Only once the plan is KNOWN to send directly: while
      // it loads (null) the server's own order answers — plan first,
      // confirm last (release gate review, 9 Oct).
      const heldNow = directSendEntitled === true
        ? heldReasonForUser(await refreshUser?.())
        : null;
      if (heldNow) {
        setSendIssue({
          message: heldNow === HELD_CLAIM_OPEN
            ? t("dcMailHeldClaimOpen", "Not sent to your revisor — BonBox is waiting for your answer to the question we e-mailed you (did you create this account yourself?)")
            : t("dcMailHeldUnverified", "Not sent to your revisor — confirm your e-mail first"),
          fmt, verify: heldNow === HELD_UNVERIFIED, claim: heldNow === HELD_CLAIM_OPEN,
        });
        return;
      }
      // The copy goes to the login address — the same one the server uses.
      const ownerCopy = (user?.email || "").trim() || t("dcYourOwnMail", "your own mail");
      const ok = await confirm({
        title: t("dcSendConfirmTitle", "Send to your revisor?"),
        message: t("dcSendConfirmBody", "{format} for {from} – {to} ({closes}{drafts}) goes to {email}. You get a copy at {owner}.", {
          format: FMT_LABEL[fmt] || fmt, from: shortRangeDay(activeRange.from), to: shortRangeDay(activeRange.to),
          closes: closesTxt, drafts: draftsTxt + demoTxt, email: acct, owner: ownerCopy,
        }),
        confirmLabel: t("sendToAccountantBtn", "Send to revisor"),
        cancelLabel: t("cancel", "Cancel"),
        // A mail to a third party cannot be called back: focus on Cancel.
        irreversible: true,
      });
      if (!ok) return;
      setSendingToAccountant(true);
      try {
        // One key per confirmed tap: a retried POST answers with the first
        // send's outcome instead of mailing the revisor twice.
        // Only for the SAME send: another period or format is a new key.
        const sig = `${activeRange.from}|${activeRange.to}|${fmt}`;
        if (periodSendKeyRef.current?.sig !== sig) periodSendKeyRef.current = { sig, key: newSendKey() };
        const r = await api.post(
          `/daily-close/send-to-accountant?from=${activeRange.from}&to=${activeRange.to}`,
          { fmt, cc_self: true, key: periodSendKeyRef.current.key },
          // A send is not replayed by the interceptor: a lost response does
          // not mean nothing was sent.
          { _noRetry: true },
        );
        periodSendKeyRef.current = null;
        if (r.data?.ok) {
          setSendStatus(
            (t("sentToAccountantOk", "Sent to")) +
            ` ${r.data.sent_to}` +
            (r.data.cc_self ? ` (${t("ccdYou", "you cc'd")})` : "")
          );
          setTimeout(() => setSendStatus(""), 8000);
          loadRecentSends();
          return;
        }
      } catch (e) {
        const status = e.response?.status;
        const detail = e.response?.data?.detail;
        // An answer means the server decided: the next tap is a new send.
        // No answer (lost response) keeps the key, so a retry replays it.
        if (e.response) periodSendKeyRef.current = null;
        if (status === 402 && detail?.feature === "direct_accountant_email") {
          // Free: download + own mail is the plan's path — go straight there.
          await sendViaOwnMail(fmt, { freePath: true });
          return;
        }
        if (status === 402) {
          // Date-range plan cap — the existing banner with its upgrade link.
          const parsed = await parseExportError(e, t);
          setExportError(parsed.message);
          setExportErrorIsCap(parsed.isPlanCap);
          setTimeout(() => { setExportError(""); setExportErrorIsCap(false); }, 8000);
          return;
        }
        let message;
        let verify = false;
        let claim = false;
        if (status === 403 && detail?.code === "email_unverified" && heldReasonFromError(e) === HELD_CLAIM_OPEN) {
          // The address IS confirmed; the answer to the mailed question is
          // missing — "Send spørgsmålet igen", never "Bekræft nu".
          message = t("dcMailHeldClaimOpen", "Not sent to your revisor — BonBox is waiting for your answer to the question we e-mailed you (did you create this account yourself?)");
          claim = true;
        } else if (status === 403 && detail?.code === "email_unverified") {
          // Nothing was mailed — not the revisor, not a copy. The owner's own
          // mail still works (the button below), and "Bekræft nu" opens BonBox's.
          message = t("dcMailHeldUnverified", "Not sent to your revisor — confirm your e-mail first");
          verify = true;
        } else if (status === 422 && detail?.code === "nothing_locked") {
          message = detail?.n_demo > 0
            ? t("dcSendOnlyDemo", "This period only has sample days (demo data) — they are never sent to your revisor. Lock your real days first.")
            : t("dcSendNothingLocked", "There are no locked closes in this period — lock the days before you send them to your revisor.");
        } else if (status === 409 && detail?.code === "demo_recipient") {
          message = t("dcRevisorIsDemo", "The revisor is sample data — save your own revisor's name and e-mail on Profile.");
        } else if (status === 409 && detail?.code === "demo_identity") {
          message = t("identityIsDemoNotice", "Your business is still set up as the sample company (Mirabelle ApS). Correct the name, CVR and address on Profile before we send anything to your revisor.");
        } else if (status === 409 && detail?.code === "accountant_opted_out") {
          message = t("dcSendOptedOut", "Your revisor has unsubscribed from BonBox mail, so BonBox won't send it. You can send the file from your own mail.");
        } else if (status === 429) {
          message = t("dcSendDailyCap", "BonBox has sent your revisor the most mails it sends in a day. Send this one from your own mail, or try tomorrow.");
        } else if (status === 503 && detail?.reason === "email_not_configured") {
          message = t("dcSendNotConfigured", "Sending from BonBox isn't set up here, so nothing was sent. Send the file from your own mail.");
        } else if (status === 502 && detail?.code === "email_send_failed") {
          // The mail service answered with an error. The owner's copy is only
          // sent after the revisor's send succeeds, so no copy is coming —
          // telling them to wait for one sent them looking for nothing.
          message = t("dcSendProviderFailed", "The mail service reported an error, so it most likely did not reach {email} — and no copy was sent to you. Send the file from your own mail, or try again in a moment.", { email: acct });
        } else if (!e.response || status >= 500) {
          message = t("dcSendUnknown", "We couldn't confirm whether it reached {email}. Check your inbox — you get a copy — before sending it another way.", { email: acct });
        } else {
          message = errText(e, t("dcSendFailedDirect", "BonBox couldn't send it. Nothing was sent."));
        }
        setSendIssue({ message, fmt, verify, claim });
        return;
      } finally {
        setSendingToAccountant(false);
      }
    }

    // No revisor saved, or they opted out: download + the owner's own mail.
    setSendingToAccountant(true);
    try {
      await sendViaOwnMail(fmt);
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
      message: !isPaymentsOnly(dc) ? t(
        "dcDeleteDraftBodyAmount",
        // No full stop straight after the amount: the Danish money token ends
        // in one already ("1.070 kr."), and the dialog rendered "kr..".
        "This kladde shows {amount} — it is removed from your history and from anything you send your revisor. Locked closes cannot be deleted.",
        // Øre when the row has them — the card said 17.912,75 kr., the dialog 17.913 kr.
        { amount: formatOwnerMoney(dc.revenue_total ?? 0, currency, { decimals: oreDecimals(dc.revenue_total) }) },
      )
        // A draft of payments only (round 21) says so, never "viser 0 kr.".
        : t("dcDeleteDraftBodyPaymentsOnly", "This kladde shows only payments of {amount} — it is removed from your history and from anything you send your revisor. Locked closes cannot be deleted.",
          { amount: formatOwnerMoney(paymentsOf(dc), currency, { decimals: oreDecimals(paymentsOf(dc)) }) }),
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
      // Mirrored from the server's own Content-Disposition:
      // "Kasserapport <firma> <dato>.pdf" / "Kasserapport KLADDE …".
      const name = filenameFromResponse(res, isDraft
        ? `Kasserapport KLADDE ${dateStr}.pdf`
        : `Kasserapport ${dateStr}.pdf`);
      const out = await saveFile(res.data, name, {
        type: "application/pdf",
      });
      if (!out.ok) setRowError({ id, message: t("dcExportFailed"), isPlanCap: false });
    } catch (e) {
      // Same blob-aware parser the range export uses, so a plan cap (402)
      // arrives here as a real sentence plus the upgrade link instead of a
      // button that flickers and does nothing.
      const parsed = await parseExportError(e, t);
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
      // The same name as every revisor artifact (the profile's legal name).
      const bizName = businessProfile?.company_name || user?.business_name;
      const title = buildShareTitle({
        businessName: bizName,
        dateLabel,
      });
      const text = buildShareMessage(aggregated, {
        businessName: bizName,
        dateLabel,
        currency,
      });
      const res = await shareCloseSummary({ title, text });
      if (res.ok) {
        setShareToast(
          res.channel === "clipboard"
            ? (t("shareCopiedToClipboard", "Copied to clipboard — paste into your group"))
            : (t("shareOpened", "Share sheet opened")),
        );
        setTimeout(() => setShareToast(""), 3000);
      } else {
        setShareToast(t("shareFailed", "Could not open share sheet"));
        setTimeout(() => setShareToast(""), 4000);
      }
    } catch {
      setShareToast(t("shareFailed", "Could not open share sheet"));
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
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t("noDailyClosesYetHint", "Submit your first end-of-day close to see history here.")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-sm:flex max-sm:flex-col max-sm:space-y-0 max-sm:gap-3">
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
          profile={businessProfile}
          profileLoaded={profileKnown}
          businessType={user?.business_type}
          onDismiss={onDismissLastLocked}
          onEmailSent={onRefresh}
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

      {/* On a phone the closes come first and the export panel follows them
          all (~14.000px down). One line here jumps straight to it. */}
      <button type="button"
        onClick={() => document.getElementById("dc-export-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        className="sm:hidden w-full min-h-11 px-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-[13px] font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2"><Icon name="Package" size={16} className="text-gray-500 dark:text-gray-400" /> {t("dcJumpToExport", "Send a period to your revisor")}</span>
        <Icon name="ChevronDown" size={16} className="text-gray-500 dark:text-gray-400" />
      </button>

      {/* Date-range export panel — accountant handoff.
          Lets the owner pick a window (7d / 14d / 1m / 3m / custom)
          and pull a multi-day PDF or CSV in one click. Distinct from
          the per-close PDF on each row below — this is the
          "send the whole month to my bookkeeper" format. */}
      <div id="dc-export-panel" className="scroll-mt-20 bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm max-sm:order-1">
        <div className="flex items-center gap-2 mb-3">
          <Icon name="Package" size={18} className="text-gray-500 dark:text-gray-400" />
          <h3 className="text-[14px] font-semibold text-gray-900 dark:text-white">
            {t("exportToAccountantTitle", "Export to accountant")}
          </h3>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          {t("exportToAccountantDesc", "Pick a period. Excel is for your revisor's bookkeeping, PDF is an overview, and the CSV opens in Danish Excel (semicolon, decimal comma). Drafts are listed but never counted.")}
        </p>

        {/* Preset buttons. None is locked: a period longer than the plan's
            export window is still the owner's to choose — the panel then says
            so before anything is generated and offers the pieces the plan
            allows (see the over-window notice below). The backend still
            enforces the window (402) whatever the client does. */}
        <div className="flex flex-wrap gap-2 mb-3">
          {[
            { id: "7d",     label: t("rangePreset7d", "Last 7 days") },
            { id: "14d",    label: t("rangePreset14d", "Last 14 days") },
            { id: "1m",     label: t("rangePreset1m", "Last 1 month") },
            { id: "prev",   label: t("rangePresetPrevMonth", "Last month") },
            { id: "prevq",  label: t("rangePresetPrevQuarter", "Last quarter") },
            { id: "3m",     label: t("rangePreset3m", "Last 3 months") },
            { id: "custom", label: t("rangePresetCustom", "Custom") },
          ].map(p => {
            const isActive = rangePreset === p.id;
            return (
              <button
                key={p.id}
                onClick={() => { userPickedRange.current = true; setRangePreset(p.id); }}
                aria-pressed={isActive}
                // The app's selected state in both themes: in dark the chosen
                // range was the DARKEST button and read as the unselected one.
                className={`px-3 min-h-10 lg:min-h-8 rounded-lg text-[13px] sm:text-xs font-semibold border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 ${
                  isActive
                    ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                    : "bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600 hover:border-gray-300"
                }`}
              >
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
                {t("planCapHintNativePrefix", "Export covers up to")}{" "}<strong>{exportCapDays} {t("planCapHintDays", "days")}</strong>.
              </span>
            ) : (
              <span className="flex-1">
                <strong>{planTier === "free" ? t("pricingTierFree", "Free") : planTier} {t("planLabelSuffix", "plan")}</strong>
                {" "}{t("planCapHintMid", "exports up to")}{" "}<strong>{exportCapDays} {t("planCapHintDays", "days")}</strong>.
                {canPurchaseInApp() && (
                  <Link to="/subscription" className="ml-2 underline font-semibold hover:no-underline">
                    {t("planCapHintCta", "Upgrade for full year →")}
                  </Link>
                )}
              </span>
            )}
          </div>
        )}

        {/* Custom range pickers — shown only when preset === 'custom'.
            Any past day can start a range: the plan's window limits how many
            days ONE export spans, not how far back it may start (the picker
            used to grey out everything before "today minus the window", so a
            Starter owner could not pick July at all). A range longer than the
            window gets the pieces notice below. */}
        {rangePreset === "custom" && (
          <div>
            <div className="flex flex-wrap items-end gap-3 mb-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">
                {t("dcRangeFrom", "From")}
                <input
                  type="date"
                  value={customFrom}
                  max={customTo}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="block mt-1 px-3 py-1.5 max-lg:h-11 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-white text-sm"
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
                  className="block mt-1 px-3 py-1.5 max-lg:h-11 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-white text-sm"
                />
              </label>
            </div>
          </div>
        )}

        {/* Longer than the plan's export window: said plainly, BEFORE anything
            is generated, with the allowed pieces as one-tap buttons — never a
            dead end and never only an upgrade wall. */}
        {overCap && (
          <div data-testid="dc-over-cap" className="mb-3 px-3 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[12px] text-amber-800 dark:text-amber-200" role="status">
            <p className="flex items-start gap-2">
              <Icon name="Info" size={14} className="shrink-0 mt-0.5" />
              <span>
                {pieces.kind === "months"
                  ? t("dcRangeOverCapMonths", "This period is {span} days. Your plan exports up to {cap} days at a time — get it month by month as {format}:", {
                      span: rangeSpan, cap: exportCapDays, format: FMT_LABEL[accountantFmt] || accountantFmt })
                  : t("dcRangeOverCapTail", "This period is {span} days. Your plan exports up to {cap} days at a time — get the last {cap} days as {format}, or each day's own kasserapport (PDF):", {
                      span: rangeSpan, cap: exportCapDays, format: FMT_LABEL[accountantFmt] || accountantFmt })}
              </span>
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              {pieces.pieces.map((piece) => (
                <Button key={`${piece.from}_${piece.to}`} size="sm" variant="secondary"
                  className="border border-amber-300 dark:border-amber-700 max-lg:h-10"
                  busy={pieceBusy === `${piece.from}_${piece.to}`}
                  disabled={!!pieceBusy || !!exportingFmt}
                  onClick={() => downloadPiece(piece)}
                  iconLeft={<Icon name="Download" size={13} />}>
                  {pieces.kind === "tail"
                    ? t("dcPieceLastDays", "Last {n} days ({from} – {to})", { n: exportCapDays, from: shortRangeDay(piece.from), to: shortRangeDay(piece.to) })
                    : pieceLabel(piece)}
                </Button>
              ))}
            </div>
            {pieces.kind === "tail" && lockedInRange.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2" aria-label={t("dcPieceDaysLabel", "Each day's kasserapport")}>
                {[...lockedInRange].sort((a, b) => (a.date < b.date ? -1 : 1)).map((dc) => (
                  <button key={dc.id} type="button" onClick={() => downloadDayPdf(dc)}
                    disabled={!!pieceBusy}
                    className="px-2 min-h-8 max-lg:min-h-10 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-800 text-[12px] font-medium text-gray-800 dark:text-gray-100 disabled:opacity-50">
                    {t("dcPieceDay", "Kasserapport {date}", { date: shortRangeDay(dc.date) })}
                  </button>
                ))}
              </div>
            )}
            {!isNativeApp() && canPurchaseInApp() && (
              <p className="mt-2">
                <Link to="/subscription" className="underline font-semibold hover:no-underline">
                  {exportCapDays < 31
                    ? t("dcRangeOverCapUpgradeStarter", "The whole period in one file: Starter →")
                    : t("dcRangeOverCapUpgradePro", "The whole period in one file: Pro →")}
                </Link>
              </p>
            )}
          </div>
        )}

        {/* Range summary + download buttons */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {/* "25. sep. – 1. okt.", not the ISO "2026-09-25 → 2026-10-01". */}
            <strong className="text-gray-700 dark:text-gray-300">{shortRangeDay(activeRange.from)}</strong>
            {" – "}
            <strong className="text-gray-700 dark:text-gray-300">{shortRangeDay(activeRange.to)}</strong>
            {"  ·  "}
            {/* What the files and the mail count: locked closes, with any
                drafts named beside them ("26 låste · 1 kladde"). */}
            {draftRangeCount > 0
              ? t("dcRangeLockedAndDrafts", "{locked} locked · {drafts} draft(s)", { locked: lockedRangeCount, drafts: draftRangeCount })
              : <>{rangeCount} {rangeCount === 1
                  ? (t("closeSingular", "close"))
                  : (t("closePlural", "closes"))}</>}
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
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0 || overCap}
              iconLeft={exportingFmt === "xlsx" ? null : <Icon name="BarChart3" size={14} />}
              className="max-lg:h-10"
              title={t("excelTooltip", "Best for your accountant — sortable, filterable, pivotable")}
            >
              {exportingFmt === "xlsx" ? (t("generatingPdfBtn", "Generating…")) : "Excel"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => downloadRange("pdf")}
              busy={exportingFmt === "pdf"}
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0 || overCap}
              iconLeft={exportingFmt === "pdf" ? null : <Icon name="FileText" size={14} />}
              className="border border-gray-200 dark:border-gray-700 max-lg:h-10"
              title={t("pdfTooltip", "One-pager — easy to read, not editable")}
            >
              {exportingFmt === "pdf" ? (t("generatingPdfBtn", "Generating…")) : "PDF"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => downloadRange("csv")}
              busy={exportingFmt === "csv"}
              disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0 || overCap}
              iconLeft={exportingFmt === "csv" ? null : <Icon name="FileSpreadsheet" size={14} />}
              className="border border-gray-200 dark:border-gray-700 max-lg:h-10"
              title={t("csvTooltip", "Semicolon + decimal comma — opens in Danish Excel")}
            >
              {exportingFmt === "csv" ? (t("generatingPdfBtn", "Generating…")) : "CSV"}
            </Button>

            {/* Vertical divider + send-to-accountant group */}
            <div className="hidden sm:block w-px h-6 bg-gray-200 dark:bg-gray-700 mx-1" />

            <div className="flex gap-1 items-center">
              <select
                value={accountantFmt}
                onChange={(e) => persistAccountantFmt(e.target.value)}
                disabled={!!exportingFmt || sendingToAccountant || rangeCount === 0}
                className="px-2 py-1.5 max-lg:h-10 rounded-l-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:opacity-50"
                title={t("accountantFmtTooltip", "Pick the format your accountant prefers")}
              >
                <option value="xlsx">Excel</option>
                <option value="pdf">PDF</option>
                <option value="csv">CSV</option>
              </select>
              <button
                onClick={sendToAccountant}
                // Only LOCKED closes go to a revisor: a drafts-only period
                // has nothing to send.
                disabled={!!exportingFmt || sendingToAccountant || lockedRangeCount === 0 || overCap}
                className="px-3 py-1.5 max-lg:h-10 rounded-r-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white disabled:bg-gray-200 disabled:text-gray-600 dark:disabled:bg-gray-700 dark:disabled:text-gray-300 text-white text-xs font-semibold flex items-center gap-1 transition"
                title={
                  revisorEmail
                    ? `${t("sendToTooltip", "Send to")} ${revisorEmail}`
                    : (t("sendToAccountantTooltipNoEmail", "Send to revisor — set their email on Profile to skip typing it"))
                }
              >
                {sendingToAccountant
                  ? <><Icon name="Loader" size={14} className="animate-spin" /> {t("sendingBtn", "Sending…")}</>
                  : <><Icon name="Send" size={14} /> {t("sendToAccountantBtn", "Send to revisor")}</>}
              </button>
            </div>
          </div>
        </div>

        {/* Empty-range guidance — when the chosen window has no closes but the
            business HAS closed before, explain WHY it's empty and offer a
            one-tap jump to the most recent close. Without this, "0 closes" +
            greyed buttons reads as a broken report. */}
        {rangeCount === 0 && data.length > 0 && demoRangeCount === 0 && (
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
            <Icon name="Lightbulb" size={12} className="inline align-text-bottom mr-1" /> {t("accountantHint", "Tip: save your revisor's email on ")}
            <Link to="/profile" className={`text-amber-600 dark:text-amber-400 hover:underline ${PROFILE_LINK_TAP}`}>
              {t("profileLinkLabel", "Profile")}
            </Link>
            {" "}{t("accountantHintTail", "to skip typing it every time.")}
          </p>
        )}

        {/* Who a send goes to — on the screen, not in a hover tooltip a
            phone cannot show. */}
        {/* The saved revisor is the demo seeder's sample: say so — Send
            opens the owner's own mail, never to the sample address. The
            business still the sample company: BonBox sends the revisor
            nothing, and the owner's own mail is not pre-filled with them. */}
        {profileKnown && identityDemo && (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300" data-testid="dc-identity-demo">
            <Icon name="AlertTriangle" size={12} className="inline align-text-bottom mr-1" />
            {t("identityIsDemoNotice", "Your business is still set up as the sample company (Mirabelle ApS). Correct the name, CVR and address on Profile before we send anything to your revisor.")}{" "}
            <Link to="/profile" className={`font-semibold underline ${PROFILE_LINK_TAP}`}>{t("profileLinkLabel", "Profile")}</Link>
          </p>
        )}
        {profileKnown && revisorIsDemo && (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300" data-testid="dc-revisor-demo">
            <Icon name="Info" size={12} className="inline align-text-bottom mr-1" />
            {t("dcRevisorIsDemo", "The revisor is sample data — save your own revisor's name and e-mail on Profile.")}{" "}
            <Link to="/profile" className={`font-semibold underline ${PROFILE_LINK_TAP}`}>{t("profileLinkLabel", "Profile")}</Link>
          </p>
        )}

        {profileKnown && revisorEmail && !identityDemo && rangeCount > 0 && (
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            {businessProfile?.accountant_opted_out
              ? t("dcSendToLineOptedOut", "Your revisor ({email}) has unsubscribed from BonBox mail — Send opens your own mail instead.", { email: businessProfile.accountant_email })
              : directSendEntitled === false
                ? t("dcSendToLineOwnMail", "Send downloads the {format} and opens your own mail to {email} — you send it yourself.", {
                    email: businessProfile.accountant_email,
                    format: FMT_LABEL[accountantFmt] || accountantFmt,
                  })
                : t("dcSendToLine", "Send goes to {email} · {format} · {from} – {to}", {
                    email: businessProfile.accountant_email,
                    format: FMT_LABEL[accountantFmt] || accountantFmt,
                    from: shortRangeDay(activeRange.from), to: shortRangeDay(activeRange.to),
                  })}
          </p>
        )}

        {/* Drafts but nothing locked: why Send is greyed out. */}
        {rangeCount > 0 && lockedRangeCount === 0 && (
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            {t("dcSendNothingLocked", "There are no locked closes in this period — lock the days before you send them to your revisor.")}
          </p>
        )}

        {/* Sample days are in no export and never reach the revisor. */}
        {demoRangeCount > 0 && (
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400" data-testid="dc-range-demo">
            {demoRangeCount === 1
              ? t("dcRangeDemoOne", "1 sample day (demo data) in this period is not in the export and is never sent to your revisor.")
              : t("dcRangeDemoMany", "{n} sample days (demo data) in this period are not in the export and are never sent to your revisor.", { n: demoRangeCount })}
          </p>
        )}

        {/* The lasting record of what this panel sent to the revisor. */}
        {recentSends.length > 0 && (
          <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400" data-testid="dc-recent-sends">
            <p className="font-semibold text-gray-600 dark:text-gray-300">{t("dcRecentSendsTitle", "Sent to your revisor from here")}</p>
            <ul className="mt-0.5 space-y-0.5">
              {recentSends.map((r, i) => {
                const w = sentWhen(r.sent_at);
                return (
                  <li key={`${r.sent_at}_${i}`}>
                    {t("dcRecentSendLine", "{from} – {to} · {format} · {n} locked · to {email} · {when}", {
                      from: shortRangeDay(r.from), to: shortRangeDay(r.to),
                      format: FMT_LABEL[r.format] || r.format || "—",
                      n: r.n_closes ?? "—", email: r.recipient || "—",
                      when: w ? t("dcMailWhen", "{date} at {time}", w) : "—",
                    })}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {sendIssue && (
          <div className="mt-2 px-3 py-2 rounded-lg text-xs bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200" role="alert">
            <p className="flex items-start gap-2"><Icon name="AlertTriangle" size={14} className="shrink-0 mt-0.5" /> <span>{sendIssue.message}{sendIssue.verify && (
              <>{" "}<Link to="/verify-email?now=1" className="font-semibold underline underline-offset-2 whitespace-nowrap" data-testid="dc-send-verify-now">{t("verifyEmailNowCta", "Confirm now")}</Link></>
            )}{sendIssue.claim && (
              <>{" "}<ClaimQuestionResend testId="dc-send-claim-resend" /></>
            )}</span></p>
            <div className="flex flex-wrap gap-2 mt-2">
              <Button size="sm" variant="secondary" className="border border-amber-300 dark:border-amber-700 max-lg:h-10"
                onClick={() => sendViaOwnMail(sendIssue.fmt)} iconLeft={<Icon name="Mail" size={13} />}>
                {t("dcSendViaOwnMail", "Send from my own mail")}
              </Button>
              <Button size="sm" variant="secondary" className="border border-gray-200 dark:border-gray-700 max-lg:h-10"
                onClick={() => setSendIssue(null)}>
                {t("dismiss", "Dismiss")}
              </Button>
            </div>
          </div>
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

      {/* Calendar heat map. On a phone the closes come first — the export
          panel and this map put the first close about two screens down. */}
      <div className="max-sm:order-1"><CalendarHeatMap data={data} currency={currency} /></div>

      {data.slice(0, shownCount).map((dc, idx) => {
        const rev = dc.revenue_breakdown || {};
        const pay = dc.payment_breakdown || {};
        const cardDec = listDec;
        const prev = data[idx + 1]; // previous close (list sorted desc)
        const revChange = prev && prev.revenue_total > 0 && dc.revenue_total > 0
          ? Math.round(((dc.revenue_total - prev.revenue_total) / prev.revenue_total) * 100) : null;
        const tipsChange = prev && prev.tips_total > 0 && dc.tips_total > 0
          ? Math.round(((dc.tips_total - prev.tips_total) / prev.tips_total) * 100) : null;
        const isOpen = openId === dc.id;
        // The part of the total no category carries (a second till read as
        // a total only) — the chips summed to 17.530 under a 22.030 headline.
        const revLinesSum = Object.values(rev).reduce((a, v) => a + (Number(v) || 0), 0);
        const unsplit = Object.keys(rev).length && Number(dc.revenue_total) > 0
          ? Math.round((Number(dc.revenue_total) - revLinesSum) * 100) / 100 : 0;
        return (
          <div key={dc.id} data-close-id={dc.id} className="bg-white dark:bg-gray-800 rounded-xl p-4 sm:p-5 border border-gray-100 dark:border-gray-700 shadow-sm scroll-mt-20">
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
                  {/* A demo seeder's sample day — the owner (and an invited
                      revisor) can tell it from a real one at a glance; its
                      kasserapport says EKSEMPEL too. */}
                  {isDemoClose(dc) && (
                    <span data-testid="dc-demo-chip" title={t("dcDemoChipTitle", "Sample data from the demo — not for bookkeeping")}
                      className="text-[11px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 rounded-lg font-semibold">
                      {t("dcDemoChip", "Sample")}
                    </span>
                  )}
                </div>
                {dc.closed_by && <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">{t("dcClosedBy", "Closed by {name}", { name: dc.closed_by })}</p>}
                {dc.unlock_reason && (
                  <p className="text-[12px] text-amber-700 dark:text-amber-400 mt-0.5">{t("dcUnlockedReason", "Unlocked: {reason}", { reason: dc.unlock_reason })}</p>
                )}
                {/* Did this day reach the revisor? Persisted on the close, so it
                    is still true after a reload — "Sendt til revisor 08.10 kl.
                    07:12" or "Ikke sendt — Send igen". */}
                {(dc.status || "confirmed") === "confirmed" && (
                  <div className="mt-1">
                    <CloseEmailStatus key={`${dc.id}-${dc.email_status || ""}-${dc.email_sent_at || ""}`}
                      t={t} close={dc} profile={businessProfile} profileLoaded={profileKnown} compact
                      canSend={directSendEntitled === true}
                      onSent={onRefresh} />
                  </div>
                )}
              </div>
              <div className="text-right shrink-0">
                {/* The row's money figure leads in neutral gray-900. Emerald is
                    reserved for the money MOMENT (a lock, a send); a revenue
                    figure is a fact, and colouring facts is what made this page
                    read as nine palettes. */}
                {/* A draft of payments only (round 21: the autosave files a till
                    of payments) has no revenue yet: said as such, never a
                    confident "0 kr." headline. */}
                {isPaymentsOnly(dc) && (dc.status || "confirmed") === "draft" ? (
                  <p data-testid="dc-history-payments-only" className="text-[13px] font-medium text-gray-700 dark:text-gray-200 tabular-nums">
                    {t("dcDraftPaymentsOnly", "Payments only: {amount}", { amount: formatOwnerMoney(paymentsOf(dc), currency, { decimals: oreDecimals(paymentsOf(dc)) }) })}
                  </p>
                ) : (
                  <Amount value={dc.revenue_total} currency={currency} decimals={cardDec} size="kpi" className="text-gray-900 dark:text-white" />
                )}
                {/* A direction word, not a raw percentage — "↑ 2219 %" against a
                    test close of 734 kr. meant nothing. Within ±5 % it's
                    stable; beyond 4× either way the days aren't comparable. */}
              </div>
            </div>
            {/* Its own line: beside the amount it squeezed the date onto two
                lines on a phone. */}
            {revChange !== null && Math.abs(revChange) >= 5 && revChange <= 300 && revChange >= -75 && (
              // A lower day is not a shortfall — red is for money out and a
              // real shortage. The icon carries the direction.
              <p className={`text-[11px] font-semibold mt-1 flex items-center gap-1 sm:justify-end ${revChange > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-gray-600 dark:text-gray-400"}`}>
                <Icon name={revChange > 0 ? "TrendingUp" : "TrendingDown"} size={11} />
                {revChange > 0 ? t("dcTrendHigherThanPrev", "Higher than the close before") : t("dcTrendLowerThanPrev", "Lower than the close before")}
              </p>
            )}

            {/* Revenue + payment chips. The payment row used to be blue for no
                reason other than "it is a different kind of chip" — a whole
                colour family spent on a distinction the label already makes. */}
            <div className="flex flex-wrap gap-2 mt-3">
              {Object.entries(rev).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-gray-100 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200 rounded-lg text-[11px] font-medium tabular-nums">
                  {chipLabel(CAT_LABEL, k, t)}: <Amount value={v} currency={currency} decimals={cardDec} />
                </span>
              ))}
              {Math.abs(unsplit) >= 0.005 && (
                <span className="px-2 py-1 bg-gray-100 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200 rounded-lg text-[11px] font-medium tabular-nums">
                  {unsplit > 0 ? t("dcUnsplitRevenue", "Not split by category") : t("dcCorrectedDown", "Corrected down by hand")}: <Amount value={unsplit} currency={currency} decimals={cardDec} />
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-2 mt-2">
              {Object.entries(pay).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-gray-50 dark:bg-gray-800/50 text-gray-600 dark:text-gray-400 rounded-lg text-[11px] font-medium tabular-nums border border-gray-200 dark:border-gray-700">
                  {chipLabel(PAY_LABEL, k, t)}: <Amount value={v} currency={currency} decimals={cardDec} />
                </span>
              ))}
            </div>

            {/* The close as it was saved, read-only — the kasserapport's own
                lines, at ledger precision. */}
            {isOpen && (
              <dl className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-1 text-[13px] tabular-nums text-gray-700 dark:text-gray-300">
                {[
                  [t("revenueMedMoms", "Revenue (incl. MOMS)"), dc.revenue_total],
                  [t("totalMoms", "Total MOMS"), dc.moms_total],
                  [t("revenueUdenMoms", "Revenue (excl. MOMS)"), dc.revenue_ex_moms],
                  [t("paymentTotal", "Payment total"), dc.payment_total],
                  [t("dcCashExpectedLabel", "Cash expected"), dc.cash_expected],
                  [t("dcCashTakingsCounted", "Counted (float taken off)"), dc.cash_counted],
                  [t("dcCashDiffLabel", "Cash difference"), dc.cash_difference, true],
                  [dc.tips_staff_count
                    ? `${t("tipsLabel", "Tips")} (${t("dcStaffCountInline", "{count} staff", { count: dc.tips_staff_count })})`
                    : t("tipsLabel", "Tips"), dc.tips_total > 0 ? dc.tips_total : null],
                ].filter(([, v]) => v != null).map(([label, v, sign]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt>{label}</dt>
                    <dd className="font-medium text-gray-900 dark:text-gray-100"><Amount value={v} currency={currency} decimals={cardDec} sign={!!sign} /></dd>
                  </div>
                ))}
                {dc.notes && (
                  <div className="pt-1">
                    <dt className="text-[12px] text-gray-500 dark:text-gray-400">{t("notes", "Notes")}</dt>
                    <dd className="whitespace-pre-line">{dc.notes}</dd>
                  </div>
                )}
              </dl>
            )}

            {/* Bottom row */}
            <div className="flex items-center justify-between gap-3 flex-wrap mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="flex gap-4 flex-wrap text-[12px] text-gray-500 dark:text-gray-400 tabular-nums">
                {/* The open ledger above already lists both — not twice. */}
                {!isOpen && dc.cash_difference !== null && (
                  <span className={dc.cash_difference < -100 ? "text-red-600 dark:text-red-400 font-semibold" : ""}>
                    {t("dcCashDiffLabel", "Cash difference")}: <Amount value={dc.cash_difference} currency={currency} decimals={cardDec} sign />
                  </span>
                )}
                {!isOpen && dc.tips_total > 0 && (
                  <span>{t("tipsLabel", "Tips")}: <Amount value={dc.tips_total} currency={currency} decimals={cardDec} />{dc.tips_staff_count ? ` (${t("dcStaffCountInline", "{count} staff", { count: dc.tips_staff_count })})` : ""}
                    {/* A direction word in gray, like the revenue line — a raw
                        red "↓13%" read as money lost. */}
                    {tipsChange !== null && Math.abs(tipsChange) >= 5 && tipsChange <= 300 && tipsChange >= -75 && (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-gray-600 dark:text-gray-400">
                        <Icon name={tipsChange > 0 ? "TrendingUp" : "TrendingDown"} size={11} />
                        {tipsChange > 0 ? t("dcTipsHigherThanPrev", "more than the close before") : t("dcTipsLowerThanPrev", "less than the close before")}
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
                <Button size="sm" variant="secondary" onClick={() => setOpenId(openId === dc.id ? null : dc.id)}
                  aria-expanded={openId === dc.id}
                  iconLeft={<Icon name={openId === dc.id ? "ChevronUp" : "ChevronDown"} size={13} />}
                  className="border border-gray-200 dark:border-gray-700 max-lg:h-10">
                  {openId === dc.id ? t("dcHideDetails", "Hide") : t("dcShowDetails", "Details")}
                </Button>
                {(dc.status || "confirmed") === "confirmed" && (
                  <button onClick={() => { setUnlockId(dc.id); setUnlockReason(""); }}
                    className="max-lg:min-h-10 text-[11px] px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-400 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 font-medium inline-flex items-center gap-1.5 border border-amber-200 dark:border-amber-800">
                    <Icon name="LockOpen" size={13} /> {t("dcUnlock", "Unlock")}
                  </button>
                )}
                {(dc.status || "confirmed") === "draft" && onEdit && (
                  <Button size="sm" variant="secondary" onClick={() => onEdit(dc)} iconLeft={<Icon name="Pencil" size={13} />} className="border border-gray-200 dark:border-gray-700 max-lg:h-10">
                    {t("edit", "Edit")}
                  </Button>
                )}
                {/* "Del" (share sheet with a text summary) — never "Send": on
                    this card "Send" only ever means mail to the revisor. */}
                <Button size="sm" variant="secondary" onClick={() => shareDc(dc)} busy={sharing === dc.id}
                  iconLeft={sharing === dc.id ? null : <Icon name="Share2" size={13} />} className="border border-gray-200 dark:border-gray-700 max-lg:h-10">
                  {t("dcShareClose", "Share")}
                </Button>
                <Button size="sm" variant="secondary"
                  onClick={() => downloadPdf(dc.id, dc.date, (dc.status || "confirmed") !== "confirmed")}
                  busy={downloading === dc.id}
                  iconLeft={downloading === dc.id ? null : <Icon name="FileText" size={13} />} className="border border-gray-200 dark:border-gray-700 max-lg:h-10">
                  PDF
                </Button>
                {/* Delete — DRAFTS ONLY. A locked close is the day's legal
                    kasserapport under Bogføringsloven §10; it is not offered
                    here and the server refuses it regardless. Red because this
                    one really does remove something. */}
                {(dc.status || "confirmed") === "draft" && (
                  <button onClick={() => deleteDraft(dc)} disabled={deleting === dc.id}
                    title={t("dcDeleteDraftTitle", "Delete this kladde?")}
                    className="max-lg:min-h-10 text-[11px] px-3 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40 font-medium inline-flex items-center gap-1.5 border border-red-200 dark:border-red-800 disabled:opacity-50">
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
      {data.length > shownCount && (
        <Button variant="secondary" size="md" className="w-full max-lg:h-11" onClick={() => setShownCount((n) => n + 20)}>
          {t("dcShowMoreCloses", "Show more ({n} left)", { n: data.length - shownCount })}
        </Button>
      )}

      {/* Unlock modal */}
      {unlockId && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={() => { setUnlockId(null); setUnlockError(""); }}>
          <FocusedDialog labelledBy="dc-unlock-title" initialRef={unlockReasonRef}
            onEscape={() => { if (!unlocking) { setUnlockId(null); setUnlockError(""); } }}
            className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md shadow-sm focus:outline-none" onClick={e => e.stopPropagation()}>
            <h3 id="dc-unlock-title" className="text-[16px] font-semibold text-gray-900 dark:text-white mb-1 inline-flex items-center gap-2"><Icon name="LockOpen" size={18} /> {t("dcUnlockModalTitle", "Unlock the kasserapport")}</h3>
            {/* Which day — the dialog didn't say. */}
            {(() => {
              const row = (data || []).find((r) => r.id === unlockId);
              return row ? (
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
                  {formatDateClearFull(String(row.date).slice(0, 10))} · <Amount value={row.revenue_total} currency={currency} decimals={oreDecimals(row.revenue_total)} />
                </p>
              ) : null;
            })()}
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              {t("dcUnlockModalBody", "This will allow editing. Enter a reason for the audit trail.")}
            </p>
            {/* The revisor already holds the locked version: say so, and that
                what follows is a marked correction carrying this reason. */}
            {(() => {
              const row = (data || []).find((r) => r.id === unlockId);
              const acct = revisorEmail.toLowerCase();
              const got = acct && (row?.email_sent_to || []).map((x) => String(x).toLowerCase()).includes(acct);
              if (!row || !got) return null;
              const w = sentWhen(row.email_sent_at);
              const when = w ? t("dcMailWhen", "{date} at {time}", w) : "";
              // "Automatically" only when the relock mail will really go: a
              // plan that sends, the revisor auto-send on, AND the owner's own
              // "mail on lock" switch on — the server skips the relock mail
              // when that switch is off (skipped_preference_off).
              const auto = businessProfile?.accountant_auto_send_effective
                && directSendEntitled === true
                && user?.auto_email_on_close !== false
                // …and only from a confirmed owner (skip "email_unverified").
                && user?.email_verified !== false;
              return (
                <p data-testid="dc-unlock-revisor-note" className="text-[13px] text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 mb-4">
                  {auto
                    ? t("dcUnlockRevisorHasAuto", "Your revisor ({email}) already has the locked version ({when}). If you change something and lock it again, they automatically get a corrected kasserapport — marked \"Rettet\" and with the reason you write here. Locked again unchanged, no new mail is sent.", { email: acct, when })
                    : t("dcUnlockRevisorHas", "Your revisor ({email}) already has the locked version ({when}). When you send it again after the correction, it is marked \"Rettet kasserapport\" and carries the reason you write here.", { email: acct, when })}
                </p>
              );
            })()}
            <textarea ref={unlockReasonRef} aria-label={t("dcUnlockModalBody", "This will allow editing. Enter a reason for the audit trail.")}
              placeholder={t("dcUnlockReasonPlaceholder", "e.g. Accountant found an error in cash count…")}
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
                className="flex-1 px-4 py-2.5 bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 rounded-xl font-semibold text-sm hover:bg-gray-800 dark:hover:bg-white transition disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                {unlocking ? t("dcUnlocking", "Unlocking…") : <><Icon name="LockOpen" size={15} /> {t("dcUnlock", "Unlock")}</>}
              </button>
            </div>
          </FocusedDialog>
        </div>
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
            <Chip key={m.id} size="sm" selected={mode === m.id} onClick={() => setMode(m.id)} className="max-lg:min-h-10">{m.label}</Chip>
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
          {t("dcHeatWeekdays", "M,,W,,F,,S").split(",").map((d, i) => (
            <div key={i} className="w-[18px] h-[18px] sm:w-3 sm:h-3 flex items-center justify-center text-[11px] leading-none text-gray-400 dark:text-gray-500 select-none">{d}</div>
          ))}
        </div>
        {/* Week columns */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((day, di) => {
              if (!day) return <div key={di} className="w-[18px] h-[18px] sm:w-3 sm:h-3" />;
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
                  // 18px on a phone: a 12px square was not a tap target.
                  className={`w-[18px] h-[18px] sm:w-3 sm:h-3 min-h-0! min-w-0! p-0 rounded-[2px] ${getColor(dc)} cursor-pointer transition-all hover:ring-2 hover:ring-gray-400 dark:hover:ring-gray-300 hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:scale-125`}
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
          // "Hold over" means nothing to a finger.
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            {typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches
              ? t("tapDayForDetails", "Tap a day for details")
              : t("hoverDayForDetails")}
          </p>
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
