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

/**
 * Returns 5 bottom nav tabs based on the business type — the active branch's,
 * or the owner's own when there are no branches (useBranch resolves that).
 * Common: Home, Sales, Quick Add (center FAB), [type-specific], More.
 * The type-specific 4th tab maps business_type → the route an owner of that
 * vertical hits most; its icon/label come from the manifest entry for that
 * route. Icons are Lucide names (see ui/Icon.jsx).
 */
export function getTabsForType(branchType, hiddenPillars = null) {
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
  // Retail siblings (clothing / grocery / kiosk / pharmacy / electronics / …)
  // resolve to the retail archetype and share retail's Inventory-first
  // contextual tab, instead of falling through to the general '/daily-close'
  // slot. Direct typeRoute hits (restaurant / cafe / bar / salon / workshop /
  // …) are matched first and stay exactly as before.
  let typeTo =
    typeRoute[branchType] ||
    (archetypeIdFor(branchType) === "retail" ? "/inventory" : typeRoute.general);
  // The slot never points at a pillar the owner switched off (or the preset
  // left off): a café with Reservations off keeps Kasserapport here, instead
  // of a tab that opens the "Reservationer er slået fra" gate.
  const pillar = byPath(typeTo)?.pillar;
  if (pillar && hiddenPillars instanceof Set && hiddenPillars.has(pillar)) {
    typeTo = typeRoute.general;
  }
  const archetypeId = archetypeIdFor(branchType);

  return [
    manifestTab("/dashboard", { to: "/dashboard", icon: "Home", labelKey: "navHome" }),
    manifestTab("/sales", { to: "/sales", icon: "ShoppingBag", labelKey: "sales" }),
    // Center "+" — bottom-nav chrome. Opens the QuickAdd sheet (no `to`).
    { icon: "Plus", labelKey: "add", isCenter: true },
    manifestTab(typeTo, { to: "/daily-close", icon: "Moon", labelKey: "navToday" }, archetypeId),
    // More — bottom-nav chrome.
    { to: "/more", icon: "Menu", labelKey: "more" },
  ];
}

