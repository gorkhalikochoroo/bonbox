import { useState, useEffect, lazy, Suspense } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import { getVatTerms } from "../utils/currency";
import { usePageTracking } from "../hooks/useEventLog";
import NotificationCenter from "./NotificationCenter";
import TrialChip from "./TrialChip";
import { Icon } from "./ui";
// Lazy-load the search modal — only fetched when the user actually
// opens it (⌘K or button), keeping main bundle lean.
const GlobalSearchModal = lazy(() => import("./GlobalSearchModal"));
import BranchSelector, { useBranch } from "./BranchSelector";
import MobileBottomNav from "./MobileBottomNav";
import { useAppLifecycle } from "../hooks/useAppLifecycle";
import { useKeyboardAvoidance } from "../hooks/useKeyboardAvoidance";

// Lazy-load heavy floating widgets — only parsed when opened
const QuickAdd = lazy(() => import("./QuickAdd"));
const BonBoxAgent = lazy(() => import("./BonBoxAgent"));
const SupportChip = lazy(() => import("./SupportChip"));
const SmartLanguageToast = lazy(() => import("./SmartLanguageToast"));
// Task #49 — Accountant read-only banner. Renders only for accountant
// sessions; no-ops otherwise so the import cost is negligible.
const AccountantViewBanner = lazy(() => import("./AccountantViewBanner"));
// Soft-error banner is part of the multi-layer defense — listens for graceful
// backend errors so a single failing endpoint never blanks the whole page.
const SoftErrorBanner = lazy(() => import("./SoftErrorBanner"));
// PWA install prompt — self-hides if already installed / dismissed /
// running natively. Surfaces 25 sec after the page mounts.
const InstallAppPrompt = lazy(() => import("./InstallAppPrompt"));

