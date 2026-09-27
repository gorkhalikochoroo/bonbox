import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { LANGUAGES } from "../i18n/languageCatalog";
import { loadLocale, loadedLocales, localesFor } from "../lib/localeStore";

const LanguageContext = createContext(null);

// ─── Dictionaries ─────────────────────────────────────────────────────
//
// Every language, English and Danish included, is its own chunk loaded by
// lib/localeStore.js (the dictionaries themselves are i18n/<code>.js). A
// visitor downloads only the language they use — see localeStore for why and
// for which languages carry an English fallback.
//
// IMPORTANT: never import a dictionary statically here. That puts it back in
// every visitor's first download.

// Priority languages — these are the only ones with full translation
// coverage (~1000+ keys each: every UI string, pricing page, FAQ,
// error states). The 9 European/Asian stub packs (de/fr/es/nl/sv/no/pt/it/ja)
// only had ~400 keys each — half the UI fell back to English in those
// languages, which felt deceptive in the picker. Removed until we have
// full translation coverage for any of them.
//
// The stub translation files (i18n/{de,es,fr,nl,sv,no,pt,it,ja}.js) are
// kept on disk so the import statements still resolve and so we can
// re-enable individual languages by adding them back here once they're
// fully translated.
// `short` is the 2-letter compact code shown in the navbar switcher
// (Task #110+): "EN", "DK", "DE" — country-style codes Danes recognize
// instantly.  `label` is the native-language full name, used inside
// expanded dropdowns + accessibility (aria-label) so screen-reader
// users still hear "Dansk" not "DK".
/**
 * The two titles index.html can ship. The shell is Danish (Denmark is the
 * market and the static HTML is what crawlers read); the English one is
 * swapped in at runtime for an English reader. Kept beside LANGUAGES so the
 * pair cannot drift from index.html unnoticed — if you change the <title>
 * there, change it here.
 */
const SHELL_TITLES = {
  da: "BonBox \u2014 Bagkontoret din virksomhed faktisk k\u00f8rer p\u00e5",
  en: "BonBox \u2014 The back office your business actually runs on",
  // Only languages at full coverage get a localised shell title. A translated
  // tab on a mostly-English page reads as broken, so partial locales keep the
  // English one until they are filled.
  tr: "BonBox \u2014 \u0130\u015fletmenin ger\u00e7ekten \u00fczerinde d\u00f6nd\u00fc\u011f\u00fc arka ofis",
};
const SHELL_TITLE_VALUES = Object.values(SHELL_TITLES);

// The catalog of locales, and which are complete enough to offer, now lives in
// i18n/languageCatalog.js — see the note there for why four locales were taken
// out of the picker. LANGUAGES is imported at the top of this file.

// Auto-detect language from currency. Currencies whose native language
// is in stub-only state (SEK→sv, NOK→no, CHF→de, JPY→ja, BRL→pt, MXN→es)
// fall through to "en" until we have full translation coverage for those
// languages. THB→th and TRY→tr added since both are now fully translated.
const CURRENCY_LANG_MAP = {
  DKK: "da", NPR: "np", EUR: "en", USD: "en", GBP: "en",
  THB: "th", VND: "vi", TRY: "tr",
  SEK: "en", NOK: "en", CHF: "en", JPY: "en",
  INR: "en", BRL: "en", MXN: "en", AUD: "en", CAD: "en",
  NZD: "en", ZAR: "en", PHP: "en",
};

export function getLangForCurrency(currencyCode) {
  return CURRENCY_LANG_MAP[currencyCode] || "en";
}


