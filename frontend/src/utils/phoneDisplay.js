/**
 * A guest's phone number, written one way on screen — display only.
 *
 * The book printed what each guest typed, so one service showed
 * "20 55 66 77", "+4511223344" and "+45 20 44 55 66" side by side (waiter
 * test, 12 Nov). A number we can read as Danish or Portuguese is written the
 * country's usual way with its code ("+45 20 55 66 77", "+351 912 345 678");
 * anything else is shown as typed (trimmed). The stored value is never
 * changed, and a tel: link keeps the digits as stored.
 *
 * `country` is the venue's ("DK" | "PT" | null — GET /reservations/book
 * venue_country): it decides what a bare national number means — 8 digits
 * in Denmark, 9 in Portugal. Unknown (an older API) reads Denmark first, as
 * the SMS sender always has. A number with + or 00 keeps its own code. A
 * Portuguese number is a "9…" mobile, as the SMS sender reads it: a bare
 * "612 345 678" (a Spanish mobile typed without +34) stays as typed.
 */
const DK = (d) => `+45 ${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 6)} ${d.slice(6, 8)}`;
const PT = (d) => `+351 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)}`;

export function displayPhone(raw, country = null) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s) return s;
  // Only a number written with the usual separators is ours to re-write; a
  // note typed in the phone field ("ring efter 17") stays as typed.
  if (!/^\+?[\d\s\-().]+$/.test(s)) return s;
  let digits = s.replace(/\D/g, "");
  let intl = s.startsWith("+");
  if (!intl && digits.startsWith("00")) {
    digits = digits.slice(2);
    intl = true;
  }
  if (digits.startsWith("45") && digits.length === 10) return DK(digits.slice(2));
  if (digits.startsWith("351") && digits.length === 12) return PT(digits.slice(3));
  if (intl) return s;
  const c = String(country || "").toUpperCase();
  if (c === "PT") return /^9\d{8}$/.test(digits) ? PT(digits) : s;
  if (c === "DK" || !c) return digits.length === 8 ? DK(digits) : s;
  return s;
}
