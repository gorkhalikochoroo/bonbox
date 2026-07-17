import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { canUsePersonalMode, resolveMode, setStoredMode, clearStoredMode } from "../lib/appMode";
import { personalNavFor } from "../config/personalNav";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { usePillars } from "../hooks/usePillars";
import { useActivation } from "../hooks/useActivation";
import { getVatTerms } from "../utils/currency";
import { isNativeApp } from "../utils/platform";
import { NAV_MANIFEST, NAV_GROUPS, filterDestinations, PILLAR_DISPLAY_BY_ID, isStaffMemberRole } from "../config/navManifest";
import { useUndoToast } from "../hooks/useUndoToast";
import { usePageTracking } from "../hooks/useEventLog";
import NotificationCenter from "./NotificationCenter";
import TrialChip from "./TrialChip";
import { Icon } from "./ui";
// Lazy-load the search modal — only fetched when the user actually
// opens it (⌘K or button), keeping main bundle lean.
const GlobalSearchModal = lazy(() => import("./GlobalSearchModal"));
import BranchSelector, { useBranch } from "./BranchSelector";
import DeviceShareChip from "./DeviceShareChip";
import { useDeviceShare } from "../hooks/useDeviceShare";
import { archetypeIdFor } from "../config/archetypes";
import MobileBottomNav from "./MobileBottomNav";
import PillarDiscovery from "./PillarDiscovery";
import ResumeRow from "./ResumeRow";
import { useRouteHistoryRecorder } from "../hooks/useRouteHistory";
import { useAppLifecycle } from "../hooks/useAppLifecycle";
import { useKeyboardAvoidance } from "../hooks/useKeyboardAvoidance";

// Lazy-load heavy floating widgets — only parsed when opened
const QuickAdd = lazy(() => import("./QuickAdd"));
const BonBoxAgent = lazy(() => import("./BonBoxAgent"));
const SupportChip = lazy(() => import("./SupportChip"));
const SmartLanguageToast = lazy(() => import("./SmartLanguageToast"));
// Smart Scan — the standalone mobile FAB was removed in C4 (FAB merge).
// "Snap anything" now lives inside the QuickAdd sheet (Smart skan is its
// first option), which the mobile bottom-tab center "+" opens. Desktop
// reaches Smart skan the same way via the QuickAdd "+".
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
   The owner sidebar is now MANIFEST-DRIVEN. The single source of truth for
   every owner-facing destination (route, icon, labelKey, group, the three
   visibility axes, and which surfaces it appears on) lives in
   config/navManifest.js. This module just PROJECTS the manifest into the
   grouped shape the sidebar renderer expects.

   `buildSidebarGroups()` walks NAV_GROUPS (the ordered list of group
   headers — id + labelKey + icon + group-level visibleFor/module gate) and,
   for each, collects the manifest entries whose `group` matches AND whose
   `surfaces` includes 'sidebar'. The resulting array is byte-for-byte the
   same grouped shape the old hand-written `navGroups` produced — same order,
   same icons, same labelKeys, same per-item gates — so this is a pure
   refactor with ZERO visual change.
*/
function buildSidebarGroups() {
  const sidebarItems = NAV_MANIFEST.filter((d) => d.surfaces.includes("sidebar"));
  return NAV_GROUPS.map((g) => ({
    id: g.id,
    labelKey: g.labelKey,
    icon: g.icon,
    visibleFor: g.visibleFor,
    requiresAnyModule: g.requiresAnyModule,
    items: sidebarItems.filter((d) => d.group === g.id),
  }));
}
const navGroups = buildSidebarGroups();

