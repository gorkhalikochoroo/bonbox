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
 * COLOUR IS STILL PER-SURFACE — roleSections.js decides none, on purpose. But
 * this grid no longer disagrees with the staff app about the majority persona:
 * `floor` is VIOLET here too, as of the Option-B grid. Emerald was taken off it
 * deliberately — emerald now means exactly ONE thing on the owner grid, "seen
 * by staff", and a role bar wearing the same green made that signal unreadable
 * (a Gulv row looked acknowledged whether or not anyone had opened it). The
 * staff app had already reserved green for live/now, so the two surfaces now
 * agree on all five: kitchen red, bar blue, floor violet, treatment violet,
 * front blue (StaffPortalPage roleBarColor).
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
    dot: "bg-violet-500",
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

// Section as a 3px LEFT BAR on a PUBLISHED shift card. Keyed by the SAME
// section as SECTION_COLORS so the bar always agrees with the row dot (red-500
// / blue-500 / violet-500). border-* = the bar hue. `floor` carries a dark-mode
// step because violet-500 on a gray-900 card is the one bar that loses
// contrast at 3px.
//
// The card used to be white with the bar as its only colour ("no flood tint on
// the CARD"). That lock is lifted as of 3 Nov 2026: the owner asked for the
// boxes to be coloured by who works them (his mockup), so a published card now
// also wears its section's soft fill — SECTION_CARD below. A DRAFT no longer
// carries the bar at all (see CARD_DRAFT in StaffSchedulePage.jsx).
export const SECTION_BAR = {
  kitchen: "border-red-500",
  bar: "border-blue-500",
  floor: "border-violet-500 dark:border-violet-400",
  treatment: "border-violet-500",
  front: "border-blue-500",
};

// The bar for a vertical that has NO sections (retail / services / personal).
//
// Every card carries a 3px left bar, and on a section-less vertical the grid's
// `|| "floor"` fallback painted all of them violet — a colour key with nothing
// in the legend to read it by, since the legend's "Roller:" block is suppressed
// on exactly those verticals. That is the same defect the row dot was
// suppressed for, on a bigger surface, and F1 made it louder by moving `floor`
// off emerald onto a hue nothing else on the page uses.
//
// Neutral, not absent: the bar is also what gives the card its left inset, so
// dropping it would reflow every cell. Grey says "this is a card edge", which
// is true, instead of "this is a role", which is not.
export const SECTION_BAR_NEUTRAL = "border-gray-200 dark:border-gray-700";

// A PUBLISHED shift card, by section: the soft fill, the hairline ring that
// edges it, the hover step (the phone chip is a button), the job-title tag's
// ink and the dot a DRAFT shows in front of that tag (a draft has no bar, so
// the dot is where its section stays readable).
//
// Same hue family as SECTION_BAR and the row dot, one step softer than the
// section HEADER band's pill so a card never reads as a header. Dark mode uses
// the /10 tints over the gray-800 card, like SECTION_HEADER: a -50 flood on a
// dark table is a light slab. Contrast, measured in Chromium from the compiled
// CSS for all five sections + the draft cream (3 Nov 2026, lab NOTES.md):
// light — time 16.2:1, hours (gray-600) 6.9:1, tag (-700) 5.9:1, ✓ 3.3:1;
// dark — time 11.3:1, hours (gray-300) 8.5:1, tag (-300) 6.5:1, ✓ 6.4:1
// (each the lowest over every fill). gray-500 hours would be 4.4:1 on red-50.
// The dark fills are TRANSLUCENT, so the row hover (gray-700/40) and the cell
// hover (gray-700/50) show through the card. With the pointer on a draft the
// worst case is hours 6.7:1 (gray-300; gray-400 was 3.8:1), tag 5.2:1, the
// conflict label (red-300) 5.2:1, ✓ 5.1:1. Text ON these fills is chosen for
// that worst case, not for the card at rest.
export const SECTION_CARD = {
  kitchen: { fill: "bg-red-50 dark:bg-red-500/10", ring: "ring-red-200 dark:ring-red-500/30", hover: "hover:bg-red-100 dark:hover:bg-red-500/20", tag: "text-red-700 dark:text-red-300", dot: "bg-red-500" },
  bar: { fill: "bg-blue-50 dark:bg-blue-500/10", ring: "ring-blue-200 dark:ring-blue-500/30", hover: "hover:bg-blue-100 dark:hover:bg-blue-500/20", tag: "text-blue-700 dark:text-blue-300", dot: "bg-blue-500" },
  floor: { fill: "bg-violet-50 dark:bg-violet-500/10", ring: "ring-violet-200 dark:ring-violet-500/30", hover: "hover:bg-violet-100 dark:hover:bg-violet-500/20", tag: "text-violet-700 dark:text-violet-300", dot: "bg-violet-500" },
  treatment: { fill: "bg-violet-50 dark:bg-violet-500/10", ring: "ring-violet-200 dark:ring-violet-500/30", hover: "hover:bg-violet-100 dark:hover:bg-violet-500/20", tag: "text-violet-700 dark:text-violet-300", dot: "bg-violet-500" },
  front: { fill: "bg-blue-50 dark:bg-blue-500/10", ring: "ring-blue-200 dark:ring-blue-500/30", hover: "hover:bg-blue-100 dark:hover:bg-blue-500/20", tag: "text-blue-700 dark:text-blue-300", dot: "bg-blue-500" },
};

