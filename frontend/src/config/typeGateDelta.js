/**
 * typeGateDelta.js — which MENU entries a business-type change moves.
 *
 * The nav's business-type gate (navManifest visibleFor / visibleForArchetypes /
 * hideForArchetypes) trims a few tools by type — Udløbsprognose and Madspild
 * outside perishable stock. It never takes one the owner uses or switched on
 * (filterDestinations: keepWhenUsed + the module rule). The Profile confirm
 * sheet must say what the switch will move (vertical-fit review, Oct 2026):
 * this answers it from the SAME filter the sidebar and Mere run, so the sheet
 * and the menu cannot disagree.
 *
 * Kept out of navManifest.js so the manifest stays free of the archetype
 * import (no cycle) and the helper stays a pure, testable function.
 */
import { NAV_MANIFEST, filterDestinations } from "./navManifest";
import { archetypeIdFor } from "./archetypes";

const MENU_ITEMS = NAV_MANIFEST.filter(
  (d) => d.surfaces.includes("sidebar") || d.surfaces.includes("more"),
);

function menuFor(type, usage) {
  return new Set(
    filterDestinations(MENU_ITEMS, {
      businessTypes: [type],
      archetypeId: archetypeIdFor(type),
      enabledModules: usage.enabledModules instanceof Set ? usage.enabledModules : new Set(),
      usedSurfaces: usage.usedSurfaces instanceof Set ? usage.usedSurfaces : new Set(),
      // Only the type gate may differ between the two answers: every feature
      // reads unlocked and nothing is pillar-hidden on either side.
      hasFeature: () => true,
      hiddenPillars: new Set(),
    }).map((d) => d.to),
  );
}

/**
 * @param {string} fromType  the saved business type
 * @param {string} toType    the type being picked
 * @param {{usedSurfaces?: Set<string>, enabledModules?: Set<string>}} usage
 * @returns {{hide: object[], show: object[]}}  manifest entries that leave /
 *   join the menu with the new type (each with its labelKey, resolved for the
 *   NEW type's archetype where it has one).
 */
export function typeGateDelta(fromType, toType, usage = {}) {
  if (!fromType || !toType || fromType === toType) return { hide: [], show: [] };
  const before = menuFor(fromType, usage);
  const after = menuFor(toType, usage);
  return {
    hide: MENU_ITEMS.filter((d) => before.has(d.to) && !after.has(d.to)),
    show: MENU_ITEMS.filter((d) => after.has(d.to) && !before.has(d.to)),
  };
}