/** Filter nav groups based on active branch business_type, the owner's
 *  enabled vertical modules, tier entitlements, and (later) pillar
 *  relevance toggles.
 *
 *  This is now a thin wrapper over filterDestinations() from the manifest:
 *  per-item visibility (business_type + module hide, requiresFeature
 *  locked-but-visible, hidden-pillar relevance hide) is resolved there.
 *  This function keeps the Layout-specific concerns the manifest is
 *  deliberately surface-agnostic about:
 *    • group-level visibleFor / requiresAnyModule gating
 *    • App-Store native compliance (drop locked entries entirely on the
 *      native shell — the manifest never hides a tier-locked item; the
 *      caller decides whether to render or suppress the lock)
 *    • dropping a group once all its items are filtered out
 *
 *  `hiddenPillars` (the RELEVANCE axis) is now threaded in from usePillars
 *  (C9). An OFF pillar's destinations drop out of the sidebar entirely —
 *  while staying reachable via a deep link (PillarGate interstitial) and ⌘K.
 *  Accountant-view / logged-out yield an empty Set upstream, so a revisor
 *  always sees the full nav.
 */
function filterNavGroups(groups, branchType, businessTypes, enabledModules, hasFeature, entReady = true, hiddenPillars = new Set(), archetypeId = null, activation = null, isStaffMember = false) {
  const activeTypes = branchType ? [branchType] : businessTypes;
  const enabled = enabledModules instanceof Set ? enabledModules : new Set();
  const featReady = entReady !== false;
  // ACTIVATION axis (4th) — defaults are fail-open (no Set, gate inert), so an
  // absent activation arg leaves the nav IDENTICAL to before this axis existed.
  const act = activation || {};

  // Group-level gate (mirrors the legacy group filter): the group's own
  // visibleFor + requiresAnyModule must pass before we look at its items.
  const passesType = (vf) => {
    if (!vf) return true;
    if (!activeTypes || activeTypes.length === 0) return true;
    return vf.some((t) => activeTypes.includes(t));
  };
  const passesAnyModule = (reqAny) => {
    if (!reqAny) return true;
    return reqAny.some((m) => enabled.has(m));
  };

  // Shared per-item context for filterDestinations. hiddenPillars is the
  // owner's OFF-list (usePillars); an OFF pillar's items are dropped here.
  const ctx = {
    businessTypes: activeTypes,
    enabledModules: enabled,
    hasFeature,
    featReady,
    hiddenPillars: hiddenPillars instanceof Set ? hiddenPillars : new Set(),
    archetypeId,
    // ACTIVATION axis — dormant relevant in-scope pillars drop from the dense
    // sidebar (re-surface as "Sæt op" tiles in PillarDiscovery). Fail-open
    // defaults leave this inert for established owners / flag-off.
    activatedPillars: act.activatedPillars instanceof Set ? act.activatedPillars : undefined,
    isInScope: act.isInScope === true,
    activationEnabled: act.activationEnabled === true,
    // OWNER-ONLY axis — hide the owner's financial surfaces (Reports & MOMS,
    // Tax) from invited staff members. Owner + accountant are not staff.
    isStaffMember,
  };

  return groups
    .filter((g) => passesType(g.visibleFor) && passesAnyModule(g.requiresAnyModule))
    .map((g) => {
      // filterDestinations returns survivors with a resolved `locked` flag.
      // It NEVER drops a tier-locked entry — that's the UpgradeNudge funnel.
      let items = filterDestinations(g.items, ctx);
      // App Store compliance (Apple 3.1.1): the native shell must not show a
      // feature the account can't use (the lock would link to a purchase
      // surface). Drop locked entries entirely on native; web keeps the
      // locked-but-visible upsell.
      if (isNativeApp()) {
        items = items.filter((item) => !item.locked);
      }
      return items.length > 0 ? { ...g, items } : null;
    })
    .filter(Boolean);
}

