import { NavLink, useLocation } from "react-router-dom";
import { useBranch } from "./BranchSelector";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";
import { Plus, Menu } from "lucide-react";
import { NAV_MANIFEST } from "../config/navManifest";

/**
 * iOS-style 5-tab bottom bar. The slot LAYOUT is bottom-nav chrome (fixed:
 * Home · Sales · center "+" FAB · type-specific · More) but the icon + label
 * for each real destination is now resolved from the shared nav manifest
 * (config/navManifest.js) so the phone tab bar can never drift from the
 * sidebar / More page / ⌘K for the same route.
 *
 * The center "+" FAB (opens the QuickAdd action sheet) and the "More" tab
 * (→ /more) are pure bottom-nav affordances, not owner destinations, so they
 * stay defined inline rather than in the manifest.
 *
 * C4 (FAB merge): the center "+" no longer navigates to /expenses. It now
 * opens the existing QuickAdd sheet (log sale / add expense / Smart skan) by
 * dispatching a click to QuickAdd's hidden [data-quickadd-toggle] trigger —
 * so phones have a single "+" affordance (the tab bar) instead of a floating
 * QuickAdd FAB stacked over it.
 */

// Resolve a manifest entry by route path → { to, icon, labelKey }. Falls back
// to a literal tab spec if the route isn't a manifest destination (keeps the
// component robust if a type-tab points somewhere off-manifest).
const byPath = (to) => NAV_MANIFEST.find((d) => d.to === to);
function manifestTab(to, fallback) {
  const m = byPath(to);
  if (!m) return fallback;
  return { to: m.to, icon: m.icon, labelKey: m.labelKey };
}

/**
 * Returns 5 bottom nav tabs based on the active branch's business type.
 * Common: Home, Sales, Quick Add (center FAB), [type-specific], More.
 * The type-specific 4th tab maps business_type → the route an owner of that
 * vertical hits most; its icon/label come from the manifest entry for that
 * route. Icons are Lucide names (see ui/Icon.jsx).
 */
function getTabsForType(branchType) {
  // type → route for the 4th (vertical-specific) contextual tab.
  //
  // C5 nav diet: hospitality branches (restaurant / cafe / bar) now claim
  // the contextual slot for RESERVATIONS — the table book is the surface a
  // service owner reaches for most during a shift. ("Today" / daily-close
  // is no longer parked here; it moved to the core spine and is reachable
  // from the sidebar / More / ⌘K.) Other verticals keep their best-fit slot.
  const typeRoute = {
    restaurant: "/reservations",
    bar:        "/reservations",
    cafe:       "/reservations",
    retail:     "/inventory",
    workshop:   "/workshop",
    // Phase A bug fix (BUG #3): salon is reservations-first (Aftaler /
    // Tidsbestilling). It contradicted its own archetype by routing the 4th
    // tab to /staff/schedule; bring it in line with every other booking-first
    // vertical.
    salon:      "/reservations",
    hotel:      "/reservations",
    freelance:  "/cashflow",
    general:    "/daily-close",
  };
  const typeTo = typeRoute[branchType] || typeRoute.general;

  return [
    manifestTab("/dashboard", { to: "/dashboard", icon: "Home", labelKey: "navHome" }),
    manifestTab("/sales", { to: "/sales", icon: "ShoppingBag", labelKey: "sales" }),
    // Center "+" — bottom-nav chrome. Opens the QuickAdd sheet (no `to`).
    { icon: "Plus", labelKey: "add", isCenter: true },
    manifestTab(typeTo, { to: "/daily-close", icon: "Moon", labelKey: "navToday" }),
    // More — bottom-nav chrome.
    { to: "/more", icon: "Menu", labelKey: "more" },
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
            // Center "+" opens the QuickAdd action sheet (log sale / add
            // expense / Smart skan) by clicking QuickAdd's hidden trigger.
            // It's a button, not a link — no route change. Uses Plus directly
            // (larger + white stroke) to contrast against the dark/emerald fill.
            return (
              <button
                key={`center-${i}`}
                type="button"
                onClick={() => {
                  document
                    .querySelector("[data-quickadd-toggle]")
                    ?.click();
                }}
                className="relative -top-3 flex items-center justify-center
                  w-12 h-12 bg-gray-900 dark:bg-emerald-500 rounded-full
                  text-white shadow-sm active:scale-95 transition-transform
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-gray-400 focus-visible:ring-offset-2
                  focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800"
                aria-label={label}
              >
                <Plus size={22} strokeWidth={2.25} aria-hidden="true" />
              </button>
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
