/**
 * The unit an owner reads, from the code an item stores.
 *
 * Items keep their unit as a code ("pieces", "liters", "boxes"); rendering it
 * raw put English "pieces" in a Danish stock list, count and waste log. Demo
 * items only looked fine because the seed happened to store "stk".
 */
const UNIT_KEYS = {
  pieces: ["unitShortPieces", "pcs"],
  piece: ["unitShortPieces", "pcs"],
  pcs: ["unitShortPieces", "pcs"],
  stk: ["unitShortPieces", "pcs"],
  kg: ["unitShortKg", "kg"],
  g: ["unitShortG", "g"],
  grams: ["unitShortG", "g"],
  liters: ["unitShortL", "l"],
  litres: ["unitShortL", "l"],
  liter: ["unitShortL", "l"],
  l: ["unitShortL", "l"],
  ml: ["unitShortMl", "ml"],
  cl: ["unitShortCl", "cl"],
  boxes: ["unitShortBoxes", "boxes"],
  box: ["unitShortBoxes", "boxes"],
  bottles: ["unitShortBottles", "bottles"],
  bottle: ["unitShortBottles", "bottles"],
  bags: ["unitShortBags", "bags"],
  cans: ["unitShortCans", "cans"],
  packs: ["unitShortPacks", "packs"],
};

export function unitLabel(t, unit) {
  if (!unit) return "";
  const k = UNIT_KEYS[String(unit).trim().toLowerCase()];
  return k ? t(k[0], k[1]) : unit;
}
