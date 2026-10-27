// A page's own words, for a page that should not wait for a whole language
// (booking R5).
//
// The Danish dictionary is ~200 KB over the wire; the public booking page uses
// ~400 of its 10.000 keys. A guest on a slow phone used to download (and
// parse) all of it before the page could say anything. The booking page now
// brings its own: virtual:bonbox-booking-dict (vite.config.js, built from
// i18n/da.js + en.js — they stay the one place a string is written) holds
// exactly the keys the page and everything it imports can show, in Danish and
// English, ~10 KB. lib/bookingDict.js registers it here the moment the page's
// code is evaluated — before its first render — and hooks/useLanguage.jsx
// looks here after the full dictionary and before the landing's boot keys.
//
// A registered dictionary never claims to be the whole language: `fullReady`
// stays about the full one, so App.jsx still holds every other route until
// that is in.
const dicts = {};
const subs = new Set();
let version = 0;

/** Add `{ da: {...}, en: {...} }` (merged into anything already here). */
export function registerPageDict(byLang) {
  for (const [code, words] of Object.entries(byLang || {})) {
    if (words && typeof words === "object") dicts[code] = { ...(dicts[code] || {}), ...words };
  }
  version += 1;
  for (const f of [...subs]) {
    try {
      f();
    } catch {
      /* a listener never breaks the registration */
    }
  }
}

/** The registered words for a language, or undefined. */
export function pageDictFor(code) {
  return dicts[code];
}

export function hasPageDict(code) {
  return Boolean(dicts[code]);
}

/** For useSyncExternalStore: re-render when a page registers its words. */
export function subscribePageDict(onChange) {
  subs.add(onChange);
  return () => subs.delete(onChange);
}

export function pageDictVersion() {
  return version;
}
