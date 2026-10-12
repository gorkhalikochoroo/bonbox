/**
 * verticalModules.js — display copy + fit for the vertical modules
 * (services/modules.py MODULES). Read by /modules (ModulesPage) and by the
 * Profile type-change sheet, which names the modules a new type switches on.
 */

// The vertical-module catalogue in the owner's language (the API sends the
// English name/description from services/modules.py) and which archetypes
// each module is for. A module that does not fit this business is listed
// under "Andre brancher", collapsed — never hidden, and never collapsed while
// it is switched on (vertical-fit audit, Oct 2026: a salon was offered Bar
// Pour and Wine & Sommelier first, in English).
export const MODULE_COPY = {
  bar_pour: { nameKey: "moduleBarPourName", descKey: "moduleBarPourDesc", archetypes: ["bar", "food_service"] },
  wine_sommelier: { nameKey: "moduleWineName", descKey: "moduleWineDesc", archetypes: ["food_service", "bar"] },
  workshop: { nameKey: "moduleWorkshopName", descKey: "moduleWorkshopDesc", archetypes: ["services"] },
};

/** Does module `id` fit this archetype? Unknown module / generic (or no)
 *  archetype → yes: nothing is ever filed away by a guess. */
export function moduleFitsArchetype(id, archetypeId) {
  const meta = MODULE_COPY[id];
  if (!meta || !archetypeId || archetypeId === "generic") return true;
  return meta.archetypes.includes(archetypeId);
}
