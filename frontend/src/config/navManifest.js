/**
 * navManifest.js — the SINGLE source of truth for every owner-facing
 * navigation destination in BonBox.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this file, the same destinations were hand-listed in FOUR places
 * that drifted apart:
 *   • Layout.jsx        — the desktop grouped sidebar (`navGroups`)
 *   • MorePage.jsx      — the mobile "More" grid (`sections`)
 *   • MobileBottomNav   — the 5-tab bottom bar (`getTabsForType`)
 *   • GlobalSearchModal — the ⌘K command-palette page list (`PAGES`)
 * Drift meant a page could be reachable from the sidebar but missing from
 * More / search, gated one way on desktop and another on mobile (the
 * wine-list `requiresModule` vs `visibleFor` split), or surfaced with a
 * different icon per device. This manifest collapses all of that into one
 * array; each surface filters + projects the same data.
 *
 * THE FOUR ORTHOGONAL VISIBILITY AXES (architecture_pillar_visibility.md)
 * -----------------------------------------------------------------------
 *   1. RELEVANCE  — per-account pillar toggles (`hiddenPillars`). Free,
 *      owner-controlled. A destination with `pillar: 'reservations'` is
 *      hidden from chrome when that pillar is toggled OFF. `pillar: null`
 *      means "spine" — always relevant, never pillar-hideable.
 *      This axis IS WIRED (C9): usePillars feeds the real `users.hidden_pillars`
 *      OFF-list into ctx.hiddenPillars at Layout / MorePage / ResumeRow. ⌘K
 *      deliberately passes an EMPTY set so an OFF pillar stays findable as an
 *      enable-action (C10) rather than vanishing.
 *   2. ENTITLEMENT — PLAN_FEATURES tier locks (`requiresFeature`). These
 *      stay VISIBLE-BUT-LOCKED (the UpgradeNudge conversion funnel). They
 *      are NEVER hidden by filterDestinations — instead each entry is
 *      flagged `locked: true` and the surface renders the lock treatment.
 *      (The lone exception is App-Store native compliance, handled by the
 *      caller, not here — see Layout's isNativeApp() branch.)
 *   3. BUSINESS TYPE — `visibleFor` hides truly irrelevant surfaces
 *      (a workshop board has no place in a retail-only sidebar) and
 *      `requiresModule` / `requiresAnyModule` hide opted-out verticals
 *      (Bar / Wine / Workshop). These are HARD hides — wrong-product-fit
 *      signal, not a conversion funnel.
 *   4. ACTIVATION — activation-gated disclosure (CONSERVATIVE v1). A pillar's
 *      destination is hidden ONLY when it is DORMANT: relevant to this
 *      business type, never used (no real usage row — see useActivation), not
 *      owner-hidden, not tier-locked, AND the account is in the gateable
 *      NEW-account cohort (`isInScope`) with the feature flag on
 *      (`activationEnabled`). A dormant pillar drops out of the dense nav and
 *      re-surfaces as a one-tap "Sæt op" tile (PillarDiscovery) + stays
 *      findable in ⌘K. It AUTO-GRADUATES back the moment its usage row exists.
 *      LOCKED WINS over ACTIVATION — a `requiresFeature`-missing entry is
 *      pushed locked:true and is NEVER activation-hidden (Reservations stays
 *      visible-but-locked even when dormant). When activationEnabled=false OR
 *      isInScope=false, this axis is a NO-OP → IDENTICAL to today's nav (the
 *      established-owner firewall) — with the ONE exception below.
 *
 *      THE EXCEPTION — the USAGE GATE (`ctx.usageDormant`). Events is not one
 *      of the six jobs BonBox focuses on, and exactly one production account
 *      has ever created an Event row. So the USAGE_GATED_PILLARS below are
 *      hidden for EVERY owner (not just the new-account cohort, not behind the
 *      activation flag) until a real usage row exists — see useActivation's
 *      usageDormantPillars. Unlike ACTIVATION, LOCKED does NOT win here: a
 *      usage-dormant pillar is a feature we are not selling, so leaving it as
 *      a tier-locked upgrade funnel would be dishonest. It re-appears the
 *      moment the owner creates their first row (EventsPage dispatches
 *      'bonbox-data-changed' on create) and stays findable in ⌘K, which never
 *      passes the gate.
 *
 * Hide (axes 1, 3, 4) and locked (axis 2) are different outcomes and must
 * never be conflated. filterDestinations returns the kept items with a
 * `locked` boolean already resolved; it never drops a tier-locked entry.
 *
 * FIELD CONTRACT
 * --------------
 *   to            route path (string) — also the stable key.
 *   icon          Lucide icon NAME (string). Every consumer renders via the
 *                 <Icon name="…"> registry (components/ui/Icon.jsx), so a
 *                 string is correct for sidebar, More, bottom-nav AND the
 *                 ⌘K palette. Add new names to the Icon registry, not here.
 *   labelKey      i18n key resolved by t(). Must have a real EN + DA entry.
 *   group         sidebar group id ('core'|'money'|'stock'|'staff'|
 *                 'reports'|'workshop'|'manage'). Drives the desktop sidebar
 *                 grouping + the More-page section. The core group has no
 *                 header (flat list at the top of the sidebar). (The 'intel'
 *                 group was removed in C7 — its Insights survivor lives in
 *                 'reports'.)
 *   pillar        'reservations'|'events'|'inventory'|'staff'|'insights' or
 *                 null (= spine, always relevant). RELEVANCE axis only.
 *   requiresModule        single vertical-module id that must be enabled.
 *   requiresAnyModule     array — at least one must be enabled.
 *   requiresFeature       PLAN_FEATURES flag — locked-but-visible if absent.
 *   visibleFor    array of business_types that may see this, or null = all.
 *   frequency     'daily'|'weekly'|'rare' — usage cadence hint (ordering /
 *                 future bottom-nav promotion logic).
 *   surfaces      subset of ['sidebar','more','search','bottomnav'] — which
 *                 chrome this destination appears on. A surface filters the
 *                 manifest to its own subset before rendering.
 *   surfacesByArchetype  optional { [archetypeId]: surfaces[] } override —
 *                 REPLACES `surfaces` for owners of that archetype only.
 *                 Resolve it with surfacesFor() / isOnSurface(), never by
 *                 reading `.surfaces` directly. See the C12b note below.
 *   aliases       (search only) extra substrings ⌘K matches against.
 *   dynamic       (sidebar only) label comes from vatTerms, not labelKey.
 *
 * SCOPE: owner-facing destinations ONLY. The personal-mode nav, the
 * accountant read-only nav, and the super_admin Platform group are
 * deliberately NOT manifest-driven — they live in their own surfaces and
 * stay decoupled (accountant nav is a security-adjacent allowlist).
 *
 * C12b — THE ARCHETYPE-AWARE SIDEBAR (Sep 2026, founder call)
 * ----------------------------------------------------------
 * C12 proved the `surfaces` lever: dropping 'sidebar' from a rare destination
 * is a pure subtraction, because 'more' + 'search' keep it one tap away and
 * the route/page/data are untouched. C12b extends the same lever ONE axis:
 * some rows are rare for a restaurant and routine for a bookkeeper-ish
 * services owner, so "rare" is per-ARCHETYPE, not global.
 *
 * `surfacesByArchetype` is that axis. It is deliberately NOT a fifth
 * visibility axis in filterDestinations(): the four axes answer "may this
 * owner have this destination at all", and the answer here is always YES —
 * only the CHROME placement changes. Keeping it in the surface-narrowing step
 * is what makes it impossible for this field to hide a page from ⌘K.
 */

