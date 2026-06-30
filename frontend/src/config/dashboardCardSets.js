/**
 * dashboardCardSets — the single declarative source of truth for what
 * appears on the Dashboard, in what order, and under what conditions.
 *
 * Architecture (locked 2026-05-25 per `docs/tier-4-dashboard-restructure.md`):
 *
 *   1. `ARCHETYPES` — the user's business archetype is a SEED, not a runtime
 *      driver. Two archetypes (transactionalDaily, projectWeekly) cover all
 *      current business types. Future verticals add to the map; they do NOT
 *      add a third zone-tree.
 *
 *   2. `BUSINESS_TYPE_TO_ARCHETYPE` — maps `user.business_type` to its
 *      archetype. Default falls back to transactionalDaily (the most
 *      conservative — keeps inventory + multi-payment surfaces alive for
 *      a user who picked the wrong dropdown at signup).
 *
 *   3. `deriveActivations(ctx, archetype)` — the FOOTGUN FIX. Card rendering
 *      is driven by activation flags derived from ACTUAL DATA STATE, not
 *      from the user-declared `business_type`. A restaurant owner who picks
 *      "event_organizer" at signup never loses the Inventory CRITICAL card
 *      because `hasInventory` reads `ctx.inventory.itemCount > 0`, not
 *      `business_type === "restaurant"`.
 *
 *   4. `DASHBOARD_CARD_SET` — the declarative tree of zones. Each entry has:
 *        • id — stable key for React + analytics
 *        • component — string name resolved by DashboardZones to a real
 *          React component (string indirection lets us avoid importing
 *          every card here, keeping the config file pure-data)
 *        • renderIf?(ctx) — predicate that gates the card on archetype +
 *          activations + feature flags + data state. Combined into ONE
 *          predicate per card so DashboardPage never grows inline ifs.
 *        • props? — either a static object OR a function `(ctx) => ({...})`
 *          (function form lets one component render differently per tier:
 *          RevenueTrendChart with `days={7|30|90}`).
 *        • children? — for the `Row` compound, the children render side-
 *          by-side on `lg+` and stack on `<lg`.
 *        • requiresFeature? — optional shortcut for `ctx.has(featureKey)`
 *          to keep the predicate readable when there's no other condition.
 *
 *   5. `fullPageStates` — REPLACE the entire zone tree when their predicate
 *      matches. First-run (zero sales) replaces Dashboard with a 3-step
 *      onboarding card instead of stacking empty states across 3 zones.
 *
 * The `ctx` shape (assembled by DashboardPage before passing into Zones):
 *   {
 *     plan: "free" | "starter" | "pro",
 *     has: (featureKey) => boolean,    // wraps useEntitlements().hasFeature
 *     archetype: "transactionalDaily" | "projectWeekly",
 *     activations: { hasInventory, hasStaff, hasEvents, hasMultiPayment,
 *                    hasOutstandingInvoices, hasUpcomingCompliance,
 *                    isMonthEnd, isFirstRun },
 *     summary: { totalSales, todaySales, todayRevenue, weekRevenue,
 *                monthRevenue, monthExpenses, profit_30d, profit_margin, ... },
 *     weekComparison: { todayDeltaPct, weekDeltaPct, direction: "up"|"down" },
 *     compliance: { nextDeadline: { type, date, daysAway, label },
 *                   daysToNext, nextDeadlineLabel },
 *     inventory: { itemCount, criticalCount },
 *     inventoryCriticalCount: number,
 *     expiringSoonCount: number,
 *     staff: { configured, headcount },
 *     events: { recurringCount, totalCount },
 *     payments: { distinctMethods: [...] },
 *     invoices: { overdue: [{customer, amount, daysOverdue}], overdueCount, overdueTotal },
 *     actionItems: [...],
 *     dailyCloseRanToday: boolean,
 *     driftActive: boolean,
 *     isDemoData: boolean,
 *     pushOptedIn: boolean,
 *     trialDaysLeft: number | null,
 *     goalsSet: boolean,
 *     growthSignals: [{ title, body, ctaLabel, ctaHref }],
 *     now: { daysToMonthEnd },
 *     zone3DynamicCount: number,   // computed by Zones, used by AllClearCard renderIf
 *   }
 *
 * Multi-barrier 10-layer discipline note:
 *   `ctx.has(featureKey)` is ADVISORY — it gates the FRONTEND render. Every
 *   Pro-only endpoint (e.g. /api/growth-signals) still re-checks PLAN_FEATURES
 *   server-side per `billing.py`. The card config never grants entitlements;
 *   it only decides whether to show the surface.
 */

// ─────────────────────────────────────────────────────────────────────
// Archetypes — 2 templates that cover all current business types.
// ─────────────────────────────────────────────────────────────────────