/* ─── Grouped sidebar navigation ───
   visibleFor: array of business_types that see this group.
   null = always visible regardless of branch type.
   Items with visibleFor on individual items are filtered too.
*/
const navGroups = [
  {
    id: "core",
    visibleFor: null, // always
    items: [
      // Sidebar labels follow the job-to-be-done renaming (Option A,
      // May 2026): Dashboard → Home, Daily Report → Today's Floor,
      // Reports → Reports & Tax, Daily Close → End-of-Day. The original
      // `dashboard`/`dailyReport`/`dailyClose` translation keys still
      // exist for tooltip / button copy elsewhere — only the SIDEBAR
      // uses the shorter job-to-be-done labels.
      //
      // Icons are Lucide names (see components/ui/Icon.jsx for the map).
      // Each item gets a UNIQUE icon — no duplicates across categories.
      { to: "/dashboard", icon: "Home", labelKey: "navHome" },
      { to: "/sales", icon: "ShoppingBag", labelKey: "sales" },
      { to: "/expenses", icon: "Receipt", labelKey: "expenses" },
    ],
  },
  {
    id: "money",
    labelKey: "navMoney",
    icon: "Wallet",
    visibleFor: null,
    items: [
      { to: "/cashbook", icon: "BookOpen", labelKey: "cashBook" },
      { to: "/cashflow", icon: "LineChart", labelKey: "cashFlow" },
      { to: "/budgets", icon: "Target", labelKey: "budgetOverview" },
      { to: "/bank-import", icon: "Landmark", labelKey: "bankImport" },
      { to: "/payment-imports", icon: "CreditCard", labelKey: "paymentImports" },
      // Khata = customer credit ledger. Lives in Money (it IS money
      // owed to/by the business), not Manage. Moved here May 2026.
      { to: "/khata", icon: "BookText", labelKey: "khata" },
      // Invoicing — Starter-tier feature. Pages render their own upgrade
      // prompt for Free-tier users, so we keep these in nav for visibility
      // (the conversion signal we want).
      { to: "/faktura", icon: "FileText", labelKey: "faktura" },
      { to: "/customers", icon: "Users", labelKey: "customers" },
      { to: "/mileage", icon: "Car", labelKey: "mileage" },
    ],
  },
  {
    id: "stock",
    labelKey: "navStock",
    icon: "Boxes",
    visibleFor: null,
    items: [
      // Inventory always visible — it's the general kitchen / shop / pantry stock.
      { to: "/inventory", icon: "Package", labelKey: "inventory" },
      // Bar Pour — extracted from inventory in this commit. Gated on the
      // bar_pour vertical module so non-bar businesses (takeaways, retail,
      // workshops) never see it cluttering their nav.
      { to: "/bar", icon: "Martini", labelKey: "bar", requiresModule: "bar_pour" },
      // Wine list — gated on wine_sommelier module instead of business_type
      // so a Pro restaurant that doesn't sell wine can hide it, and a wine
      // bar (technically business_type=restaurant) gets it without fuss.
      { to: "/wine-list", icon: "Wine", labelKey: "wineList", requiresModule: "wine_sommelier" },
      { to: "/expiry", icon: "AlarmClock", labelKey: "expiryForecasting", visibleFor: ["restaurant", "retail", "general"] },
      { to: "/waste", icon: "Trash2", labelKey: "wasteTracker", visibleFor: ["restaurant", "retail", "general"] },
    ],
  },
  // Reports placed BEFORE Staff in the sidebar — matches the owner's
  // operational rhythm: every night ends with a close + daily report,
  // staff scheduling is a weekly cadence (less frequent). Putting
  // Reports right after Stock keeps the close-the-day workflow as
  // a continuous downward scan in the nav.
  {
    id: "reports",
    labelKey: "navReports",
    icon: "BarChart3",
    visibleFor: null,
    items: [
      { to: "/daily-report", icon: "Utensils", labelKey: "navTodaysFloor" },
      { to: "/reports", icon: "ClipboardList", labelKey: "navReportsTax" },
      { to: "/daily-close", icon: "Moon", labelKey: "navEndOfDayClose" },
      // Multi-terminal close — only relevant when the owner has >1 POS
      // terminal configured. Most single-location cafés have one, so we
      // hide this entry behind the `multi_terminal` module flag to avoid
      // sidebar bloat. Owners enable it via /modules when needed.
      { to: "/daily-close/multi", icon: "Store", labelKey: "multiClose", requiresModule: "multi_terminal" },
      { to: "/tax", icon: "Calculator", labelKey: "taxAutopilot" },
      { to: "/bookkeeping-export", icon: "Send", labelKey: "sendToAccountant" },
    ],
  },
  {
    id: "staff",
    labelKey: "navStaff",
    icon: "UsersRound",
    visibleFor: null,
    items: [
      { to: "/staff/schedule", icon: "Calendar", labelKey: "staffSchedule" },
      { to: "/staff/hours", icon: "Timer", labelKey: "staffHours" },
      { to: "/staff/tips", icon: "Coins", labelKey: "staffTips" },
      { to: "/staff/payroll", icon: "FileSpreadsheet", labelKey: "staffPayroll" },
    ],
  },
  {
    id: "intel",
    labelKey: "navIntel",
    icon: "Brain",
    visibleFor: ["restaurant", "retail", "service", "general"],
    items: [
      { to: "/weather", icon: "CloudSun", labelKey: "weatherSmart" },
      { to: "/staffing", icon: "CalendarClock", labelKey: "staffingForecast" },
      { to: "/pricing", icon: "BadgePercent", labelKey: "priceOptimization" },
      { to: "/retention", icon: "Heart", labelKey: "customerRetention" },
      { to: "/competitors", icon: "Telescope", labelKey: "competitorScan" },
    ],
  },
  {
    id: "workshop",
    labelKey: "navWorkshop",
    icon: "Wrench",
    // Show the group when EITHER the branch is workshop-typed OR the
    // owner has explicitly enabled the workshop module via /modules.
    // The latter lets a multi-business owner with one workshop branch
    // see the group regardless of which branch they're viewing.
    visibleFor: ["workshop"],
    requiresAnyModule: ["workshop"],
    items: [
      { to: "/workshop", icon: "Wrench", labelKey: "workshop", requiresModule: "workshop" },
    ],
  },
  {
    id: "manage",
    labelKey: "navManage",
    icon: "Settings",
    visibleFor: null,
    items: [
      // Connections hub leads the Manage group — owners reach it
      // most often (new bank, new revisor, new sales channel).
      { to: "/connections", icon: "Link2", labelKey: "navConnections" },
      { to: "/branches", icon: "Building2", labelKey: "branches" },
      { to: "/terminals", icon: "Monitor", labelKey: "terminals" },
      { to: "/channel-settings", icon: "Bike", labelKey: "orderChannels" },
      { to: "/modules", icon: "LayoutGrid", labelKey: "modules" },
      { to: "/share-recipients", icon: "Mail", labelKey: "shareRecipients" },
      { to: "/outlets", icon: "Network", labelKey: "crossOutlet" },
      { to: "/consolidated-close", icon: "Building", labelKey: "consolidatedClose" },
      { to: "/team", icon: "UserCog", labelKey: "team" },
      // Khata moved to Money group below — it's customer credit, not a Manage concern.
      // Feedback page retired — replaced by the in-app SupportChip (bottom-left "?")
      // which routes to /api/support/tickets and is consistently visible across pages.
      // /feedback route still exists as a backstop URL but isn't surfaced in primary nav.
      { to: "/recently-deleted", icon: "Trash", labelKey: "recentlyDeleted" },
      { to: "/contact", icon: "MessageCircle", labelKey: "contact" },
    ],
  },
  {
    id: "account",
    labelKey: "navAccount",
    icon: "Sparkles",
    visibleFor: null,
    items: [
      { to: "/subscription", icon: "Sparkles", labelKey: "planBilling" },
    ],
  },
];