// ─── Smart Language auto-detect (May 2026) ────────────────────────────
//
// Rule order on first visit (cleanest "we figure it out" UX):
//
//   1. localStorage("lang")           → user picked once before; respect
//   2. navigator.language → mapped     → browser locale matches a supported
//                                         language (en, da, np, vi, th, tr)
//   3. localStorage("bonbox_currency") → currency hint from earlier signup
//                                         flow (DKK→da, NPR→np, etc.)
//   4. "en"                           → safe fallback
//
// We ONLY auto-pick on first visit — once "lang" is in localStorage, we
// trust the user's explicit choice. Auto-picks are flagged via
// `bonbox_lang_auto_picked` so the welcome toast can offer "switch back".
//
// Map browser locale to the supported languages. Falls through to null
// when the locale isn't supported (caller falls to currency hint).
//
// MUST contain every language the picker offers (languageCatalog.js
// `offered: true`), because detectInitialLanguage() gates the STORED choice on
// this set. "de" was offered but missing here, so picking Deutsch did not
// survive a reload — and not merely by being ignored: detectInitialLanguage
// falls through to browser detection and then WRITES that result back, so the
// stored "de" was overwritten with "en". Directly contradicts the promise four
// lines up, that once "lang" is in localStorage we trust the user's choice.
// i18nLanguageCatalog.test.js now fails if the two lists drift apart again.
const SUPPORTED = new Set(["en", "da", "np", "vi", "th", "tr", "de"]);
const BROWSER_LANG_MAP = {
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

function detectLanguageFromBrowser() {
  if (typeof navigator === "undefined") return null;
  // navigator.languages is the prioritised list; navigator.language is
  // the primary. Try every entry until one maps to a supported lang.
  const candidates = []
    .concat(Array.isArray(navigator.languages) ? navigator.languages : [])
    .concat(navigator.language ? [navigator.language] : []);
  for (const raw of candidates) {
    if (!raw) continue;
    const lower = String(raw).toLowerCase();
    if (BROWSER_LANG_MAP[lower]) return BROWSER_LANG_MAP[lower];
    // Fall back to the primary subtag — "da-FO" → "da"
    const primary = lower.split("-")[0];
    if (BROWSER_LANG_MAP[primary]) return BROWSER_LANG_MAP[primary];
  }
  return null;
}

function detectLanguageFromCurrencyHint() {
  if (typeof localStorage === "undefined") return null;
  const ccy = localStorage.getItem("bonbox_currency");
  if (!ccy) return null;
  const mapped = CURRENCY_LANG_MAP[ccy];
  return mapped && SUPPORTED.has(mapped) ? mapped : null;
}

/** Public: resolves the best initial language. Used by LanguageProvider
 *  on first mount AND exported so onboarding/signup flows can pre-warm
 *  the chunk for the detected language before the user lands. */
export function detectInitialLanguage() {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem("lang");
    if (stored && SUPPORTED.has(stored)) return { lang: stored, source: "stored" };
  }
  const fromBrowser = detectLanguageFromBrowser();
  if (fromBrowser) return { lang: fromBrowser, source: "browser" };
  const fromCurrency = detectLanguageFromCurrencyHint();
  if (fromCurrency) return { lang: fromCurrency, source: "currency" };
  return { lang: "en", source: "fallback" };
}


