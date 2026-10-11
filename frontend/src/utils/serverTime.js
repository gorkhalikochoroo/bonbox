/**
 * Read a server timestamp as the instant it is — UTC when it says nothing.
 *
 * The backend stores timestamps as NAIVE UTC and most endpoints send them as
 * `dt.isoformat()`: "2026-10-11T08:14:03.123456", no "Z", no offset. The
 * browser's Date() reads a date-time with no offset as LOCAL time, so on a
 * Danish screen every such stamp lands 2 h (summer, CEST) or 1 h (winter, CET)
 * in the past: the admin list said "Last seen 2h ago" for an owner who had
 * signed in a minute earlier.
 *
 *   parseServerTime("2026-10-11T08:14:03")       → 08:14:03 UTC (10:14 CEST)
 *   parseServerTime("2026-10-11 08:14:03.123456") → the same, space separator
 *   parseServerTime("2026-10-11T08:14:03Z")       → unchanged
 *   parseServerTime("2026-10-11T10:14:03+02:00")  → unchanged
 *   parseServerTime("2026-10-11")                 → unchanged (a day, not a time)
 *   parseServerTime(null | "" | "garbage")        → null
 *
 * Returns a Date, or null when there is nothing usable — never an Invalid
 * Date, so a caller can write `parseServerTime(x)?.toLocaleString()`.
 *
 * NOT for wall-clock fields. Reservation and event `starts_at` / `ends_at`
 * (and what is computed from them, like `bookings_close_at`) are stored as
 * naive Europe/Copenhagen wall-clock — the booking engine's frame — and
 * new Date() reading them as local is the correct reading there
 * (utils/reservationIcs.js, routers/reservations.py _local_date_of). Only use
 * this for stamps the server writes with utc_now(): created_at, updated_at,
 * last_*_at, *_verified_at, trial_ends_at, …
 */

// A calendar date followed by a clock time (T or space separated).
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
// Already says where it is: "Z", "+02:00", "+0200", "-05".
const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/;

export function parseServerTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  const iso = DATE_TIME.test(s) && !HAS_OFFSET.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
