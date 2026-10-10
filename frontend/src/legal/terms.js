/* The Terms of Service version — ONE place.

   TermsPage shows it as "Sidst opdateret" / "Last updated"; the backend
   stamps the same value on a new account that accepted the Terms
   (backend/app/services/terms.py TERMS_VERSION). backend
   tests/test_terms_acceptance.py fails if the two ever differ, so change
   both — and the Terms text — in one commit. */
export const TERMS_VERSION = "2026-10-10";

/** Add accept_terms: true to a sign-up request body — only when the caller
    says the page showed the acceptance line (opts.acceptTerms === true).
    Anything else returns the body untouched, so the server records nothing. */
export function withTermsAcceptance(body, opts) {
  return opts && opts.acceptTerms === true ? { ...body, accept_terms: true } : body;
}

// "2026-10-10" → "10. oktober 2026" / "10 October 2026" — the Terms page's
// "Sidst opdateret" / "Last updated" line.
const DA_MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function termsDate(version, lang) {
  const [y, m, d] = String(version).split("-").map(Number);
  if (!y || !m || !d) return String(version);
  return lang === "da" ? `${d}. ${DA_MONTHS[m - 1]} ${y}` : `${d} ${EN_MONTHS[m - 1]} ${y}`;
}
