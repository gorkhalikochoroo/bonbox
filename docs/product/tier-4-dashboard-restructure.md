# Tier 4 — Dashboard / Sales / Expenses restructure (v2)

**v2 changes from v1 (after PM critique 2026-05-25):**
- 5 verdicts upgraded (BusinessHealth REFACTOR not DELETE, WeekComparison MERGE INTO KPI delta, etc.)
- 4 new cards added (OutstandingFakturaCard, GrowthLeverCard, ComplianceCountdownCard, AllClearCard)
- Persona config rewritten: 6 personas → 2 archetypes + **activation flags** (kills the "restaurant signs up as event_organizer, loses inventory" footgun)
- Loading + first-run + mobile states explicitly specified
- Tier gating per card per Manoj's "free starter pro everyone should get but mostly starter and pro and limit free"

---

**Lens:** business-growth, not minimalism. Every surviving card answers one of three questions:

1. **What's making me money today?** (revenue, top sellers, conversion)
2. **What's costing me money this week?** (expenses, low margin, leaks)
3. **What's coming up that I must handle?** (MOMS, overdue invoices, expiring stock)

If a card doesn't answer one of those, it gets demoted or deleted.

**Method:** persona-aware composition over a 3-zone shell. Same primitives, different card-sets per business type.

---

## 1. The 3-question filter applied to current Dashboard (14 card blocks)

