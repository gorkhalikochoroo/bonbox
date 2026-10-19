// Date words on the guest booking page (/r/:slug), in the guest's language.
//
// Moved out of pages/ReservationPublicPage.jsx unchanged (booking push p1,
// build plan C4), so pure helpers such as utils/dayState.js can format a
// date without importing the page.
//
// Dates followed the venue's language even after the guest switched to
// English: the page read "Pick a date" over a strip of "Søn. 26. Jul.".
// Weekday and month names are UI chrome, so they translate — unlike the
// DK terminology lock (MOMS, revisor, kasserapport), which never does.
//
// en-GB, not en-US: day-before-month matches how the rest of this page
// and every Danish guest reads a date.
export const DATE_LOCALES = { da: "da-DK", en: "en-GB" };

export function dateLocale(lang) {
  return DATE_LOCALES[lang] || "da-DK";
}

// "Fre. 2. okt." / "Fri 2 Oct" — the bottom bar's compact date. en-GB writes
// September as "Sept" while every other month is three letters; "Sep" keeps
// the rhythm.
export function fmtDayShort(isoStr, lang) {
  if (!isoStr) return "";
  try {
    return new Date(`${isoStr}T00:00:00`)
      .toLocaleDateString(dateLocale(lang), { weekday: "short", day: "numeric", month: "short" })
      .replace(/\bSept\b/, "Sep");
  } catch {
    return isoStr;
  }
}

export function capFirst(text) {
  const v = String(text || "");
  return v ? v[0].toLocaleUpperCase() + v.slice(1) : v;
}

// Pretty DK date for the header / success screen: "lørdag 13. juni".
export function fmtDayLabel(isoStr, lang) {
  if (!isoStr) return "";
  try {
    const d = new Date(`${isoStr}T00:00:00`);
    return d.toLocaleDateString(dateLocale(lang), {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  } catch {
    return isoStr;
  }
}
