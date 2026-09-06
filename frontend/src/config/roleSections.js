/**
 * roleSections.js — the ONE role→section map, shared by the owner's schedule
 * maker and the staff app.
 *
 * WHY THIS EXISTS
 *
 * There were two taxonomies and they disagreed. StaffSchedulePage.jsx carried a
 * ROLE_CATEGORY object; StaffPortalPage.jsx's roleBarColor() matched substrings
 * instead. Measured 2026-09-06 against 60 days of production shifts:
 *
 *     role         owner grid   staff app
 *     Chef         kitchen      kitchen           agrees
 *     Dishwasher   kitchen      UNCATEGORISED     disagrees
 *     Bartender    bar          bar               agrees only because
 *                                                 "Bartender" contains "bar"
 *     Server       floor        floor             agrees
 *     Runner       floor        UNCATEGORISED     disagrees
 *     Manager      floor        UNCATEGORISED     disagrees
 *
 * 33 of 80 shifts rendered uncategorised in the staff app, including every
 * dishwasher shift. Two hand-maintained lists drifting is a known failure mode
 * in this repo (see the SHAPES/_SHAPES note in tableArchetypes) — so this is a
 * module both sides import, not a second copy to keep in step.
 *
 * NOT HOSPITALITY-ONLY. The old map held six restaurant roles and every other
 * vertical fell through `|| "floor"` — so an entire salon (Frisør, Barber,
 * Kolorist, Kosmetolog, Negletekniker, Reception) rendered as one
 * undifferentiated "Floor" in the owner's own schedule maker. Sections are
 * keyed by ARCHETYPE here, the same way the rest of the product resolves
 * vertical behaviour (config/archetypes.js, twin of backend archetype.py).
 *
 * SECTIONS ARE OPTIONAL, ON PURPOSE. A shop, a consultancy or a one-person
 * business has no meaningful section split, and inventing "Floor" for them
 * would be vocabulary theatre. sectionFor() returns null there, and callers
 * render one ungrouped list — which is the honest shape for those verticals.
 *
 * THIS MODULE DOES NOT DECIDE COLOUR. The two surfaces deliberately differ:
 * the owner grid paints `floor` emerald, while the staff app paints it violet
 * because green is reserved exclusively for live/now (the Live pill and the
 * clocked-in ping) and painting the majority persona green flooded that app
 * with false live signals. Each surface maps section → its own colour; only
 * the SECTION has to agree.
 *
 * Labels are i18n keys, never literals — archetype doctrine.
 */

import { archetypeIdFor } from "./archetypes";

/** Section ids. Stable strings — persisted nowhere, but read by both surfaces. */
export const SECTION = {
  KITCHEN: "kitchen",
  BAR: "bar",
  FLOOR: "floor",
  TREATMENT: "treatment",
  FRONT: "front",
};

/** Display order + label key per section. Order is service order, not alphabet. */
export const SECTION_META = {
  [SECTION.KITCHEN]: { order: 1, labelKey: "roleKitchen", fallback: "Kitchen" },
  [SECTION.BAR]: { order: 2, labelKey: "roleBar", fallback: "Bar" },
  [SECTION.FLOOR]: { order: 3, labelKey: "roleFloor", fallback: "Floor" },
  [SECTION.TREATMENT]: { order: 1, labelKey: "sectionTreatment", fallback: "Treatments" },
  [SECTION.FRONT]: { order: 2, labelKey: "sectionFront", fallback: "Reception" },
};

/**
 * archetype id → { role: section }.
 *
 * Roles are the values the owner actually picks (ROLES_RESTAURANT /
 * ROLES_SALON in StaffSchedulePage). An archetype absent from this object has
 * NO sections — that is a deliberate statement about the vertical, not a gap.
 */