/**
 * C12b — the food_service / bar sidebar diet (founder call, Sep 2026).
 *
 * A DK restaurant or bar owner does not invoice (they take the money at the
 * table), does not keep a CRM, runs one location, and picks their modules once
 * during onboarding. Those four rows were ~17% of the densest sidebar we ship
 * and none of them is a daily job. They move to More (PHONE) and to search /
 * ⌘K (EVERY width) — the exact C12 trade: one extra tap for a rare
 * destination, four fewer rows to read past for the ones that ARE daily.
 *
 * Be precise about that, because the two halves are not equally reachable.
 * The only link to /more in the app is MobileBottomNav's tile, and that bar is
 * `md:hidden` — so on DESKTOP, where a daily close is actually done, these four
 * are reachable through the sidebar's search button (Layout.jsx, not
 * breakpoint-gated) or ⌘K, and not through a visible nav row. That is a
 * deliberate narrowing of discoverability, not a dead end; if it turns out to
 * be too narrow, the fix is one more NAV_MANIFEST entry pointing at /more,
 * which is already a real route.
 *
 * NOTHING IS DELETED: the route, the page, the data, the aliases and the More
 * tile are all untouched, and every other archetype (retail, salon, services,
 * generic, personal) keeps these rows in the sidebar exactly as today.
 *
 * REVERT: delete this constant and the four `surfacesByArchetype:` lines that
 * reference it. The sidebar is back to what shipped before, byte for byte.
 */
const OFF_SIDEBAR_FOR_HOSPITALITY = {
  food_service: ["more", "search"],
  bar: ["more", "search"],
};

