import { useState, useEffect, lazy, Suspense } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { getVatTerms } from "../utils/currency";
import { isNativeApp } from "../utils/platform";
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
// Smart Scan — mobile-only FAB that opens the unified "snap anything"
// classifier modal. Routes to Expenses / Daily Close / Inventory based
// on the backend's doc_type guess.
const SmartScanFAB = lazy(() => import("./SmartScanFAB"));
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
      // Cultural events (migration 013, kulturarrangør sprint) — sits
      // directly under Sales because event-tagged sales are the core
      // flow. Visible to everyone; for non-event owners it stays empty
      // (no nag). DK-first label key is "events" — same English-loaned
      // word works in both EN and DK UI per Manoj's Sudip interviews.
      { to: "/events", icon: "CalendarDays", labelKey: "events" },
      // Reservations (table booking + appointments) — sits directly after
      // Events as its own top-level entry (IA decision: NOT nested under
      // Events). Starter+ feature, so we gate it with requiresFeature; the
      // item stays visible-but-locked for Free tier (the conversion signal
      // we want, same as Faktura) and the page renders its own UpgradeNudge.
      { to: "/reservations", icon: "CalendarCheck", labelKey: "reservations", requiresFeature: "reservations" },
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
      // Today (#150) — single daily page that lives with the owner
      // through the shift: live KPIs on top → close wizard in the
      // middle → locked summary after confirm. The legacy
      // "Today's Floor" entry was dropped here; /daily-report now
      // redirects to /daily-close to keep bookmarks working.
      { to: "/daily-close", icon: "Moon", labelKey: "navToday" },
      { to: "/reports", icon: "ClipboardList", labelKey: "navReportsTax" },
      // Multi-terminal close — Pro entitlement (P5 honesty fix).
      // Previously hidden behind a `multi_terminal` module flag that
      // wasn't in the modules allowlist (services/modules.py) — i.e.
      // the entry was effectively dead for everyone. Now gated on the
      // canonical `multi_terminal_close` feature flag so it appears
      // for Pro/Trial users (matching the "manage up to 3 branches"
      // marketing claim) and stays hidden for Free + Starter.
      { to: "/daily-close/multi", icon: "Store", labelKey: "multiClose", requiresFeature: "multi_terminal_close" },
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
      { to: "/staff/time-registration", icon: "Clock", labelKey: "staffTimeReg" },
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
      // Task #204 P2.9 — Insights inbox was an orphan route; promote
      // it into the Intelligence group so owners can actually find the
      // patterns surface.
      { to: "/insights", icon: "Sparkles", labelKey: "insightsInbox" },
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
function filterNavGroups(groups, branchType, businessTypes, enabledModules, hasFeature, entReady = true) {
  const activeTypes = branchType ? [branchType] : businessTypes;
  const enabled = enabledModules instanceof Set ? enabledModules : new Set();
  // Default to a fail-closed `hasFeature` when none is provided (e.g.
  // tests rendering Layout without an EntitlementsProvider). Mirrors
  // the backend's fail-closed semantics: unknown feature → false →
  // sidebar entry stays hidden.
  const hasFeat = typeof hasFeature === "function" ? hasFeature : () => false;
  // Tier-flicker fix: while entitlements are still loading, `hasFeat`
  // returns false for everything (fail-closed Free default), which
  // would mark Pro-only sidebar entries as `locked: true` for the
  // ~150-300ms cold-load window — a trial user briefly sees their
  // Pro-only entries flagged as locked.  We treat the loading state
  // as "assume unlocked for cosmetic purposes" — the backend still
  // gates the actual endpoint, so this is purely about not flashing
  // a lock icon. Same multi-barrier rationale as <Locked> doing
  // pass-through children during loading.
  const featReady = entReady !== false;

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
  // P5 — entitlement-level visibility. Used by the multi-terminal close
  // entry (and any future Pro-only nav). Cosmetic gate only — the
  // backend re-checks via enforce_feature() on every call. Frontend
  // cache changes can only HIDE links, never grant access.
  //
  // Tier-flicker fix: while entitlements are still loading, return
  // `true` so locked-but-visible items render UNLOCKED.  Once the
  // payload lands the next render will lock them if appropriate.
  // A trial user briefly seeing an unlocked Pro link is strictly
  // better than seeing it flash as locked — and the backend gate
  // is the actual security boundary.
  const passesFeature = (feat) => {
    if (!feat) return true;
    if (!featReady) return true;
    return hasFeat(feat);
  };

  // L1 — UI Visibility:
  //   • `visibleFor` (business_type) + `requiresModule` items that don't
  //     match are HIDDEN — they're a wrong-product-fit signal (a bar
  //     nav item doesn't belong in a retail-only sidebar).
  //   • `requiresFeature` items that the user doesn't have access to
  //     are SHOWN BUT LOCKED. Owners see what their next tier unlocks
  //     (growth signal). Click navigates to /subscription via the lock
  //     handler in the render block below.
  //
  // The locked-but-visible behavior is the L1 multi-barrier defense
  // for tier-gated features — if a future refactor accidentally drops
  // the backend gate, the frontend still pops a polite "Pro feature,
  // upgrade to unlock" experience instead of letting a Free user click
  // through to a 402-after-the-fact toast.
  return groups
    .filter(
      (g) =>
        passesType(g.visibleFor) &&
        passesModule(g.requiresModule, g.requiresAnyModule),
      // NOTE: group-level requiresFeature still hides the whole group —
      // a locked group with no clickable items would be confusing. We
      // don't currently use group-level requiresFeature; if we add it
      // later, decide per-feature whether to hide or lock.
    )
    .map((g) => {
      const itemsWithLockState = g.items
        .filter(
          (item) =>
            passesType(item.visibleFor) &&
            passesModule(item.requiresModule, item.requiresAnyModule),
        )
        .map((item) => {
          // L1 — for `requiresFeature` items the user lacks, KEEP the
          // entry visible but mark it `locked` so the renderer can swap
          // the icon + click handler. Items without `requiresFeature`
          // are unchanged.
          if (item.requiresFeature && !passesFeature(item.requiresFeature)) {
            // App Store compliance (Apple 3.1.1) — approach (a): on the native
            // app a locked entry would render a Lock icon + a "Pro feature —
            // upgrade to unlock" tooltip routing to /subscription, i.e. an
            // upgrade/purchase surface. Hide the entry entirely instead — the
            // reviewer never sees a feature the account can't use. (Drop here;
            // filtered out below.) Web keeps the locked-but-visible upsell.
            if (isNativeApp()) return null;
            return { ...item, locked: true };
          }
          return item;
        })
        .filter(Boolean);
      return itemsWithLockState.length > 0 ? { ...g, items: itemsWithLockState } : null;
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
      // Accountant nav mirrors the owner nav (#150) — single "Today"
      // entry pointing at the merged page.
      { to: "/daily-close", icon: "Moon", labelKey: "navToday" },
      { to: "/reports", icon: "ClipboardList", labelKey: "navReportsTax" },
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

  // P5 — pull the entitlement helper so the sidebar filter can hide
  // Pro-only entries (multi-terminal close) for Free/Starter users.
  // Cosmetic only; backend enforcement is what actually keeps the
  // feature locked.  `isReady` is threaded so the filter can suppress
  // the locked-state flicker during the cold-load window.
  const { hasFeature, isReady: entReady } = useEntitlements();

  // Filter sidebar groups by both business_type (branch) and enabled modules
  const baseVisible = isAccountant
    ? accountantNavGroups
    : filterNavGroups(navGroups, branchType, businessTypes, enabledModules, hasFeature, entReady);
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
  // Active item: subtle gray bg (the doctrine) PLUS a 2px emerald-500 inset
  // left rail drawn via box-shadow so it doesn't shift the icon/text layout
  // (every NavLink — top-level AND sub-item — has different left padding;
  // using box-shadow keeps that geometry untouched). That rail is the only
  // brand-green moment in the nav. Everything else stays neutral.
  // See "BRAND GREEN" block in index.css for the token contract.
  const activeClass = "bg-gray-100 dark:bg-gray-700/60 text-gray-900 dark:text-white font-semibold shadow-[inset_2px_0_0_0_#10b981]";
  const inactiveClass = "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-white";

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-900">
      {/* Skip-to-content link — invisible until focused, lets keyboard
          users jump past the sidebar nav straight to the main content.
          WCAG 2.4.1 (Bypass Blocks). Uses sr-only + focus styles to
          appear only when tabbed to. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-gray-900 focus:text-white focus:rounded-lg focus:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
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
          className="text-gray-600 dark:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800 rounded-md p-1"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        {/* Mobile top-bar wordmark + emerald-600 brand mark. Logo tile is
            the saturated brand-green moment per the brand-green token block
            in index.css. Tile holds an inverted version of the favicon
            shape (notepad lines) in white so it reads as the BonBox logo
            even at 24px. */}
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-emerald-600 rounded-md flex items-center justify-center shrink-0" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <path d="M8 8h8M8 12h8M8 16h5" />
            </svg>
          </div>
          <h1 className="text-base font-bold text-gray-900 dark:text-gray-100">BonBox</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSearchOpen(true)}
            aria-label={t("search") || "Search"}
            className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition"
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
            {/* Wordmark — emerald-600 tile + gray-900 wordmark. The tile is
                the saturated brand-green moment for the sidebar (paired
                with the active-nav left-rail in emerald-500). */}
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 bg-emerald-600 rounded-md flex items-center justify-center shrink-0" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="3" width="16" height="18" rx="2" />
                  <path d="M8 8h8M8 12h8M8 16h5" />
                </svg>
              </div>
              <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">BonBox</h1>
            </div>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate mt-1">{user?.business_name}</p>
            <BranchSelector compact />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Desktop sidebar hide — Claude-style. Lucide PanelLeftClose
                inside a 40×40 ghost button (no border, hover bg only) so
                it reads as a clean toolbar control. Bumped from 32×32 →
                40×40 (Task #129 — "nice good size noticeable"). */}
            <button
              onClick={toggleDesktopSidebar}
              title={t("hideSidebar") || "Hide sidebar"}
              className="hidden md:inline-flex items-center justify-center w-10 h-10 rounded-lg text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800"
              aria-label={t("hideSidebar") || "Hide sidebar"}
            >
              <Icon name="PanelLeftClose" size={20} strokeWidth={1.75} />
            </button>
            {/* Mobile close */}
            <button
              onClick={closeSidebar}
              aria-label={t("closeMenu") || "Close menu"}
              className="md:hidden text-gray-400 hover:text-gray-600 text-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800 rounded-md w-8 h-8 flex items-center justify-center"
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
                        item.locked ? (
                          // L1 — visible-but-locked entry (Pro feature
                          // for non-Pro user). Lock icon replaces the
                          // normal icon; clicking routes to /subscription
                          // so the owner sees what their tier unlocks.
                          <NavLink
                            key={item.to}
                            to="/subscription"
                            onClick={closeSidebar}
                            title={(t("proFeatureUpgrade") || "Pro feature — upgrade to unlock")}
                            aria-label={(t("proFeatureUpgrade") || "Pro feature — upgrade to unlock") + " (" + (item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)) + ")"}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition cursor-not-allowed opacity-60 ${inactiveClass}`}
                          >
                            <Icon name="Lock" size={18} className="shrink-0" />
                            <span className="flex-1 truncate">{item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)}</span>
                          </NavLink>
                        ) : (
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
                        )
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
                      className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition ${
                        hasActiveChild
                          ? "text-gray-900 dark:text-gray-100"
                          : "text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                      }`}
                    >
                      <Icon name={group.icon} size={14} className="shrink-0 opacity-70" />
                      <span>{t(group.labelKey)}</span>
                      {hasActiveChild && !isOpen && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 ml-0.5" />
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
                          item.locked ? (
                            // L1 — visible-but-locked Pro feature entry.
                            // Lucide Lock icon + opacity-60 + cursor-not-
                            // allowed; click routes to /subscription so
                            // the owner sees the upsell path. Multi-
                            // barrier defense: even if the L3 router
                            // gate breaks, the frontend stops the click
                            // from hitting the 402 directly.
                            <NavLink
                              key={item.to}
                              to="/subscription"
                              onClick={closeSidebar}
                              title={(t("proFeatureUpgrade") || "Pro feature — upgrade to unlock")}
                              aria-label={(t("proFeatureUpgrade") || "Pro feature — upgrade to unlock") + " (" + (item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)) + ")"}
                              className={`flex items-center gap-2.5 pl-5 pr-3 py-1.5 rounded-lg text-[13px] font-medium transition cursor-not-allowed opacity-60 ${inactiveClass}`}
                            >
                              <Icon name="Lock" size={16} className="shrink-0" />
                              <span className="flex-1 truncate">{item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)}</span>
                            </NavLink>
                          ) : (
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
                          )
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
            <span className="w-5 flex items-center justify-center"><Icon name="User" size={16} /></span>
            {t("profile")}
          </NavLink>
          <button
            onClick={toggleDark}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
          >
            <span className="w-5 flex items-center justify-center"><Icon name={dark ? "Sun" : "Moon"} size={16} /></span>
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
            <span className="w-5 flex items-center justify-center"><Icon name="LogOut" size={16} /></span>
            {t("signOut")}
          </button>
        </div>
      </aside>

      {/* Soft-error banner — shows toast for graceful backend failures */}
      <Suspense fallback={null}>
        <SoftErrorBanner />
      </Suspense>

      {/* Floating "show sidebar" — Claude-style. 44×44 white card with
          1px gray-200 border, rounded-lg, subtle shadow-sm. Hover stays
          gray (DNA rule 2: emerald is for money moments only, not for
          UI affordances). Bumped from 40×40 → 44×44 to meet iOS HIG
          tap target + "noticeable" requirement. PanelLeft Lucide icon
          mirrors the close button visually so it's clear what it does.
          One tap → sidebar slides back in; preference persists. */}
      {desktopSidebarHidden && (
        <button
          onClick={toggleDesktopSidebar}
          title={t("showSidebar") || "Show sidebar"}
          aria-label={t("showSidebar") || "Show sidebar"}
          className="hidden md:flex fixed top-4 left-4 z-40 items-center justify-center w-11 h-11 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white hover:border-gray-300 dark:hover:border-gray-600 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900"
        >
          <Icon name="PanelLeft" size={20} strokeWidth={1.75} />
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
          {/* Smart Scan FAB — mobile-only "snap anything" entry. Sits
              above the BonBoxAgent orb in the bottom-right column. The
              QuickAdd menu also exposes Smart skan as its first option,
              so both surfaces reach the same modal. */}
          <SmartScanFAB />
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