const HOSPITALITY = {
  exact: {
    // picker vocabulary (ROLES_RESTAURANT)
    chef: SECTION.KITCHEN,
    dishwasher: SECTION.KITCHEN,
    bartender: SECTION.BAR,
    server: SECTION.FLOOR,
    runner: SECTION.FLOOR,
    manager: SECTION.FLOOR,
    // lowercase / DK free-text forms ALREADY LIVE in staff_members.role —
    // 12 of 25 rows. The old capitalised-key map missed every one of these and
    // fell through to "floor", so a kitchen hand and a barista are painted
    // Gulv/emerald in the OWNER's grid today.
    kitchen: SECTION.KITCHEN,
    kok: SECTION.KITCHEN,
    "køkken": SECTION.KITCHEN,
    cook: SECTION.KITCHEN,
    opvask: SECTION.KITCHEN,
    opvasker: SECTION.KITCHEN,
    barista: SECTION.BAR,
    tjener: SECTION.FLOOR,
    waiter: SECTION.FLOOR,
    gulv: SECTION.FLOOR,
    floor: SECTION.FLOOR,
  },
  // Last-resort tier, ordered — first hit wins. "opvask"/"dish" before "bar",
  // and "barista"/"bartend" before the bare "bar", so an Opvasker never lands
  // behind the bar. This tier is why "Head Chef" and "Sous Chef" — both live in
  // production and in no role list — stay in the kitchen instead of going gray.
  substrings: [
    ["opvask", SECTION.KITCHEN],
    ["dish", SECTION.KITCHEN],
    ["chef", SECTION.KITCHEN],
    ["kok", SECTION.KITCHEN],
    ["køkken", SECTION.KITCHEN],
    ["kitchen", SECTION.KITCHEN],
    ["cook", SECTION.KITCHEN],
    ["barista", SECTION.BAR],
    ["bartend", SECTION.BAR],
    ["bar", SECTION.BAR],
    ["tjener", SECTION.FLOOR],
    ["waiter", SECTION.FLOOR],
    ["server", SECTION.FLOOR],
    ["runner", SECTION.FLOOR],
    ["manager", SECTION.FLOOR],
    ["gulv", SECTION.FLOOR],
    ["floor", SECTION.FLOOR],
  ],
};

const BY_ARCHETYPE = {
  food_service: HOSPITALITY,
  // A bar runs the same three sections; the mix differs, the vocabulary does not.
  bar: HOSPITALITY,
  // Salon: the split that matters is "with a client" vs "on the desk". A
  // colourist and a barber are not different departments, they are different
  // chairs. NOTE this substring list never contains "bar" — filing a salon
  // "Master Barber" behind a bar is exactly what per-archetype patterns
  // (and exact-before-substring) exist to prevent.
  salon: {
    exact: {
      "frisør": SECTION.TREATMENT,
      barber: SECTION.TREATMENT,
      kolorist: SECTION.TREATMENT,
      kosmetolog: SECTION.TREATMENT,
      negletekniker: SECTION.TREATMENT,
      reception: SECTION.FRONT,
    },
    substrings: [
      ["frisør", SECTION.TREATMENT],
      ["barber", SECTION.TREATMENT],
      ["kolorist", SECTION.TREATMENT],
      ["kosmetolog", SECTION.TREATMENT],
      ["negle", SECTION.TREATMENT],
      ["stylist", SECTION.TREATMENT],
      ["reception", SECTION.FRONT],
      ["desk", SECTION.FRONT],
    ],
  },
  // retail / services / personal / generic: intentionally absent. One ungrouped
  // list is the honest shape — see the module header.
};

/** Case/diacritic-tolerant lookup, so "frisør" and "Frisør" both resolve. */
function normalise(role) {
  return String(role || "").trim().toLowerCase();
}

/**
 * sectionFor(role, businessType) → section id, or null.
 *
 * null means BOTH "this vertical has no sections" and "this role is unknown
 * here". Callers must treat null as "ungrouped", never as a section — the old
 * `|| "floor"` default is exactly how a salon ended up labelled Floor.
 */
export function sectionFor(role, businessType) {
  const cfg = BY_ARCHETYPE[archetypeIdFor(businessType)];
  if (!cfg) return null;
  const r = normalise(role);
  if (!r) return null;
  if (cfg.exact[r]) return cfg.exact[r];          // exact first: salon "Barber" ≠ bar
  for (const [needle, section] of cfg.substrings) {
    if (r.includes(needle)) return section;        // substring last: "Head Chef" stays kitchen
  }
  return null;
}

/** True when this vertical groups by section at all. */
export function hasSections(businessType) {
  return Boolean(BY_ARCHETYPE[archetypeIdFor(businessType)]);
}

/** Section ids for a vertical, in service order. [] when it has none. */
export function sectionsFor(businessType) {
  const cfg = BY_ARCHETYPE[archetypeIdFor(businessType)];
  if (!cfg) return [];
  const seen = [...new Set(Object.values(cfg.exact))];
  return seen.sort(
    (a, b) => (SECTION_META[a]?.order ?? 99) - (SECTION_META[b]?.order ?? 99),
  );
}