export const NAV_MANIFEST = [
  // ─── CORE (spine — flat, headerless top of the sidebar) ───────────────
  {
    to: "/dashboard",
    icon: "Home",
    labelKey: "navHome",
    group: "core",
    pillar: null,
    frequency: "daily",
    surfaces: ["sidebar", "search", "bottomnav"],
    aliases: ["dashboard", "home", "overview"],
  },
  {
    to: "/sales",
    icon: "ShoppingBag",
    labelKey: "sales",
    group: "core",
    pillar: null,
    frequency: "daily",
    surfaces: ["sidebar", "search", "bottomnav"],
  },
  {
    // Directly after Sales on purpose: these are the two daily money-logging
    // jobs and both are frequency:"daily". This used to sit after Gavekort
    // (weekly), landing it as the 7th core row — below the fold in the phone
    // drawer, whose scrollbar is hidden under (pointer: coarse) so nothing
    // signals the list continues.
    to: "/expenses",
    icon: "Receipt",
    labelKey: "expenses",
    group: "core",
    pillar: null,
    frequency: "daily",
    // 'more' added: this was the ONLY frequency:"daily" destination declaring
    // neither `more` nor `bottomnav`, so on a phone Expenses existed in
    // exactly one place in the entire nav chrome. Every other daily
    // destination (dashboard, sales, daily-close, reservations, inventory)
    // carries at least one of the two.
    surfaces: ["sidebar", "more", "search"],
  },
  {
    // "Today" — the merged daily-close page (#150). C5 nav diet promotes it
    // from the Reports group to the top-level ungrouped (core) spine, right
    // after Sales — it's the daily ritual, not a once-a-period report.
    to: "/daily-close",
    icon: "Moon",
    labelKey: "navToday",
    group: "core",
    pillar: null,
    frequency: "daily",
    surfaces: ["sidebar", "more", "search", "bottomnav"],
    aliases: ["today", "daily close", "close", "end of day", "today's floor", "daily report", "floor", "ops"],
  },
  {
    to: "/events",
    icon: "CalendarDays",
    labelKey: "events",
    group: "core",
    pillar: "events",
    frequency: "weekly",
    // OFF THE SIDEBAR FOR EVERYONE (founder call, Sep 2026) — "events is still
    // not hidden", said twice. It was still on HIS rail because the usage gate
    // was working exactly as designed: his is the one production account with
    // Event rows (two May drafts), so `used.events === true`, dormantFromUsed()
    // drops events from usageDormantPillars, and filterDestinations correctly
    // KEEPS the row for him and for nobody else.
    //
    // So the gate is not the instrument. The gate answers "has this owner used
    // it"; the question here is "is this one of the six jobs the product sells"
    // (daily close · reservations · vagtplan · timer & løn · lager · penge) and
    // the answer is no, for every owner. `surfaces` is the lever that answers
    // scope — the same pure C12 subtraction used for Faktura / Kunder.
    //
    // NOTHING IS DELETED: the /events route, EventsPage, the existing rows, the
    // Funktioner (pillar) toggle, the usage gate and every alias below are all
    // untouched, and ⌘K keeps it one tap away.
    //
    // HOW AN OWNER GETS IT BACK: ⌘K / the sidebar search button → type
    // "arrangement", "billetter" or "events" (the aliases below) — that is the
    // route back for EVERY owner, and the only one for most of them. The More
    // tile is NOT a second route for a never-used account: MorePage threads the
    // same `usageDormant` Set as the sidebar, so an owner with no Event row has
    // no More tile either. More returns only once a real Event row exists (i.e.
    // for the founder today). HOW WE GIVE IT BACK: re-add "sidebar" to this
    // array — one word, and the rail is what it was.
    //
    // KNOWN, ACCEPTED: `surfaces` resolves BEFORE the usage gate, so a genuine
    // event_organizer (USAGE_GATE_EXEMPT_TYPES) loses the rail row too — they
    // resolve to the 'services' archetype, so surfacesByArchetype cannot
    // isolate them. Zero such accounts today; if one signs up the fix is a
    // business_type-keyed override, not a rollback of this line.
    surfaces: ["more", "search"],
    // USAGE-GATED (see USAGE_GATED_PILLARS): hidden from the REMAINING nav
    // chrome (More, the /modules list) until the owner has a real Event row.
    // ⌘K deliberately does NOT pass the usage gate, so these aliases are the
    // ONLY way back in for an owner who wants Events before they've used it —
    // the DA singular/plural forms and "billet" matter because a Dane types
    // "billetter", not "tickets".
    aliases: [
      "events", "tickets", "arrangement", "arrangementer",
      "billet", "billetter", "event",
    ],
  },
  {
    // Reservations — an ALL-TIER, usage-capped feature. billing.py sets the
    // `reservations` flag ON for every plan ("the cap creates the upgrade
    // moment, NOT a sidebar lock"): Free is cap-gated to 20 bookings/mo + 3
    // tables, Starter+ is unlimited. So NO requiresFeature here — the page +
    // the server cap do the limiting; we never tier-lock the sidebar item.
    // C5: also a 'bottomnav' surface so MobileBottomNav can resolve its
    // icon/label when it claims the contextual 4th slot for restaurant /
    // cafe / bar branches (see getTabsForType).
    to: "/reservations",
    icon: "CalendarCheck",
    labelKey: "reservations",
    group: "core",
    pillar: "reservations",
    frequency: "daily",
    surfaces: ["sidebar", "more", "search", "bottomnav"],
    aliases: ["reservations", "booking", "table", "bordbestilling"],
  },
  {
    // JOB 3 — Vagtplan. PROMOTED from the 'staff' group into the core spine
    // (founder call, Sep 2026: "making those 6 jobs priority"). Same row, same
    // label, same icon, same route — it just stops living behind a PERSONALE
    // header and joins the block an owner already stares at. `pillar: "staff"`
    // is untouched, which is what makes it drop honestly for an owner (or an
    // archetype) with no staff pillar rather than leaving an empty header.
    to: "/staff/schedule",
    icon: "Calendar",
    labelKey: "staffSchedule",
    group: "core",
    pillar: "staff",
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search", "bottomnav"],
    // C7: weather + staffing forecasts now live in the collapsed forecast
    // panel ON this page, so Cmd-K "weather" / "staffing" / "vejr" /
    // "bemanding" lands here (their old /weather, /staffing routes redirect
    // here too).
    aliases: [
      "schedule", "vagtplan", "rota",
      "weather", "vejr", "forecast",
      "staffing", "smart staffing", "bemanding", "bemandings-prognose",
    ],
  },
  {
    // JOB 4 — Timer & løn. PROMOTED from the 'staff' group (see above).
    //
    // C12 Bucket B (Staff back-office MERGE): /staff/hours is the single Staff
    // back-office row — a tabbed hub (Timer · Tidsregistrering · Drikkepenge ·
    // Løn). The former /staff/time-registration, /staff/tips and /staff/payroll
    // rows are GONE from the manifest; their routes redirect into the matching
    // tab (App.jsx) and their aliases are folded here so ⌘K still finds every
    // tab. Label is "Timer & løn" (staffBackOffice) — the clearest one-line
    // name for "settle the staff numbers". Reversible: split the rows back out
    // + re-add their routes.
    to: "/staff/hours",
    icon: "Timer",
    labelKey: "staffBackOffice",
    group: "core",
    pillar: "staff",
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    aliases: [
      "hours", "timer",
      // time-registration tab (was /staff/time-registration)
      "time registration", "tidsregistrering", "stempling", "clock in", "clock out",
      // tips tab (was /staff/tips)
      "tips", "drikkepenge",
      // payroll tab (was /staff/payroll)
      "payroll", "løn", "lønseddel", "lønkørsel",
    ],
  },
  {
    // JOB 5 — Lager. PROMOTED from the 'stock' group; /bar, /wine-list,
    // /expiry and /waste stay behind the LAGER header, which still renders.
    // This is the row an owner means by "stock": the count + the spend loop.
    to: "/inventory",
    icon: "Package",
    labelKey: "inventory",
    group: "core",
    pillar: "inventory",
    // Corrected from "daily" in the same hunk that re-homes this row. It was
    // wrong on both counts it could be checked against: NAV_GROUPS' own comment
    // calls Stock "a monthly-ritual tracker", and the locked inventory
    // north-star is snap-the-kvittering daily but optælling MONTHLY. The field
    // is documentation today (nothing in frontend/src reads it) — repaired here
    // so it can be trusted the first time something does.
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search", "bottomnav"],
  },

  // ─── MONEY ────────────────────────────────────────────────────────────
  {
    // Gavekort (gift cards) — an ALL-TIER, usage-capped feature. billing.py
    // sets the `gavekort` flag ON for every plan; the tier lever is the numeric
    // gavekort_active_max cap, NOT a sidebar lock. So NO requiresFeature — the
    // cap does the limiting. Owner pillar (relevance-hideable). On More + ⌘K so
    // it stays findable even when the pillar is toggled off.
    //
    // DEMOTED from the core spine into MONEY (Sep 2026) — the one row that
    // moves DOWN in this change. A gavekort IS a money instrument (job 6), and
    // keeping it on the spine would have made the promoted block spine + six +
    // one, which is exactly the "miscellaneous list" the promotion is meant to
    // end. Placed FIRST in MONEY: it is the only customer-facing row here, the
    // other three are back-office reconciliation. A group with no stored choice
    // defaults OPEN (config/navChrome.js), and More + ⌘K are unchanged.
    to: "/gavekort",
    icon: "Gift",
    labelKey: "gavekort",
    group: "money",
    pillar: "gavekort",
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    aliases: ["gavekort", "gift card", "giftcard", "voucher", "gift"],
  },
  {
    to: "/cashbook",
    icon: "BookOpen",
    labelKey: "cashBook",
    group: "money",
    pillar: null,
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
  },
  {
    to: "/cashflow",
    icon: "LineChart",
    labelKey: "cashFlow",
    group: "money",
    pillar: null,
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search", "bottomnav"],
    // App.jsx already wraps this route in OwnerOnlyRoute and the server denies
    // /api/cashflow to every staff seat — but the nav row was ungated, so a
    // cashier got "Cash Flow" in their BOTTOM NAV and was bounced on tap. The
    // route guard stops the leak; this stops the dead door.
    ownerOnly: true,
  },
  {
    to: "/budgets",
    icon: "Target",
    labelKey: "budgetOverview",
    group: "money",
    pillar: null,
    frequency: "rare",
    // C12 declutter: rare; already on More + ⌘K, so dropping "sidebar" is a
    // pure subtraction with zero reach loss. Reversible by re-adding "sidebar".
    surfaces: ["more", "search"],
    aliases: ["budget", "budgets"],
  },
  {
    // Imports — C5 merge of the old /bank-import + /payment-imports into one
    // destination (a TabPills wrapper: Bank · Payments). The legacy paths
    // still resolve (App.jsx redirects them into the right tab) and ⌘K still
    // matches "bank import" / "payment imports" via aliases.
    to: "/imports",
    icon: "Landmark",
    labelKey: "imports",
    group: "money",
    pillar: null,
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    // Reconciling the owner's bank statement against sales is owner work, and
    // the server agrees twice over: /api/bank-import is member-denied on read,
    // and the member write-guard 403s the preview/confirm POSTs this page runs.
    // Ungated it was a door that opened onto a 403.
    ownerOnly: true,
    aliases: ["imports", "bank import", "payment imports", "csv", "mobilepay", "bankimport", "betalingsimport"],
  },
  {
    // Khata = customer credit ledger (informal running "tab"). It's a
    // South-Asian retail convention, NOT part of the Denmark-first product —
    // a DK business doesn't run a khata. HIDDEN for now (Manoj, 2026-06-28):
    // `surfaces: []` removes it from the sidebar, More, and ⌘K everywhere.
    // FULLY REVERSIBLE — the /khata route, the KhataPage, the backend, and any
    // existing data are all untouched; restore visibility by putting the
    // surfaces back (["sidebar","more","search"]). If a non-DK market ever
    // needs it, also drop `personal`/add the right archetypes below.
    to: "/khata",
    icon: "BookText",
    labelKey: "khata",
    group: "money",
    pillar: null,
    frequency: "weekly",
    surfaces: [],
    hideForArchetypes: ["food_service", "bar", "salon", "personal"],
  },
  {
    // Faktura — Starter-tier; page renders its own UpgradeNudge for Free.
    to: "/faktura",
    icon: "FileText",
    labelKey: "faktura",
    group: "money",
    pillar: null,
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    // C12b: a restaurant/bar takes the money at the table — it never sends a
    // faktura. Off their sidebar, still on More + ⌘K.
    surfacesByArchetype: OFF_SIDEBAR_FOR_HOSPITALITY,
    aliases: ["faktura", "invoice", "invoicing"],
  },
  {
    to: "/customers",
    icon: "Users",
    labelKey: "customers",
    group: "money",
    pillar: null,
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    // C12b: a named-customer ledger is B2B work. Hospitality guests arrive as
    // reservations, not as CRM rows. Off their sidebar, still on More + ⌘K.
    surfacesByArchetype: OFF_SIDEBAR_FOR_HOSPITALITY,
  },
  {
    to: "/mileage",
    icon: "Car",
    labelKey: "mileage",
    group: "money",
    pillar: null,
    frequency: "rare",
    // C12 declutter: rare once-a-year kørselsfradrag entry — off the daily
    // sidebar, into More + ⌘K (this GAINS reach: it was sidebar-only before).
    // Reversible by re-adding "sidebar".
    surfaces: ["more", "search"],
    aliases: ["km", "kørsel", "kørselsfradrag", "mileage"],
  },

  // ─── STOCK ──────────────────────────────────────────────────────────
  // (/inventory — job 5 — was promoted to the core spine in Sep 2026. The rows
  // below are the stock DETAIL and keep the LAGER header.)
  {
    // Bar Pour — gated on the bar_pour vertical module.
    to: "/bar",
    icon: "Martini",
    labelKey: "bar",
    group: "stock",
    pillar: "inventory",
    requiresModule: "bar_pour",
    frequency: "daily",
    surfaces: ["sidebar"],
  },
  {
    // Wine list — STRICTER UNION GATE (panel-flagged drift fix). Both the
    // wine_sommelier module AND a wine-friendly business_type must hold.
    // Previously Layout gated only on requiresModule and MorePage only on
    // visibleFor — a wine bar saw it on one surface and not the other.
    to: "/wine-list",
    icon: "Wine",
    labelKey: "wineList",
    group: "stock",
    pillar: "inventory",
    requiresModule: "wine_sommelier",
    visibleFor: ["restaurant", "bar", "cafe", "hotel", "general"],
    frequency: "weekly",
    surfaces: ["sidebar", "more"],
    aliases: ["wine", "sommelier", "vin"],
  },
  {
    to: "/expiry",
    icon: "AlarmClock",
    labelKey: "expiryForecasting",
    group: "stock",
    pillar: "inventory",
    visibleFor: ["restaurant", "retail", "general"],
    // Root-cause rule: resolve through the archetype so every retail sibling
    // (grocery / veggie_shop / flower_shop / pharmacy / … — the MOST perishable
    // shops) gets Expiry, not just the raw `retail` token. See passesType().
    visibleForArchetypes: ["retail"],
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    aliases: ["expiry", "expiring", "udløb"],
  },
  {
    to: "/waste",
    icon: "Trash2",
    labelKey: "wasteTracker",
    group: "stock",
    pillar: "inventory",
    visibleFor: ["restaurant", "retail", "general"],
    // Archetype-aware (see /expiry) — every retail sibling gets Waste too.
    visibleForArchetypes: ["retail"],
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    aliases: ["waste", "spild"],
  },

  // ─── REPORTS & MOMS ─────────────────────────────────────────────────
  // ("Today" / daily-close moved to the core spine in C5 — see above.)
  {
    to: "/reports",
    icon: "ClipboardList",
    labelKey: "navReportsTax",
    group: "reports",
    pillar: null,
    // Owner-only: the Reports & MOMS surface exposes the owner's SKAT liability
    // (moms_til_skat / vat_payable). Hidden from invited STAFF members
    // (manager/cashier/viewer) — the accountant grant keeps it (revisor read).
    // Mirrors the backend member_read_guard deny of /api/reports.
    ownerOnly: true,
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    aliases: ["reports", "tax", "books"],
  },
  {
    // Multi-terminal close — Pro entitlement; locked-but-visible.
    to: "/daily-close/multi",
    icon: "Store",
    labelKey: "multiClose",
    group: "reports",
    pillar: null,
    requiresFeature: "multi_terminal_close",
    frequency: "rare",
    surfaces: ["sidebar"],
  },
  {
    to: "/tax",
    icon: "Calculator",
    labelKey: "taxAutopilot",
    group: "reports",
    pillar: null,
    // Owner-only: Tax Autopilot IS the owner's SKAT filing. Backend
    // member_read_guard already 403s /api/tax for staff members, so hiding the
    // nav keeps a manager from clicking into a page that would just fail.
    ownerOnly: true,
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    aliases: ["tax", "moms", "vat", "skat"],
  },
  {
    to: "/bookkeeping-export",
    icon: "Send",
    labelKey: "sendToAccountant",
    group: "reports",
    pillar: null,
    frequency: "weekly",
    surfaces: ["sidebar", "more"],
    aliases: ["accountant", "revisor", "export", "bookkeeping"],
  },

  // ─── STAFF ──────────────────────────────────────────────────────────
  // EMPTY BY DESIGN (Sep 2026). Both staff rows — Vagtplan (job 3) and
  // Timer & løn (job 4) — were promoted into the core spine, so no destination
  // declares group:"staff" today and the PERSONALE header stops rendering
  // (Layout.jsx drops a group once its items filter out). The NAV_GROUPS entry
  // is deliberately KEPT as the landing spot if a third staff row (fravær /
  // availability) ever returns; see the note there.

  // ─── INTELLIGENCE ──────────────────────────────────────────────────
  // C7 Intelligence collapse: the six-entry Intelligence cluster is gone.
  // ONE "Insights" destination remains — the InsightsHub at /insights with
  // tabs (AI Insights · Priser & marked · Gæster). The `intel` group header
  // was removed from NAV_GROUPS too, so Insights now lives in the
  // "Reports & MOMS" group (group:'reports') — it reads as the analytical
  // surface alongside Reports / Tax. Where the old entries now resolve:
  //   • pricing + competitors  → /insights?tab=pricing  (App.jsx redirects)
  //   • retention              → /insights?tab=guests   (App.jsx redirects)
  //   • weather + staffing     → /staff/schedule forecast panel (redirects)
  // Cmd-K reach for the old names is preserved via the union of aliases
  // here (pricing/market/competitors/retention/guests) + weather/staffing
  // aliases added to the /staff/schedule entry. Still visibleFor data-rich
  // business types (the legacy Intelligence-group gate).
  {
    to: "/insights",
    icon: "Sparkles",
    labelKey: "insightsHubTitle",
    group: "reports",
    pillar: "insights",
    visibleFor: ["restaurant", "retail", "service", "general"],
    // Archetype-aware (see /expiry) — every retail sibling gets Insights too.
    visibleForArchetypes: ["retail"],
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    aliases: [
      "insights", "ai", "patterns", "indsigt",
      // pricing + market (now /insights?tab=pricing)
      "pricing", "price", "priser", "marked", "market",
      "competitors", "competitor", "konkurrent", "konkurrentscan",
      // retention / guests (now /insights?tab=guests)
      "retention", "churn", "loyalty", "guests", "gæster", "kundefastholdelse",
    ],
  },

  // ─── WORKSHOP (vertical) ───────────────────────────────────────────
  {
    to: "/workshop",
    icon: "Wrench",
    labelKey: "workshop",
    group: "workshop",
    pillar: null,
    visibleFor: ["workshop"],
    requiresModule: "workshop",
    frequency: "daily",
    // bottomnav: the per-business-type 4th tab for workshop branches
    // resolves its icon/label from this entry (MobileBottomNav).
    surfaces: ["sidebar", "bottomnav"],
  },

  // ─── MANAGE ─────────────────────────────────────────────────────────
  {
    to: "/connections",
    icon: "Link2",
    labelKey: "navConnections",
    group: "manage",
    pillar: null,
    frequency: "rare",
    // C12 declutter: bank/MobilePay/integration setup is configured at
    // onboarding, rarely revisited. Off the sidebar, into More + ⌘K (aliases
    // bank/integrations keep it findable). Reversible by re-adding "sidebar".
    surfaces: ["more", "search"],
    aliases: ["connections", "integrations", "bank"],
  },
  {
    // C12 Bucket B (Locations MERGE): /branches is now the single Locations
    // row — a tabbed hub (Filialer · Sammenligning · Konsolideret). The former
    // /outlets and /consolidated-close rows are GONE from the manifest; their
    // routes redirect into the matching tab (App.jsx) and their aliases are
    // folded here so ⌘K still finds every tab. Single-location owners get a
    // friendly empty state on the multi-location tabs (LocationsPage).
    // Reversible: split the rows back out + re-add their routes.
    to: "/branches",
    icon: "Building2",
    // "Locations" not "Branches": an owner has locations, a bank has
    // branches. Both strings already exist in en + da; the `branches` string
    // itself stays put so the Filialer tab inside the hub keeps its name.
    labelKey: "locations",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar", "more", "search"],
    // C12b: the ICP is a 5-12 staff owner-operated single site. A Locations hub
    // that shows one location is chrome. Off their sidebar, still on More + ⌘K
    // — and an owner who opens a second site finds it there the same day.
    surfacesByArchetype: OFF_SIDEBAR_FOR_HOSPITALITY,
    aliases: [
      "branches", "filialer", "locations", "lokationer",
      // compare tab (was /outlets)
      "outlets", "sammenligning", "cross-outlet", "filialsammenligning",
      // consolidated tab (was /consolidated-close)
      "consolidated", "konsolideret", "consolidated close", "samlet lukning",
    ],
  },
  {
    to: "/terminals",
    icon: "Monitor",
    labelKey: "terminals",
    group: "manage",
    pillar: null,
    frequency: "rare",
    // C12 declutter: POS-terminal registry is set-once (also reached in the
    // close ritual + Connections). Off the sidebar, into More + ⌘K. The first
    // item to revert (re-add "sidebar") if owners miss it.
    surfaces: ["more", "search"],
    aliases: ["terminal", "kasseapparat", "pos"],
  },
  {
    to: "/channel-settings",
    // Wolt / Uber / Foodora reach the owner as APPS. The bicycle drew the
    // courier, which is not the thing being configured here.
    icon: "Smartphone",
    labelKey: "orderChannels",
    group: "manage",
    pillar: null,
    frequency: "rare",
    // C12 declutter: one-time Wolt/Uber channel setup — off the daily sidebar,
    // into More + ⌘K (GAINS reach: was sidebar-only). Reversible.
    surfaces: ["more", "search"],
    aliases: ["wolt", "uber", "channels", "kanaler", "ordrekanaler"],
  },
  {
    // Features & modules — the /modules opt-in picker.
    to: "/modules",
    icon: "LayoutGrid",
    labelKey: "modules",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar", "more", "search"],
    // C12b: modules are chosen once at onboarding and revisited almost never.
    // Off their sidebar, still on More + ⌘K. NOTE this row is also the way back
    // to a hidden pillar — PillarDiscovery pins that affordance to the bottom
    // of the nav independently, so the re-find path is not this row.
    surfacesByArchetype: OFF_SIDEBAR_FOR_HOSPITALITY,
    aliases: ["modules", "features"],
  },
  {
    to: "/share-recipients",
    icon: "Mail",
    labelKey: "shareRecipients",
    group: "manage",
    pillar: null,
    frequency: "rare",
    // C12 declutter: set-once (who receives the auto-emailed kasserapport) —
    // off the daily sidebar, into More + ⌘K (GAINS reach). Reversible.
    surfaces: ["more", "search"],
    aliases: ["recipients", "modtagere", "share"],
  },
  // C12 Bucket B (Locations MERGE): the former /outlets (Filialsammenligning)
  // and /consolidated-close (Samlet lukning) rows were REMOVED here — they are
  // now tabs of the /branches Locations hub. Their routes redirect into the
  // matching tab (App.jsx: /outlets → /branches?tab=compare, /consolidated-close
  // → /branches?tab=consolidated) and their aliases are folded onto the
  // /branches entry above so ⌘K still finds them.
  {
    to: "/team",
    icon: "UserCog",
    labelKey: "team",
    group: "manage",
    pillar: null,
    frequency: "rare",
    // C12 declutter: team/role setup is set-once — already on More + ⌘K, so
    // dropping "sidebar" is a pure subtraction with zero reach loss.
    // Reversible by re-adding "sidebar".
    surfaces: ["more", "search"],
  },
  {
    to: "/recently-deleted",
    icon: "Trash",
    labelKey: "recentlyDeleted",
    group: "manage",
    pillar: null,
    frequency: "rare",
    // C12 declutter: a recovery surface visited only when something's wrong —
    // off the daily sidebar, into More + ⌘K (this GAINS reach: it was
    // sidebar-only). MUST keep "more" (never search-only) so it's a tappable
    // safety net. Reversible by re-adding "sidebar".
    surfaces: ["more", "search"],
    aliases: ["deleted", "slettet", "papirkurv", "trash"],
  },
  {
    to: "/contact",
    icon: "MessageCircle",
    labelKey: "contact",
    group: "manage",
    pillar: null,
    frequency: "rare",
    // C12 declutter: support/contact is rare — off the daily sidebar, into
    // More + ⌘K (GAINS reach: it was sidebar-only). Reversible.
    surfaces: ["more", "search"],
    aliases: ["support", "kontakt", "hjælp", "help"],
  },
  {
    // Plan & billing — C5 folds the old one-item ACCOUNT group into the
    // rare SETTINGS group (manage). One settings home instead of two
    // bottom-of-sidebar groups.
    to: "/subscription",
    icon: "Sparkles",
    labelKey: "planBilling",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar", "more", "search"],
    aliases: ["subscription", "plan", "billing", "upgrade"],
  },
];

