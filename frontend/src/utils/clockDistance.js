/**
 * How far the staffer is from the venue, for the clock-in "too far" hint
 * ("About 1.2 km from Café Solsikke" / "Cirka 1,2 km fra Café Solsikke").
 *
 * GPS jitters, so the figure is rounded: whole metres under 1 km, km with one
 * decimal above. The decimal mark follows the app language, not the phone
 * (utils/hours.js: a point in English, a comma in Danish). It used to be
 * da-DK always ("About ~1,2 km" on an English screen) and carried its own
 * "~" inside a sentence that already says "About" / "Cirka".
 */
const LOCALE = { da: "da-DK", en: "en-GB" };

export function formatClockDistance(m, lang = "en") {
  if (m == null || !Number.isFinite(Number(m))) return "";
  const n = Number(m);
  return n < 1000
    ? `${Math.round(n)} m`
    : `${(n / 1000).toLocaleString(LOCALE[lang] || lang || undefined, { maximumFractionDigits: 1 })} km`;
}
