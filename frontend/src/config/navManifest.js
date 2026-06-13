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
 * THE THREE ORTHOGONAL VISIBILITY AXES (architecture_pillar_visibility.md)
 * -----------------------------------------------------------------------
 *   1. RELEVANCE  — per-account pillar toggles (`hiddenPillars`). Free,
 *      owner-controlled. A destination with `pillar: 'reservations'` is
 *      hidden from chrome when that pillar is toggled OFF. `pillar: null`
 *      means "spine" — always relevant, never pillar-hideable.
 *      NOTE: there is NO frontend pillar state yet (backend C8 only). Every
 *      caller passes an empty `hiddenPillars` set today, so this axis is a
 *      no-op until a later batch wires `users.hidden_pillars` into context.
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
 *
 * Hide (axes 1 + 3) and locked (axis 2) are different outcomes and must
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
    surfaces: ["sidebar", "more", "search"],
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
    // Khata = customer credit ledger. Lives in Money.
    to: "/khata",
    icon: "BookText",
    labelKey: "khata",
    group: "money",
    pillar: null,
    frequency: "weekly",
    surfaces: ["sidebar", "more", "search"],
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
    surfaces: ["sidebar"],
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
    to: "/staff/hours",
    icon: "Timer",
    labelKey: "staffHours",
    group: "staff",
    pillar: "staff",
    frequency: "weekly",
    surfaces: ["sidebar", "more"],
  },
  {
    to: "/staff/time-registration",
    icon: "Clock",
    labelKey: "staffTimeReg",
    group: "staff",
    pillar: "staff",
    frequency: "weekly",
    surfaces: ["sidebar", "more"],
  },
  {
    to: "/staff/tips",
    icon: "Coins",
    labelKey: "staffTips",
    group: "staff",
    pillar: "staff",
    frequency: "weekly",
    surfaces: ["sidebar", "more"],
  },
  {
    to: "/staff/payroll",
    icon: "FileSpreadsheet",
    labelKey: "staffPayroll",
    group: "staff",
    pillar: "staff",
    frequency: "rare",
    surfaces: ["sidebar", "more"],
    aliases: ["payroll", "løn", "lønseddel"],
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
    surfaces: ["sidebar", "more"],
    aliases: ["connections", "integrations", "bank"],
  },
  {
    to: "/branches",
    icon: "Building2",
    labelKey: "branches",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar", "more", "search"],
  },
  {
    to: "/terminals",
    icon: "Monitor",
    labelKey: "terminals",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar", "more"],
  },
  {
    to: "/channel-settings",
    icon: "Bike",
    labelKey: "orderChannels",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar"],
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
    surfaces: ["sidebar"],
  },
  {
    to: "/outlets",
    icon: "Network",
    labelKey: "crossOutlet",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar"],
  },
  {
    to: "/consolidated-close",
    icon: "Building",
    labelKey: "consolidatedClose",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar"],
  },
  {
    to: "/team",
    icon: "UserCog",
    labelKey: "team",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar", "more", "search"],
  },
  {
    to: "/recently-deleted",
    icon: "Trash",
    labelKey: "recentlyDeleted",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar"],
  },
  {
    to: "/contact",
    icon: "MessageCircle",
    labelKey: "contact",
    group: "manage",
    pillar: null,
    frequency: "rare",
    surfaces: ["sidebar"],
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
 * filterDestinations(items, ctx)
 * ------------------------------
 * Apply the three visibility axes to a list of manifest entries and return
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
 * }
 *
 * Outcome per axis:
 *   • RELEVANCE  (hiddenPillars)            → HIDE (dropped from result)
 *   • BUSINESS   (visibleFor / module)      → HIDE (dropped from result)
 *   • ENTITLEMENT(requiresFeature missing)  → KEEP, `locked: true`
 *
 * A tier-locked entry is NEVER dropped here — hiding it would unrender the
 * UpgradeNudge funnel. (Native App-Store compliance hiding is the caller's
 * job, not this function's.)
 */
export function filterDestinations(items, ctx = {}) {
  const {
    businessTypes,
    hasFeature,
    hiddenPillars,
    featReady = true,
  } = ctx;

  const types = Array.isArray(businessTypes) ? businessTypes : [];
  const hidden = hiddenPillars instanceof Set ? hiddenPillars : new Set();
  // Fail-closed default — an absent hasFeature (e.g. a test rendering a
  // surface without an EntitlementsProvider) treats every feature as
  // missing, mirroring the backend's fail-closed semantics.
  const hasFeat = typeof hasFeature === "function" ? hasFeature : () => false;

  // BUSINESS TYPE — null visibleFor = all; empty active types = don't gate
  // by type (fresh signup with no branch). Module gate still applies.
  const passesType = (vf) => {
    if (!vf) return true;
    if (!types || types.length === 0) return true;
    return vf.some((tp) => types.includes(tp));
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
  // drops the entry from chrome. (No-op until pillar state is wired.)
  const passesPillar = (pillar) => {
    if (!pillar) return true;
    return !hidden.has(pillar);
  };

  const out = [];
  for (const item of items) {
    if (!passesPillar(item.pillar)) continue;
    if (!passesType(item.visibleFor)) continue;
    if (!passesModule(item.requiresModule, item.requiresAnyModule)) continue;
    if (item.requiresFeature && !passesFeature(item.requiresFeature)) {
      out.push({ ...item, locked: true });
      continue;
    }
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
  { id: "stock",    labelKey: "navStock",       icon: "Boxes",     visibleFor: null },
  { id: "staff",    labelKey: "navStaff",       icon: "UsersRound", visibleFor: null },
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
