// The venue's weekly opening hours on the guest booking page (/r/:slug),
// as words (booking push p3). Pure: no React, no clock of its own.
//
// The server sends the booking engine's own week (public_reservations
// "hours", reservation_service.public_week): one entry per weekday, Monday
// first, each null (no claim for that day — no row) or
// { windows: [["17:00", "22:00"]], by: "booking" | "opening" }, where
// windows [] is a closed day. A closed day's word follows the source the
// date strip reads ("opening" = "Lukket", the strip's "lukket"; "booking" =
// closed for bookings only). These helpers only group and word that week —
// they never decide whether a day is open.
import { capFirst, dateLocale } from "./guestLocale";

export const WEEK_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Owner question Q5 (the fold ladder, build plan C2): the one-tap hours item
// in the phone/tablet card's address row, and the week it opens. false holds
// that item back (if a phone fold measurement ever fails) and changes
// nothing else: the desktop column keeps its list.
export const PHONE_HOURS_ITEM = true;

// getDay() order (0 = Sunday) → our Monday-first keys.
const BY_GET_DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// The weekday key for the page's own `today` (an ISO date in the guest's
// local calendar), built as local midnight — the same construction the
// page's date strip uses (fmtDayShort), so "today" in the list and the
// strip's first chip always agree.
export function todayKey(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  const n = d.getDay();
  return Number.isNaN(n) ? null : BY_GET_DAY[n];
}

// Two days read the same: equal windows, and — only for a day with no
// window — the same source, since that is where the source picks the word
// ("Lukket" or "Ingen bordbestilling"). On an open day the source shows
// nothing, so Monday's Profile 17–22 and Tuesday's booking 17–22 are one row.
function sameDay(a, b) {
  if (!a || !b) return false;
  const wa = a.windows || [];
  if (JSON.stringify(wa) !== JSON.stringify(b.windows || [])) return false;
  return wa.length > 0 || a.by === b.by;
}

// [{ from, to, day }]: consecutive weekdays that read the same (sameDay)
// merge into one row, Monday first. A null day breaks a run and yields no
// row; Sunday never wraps into Monday.
export function groupWeek(days) {
  const out = [];
  if (!days || typeof days !== "object") return out;
  let gap = true; // the previous weekday had no row
  for (const key of WEEK_KEYS) {
    const day = days[key] || null;
    if (!day) {
      gap = true;
      continue;
    }
    const last = out[out.length - 1];
    if (!gap && last && sameDay(last.day, day)) last.to = key;
    else out.push({ from: key, to: key, day });
    gap = false;
  }
  return out;
}

// Is there a week worth showing? (The server sends null otherwise; an old or
// odd payload with every day null shows nothing either.)
export function hasVenueWeek(hours) {
  return groupWeek(hours?.days).length > 0;
}

// "Mandag" / "Monday". Pinned to UTC on both sides (a UTC date, formatted in
// UTC), so a guest west or east of UTC never reads the names a day off.
export function weekdayName(key, lang) {
  const i = WEEK_KEYS.indexOf(key);
  if (i < 0) return "";
  const date = new Date(Date.UTC(2026, 0, 5 + i)); // 5 Jan 2026 is a Monday
  return capFirst(new Intl.DateTimeFormat(dateLocale(lang), { weekday: "long", timeZone: "UTC" }).format(date));
}

// "Mandag–torsdag" / "Monday–Thursday": the first name capitalised; the
// second lowercase in Danish, as Danish writes it. A single day: "Søndag".
export function dayRangeLabel(group, lang) {
  const first = weekdayName(group.from, lang);
  if (group.to === group.from) return first;
  const last = weekdayName(group.to, lang);
  return `${first}–${lang === "en" ? last : last.toLocaleLowerCase("da-DK")}`;
}

// "17:00–22:00" (an en dash, 24 h in both languages, like the time chips);
// several windows joined with ", "; null for a closed day.
export function windowsLabel(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  return windows.map(([open, close]) => `${open}–${close}`).join(", ");
}

// The word for a day with no window: "Lukket" where the Profile hours say
// closed (the strip's "lukket"), else "Ingen bordbestilling" /
// "Ingen tidsbestilling" (owner question Q4's default).
export function emptyWord(by, apptWords, t) {
  if (by === "opening") return t("rsvpVenueHoursClosed", "Closed");
  return apptWords
    ? t("rsvpVenueHoursNoBookingAppt", "No appointments")
    : t("rsvpVenueHoursNoBooking", "No table bookings");
}
