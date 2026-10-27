import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LANGUAGES } from "../i18n/languageCatalog";
import { loadLocale, loadedLocales, localesFor } from "../lib/localeStore";
import { PAGE_WORDS_ON, pageDictFor, pageDictVersion, subscribePageDict } from "../lib/pageDict";
import { isBookingPathNow } from "../lib/bookingPath";
import { browserListsDanish, isReplaceableTitle, shellTitle } from "../lib/shellTitles";
import { landingFirstPaint } from "../lib/landingBoot";
// The landing page's and cookie banner's keys in Danish and English, built
// from i18n/da.js + en.js at build time (vite.config.js, lib/bootKeys.js).
// ~13 KB gz. Lets the logged-out landing paint before the full dictionary
// arrives — see the render gate below and FullDictionaryGate in App.jsx.
import BOOT from "virtual:bonbox-boot-dict";

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
// The shell's tab titles (index.html ships the Danish one) live in
// lib/shellTitles.js with the language rule the shell shares. Re-exported here
// so callers can keep importing them from the language module.
export { shellTitle };

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

function browserCandidates() {
  if (typeof navigator === "undefined") return [];
  return []
    .concat(Array.isArray(navigator.languages) ? navigator.languages : [])
    .concat(navigator.language ? [navigator.language] : []);
}

function detectLanguageFromBrowser() {
  if (typeof navigator === "undefined") return null;
  // navigator.languages is the prioritised list; navigator.language is
  // the primary.
  const candidates = browserCandidates();
  // PQ-05 (push 6): Danish (or Faroese) ANYWHERE in the list wins. An
  // English-first phone in Denmark (["en-US", "da"]) used to get English on
  // the sign-up pages while the dictionary preload fetched Danish as well.
  // Same rule as index.html and the preload (lib/shellTitles.js).
  if (browserListsDanish(candidates)) return "da";
  // Otherwise: try every entry until one maps to a supported lang.
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
    if (stored && SUPPORTED.has(stored)) {
      // One-time move (push 6, PQ-05): a language the BROWSER picked under
      // the old first-entry rule (English on an ["en-US", "da"] phone) moves
      // to Danish once. Only an auto pick: choosing a language in the picker
      // clears bonbox_lang_auto_picked (setLang below), so an owner who chose
      // English keeps English. The stored value becomes "da", so this runs
      // once; SmartLanguageToast then offers "Switch to English".
      if (stored !== "da" && browserListsDanish(browserCandidates())) {
        let auto = null;
        try { auto = localStorage.getItem("bonbox_lang_auto_picked"); } catch { auto = null; }
        if (auto === "browser") return { lang: "da", source: "migrated" };
      }
      return { lang: stored, source: "stored" };
    }
  }
  const fromBrowser = detectLanguageFromBrowser();
  if (fromBrowser) return { lang: fromBrowser, source: "browser" };
  const fromCurrency = detectLanguageFromCurrencyHint();
  if (fromCurrency) return { lang: fromCurrency, source: "currency" };
  return { lang: "en", source: "fallback" };
}