/**
 * PILLAR_RELEVANCE_BY_ARCHETYPE — which gateable pillars are RELEVANT to each
 * canonical archetype. The inverse of the backend onboarding-preset OFF-lists
 * (services/pillars.py `_PRESET_OFF_LISTS_BY_ARCHETYPE` + the exact-token
 * table): a pillar that the preset HIDES for an archetype is NOT relevant, so
 * — in the CONSERVATIVE activation scope — a dormant pillar that is also
 * IRRELEVANT must NOT produce a "Sæt op" tile (the existing relevance /
 * business-type gates already handle irrelevance; activation only governs
 * relevant-but-unused pillars).
 *
 * `insights` is always-on (never activation-gated), so it is never listed.
 * Only the four gateable pillars (inventory / reservations / events / staff)
 * appear. An archetype absent here, or a null archetypeId, FAILS OPEN — every
 * gateable pillar is treated as relevant (the conservative gate then only
 * hides a dormant pillar the owner could genuinely set up). Keep in sync with
 * the backend preset verdict (locked, June 2026):
 *   food_service → inventory, reservations, staff
 *   bar          → inventory, reservations, staff
 *   salon        → reservations, staff               (salons don't run an
 *                  inventory pillar by default)
 *   retail       → inventory, staff
 *   services     → staff                             (inventory/reservations
 *                  are not a default services pillar)
 *   generic/personal → all four (fail-open — never lose a setup affordance)
 *
 * `events` is absent from every list above. It USED to be "hidden by preset"
 * for these archetypes; since Sep 2026 the backend BUSINESS presets no longer
 * hide it (services/pillars.py) — the USAGE GATE hides it instead, for every
 * owner, until the first real Event row. Leaving it out here keeps it from
 * also becoming an activation "Sæt op" tile.
 */
