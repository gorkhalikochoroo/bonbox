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
 *      established-owner firewall).
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
 *   aliases       (search only) extra substrings ⌘K matches against.
 *   dynamic       (sidebar only) label comes from vatTerms, not labelKey.
 *
 * SCOPE: owner-facing destinations ONLY. The personal-mode nav, the
 * accountant read-only nav, and the super_admin Platform group are
 * deliberately NOT manifest-driven — they live in their own surfaces and
 * stay decoupled (accountant nav is a security-adjacent allowlist).
 */

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
    surfaces: ["sidebar", "more", "search"],
    aliases: ["events", "tickets", "arrangement"],
  },
  {
    // Reservations — Starter+ feature: stays VISIBLE-BUT-LOCKED for Free.
    // C5: also a 'bottomnav' surface so MobileBottomNav can resolve its
    // icon/label when it claims the contextual 4th slot for restaurant /
    // cafe / bar branches (see getTabsForType).
    to: "/reservations",
    icon: "CalendarCheck",
    labelKey: "reservations",
    group: "core",
    pillar: "reservations",
    requiresFeature: "reservations",
    frequency: "daily",
    surfaces: ["sidebar", "more", "search", "bottomnav"],
    aliases: ["reservations", "booking", "table", "bordbestilling"],
  },
  {
    // Gavekort (gift cards) — Starter+ feature: stays VISIBLE-BUT-LOCKED for
    // Free. Owner pillar (relevance-hideable). On More + ⌘K so it stays
    // findable even when the pillar is toggled off.
    to: "/gavekort",
    icon: "Gift",
    labelKey: "gavekort",
    group: "core",
    pillar: "gavekort",
    requiresFeature: "gavekort",
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
    aliases: ["gavekort", "gift card", "giftcard", "voucher", "gift"],
  },
  {
    to: "/expenses",
    icon: "Receipt",
    labelKey: "expenses",
    group: "core",
    pillar: null,
    frequency: "daily",
    surfaces: ["sidebar", "search"],
  },

  // ─── MONEY ────────────────────────────────────────────────────────────
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
  {
    to: "/inventory",
    icon: "Package",
    labelKey: "inventory",
    group: "stock",
    pillar: "inventory",
    frequency: "daily",
    surfaces: ["sidebar", "more", "search", "bottomnav"],
  },
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
  {
    to: "/staff/schedule",
    icon: "Calendar",
    labelKey: "staffSchedule",
    group: "staff",
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
    // C12 Bucket B (Staff back-office MERGE): /staff/hours is now the single
    // Staff back-office row — a tabbed hub (Timer · Tidsregistrering ·
    // Drikkepenge · Løn). The former /staff/time-registration, /staff/tips and
    // /staff/payroll rows are GONE from the manifest; their routes redirect
    // into the matching tab (App.jsx) and their aliases are folded here so ⌘K
    // still finds every tab. Label is "Timer & løn" (staffBackOffice) — the
    // clearest one-line name for "settle the staff numbers". /staff/schedule
    // stays its OWN separate row above (weekly + salon bottom-nav 4th tab).
    // Reversible: split the rows back out + re-add their routes.
    to: "/staff/hours",
    icon: "Timer",
    labelKey: "staffBackOffice",
    group: "staff",
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
    labelKey: "branches",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar", "more", "search"],
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
    icon: "Bike",
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
 *   food_service → inventory, reservations, staff   (events hidden by preset)
 *   bar          → inventory, reservations, staff    (events hidden)
 *   salon        → reservations, staff               (events hidden; salons
 *                  don't run an inventory pillar by default)
 *   retail       → inventory, staff                  (events hidden)
 *   services     → staff                             (events hidden;
 *                  inventory/reservations not a default services pillar)
 *   generic/personal → all four (fail-open — never lose a setup affordance)
 */
export const PILLAR_RELEVANCE_BY_ARCHETYPE = {
  food_service: ["inventory", "reservations", "staff"],
  bar: ["inventory", "reservations", "staff"],
  salon: ["reservations", "staff"],
  retail: ["inventory", "staff"],
  services: ["staff"],
  // generic / personal deliberately omitted → fail-open (all relevant).
};

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
  // scope, this returns true for EVERYTHING → IDENTICAL to today's nav.
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
  { id: "core",     labelKey: null,             icon: null,        visibleFor: null },
  { id: "money",    labelKey: "navMoney",       icon: "Wallet",    visibleFor: null },
  // Staff ABOVE Stock: Vagtplan is a headline pillar (the Planday
  // replacement — weekly ritual + fravær interrupts), Stock is a
  // monthly-ritual tracker. Matches archetypes.js leadFeatures ranking.
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
