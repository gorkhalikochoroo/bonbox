/**
 * localeStore — every language dictionary, loaded on demand and cached.
 *
 * WHY. English and Danish used to sit inline in hooks/useLanguage.jsx, so
 * every visitor — the landing page included — downloaded both: ~850 KB raw,
 * 286 KB over the wire, the largest single thing on a first visit (57% of
 * the landing page's JavaScript). A Danish owner never needs the English
 * dictionary: Danish is complete (the parity guards hold every key to both).
 * Now each language is its own chunk and a visitor loads the one they use.
 *
 * WHICH DICTIONARIES A LANGUAGE NEEDS
 *   en, da          complete — load alone.
 *   tr, th, vi, …   partial packs — load with English, the fallback for any
 *                   key the pack does not have yet.
 *
 * Loading starts when hooks/useLanguage.jsx is first imported (in parallel
 * with the rest of the app booting), and the provider holds the first render
 * until the visitor's dictionary is in — the same wait there always was for
 * the inline one, with half the bytes behind it. Tests prime en + da
 * synchronously (src/test/setup.js), so a render in a test never waits.
 *
 * Note on 'no': i18n/no.js exports `no_` (a name collision in an older
 * static-import setup); the loader keeps that convention.
 */
const LOADERS = {
  en: async () => (await import("../i18n/en.js")).en,
  da: async () => (await import("../i18n/da.js")).da,
  de: async () => (await import("../i18n/de.js")).de,
  fr: async () => (await import("../i18n/fr.js")).fr,
  es: async () => (await import("../i18n/es.js")).es,
  nl: async () => (await import("../i18n/nl.js")).nl,
  sv: async () => (await import("../i18n/sv.js")).sv,
  no: async () => (await import("../i18n/no.js")).no_,
  pt: async () => (await import("../i18n/pt.js")).pt,
  it: async () => (await import("../i18n/it.js")).it,
  ja: async () => (await import("../i18n/ja.js")).ja,
  vi: async () => (await import("../i18n/vi.js")).vi,
  th: async () => (await import("../i18n/th.js")).th,
  tr: async () => (await import("../i18n/tr.js")).tr,
  // Hidden in the picker (product decision) but still supported for owners
  // already using it.
  np: async () => (await import("../i18n/np.js")).np,
};

/** Languages whose dictionary covers every key — no English fallback needed. */
const COMPLETE = new Set(["en", "da"]);

const cache = {};
const inflight = {};

/** The dictionaries `code` needs, in lookup order. */
export function localesFor(code) {
  const c = LOADERS[code] ? code : "en";
  return COMPLETE.has(c) ? [c] : [c, "en"];
}

/** Everything loaded so far, keyed by language code. */
export function loadedLocales() {
  return cache;
}

export function hasLocale(code) {
  return Boolean(LOADERS[code]);
}

/** Load one dictionary (cached; concurrent calls share one request). */
export function loadLocale(code) {
  if (cache[code]) return Promise.resolve(cache[code]);
  if (!LOADERS[code]) return Promise.resolve(null);
  if (!inflight[code]) {
    inflight[code] = LOADERS[code]()
      .then((dict) => {
        cache[code] = dict;
        return dict;
      })
      .finally(() => {
        delete inflight[code];
      });
  }
  return inflight[code];
}

/** Put dictionaries in the cache directly — tests, and any caller that
 *  already holds them. */
export function primeLocales(dicts) {
  Object.assign(cache, dicts);
}
