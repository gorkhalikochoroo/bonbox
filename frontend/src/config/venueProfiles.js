/**
 * venueProfiles — the "venue archetype" layer for the 2D reservation floor
 * designer (components/FloorPlan.jsx, rendered by pages/ReservationsPage.jsx).
 *
 * WHY THIS EXISTS
 * ---------------
 * The floor designer was born restaurant-centric: it called every bookable
 * resource a "table", ringed it with chairs, and offered Indoor/Terrace
 * zones. BonBox serves many small-business verticals, so the floor view
 * should speak each account's language — the noun (Table / Station / Space),
 * the default shape, one well-chosen Lucide icon, and sensible zone presets —
 * driven by `user.business_type`.
 *
 * This is a FRONTEND vocabulary + visual layer ONLY. It changes nouns, the
 * default shape a resource picks when it has none, the section icon, and the
 * suggested zone labels. It does NOT touch the drag / save / status / tap
 * logic, the data model, or any backend contract.
 *
 * DESIGN DOCTRINE (mirrors FloorPlan.jsx):
 *   • gray-900 primary; status colors (free/upcoming/seated/overdue) only.
 *   • the archetype icon is rendered SUBTLY (faint, decorative) — never a
 *     splash of brand color. One icon per archetype, chosen to read at a
 *     glance, not to decorate.
 *
 * KEYS, NOT STRINGS
 * -----------------
 * Every user-facing label here is an i18n KEY (resolved by the component's
 * `t()`), never a literal — so the EN/DA blocks in useLanguage.jsx stay the
 * single source of truth and the raw-key-leak guard (scripts/check-i18n-keys)
 * can verify each one. The icon is a Lucide component reference.
 *
 * `business_type` values are the canonical set collected at signup /on the
 * profile (RegisterPage.jsx, ProfilePage.jsx). Unknown / null / service- and
 * retail-type values fall through to the `generic` archetype — the most
 * neutral vocabulary ("Space"), so a flower shop or a clinic still gets a
 * coherent, non-restaurant floor.
 */

import { Armchair, Beer, Scissors, Croissant, ShoppingBag, Wrench } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────
// Archetypes. Each carries:
//   id                 — stable key (analytics / debugging)
//   icon               — Lucide component, rendered faint (decorative) on the
//                        floor designer.
//   glanceIcon         — the ONE Lucide glyph that reads this vertical at a
//                        glance in chrome (settings preview, headers). Often
//                        the same as `icon`; split out so a future header can
//                        differ from the floor mark without breaking it.
//   bookingMode        — "table" | "provider" | "none". Gates the table floor
//                        / couverts / floor-map on the VENUE TYPE, never on
//                        tables==0 (honesty gate #1): a salon is "provider", a
//                        bakery/retail is "none", dining/bar is "table". This
//                        is a LABEL/IA gate only — the booking primitive itself
//                        stays table-shaped underneath in Phase A (NOT
//                        appointment-grade; see plan honesty_gates #2).
//   cutoffHour         — the display business-day cutoff hour this vertical
//                        rolls over at (mirrors archetype default_cutoff_hour /
//                        archetypes.js). Surfaced as a hint in chrome; the
//                        authoritative value still lives on
//                        BusinessProfile.day_cutoff_hour.
//   nounKey/nounPluralKey   — "Table" / "Tables" etc. (i18n keys)
//   unitKey            — how capacity reads ("seats" / "per chair" / "capacity")
//   stationLike        — true → render ONE person/seat marker, not N chairs,
//                        and prefer the station name over a seat count.
//   defaultShape(seats) — shape to use when a resource has no `shape` set.
//   zonePresetKeys     — suggested zone labels when arranging (i18n keys);
//                        [] = no presets (don't suggest any).
//   emptyTitleKey / emptyBodyKey  — empty-state copy for THIS vocabulary.
//   tapHintKey         — "Tap a {noun} to …" hint (view mode).
//   dragHintKey        — "Drag {nouns} to arrange …" hint (edit mode).
//   arrangeKey         — the "Arrange room/studio/bar" CTA label.
// ─────────────────────────────────────────────────────────────────────

