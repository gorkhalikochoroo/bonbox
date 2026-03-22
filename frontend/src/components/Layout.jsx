import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useLanguage } from "../hooks/useLanguage";
import QuickAdd from "./QuickAdd";
import { usePageTracking } from "../hooks/useEventLog";

const businessNav = [
  { to: "/dashboard", labelKey: "dashboard" },
  { to: "/sales", labelKey: "sales" },
  { to: "/expenses", labelKey: "expenses" },
  { to: "/inventory", labelKey: "inventory" },
  { to: "/staffing", labelKey: "smartStaffing" },
  { to: "/waste", labelKey: "wasteTracker" },
  { to: "/weekly-report", labelKey: "weeklyReport" },
  { to: "/vat-report", labelKey: "momsVat" },
  { to: "/cashbook", labelKey: "cashBook" },
  { to: "/feedback", labelKey: "feedback" },
  { to: "/recently-deleted", labelKey: "recentlyDeleted" },
  { to: "/contact", labelKey: "contact" },
];

const personalNav = [
  { to: "/personal", label: "Personal Finance" },
  { to: "/expenses", labelKey: "expenses" },
  { to: "/contact", labelKey: "contact" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mode, setMode] = useState(localStorage.getItem("bonbox_mode") || "business");

  const toggleMode = () => {
    const next = mode === "business" ? "personal" : "business";
    setMode(next);
    localStorage.setItem("bonbox_mode", next);
    navigate(next === "personal" ? "/personal" : "/dashboard");
    closeSidebar();
  };

  const navItems = mode === "personal" ? personalNav : businessNav;
  const [dark, toggleDark] = useDarkMode();
  const { t, toggleLang } = useLanguage();
  usePageTracking();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-900">
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between">
        <button onClick={() => setSidebarOpen(true)} className="text-gray-600 dark:text-gray-300">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 className="text-base font-bold text-blue-600">BonBox</h1>
        <div className="w-6" />
      </div>

      {/* Overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40" onClick={closeSidebar} />
      )}

      {/* Sidebar */}
      <aside className={`fixed top-0 left-0 h-full w-56 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col z-50 transition-transform duration-200 ${
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      } md:translate-x-0`}>
        <div className="p-5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-blue-600">BonBox</h1>
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
                : "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-700"
            }`}
          >
            <span className="text-base">{mode === "personal" ? "👤" : "💼"}</span>
            <span>{mode === "personal" ? "Personal Mode" : "Business Mode"}</span>
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
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-white"
                }`
              }
            >
              {item.labelKey ? t(item.labelKey) : item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-100 dark:border-gray-700 space-y-1">
          <NavLink
            to="/profile"
            onClick={closeSidebar}
            className={({ isActive }) =>
              `block px-4 py-2.5 rounded-lg text-sm font-medium transition ${
                isActive
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
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
          <button
            onClick={toggleLang}
            className="w-full text-left px-4 py-2.5 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
          >
            {t("language")}
          </button>
          <button
            onClick={handleLogout}
            className="w-full text-left px-4 py-2.5 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
          >
            {t("signOut")}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="md:ml-56 pt-14 md:pt-0">
        <Outlet />
      </main>

      {/* Floating quick-add button */}
      <QuickAdd />
    </div>
  );
}
