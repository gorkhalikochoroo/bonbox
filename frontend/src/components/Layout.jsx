import { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
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
import { syncStatusBar } from "../utils/statusBar";
import { filterDestinations, sidebarGroupsFor, PILLAR_DISPLAY_BY_ID, isStaffMemberRole, pillarIsScopedOffTheRail } from "../config/navManifest";
import {
  NAV_FOCUS_RING,
  NAV_GROUPS_STORAGE_KEY,
  NAV_MUTED,
  NAV_MUTED_HOVER,
  isNavGroupOpen,
  readNavGroups,
  toggleNavGroup,
} from "../config/navChrome";
import { isFloatingChromeHidden } from "../config/floatingChrome";
import { clickHiddenTrigger } from "../utils/hiddenTrigger";
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

   `sidebarGroupsFor(archetypeId)` (config/navManifest.js) walks NAV_GROUPS
   (the ordered list of group headers — id + labelKey + icon + group-level
   visibleFor/module gate) and, for each, collects the manifest entries whose
   `group` matches AND that appear on this owner's sidebar. The resulting array
   is the same grouped shape the old hand-written `navGroups` produced — same
   order, same icons, same labelKeys, same per-item gates.

   It takes an ARCHETYPE, because the sidebar surface is archetype-aware
   (C12b: the four rare rows a restaurant or bar never opens are off the
   sidebar for those two archetypes and on More + ⌘K instead). The resolver is
   isOnSurface() in the manifest, so a per-archetype override lives next to the
   destination it narrows, and no other surface has to know about it.

   The projection itself lives in the manifest (it is pure data, and a guard
   test has to resolve a rail without mounting this shell). What stays HERE is
   everything surface-specific: filterNavGroups below.
*/
// Tailwind's `md` breakpoint in px. The aside is pinned open at/above it
// (`md:translate-x-0`) and an off-canvas drawer below it. Kept as a named
// constant so the JS mirror of that CSS fact can't silently drift from it.
const MD_BREAKPOINT = 768;


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
    // USAGE GATE — a pillar this owner has never used (today: Events) is not
    // in the sidebar at all. Cohort-wide + flag-free, unlike the activation
    // axis above; it returns the moment the first real row exists.
    usageDormant: act.usageDormantPillars instanceof Set ? act.usageDormantPillars : undefined,
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
    // navReportsMoms, not navReports — the owner rail's own header key, which
    // this nav claims to mirror. navReports resolves to the bare noun
    // ("Rapporter" / "Reports" / "Raporlar"), i.e. character-for-character the
    // row below it once that row stopped repeating the group's name. A header
    // and its second row reading the same word is the defect the owner rail
    // was just cleaned of; it would have been re-created here, on the surface
    // a revisor sees. This key already exists in every loaded locale and keeps
    // MOMS Danish.
    labelKey: "navReportsMoms",
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

// `findGroupForPath` used to live here to drive an auto-expand effect. It is
// gone with that effect: revealing the active group is now a DEFAULT in
// config/navChrome.js (a group with no stored choice is open), not a write —
// which is what makes a deliberate collapse survive the next visit. The
// active group is still signalled when collapsed, by the dot on its header.

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
  // Which side of `md` are we on? React needs to know, because whether the
  // rail is currently OFF-CANVAS decides whether its ~28 links belong in the
  // tab order at all — and "off-canvas" means different things above and below
  // the breakpoint. From innerWidth, not matchMedia: this component already
  // tracks width that way, and jsdom ships no matchMedia.
  const [isMdUp, setIsMdUp] = useState(() => {
    try { return typeof window === "undefined" || window.innerWidth >= MD_BREAKPOINT; }
    catch { return true; }
  });
  // Refs for focus return (WCAG 2.4.3). Opening the drawer moves focus into
  // it; closing hands focus back to the control that opened it, instead of
  // dropping the keyboard user on <body> when `inert` blurs the drawer.
  const asideRef = useRef(null);
  const menuButtonRef = useRef(null);
  const drawerCloseRef = useRef(null);
  const drawerWasOpenRef = useRef(false);
  // Desktop-only: persist whether the user has collapsed the sidebar
  // for more horizontal real estate (Claude-style hide). Mobile uses
  // the existing sidebarOpen overlay model — this flag is ignored
  // there.
  //
  // The rail starts OPEN unless the owner has said otherwise. There is no
  // viewport guess left, and the reason is arithmetic rather than taste.
  //
  // This flag only ever reaches the DOM through `md:` classes — the rail's
  // `md:-translate-x-full`, main's `md:ml-0`, the floating re-open button's
  // `hidden md:flex` — and `md` is 768. Below 768 the rail is governed by
  // `sidebarOpen` (the drawer) instead, so the flag is inert there. The old
  // default fired below 1024. Intersect the two and its ENTIRE effective range
  // was 768–1023px: exactly the band where the mobile top bar and the bottom
  // tab bar are both `md:hidden`, so collapsing the rail leaves one unlabelled
  // 44px floating button as the whole of navigation. The guess could only ever
  // apply where it cost the most, and it cost it to an owner who had not asked
  // for anything.
  //
  // The width it was buying back is still available — one click on the hide
  // button, which writes the key and persists forever. That is the trade the
  // right way round: the owner spends a click to gain width, instead of
  // spending their navigation to gain width they did not ask for.
  const [desktopSidebarHidden, setDesktopSidebarHidden] = useState(() => {
    try {
      const saved = localStorage.getItem("bonbox_sidebar_hidden");
      return saved === "1";
    } catch {
      return false; // private mode — open is the safe direction for navigation
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

  // Width tracking for resize + orientationchange (iPad rotating from portrait
  // to landscape, a window dragged narrower, etc). Cleans up on unmount.
  //
  // This used to ALSO re-apply the <1024px collapse default on every resize
  // for anyone without a stored preference — so narrowing a window mid-session
  // took the rail away from an owner who had not asked for that, in the one
  // band (768–1023px) where the mobile top bar and the bottom tab bar are both
  // `md:hidden` and the floating re-open button is the ONLY way back.
  //
  // Nothing but an explicit click moves the rail now, in either direction. No
  // one-directional "reveal on widen" either: with the width guess gone (see
  // the initialiser above) there is no auto-collapse left for a widen to undo,
  // so re-opening on resize would only ever override a deliberate collapse.
  useEffect(() => {
    const onResize = () => {
      // Whether the rail is off-canvas means different things either side of
      // `md`, so this must keep tracking — see navOffCanvas.
      setIsMdUp(window.innerWidth >= MD_BREAKPOINT);
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

  // The resolved archetype — hoisted out of the filterNavGroups call because
  // the SIDEBAR SURFACE itself is archetype-aware now (C12b), not just the
  // per-item visibility axes. Branch type wins over the account's own type, so
  // an owner standing in a restaurant branch gets the restaurant's rail.
  // DECLARED HERE, above the graduation effect below, so that effect's
  // dependency array can reference it without a temporal-dead-zone crash
  // (deps arrays are evaluated during render — the same trap that once took
  // Layout, and with it the whole app, down over `t`).
  const archetypeId = archetypeIdFor(branchType || user?.business_type);

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
          // …but only SAY "er nu i din menu" if the menu can honour it. A
          // pillar whose every destination is off the rail for scope (today:
          // Events) never appears in the nav, activated or not — toasting it
          // would be a claim the sidebar contradicts one glance later. The
          // pillar still graduates; we just stay quiet about it. Re-adding
          // "sidebar" to the manifest entry restores the toast with no edit
          // here (see pillarIsScopedOffTheRail).
          if (pillarIsScopedOffTheRail(pid, archetypeId)) continue;
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
  }, [activation, isAccountant, archetypeId, t, showGraduationToast]);

  // (`archetypeId` is declared above, next to `isAccountant`.)
  // Rebuilt only when the archetype changes — everything else about the
  // sidebar surface is static manifest data.
  const navGroups = useMemo(() => sidebarGroupsFor(archetypeId), [archetypeId]);

  // Filter sidebar groups by both business_type (branch) and enabled modules
  const baseVisible = isAccountant
    ? accountantNavGroups
    : filterNavGroups(navGroups, branchType, businessTypes, enabledModules, hasFeature, entReady, hiddenPillars, archetypeId, activation, _ownerFinancialsHidden);
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

  // The owner's EXPLICIT collapse choices — `{ [groupId]: boolean }`, the same
  // shape (and key) owners already have in localStorage. Absence means "no
  // choice", which resolves to open; see config/navChrome.js for why that
  // single-writer model is what makes a collapse stick.
  const [openGroups, setOpenGroups] = useState(() => {
    try { return readNavGroups(localStorage.getItem(NAV_GROUPS_STORAGE_KEY)); }
    catch { return {}; }
  });

  // Persist. This is now the ONLY writer. The auto-expand effect that used to
  // sit above it wrote `true` for the active group on every navigation and
  // persisted that, so the owner's `false` was erased the next time they opened
  // a page in that group — the rail could only ever get more open.
  useEffect(() => {
    try { localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(openGroups)); }
    catch { /* private mode / quota — the rail just won't remember */ }
  }, [openGroups]);

  const toggleGroup = (gid) => {
    setOpenGroups((prev) => toggleNavGroup(prev, gid));
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
  // Native shell: keep the iOS/Android status bar in step with the theme
  // (light text on dark, dark text on light). No-op on web.
  useEffect(() => {
    syncStatusBar(dark);
  }, [dark]);
  usePageTracking();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const closeSidebar = () => setSidebarOpen(false);

  // Close the drawer on ANY navigation, not just taps on its own links.
  //
  // The bottom tab bar is a separate component and knows nothing about this
  // state, so tapping Home/Sales/Today/More with the drawer open changed the
  // page BEHIND it and left the drawer sitting over the thing you had just
  // navigated to. Reproduced on two accounts. Keying off location covers every
  // route change — tab bar, deep link, programmatic — rather than patching the
  // one entry point that happened to be noticed.
  //
  // Desktop is unaffected: the aside is pinned open by md:translate-x-0, which
  // overrides sidebarOpen entirely.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Is the rail translated fully out of view right now? Below `md` that's
  // "drawer closed"; at/above it, "owner collapsed the desktop sidebar". Both
  // states were hidden by TRANSFORM ALONE, which moves pixels and nothing
  // else: the ~28 links stayed in the tab order and in the accessibility tree,
  // so a keyboard user tabbing from the skip-link, or a screen-reader user
  // swiping forward, walked the entire invisible nav before reaching the page.
  const navOffCanvas = isMdUp ? desktopSidebarHidden : !sidebarOpen;

  // Focus choreography for the phone drawer (WCAG 2.4.3 Focus Order).
  //   open  → put focus on the drawer's close button, so the next Tab walks
  //           the nav the user just asked for rather than the page behind it.
  //   close → hand focus back to the hamburger that opened it, but ONLY if
  //           focus is still inside the drawer (or already lost to <body>,
  //           which is where the browser drops it the instant `inert` lands).
  //           Anything else means something on the page has legitimately taken
  //           focus since, and stealing it back would be the rude behaviour.
  useEffect(() => {
    if (sidebarOpen) {
      drawerWasOpenRef.current = true;
      drawerCloseRef.current?.focus();
      return;
    }
    if (!drawerWasOpenRef.current) return;  // never opened — nothing to return
    drawerWasOpenRef.current = false;
    const active = document.activeElement;
    const inDrawer = asideRef.current && active && asideRef.current.contains(active);
    if (!active || active === document.body || inDrawer) {
      menuButtonRef.current?.focus();
    }
  }, [sidebarOpen]);

  // Accounting-software style: neutral gray bg + bold dark text on the active
  // item (Dinero/Billy/e-conomic do this). Avoids the "tech glow" colored pill
  // that read as developer-tool aesthetic.
  // Active item: subtle gray bg (the doctrine) PLUS a 2px brand-accent inset
  // left rail drawn via box-shadow so it doesn't shift the icon/text layout
  // (every NavLink — top-level AND sub-item — has different left padding;
  // using box-shadow keeps that geometry untouched). That rail is the only
  // brand-green moment in the nav. Everything else stays neutral.
  // See "BRAND GREEN" block in index.css for the token contract.
  //
  // THE FOUNDER PICKED GREEN (Sep 2026). The open question this comment used to
  // carry — green rail vs the venue theme's blue — is closed: BonBox green is
  // the identity, the four venue themes tint CONTENT, not identity.
  //
  // The token is --brand-green-accent, which FLIPS by theme. The rail was a
  // fixed emerald-500 and measured 2.30:1 against this row's own light
  // background (#f3f4f6) — below the 3:1 WCAG non-text floor, i.e. the one
  // indicator telling you where you are was the least visible thing in the
  // rail. It is emerald-600 in light (3.42:1) and emerald-400 in dark (6.25:1).
  //
  // Both strings carry NAV_FOCUS_RING (config/navChrome.js). Every nav row on
  // the rail composes one of these two, so putting it here is what makes the
  // sweep exhaustive rather than a list of rows someone remembered.
  const activeClass = `bg-gray-100 dark:bg-gray-700/60 text-gray-900 dark:text-white font-semibold shadow-[inset_2px_0_0_0_rgb(var(--brand-green-accent))] ${NAV_FOCUS_RING}`;
  const inactiveClass = `text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-white ${NAV_FOCUS_RING}`;

  return (
    /* Rung 0 of the SURFACE LADDER — the page ground every card sits on. Was a
       hard-coded `bg-slate-50 dark:bg-gray-900` pair, which is the same value
       ui/Card.jsx was painting its DARK cards, so a card and the page under it
       were the same colour. One token now, one answer. */
    <div className="min-h-screen bg-[rgb(var(--surface-ground))]">
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
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 glass border-b border-gray-200/70 dark:border-gray-700/70 px-4 py-3 flex items-center justify-between gap-3" style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingLeft: "env(safe-area-inset-left, 0px)", paddingRight: "env(safe-area-inset-right, 0px)" }}>
        <button
          ref={menuButtonRef}
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
        {/* Mobile top-bar wordmark + the brand mark. The tile is the saturated
            brand-green moment per the BRAND GREEN token block in index.css —
            on the token now, not a raw `bg-emerald-600` class, so the mark and
            the sidebar's mark cannot drift apart. Deliberately the SAME green
            in light and dark: a logo that changes hue is a different logo.
            Tile holds an inverted version of the favicon shape (notepad lines)
            so it reads as the BonBox logo even at 24px. */}
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-[rgb(var(--brand-green))] text-[rgb(var(--brand-green-on))] rounded-md flex items-center justify-center shrink-0" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <path d="M8 8h8M8 12h8M8 16h5" />
            </svg>
          </div>
          {/* Wordmark, NOT a heading. This and the sidebar's wordmark were both
              <h1>, so every page shipped two document headings on top of the
              page's own — and the sidebar one is the copy that survives at
              every breakpoint (this bar is md:hidden), so that is the one that
              stays an <h1>. Same size and weight; only the tag changed. */}
          <p className="text-base font-bold text-gray-900 dark:text-gray-100">BonBox</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Shared-device ("Delt enhed") reveal/hide chip — only shows when the
              owner flagged THIS device shared (#379). */}
          <DeviceShareChip />
          {/* Help — moved out of the floating bottom-left chip (which sat over
              content above the tab bar) into the header, where the other global
              actions live. Dispatches the same OPEN_SUPPORT_EVENT the sidebar's
              "Help & feedback" row uses, so all three entry points open one
              composer. Placed FIRST in a right-aligned row on purpose: the group
              grows leftward, so search/AI/bell keep their learned positions. */}
          <button
            onClick={() => window.dispatchEvent(new Event("bonbox:open-support"))}
            aria-label={t("supportChipAria") || "Get help / send feedback"}
            className="text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition"
          >
            <Icon name="HelpCircle" size={20} strokeWidth={2} />
          </button>
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
              The brand accent keeps the AI moment recognizable as the orb —
              on --brand-green-accent, which already resolves to emerald-600 in
              light and emerald-400 in dark, so this is the same two colours it
              shipped, minus the hand-written theme pair that could drift.

              The `?.click()` this used to be could not tell "panel opened"
              from "nothing was there" — and on /subscription nothing WAS
              there. BonBoxAgent is mounted everywhere now, so the remaining
              miss is its lazy chunk still in flight; the owner tapped ✨ to ask
              BonBox something, so the question still gets somewhere to go.

              The fallback NAVIGATES rather than dispatching bonbox:open-support
              the way the "?" beside it does. That event's only listener is
              SupportChip — a lazy sibling of the very component we just failed
              to find — so in the one situation this fallback exists for, it was
              firing into a subtree that was not there either. A fallback may
              not depend on a sibling of the thing that was missing. /feedback
              is a real route, rendered by the router, and it says "tell us
              anything — a bug, an idea, a question": not the assistant, but
              visibly somewhere rather than invisibly nowhere. */}
          <button
            onClick={() => {
              if (clickHiddenTrigger("[data-bonbox-agent-toggle]")) return;
              navigate("/feedback");
            }}
            aria-label={t("openBonBoxAi")}
            className="text-[rgb(var(--brand-green-accent))] hover:text-[rgb(var(--brand-green-hover))] transition"
          >
            <Icon name="Sparkles" size={20} strokeWidth={2} />
          </button>
          <NotificationCenter />
        </div>
      </div>

      {/* Overlay (scrim).
          z-[55] — ABOVE MobileBottomNav's z-50, not below it. The scrim used to
          be z-40, so the tab bar stayed bright and tappable through an "open"
          drawer: you could dim the app and still hit Home/Sales underneath. A
          scrim that doesn't cover the whole app isn't a scrim. */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-[55] bg-black/40" onClick={closeSidebar} aria-hidden="true" />
      )}

      {/* Sidebar.
          Mobile: slide-in/out via sidebarOpen (existing behavior).
          Desktop: visible by default; user can collapse via the chevron
          button in the header. When collapsed, the floating "show
          sidebar" button below renders at the left edge for one-tap
          re-open. State persists in localStorage. */}
      <aside
        ref={asideRef}
        id="primary-navigation"
        aria-label={t("primaryNavigation") || "Primary navigation"}
        /* `inert` takes the off-canvas rail out of BOTH the tab order and the
           accessibility tree. Transform alone left ~28 invisible links in
           front of the page for every keyboard and screen-reader user. It is
           deliberately NOT a plain aria-hidden: aria-hidden on a subtree whose
           children are still tabbable is its own violation (focus lands on a
           control the screen reader refuses to announce). */
        inert={navOffCanvas || undefined}
        /* z-50 at rest, z-[60] while the phone drawer is open — above
           MobileBottomNav (z-50), which renders AFTER this element and so won
           the tie at equal z and covered the bottom of the drawer, Log ud
           included. Conditional rather than a flat z-[60] on purpose: the
           DESKTOP rail must stay at z-50, or every page-level modal (z-50,
           rendered later in <main>) would slide UNDER the pinned sidebar. */
        /* The shell sits on rung 1 of the SURFACE LADDER — the SAME rung as a
           resting card, in both themes. In light the sidebar has always been
           white, i.e. exactly a card; dark now matches instead of leaving the
           rail above the cards in one theme and level with them in the other.
           Same pixels as the `bg-white dark:bg-gray-800` this replaces; the
           point is that it is now the same TOKEN the cards read. */
        className={`fixed top-0 left-0 h-full w-56 bg-[rgb(var(--surface-card))] border-r border-[rgb(var(--surface-line))] flex flex-col ${
          sidebarOpen ? "z-[60]" : "z-50"
        } ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } ${desktopSidebarHidden ? "md:-translate-x-full" : "md:translate-x-0"}`}
        style={{
          paddingTop: "env(safe-area-inset-top, 0px)",
          // FALLBACK for any target without `inert` (pre-Safari 15.5 — our
          // build target is Safari 16+, so this is belt-and-braces, not load-
          // bearing): visibility:hidden is the one property that removes a
          // subtree from the tab order AND the a11y tree in every browser.
          // The transition is written out here rather than left to Tailwind's
          // `transition-transform duration-200` because visibility must flip
          // on a DELAY when hiding (after the slide finishes, so the drawer
          // still animates out) and instantly when showing.
          visibility: navOffCanvas ? "hidden" : "visible",
          transitionProperty: "transform, visibility",
          transitionDuration: "200ms, 0s",
          transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
          transitionDelay: navOffCanvas ? "0s, 200ms" : "0s, 0s",
        }}>
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-2">
          <div className="min-w-0">
            {/* Wordmark — brand-green tile + gray-900 wordmark. The tile is
                the saturated brand-green moment for the sidebar (paired with
                the active-nav left-rail on --brand-green-accent). Same token
                as the mobile top bar above, so there is one mark, not two. */}
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 bg-[rgb(var(--brand-green))] text-[rgb(var(--brand-green-on))] rounded-md flex items-center justify-center shrink-0" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="3" width="16" height="18" rx="2" />
                  <path d="M8 8h8M8 12h8M8 16h5" />
                </svg>
              </div>
              <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">BonBox</h1>
            </div>
            {/* The venue's own name — the one line that tells the owner WHICH
                account this window is. Structural, so it sits on the AA-passing
                muted tier (config/navChrome.js), not the 2.54:1 gray-400 it
                used to whisper in. */}
            <p className={`text-[11px] ${NAV_MUTED} truncate mt-1`}>{user?.business_name}</p>
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
              ref={drawerCloseRef}
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
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition
                bg-gray-50 dark:bg-gray-700/60 text-gray-800 dark:text-gray-100
                border border-gray-200 dark:border-gray-600
                hover:bg-gray-100 dark:hover:bg-gray-700 ${NAV_FOCUS_RING}`}
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
            className={`flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition
              ${NAV_MUTED} ${NAV_FOCUS_RING}
              hover:bg-gray-50 dark:hover:bg-gray-700/40 ${NAV_MUTED_HOVER}`}
          >
            <svg className="w-3 h-3 shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
            <span className="flex-1 text-left truncate">{t("search") || "Search"}</span>
            {/* text-[11px], not text-[8px]. Eight pixels is below every step on
                the type ramp (11px is the floor) and it was carrying the
                keyboard shortcut — the one thing in this row a power user
                actually has to read. Matches the label beside it now. */}
            <kbd className={`hidden md:inline-flex items-center px-1 py-0 text-[11px] font-mono ${NAV_MUTED} shrink-0`}>
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
                  <span className="flex-1 truncate">{item.labelKey ? t(item.labelKey) : item.label}</span>
                </NavLink>
              ))}
            </div>
          ) : (
            /* Business mode — grouped navigation (filtered by branch type).

               ROW RHYTHM LADDER (C2, Sep 2026). Twenty rows only read as five
               groups if the gaps say so, and they did not: the gap between one
               group and the next was `space-y-0.5` (2px) — the SAME 2px used
               between two rows INSIDE a group — and a group header sat 2px
               above its own first row. Every gap on the rail was one value, so
               the eye got a list, not groups. Three steps now, and only three:

                 2px  (space-y-0.5) between rows inside a group
                 6px  (mt-1.5)      between a group header and its first row
                12px  (mt-3)        between one group and the next

               No new surface, no icon rail, and NO type-scale change — the
               rhythm is entirely whitespace, which is the one lever that makes
               a dense rail readable without making it taller per row. */
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
                // Stored choice wins; no stored choice = open (which is what
                // reveals the group the owner just navigated into).
                const isOpen = isNavGroupOpen(openGroups, group.id);
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
                          //
                          // The row used to say "dead" and behave "live":
                          // `cursor-not-allowed` sat on the one row that turns
                          // a Free owner into a paying one, so the owner was
                          // told not to click the upgrade path they had just
                          // been shown. `opacity-60` compounded it — gray-600
                          // washed to ~3.1:1 on the white rail, under the AA
                          // floor. Now a pointer cursor and the full-opacity
                          // muted tier (4.83:1 light / 5.78:1 dark), which
                          // still reads a step quieter than an unlocked row.
                          // The Lock icon carries "locked" on its own; it does
                          // not need the row to pretend to be inert.
                          <NavLink
                            key={item.to}
                            to="/subscription"
                            onClick={closeSidebar}
                            title={(t("proFeatureUpgrade") || "Pro feature — upgrade to unlock")}
                            aria-label={(t("proFeatureUpgrade") || "Pro feature — upgrade to unlock") + " (" + (item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)) + ")"}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${NAV_MUTED} ${NAV_MUTED_HOVER} hover:bg-gray-50 dark:hover:bg-gray-700 ${NAV_FOCUS_RING}`}
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
                            {/* `truncate`, like the locked variant above
                                already had. Measured on the real 224px rail:
                                "Abonnement & betaling" is 148.7px in a 142px
                                slot — the one label that still overflows once
                                multiClose stops saying "Kasserapport · ". A
                                locked row clipped it and an unlocked row spilled
                                it, which is the asymmetry, not the width. */}
                            <span className="flex-1 truncate">{item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)}</span>
                          </NavLink>
                        )
                      ))}
                      {/* The core spine's closing rule. `mb-0` because the next
                          group brings its own 12px step (see the ladder above);
                          `my-1.5` here stacked with it and opened a gap wider
                          than any other on the rail. */}
                      <div className="h-px bg-gray-100 dark:bg-gray-700 mt-2 mb-0" />
                    </div>
                  );
                }

                // Collapsible groups — `mt-3` is the ladder's between-groups
                // step. It sits on the wrapper rather than on the header so a
                // COLLAPSED group keeps the same step as an open one.
                return (
                  <div key={group.id} className="mt-3">
                    <button
                      onClick={() => toggleGroup(group.id)}
                      /* The header IS the disclosure control for the rows under
                         it, and it said so to sighted users only (the chevron
                         rotates) — a screen-reader user got an unlabelled
                         button with no state at all. */
                      aria-expanded={isOpen}
                      /* Group headers are the organising layer — the thing that
                         makes a dense rail scannable at all. On the AA-passing
                         muted tier, not the 2.54:1 gray-400 they used to be.
                         `py-1` + the 6px step below it (mt-1.5 on the item
                         list) replaces the old `py-1.5` + 2px: the header now
                         hugs its own label and the AIR lands between the header
                         and its rows, which is what makes it read as a label
                         for what follows rather than as the first row of it. */
                      className={`w-full flex items-center gap-2 px-3 py-1 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition ${NAV_FOCUS_RING} ${
                        hasActiveChild
                          ? "text-gray-900 dark:text-gray-100"
                          : `${NAV_MUTED} ${NAV_MUTED_HOVER}`
                      }`}
                    >
                      <Icon name={group.icon} size={14} className="shrink-0 opacity-70" />
                      <span>{t(group.labelKey)}</span>
                      {/* "Your page is inside this collapsed group" dot — the
                          only thing standing in for the active row when the
                          group is shut, so it is an INFORMATIVE graphic and
                          owes the 3:1 non-text floor. As a fixed emerald-500 it
                          measured 2.54:1 on the white rail; on the accent token
                          it is 3.77:1 in light and 7.64:1 in dark. */}
                      {hasActiveChild && !isOpen && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--brand-green-accent))] ml-0.5" />
                      )}
                      <svg
                        className={`w-3 h-3 ml-auto transition-transform ${isOpen ? "rotate-180" : ""}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isOpen && (
                      /* 6px under the header (ladder step 2); no mb — the next
                         group's own mt-3 is the between-groups step, and the
                         old mb-1 made that gap depend on whether the PREVIOUS
                         group happened to be open. */
                      <div className="space-y-0.5 mt-1.5">
                        {group.items.map((item) => (
                          item.locked ? (
                            // L1 — visible-but-locked Pro feature entry.
                            // Lucide Lock icon; click routes to
                            // /subscription so the owner sees the upsell
                            // path. Multi-barrier defense: even if the L3
                            // router gate breaks, the frontend still sends
                            // the click somewhere that explains the tier
                            // instead of into a bare 402.
                            //
                            // Same repair as the core-group locked row
                            // above: `cursor-not-allowed opacity-60` told
                            // the owner the upgrade row was dead while it
                            // navigated, and washed the label under the AA
                            // floor. Pointer cursor + the full-opacity
                            // muted tier; the Lock icon is the signal.
                            <NavLink
                              key={item.to}
                              to="/subscription"
                              onClick={closeSidebar}
                              title={(t("proFeatureUpgrade") || "Pro feature — upgrade to unlock")}
                              aria-label={(t("proFeatureUpgrade") || "Pro feature — upgrade to unlock") + " (" + (item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)) + ")"}
                              className={`flex items-center gap-2.5 pl-5 pr-3 py-1.5 rounded-lg text-[13px] font-medium transition cursor-pointer ${NAV_MUTED} ${NAV_MUTED_HOVER} hover:bg-gray-50 dark:hover:bg-gray-700 ${NAV_FOCUS_RING}`}
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
                              <span className="flex-1 truncate">{item.dynamic ? vatTerms.sidebarLabel : t(item.labelKey)}</span>
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
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition ${NAV_FOCUS_RING}`}
          >
            <span className="w-5 flex items-center justify-center"><Icon name="MessageSquare" size={14} /></span>
            {t("helpFeedback") || "Help & feedback"}
          </button>
          <button
            onClick={toggleDark}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition ${NAV_FOCUS_RING}`}
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
              className={`bg-transparent text-xs font-medium outline-none cursor-pointer pr-1 rounded ${NAV_FOCUS_RING}`}
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
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition font-medium ${NAV_FOCUS_RING}`}
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
          /* Rung 2 (raised) of the SURFACE LADDER — this button floats OVER
             the page with nothing under it, which is the one piece of chrome
             that genuinely sits above a card. Its focus-ring offset is the
             GROUND, because that is what is actually behind it. */
          className="hidden md:flex fixed top-4 left-4 z-40 items-center justify-center w-11 h-11 rounded-lg bg-[rgb(var(--surface-raised))] border border-[rgb(var(--surface-line))] text-gray-600 dark:text-gray-300 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white hover:border-[rgb(var(--surface-line-strong))] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(var(--surface-ground))]"
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

      {/* Floating widgets — MOUNTED ON EVERY ROUTE.
          The quiet-on-/subscription rule still holds, but it is now each
          component's own job (config/floatingChrome.js): it hides that
          component's floating BUTTON, not the sheet behind it. Layout used to
          drop the whole subtree, which also removed the hidden triggers that
          other surfaces click — so on /subscription the phone tab bar's centre
          "+" opened nothing, the mobile header's ✨ opened nothing, and both
          Help entries (header "?" and the sidebar's Help & feedback row)
          dispatched an event with no listener. Three dead CTAs on ONE route,
          to hide two buttons — the list's other entry, /pricing, is a redirect
          and was never a rendered surface at all. */}
      {/* ONE BOUNDARY EACH, deliberately. A Suspense boundary commits none of
          its children while ANY of them is still resolving, so a single shared
          boundary made these four widgets load as a unit: QuickAdd's chunk
          arriving late unmounted BonBoxAgent's trigger and SupportChip's
          listener too. "Mounted on every route" has to mean at every moment,
          not just once the slowest chunk lands. Separate boundaries cost four
          null fallbacks and make each widget's absence its own, short window. */}
      <Suspense fallback={null}>
        <QuickAdd />
      </Suspense>
      {/* Smart Scan FAB removed in C4 (FAB merge): "snap anything" now
          lives as the first option inside the QuickAdd sheet, reached on
          mobile via the bottom-tab center "+" and on desktop via the
          QuickAdd "+". One fewer floating button on phones. */}
      <Suspense fallback={null}>
        <BonBoxAgent />
      </Suspense>
      {/* SupportChip — the support composer. It has no floating button of
          its own any more (see its render), so it is pure listener: the
          only thing suppressing it ever did was kill both Help entries. */}
      <Suspense fallback={null}>
        <SupportChip />
      </Suspense>
      {/* InstallAppPrompt — encourages adding BonBox to the home screen.
          Self-hides when already standalone / dismissed / running in a
          Capacitor shell. This one IS just chrome — nothing else opens it —
          so it keeps the route gate, here where it is rendered. */}
      <Suspense fallback={null}>
        {!isFloatingChromeHidden(location.pathname) && <InstallAppPrompt />}
      </Suspense>

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