export const ARCHETYPES = {
  /**
   * transactionalDaily — cafe / bar / restaurant / retail / general.
   * High-frequency same-day reconciliation. Inventory + staff + multi-
   * payment surfaces are ON by default; the activation flags can still
   * gate them off when the underlying data doesn't exist.
   */
  transactionalDaily: {
    id: "transactionalDaily",
    defaultActivations: {
      hasInventory: true,
      hasStaff: true,
      hasMultiPayment: true,
      hasEvents: false,
    },
    salesRightRail: "session4tile",
    expensesDefaultMode: "quick",
  },

  /**
   * projectWeekly — event_organizer / freelancer / clinic.
   * Weekly burst transactions. Inventory + staff hidden by default;
   * events activation is ON.
   */
  projectWeekly: {
    id: "projectWeekly",
    defaultActivations: {
      hasInventory: false,
      hasStaff: false,
      hasMultiPayment: false,
      hasEvents: true,
    },
    salesRightRail: "sessionInline",
    expensesDefaultMode: "quick",
  },
};

// ─────────────────────────────────────────────────────────────────────
// Business type → Archetype map. The DEFAULT for unknowns / nulls is
// transactionalDaily because it's the most permissive — a restaurant
// owner who left business_type blank still gets the safety surfaces.
// ─────────────────────────────────────────────────────────────────────

export const BUSINESS_TYPE_TO_ARCHETYPE = {
  restaurant: "transactionalDaily",
  cafe: "transactionalDaily",
  bar: "transactionalDaily",
  retail: "transactionalDaily",
  general: "transactionalDaily",
  other: "transactionalDaily",
  event_organizer: "projectWeekly",
  freelancer: "projectWeekly",
};

/**
 * getArchetype(user) — single entry point. Always returns an archetype
 * record (never undefined). Falls back to transactionalDaily on unknown
 * business_type to preserve the inventory + staff safety surfaces.
 */
export function getArchetype(user) {
  const key =
    BUSINESS_TYPE_TO_ARCHETYPE[user?.business_type] || "transactionalDaily";
  return ARCHETYPES[key];
}

// ─────────────────────────────────────────────────────────────────────
// deriveActivations — activation flags are LIVE-derived from data, not
// user-declared. This eliminates the "wrong dropdown → safety net
// silently disappears" footgun the PM critique caught in v1.
// ─────────────────────────────────────────────────────────────────────