// The card on a vertical with NO sections (retail / services / personal): the
// same reason as SECTION_BAR_NEUTRAL — no "Roller:" legend, so no hue. White
// card, gray ring, gray ink, and no dot at all.
export const SECTION_CARD_NEUTRAL = {
  fill: "bg-white dark:bg-[rgb(var(--surface-card))]",
  ring: "ring-gray-200 dark:ring-gray-700",
  hover: "hover:bg-gray-50 dark:hover:bg-[rgb(var(--surface-raised))]",
  tag: "text-gray-600 dark:text-gray-300",
  dot: "",
};

// Section HEADER row (Option B — one tinted band per section above its people).
// The band reads as "new group starts here". Its per-day number is a PILL in
// the section's tint (`pill`), one step stronger than the band and the cards
// so it stays a shape on its own band. `other` is NOT a section roleSections
// can return — it is the grid's own bucket for a role this vertical has no
// section for (a café "DJ"), so it stays deliberately colourless rather than
// borrowing a real section's hue. Dark mode uses the /10 tints: a -50 flood on
// a gray-900 table is a light bar.
export const SECTION_HEADER = {
  kitchen: { bg: "bg-red-50 dark:bg-red-500/10", bar: "border-red-500", text: "text-red-700 dark:text-red-300", dot: "bg-red-500", pill: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200" },
  bar: { bg: "bg-blue-50 dark:bg-blue-500/10", bar: "border-blue-500", text: "text-blue-700 dark:text-blue-300", dot: "bg-blue-500", pill: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200" },
  floor: { bg: "bg-violet-50 dark:bg-violet-500/10", bar: "border-violet-500", text: "text-violet-700 dark:text-violet-300", dot: "bg-violet-500", pill: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200" },
  treatment: { bg: "bg-violet-50 dark:bg-violet-500/10", bar: "border-violet-500", text: "text-violet-700 dark:text-violet-300", dot: "bg-violet-500", pill: "bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200" },
  front: { bg: "bg-blue-50 dark:bg-blue-500/10", bar: "border-blue-500", text: "text-blue-700 dark:text-blue-300", dot: "bg-blue-500", pill: "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200" },
  other: { bg: "bg-gray-50 dark:bg-gray-500/10", bar: "border-gray-300", text: "text-gray-700 dark:text-gray-300", dot: "bg-gray-300 dark:bg-gray-600", pill: "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-200" },
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
  // Grid-only bucket (see SECTION_HEADER) — never returned by sectionFor().
  other: "sectionOther",
};

export const SECTION_LABEL_FALLBACK = {
  kitchen: "Kitchen",
  bar: "Bar",
  floor: "Floor",
  treatment: "Treatments",
  front: "Reception",
  other: "Other",
};
