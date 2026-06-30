// Tier 4 — DashboardPage (v2) — persona-aware 3-zone shell.
//
// Phase B wiring: this file is the thin orchestrator. It fetches data,
// derives the `ctx` object, and hands it (with a component `registry`)
// to the declarative <DashboardZones> primitive shipped in Phase A.
//
// All the inline card components that used to live here have been
// extracted to `components/dashboard/` so this file stays at orchestrator
// scope. See `docs/tier-4-dashboard-restructure.md` for the v2 spec and
// `docs/design-system-doctrine.md` for the color / component discipline
// every extracted card already follows.
//
// What still lives in DashboardPage:
//   1. Data fetching (the same `/dashboard/batch` call as before).
//   2. The `ctx` memo — assembled from existing state hooks so the
//      declarative config can drive rendering without each card
//      doing its own fetch.
//   3. The component `REGISTRY` — string -> React component lookup the
//      orchestrator uses to render zones.
//   4. PageHeader (kept the surgical 2-CTA + overflow pattern from the
//      previous pass).
//   5. Loading skeleton matching the zone shape.
//   6. First-run state — replaces the full dashboard.
import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import api from "../services/api";
import { PageHeader, Button, UpgradeNudge } from "../components/ui";
import PageShell from "../components/ui/PageShell";
import { trackEvent } from "../hooks/useEventLog";
import {
  SkeletonCard,
  SkeletonChart,
  useToast,
  useKeyboardShortcuts,
  ShortcutsHelp,
  QuickSaleModal,
  PullToRefresh,
} from "../components/BonBoxPolishKit";
import ReceiptCapture from "../components/ReceiptCapture";
import SmartSaleInput from "../components/SmartSaleInput";
import { displayCurrency, getTaxConfig } from "../utils/currency";
import { localIso } from "../utils/dateFormat";

// ── Phase A artifacts + extracted zone cards ──
import DashboardZones from "../components/dashboard/DashboardZones";
import KpiStrip from "../components/dashboard/KpiStrip";
import AllClearCard from "../components/dashboard/AllClearCard";
import OutstandingFakturaCard from "../components/dashboard/OutstandingFakturaCard";
import ComplianceCountdownCard from "../components/dashboard/ComplianceCountdownCard";
import NeedsYouQueue from "../components/NeedsYouQueue";
import SelfHealBoundary from "../components/SelfHealBoundary";
import GrowthLeverCard from "../components/dashboard/GrowthLeverCard";
import FirstRunCollapsedDashboard from "../components/dashboard/FirstRunCollapsedDashboard";
import BusinessHealthCard from "../components/dashboard/BusinessHealthCard";
import RevenueTrendChart from "../components/dashboard/RevenueTrendChart";
import ProfitAnswerCard from "../components/dashboard/ProfitAnswerCard";
import ProfitLossCard from "../components/dashboard/ProfitLossCard";
import GoalTracker from "../components/dashboard/GoalTracker";
import PaymentBreakdownCard from "../components/dashboard/PaymentBreakdownCard";
import TopSellersCard from "../components/dashboard/TopSellersCard";
import InventoryPanel from "../components/dashboard/InventoryPanel";
import AlertsPanel from "../components/dashboard/AlertsPanel";
import TodayOnShiftCard from "../components/dashboard/TodayOnShiftCard";
import {
  DASHBOARD_CARD_SET,
  getArchetype,
  deriveActivations,
} from "../config/dashboardCardSets";

// ── Existing app-level components referenced by the card-set config ──
import DailyBriefCard from "../components/DailyBriefCard";
import AccountantHoursWidget from "../components/AccountantHoursWidget";
import SmartDriftBanner from "../components/SmartDriftBanner";
import DemoActiveBanner from "../components/DemoActiveBanner";
import TrialBanner from "../components/TrialBanner";
import BankConsentExpiryBanner from "../components/BankConsentExpiryBanner";
import PushOptInPrompt from "../components/PushOptInPrompt";
import MonthEndBundleBanner from "../components/MonthEndBundleBanner";
import CloserPromptCard from "../components/CloserPromptCard";
import SmartStaffingCard from "../components/SmartStaffingCard";
import ExpiryAlertsCard from "../components/ExpiryAlertsCard";

// ExpiryWarningsCard is the spec name; the existing component is
// ExpiryAlertsCard. Aliased so the registry id matches the config.
const ExpiryWarningsCard = ExpiryAlertsCard;

