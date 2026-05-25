import { NavLink, useLocation } from "react-router-dom";
import { useBranch } from "./BranchSelector";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";
import { Plus, Menu } from "lucide-react";

/**
 * Returns 5 bottom nav tabs based on the active branch's business type.
 * Common: Home, Sales, Quick Add (center FAB), [type-specific], More.
 * Icons are Lucide names (see ui/Icon.jsx for the map).
 */
function getTabsForType(branchType) {
  const typeTab = {
    restaurant: { to: "/daily-close", icon: "Moon", labelKey: "navToday" },
    bar:        { to: "/wine-list",   icon: "Wine", labelKey: "wineList" },
    cafe:       { to: "/daily-close", icon: "Moon", labelKey: "navToday" },
    retail:     { to: "/inventory",   icon: "Package", labelKey: "inventory" },
    workshop:   { to: "/workshop",    icon: "Wrench", labelKey: "workshop" },
    salon:      { to: "/staff/schedule", icon: "Calendar", labelKey: "staffSchedule" },
    hotel:      { to: "/daily-close", icon: "Moon", labelKey: "navToday" },
    freelance:  { to: "/cashflow",    icon: "LineChart", labelKey: "cashFlow" },
    general:    { to: "/daily-close", icon: "Moon", labelKey: "navToday" },
  };

  return [
    { to: "/dashboard", icon: "Home", labelKey: "navHome" },
    { to: "/sales",     icon: "ShoppingBag", labelKey: "sales" },
    { to: "/expenses",  icon: "Plus", labelKey: "add", isCenter: true },
    typeTab[branchType] || typeTab.general,
    { to: "/more",      icon: "Menu", labelKey: "more" },
  ];
}

export default function MobileBottomNav() {
  const location = useLocation();
  const { branchType } = useBranch();
  const { t } = useLanguage();
  const tabs = getTabsForType(branchType || "general");

  return (
    <nav
      aria-label={t("bottomNav") || "Primary"}
      className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800
        border-t border-gray-200 dark:border-gray-700 z-50 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex justify-around items-center h-14">
        {tabs.map((tab, i) => {
          const isActive = location.pathname === tab.to ||
            (tab.to !== "/" && location.pathname.startsWith(tab.to));
          const label = t(tab.labelKey) || tab.labelKey;

          if (tab.isCenter) {
            // Center FAB uses Plus directly — larger size + white stroke
            // to contrast against the emerald background.
            return (
              <NavLink
                key={`center-${i}`}
                to={tab.to}
                className="relative -top-3 flex items-center justify-center
                  w-12 h-12 bg-gray-900 dark:bg-emerald-500 rounded-full
                  text-white shadow-sm active:scale-95 transition-transform
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-gray-400 focus-visible:ring-offset-2
                  focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800"
                aria-label={label}
              >
                <Plus size={22} strokeWidth={2.25} aria-hidden="true" />
              </NavLink>
            );
          }

          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === "/dashboard"}
              aria-current={isActive ? "page" : undefined}
              aria-label={label}
              className={`flex flex-col items-center justify-center w-16 h-14 transition
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-gray-400 focus-visible:ring-inset
                ${isActive
                  ? "text-gray-900 dark:text-gray-100"
                  : "text-gray-500 dark:text-gray-400"}`}
            >
              {tab.icon === "Menu"
                ? <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
                : <Icon name={tab.icon} size={20} strokeWidth={1.75} />}
              <span className="text-[10px] mt-0.5 font-medium" aria-hidden="true">
                {label}
              </span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
