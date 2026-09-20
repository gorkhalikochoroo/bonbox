/**
 * inventoryTemplates.js — the starter-list catalogue behind "Indlæs skabelon"
 * on /inventory, plus the server-category label map that page reads.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The picker is the first thing an owner with an empty lager opens, and it
 * used to live inline in InventoryPage.jsx as 23 rows of hardcoded ENGLISH
 * name + description, one EMOJI per row, and a COLOR_MAP spreading the list
 * across eleven decorative hues. A Danish café owner met a developer's labels,
 * in the wrong language, in a rainbow.
 *
 * So, matching the rest of src/config/: every user-facing label is an i18n KEY
 * resolved by t() (real en + da in useLanguage.jsx — never a literal), the icon
 * is a Lucide name from the components/ui/Icon.jsx registry, and there is no
 * colour field at all. Colour on that screen would carry no status, and status
 * is the only thing colour is allowed to carry.
 *
 * `type` is the WIRE value: it is posted to /inventory/templates/load and must
 * keep matching HARDCODED_TEMPLATES in backend/app/routers/inventory.py.
 * `count` is how many rows that backend list holds, shown so the owner knows
 * how much lands before they tap.
 */

export const INVENTORY_TEMPLATES = [
  // Mad & drikke
  { type: "restaurant", icon: "Utensils", count: 13, nameKey: "invTmplRestaurant", descKey: "invTmplRestaurantDesc" },
  { type: "cafe", icon: "Coffee", count: 13, nameKey: "invTmplCafe", descKey: "invTmplCafeDesc" },
  { type: "bakery", icon: "Croissant", count: 13, nameKey: "invTmplBakery", descKey: "invTmplBakeryDesc" },
  { type: "bar", icon: "Martini", count: 30, nameKey: "invTmplBar", descKey: "invTmplBarDesc" },
  { type: "food_truck", icon: "Truck", count: 13, nameKey: "invTmplFoodTruck", descKey: "invTmplFoodTruckDesc" },
  { type: "tea_shop", icon: "Coffee", count: 10, nameKey: "invTmplTeaShop", descKey: "invTmplTeaShopDesc" },
  // Butik
  { type: "clothing", icon: "ShoppingBag", count: 12, nameKey: "invTmplClothing", descKey: "invTmplClothingDesc" },
  { type: "online_clothing", icon: "Package", count: 12, nameKey: "invTmplOnlineClothing", descKey: "invTmplOnlineClothingDesc" },
  { type: "veggie_shop", icon: "Leaf", count: 13, nameKey: "invTmplVeggieShop", descKey: "invTmplVeggieShopDesc" },
  { type: "grocery", icon: "ShoppingCart", count: 12, nameKey: "invTmplGrocery", descKey: "invTmplGroceryDesc" },
  { type: "kiosk", icon: "Store", count: 12, nameKey: "invTmplKiosk", descKey: "invTmplKioskDesc" },
  { type: "electronics", icon: "Smartphone", count: 11, nameKey: "invTmplElectronics", descKey: "invTmplElectronicsDesc" },
  { type: "pharmacy", icon: "Beaker", count: 12, nameKey: "invTmplPharmacy", descKey: "invTmplPharmacyDesc" },
  { type: "cosmetics", icon: "Palette", count: 10, nameKey: "invTmplCosmetics", descKey: "invTmplCosmeticsDesc" },
  { type: "stationery", icon: "BookOpen", count: 10, nameKey: "invTmplStationery", descKey: "invTmplStationeryDesc" },
  { type: "hardware", icon: "Hammer", count: 10, nameKey: "invTmplHardware", descKey: "invTmplHardwareDesc" },
  { type: "flower_shop", icon: "Gift", count: 9, nameKey: "invTmplFlowerShop", descKey: "invTmplFlowerShopDesc" },
  { type: "jewelry", icon: "Sparkles", count: 8, nameKey: "invTmplJewelry", descKey: "invTmplJewelryDesc" },
  { type: "mobile_repair", icon: "Wrench", count: 8, nameKey: "invTmplMobileRepair", descKey: "invTmplMobileRepairDesc" },
  // Service
  { type: "salon", icon: "Scissors", count: 12, nameKey: "invTmplSalon", descKey: "invTmplSalonDesc" },
  // WashingMachine / Recycle, not RotateCw / RotateCcw: the first pass gave
  // these two rows the same circular arrow mirrored, so at 18px and two rows
  // apart they were one silhouette that meant neither trade.
  { type: "laundry", icon: "WashingMachine", count: 10, nameKey: "invTmplLaundry", descKey: "invTmplLaundryDesc" },
  { type: "thrift", icon: "Recycle", count: 10, nameKey: "invTmplThrift", descKey: "invTmplThriftDesc" },
  // Alt andet
  { type: "other", icon: "Boxes", count: 20, nameKey: "invTmplOther", descKey: "invTmplOtherDesc" },
];