export const PILLAR_RELEVANCE_BY_ARCHETYPE = {
  food_service: ["inventory", "reservations", "staff"],
  bar: ["inventory", "reservations", "staff"],
  salon: ["reservations", "staff"],
  retail: ["inventory", "staff"],
  services: ["staff"],
  // generic / personal deliberately omitted → fail-open (all relevant).
};

/**
 * USAGE_GATED_PILLARS — pillars hidden from the nav chrome for EVERY owner
 * until a real usage row exists (the "usage gate", Sep 2026).
 *
 * WHY THIS IS NOT THE ACTIVATION AXIS: activation is cohort-scoped (new
 * accounts only), flag-gated, and its dormant pillars re-surface as "Sæt op"
 * tiles — it is a DISCLOSURE ramp for features we do sell. The usage gate is
 * the opposite statement: BonBox focuses on six jobs and Events is not one of
 * them, so for an owner who has never created an Event the surface is not
 * "not yet set up", it is NOISE. It therefore applies to every owner, hides
 * the pillar from the discovery floor + the /modules toggle list as well, and
 * is NOT an upgrade funnel (a tier-locked entry is dropped too).
 *
 * REVERSIBLE + never a dead end: emptying this array restores the previous
 * nav exactly; the route, the page and the data are untouched; ⌘K never
 * passes the gate; and the pillar auto-returns on the owner's first real row.
 */
export const USAGE_GATED_PILLARS = ["events"];