export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    const detected = detectInitialLanguage();
    // First-visit auto-pick: persist the result so future loads skip
    // detection AND mark it as auto-picked so the welcome toast can
    // offer "switch back to English". User-explicit picks (via the
    // language selector) clear the auto-pick flag.
    if (detected.source !== "stored" && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem("lang", detected.lang);
        if (detected.source === "browser" || detected.source === "currency") {
          localStorage.setItem("bonbox_lang_auto_picked", detected.source);
        }
      } catch { /* private mode etc — silent */ }
    }
    return detected.lang;
  });
  // Dictionaries loaded so far, as state so a finished download re-renders.
  const [loaded, setLoaded] = useState(() => ({ ...loadedLocales() }));
  const [loadFailed, setLoadFailed] = useState(false);
  const readyFor = (code) => localesFor(code).every((c) => loaded[c]);

  // The language on screen. While a newly picked language downloads, the
  // current one stays up (no blank screen, no raw keys); it switches the
  // moment the new dictionary is in. On first load there is nothing to show
  // yet, so the provider waits — see the render gate below.
  const [shown, setShown] = useState(lang);
  if (readyFor(lang) && shown !== lang) setShown(lang);
  const active = readyFor(lang) ? lang : shown;

  useEffect(() => {
    if (localesFor(lang).every((c) => loaded[c])) return undefined;
    let live = true;
    Promise.all(localesFor(lang).map(loadLocale))
      .then(() => {
        if (live) setLoaded({ ...loadedLocales() });
      })
      .catch((e) => {
        // Offline, or a chunk 404 right after a deploy. Never leave the app
        // blank over it: try English, and render regardless.
        console.warn(`useLanguage: failed to load "${lang}":`, e);
        loadLocale("en")
          .catch(() => null)
          .finally(() => {
            if (!live) return;
            setLoaded({ ...loadedLocales() });
            setLoadFailed(true);
          });
      });
    return () => {
      live = false;
    };
  }, [lang, loaded]);

  const setLang = useCallback((code) => {
    setLangState(code);
    try {
      localStorage.setItem("lang", code);
      // User explicitly picked → not auto-anymore. Clear the flag so
      // the welcome-toast suppression logic doesn't keep nagging.
      localStorage.removeItem("bonbox_lang_auto_picked");
    } catch { /* private mode — silent */ }
    // The dictionary loads in the effect above; the current language stays
    // on screen until it is in.
  }, []);

  // Keep toggleLang for backward compat — cycles through all languages
  const toggleLang = () => {
    const codes = LANGUAGES.map((l) => l.code);
    const idx = codes.indexOf(lang);
    const next = codes[(idx + 1) % codes.length];
    setLang(next);
  };

  // Lookup: the language on screen, then English (loaded alongside every
  // partial pack), then the call's own fallback, then the key.
  //
  // Argument shapes (all mix-and-match safe, fully backwards compatible):
  //   • t("key")                          → resolved string, or raw key if missing
  //   • t("key", "fallback text")         → resolved, or fallback if missing
  //   • t("key", { var: "val" })          → resolved with {var} substituted; if
  //                                         missing, returns key (with subs applied
  //                                         if the key string itself has {placeholders})
  //   • t("key", "fallback", { var: "v" })→ resolved or fallback, THEN {var} subs.
  //                                         This is the natural pattern when the
  //                                         fallback is a real human-readable template
  //                                         like "Cash-up logged · {gross}" — both
  //                                         the resolved key AND the fallback share
  //                                         the same placeholder shape.
  //
  // Why each form exists:
  //   2-arg string fallback — original behavior since 2026-05-16, callers used to
  //   guard with `|| "…"` but that's broken when t() returns a truthy key string.
  //   2-arg vars object — added 2026-05-24 after Dashboard showed "Revenue
  //   ({currency})" literally. The second arg was ignored when the key existed.
  //   3-arg form — added later same day after EventsPage cash-up toast showed
  //   "Cash-up logged · {gross}" literally. Agent had naturally written the
  //   key+fallback+vars triple pattern (because the fallback string is a real
  //   user-visible template, not a debug placeholder) and a 2-arg-only t()
  //   silently dropped the vars object.
  const t = useCallback((key, fallbackOrVars, maybeVars) => {
    // Disambiguate the second arg: string = fallback, object = vars
    const secondIsVarsObject =
      fallbackOrVars !== null &&
      typeof fallbackOrVars === "object" &&
      !Array.isArray(fallbackOrVars);
    const fallback = secondIsVarsObject ? undefined : fallbackOrVars;
    const varsFromSecond = secondIsVarsObject ? fallbackOrVars : null;
    // Third arg, if present, is always a vars object (overrides second-as-vars)
    const thirdIsVarsObject =
      maybeVars !== null &&
      maybeVars !== undefined &&
      typeof maybeVars === "object" &&
      !Array.isArray(maybeVars);
    const vars = thirdIsVarsObject ? maybeVars : varsFromSecond;

    const hit = loaded[active]?.[key] || loaded.en?.[key];
    let result;
    if (hit) {
      result = hit;
    } else {
      result = fallback !== undefined ? fallback : key;
    }

    // Substitute {var} placeholders if a vars object was supplied. Missing
    // keys in `vars` leave the placeholder text untouched — better than
    // silently rendering "undefined" in the UI. Only acts on strings; if
    // a translation entry is e.g. a JSX node, it passes through unchanged.
    if (vars && typeof result === "string" && result.indexOf("{") !== -1) {
      result = result.replace(/\{(\w+)\}/g, (match, name) =>
        vars[name] !== undefined ? String(vars[name]) : match,
      );
    }
    return result;
  }, [loaded, active]);

  // Keep <html lang> and the tab title in step with the chosen language.
  //
  // index.html now ships lang="da" and a Danish <title>, because Denmark is
  // the market and the STATIC shell is what Google indexes — a crawler never
  // waits for React. The consequence is that an English-reading visitor would
  // otherwise sit on a Danish tab title, so it is swapped here once the app
  // knows the language.
  //
  // The guard matters: ReservationPublicPage and StaffPortalPage set their own
  // document.title ("Book bord · <venue>"). Only replace the title when it is
  // still one of the two shell defaults, so a page that has named itself is
  // never stomped by a language change.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang;
    const wanted = SHELL_TITLES[lang] || SHELL_TITLES.en;
    if (SHELL_TITLE_VALUES.includes(document.title)) document.title = wanted;
  }, [lang]);

  // First paint waits for the visitor's dictionary — the page is still the
  // bare shell at that point, exactly as it was while the old inline
  // dictionary downloaded. A failed download renders anyway.
  if (!readyFor(active) && !loadFailed) return null;

  return (
    <LanguageContext.Provider value={{ lang: active, setLang, toggleLang, t, LANGUAGES }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}

// Start downloading the visitor's dictionary as soon as this module loads —
// in parallel with the rest of the app booting, not after its first render.
// Placed last on purpose: detectInitialLanguage reads constants defined above.
try {
  localesFor(detectInitialLanguage().lang).forEach((code) => {
    loadLocale(code).catch(() => { /* the provider retries and falls back */ });
  });
} catch { /* no storage available — the provider loads it on mount */ }
