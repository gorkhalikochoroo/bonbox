/**
 * "Rute" — the one moment anything about the venue leaves BonBox.
 *
 * Only ever built for an explicit tap on the staff app's Rute button or the
 * shift menu row. It carries the venue's position (when the owner confirmed
 * the pin) or its address, and its name — never anything about the staffer.
 *
 *   apple  — iPhone / iPad (native shell or Safari): Apple Maps, directions.
 *   geo    — Android (native shell or browser): the phone's own map choice.
 *   google — anything else: the Google Maps search URL the app used before.
 */
import { platform } from "./platform";

export function routePlatform(ua) {
  if (platform.isIOS) return "apple";
  if (platform.isAndroid) return "geo";
  const agent = ua ?? (typeof navigator !== "undefined" ? navigator.userAgent || "" : "");
  if (/iPhone|iPad|iPod/i.test(agent)) return "apple";
  // iPadOS Safari reports itself as a Mac; a touch screen gives it away.
  if (/Macintosh/i.test(agent) && typeof document !== "undefined" && "ontouchend" in document) return "apple";
  if (/Android/i.test(agent)) return "geo";
  return "google";
}

const hasPoint = (lat, lng) =>
  Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== null && lng !== null;

/**
 * routeUrl({ lat, lng, name, address, street, town }, kind) → a URL, or null
 * when there is nothing to route to. A confirmed pin wins over the address
 * text: it is the point the owner checked, where an address can resolve to a
 * street centroid.
 *
 * `street` (optional) says whether the address has a street in it. When it is
 * given and blank, the address names a town at most ("2200 København N"), and
 * routing to it lands in the town centre — so the search is the place's name
 * in that town ("Café Solsikke, 2200 København N"), with `town` standing in
 * when there is no address at all. Left out, the address is used as it is.
 */
export function routeUrl({ lat, lng, name, address, street, town } = {}, kind = routePlatform()) {
  const point = hasPoint(lat, lng) ? `${Number(lat)},${Number(lng)}` : null;
  const label = (name || "").trim();
  const addr = (address || "").trim();
  const noStreet = street !== undefined && !String(street || "").trim();
  const text = noStreet
    ? [label, addr || String(town || "").trim()].filter(Boolean).join(", ")
    : addr || label;
  if (!point && !text) return null;
  if (kind === "apple") {
    return point
      ? `https://maps.apple.com/?daddr=${point}${label ? `&q=${encodeURIComponent(label)}` : ""}`
      : `https://maps.apple.com/?daddr=${encodeURIComponent(text)}`;
  }
  if (kind === "geo") {
    return point
      ? `geo:0,0?q=${point}${label ? `(${encodeURIComponent(label)})` : ""}`
      : `geo:0,0?q=${encodeURIComponent(text)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${point || encodeURIComponent(text)}`;
}