/**
 * Business types the usage gate NEVER applies to — the vertical whose whole
 * business IS the gated pillar. `event_organizer` is the real token stored in
 * users.business_type (frontend config/archetypes.js BUSINESS_TYPE_TO_ARCHETYPE
 * + backend services/archetype.py; routers/onboarding.py maps the free-text
 * "event"/"arrangør"/"eventbureau" answers onto it). An event organizer sees
 * Events from minute one, before any row exists.
 */
export const USAGE_GATE_EXEMPT_TYPES = ["event_organizer"];

/**
 * surfacesFor(item, archetypeId)
 * ------------------------------
 * The surfaces this destination appears on FOR THIS OWNER. `surfaces` is the
 * default; a `surfacesByArchetype` entry REPLACES it for that archetype only
 * (C12b — see the module header). Pure; never throws; fails OPEN — an unknown
 * or null archetype, or a malformed override, falls back to `surfaces`, so a
 * bad archetype string can never blank a surface.
 *
 * @param {object} item — a NAV_MANIFEST entry
 * @param {string|null} archetypeId — resolved archetype (config/archetypes.js)
 * @returns {string[]} the surface list to test against
 */
export function surfacesFor(item, archetypeId = null) {
  const base = Array.isArray(item?.surfaces) ? item.surfaces : [];
  if (!archetypeId) return base;
  const override = item?.surfacesByArchetype?.[archetypeId];
  return Array.isArray(override) ? override : base;
}

/** Does this destination appear on `surface` for this owner? See surfacesFor. */
export function isOnSurface(item, surface, archetypeId = null) {
  return surfacesFor(item, archetypeId).includes(surface);
}

const _ACTIVATION_GATEABLE = ["inventory", "reservations", "events", "staff"];

/** The set of activation-gateable pillars RELEVANT to this archetype. Unknown
 *  / null archetype → all gateable pillars (fail-open). Pure, never throws. */
export function relevantPillarsForArchetype(archetypeId) {
  if (!archetypeId) return new Set(_ACTIVATION_GATEABLE);
  const list = PILLAR_RELEVANCE_BY_ARCHETYPE[archetypeId];
  if (!list) return new Set(_ACTIVATION_GATEABLE);
  return new Set(list);
}

/**
 * filterDestinations(items, ctx)
 * ------------------------------
 * Apply the FOUR visibility axes to a list of manifest entries and return
 * the survivors with a resolved `locked` flag. Pure + surface-agnostic — a
 * surface first narrows the manifest to its own `surfaces` subset, then
 * passes that slice here.
 *
 * ctx = {
 *   businessTypes : string[]                 active branch types (or all
 *                                            owned types when no branch)
 *   plan          : string                   (informational; gating is via
 *                                            hasFeature so the frontend can
 *                                            never out-grant the backend)
 *   hasFeature    : (flag) => boolean        PLAN_FEATURES check
 *   hiddenPillars : Set<string>              RELEVANCE axis (default empty)
 *   featReady     : boolean (default true)   while entitlements load, treat
 *                                            locked-but-visible items as
 *                                            UNLOCKED to avoid a lock-flicker
 *                                            (matches Layout's prior behavior)
 *   archetypeId   : string|null              resolved archetype (relevance)
 *   activatedPillars  : Set<string>          ACTIVATION axis — the owner's
 *                                            activated (real-usage) pillars
 *   isInScope     : boolean (default false)  true only for the gateable
 *                                            NEW-account cohort
 *   activationEnabled : boolean (default false)  feature-flag kill-switch
 *   usageDormant  : Set<string> (default empty)  USAGE GATE — pillars this
 *                                            owner has never used (see
 *                                            USAGE_GATED_PILLARS /
 *                                            useActivation.usageDormantPillars)
 * }
 *
 * Outcome per axis:
 *   • RELEVANCE  (hiddenPillars)            → HIDE (dropped from result)
 *   • BUSINESS   (visibleFor / module)      → HIDE (dropped from result)
 *   • ENTITLEMENT(requiresFeature missing)  → KEEP, `locked: true`
 *   • ACTIVATION (dormant + in-scope + on)  → HIDE (dropped) — but LOCKED WINS:
 *                                            a tier-locked entry is pushed
 *                                            locked:true and NEVER
 *                                            activation-hidden.
 *   • USAGE GATE (pillar ∈ usageDormant)    → HIDE (dropped) INCLUDING a
 *                                            tier-locked entry — a pillar we
 *                                            are not selling must not become
 *                                            an upgrade funnel.
 *
 * A tier-locked entry is NEVER dropped here — hiding it would unrender the
 * UpgradeNudge funnel. (Native App-Store compliance hiding is the caller's
 * job, not this function's.)
 */
/** STAFF members (manager/cashier/viewer) — invited employees who must not see
 *  the owner's financial/compliance surfaces. The OWNER and the read-only
 *  ACCOUNTANT grant are deliberately NOT staff (the revisor needs the reports).
 *  Single source of truth for the frontend ownerOnly gate + route guards. */
export const STAFF_MEMBER_ROLES = ["manager", "cashier", "viewer"];
export const isStaffMemberRole = (role) =>
  STAFF_MEMBER_ROLES.includes(String(role || "owner").toLowerCase());

