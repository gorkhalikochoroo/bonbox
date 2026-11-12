/**
 * A table's name as a person reads it — display only.
 *
 * A table named only by a number read like a party size: the row said
 * "👥 2   2", the toast "Drop-in finished — 2 is free.", the waitlist "Free
 * now and fits: 2" (waiter test on the iPad, 12 Nov). A label that is only
 * digits is said "Table 2" / "Bord 2" ("Space 2" / "Plads 2" where the
 * venue speaks appointments); any other label ("Vindue 3", "A2") is shown as
 * the owner wrote it.
 *
 * Never the stored label, never a comparison, never the floor plan's circles
 * (a bare number inside a drawn table reads fine): only words on screen.
 * Idempotent — a name already made ("Bord 2") passes through unchanged.
 */
const DIGITS_ONLY = /^\d+$/;

export function tableName(label, t, { appt = false } = {}) {
  if (label == null || label === "") return label;
  const s = String(label).trim();
  if (!DIGITS_ONLY.test(s)) return label;
  return appt
    ? t("rsvpSpaceNumbered", "Space {n}", { n: s })
    : t("rsvpTableNumbered", "Table {n}", { n: s });
}

/**
 * Several tables pushed together — an array of labels, or one string the way
 * the book joins them ("6 + 7") — each named by tableName, joined " + ".
 */
export function tablesName(labels, t, opts) {
  if (labels == null || labels === "") return labels;
  const parts = Array.isArray(labels) ? labels : String(labels).split(" + ");
  return parts.filter((p) => p != null && p !== "").map((p) => tableName(p, t, opts)).join(" + ");
}