/** Filter nav groups based on active branch business_type AND the owner's
 *  enabled vertical modules.
 *
 *  Two-layer filter:
 *    1. business_type (existing) — branch-scoped relevance ("workshop only
 *       shows for workshop branches")
 *    2. enabled module (new) — owner explicitly opted into this vertical
 *       via /modules. Gates Bar / Wine / Workshop / Staff Payroll so
 *       non-bar / non-wine / non-workshop businesses get a calm sidebar.
 *
 *  An item is shown iff:
 *    • visibleFor is null OR matches active business types, AND
 *    • requiresModule is null OR is in enabledModules
 *
 *  Default state for a new owner = no modules enabled = clean sidebar
 *  with just core + general inventory. The /modules picker is the
 *  single explicit place to opt in.
 */
function filterNavGroups(groups, branchType, businessTypes, enabledModules) {
  const activeTypes = branchType ? [branchType] : businessTypes;
  const enabled = enabledModules instanceof Set ? enabledModules : new Set();

  // Helper — does this nav element pass both filters?
  const passesType = (vf) => {
    if (!vf) return true;
    // No active branch context → don't gate by type (e.g. fresh signup
    // with no branches yet). The module gate still applies.
    if (!activeTypes || activeTypes.length === 0) return true;
    return vf.some((t) => activeTypes.includes(t));
  };
  const passesModule = (req, reqAny) => {
    if (!req && !reqAny) return true;
    if (req && !enabled.has(req)) return false;
    if (reqAny && !reqAny.some((m) => enabled.has(m))) return false;
    return true;
  };

  return groups
    .filter((g) => passesType(g.visibleFor) && passesModule(g.requiresModule, g.requiresAnyModule))
    .map((g) => {
      const filteredItems = g.items.filter(
        (item) =>
          passesType(item.visibleFor) &&
          passesModule(item.requiresModule, item.requiresAnyModule),
      );
      return filteredItems.length > 0 ? { ...g, items: filteredItems } : null;
    })
    .filter(Boolean);
}

