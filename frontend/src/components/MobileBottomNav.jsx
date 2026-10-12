import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { clickHiddenTrigger } from "../utils/hiddenTrigger";
import { useBranch } from "./BranchSelector";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { resolveMode } from "../lib/appMode";
import { personalTabs } from "../config/personalNav";
import { Icon } from "./ui";
import { Plus } from "lucide-react";
import { getTabsForType } from "../config/bottomNavTabs";
import { usePillars } from "../hooks/usePillars";
import { useActivation } from "../hooks/useActivation";

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

/* Where the centre "+" goes when the QuickAdd sheet is not there to open.
   Both are pages the owner can do the sheet's default job on by hand — log a
   sale in business mode, log a personal entry in personal mode — so a miss
   costs taps, never the task. */
const CENTER_FALLBACK = { business: "/sales", personal: "/personal" };

/**
 * @param {{enabledModules?: Set<string>|null}} props  the owner's switched-on
 *   vertical modules from Layout's /modules read — null until it has answered
 *   (unknown never switches a tab off).
 */
export default function MobileBottomNav({ enabledModules = null } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { branchType } = useBranch();
  const { hiddenPillars } = usePillars();
  // What the owner has in use: the 4th slot leads with a type's own tool only
  // once it is used (bottomNavTabs) — known pillars and tools, never the
  // fail-open "everything" of a request still in flight.
  const { knownActivatedPillars, usedSurfaces } = useActivation();
  const { t } = useLanguage();
  // Mode comes from the ACCOUNT (lib/appMode.js) — the same resolver the
  // sidebar and QuickAdd use. This bar used to ask useBranch() what vertical
  // it was and never ask who the user was, so a personal account got a
  // business bar (Home/Sales/I dag) sitting under its own personal sidebar.
  //
  // From useAuth, never useBranch: branchType is null until an owner picks a
  // branch, so mode sourced there would be wrong for most accounts, not just
  // briefly wrong. `user` is safe here — both Layout render sites are behind
  // ProtectedRoute, which holds a loader until /auth/me resolves.
  const { user } = useAuth();
  const isPersonal = resolveMode(user) === "personal";
  const tabs = isPersonal
    ? personalTabs()
    : getTabsForType(branchType || "general", hiddenPillars, {
      usedPillars: knownActivatedPillars ?? null,
      usedSurfaces: usedSurfaces instanceof Set ? usedSurfaces : new Set(),
      enabledModules: enabledModules instanceof Set ? enabledModules : null,
    });

  return (
    <nav
      aria-label={t("bottomNav") || "Primary"}
      /* The cookie banner sits on this bar instead of over it (CookieConsent.jsx). */
      data-bb-consent-clear=""
      /* .glass, not bg-white. The bar is h-14 (56px) plus the ~34pt home
         indicator area iOS reserves, and as an opaque white block that reads as
         a 90pt empty slab at the bottom of a light app. Translucent, it reads as
         a bar with content passing under it — which is what a native iOS tab bar
         does. .glass (not .glass-static) is correct here: index.css:458 notes
         FIXED bars need the compositor hint or WKWebView repaints them every
         scroll frame; .glass-static exists for STICKY bars where that same
         transform causes the documented wobble. */
      className="fixed bottom-0 left-0 right-0 glass bar-paper
        border-t border-gray-200/70 dark:border-gray-700/70 z-50 md:hidden"
      /* Reserve LESS than the full bottom inset so the row sits lower.
         Padding the full env(safe-area-inset-bottom) — ~34pt on this device —
         left the icons pinned to the top of a ~90pt bar with a slab of empty
         space under them. The home indicator is a ~5pt pill with ~8pt of
         margin, so ~13pt is the real clearance it needs; 34pt is Apple's
         generous reserve, not a hard floor. Giving 14px of it back moves
         Home/Sales/Today/More visibly down and closes most of the gap, while
         still leaving 20pt under them on a notched phone.
         max(..., 8px) keeps a sane floor on devices reporting no inset. */
      style={{ paddingBottom: "max(calc(env(safe-area-inset-bottom, 0px) - 14px), 8px)", paddingLeft: "env(safe-area-inset-left, 0px)", paddingRight: "env(safe-area-inset-right, 0px)" }}
    >
      <div className="flex justify-around items-center h-14">
        {tabs.map((tab, i) => {
          const matches = (tb) => location.pathname === tb.to ||
            (tb.to !== "/" && location.pathname.startsWith(tb.to));
          // A page with no tab of its own (/expenses, /inventory …) is reached
          // through "Mere" — light that, so the bar never shows no position.
          const isActive = matches(tab) ||
            (tab.to === "/more" && !tabs.some((tb) => !tb.isCenter && matches(tb)));
          const label = t(tab.labelKey) || tab.labelKey;

          if (tab.isCenter) {
            // Center "+" opens the QuickAdd action sheet (log sale / add
            // expense / Smart skan) by clicking QuickAdd's hidden trigger.
            // Normally no route change; it only navigates when the sheet is
            // not there to open. Uses Plus directly (larger + white stroke)
            // to contrast against the dark/emerald fill.
            //
            // This was `querySelector(...)?.click()`, and that `?.` meant an
            // unmounted QuickAdd and a working "+" were indistinguishable —
            // which is what /subscription shipped as, a centre button that did
            // nothing at all. The sheet is mounted on every route now; this is
            // the belt that makes a future miss LOUD (a navigation the owner
            // can see) instead of silence.
            return (
              <button
                key={`center-${i}`}
                type="button"
                onClick={() => {
                  if (clickHiddenTrigger("[data-quickadd-toggle]")) return;
                  navigate(isPersonal ? CENTER_FALLBACK.personal : CENTER_FALLBACK.business);
                }}
                className="relative -top-3 flex items-center justify-center
                  w-12 h-12 bg-gray-900 dark:bg-gray-600 rounded-full
                  text-white dark:text-white shadow-sm active:scale-95 transition-transform
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
                  // gray-600 in light: the bar is paper (.bar-paper), where
                  // gray-500 is 4.39:1 under a 10px label. Dark unchanged.
                  : "text-gray-600 dark:text-gray-400"}`}
            >
              <Icon name={tab.icon} size={20} strokeWidth={1.75} />
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