/**
 * Server category → i18n key.
 *
 * The backend seeds every template row with an ENGLISH category ("Vegetables",
 * "Dry Goods") and hands it back verbatim on /inventory and
 * /inventory/categories, so the filter row and every category cell on the page
 * read as English no matter what language the owner picked. This map is the
 * translation layer; the keys are exactly the `category` values shipped in
 * backend/app/routers/inventory.py.
 */
export const CATEGORY_LABEL_KEYS = {
  General: "general",
  Accessories: "invCatAccessories",
  Arrangements: "invCatArrangements",
  Audio: "invCatAudio",
  Bags: "invCatBags",
  Bakery: "invCatBakery",
  Batteries: "invCatBatteries",
  Beer: "invCatBeer",
  Beverages: "invCatBeverages",
  Bottoms: "invCatBottoms",
  Cables: "invCatCables",
  Chargers: "invCatChargers",
  Chemicals: "invCatChemicals",
  Clothing: "invCatClothing",
  Computer: "invCatComputer",
  Construction: "invCatConstruction",
  Dairy: "invCatDairy",
  Devices: "invCatDevices",
  Dresses: "invCatDresses",
  "Dry Goods": "invCatDryGoods",
  Electrical: "invCatElectrical",
  Electronics: "invCatElectronics",
  Fasteners: "invCatFasteners",
  "First Aid": "invCatFirstAid",
  Flowers: "invCatFlowers",
  Footwear: "invCatFootwear",
  Fragrance: "invCatFragrance",
  Fruits: "invCatFruits",
  Garnish: "invCatGarnish",
  Gold: "invCatGold",
  "Hair Care": "invCatHairCare",
  Hardware: "invCatHardware",
  Herbs: "invCatHerbs",
  Home: "invCatHome",
  Household: "invCatHousehold",
  Hygiene: "invCatHygiene",
  Liqueurs: "invCatLiqueurs",
  Makeup: "invCatMakeup",
  Materials: "invCatMaterials",
  Media: "invCatMedia",
  Medicine: "invCatMedicine",
  Misc: "invCatMisc",
  Mixers: "invCatMixers",
  Nail: "invCatNails",
  Nails: "invCatNails",
  Outerwear: "invCatOuterwear",
  Packaged: "invCatPackaged",
  Packaging: "invCatPackaging",
  Paint: "invCatPaint",
  Pantry: "invCatPantry",
  Paper: "invCatPaper",
  Parts: "invCatParts",
  "Personal Care": "invCatPersonalCare",
  Phone: "invCatPhone",
  Plants: "invCatPlants",
  Plumbing: "invCatPlumbing",
  Produce: "invCatProduce",
  Products: "invCatProducts",
  Protein: "invCatProtein",
  Screens: "invCatScreens",
  Services: "invCatServices",
  Silver: "invCatSilver",
  Skin: "invCatSkin",
  Skincare: "invCatSkincare",
  Snacks: "invCatSnacks",
  Spices: "invCatSpices",
  Spirits: "invCatSpirits",
  Supplies: "invCatSupplies",
  Tea: "invCatTea",
  Tobacco: "invCatTobacco",
  Tools: "invCatTools",
  Tops: "invCatTops",
  Traditional: "invCatTraditional",
  Vegetables: "invCatVegetables",
  Vitamins: "invCatVitamins",
  Watches: "invCatWatches",
  Wine: "invCatWine",
  Writing: "invCatWriting",
};

/**
 * Label for a stock category. A category the owner typed themselves is NOT in
 * the map and is returned untouched — showing an owner their own word back is
 * the only honest default, and guessing a translation for it would be worse
 * than leaving it alone.
 */
export function categoryLabel(t, category) {
  const cat = category || "General";
  const key = CATEGORY_LABEL_KEYS[cat];
  return key ? t(key, cat) : cat;
}
