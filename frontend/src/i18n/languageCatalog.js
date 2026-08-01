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
 * Coverage worth knowing, unresolved: useLanguage.jsx records that nine stub
 * packs were once pulled from the picker because half the UI fell back to
 * English and that "felt deceptive". By that standard de/vi/th (10–22%) do not
 * clear the bar either — someone picking Deutsch gets a German label on a
 * 90%-English app. They stay offered until that call is made.
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
  // Still offered. Coverage is low and the note above explains why that is a
  // problem, but pulling them is a product call that has not been made.
  { code: "vi", label: "Tiếng Việt", short: "VN", flag: "🇻🇳", coverage: 22, offered: true },
  { code: "th", label: "ภาษาไทย", short: "TH", flag: "🇹🇭", coverage: 22, offered: true },
  { code: "de", label: "Deutsch", short: "DE", flag: "🇩🇪", coverage: 10, offered: true },
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