| # | Card (current) | JTBD | Verdict (v2 after critique) |
|---|---|---|---|
| 1 | `SmartDriftBanner` | Q3 — Daily Close needs reconciliation | **KEEP** in PageNotices slot |
| 2 | `MomsCountdownCard` | Q3 — MOMS filing deadline | **GENERALIZE → `ComplianceCountdownCard`** that surfaces *next* deadline of any kind (MOMS / kvartalsregnskab / SKAT lønseddel / årsregnskab). Single Zone 1 line. |
| 3 | `AccountantHoursWidget` | Retention proof | **KEEP** Zone 1 (Starter+ — hidden on Free per tier gate) |
| 4 | `DailyBriefCard` | Q1+Q2+Q3 — 3 ranked actions | **PROMOTE to hero — Zone 1 position #1** |
| 5 | 4-tile KPI strip | Q1 — money in, today | **KEEP**, trim to 3 tiles (Today / Week / Compliance-next) + **wire WeekComparison's delta into the existing StatCard delta-arrow** (`28,660 DKK ↑12% vs last week`) |
| 6 | `TopSellersCard` | Q1 — what's selling | **CONDITIONAL** — `activations.hasInventory && topSellers.length >= 2`. When n=0–1, render `<Empty>` state ("Log a sale to see your top movers") not hidden. |
| 7 | `RevenueForecastCard` | Q1 — forward revenue | **DEMOTE to /reports** (monthly planning, not daily). Weather emoji removed. |
| 8 | `ProfitLossCard` | Q1+Q2 — net for month | **KEEP** Zone 2 (compress: Revenue/Expenses/Net only) |
| 9 | `PaymentBreakdownCard` | Q1 — money-in by channel | **CONDITIONAL** — Zone 2 compact 3-row for transactional-daily persona (Maria's café needs daily channel reconciliation: did the card terminal go down at 14:00?). Demoted to /reports for project-weekly persona. |
| 10 | `ExpenseBreakdownCard` | Q2 — categories | **DEMOTE to /reports** |
| 11 | `InventoryPanel` | Q3 — stockouts | **CONDITIONAL on `activations.hasInventory && ctx.inventoryCriticalCount > 0`**. Not on business_type — that footgun is killed. |
| 12 | `AlertsPanel` | Q3 — exhaustive open items | **KEEP in Zone 3 as Inbox** when `count >= 1`. Daily Brief = curated top-3 (different JTBD). AlertsPanel = scannable list. Don't merge. |
| 13 | `WeekComparisonCard` | Q1 — week-over-week trend | **MERGE INTO KPI tile delta** (no standalone card). Signal survives as `↑12%` badge on Today's Revenue tile. |
| 14 | `BusinessHealthCard` | Composite health | **REFACTOR not DELETE**. The Stripe/Pleo pattern — one composite number + one falsifiable verdict + one next-best-action. Example: *"Healthy — margin held above 30% this week. Watch: expense-to-revenue ratio drifted +4%."* Keep Zone 2 below trend. |
| 15 | `GoalTracker` | Q1 — progress to target | **CONDITIONAL** — only when ≥1 goal is set. Empty-state nudge spam deleted. |
| 16 | `BudgetSnapshot` | Q2 — spend control | **DEMOTE to /budget** (page already exists) |
| 17 | `RevenueTrendChart` | Q1 — sustained growth | **PROMOTE Zone 2 position #1**. Days = 7/30/90 per tier. |
| 18 | `SmartStaffingCard` | Q2 — labor cost | **CONDITIONAL on `activations.hasStaff`** (NOT business_type). Pro-only (uses `staff_schedule_autopilot` feature flag). |

**Cards added in v2 (the 4 omissions the critique caught):**

| # | Card (new) | Zone | When |
|---|---|---|---|
| 19 | **`OutstandingFakturaCard`** | Zone 1 | When ≥1 invoice overdue. *"3 overdue · 24,500 DKK — review →"*. Sudip's biggest cashflow pain has its own surface, not just a Daily Brief item that can drop off. |
| 20 | **`GrowthLeverCard`** | Zone 2 | Pro-gated. When ≥3 events of ≥2 distinct types (or ≥2 weeks of sales for transactional persona). *"Friday events earn 73% more per ticket than weekday — book another Friday in June."* This is the informative card Manoj asked for. |
| 21 | **`MonthEndBundleBanner`** | Zone 1 | Last 5 days of month. *"Month-end pack ready — 8 faktura, 12 expenses → Send to revisor"*. Component already exists in codebase, wire to new shell so it doesn't get lost in migration. |
| 22 | **`AllClearCard`** | Zone 3 | When 0 dynamic Zone-3 cards. *"All clear. MOMS filing on track. Next deadline: kvartalsregnskab in 23 days."* Linear's Inbox-Zero pattern — empty must explain emptiness. |

**Other conditional banners (existing components — explicit decisions to avoid losing them in migration):**
- `CloserPromptCard` → Zone 3 conditional when daily close not run today
- `ConnectionsProgressCard` → onboarding-only, hide after 100%
- `PushOptInPrompt` → PageNotices once per user, then dismissed
- `DemoActiveBanner` → PageNotices when demo data active
- `FirstRunWizard` → overlays everything when first-run state
- `BranchSummaryCard` → conditional when multi-branch configured
- `ScheduleConfirmationCard` + `SickCallNotificationCard` + `SwapRequestNotificationCard` → Zone 3 conditional notifications
- `InsightsCard` → audit if still used; if yes, fold its signals into `GrowthLeverCard`

**Net:** 18 cards → 22 card slots (6 always visible + 16 conditional, only 3-5 typically rendering). 7 demoted to /reports. 1 deleted (BudgetSnapshot kept but moved). BusinessHealth + WeekComparison + MOMS Countdown REFACTORED.

---

## 2. New Dashboard structure — 3 zones, persona-aware

```
PageShell width="wide"
  PageHeader title actions (already shipped: 2 CTAs + overflow)
  PageNotices                        # SmartDriftBanner + trial countdown live here
  
  ZONE 1 — TODAY's PULSE              # always visible, 5-second scan
    DailyBriefCard (hero — 3 actions, full width)
    Row: [3-tile KPI: today revenue / week revenue / MOMS countdown]
         [AccountantHoursWidget (small, right-aligned)]
  
  ZONE 2 — GROWTH LEVERS              # actionable this week
    RevenueTrendChart (30-day, full width, 24-row tall)
    Row: [ProfitLossCard (compact)] [GoalTracker IF set, else hidden]
    TopSellersCard IF ≥5 products with sales > 0, else hidden
  
  ZONE 3 — HEALTH SIGNALS             # urgent only, conditionally rendered
    InventoryPanel IF persona=restaurant AND items below min
    ExpiryWarningsCard IF items expiring < 7 days
    SmartStaffingCard IF persona=restaurant AND staff configured
    
  Footer: "View all metrics → /reports" link
```

**Read top-to-bottom:** Daily Brief (what to do) → KPIs (where I stand) → Trend (am I growing) → P&L (am I profitable) → Conditional health signals (anything broken).

**The reading rhythm:**
- Zone 1 always renders (1-2 viewport heights on mobile)
- Zone 2 always renders (1-2 viewport heights)
- Zone 3 renders 0-3 cards depending on state (often 0 — that IS the calm state)

When Sudip has no urgent issues, his Dashboard is **2 viewport heights tall**, not 4.5. When Maria's restaurant has 3 critical inventory items + a staffing imbalance, Dashboard is 3 viewport heights — same scroll length as today but with information that drives action.

---

## 3. Persona + activation-driven card-set config (v2 — critique-amended)

**v1 mistake the critique caught:** I drove rendering off `business_type` directly. That meant a restaurant owner who clicks the wrong dropdown on signup loses Inventory CRITICAL — a real safety net silently disappears.

**v2 fix:** `business_type` *seeds defaults* on signup. **Activation flags derived from data** drive the actual rendering. Inventory shows when inventory exists, regardless of stated business type.

New file `frontend/src/config/dashboardCardSets.js`:

```js
// 2 archetypes seed defaults at signup. Activation flags drive rendering.
// `ctx.has(featureFlag)` reads PLAN_FEATURES via useEntitlements().
// `ctx.activations.X` reads data state — Inventory shows when inventory exists,
//   not when business_type === "restaurant".

const ARCHETYPES = {
  // Daily ops: cafe/bar/restaurant/retail — high-frequency transactions
  transactionalDaily: {
    defaultActivations: { hasInventory: true, hasStaff: true, hasMultiPayment: true },
    salesRightRail: "session4tile",   // 4-tile session reconciliation
    expensesDefaultMode: "quick",
  },
  // Project ops: event_organizer/freelancer/clinic — weekly burst transactions
  projectWeekly: {
    defaultActivations: { hasInventory: false, hasStaff: false, hasEvents: true },
    salesRightRail: "sessionInline",  // single line "3 sales this session"
    expensesDefaultMode: "quick",
  },
};

const BUSINESS_TYPE_TO_ARCHETYPE = {
  restaurant: "transactionalDaily",
  cafe:       "transactionalDaily",
  bar:        "transactionalDaily",
  retail:     "transactionalDaily",
  event_organizer: "projectWeekly",
  freelancer: "projectWeekly",
  general:    "transactionalDaily",   // balanced default
  other:      "transactionalDaily",
};

export function getArchetype(user) {
  return ARCHETYPES[BUSINESS_TYPE_TO_ARCHETYPE[user.business_type] || "transactionalDaily"];
}

// Activations are LIVE-derived from data, not user-declared.
// This eliminates the "wrong dropdown → safety net disappears" footgun.
export function deriveActivations(ctx, archetype) {
  return {
    hasInventory:    ctx.inventory.itemCount > 0,
    hasStaff:        ctx.staff.configured && ctx.staff.headcount > 0,
    hasEvents:       ctx.events.recurringCount > 0 || ctx.events.totalCount >= 3,
    hasMultiPayment: ctx.payments.distinctMethods.length >= 2,
    hasOutstandingInvoices: ctx.invoices.overdueCount > 0,
    hasUpcomingCompliance: ctx.compliance.daysToNext <= 30,
    isMonthEnd:      ctx.now.daysToMonthEnd <= 5,
    isFirstRun:      ctx.summary.totalSales === 0,
  };
}

// The actual card set — one declarative tree.
// Each card has: { id, component, renderIf?, props?, requiresFeature? }
export const DASHBOARD_CARD_SET = {
  notices: [
    { id: "drift", component: "SmartDriftBanner",
      renderIf: (ctx) => ctx.driftActive },
    { id: "demo", component: "DemoActiveBanner",
      renderIf: (ctx) => ctx.isDemoData },
    { id: "trial", component: "TrialBanner",
      renderIf: (ctx) => ctx.trialDaysLeft !== null && ctx.trialDaysLeft <= 7 },
    { id: "push", component: "PushOptInPrompt",
      renderIf: (ctx) => !ctx.pushOptedIn && ctx.summary.totalSales >= 3 },
  ],

  zone1: [
    // OutstandingFakturaCard — Sudip's #1 pain (NEW in v2)
    { id: "outstandingFaktura", component: "OutstandingFakturaCard",
      renderIf: (ctx) => ctx.activations.hasOutstandingInvoices },

    // Month-end Send-to-revisor (NEW in v2 — wires existing component)
    { id: "monthEnd", component: "MonthEndBundleBanner",
      renderIf: (ctx) => ctx.activations.isMonthEnd && ctx.has("send_to_revisor") },

    // Daily Brief — always the hero
    { id: "brief", component: "DailyBriefCard" },

    // KPI strip + Compliance + AccountantHours
    { id: "kpi+hours", component: "Row", children: [
      { id: "kpi3", component: "KpiStrip", props: (ctx) => ({
        tiles: ["today", "week", "complianceNext"],
        showDelta: true,   // wires WeekComparison delta INTO the today-tile
      })},
      { id: "hours", component: "AccountantHoursWidget",
        renderIf: (ctx) => ctx.has("dashboard_accountant_hours") },
    ]},
  ],

  zone2: [
    // Revenue trend — Pro=90d, Starter=30d, Free=7d
    { id: "trend", component: "RevenueTrendChart",
      props: (ctx) => ({
        days: ctx.has("revenue_trend_90d") ? 90
            : ctx.has("revenue_trend_30d") ? 30
            : 7,
      })},

    // P&L compact + GoalTracker
    { id: "pl+goal", component: "Row", children: [
      { id: "pl", component: "ProfitLossCard" },
      { id: "goal", component: "GoalTracker",
        renderIf: (ctx) => ctx.has("dashboard_goal_tracker") && ctx.goalsSet },
    ]},

    // BusinessHealth REFACTORED — single composite line, falsifiable verdict (v2)
    { id: "health", component: "BusinessHealthCard",
      renderIf: (ctx) => ctx.has("dashboard_business_health") && ctx.summary.totalSales >= 10 },

    // PaymentBreakdown — daily reconciliation for café operators (v2 amendment)
    { id: "paymentBreakdown", component: "PaymentBreakdownCard",
      props: { compact: true },
      renderIf: (ctx) => ctx.archetype === "transactionalDaily" && ctx.activations.hasMultiPayment },

    // Top Sellers — gated on inventory + threshold of 2 (v2 amendment, was 5)
    { id: "sellers", component: "TopSellersCard",
      renderIf: (ctx) => ctx.has("dashboard_top_sellers") && ctx.activations.hasInventory },

    // Growth Lever — the NEW informative Pro card (v2)
    { id: "growthLever", component: "GrowthLeverCard",
      renderIf: (ctx) => ctx.has("growth_intelligence") && ctx.growthSignals.length > 0 },

    // Free upgrade nudge — fills the slot Pro/Starter has growth cards
    { id: "upgradeNudge", component: "UpgradeNudge",
      renderIf: (ctx) => ctx.plan === "free",
      props: {
        title: "Unlock 30-day trend, top sellers, growth signals",
        cta: "Try Starter free for 14 days",
        href: "/subscription?plan=starter&source=dashboard",
      },
    },
  ],

  zone3: [
    // Inventory CRITICAL — gated on data, NOT business_type (v2 footgun fix)
    { id: "inv", component: "InventoryPanel",
      renderIf: (ctx) => ctx.activations.hasInventory && ctx.inventoryCriticalCount > 0 },

    // Expiry warnings
    { id: "exp", component: "ExpiryWarningsCard",
      renderIf: (ctx) => ctx.has("dashboard_expiry_warnings") && ctx.expiringSoonCount > 0 },

    // Smart Staffing — gated on staff activation + Pro feature
    { id: "staff", component: "SmartStaffingCard",
      renderIf: (ctx) => ctx.has("staff_schedule_autopilot") && ctx.activations.hasStaff },

    // AlertsPanel — kept as inbox-style, NOT merged into Daily Brief (v2 amendment)
    { id: "alerts", component: "AlertsPanel",
      renderIf: (ctx) => ctx.actionItems.length >= 1 },

    // Closer prompt — when daily close not run today
    { id: "closer", component: "CloserPromptCard",
      renderIf: (ctx) => !ctx.dailyCloseRanToday && ctx.summary.todaySales > 0 },

    // AllClearCard — when Zone 3 has 0 dynamic cards (v2 — Linear Inbox-Zero pattern)
    { id: "allClear", component: "AllClearCard",
      renderIf: (ctx) => ctx.zone3DynamicCount === 0 && !ctx.activations.isFirstRun },
  ],

  // States that REPLACE the whole Dashboard
  fullPageStates: [
    { id: "firstRun", component: "FirstRunCollapsedDashboard",
      renderIf: (ctx) => ctx.activations.isFirstRun },
    // Existing onboarding wizard continues to render as overlay when triggered
  ],
};
```

**Why this v2 shape:**
- **Activation flags decouple rendering from `business_type`.** Inventory CRITICAL shows when inventory exists, not when user-declared field equals "restaurant." Footgun killed.
- **`ctx.has(featureFlag)` reads PLAN_FEATURES via the existing `useEntitlements()` hook.** Same single source of truth as the rest of the app. Multi-barrier 10-layer doctrine intact — server re-checks every Pro endpoint.
- **One file owns the entire visual hierarchy.** Future archetypes (`clinic`, `freelancer`) extend the `BUSINESS_TYPE_TO_ARCHETYPE` map and may add an entry to `ARCHETYPES` — they do NOT add a 3rd card-set tree.
- **`renderIf` composes archetype + activation + feature flag + data state.** One predicate per card. No 50 inline `if` statements across DashboardPage.
- **`fullPageStates`** explicitly handles first-run / loading / empty — these states REPLACE the zone tree, not nest inside it. Loading state spec: render skeletons matching the zone shape (DailyBrief skeleton + 3 KPI tile skeletons + AccountantHours skeleton), no "Loading your day..." text.

---

## 4. Sales page restructure

### Decision: keep the 4-tile KPI right-rail, but reframe it.

**Currently:** TODAY 0 / MAY REVENUE 38,410 / AVG SALE 12,803 / BY PAYMENT (mini-bars). All period scoped, all duplicating Dashboard.

**Reframe:** the right-rail becomes a **session reconciliation panel**, not period analytics.

```
Right rail (4 small tiles):
  THIS SESSION         3 sales logged · 2,450 DKK
  TODAY                what was logged today (matches Dashboard)
  EVENT (if filtered)  filtered total for the selected event
  RECONCILE            "Matches cash drawer? [Open Daily Close →]"
```

**Why:** the user came to Sales to **log + verify**, not to analyze. Session-scoped feedback ("you've logged 3 sales this session") is unique to this page and earns its place. Today + Event + Reconcile are all action-oriented.

### Recent Sales table → migrate to `<DataTable>` primitive

Replace the hand-rolled `<table>` with:
```jsx
<DataTable
  columns={[
    { id: "amount", label: "Amount", align: "right", render: r => formatDKK(r.amount) },
    { id: "method", label: "Method" },
    { id: "notes",  label: "Notes" },
    { id: "date",   label: "Date", width: "w-32" },
  ]}
  rows={recentSales}
  rowKey="id"
  empty={<Empty title="No sales yet" body="Tap a quick amount above to log your first." />}
  rowActions={(row) => [
    { label: "Return", icon: <Undo2 size={14} />, onClick: () => openReturn(row) },
    { label: "Edit", icon: <Pencil size={14} />, onClick: () => openEdit(row) },
    { label: "Delete", icon: <Trash size={14} />, onClick: () => softDelete(row), variant: "danger" },
  ]}
/>
```

LOC savings: ~150 LOC of inline table chrome removed.

### Migrate the FilterBar

The current event-filter + date-range row is hand-rolled. Move to:
```jsx
<FilterBar>
  <FilterBar.Select label="Event" value={eventFilter} onChange={setEventFilter} options={eventOptions} />
  <FilterBar.Date label="From" value={from} onChange={setFrom} />
  <FilterBar.Date label="To" value={to} onChange={setTo} />
  <FilterBar.Search value={q} onChange={setQ} placeholder="Amount, notes..." />
  {hasActiveFilter && <FilterBar.Reset onClick={clearFilters} />}
</FilterBar>
```

---

## 5. Expenses page restructure

### Decision: delete the period KPI right-rail. Reframe with InboxBanner as the hero.

**Currently:** Header + InboxBanner + Tabs + EntryCard + 4-tile period KPI rail + Recent table.

**Sudip's actual job here:** triage the receipts that the inbox alias caught overnight. Logging an in-person cash expense is the *secondary* job.

**New layout:**

```
PageShell width="default"
  PageHeader eyebrow="MONEY" title="Expenses" actions=[Snap Receipt | ... ]
  
  InboxBanner                       # expanded by default WHEN count > 0
                                    # collapsed-thin-row when count = 0
                                    # this is Sudip's hero
  
  TabPills [One-time | Recurring]
  
  EntryCard                          # Quick mode by default — Detailed
                                    # becomes a progressive disclosure
                                    # ("More fields ↓") inside the card,
                                    # not a top-level tab
  
  PageSection title="This month" actions=
    <span className="text-xs text-gray-500">
      350 DKK across 2 expenses
      <Link>View breakdown in /reports →</Link>
    </span>
                                    # one-line summary, NOT a 4-tile strip.
                                    # full breakdown lives in /reports.
  
  PageSection title="Recent expenses" actions={<FilterBar>}>
    <DataTable />
```

**Why merge Quick/Detailed into progressive disclosure:**
- Quick mode is 95% of usage (snap photo or tap chip → done)
- Detailed mode adds: vendor input, smart-scan verify chips, FX panel
- A top-level toggle forces the user to choose before they know what they need
- Inside the EntryCard, a small "More fields ↓" disclosure surfaces the detailed inputs on-demand

**Why InboxBanner becomes hero:**
- It's Sudip's actual workflow signal: "5 receipts to review"
- When count = 0, it's a quiet thin row ("Active · 0 this month") that doesn't compete
- When count > 0, it's expanded with a "Review all →" CTA

---

## 6. Migration risks + safety

| Risk | Mitigation |
|---|---|
| `business_type` defaults to "restaurant" — existing accounts get full card set, no surprise | ✓ Already the prod default |
| `business_type` null/missing | `getCardSet()` falls back to restaurant set |
| User has stale `business_type` after vertical change | Add a "Looks wrong? Update business type →" link in Dashboard footer linking to /profile |
| Bookmarks to /dashboard still work | ✓ URL unchanged, content shape changes |
| Mobile compression (iPhone SE = 375px) | Zone 1 fits in single viewport. Row components stack on `<lg`. |
| Multi-barrier 10-layer doctrine | Restructure is pure composition — no new endpoints, no new caps. L1-L10 unchanged. |
| DK terminology lock | Zone titles ("TODAY's PULSE", "GROWTH LEVERS", "HEALTH SIGNALS") translate. **MOMS / revisor / faktura stay Danish in card content per existing lock.** |
| Demoted cards (PaymentBreakdown / ExpenseBreakdown / WeekComparison / Forecast) | Move to /reports as sections — keep the components, just relocate. Zero deletion of working code. |
| Empty Zone 3 reads as "broken" | When Zone 3 has 0 cards, omit the zone header entirely. Dashboard ends after Zone 2 footer link. |
| Existing in-flight users have Dashboard open during deploy | React component swap, no data layer change — page just re-renders with new structure on next route navigation. |
| Tier gating on demoted-to-/reports cards | Audit: PaymentBreakdown is Free, ExpenseBreakdown is Free, RevenueForecast is Free. No tier issues. |
| Analytics tracking (if any) | Add `data-zone="1|2|3"` attributes for future heatmap analysis |

---

## 7. Ship plan

### Phase A — Build the new shell (Day 1)
1. Create `frontend/src/components/dashboard/` directory (new)
2. Extract existing card components into `dashboard/` if they live elsewhere (mostly already standalone)
3. Create `frontend/src/config/dashboardCardSets.js` (the persona config)
4. Create `frontend/src/components/dashboard/DashboardZones.jsx` — renders a zone given a card-set, handles `renderIf` predicates
5. Create `frontend/src/components/dashboard/KpiStrip.jsx` — the 3-tile strip primitive used in Zone 1
6. Create `frontend/src/components/dashboard/PageNotices.jsx` — the banner stack slot for drift/trial/inbox

### Phase B — Wire DashboardPage to the new shell (Day 1)
1. `DashboardPage.jsx` becomes ~300 LOC instead of 2,150 — it composes `<PageShell>`, fetches data, builds `ctx`, passes `ctx` + `cardSet` to `<DashboardZones>`
2. Delete `BusinessHealthCard` usage (verdict: delete)
3. Delete empty-state goal cards inline render (now conditional via cardSet)
4. Delete `AlertsPanel` (merged into DailyBriefCard logic — verify DailyBriefCard surfaces inventory + drift + expiry alerts; if not, extend it)

### Phase C — Migrate Sales (Day 2)
1. Reframe right-rail to session reconciliation tiles
2. Migrate Recent Sales table to `<DataTable>` primitive
3. Migrate event/date/search filter row to `<FilterBar>`

### Phase D — Migrate Expenses (Day 2)
1. InboxBanner → conditional hero (expanded when count > 0, thin when count = 0)
2. Merge Quick/Detailed mode toggle into progressive disclosure inside EntryCard
3. Delete period KPI right-rail, replace with one-line summary
4. Migrate Recent Expenses to `<DataTable>` + `<FilterBar>`

### Phase E — Demote cards to /reports (Day 3)
1. Add tabbed sections to `ReportsPage.jsx`: Forecast / Payment Methods / Expense Categories / Week-over-Week / Budget
2. Each demoted card relocates as a `<Card>` within the right tab
3. Add `<Link to="/reports?tab=X">View in Reports →</Link>` from Dashboard footer

### Phase F — Verify + commit (Day 3)
1. `npm run build` — must pass
2. `npm run lint:doctrine` — no new violations in new files
3. Snapshot-test the persona switch (set `business_type=event_organizer` → confirm Inventory + Staffing don't render)
4. Mobile screenshot at iPhone SE width — Zone 1 must fit in one viewport
5. Commit as single PR: "feat(dashboard): persona-aware 3-zone restructure"

**Estimated LOC:**
- DashboardPage.jsx: 2,150 → 350 (−1,800)
- New shell + zones + config: +600
- ReportsPage.jsx: +300 (absorbing demoted cards)
- SalesPage.jsx: 1,712 → 1,500 (−212, table + filterbar primitives)
- ExpensesPage.jsx: 1,645 → 1,400 (−245, table + filterbar + form merge)
- **Net: −1,357 LOC.** When the system shrinks the codebase, the system is real.

---

## 8. What this will FEEL like for Manoj after deploy

He opens www.bonbox.dk on his phone. The page is **2 viewport heights tall**, not 4.5.

**Above the fold (Zone 1):**
- "Daily Brief — your 3 actions today"
- "Reorder Ice (2 left)" · "Collect 9,000 DKK from Café Nyhavn" · "Variance: Daily Close is 76% off POS — review"
- Below it: TODAY 28,660 DKK · WEEK 38,410 DKK · MOMS in 23 days. AccountantHours = 24h saved this month.

**Scroll once (Zone 2):**
- A clean 30-day revenue line (gray with green growth tick)
- P&L: +38,060 DKK net · 99.1% margin
- Top Sellers — if there are ≥5 products. (Sudip in his event-organizer test account: no top sellers card, less embarrassment.)

**Scroll again (Zone 3 — usually empty):**
- For Maria (restaurant): "3 items at minimum — Reorder →"
- For Sudip (event_organizer): nothing. Calm.

He says: *"yes. This is informative because I know what to do next. This is not vibe-coded because every card has a reason. This helps me grow."*

---

## 9. Tier gating per card (locked 2026-05-25 by Manoj)

> **Manoj:** *"free starter pro everyone should get but mostly starter and pro and limit free"*

Translation: every tier sees a Dashboard. Free is **constrained enough to convert serious users** (not crippled — tasted). Starter is the sweet spot — full 3-zone structure. Pro adds premium intelligence on top.

### The Free Dashboard — minimum viable, conversion-driving

| Zone | Card | Free state |
|---|---|---|
| Zone 1 | Daily Brief | **2-action list** (vs 3 on Starter/Pro). Inventory/expiry surfaced here for Free. |
| Zone 1 | 3-tile KPI strip | Today / Week / MOMS — basic only |
| Zone 1 | AccountantHoursWidget | **Hidden** — this is retention proof for paid users |
| Zone 2 | RevenueTrendChart | **Last 7 days only** (vs 30 days on Starter, 90 on Pro). With "Upgrade for 30-day trend →" link |
| Zone 2 | ProfitLoss (compact) | Basic — Revenue / Expenses / Net only |
| Zone 2 | TopSellers | **Hidden** (Starter+) |
| Zone 2 | GoalTracker | **Hidden** (Starter+) |
| Zone 2 | **`<UpgradeNudge>` card** | "Unlock 30-day trend, top sellers, growth signals — try Starter free 14 days" — **rendered in Zone 2 instead of TopSellers slot** |
| Zone 3 | InventoryPanel | Renders (safety net — critical alerts are universal) |
| Zone 3 | ExpiryWarnings | **Hidden** (Starter+) |
| Zone 3 | SmartStaffing | **Hidden** (Pro feature) |

**Free target:** the user sees 4-5 cards. Enough to feel like a product. The Zone 2 UpgradeNudge replaces TopSellers and is the explicit conversion surface.

### The Starter Dashboard — the sweet spot, full feature

This IS the spec in Sections 1-8 above. All cards render per persona. Daily Brief shows 3 actions. Revenue Trend is 30 days. TopSellers + GoalTracker + ExpiryWarnings all available. AccountantHoursWidget visible. No upgrade nudge in card slots.

**Starter target:** the user opens Dashboard and never feels like content is missing. This is the "premium feel" Manoj called out — but everywhere.

### The Pro Dashboard — Starter + Premium Intelligence

| Add to Starter | Card | What it does |
|---|---|---|
| Zone 1 | **OutstandingInvoicesCard** | Q3 urgent: "9,000 DKK owed across 2 customers · oldest 12 days overdue" with one-tap "Send reminder" (uses `customer_outreach` feature, Pro-only) |
| Zone 2 | **GrowthLeverCard** | The PM critique pointed this out: "Your Friday events earn 73% more per ticket than weekday — book another Friday in June." Pro-only AI insight from event/sale pattern analysis. **Uses `growth_intelligence` — new feature flag.** |
| Zone 2 | RevenueTrendChart | **90-day window with confidence band** (vs 30 days on Starter) |
| Zone 3 | SmartStaffing | Full autopilot (vs hidden on Starter, this card is `staff_schedule_autopilot` Pro-only per task #50) |
| Zone 3 | **TaxAutopilotPreview** | Q3 compliance: "MOMS Q2 ready to file — review & send to revisor" with one-tap action (Pro-only per task #51) |

**Pro target:** the Dashboard becomes a **predictive growth surface** — not just "here's what happened" but "here's what to do next to make more money."

### Implementation: feature-flag-driven, NOT inline-if

Extend `frontend/src/config/dashboardCardSets.js` from a flat `{zone1:[], zone2:[], zone3:[]}` per persona to a tier-aware shape:

```js
// Cards are filtered by BOTH persona AND tier features.
// renderIf can also gate by feature/cap.
{
  id: "trend",
  component: RevenueTrendChart,
  props: (ctx) => ({
    days: ctx.has("revenue_trend_90d") ? 90
        : ctx.has("revenue_trend_30d") ? 30
        : 7,
  }),
}

{
  id: "outstandingInvoices",
  component: OutstandingInvoicesCard,
  renderIf: (ctx) => ctx.has("customer_outreach") && ctx.outstandingTotal > 0,
}

{
  id: "growthLever",
  component: GrowthLeverCard,
  renderIf: (ctx) => ctx.has("growth_intelligence") && ctx.growthSignal,
}

{
  id: "upgrade",
  component: UpgradeNudge,
  renderIf: (ctx) => ctx.plan === "free",
  props: {
    title: "Unlock 30-day trend, top sellers, growth signals",
    cta: "Try Starter free for 14 days",
    href: "/subscription?plan=starter&source=dashboard",
  },
}
```

**Why this shape:**
- `ctx.has(featureFlag)` is the existing `useEntitlements()` hook from billing.py → PLAN_FEATURES
- `props` can be a function so the same component renders with different config per tier (Trend chart: 7d / 30d / 90d)
- `renderIf` composes persona + feature flag + data state — one predicate, one decision
- Multi-barrier 10-layer doctrine intact: the frontend `ctx.has()` is advisory; every Pro-only endpoint (e.g. `/api/growth-signals`, `/api/customer-outreach`) still re-checks server-side per existing PLAN_FEATURES gate

### New backend feature flags needed (one Alembic migration)

Add to `PLAN_FEATURES` in `billing.py`:

```python
# Free / Starter / Pro
"dashboard_full_kpi_strip": True / True / True       # 3-tile is universal
"revenue_trend_7d":          True / True / True       # everyone gets some trend
"revenue_trend_30d":         False / True / True      # Starter unlocks 30d
"revenue_trend_90d":         False / False / True     # Pro gets 90d + confidence
"dashboard_top_sellers":     False / True / True      # Starter+
"dashboard_goal_tracker":    False / True / True      # Starter+
"dashboard_accountant_hours": False / True / True     # Starter+ (retention card)
"dashboard_expiry_warnings": False / True / True      # Starter+
"growth_intelligence":       False / False / True     # NEW — Pro killer #3
"dashboard_outstanding_invoices_card": False / False / True  # Pro — uses customer_outreach
"dashboard_tax_autopilot_preview": False / False / True      # Pro — uses tax_autopilot
```

Audit existing flags reused (no change needed):
- `customer_outreach` (Pro) ← OutstandingInvoicesCard uses this
- `staff_schedule_autopilot` (Pro) ← SmartStaffingCard uses this
- `tax_autopilot` (Pro) ← TaxAutopilotPreview uses this

### Backend work for new `growth_intelligence` Pro feature

New endpoint `GET /api/dashboard/growth-signals` with the 10-layer doctrine:
- L1 auth + L4 rate-limit + L5 fail-soft + L6 tenant + L7 fail-closed PLAN_FEATURES check + L8 audit row + L9 fallback + L10 honest 402 if not Pro
- Returns 1-3 ranked growth signals from event/sale pattern analysis:
  - "Friday events earn 73% more — book another Friday"
  - "Last 4 cash-up totals show 8% variance — review POS reconciliation"
  - "Your weekend revenue is 2.4x weekday — staff weekends harder"
- Backed by simple SQL aggregation (no LLM in the hot path — runs in <100ms)

---

## Open decisions to lock before I execute

1. **Persona detection** via `user.business_type` (already exists). Acceptable values: `restaurant | cafe | bar | event_organizer | retail | general | other`. Default = `restaurant`. New "Update business type →" link in Dashboard footer. **OK?**

2. **`BusinessHealthCard` deletion** — gauge is vanity, no action. **OK to delete?** (PM critique pending — they may push back on this)

3. **`PaymentBreakdownCard` / `ExpenseBreakdownCard` / `WeekComparisonCard` / `RevenueForecastCard` demotion to /reports.** Same data, just relocated to where period analytics live. **OK?**

4. **Quick / Detailed mode merge on Expenses** — fold Detailed into progressive disclosure inside the EntryCard. **OK?**

5. **Sales right-rail reframe** — kill the period KPIs, replace with session reconciliation tiles. **OK?**

6. **AlertsPanel merge into DailyBriefCard** — one source of urgent signals, ranked. **OK?**

7. **Tier gating per the matrix in §9** — Free constrained but useful, Starter = full, Pro adds GrowthLever + OutstandingInvoices + TaxAutopilotPreview + 90-day Trend. **OK?**

8. **New `growth_intelligence` Pro feature flag + endpoint** — implement after the IA restructure lands, or as part of the same ship? **Your call.**

If you say "yes to all 8" I execute the full spec.
If you tweak any, I update + execute.
