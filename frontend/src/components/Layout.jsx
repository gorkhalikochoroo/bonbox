import { useState, useEffect, lazy, Suspense } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import { getVatTerms } from "../utils/currency";
import { usePageTracking } from "../hooks/useEventLog";
import NotificationCenter from "./NotificationCenter";
import BranchSelector from "./BranchSelector";

// Lazy-load heavy floating widgets — only parsed when opened
const QuickAdd = lazy(() => import("./QuickAdd"));
const BonBoxAgent = lazy(() => import("./BonBoxAgent"));

/* ─── Grouped sidebar navigation ─── */
const navGroups = [
  {
    id: "core",
    items: [
      { to: "/dashboard", icon: "📊", labelKey: "dashboard" },
      { to: "/sales", icon: "💰", labelKey: "sales" },
      { to: "/expenses", icon: "🧾", labelKey: "expenses" },
    ],
  },
  {
    id: "money",
    label: "Money",
    icon: "💳",
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
    label: "Stock",
    icon: "📦",
    items: [
      { to: "/inventory", icon: "📦", labelKey: "inventory" },
      { to: "/expiry", icon: "⏰", labelKey: "expiryForecasting" },
      { to: "/waste", icon: "🗑️", labelKey: "wasteTracker" },
    ],
  },
  {
    id: "intel",
    label: "Intelligence",
    icon: "🧠",
    items: [
      { to: "/weather", icon: "🌦️", labelKey: "weatherSmart" },
      { to: "/staffing", icon: "👥", labelKey: "smartStaffing" },
      { to: "/pricing", icon: "💲", labelKey: "priceOptimization" },
      { to: "/retention", icon: "🤝", labelKey: "customerRetention" },
      { to: "/competitors", icon: "🔍", labelKey: "competitorScan" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: "📋",
    items: [
      { to: "/reports", icon: "📋", labelKey: "reports" },
      { to: "/tax", icon: "🧾", labelKey: "taxAutopilot" },
    ],
  },
  {
    id: "manage",
    label: "Manage",
    icon: "⚙️",
    items: [
      { to: "/branches", icon: "🏢", labelKey: "branches" },
      { to: "/outlets", icon: "🏪", labelKey: "crossOutlet" },
      { to: "/team", icon: "👤", labelKey: "team" },
      { to: "/khata", icon: "📖", labelKey: "khata" },
      { to: "/feedback", icon: "💬", labelKey: "feedback" },
      { to: "/recently-deleted", icon: "🗂️", labelKey: "recentlyDeleted" },
      { to: "/contact", icon: "✉️", labelKey: "contact" },
    ],
  },
];

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mode, setMode] = useState(localStorage.getItem("bonbox_mode") || "business");

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

  const vatTerms = getVatTerms(user?.currency);
  const [dark, toggleDark] = useDarkMode();
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  usePageTracking();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const closeSidebar = () => setSidebarOpen(false);

  const activeClass = "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400";
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

        {/* Mode switcher */}
        <div className="px-3 py-2">
          <button
            onClick={toggleMode}
            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              mode === "personal"
                ? "bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border border-purple-200 dark:border-purple-700"
                : "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-700"
            }`}
          >
            <span>{mode === "personal" ? "👤" : "💼"}</span>
            <span>{mode === "personal" ? t("personalMode") : t("businessMode")}</span>
            <svg className="w-3 h-3 ml-auto opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
            /* Business mode — grouped navigation */
            <div className="space-y-0.5 py-1">
              {navGroups.map((group) => {
                const isOpen = openGroups[group.id] !== false; // default open for core
                const hasActiveChild = group.items.some((i) => location.pathname.startsWith(i.to));

                // Core group has no header — always visible
                if (!group.label) {
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
                      <span>{group.label}</span>
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

      {/* Main content */}
      <main className="md:ml-56 pt-14 md:pt-0 pb-20">
        <Outlet />
      </main>

      {/* Floating widgets */}
      <Suspense fallback={null}>
        <QuickAdd />
        <BonBoxAgent />
      </Suspense>
    </div>
  );
}
