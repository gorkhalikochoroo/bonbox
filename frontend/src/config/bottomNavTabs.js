/**
 * bottomNavTabs.js — the phone tab bar's slots (MobileBottomNav renders them).
 * Kept out of the component file so the slot logic is testable on its own and
 * the component file only exports components (react-refresh).
 */
import { NAV_MANIFEST, labelKeyFor, relevantPillarsForArchetype } from "./navManifest";
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


// type → the route an owner of that vertical reaches for most — the tab bar's
// slot-2 fallback when the venue keeps no booking book.
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
 * The I dag tab bar (Nov 2026 redesign — Dashboard-mobile.dc.html):
 *
 *   I dag · [book] · [staff] · Kasserapport · Mere
 *
 *   slot 2 — Reservationer / Tidsbestilling when the venue keeps a book (the
 *            reservations pillar is relevant to its type and not switched
 *            off); otherwise the type's own tool when it is in use (a shop's
 *            Lager, a workshop's Værksted, a freelancer's Pengestrøm — the
 *            rule the old 4th slot followed); otherwise Salg.
 *   slot 3 — Vagtplan when the staff pillar is on; otherwise Salg — or,
 *            when Salg already took slot 2, Lager if it is relevant to the
 *            type and not switched off, else Udgifter.
 *   slot 4 — Kasserapport, every business (the locked noun; the canvas's
 *            "Afslutning" is the same page).
 *   slot 5 — Mere (/more), which now also lists Salg.
 *
 * The QuickAdd "+" left the bar for the phone top bar (Layout.jsx), so no
 * centre slot. Icons/labels resolve from the manifest (labelKeyFor — a salon
 * reads Tidsbestilling), so the bar cannot drift from the sidebar or ⌘K.
 *
 * @param {string} branchType
 * @param {Set<string>|null} hiddenPillars  the owner's OFF-list (usePillars)
 * @param {{usedPillars?: Set<string>|null, usedSurfaces?: Set<string>,
 *          enabledModules?: Set<string>|null}|null} usage  what the owner has
 *          in use — only consulted for the type tool fallback in slot 2
 */
export function getTabsForType(branchType, hiddenPillars = null, usage = null) {
  const archetypeId = archetypeIdFor(branchType);
  const hidden = hiddenPillars instanceof Set ? hiddenPillars : new Set();
  const relevant = relevantPillarsForArchetype(archetypeId);

  let slot2 = null;
  if (relevant.has("reservations") && !hidden.has("reservations")) slot2 = "/reservations";
  if (!slot2) {
    const route = TYPE_ROUTE[branchType] || (archetypeId === "retail" ? TYPE_ROUTE.retail : null);
    if (route && route !== "/reservations" && slotInUse(byPath(route), hiddenPillars, usage)) slot2 = route;
  }
  if (!slot2) slot2 = "/sales";

  let slot3 = null;
  if (relevant.has("staff") && !hidden.has("staff")) slot3 = "/staff/schedule";
  if (!slot3 && slot2 !== "/sales") slot3 = "/sales";
  // Salg already took slot 2: Lager only where it belongs to this type and
  // is not switched off (a freelancer never gets Lager, a shop that turned
  // it off never gets it back here); otherwise Udgifter, which every
  // business has.
  if (!slot3) slot3 = relevant.has("inventory") && !hidden.has("inventory") ? "/inventory" : "/expenses";

  const tab = (to) => manifestTab(to, { to, icon: "Circle", labelKey: "more" }, archetypeId);
  return [
    manifestTab("/dashboard", { to: "/dashboard", icon: "Home", labelKey: "navTodayHome" }),
    tab(slot2),
    tab(slot3),
    manifestTab(DAILY_CLOSE, { to: DAILY_CLOSE, icon: "Moon", labelKey: "navToday" }, archetypeId),
    // More — bottom-nav chrome.
    { to: "/more", icon: "Menu", labelKey: "more" },
  ];
}
