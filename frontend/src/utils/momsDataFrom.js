/**
 * The MOMS forecast's "only figures from …" caveat (foresight payload
 * moms.data_from / moms.period_start).
 *
 * An owner who joined mid-period has no data for the days before; the run-rate
 * now uses only the days WITH data, and the booked MOMS for the days before is
 * simply not in BonBox. Say so next to the figure, once.
 * Returns null when the data covers the whole period.
 */
export function momsDataFromParts(moms) {
  const from = moms?.data_from;
  const start = moms?.period_start;
  if (!from || !start || from <= start) return null;
  const d = new Date(`${from}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const pad = (x) => String(x).padStart(2, "0");
  const end = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from, start, end };
}