export function filterDestinations(items, ctx = {}) {
  const {
    businessTypes,
    hasFeature,
    hiddenPillars,
    featReady = true,
    archetypeId,
    activatedPillars,
    isInScope = false,
    activationEnabled = false,
    isStaffMember = false,
    usageDormant,
  } = ctx;

  // OWNER-ONLY — an invited STAFF member (manager/cashier/viewer) never sees
  // the owner's financial/compliance surfaces (Reports & MOMS, Tax Autopilot).
  // The owner and the read-only accountant grant are NOT staff members, so they
  // keep full access. This is chrome-hiding only; the real boundary is the
  // backend member_read_guard (a member hitting /api/reports or /api/tax 403s
  // regardless of what nav renders).
  const passesOwnerOnly = (ownerOnly) => !ownerOnly || !isStaffMember;

  const types = Array.isArray(businessTypes) ? businessTypes : [];
  const hidden = hiddenPillars instanceof Set ? hiddenPillars : new Set();
  // Fail-closed default — an absent hasFeature (e.g. a test rendering a
  // surface without an EntitlementsProvider) treats every feature as
  // missing, mirroring the backend's fail-closed semantics.
  const hasFeat = typeof hasFeature === "function" ? hasFeature : () => false;

  // BUSINESS TYPE — null visibleFor = all; empty active types = don't gate
  // by type (fresh signup with no branch). Module gate still applies. An entry
  // may ALSO declare `visibleForArchetypes` (the root-cause rule): it then
  // passes when the resolved archetype matches, so every sibling token of that
  // archetype inherits the same visibility without re-listing each token.
  // Additive OR: an entry with neither field is visible to all; an archetype
  // match never REMOVES an entry a raw visibleFor already allowed, and an entry
  // without `visibleForArchetypes` behaves exactly as before.
  const passesType = (vf, vfa) => {
    if (!vf && (!vfa || !vfa.length)) return true;
    if (!types || types.length === 0) return true;
    if (vf && vf.some((tp) => types.includes(tp))) return true;
    if (vfa && vfa.length && archetypeId && vfa.includes(archetypeId)) return true;
    return false;
  };
  const passesModule = (req, reqAny) => {
    if (!req && !reqAny) return true;
    const enabled = ctx.enabledModules instanceof Set ? ctx.enabledModules : new Set();
    if (req && !enabled.has(req)) return false;
    if (reqAny && !reqAny.some((m) => enabled.has(m))) return false;
    return true;
  };
  // ENTITLEMENT — while loading, return true (treat as unlocked) so a
  // trial user never sees their Pro entries flash as locked.
  const passesFeature = (feat) => {
    if (!feat) return true;
    if (!featReady) return true;
    return hasFeat(feat);
  };
  // RELEVANCE — null pillar = spine (always relevant). A hidden pillar
  // drops the entry from chrome. WIRED (C9): real hiddenPillars threaded at
  // Layout / MorePage / ResumeRow; ⌘K passes an empty set to keep OFF pillars
  // findable as enable-actions.
  const passesPillar = (pillar) => {
    if (!pillar) return true;
    return !hidden.has(pillar);
  };
  // ARCHETYPE HIDE — an item may opt OUT of irrelevant archetypes via
  // `hideForArchetypes` (e.g. khata makes no sense for food_service / bar /
  // salon / personal). Additive + fail-open: an item without the field, or an
  // absent archetypeId, is never hidden. Orthogonal to visibleFor (a raw
  // business_type allow-list that's inert without branches); this gate is
  // archetype-resolved so it works for single-location owners with no branch.
  const passesArchetype = (hideFor) => {
    if (!hideFor || !hideFor.length) return true;
    if (!archetypeId) return true;
    return !hideFor.includes(archetypeId);
  };

  // ACTIVATION — a pillar's destination is HIDDEN (dropped) ONLY when ALL of:
  //   • activationEnabled (feature flag on), AND
  //   • isInScope (the gateable NEW-account cohort), AND
  //   • item.pillar is a real pillar (spine items have pillar:null → never), AND
  //   • the pillar is NOT activated (no real usage row), AND
  //   • the item is NOT owner-hidden (already dropped by passesPillar above), AND
  //   • the pillar is RELEVANT to this archetype (CONSERVATIVE — a dormant-
  //     IRRELEVANT pillar must NOT even produce a "Sæt op" tile; irrelevance is
  //     already handled by the relevance / business-type gates).
  // LOCKED WINS: this check is only reached for a NON-locked item (the
  // requiresFeature branch below returns before us), so a tier-locked entry is
  // NEVER activation-hidden — it stays visible-but-locked (Reservations dormant
  // on Free still shows the lock). When the flag is off OR the account is out of
  // scope, this returns true for EVERYTHING → IDENTICAL to today's nav, except
  // for the USAGE GATE above, which is deliberately cohort-wide and flag-free.
  // USAGE GATE — a pillar the owner has never used (USAGE_GATED_PILLARS,
  // resolved per-owner by useActivation). Default EMPTY, so every existing
  // caller that doesn't thread it (⌘K on purpose, any test) behaves exactly as
  // before. Unlike the four axes above this one also drops TIER-LOCKED items,
  // which is why the check sits before the requiresFeature branch below.
  const usageHidden = usageDormant instanceof Set ? usageDormant : new Set();
  const passesUsage = (pillar) => !pillar || !usageHidden.has(pillar);

  const activated = activatedPillars instanceof Set ? activatedPillars : null;
  const relevantSet = relevantPillarsForArchetype(archetypeId);
  const passesActivation = (pillar) => {
    if (!activationEnabled || !isInScope) return true; // firewall: today's nav
    if (!pillar) return true;                           // spine — never gated
    if (!relevantSet.has(pillar)) return true;          // irrelevant — not a tile
    if (!activated) return true;                        // fail-open (no Set yet)
    return activated.has(pillar);                       // hide only if dormant
  };

  const out = [];
  for (const item of items) {
    if (!passesOwnerOnly(item.ownerOnly)) continue;
    if (!passesPillar(item.pillar)) continue;
    if (!passesType(item.visibleFor, item.visibleForArchetypes)) continue;
    if (!passesArchetype(item.hideForArchetypes)) continue;
    if (!passesModule(item.requiresModule, item.requiresAnyModule)) continue;
    // USAGE GATE — BEFORE the entitlement branch on purpose: a usage-dormant
    // pillar is a feature we're not selling, so it must not survive as a
    // locked upgrade funnel the way an activation-dormant one does.
    if (!passesUsage(item.pillar)) continue;
    // ENTITLEMENT (locked-but-visible) takes precedence over ACTIVATION — a
    // requiresFeature-missing entry is pushed locked:true and is NEVER
    // activation-hidden (the LOCKED-WINS invariant).
    if (item.requiresFeature && !passesFeature(item.requiresFeature)) {
      out.push({ ...item, locked: true });
      continue;
    }
    // ACTIVATION — only non-locked, relevant, dormant, in-scope pillars drop.
    if (!passesActivation(item.pillar)) continue;
    out.push({ ...item, locked: false });
  }
  return out;
}

/**
 * PILLAR_DISPLAY — the RELEVANCE-axis catalog as DISPLAY metadata.
 *
 * The 5 owner pillars in a stable order, each with a Lucide icon NAME +
 * an i18n labelKey for a SHORT human label (the pillar's name, not a page
 * title). This is the single source of truth for "how do I name + draw a
 * pillar in chrome" — consumed by:
 *   • PillarDiscovery  (C10a) — the "Tilføj funktioner" re-find affordance
 *     (sidebar footer tile-strip + a More-page section) lists the OFF
 *     pillars as one-tap "Slå til" tiles.
 *   • ModulesPage      (C11)  — the new "Funktioner" toggle section.
 * (PillarGate keeps its OWN per-pillar title/body copy — that's interstitial
 * prose, a different register than these one-word chrome labels.)
 *
 * Order matches GET /api/pillars `available` and the onboarding presets so
 * the toggle list reads the same everywhere. `labelKey` resolves to a real
 * EN + DA entry in useLanguage.jsx (the pillarLabel* block).
 */
export const PILLAR_DISPLAY = [
  { id: "reservations", icon: "CalendarCheck", labelKey: "pillarLabelReservations" },
  { id: "events",       icon: "CalendarDays",  labelKey: "pillarLabelEvents" },
  { id: "inventory",    icon: "Package",       labelKey: "pillarLabelInventory" },
  { id: "staff",        icon: "UsersRound",    labelKey: "pillarLabelStaff" },
  { id: "insights",     icon: "Sparkles",      labelKey: "pillarLabelInsights" },
];

/** The canonical ordered list of the 5 pillar ids (RELEVANCE axis). */
export const PILLAR_IDS = PILLAR_DISPLAY.map((p) => p.id);

/** id → display metadata lookup (icon + labelKey). */
export const PILLAR_DISPLAY_BY_ID = PILLAR_DISPLAY.reduce((acc, p) => {
  acc[p.id] = p;
  return acc;
}, {});

/**
 * Convenience: the ordered list of sidebar group ids + their header
 * labelKey + icon. The 'core' group is headerless (flat list). Layout
 * builds its grouped structure from this + the manifest so the group
 * order / labels live in ONE place too.
 *
 * C5 nav diet (regroup): the order + labels here drive the sidebar.
 *   • core    — spine: + Today now lives here (after Sales), still headerless.
 *   • Money / Stock / Staff come first (the everyday operator groups).
 *   • reports group relabeled "Reports & MOMS" (navReportsMoms) — Today left
 *     it for the spine; it now holds Reports / Tax / Send-to-revisor + (C7)
 *     the Insights hub absorbed from the dissolved Intelligence group.
 *   • workshop stays a business-type-scoped vertical after that. (C7: the
 *     'intel' group is gone — see the NAV_GROUPS comment below.)
 *   • manage relabeled "Settings" (navSettings) and ABSORBS the old one-item
 *     ACCOUNT group (plan & billing) — one rare settings home at the bottom.
 *     The standalone `account` group is gone.
 */