const personalNav = [
  { to: "/personal", icon: "User", labelKey: "dashboard" },
  { to: "/loans", icon: "Banknote", labelKey: "loanTracker" },
  { to: "/contact", icon: "MessageCircle", labelKey: "contact" },
];

/* ─── Accountant-only sidebar (Task #49) ────────────────────────────
   Revisor sessions get a slimmed-down read-only nav: the reports +
   read-only operational pages. Everything that can mutate data (sales
   edits, expense entry, settings, modules, channels, branches, team)
   is HIDDEN.

   The backend middleware in main.py refuses any POST/PUT/DELETE for
   accountant sessions anyway — this trim is UX, not security. But a
   clean nav also signals "you are in view-only mode" without needing
   the banner to explain every link.
*/
const accountantNavGroups = [
  {
    id: "core",
    visibleFor: null,
    items: [
      { to: "/dashboard", icon: "Home", labelKey: "navHome" },
      { to: "/sales", icon: "ShoppingBag", labelKey: "sales" },
      { to: "/expenses", icon: "Receipt", labelKey: "expenses" },
    ],
  },
  {
    id: "money",
    labelKey: "navMoney",
    icon: "Wallet",
    visibleFor: null,
    items: [
      { to: "/cashbook", icon: "BookOpen", labelKey: "cashBook" },
      { to: "/cashflow", icon: "LineChart", labelKey: "cashFlow" },
      { to: "/khata", icon: "BookText", labelKey: "khata" },
      { to: "/faktura", icon: "FileText", labelKey: "faktura" },
    ],
  },
  {
    id: "reports",
    labelKey: "navReports",
    icon: "BarChart3",
    visibleFor: null,
    items: [
      { to: "/daily-report", icon: "Utensils", labelKey: "navTodaysFloor" },
      { to: "/reports", icon: "ClipboardList", labelKey: "navReportsTax" },
      { to: "/daily-close", icon: "Moon", labelKey: "navEndOfDayClose" },
      { to: "/tax", icon: "Calculator", labelKey: "taxAutopilot" },
    ],
  },
];

