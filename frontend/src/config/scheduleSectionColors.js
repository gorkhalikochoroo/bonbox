/**
 * scheduleSectionColors.js — the OWNER schedule grid's section → colour map.
 *
 * WHY THIS IS A MODULE AND NOT A LITERAL INSIDE StaffSchedulePage.jsx
 *
 * The grid held ROLE_COLORS / ROLE_BAR / ROLE_LABEL_* inline, keyed on the
 * three HOSPITALITY sections (kitchen/bar/floor). roleSections.js resolves
 * FIVE — salon adds `treatment` and `front` — and the grid's lookups were
 * unguarded:
 *
 *     const colors = ROLE_COLORS[catFor(member.role)];   // undefined for salon
 *     …
 *     <span className={colors.dot} />                    // TypeError
 *
 * i.e. a white screen on the owner's own Vagtplan for every salon account, on
 * the desktop grid, the mobile day-list AND the staff panel. Sections and their
 * styling now live one import apart, and scheduleSectionColors.test.js asserts
 * TOTAL coverage of SECTION — so adding a section id can never again ship a
 * crash that only a salon owner sees. (eslint react-refresh/only-export-components
 * is why this is a new file rather than an export from the page: "Use a new file
 * to share constants or functions between components.")
 *
 * COLOUR IS STILL PER-SURFACE — roleSections.js decides none, on purpose. This
 * grid paints `floor` emerald; the staff app paints it violet because green is
 * reserved there for live/now. The two SALON sections do agree with the staff
 * app (treatment violet, front blue — StaffPortalPage roleBarColor) because
 * nothing in this grid had claimed those hues yet, and a stylist reading both
 * surfaces should not have to re-learn the palette.
 *
 * Labels are i18n keys, never literals — archetype doctrine.
 */

/** section id → chip/badge classes + the row dot. */
export const SECTION_COLORS = {
  kitchen: {
    bg: "bg-red-100 dark:bg-red-900/20",
    text: "text-red-800 dark:text-red-300",
    border: "border-red-200 dark:border-red-800",
    dot: "bg-red-500",
  },
  bar: {
    bg: "bg-blue-100 dark:bg-blue-900/20",
    text: "text-blue-800 dark:text-blue-300",
    border: "border-blue-200 dark:border-blue-800",
    dot: "bg-blue-500",
  },
  floor: {
    bg: "bg-gray-100 dark:bg-gray-800/50",
    text: "text-gray-800 dark:text-gray-300",
    border: "border-gray-100 dark:border-gray-800",
    dot: "bg-emerald-500",
  },
  treatment: {
    bg: "bg-violet-100 dark:bg-violet-900/20",
    text: "text-violet-800 dark:text-violet-300",
    border: "border-violet-200 dark:border-violet-800",
    dot: "bg-violet-500",
  },
  front: {
    bg: "bg-blue-100 dark:bg-blue-900/20",
    text: "text-blue-800 dark:text-blue-300",
    border: "border-blue-200 dark:border-blue-800",
    dot: "bg-blue-500",
  },
};

// Section as a 3px LEFT-BAR signal only (LOCKED design — no flood tint). Keyed
// by the SAME section as SECTION_COLORS so the bar always agrees with the row
// dot (red-500 / blue-500 / emerald-500 / violet-500). border-* = the bar hue.
export const SECTION_BAR = {
  kitchen: "border-red-500",
  bar: "border-blue-500",
  floor: "border-emerald-500",
  treatment: "border-violet-500",
  front: "border-blue-500",
};

// Section → its localized label (Køkken / Bar / Gulv / Behandling / Reception).
// Used by BOTH the colour legend AND the cross-role chip on a shift block so
// they always agree. DK terminology: a kitchen shift reads "Køkken", never the
// ambiguous "Chef" (= boss in Danish).
//
// The fallbacks live here and ONLY here. SECTION_META in roleSections.js carries
// the same labelKey for its own callers; the fallback STRING is not duplicated
// into SECTION_COLORS as a `label` field the way it used to be — two fallback
// sources for one key is precisely how the old ROLE_CATEGORY/roleBarColor pair
// drifted apart.
export const SECTION_LABEL_KEY = {
  kitchen: "roleKitchen",
  bar: "roleBar",
  floor: "roleFloor",
  treatment: "sectionTreatment",
  front: "sectionFront",
};

export const SECTION_LABEL_FALLBACK = {
  kitchen: "Kitchen",
  bar: "Bar",
  floor: "Floor",
  treatment: "Treatments",
  front: "Reception",
};
