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
// Landing v6 (22 Oct 2026): the title is the landing's headline. da = index.html's <title> exactly; en is
// Claude's suggestion (PORT_PLAN 2.6, forslag); tr reads the English title, as a Turkish reader reads the
// English landing (landingV6.* has no Turkish yet, PORT_PLAN 2.2).
export const SHELL_TITLES = {
  da: "BonBox · Vagterne. Bordene. Kassen.",
  en: "BonBox · Shifts. Tables. Till.",
  tr: "BonBox · Shifts. Tables. Till.",
};

export const SHELL_TITLE_VALUES = Object.values(SHELL_TITLES);

/** The shell's tab title for `lang` (English for a language without one). */
export function shellTitle(lang) {
  return SHELL_TITLES[lang] || SHELL_TITLES.en;
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
