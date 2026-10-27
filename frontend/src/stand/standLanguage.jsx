/**
 * The door screen's language (R11, rubric B11) — what hooks/useLanguage.jsx
 * is, in the door screen's own build only (scripts/standBuild.mjs swaps it in;
 * the owner app keeps hooks/useLanguage.jsx untouched).
 *
 * The app's provider loads a whole language — ~194 KB gzip for Danish — and
 * starts that download the moment its module is imported. A door iPad reads
 * ~1,100 of those ~10,900 keys. Here it gets exactly the words the door
 * screen's code can show (virtual:bonbox-stand-words/<lang>, built from
 * i18n/da.js and en.js, which stay the one place a string is written), one
 * language at a time, preloaded by stand.html with the code.
 *
 * Same contract as the app's provider: t(key, fallback?, vars?) with the
 * same lookup order (the language, then English when the language carries an
 * English fallback, then the call's own fallback) and the same {name}
 * filling; lang / setLang / toggleLang / LANGUAGES / fullReady.
 *
 * SAFETY NET. A key the door screen's words do not hold (the build makes that
 * a build error, so this is belt and braces) fetches the full dictionary for
 * that language once and shows the word a moment later — never a raw key.
 * Languages other than Danish and English (Turkish is offered) load their
 * full dictionary as the app does.
 */
/* eslint-disable react-refresh/only-export-components -- a stand-in must have the same exports as the module it replaces (scripts/standBuild.mjs STAND_SWAPS), hooks and provider together, as hooks/useLanguage.jsx and hooks/useAuth.jsx do. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LANGUAGES } from "../i18n/languageCatalog";
import { loadLocale, localesFor } from "../lib/localeStore";
import { browserListsDanish, isReplaceableTitle, shellTitle } from "../lib/shellTitles";

export { shellTitle };

const LanguageContext = createContext(null);

// Every code a stored choice may hold (the app's SUPPORTED); the picker offers
// fewer, and a code outside both reads as English, as in the app.
const SUPPORTED = new Set(["en", "da", "np", "vi", "th", "tr", "de"]);
const OWN_WORDS = {
  da: () => import("virtual:bonbox-stand-words/da"),
  en: () => import("virtual:bonbox-stand-words/en"),
};
const PRIMARY = { da: "da", fo: "da", en: "en", ne: "np", np: "np", vi: "vi", th: "th", tr: "tr", de: "de" };

export function getLangForCurrency(code) {
  return code === "DKK" ? "da" : code === "NPR" ? "np" : code === "THB" ? "th" : code === "VND" ? "vi" : code === "TRY" ? "tr" : "en";
}

/** The device's language: the stored choice, else the browser's (Danish
 *  anywhere in the list wins, as in the app), else English. */
export function detectInitialLanguage() {
  try {
    const stored = localStorage.getItem("lang");
    if (stored && SUPPORTED.has(stored)) return { lang: stored, source: "stored" };
  } catch {
    /* no storage: the browser decides */
  }
  try {
    const list = []
      .concat(Array.isArray(navigator.languages) ? navigator.languages : [])
      .concat(navigator.language ? [navigator.language] : []);
    if (browserListsDanish(list)) return { lang: "da", source: "browser" };
    for (const raw of list) {
      const code = PRIMARY[String(raw || "").toLowerCase().split("-")[0]];
      if (code) return { lang: code, source: "browser" };
    }
  } catch {
    /* no navigator */
  }
  return { lang: "en", source: "fallback" };
}

// What has arrived, by code: the door screen's own words, and any full
// dictionary the safety net (or another language) had to fetch.
const own = {};
const full = {};

function wordsFor(code) {
  if (OWN_WORDS[code]) {
    return own[code] ? Promise.resolve(own[code]) : OWN_WORDS[code]().then((m) => (own[code] = m.default || {}));
  }
  return loadLocale(code).then((d) => (full[code] = d || {}));
}

/** The codes a language needs on screen (a partial pack rides on English). */
const needs = (code) => (OWN_WORDS[code] ? [code] : localesFor(code));
const ready = (code) => needs(code).every((c) => own[c] || full[c]);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => detectInitialLanguage().lang);
  const [version, setVersion] = useState(0);
  const [shown, setShown] = useState(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // The words for the language asked for; the one on screen stays up while
  // they download (no blank screen, no raw keys).
  useEffect(() => {
    if (ready(lang)) {
      setShown(lang);
      return undefined;
    }
    let live = true;
    Promise.all(needs(lang).map(wordsFor))
      .then(() => {
        if (!live) return;
        setShown(lang);
        bump();
      })
      .catch(() => {
        // The words could not be fetched (offline on a cold start): English
        // words, else the calls' own fallbacks — the screen still renders.
        wordsFor("en").catch(() => null).finally(() => {
          if (!live) return;
          setShown((s) => s || "en");
          bump();
        });
      });
    return () => {
      live = false;
    };
  }, [lang, bump]);

  const active = shown || lang;
  const missAsked = useMemo(() => new Set(), []);

  const t = useCallback((key, fallbackOrVars, maybeVars) => {
    const secondIsVars = fallbackOrVars !== null && typeof fallbackOrVars === "object" && !Array.isArray(fallbackOrVars);
    const fallback = secondIsVars ? undefined : fallbackOrVars;
    const thirdIsVars = maybeVars !== null && maybeVars !== undefined && typeof maybeVars === "object" && !Array.isArray(maybeVars);
    const vars = thirdIsVars ? maybeVars : secondIsVars ? fallbackOrVars : null;
    const hit =
      full[active]?.[key] || own[active]?.[key] ||
      (needs(active).includes("en") ? full.en?.[key] || own.en?.[key] : undefined);
    if (!hit && OWN_WORDS[active] && own[active] && !full[active] && !missAsked.has(active)) {
      // Not in the door screen's words: the full dictionary, once.
      missAsked.add(active);
      if (import.meta.env?.DEV) console.warn(`[i18n] "${key}" is not in the door screen's words`);
      loadLocale(active).then((d) => {
        full[active] = d || {};
        bump();
      }).catch(() => {});
    }
    let result = hit || (fallback !== undefined ? fallback : key);
    if (vars && typeof result === "string" && result.indexOf("{") !== -1) {
      result = result.replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
    }
    return result;
    // `version` re-creates t when words arrive, so every caller re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, version, bump, missAsked]);

  const setLang = useCallback((code) => {
    setLangState(code);
    try {
      localStorage.setItem("lang", code);
      localStorage.removeItem("bonbox_lang_auto_picked");
    } catch {
      /* private mode */
    }
  }, []);
  const toggleLang = useCallback(() => {
    const codes = LANGUAGES.map((l) => l.code);
    setLang(codes[(codes.indexOf(lang) + 1) % codes.length]);
  }, [lang, setLang]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = active;
    if (isReplaceableTitle(document.title)) document.title = shellTitle(active);
  }, [active]);

  // Nothing on screen says a word before its words are in (stand.html
  // preloads them with the code, so this is the code's own download time).
  if (!shown) return null;
  return (
    <LanguageContext.Provider value={{ lang: active, setLang, toggleLang, t, LANGUAGES, fullReady: true, ensureFull: () => {} }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
