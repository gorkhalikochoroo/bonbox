/**
 * businessTypes.js — the ONE business-type catalogue the type pickers offer.
 *
 * Every value here is a key of BUSINESS_TYPE_TO_ARCHETYPE (config/archetypes.js
 * and its backend twin archetype.py), so whatever an owner picks resolves to a
 * real archetype — and the backend's POST /auth/business-type accepts exactly
 * this set (it 422s a type outside the map).
 *
 * WHY: Profile carried its own list of 27 and it had drifted from onboarding.
 * There was no Værksted and no Andet, so the bike workshop's Profile select
 * showed a raw "workshop" option, and once an owner switched away they could
 * not pick Værksted again; freelancer and event_organizer were missing and
 * "other" read lowercase "andet" (vertical-fit audit, Oct 2026).
 *
 * `legacy: true` rows are shown only when the account already holds that value
 * — "other" is the old spelling of "general" (both resolve to generic), so a
 * new pick never sees two "Andet".
 */

export const BUSINESS_TYPE_GROUPS = [
  {
    id: "food",
    labelKey: "foodAndDrink",
    types: [
      { value: "restaurant", labelKey: "btRestaurant" },
      { value: "cafe", labelKey: "btCafe" },
      { value: "bar", labelKey: "btBar" },
      { value: "bakery", labelKey: "btBakery" },
      { value: "takeaway", labelKey: "btTakeaway" },
      { value: "food_truck", labelKey: "btFoodTruck" },
      { value: "tea_shop", labelKey: "btTeaShop" },
    ],
  },
  {
    id: "retail",
    labelKey: "retail",
    types: [
      { value: "clothing", labelKey: "btClothing" },
      { value: "online_clothing", labelKey: "btOnlineClothing" },
      { value: "grocery", labelKey: "btGrocery" },
      { value: "veggie_shop", labelKey: "btVeggieShop" },
      { value: "kiosk", labelKey: "btKiosk" },
      { value: "electronics", labelKey: "btElectronics" },
      { value: "pharmacy", labelKey: "btPharmacy" },
      { value: "cosmetics", labelKey: "btCosmetics" },
      { value: "stationery", labelKey: "btStationery" },
      { value: "hardware", labelKey: "btHardware" },
      { value: "flower_shop", labelKey: "btFlowerShop" },
      { value: "jewelry", labelKey: "btJewelry" },
      { value: "thrift", labelKey: "btThrift" },
      { value: "retail", labelKey: "btGeneralRetail" },
      { value: "wholesale", labelKey: "btWholesale" },
    ],
  },
  {
    id: "services",
    labelKey: "services",
    types: [
      { value: "salon", labelKey: "btSalon" },
      { value: "workshop", labelKey: "branchWorkshop" },
      { value: "mobile_repair", labelKey: "btMobileRepair" },
      { value: "laundry", labelKey: "btLaundry" },
      { value: "freelancer", labelKey: "btFreelancer" },
      { value: "event_organizer", labelKey: "btEventOrganizer" },
    ],
  },
  {
    id: "other",
    labelKey: "btGroupOther",
    types: [
      { value: "general", labelKey: "branchGeneral" },
      { value: "other", labelKey: "branchGeneral", legacy: true },
      { value: "personal", labelKey: "personalFinance" },
    ],
  },
];

/** Every value the catalogue knows (legacy rows included). */
export const BUSINESS_TYPE_VALUES = BUSINESS_TYPE_GROUPS.flatMap((g) => g.types.map((x) => x.value));

/** The groups to render for an account currently holding `current`: legacy
 *  rows only when they are that account's own value. */
export function businessTypeGroupsFor(current) {
  return BUSINESS_TYPE_GROUPS.map((g) => ({
    ...g,
    types: g.types.filter((x) => !x.legacy || x.value === current),
  }));
}

/** The label key for a business type value, or null when it is not in the
 *  catalogue. */
export function businessTypeLabelKey(value) {
  for (const g of BUSINESS_TYPE_GROUPS) {
    const hit = g.types.find((x) => x.value === value);
    if (hit) return hit.labelKey;
  }
  return null;
}