export const NAV_GROUPS = [
  // THE SPINE — headerless, and the only group that may be. The core branch in
  // Layout emits its OWN closing hairline; a second headerless block would
  // stack two rules and read as the known rail-of-borders defect. It is also
  // the only group that is not collapsible: giving `core` a labelKey would
  // render a toggle, and an owner could collapse the entire product away.
  //
  // SIX-JOBS PROMOTION (founder call, Sep 2026 — "making those 6 jobs
  // priority"). The spine now carries, in the order the landing page sells
  // them: Hjem · Salg · Udgifter (job 6 starts here — money in, money out,
  // kvittering-scan) · I dag (1) · Reservationer (2) · Vagtplan (3) ·
  // Timer & løn (4) · Lager (5). Everything under the hairline is, visibly,
  // the detail. The six are legible by POSITION, not by a new header — no
  // group was added, renamed or reordered, no group id changed (so no owner's
  // stored collapse choice resets), and the rail got one header and one row
  // SHORTER. Revert = put `group` back on the four re-homed rows.
  { id: "core",     labelKey: null,             icon: null,        visibleFor: null },
  { id: "money",    labelKey: "navMoney",       icon: "Wallet",    visibleFor: null },
  // Staff ABOVE Stock: Vagtplan is a headline pillar (the Planday
  // replacement — weekly ritual + fravær interrupts), Stock is a
  // monthly-ritual tracker. Matches archetypes.js leadFeatures ranking.
  //
  // CURRENTLY EMPTY (Sep 2026): both members were promoted to the spine, so
  // this header does not render for anyone. Kept on purpose — it is where a
  // third staff row (fravær / availability) lands when it returns, and keeping
  // the id means no stored collapse state is orphaned. A group with no items
  // is dropped by Layout before render, so an empty header is impossible.
  { id: "staff",    labelKey: "navStaff",       icon: "UsersRound", visibleFor: null },
  { id: "stock",    labelKey: "navStock",       icon: "Boxes",     visibleFor: null },
  { id: "reports",  labelKey: "navReportsMoms", icon: "BarChart3", visibleFor: null },
  // C7 Intelligence collapse: the standalone `intel` group is GONE. Its lone
  // survivor — the Insights hub — moved into the `reports` group above (it's
  // still business-type-gated via the destination's own visibleFor). All the
  // other former members (weather/staffing → Schedule panel; pricing/
  // competitors/retention → InsightsHub tabs) are no longer sidebar/More
  // destinations.
  // Workshop group shows for workshop branches OR when the workshop module
  // is enabled (legacy `requiresAnyModule: ['workshop']`).
  { id: "workshop", labelKey: "navWorkshop",    icon: "Wrench",
    visibleFor: ["workshop"], requiresAnyModule: ["workshop"] },
  // Settings — the rare group: connections, terminals, branches, team,
  // modules, channels, plan & billing, etc. (absorbed ACCOUNT in C5).
  { id: "manage",   labelKey: "navSettings",    icon: "Settings",  visibleFor: null },
];

/**
 * sidebarGroupsFor(archetypeId)
 * -----------------------------
 * The SIDEBAR surface, projected into the grouped shape Layout renders: each
 * NAV_GROUPS entry with the manifest destinations that belong to it AND appear
 * on this owner's sidebar (see surfacesFor — C12b makes that archetype-aware).
 *
 * Lives here rather than in Layout.jsx because it is pure manifest projection
 * with no React in it, and because a guard test has to be able to ask "what
 * does a restaurant owner's rail resolve to" without mounting the whole shell.
 * Layout still owns everything surface-specific on top of this: the group-level
 * visibleFor/module gate, filterDestinations, the App-Store locked-item drop,
 * and dropping a group once its items are all filtered out.
 *
 * @param {string|null} archetypeId — resolved archetype (config/archetypes.js)
 * @returns {Array<{id,labelKey,icon,visibleFor,requiresAnyModule,items}>}
 */
/**
 * isScopedOffTheRail(item, archetypeId)
 * -------------------------------------
 * Is this destination off the sidebar because it is OUT OF SCOPE for the
 * product, as opposed to merely DECLUTTERED? Two different reasons, and only
 * one of them should stop a "pick up where you left off".
 *
 * WHY THIS EXISTS. filterDestinations answers "may this owner have this
 * destination at all" and deliberately never consults `surfaces` — that is the
 * surface-narrowing step's job, and keeping the two apart is what makes it
 * impossible for a placement field to hide a page from ⌘K. But ResumeRow
 * (Fortsæt) renders at the very TOP of the rail and resolves the FULL manifest
 * through filterDestinations alone. So without this check a page the product
 * just took off the rail can reappear ABOVE the rows that replaced it, one
 * recent visit later:
 *   • /events — the founder's own account passes the usage gate (he HAS Event
 *     rows), so dropping "sidebar" hides it from the groups and Fortsæt would
 *     put it straight back at the top of his rail;
 *   • /khata — `surfaces: []` has meant "gone from every surface" since June,
 *     and Resume has been quietly ignoring that.
 *
 * WHY NOT JUST NARROW RESUME TO THE SIDEBAR SLICE. Because several rows are
 * off the rail for being RARE, not out of scope — /budgets, /mileage,
 * /connections, /terminals, and Faktura + Kunder for hospitality — and
 * resuming into one of those is exactly what ResumeRow promises. Narrowing
 * would silently break all of them.
 *
 * Pure manifest projection (no React, no path list), so a guard test can ask
 * the question without mounting the component.
 *
 * @returns {boolean} true ⇒ never offer this as a resume target.
 */
export function isScopedOffTheRail(item, archetypeId = null) {
  if (!item) return false;
  // No nav surface anywhere — the page is switched off for this product.
  if (surfacesFor(item, archetypeId).length === 0) return true;
  // Off the rail AND a pillar we are not selling. It keeps More + ⌘K (the way
  // back in), but it must not be re-offered at the top of the rail it just
  // left. Re-adding "sidebar" lifts this on its own — no second edit needed.
  if (!isOnSurface(item, "sidebar", archetypeId) && USAGE_GATED_PILLARS.includes(item.pillar)) {
    return true;
  }
  return false;
}

/**
 * pillarIsScopedOffTheRail(pillarId, archetypeId)
 * ----------------------------------------------
 * The PILLAR-level form of isScopedOffTheRail: is EVERY destination this
 * pillar owns off the rail for scope reasons? If so, switching the pillar ON
 * cannot put a single row back on this owner's sidebar.
 *
 * WHY THIS EXISTS. Two surfaces promise the rail in the owner's own words and
 * both resolve pillars, not destinations:
 *   • PillarDiscovery — "Slå til · Arrangementer" re-enables the pillar and
 *     its comment/undo copy promise the nav entry comes back;
 *   • the activation graduation toast — "{feature} er nu i din menu".
 * After /events lost "sidebar" neither promise can be kept, and the usage gate
 * is NOT the instrument that catches it: the one owner with Event rows is
 * precisely the owner the usage gate lets through.
 *
 * SAME ONE-WORD REVERT as isScopedOffTheRail: re-add "sidebar" to the /events
 * entry and this returns false again, with no second edit anywhere.
 *
 * A pillar with NO manifest destination is NOT scoped off (vacuous-truth
 * guard) — we only answer for pillars that actually own pages.
 *
 * Pure manifest projection, so a guard test can ask without mounting React.
 *
 * @returns {boolean} true ⇒ turning this pillar on adds nothing to the rail.
 */
export function pillarIsScopedOffTheRail(pillarId, archetypeId = null) {
  if (!pillarId) return false;
  const owned = NAV_MANIFEST.filter((d) => d.pillar === pillarId);
  if (owned.length === 0) return false;
  return owned.every((d) => isScopedOffTheRail(d, archetypeId));
}

export function sidebarGroupsFor(archetypeId = null) {
  const sidebarItems = NAV_MANIFEST.filter((d) => isOnSurface(d, "sidebar", archetypeId));
  return NAV_GROUPS.map((g) => ({
    id: g.id,
    labelKey: g.labelKey,
    icon: g.icon,
    visibleFor: g.visibleFor,
    requiresAnyModule: g.requiresAnyModule,
    items: sidebarItems.filter((d) => d.group === g.id),
  }));
}