/* ═══════════════════════════════════════════════════════════
   COMPONENT REGISTRY — string id → React component
   ───────────────────────────────────────────────────────────
   The card-set config references components by string name (keeps the
   config import-free of React). DashboardZones / PageNotices look them
   up here. Order grouped by zone so it's easy to see what each zone has.
   ═══════════════════════════════════════════════════════════ */

const REGISTRY = {
  // ── Notices ──
  SmartDriftBanner,
  DemoActiveBanner,
  TrialBanner,
  PushOptInPrompt,
  // Task #104: surfaces when a connected bank's 90-day SCA consent
  // window enters its last 14 days.  Self-hides when no bank is at
  // risk; renders nothing for Free users (no connection rows).
  BankConsentExpiryBanner,

  // ── Zone 1 ──
  OutstandingFakturaCard,
  MonthEndBundleBanner,
  DailyBriefCard,
  KpiStrip,
  AccountantHoursWidget,
  ComplianceCountdownCard,
  TodayOnShiftCard,

  // ── Zone 2 ──
  ProfitAnswerCard,
  RevenueTrendChart,
  ProfitLossCard,
  GoalTracker,
  BusinessHealthCard,
  PaymentBreakdownCard,
  TopSellersCard,
  GrowthLeverCard,
  UpgradeNudge,

  // ── Zone 3 ──
  InventoryPanel,
  ExpiryWarningsCard,
  SmartStaffingCard,
  AlertsPanel,
  CloserPromptCard,
  AllClearCard,

  // ── Full-page replacement states ──
  FirstRunCollapsedDashboard,
};

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */

function computeDaysToMonthEnd(now = new Date()) {
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return Math.max(0, Math.ceil((endOfMonth - now) / 86400000));
}

/* ═══════════════════════════════════════════════════════════
   MAIN DASHBOARD
   ═══════════════════════════════════════════════════════════ */

