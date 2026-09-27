// ── Venue monogram ─────────────────────────────────────────────────
// Fallback venue identity on the public booking page when the owner hasn't
// uploaded a brand logo: a 1–2 letter monogram from the venue's name —
// first letters of the first two words, else the first two letters.
// Upper-cased, diacritics kept (Café → C). Letters and digits only:
// "Testcafé (lokal)" is TL, not "T(". Plain text — JSX escapes it.
export function venueMonogram(name) {
  const clean = String(name || "").trim();
  if (!clean) return "·";
  const words = clean
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return clean.slice(0, 1).toUpperCase();
}
