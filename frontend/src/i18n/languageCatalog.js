/**
 * Which languages BonBox has, and which ones the picker OFFERS.
 *
 * `coverage` is the measured share of the English dictionary each locale
 * actually translates. `offered` is what the picker shows.
 *
 * Nepali is hidden by product decision. Nothing is deleted: the dictionary
 * stays on disk, "np" stays in SUPPORTED, and anyone already reading BonBox in
 * Nepali keeps doing so. Hiding only stops us OFFERING it to someone new.
 *
 * The counts shown to users are DERIVED from `offered` below rather than typed
 * into copy. That is what stops the pricing page from claiming "6 languages"
 * while the picker shows a different number, which is exactly what it did.
 *
 * Coverage, RESOLVED 2026-08-30: useLanguage.jsx records that nine stub packs
 * were once pulled from the picker because half the UI fell back to English
 * and that "felt deceptive". de/vi/th (10–22%) did not clear that same bar, so
 * they are now withdrawn too — see the note on those rows. The picker offers
 * only en, da and tr, the three packs at 100%.
 *
 * Percentages are point-in-time (measured 2026-08-01); scripts/check-i18n-keys
 * is the source of truth if they drift.
 *
 * This lives outside useLanguage.jsx so the constants can be imported by pages
 * without breaking fast-refresh on the hook module.
 */

export const ALL_LANGUAGES = [
  { code: "en", label: "English", short: "EN", flag: "🇬🇧", coverage: 100, offered: true },
  { code: "da", label: "Dansk", short: "DK", flag: "🇩🇰", coverage: 100, offered: true },
  { code: "tr", label: "Türkçe", short: "TR", flag: "🇹🇷", coverage: 100, offered: true },
  // Hidden by an explicit product decision, not by the coverage rule.
  { code: "np", label: "नेपाली", short: "NP", flag: "🇳🇵", coverage: 34, offered: false },
  // WITHDRAWN 2026-08-30 — the call the note above was waiting for.
  //
  // The bar was already set here: nine stub packs were pulled because half the
  // UI fell back to English and that "felt deceptive". At 10–22% these three
  // are further under that bar than some of the nine were, so keeping them
  // offered meant applying the standard to everyone except the packs we
  // happened to have. A visitor picking Deutsch got a German language name on
  // a 90%-English app.
  //
  // Nothing is deleted and nothing is lost: the dictionaries stay on disk,
  // these codes stay in SUPPORTED (useLanguage.jsx), and anyone already
  // reading BonBox in one of them keeps doing so. Withdrawing only stops us
  // OFFERING it to someone new — the same treatment np already has.
  //
  // This also became visible rather than theoretical: until the SUPPORTED fix,
  // picking Deutsch silently reverted to English on the next load, which was
  // accidentally hiding the coverage problem.
  //
  // REVERTING IS ONE WORD PER ROW: flip offered back to true. The counts in
  // the pricing and landing copy are DERIVED from this list, so they follow
  // automatically in both directions — nothing else to change. Raise coverage
  // first and the locked-terms guard (which now enforces on offered locales
  // only) will tell you if the pack is ready.
  { code: "vi", label: "Tiếng Việt", short: "VN", flag: "🇻🇳", coverage: 22, offered: false },
  { code: "th", label: "ภาษาไทย", short: "TH", flag: "🇹🇭", coverage: 22, offered: false },
  { code: "de", label: "Deutsch", short: "DE", flag: "🇩🇪", coverage: 10, offered: false },
];

/** What the picker shows — complete languages only. */
export const LANGUAGES = ALL_LANGUAGES.filter((l) => l.offered);

/**
 * The count the pricing and landing pages quote, DERIVED so it cannot drift
 * from what the picker actually offers.
 */
export const COMPLETE_LANGUAGE_COUNT = LANGUAGES.length;

/** The same set as a human-readable list, in native names. */
export const COMPLETE_LANGUAGE_NAMES = LANGUAGES.map((l) => l.label).join(", ");
