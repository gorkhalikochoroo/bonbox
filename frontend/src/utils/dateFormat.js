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

/**
 * The BCP-47 tag to hand toLocaleDateString / toLocaleString.
 *
 * Twelve call sites across the app hardcoded "en-GB" or "en-US", so a Danish
 * owner read "Wednesday, 26 August 2026" under a fully Danish UI — including on
 * the MOMS/SKAT deadline card. Verified on device: switching the app to Dansk
 * translated every label and left the date in English.
 *
 * Deliberately NOT the same thing as formatDateClearFull(): that one drops the
 * weekday and abbreviates the month, so it is not a drop-in for call sites that
 * ask for `weekday: "long"`. This keeps each call's own options and only fixes
 * WHICH locale renders them.
 *
 * A plain function rather than a hook so the module-level helpers
 * (StaffHoursPage's fmtDate, BudgetPage's month label) can use it too.
 */
const BCP47_BY_LANG = {
  da: "da-DK", en: "en-GB", de: "de-DE", fr: "fr-FR", es: "es-ES",
  nl: "nl-NL", sv: "sv-SE", no: "nb-NO", pt: "pt-PT", it: "it-IT",
  ja: "ja-JP", vi: "vi-VN", th: "th-TH", tr: "tr-TR", np: "ne-NP",
};

export function dateLocale() {
  return BCP47_BY_LANG[detectLocale()] || "en-GB";
}

function detectLocale() {
  if (typeof navigator === "undefined") return "en";
  // "lang" is what the provider writes (useLanguage.jsx). This read used to
  // ask for "bonbox_lang", a key nothing sets, so it ALWAYS fell through to
  // the device language — which is why Danish accounts printed English
  // dates, including on the MOMS/SKAT deadline card.
  const lang = (localStorage.getItem("lang") || navigator.language || "en")
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

/**
 * ISO 8601 week number (1–53) for a YYYY-MM-DD date string. Shared so the
 * weekly statement renders the DK-locked "Uge {n}" label without duplicating
 * the algorithm that already lives in StaffSchedulePage. Returns null on a
 * malformed input rather than throwing.
 *
 * @param {string} dateStr - ISO date string (YYYY-MM-DD or full ISO)
 * @returns {number|null} ISO week number
 */
export function isoWeek(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.slice(0, 10).split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((p) => parseInt(p, 10));
  if ([y, m, d].some((n) => Number.isNaN(n))) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
}

/**
 * ISO date (YYYY-MM-DD) in the user's LOCAL timezone — never UTC.
 *
 * Why this exists: `new Date().toISOString().slice(0, 10)` returns the UTC
 * date, which makes a Danish owner closing at 01:14 local time (CEST=UTC+2 →
 * UTC 23:14 the day before) see "yesterday" everywhere we default a date
 * input. Cascading bugs: faktura "Issued" off by 1, "Last 7 days" range
 * starts 8 days ago and excludes today's close, etc.
 *
 * Pass an optional `Date` to convert a specific moment; defaults to now.
 *
 * @param {Date} [d=new Date()] - Date to convert
 * @returns {string} YYYY-MM-DD in the local timezone
 */
export function localIso(d = new Date()) {
  const offsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10);
}

/**
 * The date the current BUSINESS day belongs to — the client twin of the
 * backend's `business_today_local()` (services/tz_utils.py:146).
 *
 * Before the cutoff hour this returns YESTERDAY, so a café closing at 02:00
 * still counts that service against the day it started. Without this, a page
 * that filtered on localIso() reported "0 sales today" at 00:30 while the
 * dashboard — which asks the server — correctly showed the evening's takings.
 * Two screens, two answers to "what did I take today".
 *
 * Semantics match the backend exactly: `now.hour < cutoff ? yesterday : today`.
 * One known divergence: the backend resolves in the ACCOUNT's timezone and
 * this resolves in the DEVICE's. Identical for a Danish owner on a Danish
 * phone; a traveling owner can still disagree by a day, and closing that
 * needs the account timezone on the client.
 *
 * @param {number} [cutoffHour=0] - 0-23. DK restaurants use 6.
 * @param {Date} [d=new Date()]
 * @returns {string} YYYY-MM-DD
 */
export function businessTodayIso(cutoffHour = 0, d = new Date()) {
  const raw = Number(cutoffHour);
  const cutoff = Number.isFinite(raw) ? Math.min(23, Math.max(0, Math.trunc(raw))) : 0;
  const ref = new Date(d.getTime());
  if (ref.getHours() < cutoff) ref.setDate(ref.getDate() - 1);
  return localIso(ref);
}

/**
 * ISO date for N days before today, in local timezone.
 * `localDaysAgo(7)` returns the day 7 days ago. For "Last 7 days INCLUSIVE
 * of today" use `localDaysAgo(6)` and pair with `localIso()` as the end.
 *
 * @param {number} n - Days to subtract
 * @returns {string} YYYY-MM-DD
 */
export function localDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localIso(d);
}
