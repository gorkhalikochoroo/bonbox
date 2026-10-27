// The door screen's dictionaries (R11, rubric B11) — what lib/localeStore.js
// is, in the door screen's own build only (scripts/standBuild.mjs swaps it in).
//
// The door screen speaks from its own words (stand/standLanguage.jsx). A full
// dictionary is needed only for a language without its own words, or as the
// safety net for a word its words do not hold. The app's build already ships
// every dictionary; building them again here would put a second ~3 MB copy
// in dist/ (and in the native app, which bundles dist/). So this loads THE
// APP'S OWN dictionary files: the app's build lists them
// (.bonbox-app-dicts.json, scripts/standBuild.mjs appDictionaries), and the
// door screen's build bakes that list in (virtual:bonbox-app-dicts) — the
// same deployment, the same file the owner app may have cached already.
// Same API as lib/localeStore.js.
import APP_DICTS from "virtual:bonbox-app-dicts";

/** Languages whose dictionary covers every key — no English fallback needed. */
const COMPLETE = new Set(["en", "da"]);

const cache = {};
const inflight = {};

/** The dictionaries `code` needs, in lookup order. */
export function localesFor(code) {
  const c = APP_DICTS[code] ? code : "en";
  return COMPLETE.has(c) ? [c] : [c, "en"];
}

/** Everything loaded so far, keyed by language code. */
export function loadedLocales() {
  return cache;
}

export function hasLocale(code) {
  return Boolean(APP_DICTS[code]);
}

/** Load one dictionary (cached; concurrent calls share one request). */
export function loadLocale(code) {
  if (cache[code]) return Promise.resolve(cache[code]);
  const url = APP_DICTS[code];
  if (!url) return Promise.resolve(null);
  if (!inflight[code]) {
    inflight[code] = import(/* @vite-ignore */ url)
      .then((m) => {
        // i18n/no.js exports `no_` (see lib/localeStore.js).
        const dict = m[code === "no" ? "no_" : code] || null;
        if (dict) cache[code] = dict;
        return dict;
      })
      .finally(() => {
        delete inflight[code];
      });
  }
  return inflight[code];
}

/** Put dictionaries in the cache directly (tests). */
export function primeLocales(dicts) {
  Object.assign(cache, dicts);
}