export const VENUE_ARCHETYPES = {
  // dining — restaurant / cafe / bakery / tea_shop / food_truck.
  // Round for an intimate top (≤4), square for a larger shared table (≥6).
  dining: {
    id: "dining",
    icon: Armchair,
    glanceIcon: Armchair,
    bookingMode: "table",
    cutoffHour: 6,
    nounKey: "venueNounTable",
    nounPluralKey: "venueNounTablePlural",
    unitKey: "venueUnitSeats",
    stationLike: false,
    defaultShape: (seats) => (Number(seats) >= 6 ? "square" : "round"),
    zonePresetKeys: ["venueZoneIndoor", "venueZoneTerrace", "venueZoneWindow"],
    emptyTitleKey: "venueEmptyTablesTitle",
    emptyBodyKey: "venueEmptyTablesBody",
    tapHintKey: "venueTapTable",
    dragHintKey: "venueDragTables",
    arrangeKey: "venueArrangeRoom",
    // Floor TAB (resource authoring) vocabulary.
    floorIntroKey: "venueFloorIntroTables",
    floorEmptyKey: "venueFloorEmptyTables",
  },

  // bar — a bar / pub. High-tops + small square tables; bar-side seating.
  bar: {
    id: "bar",
    icon: Beer,
    glanceIcon: Beer,
    bookingMode: "table",
    cutoffHour: 6,
    nounKey: "venueNounTable",
    nounPluralKey: "venueNounTablePlural",
    unitKey: "venueUnitSeats",
    stationLike: false,
    // Bars skew to small square high-tops; only a big shared table stays
    // square-large, everything else reads as a compact square.
    defaultShape: () => "square",
    zonePresetKeys: ["venueZoneBar", "venueZoneLounge", "venueZoneTerrace"],
    emptyTitleKey: "venueEmptyTablesTitle",
    emptyBodyKey: "venueEmptyTablesBody",
    tapHintKey: "venueTapTable",
    dragHintKey: "venueDragTables",
    arrangeKey: "venueArrangeBar",
    floorIntroKey: "venueFloorIntroTables",
    floorEmptyKey: "venueFloorEmptyTables",
  },

  // salon — a styling chair / station tied to a person. One seat per station;
  // we show the station name and a single person marker, not a ring of chairs.
  salon: {
    id: "salon",
    icon: Scissors,
    glanceIcon: Scissors,
    // Salon books a PROVIDER (a chair/behandler tied to a person), not a table.
    // bookingMode "provider" gates the table floor + couverts OFF on TYPE — the
    // salon never flashes "no tables yet". As of S3b the booking primitive IS a
    // real tidsbestilling: behandling → behandler → dato → tid, with the
    // duration resolved from the behandlinger catalog, availability driven by
    // the behandler's published shifts, and a pinned behandler failing closed
    // (409) instead of silently rebooking. The owner New-booking sheet and the
    // public /r/<slug> page both render this provider flow.
    bookingMode: "provider",
    cutoffHour: 0,
    nounKey: "venueNounStation",
    nounPluralKey: "venueNounStationPlural",
    unitKey: "venueUnitPerChair",
    stationLike: true,
    defaultShape: () => "round",
    zonePresetKeys: ["venueZoneStyling", "venueZoneWash", "venueZoneNails"],
    emptyTitleKey: "venueEmptyStationsTitle",
    emptyBodyKey: "venueEmptyStationsBody",
    tapHintKey: "venueTapStation",
    dragHintKey: "venueDragStations",
    arrangeKey: "venueArrangeStudio",
    floorIntroKey: "venueFloorIntroStations",
    floorEmptyKey: "venueFloorEmptyStations",
  },

  // bakery — counter trade, no table reservations (honesty lock: NO
  // pre-order / click-collect primitive exists — Reservations stays OFF
  // rather than fake it). Kept distinct from generic only for the glance
  // icon + the 04:00 overnight-bake cutoff; vocabulary is the neutral Space
  // set since the floor designer is not offered to a bakery.
  bakery: {
    id: "bakery",
    icon: Croissant,
    glanceIcon: Croissant,
    bookingMode: "none",
    cutoffHour: 4,
    nounKey: "venueNounSpace",
    nounPluralKey: "venueNounSpacePlural",
    unitKey: "venueUnitCapacity",
    stationLike: false,
    defaultShape: () => "round",
    zonePresetKeys: [],
    emptyTitleKey: "venueEmptySpacesTitle",
    emptyBodyKey: "venueEmptySpacesBody",
    tapHintKey: "venueTapSpace",
    dragHintKey: "venueDragSpaces",
    arrangeKey: "venueArrangeSpaces",
    floorIntroKey: "venueFloorIntroSpaces",
    floorEmptyKey: "venueFloorEmptySpaces",
  },

  // retail — inventory-led shop. No floor/covers; the cleanest non-restaurant
  // fit. Glance icon is the bag; midnight cutoff (no late-night window).
  retail: {
    id: "retail",
    icon: ShoppingBag,
    glanceIcon: ShoppingBag,
    bookingMode: "none",
    cutoffHour: 0,
    nounKey: "venueNounSpace",
    nounPluralKey: "venueNounSpacePlural",
    unitKey: "venueUnitCapacity",
    stationLike: false,
    defaultShape: () => "round",
    zonePresetKeys: [],
    emptyTitleKey: "venueEmptySpacesTitle",
    emptyBodyKey: "venueEmptySpacesBody",
    tapHintKey: "venueTapSpace",
    dragHintKey: "venueDragSpaces",
    arrangeKey: "venueArrangeSpaces",
    floorIntroKey: "venueFloorIntroSpaces",
    floorEmptyKey: "venueFloorEmptySpaces",
  },

  // generic — workshop / services / clinic / freelancer / anything we don't
  // model yet. The most neutral vocabulary: "Space". No zone presets, no floor
  // booking (bookingMode "none"). The Wrench glance icon reads "general work".
  generic: {
    id: "generic",
    icon: Armchair,
    glanceIcon: Wrench,
    bookingMode: "none",
    cutoffHour: 0,
    nounKey: "venueNounSpace",
    nounPluralKey: "venueNounSpacePlural",
    unitKey: "venueUnitCapacity",
    stationLike: false,
    defaultShape: () => "round",
    zonePresetKeys: [],
    emptyTitleKey: "venueEmptySpacesTitle",
    emptyBodyKey: "venueEmptySpacesBody",
    tapHintKey: "venueTapSpace",
    dragHintKey: "venueDragSpaces",
    arrangeKey: "venueArrangeSpaces",
    floorIntroKey: "venueFloorIntroSpaces",
    floorEmptyKey: "venueFloorEmptySpaces",
  },
};

