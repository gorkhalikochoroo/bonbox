/**
 * archetypes.js — the canonical FRONTEND business-archetype layer. The exact
 * twin of backend `app/services/archetype.py`: same archetype ids, same
 * business_type→archetype map, same dashboard_mode / floor_vocab / module
 * values. The UI (onboarding wizard, nav emphasis, dashboard ordering) reads
 * the resolved archetype from HERE so it always agrees with what the backend
 * applied at signup.
 *
 * WHY: business_type is free-text (~26 strings across 3 different pickers).
 * Before this, vertical→behaviour lived in `dashboardCardSets.js` (2 modes)
 * and `venueProfiles.js` (4 vocabularies) with divergent keysets. This module
 * is the single resolver; it EXPOSES `dashboardMode` + `floorVocab` so those
 * two configs can align to one resolved archetype instead of re-deriving.
 *
 * DOCTRINE (mirror of the backend module):
 *   • Archetype = DEFAULTS + EMPHASIS only. Orthogonal to TIER (useEntitlements
 *     gates access) and to LIVE DATA (a surface shows when real data exists —
 *     the #178 footgun fix in dashboardCardSets.deriveActivations). Never HIDE
 *     a surface the owner has data in; archetype only orders/leads + supplies
 *     the brand-new-account default.
 *   • Unknown / null / blank business_type → `generic` (most permissive).
 *   • All user-facing labels are i18n KEYS resolved by t() — never literals.
 */

// dashboardMode ∈ {transactionalDaily, projectWeekly}  (dashboardCardSets.js)
// floorVocab    ∈ {dining, bar, salon, generic}        (venueProfiles.js)
// leadFeatures / firstWin use semantic keys the nav + onboarding map to routes:
//   daily_close | tax | reservations | schedule | inventory | faktura | expenses
export const ARCHETYPES = {
  food_service: {
    id: "food_service",
    labelKey: "archFoodService",
    taglineKey: "archFoodServiceTagline",
    dashboardMode: "transactionalDaily",
    floorVocab: "dining",
    leadFeatures: ["daily_close", "tax", "reservations", "schedule", "inventory"],
    firstWin: "daily_close",
    suggestedModules: ["competitor", "weather", "expiry"],
    emphasizeChannels: ["dine_in", "takeaway", "wolt", "uber_eats"],
  },
  bar: {
    id: "bar",
    labelKey: "archBar",
    taglineKey: "archBarTagline",
    dashboardMode: "transactionalDaily",
    floorVocab: "bar",
    leadFeatures: ["daily_close", "tax", "inventory", "schedule"],
    firstWin: "daily_close",
    suggestedModules: ["pour", "wine", "competitor"],
    emphasizeChannels: ["dine_in", "takeaway"],
  },
  retail: {
    id: "retail",
    labelKey: "archRetail",
    taglineKey: "archRetailTagline",
    dashboardMode: "transactionalDaily",
    floorVocab: "generic",
    leadFeatures: ["inventory", "daily_close", "tax", "expenses"],
    firstWin: "inventory",
    suggestedModules: ["khata", "expiry"],
    emphasizeChannels: ["web", "phone"],
  },
  salon: {
    id: "salon",
    labelKey: "archSalon",
    taglineKey: "archSalonTagline",
    dashboardMode: "transactionalDaily",
    floorVocab: "salon",
    leadFeatures: ["reservations", "schedule", "tax", "daily_close"],
    firstWin: "reservations",
    suggestedModules: ["competitor"],
    emphasizeChannels: ["phone", "web"],
  },
  services: {
    id: "services",
    labelKey: "archServices",
    taglineKey: "archServicesTagline",
    dashboardMode: "projectWeekly",
    floorVocab: "generic",
    leadFeatures: ["faktura", "expenses", "tax"],
    firstWin: "faktura",
    suggestedModules: ["workshop", "loan", "khata"],
    emphasizeChannels: ["phone", "web"],
  },
  personal: {
    id: "personal",
    labelKey: "archPersonal",
    taglineKey: "archPersonalTagline",
    dashboardMode: "projectWeekly",
    floorVocab: "generic",
    leadFeatures: ["expenses", "tax"],
    firstWin: "expenses",
    suggestedModules: [],
    emphasizeChannels: [],
  },
  generic: {
    id: "generic",
    labelKey: "archGeneric",
    taglineKey: "archGenericTagline",
    dashboardMode: "transactionalDaily",
    floorVocab: "generic",
    leadFeatures: ["daily_close", "tax", "expenses", "inventory"],
    firstWin: "daily_close",
    suggestedModules: [],
    emphasizeChannels: [],
  },
};

// Every business_type string any picker can produce → archetype id.
// MUST stay in sync with backend BUSINESS_TYPE_TO_ARCHETYPE (archetype.py).
export const BUSINESS_TYPE_TO_ARCHETYPE = {
  restaurant: "food_service",
  cafe: "food_service",
  bakery: "food_service",
  tea_shop: "food_service",
  food_truck: "food_service",
  takeaway: "food_service",
  bar: "bar",
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
  salon: "salon",
  mobile_repair: "services",
  laundry: "services",
  workshop: "services",
  freelancer: "services",
  event_organizer: "services",
  personal: "personal",
  general: "generic",
  other: "generic",
};

/** Resolve a business_type string → canonical archetype id (never throws;
 *  unknown / null / blank → "generic"). */
export function archetypeIdFor(businessType) {
  if (!businessType) return "generic";
  return BUSINESS_TYPE_TO_ARCHETYPE[String(businessType).trim().toLowerCase()] || "generic";
}

/** Resolve a business_type → the full archetype record (never undefined). */
export function archetypeFor(businessType) {
  return ARCHETYPES[archetypeIdFor(businessType)] || ARCHETYPES.generic;
}

/** Convenience: resolve straight from a user object (user.business_type). */
export function archetypeForUser(user) {
  return archetypeFor(user?.business_type);
}