export default function DashboardPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const currency = displayCurrency(user?.currency);
  const { showToast, ToastContainer } = useToast();
  const entitlements = useEntitlements();

  // ── State ──
  const [summary, setSummary] = useState(null);
  const [monthlyData, setMonthlyData] = useState(null);
  const [lastSale, setLastSale] = useState(null);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [topSellers, setTopSellers] = useState([]);
  const [actionItems, setActionItems] = useState([]);
  const [weekComparison, setWeekComparison] = useState(null);
  const [paymentBreakdown, setPaymentBreakdown] = useState([]);
  const [outstandingInvoices, setOutstandingInvoices] = useState([]);
  const [growthSignals, setGrowthSignals] = useState([]);
  const [profile, setProfile] = useState(null);
  const [momsCountdownDays, setMomsCountdownDays] = useState(null);
  const [momsDate, setMomsDate] = useState(null);
  // Bumped after every dashboard data refresh (fetchAll). Cards that own their
  // own fetch (e.g. ComplianceCountdownCard → /cashflow/forecast) read this off
  // ctx and re-fetch when it changes, so they don't go stale after a Quick Sale.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [saleModal, setSaleModal] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [smartSaleOpen, setSmartSaleOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // Click-outside for the overflow menu.
  const overflowRef = useRef(null);
  useEffect(() => {
    if (!overflowOpen) return;
    const onClick = (e) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [overflowOpen]);

  // ── Keyboard shortcuts ──
  useKeyboardShortcuts({
    s: () => setSaleModal(true),
    e: () => navigate("/expenses"),
    d: () => navigate("/dashboard"),
    i: () => navigate("/inventory"),
    r: () => navigate("/reports"),
    "?": () => setHelpOpen(true),
    escape: () => {
      setSaleModal(false);
      setHelpOpen(false);
      setOverflowOpen(false);
    },
  });

  // ── Data fetching (single batch call — same as the previous version) ──
  const fetchAll = async () => {
    try {
      setLoading(true);
      const now = new Date();
      const { data } = await api.get("/dashboard/batch", {
        params: { month: now.getMonth() + 1, year: now.getFullYear() },
      });
      if (data.summary) setSummary(data.summary);
      if (data.monthly) setMonthlyData(data.monthly);
      if (data.latest_sales) setLastSale(data.latest_sales);
      if (data.inventory) setInventoryItems(data.inventory);
      if (data.top_sellers) setTopSellers(data.top_sellers);
      if (data.action_items) setActionItems(data.action_items);
      if (data.week_comparison) setWeekComparison(data.week_comparison);
      if (data.payment_breakdown) setPaymentBreakdown(data.payment_breakdown);
      if (data.outstanding_invoices) setOutstandingInvoices(data.outstanding_invoices);
      if (data.growth_signals) setGrowthSignals(data.growth_signals);
      if (data.profile) setProfile(data.profile);
      if (data.moms_countdown_days != null) setMomsCountdownDays(data.moms_countdown_days);
      if (data.moms_date) setMomsDate(data.moms_date);
      // Signal self-fetching cards (foresight hero) to re-pull after this refresh.
      setRefreshNonce((n) => n + 1);
    } catch {
      // batch failed — per-endpoint fallbacks (same defensive pattern
      // as the previous DashboardPage version)
      api.get("/dashboard/summary").then((r) => setSummary(r.data)).catch(() => {});
      api.get("/dashboard/top-sellers").then((r) => setTopSellers(r.data)).catch(() => {});
      api.get("/dashboard/action-items").then((r) => setActionItems(r.data)).catch(() => {});
    }

    // MOMS countdown lives on /tax/overview (not in /dashboard/batch).
    // Always runs — independent of batch success.
    // Response shape (verified 2026-05-25 against api.bonbox.dk):
    //   upcoming_deadlines: [{ deadline: "2026-09-01", days_until: 99,
    //                          period_label, estimated_amount, ... }]
    // No `type` field — the endpoint only returns MOMS/VAT deadlines so
    // the first entry IS the next MOMS deadline.
    try {
      const taxRes = await api.get("/tax/overview");
      const deadlines = taxRes?.data?.upcoming_deadlines || [];
      const next = deadlines[0];
      if (next?.deadline && next?.days_until != null) {
        setMomsCountdownDays(Number(next.days_until));
        setMomsDate(next.deadline);
      }
    } catch {
      // /tax/overview unavailable — KpiStrip will hide the tile cleanly
    }

    try {
      // no-op preserved so the surrounding finally still fires
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const onDataChanged = () => fetchAll();
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

  // ── Quick-sale handler (preserved verbatim — MOMS conversion is
  //    load-bearing: misinterpreting incl/excl-MOMS on a stored Sale
  //    cascades into the MOMS-angivelse PDF) ──
  const handleQuickSale = async (amount, inclMoms = true, isTaxExempt = false) => {
    const profileInclMoms = user?.prices_include_moms ?? true;
    const vatRate = getTaxConfig(user?.currency).rate;
    let storedAmount = amount;
    if (!isTaxExempt && vatRate > 0 && inclMoms !== profileInclMoms) {
      if (inclMoms && !profileInclMoms) {
        storedAmount = amount / (1 + vatRate);
      } else {
        storedAmount = amount * (1 + vatRate);
      }
    }
    storedAmount = Math.round(storedAmount * 100) / 100;
    try {
      // Don't send `date` — let the backend resolve via
      // business_today_local(user) so a Quick Sale at 02:00 CEST (after
      // midnight wall-clock but BEFORE the user's 06:00 business-day
      // cutoff) lands on the correct business day, not on tomorrow.
      // Previously sent `date: localIso()` which used the wall-clock
      // local date and silently mis-routed post-midnight sales to the
      // next business day — they didn't show up in today's KPIs and the
      // user reported "Quick sale doesn't add".
      await api.post("/sales", {
        amount: storedAmount,
        // Quick Sale is a one-tap day-revenue logger, so the honest method
        // is "mixed" (matches the Sale model default + the QuickAdd FAB path).
        // It must NOT hardcode "cash": a "cash" sale auto-posts a cash-in row
        // to the kassekladde (sync_cash_in_for_sale, sales.py), so defaulting
        // to cash injected phantom cash into the cashbook for card/MobilePay
        // revenue — overstating the drawer and poisoning cash reconciliation.
        payment_method: "mixed",
        notes: t("quickSaleDesc"),
        ...(isTaxExempt ? { is_tax_exempt: true } : {}),
      });
      const trackLabel = isTaxExempt
        ? `quick_sale ${amount} ${currency} moms_fri`
        : `quick_sale ${amount} ${currency} ${inclMoms ? "incl" : "excl"}_moms`;
      trackEvent("sale_logged", "dashboard", trackLabel);
      showToast(`${t("saleLogged")} ${amount.toLocaleString()} ${currency}`, "success");
      fetchAll();
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch {
      showToast(t("failedToLogSale"), "error");
    }
  };

  const downloadPdf = async () => {
    try {
      const now = new Date();
      const res = await api.get("/reports/monthly/pdf", {
        params: { month: now.getMonth() + 1, year: now.getFullYear() },
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      // Filename mirrors the backend Ledelsesrapport doc (da-DK, internal
      // management overview — not a momsangivelse).
      a.download = `BonBox_Ledelsesrapport_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, "0")}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      showToast(t("downloadPdf") + " failed", "error");
    }
  };

  // ── Derived values ──
  const archetype = useMemo(() => getArchetype(user || {}), [user]);

  // dailyRevData feeds RevenueTrendChart via ctx. Prefer the honest
  // rolling, zero-filled `revenue_trend` series; fall back to the old
  // month-scoped `daily_revenue` during deploy skew (older backend).
  const dailyRevData = useMemo(
    () => monthlyData?.revenue_trend || monthlyData?.daily_revenue || [],
    [monthlyData],
  );

  const activations = useMemo(() => {
    return deriveActivations(
      {
        inventory: { itemCount: inventoryItems?.length || 0 },
        staff: {
          // Real active-StaffMember signal from the dashboard summary
          // (dashboard.py now emits staff_configured / staff_headcount). The
          // old profile.* reads were PHANTOM — those keys never existed on the
          // backend, so this always evaluated to false/0. Fixed to the real
          // count so the staff activation flag is honest.
          configured: !!summary?.staff_configured,
          headcount: Number(summary?.staff_headcount || 0),
        },
        // Real Event-row counts from the dashboard summary (dashboard.py now
        // emits events_total_count / events_recurring_count). Replaces the
        // hardcoded {recurringCount:0,totalCount:0} so the events activation
        // signal reflects real usage.
        events: {
          recurringCount: Number(summary?.events_recurring_count || 0),
          totalCount: Number(summary?.events_total_count || 0),
        },
        payments: {
          distinctMethods: Array.from(
            new Set((paymentBreakdown || []).map((m) => m.method)),
          ),
        },
        invoices: { overdueCount: outstandingInvoices?.length || 0 },
        compliance: { daysToNext: momsCountdownDays ?? 999 },
        now: { daysToMonthEnd: computeDaysToMonthEnd() },
        // First-run gate: require summary to be LOADED before treating
        // a zero sale count as first-run. Otherwise existing users see
        // "Welcome to BonBox" during the 600ms cold-start fetch.
        // Backend returns `total_sales` (see dashboard.py:300) — NOT
        // `lifetime_sale_count` (that field doesn't exist).
        summary: { totalSales: summary ? (summary.total_sales ?? summary.sale_count ?? 0) : -1 },
      },
      archetype,
    );
  }, [
    archetype,
    inventoryItems,
    profile,
    paymentBreakdown,
    outstandingInvoices,
    momsCountdownDays,
    summary,
  ]);

  // ── ctx — single object passed to every Phase A card ──
  const ctx = useMemo(() => {
    const overdueTotal = (outstandingInvoices || []).reduce(
      (s, inv) => s + (Number(inv.amount) || 0),
      0,
    );
    return {
      // Identity / plan
      user,
      plan: entitlements?.plan || "free",
      archetype: archetype?.id || "transactionalDaily",
      activations,
      refreshNonce,
      has: (featureKey) => Boolean(entitlements?.hasFeature?.(featureKey)),
      // Tier-flicker fix: while billing is still loading, `plan` defaults
      // to "free" and every has(...) returns false. Card renderIf
      // predicates that gate on `plan === "free"` (e.g. the Zone 2
      // UpgradeNudge) would render the upgrade nudge during the loading
      // window, then disappear once the trial/Starter/Pro payload lands.
      // entLoading lets predicates short-circuit so Free-only nudges
      // wait for the real plan to land before rendering.
      entLoading: Boolean(entitlements?.loading),
      entReady: Boolean(entitlements?.isReady),

      // Currency + nav helpers — most cards navigate themselves, but
      // some helpers below format with currency directly.
      currency,
      navigate,
      t,

      // Data feeds
      summary: {
        ...(summary || {}),
        // KpiStrip + BusinessHealthCard look at these specific keys.
        currency,
        totalSales: summary?.total_sales ?? summary?.sale_count ?? 0,
        todaySales: summary?.today_sale_count || 0,
        todayRevenue: summary?.today_revenue || 0,
        weekRevenue: summary?.week_revenue || 0,
        monthRevenue: summary?.month_revenue || 0,
        monthExpenses: summary?.month_expenses || 0,
        profit_30d: summary?.profit_30d ?? summary?.month_profit,
        profit_margin: summary?.profit_margin || 0,
        week_expense_delta_pct: summary?.week_expense_delta_pct || 0,
      },
      weekComparison: weekComparison
        ? {
            todayDeltaPct: weekComparison.today_change_pct ?? null,
            weekDeltaPct: weekComparison.change_pct ?? null,
            direction:
              (weekComparison.change_pct || 0) > 0
                ? "up"
                : (weekComparison.change_pct || 0) < 0
                  ? "down"
                  : "flat",
          }
        : { todayDeltaPct: null, weekDeltaPct: null, direction: "flat" },
      compliance: {
        nextDeadline: {
          type: "moms",
          date: momsDate,
          daysAway: momsCountdownDays,
          label: t("dashComplianceMomsLabel", "MOMS filing"),
        },
        daysToNext: momsCountdownDays ?? 999,
        nextDeadlineLabel: t("dashComplianceMomsLabel", "MOMS filing"),
      },
      topSellers: topSellers || [],
      paymentBreakdown: paymentBreakdown || [],
      inventoryItems: inventoryItems || [],
      inventoryCriticalCount: (inventoryItems || []).filter(
        (i) =>
          parseFloat(i.min_threshold) > 0 &&
          parseFloat(i.quantity) <= parseFloat(i.min_threshold),
      ).length,
      // ExpiryAlertsCard self-fetches; this gates the registry render.
      // TODO(Phase G): expose expiring count on /dashboard/batch so the
      // gate predicate is data-driven instead of always rendering.
      expiringSoonCount: 0,
      goalsSet: !!(
        profile?.daily_revenue_goal ||
        profile?.monthly_revenue_goal ||
        user?.daily_goal ||
        user?.monthly_goal
      ),
      invoices: {
        overdueCount: outstandingInvoices?.length || 0,
        overdue: outstandingInvoices || [],
        overdueTotal,
      },
      growthSignals: growthSignals || [],
      actionItems: actionItems || [],
      // CloserPromptCard self-detects whether daily close ran; the
      // renderIf still needs a default. The card hides itself when
      // there's nothing to prompt.
      dailyCloseRanToday: false,

      // Notices state. Current banner components self-detect their own
      // visibility; these defaults exist so the renderIf predicates
      // resolve without crashing.
      driftActive: true,
      isDemoData: !!user?.is_demo_data_active,
      trialDaysLeft: entitlements?.trialDaysRemaining ?? null,
      pushOptedIn: false,

      // Profile (for GoalTracker)
      profile,

      // Trend feed
      dailyRevData,
    };
  }, [
    user,
    entitlements,
    archetype,
    activations,
    currency,
    navigate,
    t,
    summary,
    weekComparison,
    topSellers,
    paymentBreakdown,
    inventoryItems,
    outstandingInvoices,
    growthSignals,
    actionItems,
    momsCountdownDays,
    momsDate,
    refreshNonce,
    profile,
    dailyRevData,
  ]);

  // ── Greeting (preserved from the previous surgical pass) ──
  const greetingTitle = useMemo(() => {
    const hour = new Date().getHours();
    const tr = (key, fallback) => {
      const v = t(key);
      return v && v !== key ? v : fallback;
    };
    let greet;
    if (hour < 5) greet = tr("goodEvening", "Good evening");
    else if (hour < 12) greet = tr("goodMorning", "Good morning");
    else if (hour < 18) greet = tr("goodAfternoon", "Good afternoon");
    else greet = tr("goodEvening", "Good evening");
    const rawName = user?.business_name?.trim() || "";
    const looksLikeAppName = /^bonbox$/i.test(rawName);
    const displayName =
      !rawName || looksLikeAppName ? user?.email?.split("@")[0] || "" : rawName;
    return displayName ? `${greet}, ${displayName}` : greet;
  }, [t, user]);

  // ── Loading skeleton (matches zone shape, not the old grid) ──
  if (loading && !summary) {
    return (
      <PageShell width="wide">
        <PageHeader
          eyebrow={t("home", "HOME").toUpperCase()}
          title={greetingTitle}
        />
        <div className="space-y-6">
          {/* Zone 1 skeleton: DailyBrief + 3-tile KPI strip */}
          <SkeletonCard />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
          {/* Zone 2 skeleton: RevenueTrend */}
          <SkeletonChart />
        </div>
      </PageShell>
    );
  }

  // ── Header actions: 2 primary CTAs + overflow menu.
  //    Preserved from the surgical pass. Repeat-Yesterday + Download PDF
  //    + Smart entry move into the overflow so the header stays calm.
  const headerActions = (
    <>
      <Button variant="primary" onClick={() => setSaleModal(true)}>
        + {t("quickSale", "Quick sale")}
      </Button>
      <ReceiptCapture onSaleCreated={fetchAll} />
      <div className="relative" ref={overflowRef}>
        <Button
          variant="ghost"
          onClick={() => setOverflowOpen((v) => !v)}
          aria-label={t("moreActions", "More actions")}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </Button>
        {overflowOpen && (
          <div
            role="menu"
            className={
              "absolute right-0 mt-2 w-56 rounded-xl border border-gray-200 " +
              "dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm " +
              "py-1 z-30"
            }
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOverflowOpen(false);
                setSmartSaleOpen(true);
              }}
              className="w-full text-left text-sm px-3 py-2 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              {t("smartEntry", "Smart entry")}
            </button>
            {lastSale && parseFloat(lastSale.amount) > 0 && lastSale.date && (() => {
              const y = new Date();
              y.setDate(y.getDate() - 1);
              const yesterdayISO = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
              const saleDate = String(lastSale.date).slice(0, 10);
              if (saleDate !== yesterdayISO) return null;
              return (
                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    setOverflowOpen(false);
                    try {
                      await api.post("/sales/repeat-yesterday");
                      trackEvent("sale_logged", "dashboard", "repeat_yesterday");
                      fetchAll();
                      window.dispatchEvent(new Event("bonbox-data-changed"));
                    } catch { /* ignore */ }
                  }}
                  className="w-full text-left text-sm px-3 py-2 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  {t("repeatYesterday", "Repeat yesterday")}
                </button>
              );
            })()}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOverflowOpen(false);
                downloadPdf();
              }}
              className="w-full text-left text-sm px-3 py-2 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              {t("downloadPdf", "Download PDF")}
            </button>
          </div>
        )}
      </div>
    </>
  );

  // ── First-run state — replaces the whole zone tree ──
  // Belt-and-braces: never render first-run if we don't yet have a
  // summary object, regardless of what isFirstRun computed.
  if (summary && ctx.activations.isFirstRun) {
    return (
      <PageShell width="wide">
        <ToastContainer />
        <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        <QuickSaleModal
          open={saleModal}
          onClose={() => setSaleModal(false)}
          onSubmit={handleQuickSale}
          currency={currency}
          pricesIncludeMoms={user?.prices_include_moms ?? true}
        />
        <SmartSaleInput
          open={smartSaleOpen}
          onClose={() => setSmartSaleOpen(false)}
          onSaved={fetchAll}
        />
        <PageHeader
          eyebrow={t("home", "HOME").toUpperCase()}
          title={greetingTitle}
          actions={headerActions}
        />
        <FirstRunCollapsedDashboard />
      </PageShell>
    );
  }

  // ── Steady-state: the full persona-aware 3-zone dashboard ──
  return (
    <PullToRefresh onRefresh={async () => fetchAll()}>
      <PageShell width="wide">
        <ToastContainer />
        <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        <QuickSaleModal
          open={saleModal}
          onClose={() => setSaleModal(false)}
          onSubmit={handleQuickSale}
          currency={currency}
          pricesIncludeMoms={user?.prices_include_moms ?? true}
        />
        <SmartSaleInput
          open={smartSaleOpen}
          onClose={() => setSmartSaleOpen(false)}
          onSaved={fetchAll}
        />

        <PageHeader
          eyebrow={t("home", "HOME").toUpperCase()}
          title={greetingTitle}
          subtitle={new Date().toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
          actions={headerActions}
        />

        {/* The read-only "Skal ses nu" queue — the few things that need the
            owner now, in order, each a deep-link. Self-hides when empty. */}
        <SelfHealBoundary quiet>
          <NeedsYouQueue />
        </SelfHealBoundary>

        {/* Auto-repair: a single crashed card re-mounts itself instead of
            white-screening the whole dashboard (runtime self-heal only —
            never touches money data). */}
        <SelfHealBoundary>
          <DashboardZones
            cardSet={DASHBOARD_CARD_SET}
            ctx={ctx}
            registry={REGISTRY}
          />
        </SelfHealBoundary>

        <div className="mt-8 text-center">
          <Link
            to="/reports"
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 underline"
          >
            {t("dashViewAllMetrics", "View all metrics in Reports →")}
          </Link>
        </div>
      </PageShell>
    </PullToRefresh>
  );
}
