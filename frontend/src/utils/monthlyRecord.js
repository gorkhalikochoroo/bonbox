/**
 * Month by month — helpers for the booking record in Indsigt (and the
 * calendar's month line). The server returns every month in the window, zeros
 * included, newest first (GET /reservations/monthly).
 */

/**
 * The months worth a row: from the first month that had ANY booking (even a
 * cancelled one) up to this month. A venue that started in July sees
 * July–September, not nine empty months above them. Newest first, as served.
 */
export function visibleMonths(months) {
  const list = Array.isArray(months) ? months : [];
  const had = (m) => (m.bookings || 0) + (m.cancelled || 0) > 0;
  let last = -1; // index of the OLDEST month with activity
  list.forEach((m, i) => {
    if (had(m)) last = i;
  });
  return last === -1 ? [] : list.slice(0, last + 1);
}

/** "2026-09" → "September 2026" in the app's language, first letter capital. */
export function monthName(key, lang, withYear = true) {
  const [y, m] = String(key).split("-").map(Number);
  if (!y || !m) return String(key);
  const s = new Date(y, m - 1, 1).toLocaleDateString(lang || "da", {
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
