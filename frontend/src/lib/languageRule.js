/**
 * The first-visit language rule, in ONE place (landing speed, 10 Nov 2026).
 *
 * Two readers run exactly this code:
 *   - hooks/useLanguage.jsx detectInitialLanguage(): the app's language on
 *     every start;
 *   - the landing's head script (vite.config.js preloadLanding): at parse
 *     time, before any app code has arrived, it decides which language the
 *     first screen the HTML draws is in (landing speed, step 2). It carries
 *     pickInitialLanguage's own source text (Function.prototype.toString) and
 *     these maps as JSON, so the two can never drift apart.
 * Hence plain JS, no imports, and ES5 inside pickInitialLanguage (it runs in
 * the page as written, before any build step could rewrite it).
 *
 * Rule order:
 *   1. the stored choice (localStorage "lang"), when it is a supported
 *      language — except the one-time move (push 6, PQ-05): a language the
 *      BROWSER picked under the old rule ("bonbox_lang_auto_picked" ===
 *      "browser") becomes Danish when the browser lists Danish;
 *   2. Danish or Faroese ANYWHERE in the browser's list → Danish (the same
 *      test as lib/shellTitles.js DANISH_TAG);
 *   3. the first browser language that maps to a supported one;
 *   4. the currency hint from an earlier sign-up (localStorage
 *      "bonbox_currency");
 *   5. English.
 * It only reads storage, never writes.
 *
 * SUPPORTED_LANGS MUST contain every language the picker offers
 * (languageCatalog.js `offered: true`): the stored choice is gated on it
 * (i18nLanguageCatalog.test.js).
 */
export const SUPPORTED_LANGS = ["en", "da", "np", "vi", "th", "tr", "de"];

export const BROWSER_LANG_MAP = {
  // Danish & Faroese (Faroese owners often run DK ops)
  "da": "da", "da-dk": "da", "fo": "da",
  // English defaults
  "en": "en", "en-us": "en", "en-gb": "en", "en-ie": "en", "en-au": "en", "en-nz": "en",
  // Nepali
  "ne": "np", "ne-np": "np", "np": "np",
  // Vietnamese
  "vi": "vi", "vi-vn": "vi",
  // Thai
  "th": "th", "th-th": "th",
  // Turkish
  "tr": "tr", "tr-tr": "tr",
};

// Currencies whose native language is in stub-only state (SEK→sv, NOK→no,
// CHF→de, JPY→ja, BRL→pt, MXN→es) fall through to "en" until we have full
// translation coverage for those languages. THB→th and TRY→tr added since
// both are now fully translated.
export const CURRENCY_LANG_MAP = {
  DKK: "da", NPR: "np", EUR: "en", USD: "en", GBP: "en",
  THB: "th", VND: "vi", TRY: "tr",
  SEK: "en", NOK: "en", CHF: "en", JPY: "en",
  INR: "en", BRL: "en", MXN: "en", AUD: "en", CAD: "en",
  NZD: "en", ZAR: "en", PHP: "en",
};

export const LANG_RULE = { supported: SUPPORTED_LANGS, browser: BROWSER_LANG_MAP, currency: CURRENCY_LANG_MAP };

/**
 * read(key): the stored value or null (the app passes localStorage.getItem, so
 * blocked storage throws exactly as before; the head script passes a reader
 * that never throws). list: the browser's languages in order
 * (navigator.languages, then navigator.language). M: LANG_RULE.
 * Returns { lang, source } with source stored | migrated | browser | currency | fallback.
 */
export function pickInitialLanguage(read, list, M) {
  var i, raw, lower, primary, danish = false;
  for (i = 0; i < list.length; i++) {
    if (/^(da|fo)(-|$)/i.test(String(list[i] || ""))) { danish = true; break; }
  }
  var stored = read("lang");
  if (stored && M.supported.indexOf(stored) >= 0) {
    if (stored !== "da" && danish) {
      var auto = null;
      try { auto = read("bonbox_lang_auto_picked"); } catch (e) { auto = null; }
      if (auto === "browser") return { lang: "da", source: "migrated" };
    }
    return { lang: stored, source: "stored" };
  }
  if (danish) return { lang: "da", source: "browser" };
  for (i = 0; i < list.length; i++) {
    raw = list[i];
    if (!raw) continue;
    lower = String(raw).toLowerCase();
    if (M.browser[lower]) return { lang: M.browser[lower], source: "browser" };
    primary = lower.split("-")[0];
    if (M.browser[primary]) return { lang: M.browser[primary], source: "browser" };
  }
  var ccy = read("bonbox_currency");
  if (ccy) {
    var mapped = M.currency[ccy];
    if (mapped && M.supported.indexOf(mapped) >= 0) return { lang: mapped, source: "currency" };
  }
  return { lang: "en", source: "fallback" };
}