function findGroupForPath(path) {
  for (const g of navGroups) {
    if (g.items.some((i) => path.startsWith(i.to))) return g.id;
  }
  return null;
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { branchType, businessTypes } = useBranch();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop-only: persist whether the user has collapsed the sidebar
  // for more horizontal real estate (Claude-style hide). Mobile uses
  // the existing sidebarOpen overlay model — this flag is ignored
  // there.
  //
  // Smart default for tablets / smaller laptops: if the user hasn't
  // explicitly set a preference, auto-collapse on viewports below
  // 1024px (iPad portrait, small Windows tablets, 11" MacBook side-
  // by-side, etc.) so reports + dashboard tables get the full width
  // by default. Above 1024px the sidebar stays open by default.
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(() => {
    try {
      const saved = localStorage.getItem("bonbox_sidebar_hidden");
      if (saved === "1") return true;
      if (saved === "0") return false;
      // No explicit preference — auto-decide based on viewport width.
      if (typeof window !== "undefined") {
        return window.innerWidth < 1024;
      }
      return false;
    } catch {
      return false;
    }
  });
  const toggleDesktopSidebar = () => {
    setDesktopSidebarHidden((prev) => {
      const next = !prev;
      try { localStorage.setItem("bonbox_sidebar_hidden", next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
  };

  // Global ⌘K command palette state. Listens for ⌘K (Mac) and Ctrl+K
  // (Win/Linux) at window level so the shortcut works from any page.
  // Modal contents handle their own ESC + arrow key navigation once
  // open. Cleanup on unmount.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      // ⌘K / Ctrl+K — power-user keyboard shortcut (always works)
      if (isCmdOrCtrl && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      // "/" — Slack / GitHub / Notion convention. Only fires when the
      // user isn't typing into something — prevents stealing keystrokes
      // from inputs / textareas / contenteditable fields.
      if (e.key === "/" && !isCmdOrCtrl && !e.altKey && !e.shiftKey) {
        const tag = (e.target?.tagName || "").toLowerCase();
        const isEditable =
          tag === "input" || tag === "textarea" || tag === "select" ||
          e.target?.isContentEditable;
        if (!isEditable) {
          e.preventDefault();
          setSearchOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Listen for orientation changes (iPad rotating from portrait to
  // landscape, phone rotating, etc). Respects an explicit user
  // preference if present in localStorage; otherwise re-applies the
  // viewport-based default so the sidebar feels native after a
  // rotation. Cleans up on unmount.
  useEffect(() => {
    const onResize = () => {
      try {
        const saved = localStorage.getItem("bonbox_sidebar_hidden");
        if (saved === "1" || saved === "0") return;  // user has chosen — leave alone
      } catch { /* ignore */ }
      setDesktopSidebarHidden(window.innerWidth < 1024);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  const [mode, setMode] = useState(localStorage.getItem("bonbox_mode") || "business");

  // Owner's enabled vertical modules — drives sidebar gating for Bar,
  // Wine, Workshop, etc. Empty Set on first render = strict default
  // (only core + general inventory visible). Once /api/modules resolves,
  // the sidebar re-renders with whatever the owner has opted into.
  const [enabledModules, setEnabledModules] = useState(() => new Set());
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    // Lazy import to avoid pulling axios into the layout chunk on first paint
    import("../services/api").then(({ default: api }) => {
      api.get("/modules")
        .then((res) => {
          if (cancelled) return;
          const enabledIds = (res.data?.modules || [])
            .filter((m) => m.enabled)
            .map((m) => m.id);
          setEnabledModules(new Set(enabledIds));
        })
        .catch(() => { /* silent — sidebar stays in strict default */ });
    });
    return () => { cancelled = true; };
  }, [user]);

  // Task #49 — Accountant sessions get the slim read-only nav.
  // The backend middleware blocks mutations regardless; this filter is
  // UX hygiene (no half-functional links to /modules / /branches).
  const isAccountant = (user?.role || "").toLowerCase() === "accountant";

  // Filter sidebar groups by both business_type (branch) and enabled modules
  const baseVisible = isAccountant
    ? accountantNavGroups
    : filterNavGroups(navGroups, branchType, businessTypes, enabledModules);
  // For super_admin owners, show an extra "Platform" group with the admin
  // dashboard. Frontend gating is cosmetic — real enforcement is server-side
  // (services/admin_security.py). A non-admin clicking this link sees an empty
  // dashboard because every /api/admin/* call returns 404.
  const visibleGroups = !isAccountant && user?.role === "super_admin"
    ? [
        ...baseVisible,
        {
          id: "platform",
          labelKey: "navPlatform",
          icon: "🛡",
          visibleFor: null,
          items: [
            { to: "/admin", icon: "🛡", labelKey: "platformAdmin" },
          ],
        },
      ]
    : baseVisible;

  // Track which groups are expanded
  const [openGroups, setOpenGroups] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("bonbox_nav_groups") || "null");
      return saved || { core: true };
    } catch { return { core: true }; }
  });

  // Auto-expand group containing current route
  useEffect(() => {
    const gid = findGroupForPath(location.pathname);
    if (gid && !openGroups[gid]) {
      setOpenGroups((prev) => ({ ...prev, [gid]: true }));
    }
  }, [location.pathname]);

  // Persist open groups
  useEffect(() => {
    localStorage.setItem("bonbox_nav_groups", JSON.stringify(openGroups));
  }, [openGroups]);

  const toggleGroup = (gid) => {
    setOpenGroups((prev) => ({ ...prev, [gid]: !prev[gid] }));
  };

  const toggleMode = () => {
    const next = mode === "business" ? "personal" : "business";
    setMode(next);
    localStorage.setItem("bonbox_mode", next);
    navigate(next === "personal" ? "/personal" : "/dashboard");
    closeSidebar();
  };

  // iOS native hooks — no-op on web
  useAppLifecycle();      // token check on resume, offline sync, deep links
  useKeyboardAvoidance(); // keyboard pushes content up, scrolls to focused input

  const vatTerms = getVatTerms(user?.currency);
  const [dark, toggleDark] = useDarkMode();
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  usePageTracking();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const closeSidebar = () => setSidebarOpen(false);

  // Accounting-software style: neutral gray bg + bold dark text on the active
  // item (Dinero/Billy/e-conomic do this). Avoids the "tech glow" colored pill
  // that read as developer-tool aesthetic.
  const activeClass = "bg-gray-100 dark:bg-gray-700/60 text-gray-900 dark:text-white font-semibold";
  const inactiveClass = "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-white";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-900">
      {/* Skip-to-content link — invisible until focused, lets keyboard
          users jump past the sidebar nav straight to the main content.
          WCAG 2.4.1 (Bypass Blocks). Uses sr-only + focus styles to
          appear only when tabbed to. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-emerald-600 focus:text-white focus:rounded-lg focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        Skip to main content
      </a>
      {/* Task #49 — Sticky banner for accountant sessions. Renders its own
          markup only when user.role === "accountant"; otherwise null. */}
      {isAccountant && (
        <Suspense fallback={null}>
          <AccountantViewBanner />
        </Suspense>
      )}
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between gap-3" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label={t("openMenu") || "Open menu"}
          aria-expanded={sidebarOpen}
          aria-controls="primary-navigation"
          className="text-gray-600 dark:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800 rounded-md p-1"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 className="text-base font-bold text-green-600 dark:text-green-400">BonBox</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSearchOpen(true)}
            aria-label={t("search") || "Search"}
            className="text-gray-600 dark:text-gray-300 hover:text-green-600 dark:hover:text-green-400 transition"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          </button>
          <NotificationCenter />
        </div>
      </div>

      {/* Overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={closeSidebar} aria-hidden="true" />
      )}

      {/* Sidebar.
          Mobile: slide-in/out via sidebarOpen (existing behavior).
          Desktop: visible by default; user can collapse via the chevron
          button in the header. When collapsed, the floating "show
          sidebar" button below renders at the left edge for one-tap
          re-open. State persists in localStorage. */}
      <aside
        id="primary-navigation"
        aria-label={t("primaryNavigation") || "Primary navigation"}
        className={`fixed top-0 left-0 h-full w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col z-50 transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } ${desktopSidebarHidden ? "md:-translate-x-full" : "md:translate-x-0"}`}
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-green-600 dark:text-green-400">BonBox</h1>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">{user?.business_name}</p>
            <BranchSelector compact />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Desktop collapse — bold chevron-left, hidden on mobile.
                Border + slightly heavier hover state so it reads as an
                affordance rather than blending into the sidebar header
                background. */}
            <button
              onClick={toggleDesktopSidebar}
              title={t("hideSidebar") || "Hide sidebar"}
              className="hidden md:inline-flex items-center justify-center w-8 h-8 rounded-md border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 hover:border-gray-300 dark:hover:border-gray-500 transition shadow-sm"
              aria-label={t("hideSidebar") || "Hide sidebar"}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
            {/* Mobile close */}
            <button
              onClick={closeSidebar}
              aria-label={t("closeMenu") || "Close menu"}
              className="md:hidden text-gray-400 hover:text-gray-600 text-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800 rounded-md w-8 h-8 flex items-center justify-center"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        </div>

        {/* Mode switcher — neutral pill with a tiny colored dot for the mode signal */}
        <div className="px-3 py-2">
          <button
            onClick={toggleMode}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition
              bg-gray-50 dark:bg-gray-700/60 text-gray-800 dark:text-gray-100
              border border-gray-200 dark:border-gray-600
              hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                mode === "personal" ? "bg-purple-500" : "bg-blue-500"
              }`}
              aria-hidden="true"
            />
            <span>{mode === "personal" ? t("personalMode") : t("businessMode")}</span>
            <svg className="w-3 h-3 ml-auto opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>
        </div>

        {/* Global search trigger — kept compact + visually quieter
            than the business-mode toggle right above so the two
            don't compete. Borderless, smaller padding + smaller
            text, with just an icon + faded label. ⌘K hint on the
            right hugs the edge so it reads as "shortcut for this
            ambient action" rather than "primary CTA". */}
        <div className="px-3 pb-1">
          <button
            onClick={() => setSearchOpen(true)}
            aria-label={t("search") || "Search"}
            className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition
              text-gray-400 dark:text-gray-500
              hover:bg-gray-50 dark:hover:bg-gray-700/40 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <svg className="w-3 h-3 shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
            <span className="flex-1 text-left truncate">{t("search") || "Search"}</span>
            <kbd className="hidden md:inline-flex items-center px-1 py-0 text-[8px] font-mono text-gray-400 dark:text-gray-500 shrink-0">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 pb-2 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          {mode === "personal" ? (
            /* Personal mode — simple flat list */
            <div className="space-y-0.5 py-1">
              {personalNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/personal"}
                  onClick={closeSidebar}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${isActive ? activeClass : inactiveClass}`
                  }
                >
                  <Icon name={item.icon} size={18} className="shrink-0" />
                  {item.labelKey ? t(item.labelKey) : item.label}
                </NavLink>
              ))}
            </div>
          ) : (
            /* Business mode — grouped navigation (filtered by branch type) */
            <div className="space-y-0.5 py-1">
              {visibleGroups.map((group) => {
                const isOpen = openGroups[group.id] !== false; // default open for core
                const hasActiveChild = group.items.some((i) => location.pathname.startsWith(i.to));

                // Core group has no header — always visible
                if (!group.labelKey) {
                  return (
                    <div key={group.id} className="space-y-0.5">
                      {group.items.map((item) => (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          end={item.to === "/dashboard"}
                          onClick={closeSidebar}
                          className={({ isActive }) =>
                            `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${isActive ? activeClass : inactiveClass}`
                          }
                        >
                          <Icon name={item.icon} size={18} className="shrink-0" />
                          {item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)}
                        </NavLink>
                      ))}
                      <div className="h-px bg-gray-100 dark:bg-gray-700 my-1.5" />
                    </div>
                  );
                }

                // Collapsible groups
                return (
                  <div key={group.id}>
                    <button
                      onClick={() => toggleGroup(group.id)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition ${
                        hasActiveChild
                          ? "text-green-600 dark:text-green-400"
                          : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                      }`}
                    >
                      <Icon name={group.icon} size={14} className="shrink-0 opacity-70" />
                      <span>{t(group.labelKey)}</span>
                      {hasActiveChild && !isOpen && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 ml-0.5" />
                      )}
                      <svg
                        className={`w-3 h-3 ml-auto transition-transform ${isOpen ? "rotate-180" : ""}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isOpen && (
                      <div className="space-y-0.5 mt-0.5 mb-1">
                        {group.items.map((item) => (
                          <NavLink
                            key={item.to}
                            to={item.to}
                            onClick={closeSidebar}
                            className={({ isActive }) =>
                              `flex items-center gap-2.5 pl-5 pr-3 py-1.5 rounded-lg text-[13px] font-medium transition ${isActive ? activeClass : inactiveClass}`
                            }
                          >
                            <Icon name={item.icon} size={16} className="shrink-0" />
                            {item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)}
                          </NavLink>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </nav>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-700 space-y-0.5" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)" }}>
          <NavLink
            to="/profile"
            onClick={closeSidebar}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition ${isActive ? activeClass : inactiveClass}`
            }
          >
            <span className="text-sm w-5 text-center">👤</span>
            {t("profile")}
          </NavLink>
          <button
            onClick={toggleDark}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
          >
            <span className="text-sm w-5 text-center">{dark ? "☀️" : "🌙"}</span>
            {dark ? t("lightMode") : t("darkMode")}
          </button>
          {/* Theme picker lives on Profile / More page now — sidebar kept lean */}
          <div className="px-1 py-1">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg text-xs bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 outline-none cursor-pointer"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.flag} {l.label}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition font-medium"
          >
            <span className="text-sm w-5 text-center">🚪</span>
            {t("signOut")}
          </button>
        </div>
      </aside>

      {/* Soft-error banner — shows toast for graceful backend failures */}
      <Suspense fallback={null}>
        <SoftErrorBanner />
      </Suspense>

      {/* Floating "show sidebar" — only visible on desktop when the
          user has collapsed the sidebar. Sits flush against the left
          edge so it doesn't compete with main content. One tap opens
          the sidebar back up; preference is persisted. */}
      {desktopSidebarHidden && (
        <button
          onClick={toggleDesktopSidebar}
          title={t("showSidebar") || "Show sidebar"}
          aria-label={t("showSidebar") || "Show sidebar"}
          className="hidden md:flex fixed top-4 left-3 z-40 items-center justify-center w-10 h-10 rounded-lg bg-white dark:bg-gray-800 border-2 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 shadow-md hover:shadow-lg hover:border-green-500 dark:hover:border-green-400 hover:text-green-600 dark:hover:text-green-300 transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
          </svg>
        </button>
      )}

      {/* Main content — margin shrinks when desktop sidebar is hidden,
          giving the user the full viewport width for the report /
          dashboard / tables they're looking at. Mobile bottom-nav
          padding unchanged. */}
      <main
        id="main-content"
        tabIndex={-1}
        className={`pt-14 md:pt-0 pb-24 md:pb-4 transition-[margin] duration-200 focus:outline-none ${
          desktopSidebarHidden ? "md:ml-0" : "md:ml-56"
        }`}
      >
        {/* Trial countdown — thin inline strip at the top of the
            page content. Persistent across all routes (lives in
            Layout). Renders nothing for paid users / no trial /
            dismissed; otherwise a single ~28px-tall row with the
            day count + see-plans link + dismiss × on the right.
            Hidden on mobile (md-). */}
        <TrialChip />
        <Outlet />
      </main>

      {/* Mobile bottom nav — iOS tab bar pattern */}
      <MobileBottomNav />

      {/* Floating widgets — hidden on pricing/subscription pages so they
          don't visually compete with the CTA cards. The "+" QuickAdd
          implies "log a sale" which is wrong context when someone is
          deciding whether to upgrade; the ✨ BonBoxAgent likewise
          distracts from the pricing decision. */}
      {!_HIDE_FLOATING_ON.some((p) => location.pathname.startsWith(p)) && (
        <Suspense fallback={null}>
          <QuickAdd />
          <BonBoxAgent />
          {/* SupportChip — bottom-left "?" so the founder hears
              from owners before they churn. */}
          <SupportChip />
          {/* InstallAppPrompt — encourages adding BonBox to the home
              screen. Self-hides when already standalone / dismissed /
              running in a Capacitor shell, so it never shows up where
              it would be redundant. */}
          <InstallAppPrompt />
        </Suspense>
      )}

      {/* Smart Language toast — fires once if we auto-picked the
          language from browser/currency on first visit. Self-suppresses
          via localStorage after first dismiss. */}
      <Suspense fallback={null}>
        <SmartLanguageToast />
      </Suspense>

      {/* Global search palette — mounted always but only fetches its
          chunk when actually opened (lazy import). Available via
          ⌘K / Ctrl+K, the search button in the sidebar, and the
          search button in the mobile top bar. */}
      <Suspense fallback={null}>
        {searchOpen && (
          <GlobalSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
        )}
      </Suspense>
    </div>
  );
}

// Routes where floating action buttons should be suppressed.
const _HIDE_FLOATING_ON = ["/pricing", "/subscription"];
