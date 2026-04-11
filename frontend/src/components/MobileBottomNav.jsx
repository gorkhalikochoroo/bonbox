import { NavLink, useLocation } from "react-router-dom";
import { useBranch } from "./BranchSelector";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Returns 5 bottom nav tabs based on the active branch's business type.
 * Common: Dashboard, Sales, Quick Add (center FAB), [type-specific], More
 */
function getTabsForType(branchType) {
  const typeTab = {
    restaurant: { to: "/daily-close", icon: "🔒", labelKey: "dailyClose" },
    bar:        { to: "/wine-list",   icon: "🍷", labelKey: "wineList" },
    cafe:       { to: "/daily-close", icon: "🔒", labelKey: "dailyClose" },
    retail:     { to: "/inventory",   icon: "📦", labelKey: "inventory" },
    workshop:   { to: "/workshop",    icon: "🔧", labelKey: "workshop" },
    salon:      { to: "/staff/schedule", icon: "👥", labelKey: "staffSchedule" },
    hotel:      { to: "/daily-close", icon: "🔒", labelKey: "dailyClose" },
    freelance:  { to: "/cashflow",    icon: "📈", labelKey: "cashFlow" },
    general:    { to: "/daily-close", icon: "🔒", labelKey: "dailyClose" },
  };

  return [
    { to: "/dashboard", icon: "📊", labelKey: "dashboard" },
    { to: "/sales",     icon: "💰", labelKey: "sales" },
    { to: "/sales",     icon: "➕", labelKey: "add", isCenter: true },
    typeTab[branchType] || typeTab.general,
    { to: "/more",      icon: "☰",  labelKey: "more" },
  ];
}

export default function MobileBottomNav() {
  const location = useLocation();
  const { branchType } = useBranch();
  const { t } = useLanguage();
  const tabs = getTabsForType(branchType || "general");

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800
        border-t border-gray-200 dark:border-gray-700 z-50 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex justify-around items-center h-14">
        {tabs.map((tab, i) => {
          const isActive = location.pathname === tab.to ||
            (tab.to !== "/" && location.pathname.startsWith(tab.to));

          if (tab.isCenter) {
            return (
              <NavLink
                key={`center-${i}`}
                to={tab.to}
                className="relative -top-3 flex items-center justify-center
                  w-12 h-12 bg-green-600 dark:bg-green-500 rounded-full
                  text-white text-xl shadow-lg active:scale-95 transition-transform"
                aria-label={t(tab.labelKey) || tab.labelKey}
              >
                {tab.icon}
              </NavLink>
            );
          }

          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === "/dashboard"}
              className={`flex flex-col items-center justify-center w-16 h-14 transition
                ${isActive
                  ? "text-green-600 dark:text-green-400"
                  : "text-gray-400 dark:text-gray-500"}`}
            >
              <span className="text-lg leading-none">{tab.icon}</span>
              <span className="text-[10px] mt-0.5 font-medium">
                {t(tab.labelKey) || tab.labelKey}
              </span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
