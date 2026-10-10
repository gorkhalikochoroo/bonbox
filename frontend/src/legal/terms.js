/* The Terms of Service version — ONE place.

   TermsPage shows it as "Sidst opdateret" / "Last updated"; the backend
   stamps the same value on a new account that accepted the Terms
   (backend/app/services/terms.py TERMS_VERSION). backend
   tests/test_terms_acceptance.py fails if the two ever differ, so change
   both — and the Terms text — in one commit. */
export const TERMS_VERSION = "2026-10-10";

/* The date these Terms apply to EXISTING accounts from (Manoj, 10 Oct 2026):
   TERMS_VERSION + 14 days — the notice the 13 May Terms §14 promise. New
   accounts accept them at once (from TERMS_VERSION). Same value as
   backend/app/services/terms.py TERMS_EXISTING_FROM (a backend test fails if
   they differ). The Terms page prints both dates; the in-app notice
   (components/TermsUpdateNotice) runs until this one. */
export const TERMS_EXISTING_FROM = "2026-10-24";

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

/** 00:00 Copenhagen time on an ISO day ("2026-10-24"), in epoch ms — the
    moment the Terms apply to existing accounts, so the notice ends at the
    same instant as the server's (services/terms.py dk_midnight_utc). */
export function copenhagenMidnightMs(isoDay) {
  const [y, m, d] = String(isoDay).split("-").map(Number);
  if (!y || !m || !d) return NaN;
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Copenhagen", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(guess));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    return guess - (wall - guess);
  } catch {
    // No time-zone data: Danish summer time is the safe side (ends 1 h early).
    return guess - 2 * 3600 * 1000;
  }
}

/** Is the in-app notice of these Terms still running at `now`? */
export function termsNoticeWindowOpen(now = Date.now()) {
  return now < copenhagenMidnightMs(TERMS_EXISTING_FROM);
}
