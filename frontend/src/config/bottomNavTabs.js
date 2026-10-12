/**
 * bottomNavTabs.js — the phone tab bar's slots (MobileBottomNav renders them).
 * Kept out of the component file so the slot logic is testable on its own and
 * the component file only exports components (react-refresh).
 */
import { NAV_MANIFEST, labelKeyFor } from "./navManifest";
import { archetypeIdFor } from "./archetypes";

// Resolve a manifest entry by route path → { to, icon, labelKey }. Falls back
// to a literal tab spec if the route isn't a manifest destination (keeps the
// component robust if a type-tab points somewhere off-manifest).
const byPath = (to) => NAV_MANIFEST.find((d) => d.to === to);
function manifestTab(to, fallback, archetypeId = null) {
  const m = byPath(to);
  if (!m) return fallback;
  // A salon's /reservations reads "Tidsbestilling" (labelKeyByArchetype).
  return { to: m.to, icon: m.icon, labelKey: labelKeyFor(m, archetypeId) };
}

// Kasserapport — the daily close. Every business closes its day, so it is the
// slot's default and its fallback.
const DAILY_CLOSE = "/daily-close";

// The archetypes whose 4th slot stays Kasserapport (product decision, main
// session, 12 Oct 2026): for food service and bars the daily close IS the
// first job, and their bar has led with Kasserapport all along — every
// branchless café / restaurant / bar resolved to "general" before the nav
// learned the owner's type. Reservationer stays one tap away in Mere and the
// sidebar. No surprise change for an existing owner.
const CLOSE_FIRST_ARCHETYPES = new Set(["food_service", "bar"]);

// type → the route an owner of that vertical reaches for most. Only the
// archetypes that do not lead with the close are listed.
const TYPE_ROUTE = {
  salon: "/reservations",   // Tidsbestilling
  retail: "/inventory",     // Lager
  workshop: "/workshop",    // Værksted
  hotel: "/reservations",
  freelance: "/cashflow",
};

/**
 * Is the per-type slot's target IN USE? The slot leads with a tool only when
 * the owner has it on AND uses it — otherwise it is Kasserapport ("if that
 * pillar is off or unused, fall back"):
 *   • off    — the pillar is in `hiddenPillars`, or the entry's module is not
 *              switched on (`enabledModules`, when known);
 *   • unused — no real row (`usedPillars` for a pillar, `usedSurfaces` for the
 *              workshop's job cards). A Set that does not hold it, or null
 *              (not known yet), reads as unused: the bar keeps Kasserapport
 *              until the answer lands, then settles once (useActivation keeps
 *              the last answer per owner, so a reload does not flip it).
 * `usage` omitted entirely → no usage rule (only the off-switches apply).
 */
function slotInUse(entry, hiddenPillars, usage) {
  if (!entry) return false;
  if (entry.pillar && hiddenPillars instanceof Set && hiddenPillars.has(entry.pillar)) return false;
  const mods = usage && usage.enabledModules;
  if (entry.requiresModule && mods instanceof Set && !mods.has(entry.requiresModule)) return false;
  if (!usage) return true;
  if (entry.pillar) {
    return usage.usedPillars instanceof Set && usage.usedPillars.has(entry.pillar);
  }
  if (entry.keepWhenUsed) {
    return usage.usedSurfaces instanceof Set && usage.usedSurfaces.has(entry.keepWhenUsed);
  }
  return true;
}

/**
 * Returns 5 bottom nav tabs based on the business type — the active branch's,
 * or the owner's own when there are no branches (useBranch resolves that).
 * Common: Home, Sales, Quick Add (center FAB), [type-specific], More.
 * The 4th slot is Kasserapport for food service and bars, and for every other
 * type whose own tool is off or not used yet; else that tool (a salon's
 * Tidsbestilling, a shop's Lager, a workshop's Værksted). Icons are Lucide
 * names (see ui/Icon.jsx).
 *
 * @param {string} branchType
 * @param {Set<string>|null} hiddenPillars  the owner's OFF-list (usePillars)
 * @param {{usedPillars?: Set<string>|null, usedSurfaces?: Set<string>,
 *          enabledModules?: Set<string>|null}|null} usage  what the owner has
 *          in use (useActivation.knownActivatedPillars / usedSurfaces, and the
 *          enabled modules once loaded — null while not known)
 */
export function getTabsForType(branchType, hiddenPillars = null, usage = null) {
  const archetypeId = archetypeIdFor(branchType);
  let typeTo = DAILY_CLOSE;
  if (!CLOSE_FIRST_ARCHETYPES.has(archetypeId)) {
    // Retail siblings (clothing / grocery / kiosk / …) share retail's
    // Lager-first slot.
    const route = TYPE_ROUTE[branchType] || (archetypeId === "retail" ? TYPE_ROUTE.retail : null);
    if (route && slotInUse(byPath(route), hiddenPillars, usage)) typeTo = route;
  }

  return [
    manifestTab("/dashboard", { to: "/dashboard", icon: "Home", labelKey: "navHome" }),
    manifestTab("/sales", { to: "/sales", icon: "ShoppingBag", labelKey: "sales" }),
    // Center "+" — bottom-nav chrome. Opens the QuickAdd sheet (no `to`).
    { icon: "Plus", labelKey: "add", isCenter: true },
    manifestTab(typeTo, { to: DAILY_CLOSE, icon: "Moon", labelKey: "navToday" }, archetypeId),
    // More — bottom-nav chrome.
    { to: "/more", icon: "Menu", labelKey: "more" },
  ];
}
