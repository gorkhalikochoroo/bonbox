/**
 * The venue map image (Vagtplan R2) — shared by the staff card
 * (StaffPortalPage VenueMapImage) and the owner's pin check (VenuePinCheck).
 *
 * SIZE. The server draws the map for the width the card actually shows, so
 * the "© OpenStreetMap" credit in its bottom-right corner is never cropped.
 * The width is asked for rounded UP to a 16 px step (256-448, the server's
 * grid — backend services/venue_map.py clamp_size), and the card shows the
 * image with object-position right: the few extra pixels are cut from the
 * LEFT, never from the credit's corner. Height is the card's 96 px.
 *
 * VERSION. `v` is the pin's version from the server (PortalInfo.venue.map_v,
 * /staff/venue-location map_v). A moved pin is a new URL, so a phone's HTTP
 * cache can never hand back the old place's image for it.
 *
 * MEMORY. Each image is fetched once per page session and kept as an object
 * URL here, keyed by who asks + size + version, so a tab switch that remounts
 * the card paints the map in the same frame instead of fetching it again (and
 * growing the card under the staffer's thumb). A newer version for the same
 * asker replaces — and frees — the older one. Other SIZES of the same version
 * stay: a card that asked for two widths must not have one answer evict the
 * other (that left an empty pine box on every other remount).
 */

export const MAP_H = 96;
const W_MIN = 256;
const W_MAX = 448;
const W_STEP = 16;
// FIRST GUESS, before the block has measured itself: the map's width on a
// touch phone. The staff page is max-w-lg (512 px) with px-3 gutters (12 px)
// at 360 px and below and px-4 (16 px) above (StaffPortalPage portal-content),
// and the card pads 18 px each side: min(viewport, 512) - 68, or - 60 at
// 360 px and below. It is only a guess: VenueMapImage measures the block as it
// mounts and sends a request only for the MEASURED width, so a screen whose
// real width differs still asks once. (The Android 14 emulator reports
// pointer: fine, so index.css gives the shell an 8 px scrollbar there and the
// block is 76 px narrower than the viewport; touch phones show no scrollbar.)
const PAGE_MAX = 512;
export function mapChrome(vw) {
  return vw <= 360 ? 60 : 68;
}

export function mapRequestWidth(measured) {
  let w = Number(measured) || 0;
  if (w <= 0) {
    const vw = typeof window !== "undefined" ? Number(window.innerWidth) || 390 : 390;
    w = Math.min(vw, PAGE_MAX) - mapChrome(vw);
  }
  return Math.min(W_MAX, Math.max(W_MIN, Math.ceil(w / W_STEP) * W_STEP));
}

export function mapDpr() {
  return typeof window !== "undefined" && window.devicePixelRatio >= 2.5 ? 3 : 2;
}

// STYLE. "pine" is the staff card's dark pine map (canvas "Pine, ivory &
// brass": pine ground, brass pin); "paper" — the default, sent as no param —
// is the owner's pin check. The server allow-lists it and keys its cache on it.
export const MAP_PINE_BG = "#123F31";

export function mapQuery(w, dpr, v, style) {
  return `w=${w}&h=${MAP_H}&dpr=${dpr}${v ? `&v=${encodeURIComponent(v)}` : ""}${
    style === "pine" ? "&style=pine" : ""}`;
}

// key -> { url } (an image in hand) | { none: true } (204 / would not decode)
const cache = new Map();

export function mapCacheKey(scope, w, dpr, v, style) {
  return `${scope}\u0001${w}\u0001${dpr}\u0001${v || ""}\u0001${style === "pine" ? "pine" : "paper"}`;
}

export function getCachedMap(key) {
  return cache.get(key);
}

// The key's parts: [scope, w, dpr, v, style].
const keyParts = (key) => String(key).split("\u0001");

export function setCachedMap(key, entry) {
  const [scope, , , v] = keyParts(key);
  for (const [k, e] of cache) {
    if (k === key) continue;
    const [kScope, , , kV] = keyParts(k);
    // Only ANOTHER version of the same asker's map goes (a moved pin); its
    // other sizes stay.
    if (kScope === scope && kV !== v) {
      if (e?.url) URL.revokeObjectURL?.(e.url);
      cache.delete(k);
    }
  }
  const old = cache.get(key);
  if (old?.url && old.url !== entry?.url) URL.revokeObjectURL?.(old.url);
  cache.set(key, entry);
}

// key -> the request in flight, so a remount (or React's dev double effect)
// while it is on its way waits for it instead of asking a second time.
const inflight = new Map();

/** The entry for `key`, fetching it (once) with `request()` when needed. A
 *  failed request is not kept: the next mount may try again. */
export function loadMapOnce(key, request) {
  const have = cache.get(key);
  if (have) return Promise.resolve(have);
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve()
    .then(request)
    .then((r) => {
      const entry = entryFromResponse(r);
      setCachedMap(key, entry);
      return entry;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Tests only: forget every image (each test starts with an empty page). */
export function clearVenueMapCache() {
  for (const e of cache.values()) if (e?.url) URL.revokeObjectURL?.(e.url);
  cache.clear();
  inflight.clear();
}

/** A blob answer → a cache entry. Anything but a real image is "no map". */
export function entryFromResponse(r) {
  const blob = r?.data;
  if (r?.status === 204 || !blob || !blob.size || !String(blob.type || "").startsWith("image/")) return { none: true };
  return { url: URL.createObjectURL(blob) };
}
