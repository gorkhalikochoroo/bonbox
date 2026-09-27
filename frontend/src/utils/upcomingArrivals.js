/**
 * Who is still to come on the day the book is showing — the "Kommende" list in
 * the Reservations side column.
 *
 * "Still to come" = a live booking nobody has seated yet: requested (awaiting
 * confirmation) or confirmed. A party whose start time has passed stays on the
 * list — same rule as the floor plan: a late party is exactly the one the host
 * must not lose track of, until they are seated or marked a no-show.
 *
 * A day that is already over has nothing coming, so it returns [] rather than
 * listing yesterday's unmarked bookings as if they were on their way.
 */
export const UPCOMING_STATUSES = ["requested", "confirmed"];

/** Rows the side list shows before "+N more" — the column is sticky, and more
 *  than this outgrows a laptop screen. */
export const UPCOMING_MAX_ROWS = 5;

export function hasAllergy(r) {
  return (
    (Array.isArray(r?.allergen_tags) && r.allergen_tags.length > 0) ||
    !!r?.allergy_note ||
    !!r?.allergy_severity
  );
}

/**
 * @param {Array} reservations  the day's bookings, as the book loaded them
 * @param {{day: string, today: string}} opts  YYYY-MM-DD of the day shown / of today
 */
export function selectUpcoming(reservations, { day, today }) {
  if (!day || !today || day < today) return [];
  const ms = (r) => new Date(r.starts_at).getTime();
  return (reservations || [])
    .filter((r) => UPCOMING_STATUSES.includes(r.status) && r.starts_at && !Number.isNaN(ms(r)))
    .sort((a, b) => ms(a) - ms(b));
}