// Personal-mode sidebar items now project from config/personalNav.js — the
// same list the mobile bottom bar renders from. They used to be two
// hand-maintained lists and they disagreed: this sidebar showed the personal
// nav while the bar underneath showed Home/Sales/I dag.
const personalNav = personalNavFor("sidebar");

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
      // Khata (customer credit ledger) hidden for the Denmark-first product —
      // see navManifest.js. Reversible: restore this line to bring it back.
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
  // #379: a shared device that isn't revealed hides the owner's financial nav
  // items too (not just curtains the pages) — treat "locked owner" like a staff
  // member for the ownerOnly nav gate.
  const { enabled: _devShared, locked: _devLocked } = useDeviceShare();
  const _ownerFinancialsHidden = isStaffMemberRole(user?.role) || (_devShared && _devLocked);
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
  // App mode is DERIVED from the account, never seeded from storage — see
  // lib/appMode.js for why. A business account is always in business mode,
  // whatever the stored key says, so no owner can be stranded in the 3-item
  // personal nav by a button they tapped once. The switcher below is the
  // only writer, and it only exists for personal accounts.
  const canPersonal = canUsePersonalMode(user);
  const [personalPref, setPersonalPref] = useState(() => resolveMode(user));
  const mode = canPersonal ? personalPref : "business";

  // Hygiene only — correctness never depends on this having run (resolveMode
  // already ignores the key for these accounts). Kept out of resolveMode so
  // that stays a pure read.
  useEffect(() => {
    if (user && !canPersonal) clearStoredMode();
  }, [user, canPersonal]);

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

  // RELEVANCE axis (C9) — the owner's OFF-list of pillars. Empty Set for
  // accountant-view / logged-out (the provider no-ops those), so a revisor
  // never loses a nav entry to a pillar toggle.
  const { hiddenPillars } = usePillars();

  // ACTIVATION axis (4th) — dormant relevant in-scope pillars drop from the
  // dense nav and re-surface as "Sæt op" tiles. Fail-open everywhere (loading /
  // error / accountant / established-owner / flag-off → everything activated),
  // so a revisor and every existing owner see the EXACT nav they see today.
  const activation = useActivation();
  // i18n — declared HERE (above the graduation effect below) so that effect's
  // dependency array can reference `t` without a temporal-dead-zone crash
  // (deps arrays are evaluated during render). Was previously declared ~100
  // lines down, which crashed Layout → the whole app, on every load.
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  // Track a dormant→active GRADUATION so we can fire a quiet undo-toast when a
  // just-used feature graduates into the nav. We watch the activated-Set
  // membership across renders (one-directional: never auto-dormant).
  const prevActivatedRef = useRef(null);
  const { show: showGraduationToast, ToastUI: graduationToastUI } = useUndoToast();
  useEffect(() => {
    if (isAccountant) return;
    if (!activation?.isInScope || !activation?.activationEnabled) return;
    const cur = activation.activatedPillars instanceof Set ? activation.activatedPillars : null;
    if (!cur) return;
    const prev = prevActivatedRef.current;
    // First settle — snapshot without toasting (no transition to report).
    if (prev instanceof Set) {
      for (const pid of cur) {
        // A pillar that was NOT activated last time but IS now → it graduated.
        if (!prev.has(pid)) {
          const label = PILLAR_DISPLAY_BY_ID[pid]
            ? (t(PILLAR_DISPLAY_BY_ID[pid].labelKey) || pid)
            : pid;
          showGraduationToast({
            message: t("activationGraduatedToast").replace("{feature}", label),
            // One-directional model: no real undo (we never auto-dormant). The
            // toast is a quiet "this is now in your menu" confirmation; tapping
            // undo simply dismisses (re-hiding would fight the usage row).
            onUndo: async () => { /* no-op: graduation is one-directional */ },
          });
          break; // one toast per settle is plenty (anti-spam)
        }
      }
    }
    prevActivatedRef.current = new Set(cur);
  }, [activation, isAccountant, t, showGraduationToast]);

  // Filter sidebar groups by both business_type (branch) and enabled modules
  const baseVisible = isAccountant
    ? accountantNavGroups
    : filterNavGroups(navGroups, branchType, businessTypes, enabledModules, hasFeature, entReady, hiddenPillars, archetypeIdFor(branchType || user?.business_type), activation, _ownerFinancialsHidden);
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
          icon: "Shield",
          visibleFor: null,
          items: [
            { to: "/admin", icon: "Shield", labelKey: "platformAdmin" },
            { to: "/admin/support", icon: "MessageSquare", labelKey: "platformSupport" },
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

  // Personal accounts only — the button is gated on canPersonal, so this is
  // unreachable for a business owner. It writes the sub-preference, not the
  // mode itself: what the account IS still comes from business_type.
  const toggleMode = () => {
    const next = mode === "business" ? "personal" : "business";
    setPersonalPref(next);
    setStoredMode(next);
    navigate(next === "personal" ? "/personal" : "/dashboard");
    closeSidebar();
  };

  // iOS native hooks — no-op on web
  useAppLifecycle();      // token check on resume, offline sync, deep links
  useKeyboardAvoidance(); // keyboard pushes content up, scrolls to focused input

  // Route-history recorder — mounted ONCE here so every owner route change is
  // recorded into per-user storage. Side-effect only (renders nothing); the
  // ResumeRow affordance at the top of the nav reads this back. It self-gates:
  // only real owner manifest destinations are recorded, never the current path,
  // and never under a pre-auth (anon) key. See hooks/useRouteHistory.jsx.
  useRouteHistoryRecorder();

  const vatTerms = getVatTerms(user?.currency);
  const [dark, toggleDark] = useDarkMode();
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
        {t("layoutSkipToMainContent", "Skip to main content")}
      </a>
      {/* Task #49 — Sticky banner for accountant sessions. Renders its own
          markup only when user.role === "accountant"; otherwise null. */}
      {isAccountant && (
        <Suspense fallback={null}>
          <AccountantViewBanner />
        </Suspense>
      )}
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between gap-3" style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingLeft: "env(safe-area-inset-left, 0px)", paddingRight: "env(safe-area-inset-right, 0px)" }}>
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
          {/* Shared-device ("Delt enhed") reveal/hide chip — only shows when the
              owner flagged THIS device shared (#379). */}
          <DeviceShareChip />
          <button
            onClick={() => setSearchOpen(true)}
            aria-label={t("search") || "Search"}
            className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          </button>
          {/* BonBox AI — mobile entry. The floating orb is desktop-only now
              (C4); on phones the AI lives here in the header beside search +
              bell. Clicking dispatches to BonBoxAgent's hidden
              [data-bonbox-agent-toggle] trigger, opening the same chat panel.
              emerald-600 keeps the brand-AI moment recognizable as the orb. */}
          <button
            onClick={() => {
              document.querySelector("[data-bonbox-agent-toggle]")?.click();
            }}
            aria-label={t("openBonBoxAi")}
            className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition"
          >
            <Icon name="Sparkles" size={20} strokeWidth={2} />
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
        {/* Mode switcher — personal ACCOUNTS only. A business owner knows
            they are a business; the label told them nothing and the swap led
            to a personal-finance app they never asked for. Hidden, not
            disabled: a control that opens nothing is a dead end.

            Personal accounts keep it — it is their only one-tap route into
            the business app and back. */}
        {canPersonal && (
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
        )}

        {/* Global search trigger — kept compact + visually quiet so it reads
            as an ambient action rather than a primary CTA. Borderless,
            smaller padding + smaller text, with just an icon + faded label,
            and the ⌘K hint hugging the right edge. (It used to be tuned to
            sit under the mode switcher without competing; that switcher is
            now personal-only, so for a business owner this is simply the
            first thing in the sidebar.) */}
        <div className="px-3 pb-1 flex items-center gap-1">
          <button
            onClick={() => setSearchOpen(true)}
            aria-label={t("search") || "Search"}
            className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition
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
          {/* Desktop notification bell — the mobile top-bar has its own; this
              brings the bell + Live-alerts toggle to the wide web view too.
              align="left" so its dropdown opens rightward into the content,
              not off the left edge from the sidebar. */}
          <span className="hidden md:block shrink-0">
            <NotificationCenter align="left" />
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 pb-2 scrollable scroll-smooth">
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
              {/* RESUME (Fortsæt) — quiet "pick up where you left off" cluster
                  pinned at the TOP of the nav, above the groups. Shows up to 2
                  genuinely-recent OTHER destinations as one-tap links, resolved
                  through the SAME visibility/tier filter the sidebar uses.
                  Renders null when there's no qualifying history (new owners,
                  or only the current page in history) and for accountant-view —
                  never a placeholder, never a fabricated suggestion. */}
              {!isAccountant && (
                <ResumeRow enabledModules={enabledModules} onNavigate={closeSidebar} />
              )}
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
              {/* DISCOVERY FLOOR (C10) — pinned "Tilføj funktioner" at the
                  bottom of the nav. Lists the owner's OFF pillars as muted
                  one-tap "Slå til" rows so a hidden pillar is always re-
                  findable. Renders null when nothing is hidden, and for
                  accountant-view (empty hiddenPillars Set upstream), so a
                  revisor never sees it. */}
              {!isAccountant && (
                <PillarDiscovery variant="sidebar" onNavigate={closeSidebar} />
              )}
            </div>
          )}
        </nav>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-gray-100 dark:border-gray-700 space-y-0.5" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)" }}>
          <NavLink
            to="/profile"
            onClick={closeSidebar}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${isActive ? activeClass : inactiveClass}`
            }
          >
            <span className="w-5 flex items-center justify-center"><Icon name="User" size={14} /></span>
            {t("profile")}
          </NavLink>
          {/* Help & feedback — the discoverable desktop entry to the support
              composer (the floating "?" is mobile-only). Dispatches
              SupportChip.OPEN_SUPPORT_EVENT ("bonbox:open-support"); the chip's
              global listener opens the modal (z-50) over everything. */}
          <button
            onClick={() => { closeSidebar(); window.dispatchEvent(new Event("bonbox:open-support")); }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
          >
            <span className="w-5 flex items-center justify-center"><Icon name="MessageSquare" size={14} /></span>
            {t("helpFeedback") || "Help & feedback"}
          </button>
          <button
            onClick={toggleDark}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
          >
            <span className="w-5 flex items-center justify-center"><Icon name={dark ? "Sun" : "Moon"} size={14} /></span>
            {dark ? t("lightMode") : t("darkMode")}
          </button>
          {/* Language — same footer-row treatment as Profile / Dark mode:
              a Lucide Globe + the short code (EN / DK), no flag emoji, no
              bordered box. Keeps the footer one consistent icon+text set so
              the dark-mode glyph sits flush with its neighbours. */}
          <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition">
            <span className="w-5 flex items-center justify-center"><Icon name="Globe" size={14} /></span>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              aria-label="Language"
              className="bg-transparent text-xs font-medium outline-none cursor-pointer pr-1"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.short}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition font-medium"
          >
            <span className="w-5 flex items-center justify-center"><Icon name="LogOut" size={14} /></span>
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
          {/* Smart Scan FAB removed in C4 (FAB merge): "snap anything" now
              lives as the first option inside the QuickAdd sheet, reached on
              mobile via the bottom-tab center "+" and on desktop via the
              QuickAdd "+". One fewer floating button on phones. */}
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

      {/* Activation graduation toast — quiet "{feature} is now in your menu"
          confirmation fired when a dormant pillar flips active (the owner just
          used it). One-directional (never auto-dormant); see the useEffect
          above. Renders null when no graduation has occurred. */}
      {graduationToastUI}
    </div>
  );
}

// Routes where floating action buttons should be suppressed.
const _HIDE_FLOATING_ON = ["/pricing", "/subscription"];
