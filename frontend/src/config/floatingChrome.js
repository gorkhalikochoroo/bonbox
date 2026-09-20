/**
 * Where the floating chrome goes quiet — and, just as importantly, what that
 * is allowed to mean.
 *
 * The rule itself is old and still right: on /subscription the owner is
 * deciding whether to pay, and a floating "+" ("log a sale") or a pulsing ✨
 * orb competes with the plan cards for exactly the wrong attention.
 *
 * ONE route, not two. /pricing was carried here for years and never fired:
 * since the C7 Intelligence collapse it is `<Navigate to="/insights?tab=pricing"
 * replace />` (App.jsx), so `location.pathname` is never committed as "/pricing"
 * for longer than the tick before the redirect — and the page it lands on is
 * MENU-pricing intelligence, the owner's own prices, not a plan CTA. Listing it
 * described a surface that is not there, which is the more expensive kind of
 * wrong: the comment and a test both asserted it.
 *
 * What was wrong was the ENFORCEMENT. Layout suppressed the whole component,
 * and QuickAdd's sheet is not only reached from its own FAB: the phone tab
 * bar's centre "+" opens it by clicking QuickAdd's hidden trigger, and the
 * mobile header's ✨ opens BonBoxAgent's panel the same way. Unmounting the
 * component to hide one button took the sheet with it, so on /subscription the
 * centre "+" was a button that did nothing at all.
 *
 * So the list lives here, the components stay mounted, and each one asks this
 * module whether to draw its OWN floating trigger. A surface that hides a
 * button may not also remove the thing another surface opens.
 */

/** Route prefixes where floating triggers step aside for the page's own CTA. */
export const HIDE_FLOATING_ON = ["/subscription"];

/**
 * Should a floating trigger hide itself on this path? Prefix match, because
 * these routes carry sub-paths (/subscription/success). Pure; never throws —
 * a missing pathname simply means "show", which is the safe direction for an
 * affordance.
 */
export function isFloatingChromeHidden(pathname) {
  if (typeof pathname !== "string") return false;
  return HIDE_FLOATING_ON.some((p) => pathname.startsWith(p));
}