// Booking R5: the public booking page brings its own words (lib/pageDict.js,
// ~10 KB for Danish AND English) — a guest's phone no longer downloads the
// ~200 KB full dictionary at all. Only for the two languages it carries; any
// other language loads as before.
const PAGE_LANGS = new Set(["da", "en"]);
const onBookingPage = (code) => PAGE_WORDS_ON && PAGE_LANGS.has(code) && isBookingPathNow();

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
  const fullFor = (code) => localesFor(code).every((c) => loaded[c]);
  // R5: re-render the moment a page registers its own words.
  useSyncExternalStore(subscribePageDict, pageDictVersion, pageDictVersion);
  // On the booking page every language is ready to show: Danish and English
  // from the page's own words, any other from the page's English while its
  // own dictionary loads in the background (the page offers DA/EN and opens
  // in the venue's language anyway). Before the page's code has arrived
  // nothing on screen says a word — the wait is the page's skeleton — so the
  // page never holds its first paint for a dictionary.
  const pageReady = () => PAGE_WORDS_ON && isBookingPathNow();
  const readyFor = (code) => fullFor(code) || pageReady(code);
  // A key the page's words do not hold: fetch the full dictionary once, so
  // it shows in a moment instead of as a raw key (see the t() below).
  const fullAsked = useRef(false);
  // Leaving the booking page for another route inside the app: App.jsx's
  // FullDictionaryGate asks for the full dictionary through this.
  const [fullWanted, setFullWanted] = useState(0);
  const ensureFull = useCallback(() => setFullWanted((n) => n + 1), []);

  // The language on screen. While a newly picked language downloads, the
  // current one stays up (no blank screen, no raw keys); it switches the
  // moment the new dictionary is in. On first load there is nothing to show
  // yet, so the provider waits — see the render gate below.
  const [shown, setShown] = useState(lang);
  if (readyFor(lang) && shown !== lang) setShown(lang);
  const active = readyFor(lang) ? lang : shown;

  useEffect(() => {
    if (localesFor(lang).every((c) => loaded[c])) return undefined;
    // R5: the booking page has its words; the full dictionary waits for a
    // key outside them (t() below), or for the guest to leave the page
    // (ensureFull, from App.jsx's gate — the address has changed by then).
    if (onBookingPage(lang) && !fullAsked.current) return undefined;
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
  }, [lang, loaded, fullWanted]);

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

    const hit =
      loaded[active]?.[key] || pageDictFor(active)?.[key] || BOOT[active]?.[key] ||
      loaded.en?.[key] || pageDictFor("en")?.[key] || BOOT.en?.[key];
    // R5: the booking page asked for a word its own dictionary does not hold
    // (lib/pageDict.js). Fetch the full one once — the page shows it a moment
    // later rather than a raw key — and say so in development. Only once the
    // page has registered its words: before its code arrives, nothing on the
    // booking route is the page (the wait has no words).
    if (!hit && !fullAsked.current && !loaded[active] && pageDictVersion() > 0 && onBookingPage(active)) {
      fullAsked.current = true;
      if (import.meta.env?.DEV) console.warn(`[i18n] "${key}" is not in the booking page's own words`);
      Promise.all(localesFor(active).map((c) => loadLocale(c)))
        .then(() => setLoaded({ ...loadedLocales() }))
        .catch(() => {});
    }
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
  //
  // Landing v6 (security fix round, 23 Oct 2026): index.html's static title
  // is the landing's headline (lib/shellTitles.js LANDING_TITLES). It counts
  // as a default too, so an app route opened cold (or a signed-in owner sent
  // on from "/") gets the app's title — except while the landing itself holds
  // the tab (pages/LandingV6Page.jsx), which sets its own headline.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = lang;
    const wanted = shellTitle(lang);
    if (isReplaceableTitle(document.title)) document.title = wanted;
  }, [lang]);

  // First paint waits for the visitor's dictionary — the page is still the
  // bare shell at that point, exactly as it was while the old inline
  // dictionary downloaded. A failed download renders anyway.
  //
  // Push 9 (E): Danish and English may render on the BOOT dictionary while
  // the full one downloads. `fullReady` tells the app which it has: App.jsx
  // (FullDictionaryGate) renders only the landing on boot keys and holds
  // every other route back until the full dictionary is in — so no app page
  // ever shows a missing key. Other languages wait as before.
  // `fullReady` is about the FULL dictionary only (a page's own words never
  // count): App.jsx's FullDictionaryGate holds every other route on it.
  const fullReady = fullFor(active) || loadFailed;
  if (!fullReady && !BOOT[active] && !pageReady(active)) return null;

  return (
    <LanguageContext.Provider value={{ lang: active, setLang, toggleLang, t, LANGUAGES, fullReady, ensureFull }}>
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
//
// Except on the landing for a visitor with no session (push 9, E): that page
// paints from BOOT, so the 185 KB dictionary waits until the provider's
// effect asks for it — right after the first paint — instead of competing
// with the fonts the first paint is drawing in.
try {
  const bootable = Boolean(BOOT[detectInitialLanguage().lang]);
  // R5: nor on the booking page (Danish or English) — it brings its own words
  // (lib/pageDict.js); a key outside them still fetches the full one (t()).
  const ownWords = onBookingPage(detectInitialLanguage().lang);
  if (!(bootable && landingFirstPaint())) {
    if (!ownWords) {
      localesFor(detectInitialLanguage().lang).forEach((code) => {
        loadLocale(code).catch(() => { /* the provider retries and falls back */ });
      });
    }
  }
} catch { /* no storage available — the provider loads it on mount */ }
