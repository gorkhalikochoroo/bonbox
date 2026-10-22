/**
 * The "boot" dictionary — the few hundred keys the logged-out landing page
 * and the cookie banner need, bundled with the app so the landing paints
 * without waiting for a whole language (push 9, E).
 *
 * WHY. The Danish dictionary is ~550 KB raw / ~185 KB over the wire, and the
 * language provider held the FIRST paint of every page until it had arrived
 * — including the landing, which uses ~300 of its 10.000 keys. On a "Fast
 * 3G" phone that was the largest single wait before the hero appeared.
 *
 * HOW. vite.config.js (bonbox-boot-dictionary) builds a virtual module from
 * src/i18n/da.js and en.js at build time, keeping only the keys isBootKey()
 * accepts. da.js and en.js stay the one place a string is written — the boot
 * copy is generated from them, so the i18n lints and parity guards are
 * unchanged. hooks/useLanguage.jsx renders with it until the full dictionary
 * is in; App.jsx lets ONLY the landing render on it (every other route waits
 * for the full dictionary, exactly as before).
 *
 * A test (landingPush9Speed) fails if a landing or cookie-banner component
 * uses a key this list does not cover — a key outside it would show its
 * English fallback for a moment before the Danish text arrived.
 */
//
// Landing v6 (port step 7, PORT_PLAN 1.9 / 2.4): the front door is the v6 page, whose every key is landingV6.*.
// "landingV2" and "landingPlan" (the old landing and its floor plan, no longer routed) left the list, so the boot
// copy in the entry holds only what the first paint can show.
export const BOOT_PREFIXES = ["landingV6", "cookie"];

/** Single keys outside those prefixes that the banner or landing reads. */
export const BOOT_KEYS = ["suCookieMore", "close"];

export function isBootKey(key) {
  return BOOT_KEYS.includes(key) || BOOT_PREFIXES.some((p) => key.startsWith(p));
}