// business_type → archetype id. The canonical values come from the signup /
// profile selects (RegisterPage.jsx, ProfilePage.jsx). Food-service verticals
// map to `dining`; the bar to `bar`; the salon to `salon`; everything else
// (retail, grocery, pharmacy, freelancer, …) falls through to `generic`.
export const BUSINESS_TYPE_TO_VENUE = {
  restaurant: "dining",
  cafe: "dining",
  // bakery now resolves to its OWN archetype (Croissant glance icon + 04:00
  // cutoff + bookingMode "none") — NOT dining. A production bakery is counter
  // trade and must never be offered a table floor it can't use.
  bakery: "bakery",
  tea_shop: "dining",
  food_truck: "dining",
  takeaway: "generic", // counter trade → generic (bookingMode "none", no floor)
  bar: "bar",
  salon: "salon",
  // retail + retail siblings → the inventory-led "retail" archetype (no floor).
  retail: "retail",
  clothing: "retail",
  online_clothing: "retail",
  grocery: "retail",
  veggie_shop: "retail",
  kiosk: "retail",
  electronics: "retail",
  pharmacy: "retail",
  cosmetics: "retail",
  stationery: "retail",
  hardware: "retail",
  flower_shop: "retail",
  jewelry: "retail",
  thrift: "retail",
  wholesale: "retail",
};

/**
 * venueProfile(businessType, resource?) — the single entry point.
 *
 * Returns a venue archetype record (NEVER undefined; unknown → generic).
 *
 * Override rule: if a specific `resource` is passed AND it is a provider
 * (`kind === "provider"` — a station/chair tied to a staff member's
 * schedule), it is treated VISUALLY as a salon-style station even inside a
 * dining venue. This lets a restaurant that also books a barber's chair, or
 * a clinic-style provider, render a person marker instead of chair dots —
 * subtle, per-resource, without changing the venue's overall vocabulary.
 *
 * Pass NO resource (or a non-provider one) to get the account-level profile
 * used for headers, empty states, and bulk vocabulary.
 */
export function venueProfile(businessType, resource = null) {
  if (resource && resource.kind === "provider") {
    return VENUE_ARCHETYPES.salon;
  }
  const id = BUSINESS_TYPE_TO_VENUE[businessType] || "generic";
  return VENUE_ARCHETYPES[id] || VENUE_ARCHETYPES.generic;
}

/**
 * bookingModeFor(businessType) — the booking primitive a vertical uses, gated
 * on the venue TYPE: "table" (dining/bar/cafe), "provider" (salon), or "none"
 * (bakery/retail/takeaway/services/unknown).
 *
 * THIS IS THE HONESTY GATE (#1): consumers hide the table floor / floor-map /
 * couverts when this is NOT "table" — keyed on the TYPE, never on tables==0.
 * A salon (provider) and a bakery (none) therefore never flash "no tables yet".
 *
 * Note: in Phase A, "provider" still renders the table-shaped book underneath
 * (it is a label/IA reskin, NOT an appointment engine). Only `bookingMode ===
 * "table"` should mount the floor designer / floor-map / party+couvert UI.
 */
export function bookingModeFor(businessType) {
  return venueProfile(businessType).bookingMode || "none";
}

/** True iff this vertical books physical TABLES (the only mode that should
 *  render the floor designer, the public floor-map, party size + couverts).
 *  Salon ("provider") and bakery/retail ("none") both return false. */
export function usesTableFloor(businessType) {
  return bookingModeFor(businessType) === "table";
}
