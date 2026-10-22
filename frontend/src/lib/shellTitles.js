/**
 * The tab titles index.html can ship, per language, and the language rule the
 * shell, the app and the dictionary preload all share.
 *
 * SHELL TITLES. The shell is Danish (Denmark is the market and the static HTML
 * is what crawlers read); the English one is swapped in at runtime for an
 * English reader. If you change the <title> in index.html, change it here.
 * Only languages at full coverage get a localised shell title: a translated
 * tab on a mostly-English page reads as broken, so partial locales keep the
 * English one until they are filled.
 *
 * Lives outside hooks/useLanguage.jsx (which re-exports it) so a page title
 * hook can restore the shell title without going through the language
 * context module — tests mock that module, never this one.
 */
//
// Landing v6 (22 Oct 2026) and the security fix round (23 Oct 2026, step_13 open item 9): the landing and the app
// each keep their own tab title.
//   - SHELL_TITLES: the app's default tab title, origin/main's line, for every signed-in page that does not name
//     itself (the dashboard and the other Layout pages). The port (step 5/6) had swapped it for the landing's headline, so
//     a signed-in owner's tabs all read "Vagterne. Bordene. Kassen."; tr keeps its Turkish line.
//   - LANDING_TITLES: the landing's headline, da = index.html's static <title> exactly (what crawlers read for "/"),
//     en = Claude's suggestion (PORT_PLAN 2.6, forslag). The landing page sets it while it is on screen
//     (pages/LandingV6Page.jsx, holdLandingTitle below), in the page's own language (da or en; a Turkish reader
//     reads the English page, so the English headline).
// A cold load of an app route still starts on index.html's landing title; the language provider replaces it with
// the app's (hooks/useLanguage.jsx), unless the landing holds the tab.
export const SHELL_TITLES = {
  da: "BonBox — Bagkontoret din virksomhed faktisk kører på",
  en: "BonBox — The back office your business actually runs on",
  tr: "BonBox — İşletmenin gerçekten üzerinde döndüğü arka ofis",
};

export const SHELL_TITLE_VALUES = Object.values(SHELL_TITLES);

/** The shell's tab title for `lang` (English for a language without one). */
export function shellTitle(lang) {
  return SHELL_TITLES[lang] || SHELL_TITLES.en;
}

export const LANDING_TITLES = {
  da: "BonBox · Vagterne. Bordene. Kassen.",
  en: "BonBox · Shifts. Tables. Till.",
};

export const LANDING_TITLE_VALUES = Object.values(LANDING_TITLES);

/** The landing's tab title for the page language (the landing is Danish or English). */
export function landingTitle(pageLang) {
  return LANDING_TITLES[pageLang] || LANDING_TITLES.en;
}

// How many mounted landings hold the tab (0 or 1; a count so StrictMode's mount / unmount / mount stays right).
let landingHolds = 0;

/** The landing takes the tab while it is on screen; the returned release hands it back. */
export function holdLandingTitle() {
  landingHolds += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    landingHolds -= 1;
  };
}

/** Whether a mounted landing holds the tab (the language provider then leaves a landing title alone). */
export function landingHoldsTitle() {
  return landingHolds > 0;
}

/** A tab title the language provider may replace with the app's: one of the app's defaults, or the landing's
 *  headline (index.html's static <title>, or a landing that has just left) while no landing holds the tab. */
export function isReplaceableTitle(title) {
  if (SHELL_TITLE_VALUES.includes(title)) return true;
  return LANDING_TITLE_VALUES.includes(title) && !landingHoldsTitle();
}

/**
 * PQ-05 — a browser that lists Danish (or Faroese) ANYWHERE in its languages
 * gets Danish. An English-first phone in Denmark (["en-US", "da"]) is the
 * common case: the owner set the phone up in English and still reads Danish.
 * The same test runs in index.html's inline script and in the dictionary
 * preload vite.config.js writes (/(^|,)(da|fo)/ over the joined list), so all
 * three agree — and such a browser downloads one dictionary, not two.
 */
export const DANISH_TAG = /^(da|fo)(-|$)/i;

export function browserListsDanish(languages) {
  if (!Array.isArray(languages)) return false;
  return languages.some((l) => DANISH_TAG.test(String(l || "")));
}
