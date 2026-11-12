// The book's day helpers — the venue's service day, a day stepped by ±n,
// and the stepper's friendly label. Moved out of pages/ReservationsPage.jsx
// unchanged (reservations v2, 12 Nov 2026) so the day rail can live in its
// own module (components/reservations/DayRail.jsx), which the door screen's
// build loads on first use. Still one definition of each.
import { businessTodayIso } from "./dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "./dailyCloseDay";

// Local YYYY-MM-DD for the book's day picker (defaults to today).
export function isoDay(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The venue's SERVICE day. The server files every booking by business day
// (06:00 cutoff for food service); the page asked for the calendar day, so a
// drop-in seated at 00:20 vanished from "I dag" and the stand jumped to an
// empty tomorrow at midnight with guests still at the tables. Table venues
// all close their day at 06:00; a salon booking nothing between midnight and
// six loses nothing by the same rule.
export function serviceDayIso() {
  return businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
}

// Step a YYYY-MM-DD day by ±n calendar days (local, DST-safe).
export function shiftDay(iso, delta) {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return isoDay(dt);
}

// Friendly label for the date stepper: "I dag" / "I morgen" / "I går" for the
// immediate neighbours, otherwise the capitalised weekday in the active locale.
export function relativeDayLabel(iso, t, locale) {
  const today = serviceDayIso();
  if (iso === today) return t("rsvpToday", "Today");
  if (iso === shiftDay(today, 1)) return t("rsvpDayTomorrow", "Tomorrow");
  if (iso === shiftDay(today, -1)) return t("rsvpDayYesterday", "Yesterday");
  try {
    const [y, m, d] = iso.split("-").map(Number);
    const wd = new Date(y, m - 1, d).toLocaleDateString(locale || "en", {
      weekday: "long",
    });
    return wd.charAt(0).toUpperCase() + wd.slice(1);
  } catch {
    return "";
  }
}