export function deriveActivations(ctx, archetype) {
  // `archetype` is included so future activations can fall back to the
  // archetype default when data is missing (e.g. brand-new account with
  // no rows yet — show what the archetype expects, not nothing).
  const defaults = archetype?.defaultActivations || {};
  const inventoryCount = ctx?.inventory?.itemCount ?? 0;
  const staffConfigured = !!ctx?.staff?.configured;
  const staffHeadcount = ctx?.staff?.headcount ?? 0;
  const eventRecurring = ctx?.events?.recurringCount ?? 0;
  const eventTotal = ctx?.events?.totalCount ?? 0;
  const distinctMethods = ctx?.payments?.distinctMethods?.length ?? 0;
  const overdueCount = ctx?.invoices?.overdueCount ?? 0;
  const complianceDays = ctx?.compliance?.daysToNext ?? Infinity;
  const daysToMonthEnd = ctx?.now?.daysToMonthEnd ?? Infinity;
  const totalSales = ctx?.summary?.totalSales ?? 0;

  return {
    hasInventory: inventoryCount > 0 || (defaults.hasInventory && totalSales === 0),
    hasStaff: (staffConfigured && staffHeadcount > 0) || (defaults.hasStaff && totalSales === 0),
    hasEvents: eventRecurring > 0 || eventTotal >= 3 || (defaults.hasEvents && totalSales === 0),
    hasMultiPayment: distinctMethods >= 2 || (defaults.hasMultiPayment && totalSales === 0),
    hasOutstandingInvoices: overdueCount > 0,
    hasUpcomingCompliance: complianceDays <= 30,
    isMonthEnd: daysToMonthEnd <= 5,
    // Only mark first-run when summary is LOADED and confirms zero sales.
    // DashboardPage passes totalSales = -1 during cold-start fetch — that
    // prevents the "Welcome to BonBox" screen flicker for existing users
    // while their dashboard data is still in flight.
    isFirstRun: totalSales === 0,
    isLoadingSummary: totalSales < 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// DASHBOARD_CARD_SET — the declarative tree. DashboardZones reads this
// to render. Component names are strings; the orchestrator maps them
// to actual React components so this config stays pure data.
// ─────────────────────────────────────────────────────────────────────

export const DASHBOARD_CARD_SET = {
  // ── Banner stack (PageNotices) — capped at 2 visible by the component ──
  notices: [
    {
      id: "drift",
      component: "SmartDriftBanner",
      renderIf: (ctx) => !!ctx?.driftActive,
    },
    {
      id: "demo",
      component: "DemoActiveBanner",
      renderIf: (ctx) => !!ctx?.isDemoData,
    },
    {
      id: "trial",
      component: "TrialBanner",
      renderIf: (ctx) =>
        ctx?.trialDaysLeft != null && ctx.trialDaysLeft <= 7,
    },
    // Task #104: PSD2 bank consent renewal nag (T-14d window).  The
    // component itself fetches /bank-connections and self-hides when
    // nothing is expiring, so renderIf can just check feature-gate.
    // Starter+ only: Free users have no connection rows in the first
    // place, but be belt-and-brace on the gate.
    {
      id: "bankExpiry",
      component: "BankConsentExpiryBanner",
      renderIf: (ctx) => !!ctx?.has?.("bank_auto_reconcile"),
    },
    {
      id: "push",
      component: "PushOptInPrompt",
      renderIf: (ctx) =>
        !ctx?.pushOptedIn && (ctx?.summary?.totalSales ?? 0) >= 3,
    },
  ],

  // ── Zone 1 — Today's Pulse. 5-second scan, always visible. ──
  zone1: [
    // Sudip's #1 pain — its own surface, not buried in Daily Brief.
    {
      id: "outstandingFaktura",
      component: "OutstandingFakturaCard",
      renderIf: (ctx) => !!ctx?.activations?.hasOutstandingInvoices,
    },

    // Month-end revisor pack — last 5 days of month, Starter+.
    {
      id: "monthEnd",
      component: "MonthEndBundleBanner",
      renderIf: (ctx) =>
        !!ctx?.activations?.isMonthEnd && ctx?.has?.("send_to_revisor"),
    },

    // KPI row + AccountantHours widget — side-by-side on lg, stacks on <lg.
    {
      id: "kpi+hours",
      component: "Row",
      children: [
        {
          id: "kpi3",
          component: "KpiStrip",
          props: (ctx) => ({
            tiles: ["today", "week", "month"],
            // WeekComparison delta wired INTO the today-tile arrow.
            showDelta: true,
          }),
        },
        {
          id: "hours",
          component: "AccountantHoursWidget",
          renderIf: (ctx) => ctx?.has?.("dashboard_accountant_hours"),
        },
      ],
    },

    // Foresight hero (S1-8 / #355) — "will you cover the MOMS bill?".  The
    // component self-fetches /cashflow/forecast → foresight and renders the
    // verdict + the one action, or the honest "connect your bank" state until a
    // bank balance lands (#344).  Shown whenever a MOMS afregningsfrist is known
    // (not tier-gated — core value, like the FREE MOMS countdown it upgrades).
    {
      id: "foresightHero",
      component: "ComplianceCountdownCard",
      renderIf: (ctx) => (ctx?.compliance?.daysToNext ?? Infinity) < Infinity,
    },

    // The AI Daily Brief — moved BELOW the KPI strip + foresight hero so
    // the owner's eye lands on the trust queue + the real numbers + "are
    // you covered?" first; the narration is context, not the headline.
    // (owner-POV critique)
    {
      id: "brief",
      component: "DailyBriefCard",
    },

    // Today on shift — Task #204 P2.6.  Answers the literal #1 question
    // owners open the app to ask: "who is working RIGHT NOW?".  Sits
    // between the KPI strip and Revenue Trend so the morning glance
    // ends on "and here's today's roster, calmly".  Gated on the
    // staff activation flag — solo owners (no staff_members rows) never
    // see this surface.  The card also self-vetoes via the /staff/today
    // empty array path if a stale activation flag slipped through.
    {
      id: "todayOnShift",
      component: "TodayOnShiftCard",
      renderIf: (ctx) => !!ctx?.activations?.hasStaff,
    },
  ],

  // ── Zone 2 — Growth Levers. Actionable this week. ──
  zone2: [
    // Profit answer — the dashboard hero. The one question an owner opens
    // the app for: "am I making money this month, and how much is really
    // mine after MOMS?" Sits ABOVE the trend on purpose — answer first, the
    // "is it growing?" chart second. Supersedes the old compact ProfitLossCard.
    {
      id: "profitAnswer",
      component: "ProfitAnswerCard",
    },

    // Revenue trend — 7 / 30 / 90 days driven by tier features.
    {
      id: "trend",
      component: "RevenueTrendChart",
      props: (ctx) => ({
        days: ctx?.has?.("revenue_trend_90d")
          ? 90
          : ctx?.has?.("revenue_trend_30d")
          ? 30
          : 7,
      }),
    },

    // Goal tracker — opt-in (Pro), only once the owner has actually set a goal.
    {
      id: "goal",
      component: "GoalTracker",
      renderIf: (ctx) =>
        ctx?.has?.("dashboard_goal_tracker") && !!ctx?.goalsSet,
    },

    // BusinessHealth — REFACTORED into single composite verdict line.
    {
      id: "health",
      component: "BusinessHealthCard",
      renderIf: (ctx) =>
        ctx?.has?.("dashboard_business_health") &&
        (ctx?.summary?.totalSales ?? 0) >= 10,
    },

    // PaymentBreakdown — compact daily reconciliation for the cafe operator.
    {
      id: "paymentBreakdown",
      component: "PaymentBreakdownCard",
      props: { compact: true },
      renderIf: (ctx) =>
        ctx?.archetype === "transactionalDaily" &&
        !!ctx?.activations?.hasMultiPayment,
    },

    // Top Sellers — gated on inventory activation + 2-product threshold.
    {
      id: "sellers",
      component: "TopSellersCard",
      renderIf: (ctx) =>
        ctx?.has?.("dashboard_top_sellers") &&
        !!ctx?.activations?.hasInventory,
    },

    // Growth Lever — Pro-only informative card.
    {
      id: "growthLever",
      component: "GrowthLeverCard",
      renderIf: (ctx) =>
        ctx?.has?.("growth_intelligence") &&
        (ctx?.growthSignals?.length ?? 0) > 0,
    },

    // Free-tier UpgradeNudge — fills the slot where Pro/Starter have growth.
    //
    // Tier-flicker fix: while entitlements are still loading, `ctx.plan`
    // defaults to "free" — without the `entReady` guard a trial user
    // briefly sees this "Upgrade to Starter" card before the real plan
    // payload arrives and removes it. That ~150-300ms flash is the
    // "asks Starter+ even, then gets normal" bug Manoj reported on the
    // trial flow. Wait until billing is loaded before deciding whether
    // to render the nudge at all.
    {
      id: "upgradeNudge",
      component: "UpgradeNudge",
      renderIf: (ctx) => ctx?.entReady !== false && ctx?.plan === "free",
      props: {
        intent: "card",
        tier: "starter",
        benefit: "Unlock 30-day trend, top sellers, and growth signals",
        ctaLabel: "Try Starter free for 14 days",
        cta: "/subscription?plan=starter&source=dashboard",
      },
    },
  ],

  // ── Zone 3 — Health Signals. Urgent only, often 0 cards (calm). ──
  zone3: [
    // Inventory CRITICAL — gated on data activation, NOT business_type.
    {
      id: "inv",
      component: "InventoryPanel",
      renderIf: (ctx) =>
        !!ctx?.activations?.hasInventory &&
        (ctx?.inventoryCriticalCount ?? 0) > 0,
    },

    // Expiry warnings.
    {
      id: "exp",
      component: "ExpiryWarningsCard",
      renderIf: (ctx) =>
        ctx?.has?.("dashboard_expiry_warnings") &&
        (ctx?.expiringSoonCount ?? 0) > 0,
    },

    // Smart Staffing — Pro feature + staff activation.
    {
      id: "staff",
      component: "SmartStaffingCard",
      renderIf: (ctx) =>
        ctx?.has?.("staff_schedule_autopilot") && !!ctx?.activations?.hasStaff,
    },

    // AlertsPanel — keep as inbox-style scannable list.
    {
      id: "alerts",
      component: "AlertsPanel",
      renderIf: (ctx) => (ctx?.actionItems?.length ?? 0) >= 1,
    },

    // CloserPrompt — when daily close hasn't been run today.
    {
      id: "closer",
      component: "CloserPromptCard",
      renderIf: (ctx) =>
        !ctx?.dailyCloseRanToday && (ctx?.summary?.todaySales ?? 0) > 0,
    },

    // AllClearCard — Linear Inbox-Zero pattern. When all dynamic Zone-3
    // cards are absent, render an explicit empty state explaining why.
    {
      id: "allClear",
      component: "AllClearCard",
      renderIf: (ctx) =>
        (ctx?.zone3DynamicCount ?? 0) === 0 && !ctx?.activations?.isFirstRun,
    },
  ],

  // ── fullPageStates — REPLACE the zone tree entirely when matched. ──
  fullPageStates: [
    {
      id: "firstRun",
      component: "FirstRunCollapsedDashboard",
      renderIf: (ctx) => !!ctx?.activations?.isFirstRun,
    },
  ],
};

// Convenience — the list of zone keys in render order.
export const DASHBOARD_ZONE_KEYS = ["zone1", "zone2", "zone3"];

// IDs of cards in zone3 that count toward "the dynamic count" for the
// AllClearCard renderIf predicate. The orchestrator pre-computes
// `ctx.zone3DynamicCount` by checking renderIf for each non-allClear id.
export const ZONE3_DYNAMIC_IDS = ["inv", "exp", "staff", "alerts", "closer"];
