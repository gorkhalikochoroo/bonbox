import { useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
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
import { fitDockLabels } from "./staff/dockLabelFit";

/**
 * The phone tab bar. A business owner gets the floating dock (OwnerDock
 * below, phone R1); personal mode keeps the bar described here.
 *
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

/* Is this tab where the owner is? Exact, or a page under it. */
const tabMatches = (pathname, tb) => pathname === tb.to || (tb.to !== "/" && pathname.startsWith(tb.to));
/* Motion only when the browser can say, and says, it is welcome — the same
   default-to-safety as the kit's sheetMotion.motionAllowed, inlined so the
   dock does not pull that module into the owner shell's first load. */
const motionOk = () => {
  try { return typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch { return false; }
};

/**
 * The owner's floating dock (phone R1, PHONE-OWNER-PLAN §4, decision 2):
 * Vagtplan's dock shape and its ONE sliding indicator, in I dag's colours
 * (components/owner/ownerShell.css). The same five tabs as the bar it
 * replaces (getTabsForType) and the same amber dots.
 *
 *   • The pill is one element for the whole dock; it slides to the active
 *     column on the soft spring (transform only) and never re-mounts. It
 *     follows the TAP at once: React Router commits a navigation in a
 *     transition, so while a page's chunk loads the address still reads
 *     the old page — the pill does not wait for it (Vagtplan's pillKey).
 *   • Tabs are silent: no haptic on a tab, ever (5.6).
 *   • Tapping the tab you are on scrolls the page to the top; on a page
 *     under that tab it goes to the tab's own page, as a tap always did.
 *   • Scroll is not remembered per tab (parked in the plan).
 *   • The five names shrink together when one does not fit
 *     (staff/dockLabelFit.js, as Vagtplan's do).
 */
function OwnerDock({ tabs, badges, t, lang }) {
  const location = useLocation();
  const navRef = useRef(null);
  const path = location.pathname;
  let here = tabs.findIndex((tb) => tabMatches(path, tb));
  // A page with no tab of its own (/expenses, /inventory …) is reached
  // through "Mere" — light that, so the dock never shows no position.
  if (here < 0) here = tabs.findIndex((tb) => tb.to === "/more");
  // The tab just tapped, until a navigation lands (any: that one, or BACK
  // meanwhile) — then the address is the truth again. Adjusted while
  // rendering, never in an effect.
  const [tapped, setTapped] = useState(null);   // { to, key }
  if (tapped && tapped.key !== location.key) setTapped(null);
  const tappedIdx = tapped ? tabs.findIndex((tb) => tb.to === tapped.to) : -1;
  const idx = tappedIdx >= 0 ? tappedIdx : here;
  const labels = tabs.map((tab) => t(tab.labelKey) || tab.labelKey);
  const labelKey = labels.join("|");

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const fit = () => fitDockLabels(nav);
    fit();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    ro?.observe(nav);
    let live = true;
    document.fonts?.ready?.then(() => { if (live) fit(); }, () => {});
    return () => { live = false; ro?.disconnect(); };
  }, [labelKey, lang]);

  return (
    <nav
      ref={navRef}
      aria-label={t("bottomNav") || "Primary"}
      /* The cookie banner sits on this dock instead of over it (CookieConsent.jsx). */
      data-bb-consent-clear=""
      data-owner-dock=""
      className="ow-dock z-50 md:hidden"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`, "--n": tabs.length }}
    >
      <span aria-hidden="true" className="ow-dock-track">
        <span
          className="ow-dock-ind"
          data-dock-indicator=""
          {...(idx < 0 ? { "data-hidden": "" } : {})}
          style={{ "--i": Math.max(0, idx) }}
        >
          <span className="ow-dock-pill" />
        </span>
      </span>
      {tabs.map((tab, i) => {
        const active = i === idx;
        const label = labels[i];
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-current={active ? "page" : undefined}
            aria-label={label}
            data-dock-tab={tab.to}
            className="ow-dock-item focus:outline-none"
            onClick={(e) => {
              // The tab you are on: back to the top, no navigation.
              if (active && path === tab.to) {
                e.preventDefault();
                try { window.scrollTo({ top: 0, behavior: motionOk() ? "smooth" : "auto" }); } catch { /* old WebView */ }
                return;
              }
              // Any other: the pill goes now, the page follows.
              if (!e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                setTapped({ to: tab.to, key: location.key });
              }
            }}
          >
            <span className="ow-dock-icon">
              <Icon name={tab.icon} size={22} strokeWidth={active ? 2.25 : 1.75} />
              {/* An ACTIONABLE count only (useNavBadges, Layout): bookings
                  waiting for an answer, draft shifts, a missing
                  kasserapport — a dot, the number is on the rail and page. */}
              {badges && badges[tab.to] && <span className="ow-dock-dot" data-dock-dot="" aria-hidden="true" />}
            </span>
            <span className="ow-dock-label vp-dock-label" aria-hidden="true">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * @param {{enabledModules?: Set<string>|null}} props  the owner's switched-on
 *   vertical modules from Layout's /modules read — null until it has answered
 *   (unknown never switches a tab off).
 */
export default function MobileBottomNav({ enabledModules = null, badges = null } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { branchType } = useBranch();
  const { hiddenPillars } = usePillars();
  // What the owner has in use: the 4th slot leads with a type's own tool only
  // once it is used (bottomNavTabs) — known pillars and tools, never the
  // fail-open "everything" of a request still in flight.
  const { knownActivatedPillars, usedSurfaces } = useActivation();
  const { t, lang } = useLanguage();
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

  // The business owner's bar is the floating dock (phone R1). Personal mode
  // keeps its own bar below, with its centre "+", exactly as it was.
  if (!isPersonal) return <OwnerDock tabs={tabs} badges={badges} t={t} lang={lang} />;

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
              /* td-tab: the dock press (today.css) — .96 down, spring back. */
              className={`td-tab flex flex-col items-center justify-center w-16 h-14 transition
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-gray-400 focus-visible:ring-inset
                ${isActive
                  ? "text-gray-900 dark:text-gray-100"
                  // gray-600 in light: the bar is paper (.bar-paper), where
                  // gray-500 is 4.39:1 under a 10px label. Dark unchanged.
                  : "text-gray-600 dark:text-gray-400"}`}
            >
              <span className="relative inline-flex">
                <Icon name={tab.icon} size={20} strokeWidth={1.75} />
                {/* An ACTIONABLE count only (useNavBadges, Layout): bookings
                    waiting for an answer, draft shifts, a missing
                    kasserapport — a dot, the number is on the rail and page. */}
                {badges && badges[tab.to] && (
                  <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-gray-900" aria-hidden="true" />
                )}
              </span>
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
