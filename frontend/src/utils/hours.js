/**
 * The ONE way BonBox prints a quantity of hours.
 *
 * Vagtplan and Timer & løn are the same week seen twice, and until this module
 * they disagreed about how to write it: the schedule grid printed "38h" (its
 * own formatTimer, no space, unit typed inline) while the hours page printed
 * "38,0 t" (its own fmtHours, always one decimal). The owner who plans a week
 * and then pays for it read two different numbers for one fact — and in the
 * Vagtplan Shield tooltips the unit was not even formatted, it was a literal
 * "t" inside the catalogue string ("{h}t of {cap}t"), so an English session
 * read "34t of 37t": a Danish unit on an English screen.
 *
 * The rule, single-sourced here:
 *   • decimal COMMA in Danish, point elsewhere — it is a number, and a Dane
 *     writes 6,25;
 *   • a space before the unit, always — "38 t", not "38t". A unit glued to a
 *     digit reads as part of the number;
 *   • whole hours drop the decimals — "38 t", not "38,0 t". Subtraction;
 *   • unit from the language, never typed at a call site;
 *   • an unknown value renders "—". Not "0 t": nobody worked zero hours, we
 *     just have not been told yet.
 */

/**
 * The unit, per language. THE one place this mapping lives.
 *
 * It has to be one place because the two pages used to read it from two: the
 * hours page derived it from `lang`, the schedule grid from t("schedHoursUnit")
 * — and those two disagree in Turkish, an offered locale ("h" vs "sa"), so a
 * Turkish owner read "38 sa" on Vagtplan and "38 h" on Timer & løn for the
 * same week. Exactly the defect this module was opened for, one locale over.
 */
const UNIT_BY_LANG = { da: "t", tr: "sa" };

export function hoursUnit(lang) {
  return UNIT_BY_LANG[lang] || "h";
}

/** Danish writes 6,25. Keyed on the LANGUAGE, not on the unit — keying it on
    `unit === "t"` gave Turkish an English decimal point under a Turkish unit
    ("38.5 sa"), because only Danish happened to spell its unit "t". */
function decimalMark(lang) {
  return lang === "da" ? "," : ".";
}

/**
 * Format a number of hours for display.
 *
 * @param {number|null|undefined} value
 * @param {object}  [opts]
 * @param {string}  [opts.lang="en"]   UI language — picks unit and decimal mark.
 * @param {number}  [opts.decimals=1]  MAXIMUM decimals kept. Per-shift figures
 *        pass 2 so an 07:00–15:20 shift stays 8,33 t (what the backend pays)
 *        instead of being crushed to 8,3.
 * @param {boolean} [opts.sign=false]  Prefix "+" on positives — for deltas,
 *        where the direction is the point.
 * @returns {string} e.g. "38 t" · "6,25 t" · "38 h" · "—"
 *
 * There is deliberately NO `unit` override any more. An override is how the
 * two pages drifted apart in the first place: give a caller a way to supply
 * its own unit and one of them eventually does.
 */
export function formatHours(value, { lang = "en", decimals = 1, sign = false } = {}) {
  const n = typeof value === "number" ? value : Number(value);
  if (value == null || value === "" || !Number.isFinite(n)) return "—";
  const u = hoursUnit(lang);
  // Round FIRST, then decide whether decimals survive — 38.04 at 1 decimal is
  // a whole 38, and printing "38,0 t" for it would claim a precision the
  // rounding just threw away.
  const factor = 10 ** decimals;
  const r = Math.round(n * factor) / factor;
  let s = Number.isInteger(r) ? String(r) : r.toFixed(decimals).replace(/0+$/, "").replace(/[.,]$/, "");
  // The unit is the language's, so the decimal mark has to be too — "6.25 t"
  // is an English number wearing a Danish unit, which is the exact hybrid the
  // Shield chip shipped.
  s = s.replace(".", decimalMark(lang));
  const prefix = sign && r > 0 ? "+" : "";
  return `${prefix}${s} ${u}`;
}
