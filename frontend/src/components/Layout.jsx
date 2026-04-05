import { useState, useEffect } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import { getVatTerms } from "../utils/currency";
import QuickAdd from "./QuickAdd";
import BonBoxAgent from "./BonBoxAgent";
import { usePageTracking } from "../hooks/useEventLog";
import { motion, AnimatePresence } from "framer-motion";

const businessNav = [
  { to: "/dashboard", labelKey: "dashboard" },
  { to: "/sales", labelKey: "sales" },
  { to: "/expenses", labelKey: "expenses" },
  { to: "/cashbook", labelKey: "cashBook" },
  { to: "/reports", labelKey: "reports" },
  { to: "/inventory", labelKey: "inventory" },
  { to: "/weather", labelKey: "weatherSmart" },
  { to: "/waste", labelKey: "wasteTracker" },
  { to: "/staffing", labelKey: "smartStaffing" },
  { to: "/khata", labelKey: "khata" },
];

const moreNav = [
  { to: "/feedback", labelKey: "feedback" },
  { to: "/recently-deleted", labelKey: "recentlyDeleted" },
  { to: "/contact", labelKey: "contact" },
];

const personalNav = [
  { to: "/personal", labelKey: "dashboard" },
  { to: "/loans", labelKey: "loanTracker" },
  { to: "/contact", labelKey: "contact" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isOnMoreRoute = moreNav.some((item) => location.pathname.startsWith(item.to));
  const [showMore, setShowMore] = useState(isOnMoreRoute);

  useEffect(() => {
    if (isOnMoreRoute) setShowMore(true);
  }, [isOnMoreRoute]);
  const [mode, setMode] = useState(localStorage.getItem("bonbox_mode") || "business");

  const toggleMode = () => {
    const next = mode === "business" ? "personal" : "business";
    setMode(next);
    localStorage.setItem("bonbox_mode", next);
    navigate(next === "personal" ? "/personal" : "/dashboard");
    closeSidebar();
  };

  const vatTerms = getVatTerms(user?.currency);
  const navItems = mode === "personal" ? personalNav : businessNav;
  const [dark, toggleDark] = useDarkMode();
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  usePageTracking();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const closeSidebar = () => setSidebarOpen(false);

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
        <div className="w-6" />
      </div>

      {/* Overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={closeSidebar} />
      )}

      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 h-full w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col z-50 transition-transform duration-200 ${
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      } md:translate-x-0`} style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <div className="p-5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-green-600 dark:text-green-400">BonBox</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">{user?.business_name}</p>
          </div>
          <button onClick={closeSidebar} className="md:hidden text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>
        {/* Mode switcher */}
        <div className="px-3 py-2">
          <button
            onClick={toggleMode}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
              mode === "personal"
                ? "bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border border-purple-200 dark:border-purple-700"
                : "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-700"
            }`}
          >
            <span className="text-base">{mode === "personal" ? "👤" : "💼"}</span>
            <span>{mode === "personal" ? t("personalMode") : t("businessMode")}</span>
            <svg className="w-3.5 h-3.5 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/dashboard" || item.to === "/personal"}
              onClick={closeSidebar}
              className={({ isActive }) =>
                `block px-4 py-2.5 rounded-lg text-sm font-medium transition ${
                  isActive
                    ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-white"
                }`
              }
            >
              {item.dynamic ? vatTerms.sidebarLabel : item.labelKey ? t(item.labelKey) : item.label}
            </NavLink>
          ))}
          {mode === "business" && (
            <>
              <button
                onClick={() => setShowMore(!showMore)}
                className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm font-medium text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300 transition"
              >
                <span>More</span>
                <svg className={`w-3.5 h-3.5 transition-transform ${showMore ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showMore && moreNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={closeSidebar}
                  className={({ isActive }) =>
                    `block px-4 py-2.5 rounded-lg text-sm font-medium transition ${
                      isActive
                        ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                        : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-white"
                    }`
                  }
                >
                  {item.labelKey ? t(item.labelKey) : item.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>
        <div className="p-3 border-t border-gray-100 dark:border-gray-700 space-y-1" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}>
          <NavLink
            to="/profile"
            onClick={closeSidebar}
            className={({ isActive }) =>
              `block px-4 py-2.5 rounded-lg text-sm font-medium transition ${
                isActive
                  ? "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                  : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              }`
            }
          >
            {t("profile")}
          </NavLink>
          <button
            onClick={toggleDark}
            className="w-full text-left px-4 py-2.5 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
          >
            {dark ? t("lightMode") : t("darkMode")}
          </button>
          <div className="px-2 py-1.5">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 focus:ring-2 focus:ring-green-300 dark:focus:ring-green-700 outline-none cursor-pointer"
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
            className="w-full text-left px-4 py-2.5 rounded-lg text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition font-medium"
          >
            {t("signOut")}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="md:ml-56 pt-14 md:pt-0 pb-20">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Floating quick-add button */}
      <QuickAdd />
      {/* AI Agent chat widget */}
      <BonBoxAgent />
    </div>
  );
}
