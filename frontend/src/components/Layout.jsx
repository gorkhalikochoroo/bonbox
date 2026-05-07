import { useState, useEffect, lazy, Suspense } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import { getVatTerms } from "../utils/currency";
import { usePageTracking } from "../hooks/useEventLog";
import NotificationCenter from "./NotificationCenter";
import BranchSelector, { useBranch } from "./BranchSelector";
import MobileBottomNav from "./MobileBottomNav";
import { useAppLifecycle } from "../hooks/useAppLifecycle";
import { useKeyboardAvoidance } from "../hooks/useKeyboardAvoidance";

// Lazy-load heavy floating widgets — only parsed when opened
const QuickAdd = lazy(() => import("./QuickAdd"));
const BonBoxAgent = lazy(() => import("./BonBoxAgent"));
// Soft-error banner is part of the multi-layer defense — listens for graceful
// backend errors so a single failing endpoint never blanks the whole page.
const SoftErrorBanner = lazy(() => import("./SoftErrorBanner"));

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
      { to: "/dashboard", icon: "📊", labelKey: "dashboard" },
      { to: "/sales", icon: "💰", labelKey: "sales" },
      { to: "/expenses", icon: "🧾", labelKey: "expenses" },
    ],
  },
  {
    id: "money",
    labelKey: "navMoney",
    icon: "💳",
    visibleFor: null,
    items: [
      { to: "/cashbook", icon: "📒", labelKey: "cashBook" },
      { to: "/cashflow", icon: "📈", labelKey: "cashFlow" },
      { to: "/budgets", icon: "🎯", labelKey: "budgetOverview" },
      { to: "/bank-import", icon: "🏦", labelKey: "bankImport" },
      { to: "/payment-imports", icon: "💳", labelKey: "paymentImports" },
    ],
  },
  {
    id: "stock",
    labelKey: "navStock",
    icon: "📦",
    visibleFor: null,
    items: [
      // Inventory always visible — it's the general kitchen / shop / pantry stock.
      { to: "/inventory", icon: "📦", labelKey: "inventory" },
      // Bar Pour — extracted from inventory in this commit. Gated on the
      // bar_pour vertical module so non-bar businesses (takeaways, retail,
      // workshops) never see it cluttering their nav.
      { to: "/bar", icon: "🍸", labelKey: "bar", requiresModule: "bar_pour" },
      // Wine list — gated on wine_sommelier module instead of business_type
      // so a Pro restaurant that doesn't sell wine can hide it, and a wine
      // bar (technically business_type=restaurant) gets it without fuss.
      { to: "/wine-list", icon: "🍷", labelKey: "wineList", requiresModule: "wine_sommelier" },
      { to: "/expiry", icon: "⏰", labelKey: "expiryForecasting", visibleFor: ["restaurant", "retail", "general"] },
      { to: "/waste", icon: "🗑️", labelKey: "wasteTracker", visibleFor: ["restaurant", "retail", "general"] },
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
    icon: "📋",
    visibleFor: null,
    items: [
      { to: "/daily-report", icon: "🌙", labelKey: "dailyReport" },
      { to: "/reports", icon: "📋", labelKey: "reports" },
      { to: "/daily-close", icon: "🧾", labelKey: "dailyClose" },
      { to: "/daily-close/multi", icon: "🌙", labelKey: "multiClose" },
      { to: "/tax", icon: "💰", labelKey: "taxAutopilot" },
      { to: "/bookkeeping-export", icon: "📤", labelKey: "sendToAccountant" },
    ],
  },
  {
    id: "staff",
    labelKey: "navStaff",
    icon: "👥",
    visibleFor: null,
    items: [
      { to: "/staff/schedule", icon: "📅", labelKey: "staffSchedule" },
      { to: "/staff/hours", icon: "⏱", labelKey: "staffHours" },
      { to: "/staff/tips", icon: "💰", labelKey: "staffTips" },
      { to: "/staff/payroll", icon: "📄", labelKey: "staffPayroll" },
    ],
  },
  {
    id: "intel",
    labelKey: "navIntel",
    icon: "🧠",
    visibleFor: ["restaurant", "retail", "service", "general"],
    items: [
      { to: "/weather", icon: "🌦️", labelKey: "weatherSmart" },
      { to: "/staffing", icon: "👥", labelKey: "smartStaffing" },
      { to: "/pricing", icon: "💲", labelKey: "priceOptimization" },
      { to: "/retention", icon: "🤝", labelKey: "customerRetention" },
      { to: "/competitors", icon: "🔍", labelKey: "competitorScan" },
    ],
  },
  {
    id: "workshop",
    labelKey: "navWorkshop",
    icon: "🔧",
    // Show the group when EITHER the branch is workshop-typed OR the
    // owner has explicitly enabled the workshop module via /modules.
    // The latter lets a multi-business owner with one workshop branch
    // see the group regardless of which branch they're viewing.
    visibleFor: ["workshop"],
    requiresAnyModule: ["workshop"],
    items: [
      { to: "/workshop", icon: "🔧", labelKey: "workshop", requiresModule: "workshop" },
    ],
  },
  {
    id: "manage",
    labelKey: "navManage",
    icon: "⚙️",
    visibleFor: null,
    items: [
      { to: "/branches", icon: "🏢", labelKey: "branches" },
      { to: "/terminals", icon: "💳", labelKey: "terminals" },
      { to: "/modules", icon: "🧩", labelKey: "modules" },
      { to: "/share-recipients", icon: "📨", labelKey: "shareRecipients" },
      { to: "/outlets", icon: "🏪", labelKey: "crossOutlet" },
      { to: "/consolidated-close", icon: "🏢", labelKey: "consolidatedClose" },
      { to: "/team", icon: "👤", labelKey: "team" },
      { to: "/khata", icon: "📖", labelKey: "khata" },
      { to: "/feedback", icon: "💬", labelKey: "feedback" },
      { to: "/recently-deleted", icon: "🗂️", labelKey: "recentlyDeleted" },
      { to: "/contact", icon: "✉️", labelKey: "contact" },
    ],
  },
  {
    id: "account",
    labelKey: "navAccount",
    icon: "💎",
    visibleFor: null,
    items: [
      { to: "/subscription", icon: "💎", labelKey: "planBilling" },
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
  { to: "/personal", icon: "📊", labelKey: "dashboard" },
  { to: "/loans", icon: "💸", labelKey: "loanTracker" },
  { to: "/contact", icon: "✉️", labelKey: "contact" },
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

  // Filter sidebar groups by both business_type (branch) and enabled modules
  const baseVisible = filterNavGroups(navGroups, branchType, businessTypes, enabledModules);
  // For super_admin owners, show an extra "Platform" group with the admin
  // dashboard. Frontend gating is cosmetic — real enforcement is server-side
  // (services/admin_security.py). A non-admin clicking this link sees an empty
  // dashboard because every /api/admin/* call returns 404.
  const visibleGroups = user?.role === "super_admin"
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
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <button onClick={() => setSidebarOpen(true)} className="text-gray-600 dark:text-gray-300">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 className="text-base font-bold text-green-600 dark:text-green-400">BonBox</h1>
        <NotificationCenter />
      </div>

      {/* Overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={closeSidebar} />
      )}

      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 h-full w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col z-50 transition-transform duration-200 ${
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      } md:translate-x-0`} style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-green-600 dark:text-green-400">BonBox</h1>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">{user?.business_name}</p>
            <BranchSelector compact />
          </div>
          <button onClick={closeSidebar} className="md:hidden text-gray-400 hover:text-gray-600 text-xl">&times;</button>
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
                  <span className="text-sm w-5 text-center">{item.icon}</span>
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
                          <span className="text-sm w-5 text-center">{item.icon}</span>
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
                      <span className="text-xs">{group.icon}</span>
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
                            <span className="text-xs w-4 text-center">{item.icon}</span>
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

      {/* Main content — extra bottom padding on mobile for bottom nav */}
      <main className="md:ml-56 pt-14 md:pt-0 pb-24 md:pb-4">
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
        </Suspense>
      )}
    </div>
  );
}

// Routes where floating action buttons should be suppressed.
const _HIDE_FLOATING_ON = ["/pricing", "/subscription"];
