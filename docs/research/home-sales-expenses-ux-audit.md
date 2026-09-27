# Home / Sales / Expenses — UX clutter audit

> Brief from Manoj: *"I feel it's a bit cluttered and not seamless."*
> Target user: **Sudip Sam** — Copenhagen Nepali-Danish event organizer, 8-13 movie nights/year, mobile-first, 20-40 min/week in BonBox.
> Files audited: `frontend/src/pages/DashboardPage.jsx` (2,151 LOC), `SalesPage.jsx` (1,770 LOC), `ExpensesPage.jsx` (1,714 LOC).

---

## 1. The big-picture diagnosis

The clutter feeling on these three pages comes from **four specific structural mistakes**, not generic over-stuffing:

1. **Dashboard has 18+ top-level conditional banners stacked before the first KPI.** `CloserPromptCard`, `TrialFinalStretchTip`, `FirstRunWizard`, `BranchSummaryCard`, `ScheduleConfirmationCard`, `SmartDriftBanner`, `MonthEndBundleBanner`, `DemoActiveBanner`, `MomsCountdownCard`, `AccountantHoursWidget`, `ConnectionsProgressCard`, `PushOptInPrompt`, `DemoDataCard`, `DailyBriefCard`, `AnomalyAlertsCard`, `ExpiryAlertsCard`, `SickCallNotificationCard`, `SwapRequestNotificationCard`, `DismissibleTip`, `InsightsCard` — each self-hides individually, but for a non-empty account 5-8 of them WILL render and they all visually compete because each uses card chrome (rounded, bordered, padded). There's no priority lane.
2. **The "tip banner" is shouting next to a real action card on /sales and /expenses.** On both pages, the first thing under the H1 is a `DismissibleTip` ("Three ways to log a sale" / "Snap, log, claim back"). It's the same visual weight as the actual entry form below it — so the user can't tell at a glance which one to look at.
3. **The form-on-left, KPIs-on-right split (`lg:grid-cols-5` with 3+2) is misaligned with intent.** On /sales and /expenses the input form is the primary job and the KPIs are the recap. But the 3/5 + 2/5 split means the KPIs draw the eye to the right at the very moment the user is trying to log something. On mobile (Sudip's case) they stack vertically — so the KPI grid pushes the recent-sales list 2-3 screens down.
4. **Cross-page inconsistency makes everything feel less designed.** Date-range pills (`Today / Week / Month / Last 30`) exist on /dashboard but not /sales or /expenses. /expenses has an `InboxBanner` AND a `DismissibleTip`. /sales has only a `DismissibleTip`. The "Snap receipt" CTA lives in the page header on /dashboard (`ReceiptCapture`), inside the form on /expenses (the purple `📷 Scan` button — also still emoji, in violation of Lucide-only), and nowhere on /sales (you have to know about the camera icon hidden behind `+ Item sale`).

The pages are not over-engineered — most cards have a real reason to exist. The problem is **no priority lane, no visual hierarchy, and three different layout grammars across three sibling pages.**

---

## 2. Page-by-page restructure proposals

### /dashboard — `DashboardPage.jsx`

**Current top-to-bottom (lines 1700-2148):**

| # | Section | Visual weight | Condition |
|---|---------|---------------|-----------|
| 0 | `PageHeader` — greeting + 4 CTAs (Quick Sale / Smart entry / Receipt / Repeat Yesterday / PDF) | Heavy | always |
| 1 | `SectionBanner` quickMsg | Light | conditional |
| 2 | `CloserPromptCard` | Medium | conditional |
| 3 | `TrialFinalStretchTip` | Medium | trial days ∈ {1,2} |
| 4 | `FirstRunWizard` | Heavy | new accounts |
| 5 | `BranchSummaryCard` | Medium | ≥2 branches |
| 6 | `ScheduleConfirmationCard` | Light | has shifts |
| 7 | `SmartDriftBanner` | Light | drift detected |
| 8 | `MonthEndBundleBanner` | Medium | last 5 / first 5 of month |
| 9 | `DemoActiveBanner` | Light | demo loaded |
| 10 | `MomsCountdownCard` | Medium | tax prefs saved |
| 11 | `AccountantHoursWidget` | Medium | always (Free = upsell, Starter+ = live) |
| 12 | `ConnectionsProgressCard` | Medium | incomplete setup |
| 13 | `PushOptInPrompt` | Light | day-1+ |
| 14 | `DemoDataCard` | Medium | empty state |
| 15 | `DailyBriefCard` | **Heavy** | always |
| 16 | `AnomalyAlertsCard` | Medium | open alerts |
| 17 | `ExpiryAlertsCard` | Medium | Starter+, items expiring |
| 18 | `SickCallNotificationCard` | Medium | sick calls |
| 19 | `SwapRequestNotificationCard` | Medium | pending swaps |
| 20 | `DismissibleTip` "welcomeDashboard" | Light | not dismissed |
| 21 | `InsightsCard` | Medium | active patterns |
| 22 | Period selector pills (`PERIODS`) | Light | always |
| 23 | `Onboarding` | Light | incomplete |
| 24 | 4 KPI cards (`KpiCard` × 4) | Heavy | always |
| 25 | `TopSellersCard` | Heavy | always |
| 26 | `ForecastWeatherStaffing` + `PLCard` | Heavy 2-col | always |
| 27 | `PaymentBreakdownCard` + `ExpenseBreakdown` | Medium 2-col | always |
| 28 | `InventoryPanel` + `AlertsPanel` | Medium 2-col | always |
| 29 | "Ask Agent" CTA banner | Light gradient | always |
| 30 | `WeekComparisonCard` + `HealthScore` | Medium 2-col | always |
| 31 | `GoalTracker` | Medium | always |
| 32 | Budget snapshot | Medium | budgets set |
| 33 | `RevenueTrendChart` | Heavy | always |
| 34 | Recent receipts grid | Medium | receipts > 0 |

**What's redundant / orphaned / fighting:**

- **The pre-KPI banner zone (items 1-21) is the single biggest problem.** That's *21 conditional surfaces above the first KPI*. A new owner with demo data + free tier + incomplete setup hits ~7 of them stacked. By the time Sudip scrolls to the KPI row he's already done.
- **`AccountantHoursWidget`, `MomsCountdownCard`, `DailyBriefCard` are the three real heroes** but they sit in the middle of the banner stack, equal-weight with `PushOptInPrompt` and `DemoActiveBanner`. The hero is fighting the noise.
- **`AnomalyAlertsCard`, `ExpiryAlertsCard`, `SickCallNotificationCard`, `SwapRequestNotificationCard`, `MonthEndBundleBanner`, `SmartDriftBanner`** are all "interrupt" cards — same intent, different chrome. They should be one component (`<InterruptStack>`) with a max of 2 visible + "n more" collapse.
- **`ScheduleConfirmationCard`, `SickCallNotificationCard`, `SwapRequestNotificationCard`, `BranchSummaryCard`** are café-operator features. Sudip will never trigger any of them. They render unconditionally-conditional — fine technically, but the imports + render checks all run, and the architecture treats them as first-class. **For Sudip's account they're invisible — good.** The problem is for the café persona, all four fire and stack.
- **`PaymentBreakdownCard` + `ExpenseBreakdown` (row 27)** repeats data the user already saw in the period KPI tiles and the P&L card. Either drop both or replace with a single "Where did money come from / go to" sankey.
- **`WeekComparisonCard` (row 30)** duplicates info from the `vsYesterday` % change badge in KpiCard #1 and from `RevenueTrendChart` at the bottom. Pick one.
- **"Ask Agent" CTA banner (row 29)** uses a gradient (`bg-gradient-to-r from-blue-500/5 via-purple-500/5 to-pink-500/5`) — the only place on the dashboard with that rainbow treatment. Violates the gray-* DNA you established in Phase 3 polish (#119, #124). Drop the gradient.
- **Recent receipts (row 34)** still renders `🧾` emoji on the fallback path (line 2115). Lucide migration miss.
- **`DismissibleTip` "welcomeDashboard" (row 20)** is a tip that lives between alert cards and the period selector — it has no neighbor it belongs to. Orphan.

**Proposed new section order:**

```
0. PageHeader (greeting + 2 actions max — Quick Sale, Smart Entry FAB on mobile)
1. <PriorityLane>          ← NEW container, max 3 cards visible at once
     • TrialFinalStretchTip (urgent)
     • MonthEndBundleBanner (urgent if last 3 days of month)
     • FirstRunWizard (urgent, new accounts)
2. <HeroStrip>             ← the three load-bearing widgets, fixed top-of-page
     • DailyBriefCard      (left, 2-col span on desktop, full width mobile)
     • MomsCountdownCard   (right, 1-col)
     • AccountantHoursWidget (right, 1-col, stacks under Moms)
3. Period pills + 4 KPI tiles (unchanged structurally, just promoted up)
4. RevenueTrendChart (promoted from bottom — this is the "did I make money" answer)
5. TopSellersCard (Sudip filters this by event → keep)
6. <InterruptStack>         ← NEW: collapses all interrupts into one card
     • AnomalyAlerts
     • ExpiryAlerts
     • SickCall / SwapRequest
     • SmartDrift
   "3 things to look at" header with expand/collapse. Default expanded if ≥1.
7. <SetupNudges>            ← collapsed by default, expands to show:
     • ConnectionsProgressCard
     • PushOptInPrompt
     • CloserPromptCard
     • ScheduleConfirmationCard
     • BranchSummaryCard
     • DemoActiveBanner / DemoDataCard
8. PLCard + ForecastWeatherStaffing (2-col)
9. InventoryPanel + AlertsPanel (2-col, gated on has-inventory)
10. WeekComparisonCard + HealthScore + GoalTracker → MERGE into one card "How this week stacks up"
11. Budget snapshot (only if budgets set — keep gated)
12. Recent receipts thumbnails (keep — they're delightful)
13. "Ask Agent" → move into the Layout/sidebar as a persistent chip; drop the banner
```

**Specific cards to delete or move:**

- **DELETE** the dashboard `DismissibleTip "welcomeDashboard"` (row 20) — `FirstRunWizard` already covers this. Two intro nudges is one too many.
- **DELETE** the gradient "Ask Agent" banner — move to a persistent chip in `Layout.jsx`. The dashboard is not where you discover the agent; it's where you check numbers.
- **MERGE** `PaymentBreakdownCard` + `ExpenseBreakdown` (row 27) into one "Money flow this month" card with two columns inside.
- **MERGE** `WeekComparisonCard` + `HealthScore` + `GoalTracker` into one "Pulse" card.
- **MOVE** `CloserPromptCard`, `ScheduleConfirmationCard`, `BranchSummaryCard`, `SickCallNotificationCard`, `SwapRequestNotificationCard` into the collapsed `<SetupNudges>` group. They are café-operator chrome — should not visually dominate Sudip's dashboard.
- **DROP** `DemoActiveBanner` AND `DemoDataCard` from the dashboard entirely. Move both to a chip in the sidebar near the user avatar — "Demo data on" / "Load demo" pill.

---

### /sales — `SalesPage.jsx`

**Current top-to-bottom (lines 318-770+):**

| # | Section | Visual weight |
|---|---------|---------------|
| 0 | `PageHeader` "Sales Tracker" + `+ Item sale` + `ReceiptCapture` | Heavy |
| 1 | success / error / fetchError banners | Light |
| 2 | Cultural-event filter `<select>` | Light (but visible chrome) |
| 3 | `DismissibleTip` "Three ways to log a sale" | Medium |
| 4 | **Quick-entry form (left 3/5) + 4 StatCards (right 2/5)** | Heavy split |
| 5 | `CsvUpload` block | Medium |
| 6 | `SectionBanner` pending returns | Light, conditional |
| 7 | Return summary 4 × StatCards | Medium, conditional |
| 8 | Sales History table + filter row + Pagination | Heavy |

**What's redundant / orphaned / fighting:**

- The **DismissibleTip is 100% docs**, not a tool. It teaches; it doesn't act. It's stacking visual weight against the actual entry form 50px below.
- The **event-filter dropdown** (rows 344-377) is a raw `<label>` + `<select>` — no card chrome — so it floats orphaned between the H1 and the tip banner. Doesn't read as a filter; reads as a stray form element.
- The **3/5 + 2/5 split (`lg:grid-cols-5`)** is fine on desktop but the StatCards repeat data that's already at the top of the page in the same KPI cards on /dashboard. Sudip already saw "Today: 2,340 DKK" 10 seconds ago. Here it's redundant.
- **`CsvUpload`** sits *after* the form/KPI block, *before* the sales list. It's a power-user feature (Sudip ran an event with a paper sign-in list, wants to bulk-import). Doesn't belong inline — should be a chip in the table header `[Import CSV]` next to `[Export]`.
- The **expandable detail panels under StatCards** (lines 583-682) use `bg-gradient-to-br from-green-950/80 to-gray-800` / blue / purple — three different rainbow gradients. This contradicts the Phase 3 rainbow cleanup (task #119). Same pattern as you killed once before — it crept back in via the expanded-state panels.
- **Return summary 4×StatCards (row 7)** only renders when `statusFilter === "returns"` — but it duplicates the existing pending-returns SectionBanner above it. Pick one.

**Proposed new section order:**

```
0. PageHeader — title only; move `+ Item sale` and Receipt into the FAB cluster
1. <SegmentedRow>           ← compact, single horizontal row, replaces tip + event filter + status filter:
     • Event: [All ▼]  |  Status: [All ▼]  |  Date: [This month ▼]  |  [Import CSV]  [Export]
2. Quick-entry form         — FULL WIDTH, no KPI split. This is the primary job.
                              Inline KPI strip BELOW the submit button shows
                              "Today 2,340 · Month 24,800 · Avg/day 1,180" — quiet text, not cards.
3. Sales History            — table on desktop, card-list on mobile (pattern from #123)
                              bilagsnummer chip stays; pagination unchanged.
4. (optional) Return drawer — only when returns exist, NOT as a section — as a slide-over from the
                              `[Status: Returns]` filter chip.
```

**Specific cards to delete or merge:**

- **DELETE** `DismissibleTip` "Three ways to log a sale" — the form itself teaches by being usable; the tip is condescending.
- **DELETE** the 4 separate `StatCard`s in the right column; replace with one quiet inline numeric strip under the form submit button.
- **DELETE** the expanded detail panels under StatCards (lines 583-682) entirely — three rainbow gradients pretending to be data drill-downs. The actual sales list below is the drill-down.
- **DELETE** the "Return summary 4 StatCards" block (lines 740-762) — duplicates the pending-returns SectionBanner.
- **MOVE** `CsvUpload` into the table header as `[Import CSV]` button → opens modal.
- **MERGE** event-filter `<select>` + status filter + date range into one `<SegmentedRow>` (new shared primitive — see Cross-page Consistency below).

---

### /expenses — `ExpensesPage.jsx`

**Current top-to-bottom (lines 563-1006+):**

| # | Section | Visual weight |
|---|---------|---------------|
| 0 | `PageHeader` "Expense Tracker" (no actions) | Heavy |
| 1 | success / error | Light, conditional |
| 2 | `DismissibleTip` "Snap, log, claim back" | Medium |
| 3 | `InboxBanner` (forward-to-inbox alias) | Medium |
| 4 | First-time setup `<div>` (categories quickstart) | Medium, conditional |
| 5 | `TabPills` One-time / Recurring | Light |
| 6 | (if One-time) Form 3/5 + StatCards 2/5 | Heavy split |
|   | — inside form: emoji-purple `📷 Scan` chip, Detailed/Quick toggle, category chips, custom-cat with autocomplete, vendor input, quick-amount chips, custom amount + voice + tax breakdown, FX panel (collapsed), payment chips, notes+date, Business/Personal toggle | very dense |
| 7 | StatCards right (Today / Month / Avg / By category) | Medium |
| 8 | Recent Expenses list | Heavy |

**What's redundant / orphaned / fighting:**

- **Three "intro" surfaces stacked**: tip banner + inbox banner + first-time setup. For a brand-new owner all three fire at once. **The inbox banner is the most valuable** — it teaches the killer-feature workflow (forward → done). The tip banner is the least valuable.
- The form is the most dense piece of UI in the entire app: **12 distinct controls in one card** (Scan / Detailed-Quick / category chip row / custom-cat input with autocomplete / vendor / quick-amount chips / amount + voice + tax / payment chips / FX collapsible panel / notes / date / Business-Personal toggle). On mobile this is an ocean.
- **`📷 Scan`** emoji in the form header (line 632) — Lucide migration miss. Should be `<Camera className="w-4 h-4" />`.
- **Detailed/Quick mode toggle** lives at the top-right of the form card — a hidden secret. Most users won't find it. Either pick a default and remove the toggle, or expose both modes as a `<TabPills>` row.
- **Personal/Business toggle at the bottom** — Sudip will hit it once, set it, forget it. It's noise in the form chrome. Move into "Advanced" disclosure.
- The **`Foreign currency` collapsible** (lines 864-944) is correctly hidden by default — that's good. Keep.
- The **right-column StatCards** repeat the same problem as /sales — they're recap, not action.

**Proposed new section order:**

```
0. PageHeader — title + one CTA: [Snap receipt] (Lucide Camera) as the only header action
1. <InboxBanner> — keep, this is the killer feature
2. <TabPills> One-time / Recurring (keep)
3. <ExpenseEntry> card, FULL WIDTH, mobile-first:
     • Category chip row (single row, scroll horizontally on mobile)
     • Amount + voice mic
     • Payment chip row
     • Notes + date
     • "More" disclosure → Vendor / FX / Personal-Business / Backdated warning
4. Inline KPI strip under the form (same quiet numeric line as /sales)
5. Recent Expenses list
```

**Specific cards to delete, merge, or relocate:**

- **DELETE** `DismissibleTip` "Snap, log, claim back" — the prominent `[Snap receipt]` header CTA + the InboxBanner together teach the workflow without a banner.
- **DELETE** the right-column StatCards block; replace with inline numeric strip.
- **DELETE** the Detailed/Quick mode toggle — pick Quick mode as default; everything Detailed mode adds goes into the "More" disclosure inside the Quick form. One form, progressive.
- **MOVE** Personal/Business toggle into the "More" disclosure.
- **MOVE** the `📷 Scan` chip in the form header to the page header as the primary CTA (replaces ReceiptCapture from the dashboard pattern, uses Lucide `Camera`).
- **DELETE** the first-time-setup green block (lines 591-600); roll its function into `FirstRunWizard` on the dashboard or trigger it inline as a `<SetupChecklist>` step inside the form.

---

## 3. Visual rhythm rules

Five rules to enforce across all three pages (and use as a polish PR checklist):

1. **One hero per page.** /dashboard's hero is `DailyBrief + MomsCountdown + AccountantHours` together. /sales's hero is the entry form. /expenses's hero is the entry form (with InboxBanner above as a single discovery aid). Nothing else gets `heavy` visual weight at the top.

2. **Banners are interrupts, not decoration.** A banner (DismissibleTip, SectionBanner, InboxBanner) renders only when it's actionable in the next 30 seconds. Tip-style "here's how this works" content moves into the form as inline placeholders / micro-copy, not banner cards.

3. **KPI cards live in one place per page, never two.** Either at the top as the hero (dashboard period strip) or as a quiet inline numeric strip under the entry form (sales, expenses). Never both. Never a 4-card grid AND a recap strip on the same page.

4. **Grids are 4-up on desktop, 2-up on tablet, single-column on mobile — full bleed.** No 3/5+2/5 splits. Either the form is the whole row or it's stacked. The current `lg:grid-cols-5` split is the single biggest mobile-feel problem on /sales and /expenses because the right column becomes "scroll past me" content on phones.

5. **Lucide icons only, gray-* tokens, no rainbow.** The expanded StatCard drill-down panels on /sales (green/blue/purple gradients, lines 583-682), the emoji `🧾` on dashboard receipts (line 2115), the emoji `📷 Scan` on /expenses (line 632), the gradient "Ask Agent" banner on /dashboard (line 2017) — all violations of the Phase 3 (task #119, #124) cleanup. Sweep these.

---

## 4. Cross-page consistency

Things that diverge across the three pages but shouldn't:

| Concern | /dashboard | /sales | /expenses | Fix |
|---|---|---|---|---|
| Date / period selector | `PERIODS` pills (today/week/month/last30) | No selector — uses `filterFrom/filterTo` query state | No selector — same as sales | Promote `PERIODS` pills into a shared `<DateRangePills>` primitive in `frontend/src/components/ui` and mount on all three. |
| Tip banner pattern | `DismissibleTip` "welcomeDashboard" mid-page | `DismissibleTip` "Three ways to log a sale" at top | `DismissibleTip` "Snap, log, claim back" at top | Pick one rule: tips only appear on first-empty-state, never on populated accounts. |
| Inbox / receipt-forwarding | Not surfaced | Not surfaced | `InboxBanner` prominent | The forward-to-inbox alias should also be discoverable from /sales (some receipts are sales receipts). Either mount `InboxBanner` on /sales too, or move it once into `MorePage` and keep a single chip on both. |
| Camera / receipt scan | `ReceiptCapture` in header (good, Lucide-ish) | `ReceiptCapture` next to `+ Item sale` (good) | Purple emoji `📷 Scan` inside form (inconsistent + emoji) | Standardize: header-level `[Snap receipt]` button using Lucide `<Camera/>`, same chrome on all three pages. |
| Entry form layout | (no entry form on dashboard — uses modals) | `lg:grid-cols-5` (form 3 + KPI 2) | `lg:grid-cols-5` (form 3 + KPI 2) | Both pages → full-width form, inline KPI strip below. Same shape. |
| StatCard chrome | `<KpiCard>` custom (rounded-xl, gray-200) | `<StatCard>` primitive | `<StatCard>` primitive | Either lift the dashboard KPI cards to `<StatCard>` or convert all to `<KpiCard>`. Currently dashboard has sparklines + change %, others don't — that's a real asymmetry. |
| Empty-state KPI strip | N/A | Renders zeros in 4 cards | Renders zeros in 4 cards | Empty states show one helpful sentence ("No sales yet — tap a quick amount to start"), not four zeroed cards. |
| Bilagsnummer chip | N/A | Yes, on each sale row | Yes, on each expense row | Good — keep. |

---

## 5. The 30-min PR

**Ship the dashboard pre-KPI banner stack collapse.**

Specifically: introduce a single `<PriorityLane>` component at the top of `DashboardPage.jsx` that owns the 18+ conditional banners. Show **at most 2 expanded cards + a "n more updates" chevron**. Priority order:

1. `TrialFinalStretchTip` (commercial urgency)
2. `MonthEndBundleBanner` (compliance urgency)
3. `FirstRunWizard` (new-user blocker)
4. `MonthEndBundleBanner` → `AnomalyAlertsCard` → `ExpiryAlertsCard` → `MomsCountdownCard` → `AccountantHoursWidget` → rest

Below the lane, the dashboard goes straight to the hero strip (DailyBrief + MomsCountdown + AccountantHours) → period pills → KPI tiles.

Why this is the highest-leverage 30 minutes: it's the single change that delivers the most "less cluttered" perception with the least code change. No new endpoints. No removed features. No tier-gate changes. No revisor-grade artifact touching. Just a wrapper component + reordering existing JSX in `DashboardPage.jsx` between lines 1781-1899. Sudip's dashboard goes from "scroll past 7 cards to find your numbers" to "open page, see numbers, see one alert if any."

**Concrete diff scope:**
- New file: `frontend/src/components/PriorityLane.jsx` (~80 LOC)
- Edit: `DashboardPage.jsx` lines 1781-1899 → wrap in `<PriorityLane>{...children}</PriorityLane>`
- Edit: `useLanguage.jsx` — add `priorityLane.moreUpdates` EN+DA key

---

## 6. Open questions for Manoj

1. **Is /sales meant for daily POS-style entry (Sudip logs sales as they happen at the event) or weekly bookkeeping (Sudip logs the whole event in one go after Sunday night)?** The current shape tries to be both — quick-amount chips suggest POS, the date picker + backdate warning suggest bookkeeping. Pick one as primary.
2. **Should `/expenses` be the canonical home for the InboxBanner, or should it live in a global hub (sidebar chip, `/connections`) and be referenced from both /sales and /expenses?** Forwarded receipts can be either — the current "expenses-only" placement is hiding it from half its use cases.
3. **For the café-operator cards on the dashboard (`SickCallNotificationCard`, `SwapRequestNotificationCard`, `ScheduleConfirmationCard`, `BranchSummaryCard`) — are these always-on for everyone, or should they auto-hide for "event-organizer" personas the same way they already auto-hide for empty data?** A persona flag on the profile would let the dashboard drop ~5 banners for Sudip.
4. **The four-card KPI row on /dashboard (Today / Yesterday / Week / Best Day) versus the two-card period-aware row on /sales — is the dashboard supposed to be the canonical KPI surface, or are KPIs intentionally duplicated on every page?** If duplicated for a reason (someone might land on /sales as their home), say so; if not, /sales/expenses can drop the KPI strip entirely.
5. **For event-organizer customers like Sudip, should /sales auto-default the event filter to "this weekend's event" when one exists, instead of "All events"?** It's the single biggest workflow win for his persona but a behavior change for café users who have no events.

---

## Files I'd modify for the v1 of these changes

If Manoj approves the directions above, the first PR touches these 4-5 files:

1. **`frontend/src/pages/DashboardPage.jsx`** — banner-stack collapse (lines 1781-1899), drop "welcomeDashboard" tip, drop gradient Ask-Agent banner (line 2012-2026), drop emoji 🧾 fallback (line 2115), merge `WeekComparisonCard` + `HealthScore` + `GoalTracker` into one card, merge `PaymentBreakdownCard` + `ExpenseBreakdown` into one.
2. **`frontend/src/components/PriorityLane.jsx`** — NEW, wraps the dashboard banner stack with priority + collapse.
3. **`frontend/src/pages/SalesPage.jsx`** — drop `DismissibleTip` (lines 379-389), drop event-filter raw `<label>`+`<select>` (lines 344-377) into a new shared `<SegmentedRow>`, drop expanded rainbow detail panels (lines 583-682), drop right-column StatCards in favor of inline numeric strip, move `CsvUpload` (line 721) into table header.
4. **`frontend/src/pages/ExpensesPage.jsx`** — drop `DismissibleTip` (lines 572-581), promote Snap to header (drop emoji line 632), pick Quick mode as default and remove Detailed/Quick toggle (lines 635-648), drop right-column StatCards, move Personal/Business toggle into "More" disclosure (lines 985-1002).
5. **`frontend/src/components/ui/DateRangePills.jsx`** + **`frontend/src/components/ui/SegmentedRow.jsx`** — NEW shared primitives so the three pages stop diverging on filter chrome.

Plus i18n keys in **`frontend/src/hooks/useLanguage.jsx`** for any new copy (`priorityLane.moreUpdates`, `segmented.event`, `segmented.status`, etc.) in EN + DA.

---

## Honest answer to "is it actually cluttered?"

**Yes — but for one specific reason that's fixable in a single PR.** The clutter is overwhelmingly localized to **the pre-KPI banner stack on /dashboard** (21 conditional surfaces) and the **mirrored form/KPI split on /sales + /expenses** that competes with the entry form on mobile. The rest of the app — the actual cards, the bilagsnummer chips, the InboxBanner, the FX panel, the Smart Scan flow — is well-designed and well-restrained. Don't gut the dashboard's content; just give it a priority lane and remove the three tip banners. That alone should resolve 80% of the "cluttered and not seamless" feeling.
