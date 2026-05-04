/**
 * Format a YYYY-MM-DD date string to dd/mm/yy.
 * NOTE: This format is locale-ambiguous (US vs EU readers interpret 02/04/26
 * differently). Prefer formatDateClear() for any UI where users might be
 * confused. Kept for backwards compatibility with table cells where space is
 * tight and EU convention is assumed.
 *
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {string} Formatted date (dd/mm/yy)
 */
export function formatDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.slice(0, 10).split("-");
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  return `${d}/${m}/${y.slice(2)}`;
}

/**
 * Format a YYYY-MM-DD date string to dd/mm (no year).
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {string} Formatted date (dd/mm)
 */
export function formatDateShort(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.slice(0, 10).split("-");
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}`;
}

/* Locale-aware month abbreviations. Falls back to English. */
const MONTHS_BY_LOCALE = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  da: ["Jan", "Feb", "Mar", "Apr", "Maj", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"],
  de: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
  fr: ["Janv", "Févr", "Mars", "Avr", "Mai", "Juin", "Juil", "Août", "Sept", "Oct", "Nov", "Déc"],
  es: ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"],
  it: ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"],
  pt: ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"],
  nl: ["Jan", "Feb", "Mrt", "Apr", "Mei", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"],
  sv: ["Jan", "Feb", "Mar", "Apr", "Maj", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"],
  no: ["Jan", "Feb", "Mar", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Des"],
};

function detectLocale() {
  if (typeof navigator === "undefined") return "en";
  const lang = (localStorage.getItem("bonbox_lang") || navigator.language || "en")
    .toLowerCase()
    .split("-")[0];
  return MONTHS_BY_LOCALE[lang] ? lang : "en";
}

/**
 * Format a date as "2 Apr 26" — unambiguous across all locales (no DD/MM vs
 * MM/DD confusion). Use this in tables and lists where users from different
 * regions might read the data.
 *
 * @param {string} dateStr - ISO date string (YYYY-MM-DD or full ISO)
 * @returns {string} Formatted date like "2 Apr 26"
 */
export function formatDateClear(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.slice(0, 10).split("-");
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  const monthIdx = parseInt(m, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return dateStr;
  const months = MONTHS_BY_LOCALE[detectLocale()] || MONTHS_BY_LOCALE.en;
  return `${parseInt(d, 10)} ${months[monthIdx]} ${y.slice(2)}`;
}

/**
 * Same as formatDateClear but returns the full year — for headers / titles
 * where you want "2 Apr 2026".
 */
export function formatDateClearFull(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.slice(0, 10).split("-");
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  const monthIdx = parseInt(m, 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return dateStr;
  const months = MONTHS_BY_LOCALE[detectLocale()] || MONTHS_BY_LOCALE.en;
  return `${parseInt(d, 10)} ${months[monthIdx]} ${y}`;
}
