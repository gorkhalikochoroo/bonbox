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
 * asker replaces — and frees — the older one.
 */

export const MAP_H = 96;
const W_MIN = 256;
const W_MAX = 448;
const W_STEP = 16;
// The card's side padding plus the page's: min(viewport, 512) - 68 is the
// map's width on the staff app (max-w-lg page, 16 px gutters, 18 px card).
const PAGE_MAX = 512;
const CHROME = 68;

export function mapRequestWidth(measured) {
  let w = Number(measured) || 0;
  if (w <= 0) {
    const vw = typeof window !== "undefined" ? Number(window.innerWidth) || 390 : 390;
    w = Math.min(vw, PAGE_MAX) - CHROME;
  }
  return Math.min(W_MAX, Math.max(W_MIN, Math.ceil(w / W_STEP) * W_STEP));
}

export function mapDpr() {
  return typeof window !== "undefined" && window.devicePixelRatio >= 2.5 ? 3 : 2;
}

export function mapQuery(w, dpr, v) {
  return `w=${w}&h=${MAP_H}&dpr=${dpr}${v ? `&v=${encodeURIComponent(v)}` : ""}`;
}

// key -> { url } (an image in hand) | { none: true } (204 / would not decode)
const cache = new Map();

export function mapCacheKey(scope, w, dpr, v) {
  return `${scope}\u0001${w}\u0001${dpr}\u0001${v || ""}`;
}

export function getCachedMap(key) {
  return cache.get(key);
}

export function setCachedMap(key, entry) {
  const scope = key.slice(0, key.indexOf("\u0001"));
  for (const [k, e] of cache) {
    if (k !== key && k.startsWith(`${scope}\u0001`)) {
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
