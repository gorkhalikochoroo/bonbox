/**
 * staffRoles.js — the shift-role presets the schedule maker offers, per
 * vertical. Moved out of StaffSchedulePage so the presets are testable.
 */
import { archetypeIdFor } from "./archetypes";

// Shift-role options are VERTICAL-AWARE (display-only vocab; role_on_shift never
// drives availability/booking). A restaurant/cafe/bar owner sees kitchen/floor
// roles; a salon owner sees salon roles. Default = restaurant so every existing
// (non-salon) account stays byte-identical. Salon role names stay Danish in BOTH
// locales (proper role nouns, like the DK terminology lock) — plain strings,
// never t() keys.
export const ROLES_RESTAURANT = ["Chef", "Bartender", "Server", "Runner", "Dishwasher", "Manager"];
export const ROLES_SALON = ["Frisør", "Barber", "Kolorist", "Kosmetolog", "Negletekniker", "Reception"];
// A shop and a workshop were offered Kok / Bartender / Tjener / Runner /
// Opvasker (vertical-fit audit, Oct 2026). Same rule as the salon: Danish role
// nouns in both languages, stored as typed. Retail resolves by ARCHETYPE, so
// every shop sibling (tøjbutik, kiosk, blomsterbutik, …) gets the shop roles.
export const ROLES_RETAIL = ["Butiksassistent", "Kasse", "Lager", "Butikschef"];
export const ROLES_WORKSHOP = ["Mekaniker", "Lærling", "Værkfører", "Kundeservice"];
const ROLES_BY_TYPE = { salon: ROLES_SALON, workshop: ROLES_WORKSHOP, mobile_repair: ROLES_WORKSHOP };
const ROLES_BY_ARCHETYPE = { retail: ROLES_RETAIL };
export function rolesFor(businessType) {
  const bt = String(businessType || "").toLowerCase();
  return ROLES_BY_TYPE[bt] || ROLES_BY_ARCHETYPE[archetypeIdFor(bt)] || ROLES_RESTAURANT;
}
