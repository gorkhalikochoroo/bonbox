/* ═══════════════════════════════════════════════════════════════════════
   !!! RELEASE-TIME DATES — PROVISIONAL — SET BOTH ON THE DAY R-e SHIPS !!!

   TERMS_VERSION       = the deploy day (below).
   TERMS_EXISTING_FROM = the deploy day + 15 days.

   "Deploy day" = the Copenhagen day on which the FRONTEND bundle with the
   notice is verified live on www.bonbox.dk (check the served bundle's
   content, not only the push), with the backend already live. The notice is
   this frontend's code (Vercel), so the notice period starts when the
   frontend is live, not when the backend (Render) is. If the frontend goes
   live on a later day than these dates assume, move BOTH dates (here and in
   backend/app/services/terms.py) before that push. If it is verified live
   only on a later day than the dates in the files (late push, slow build,
   stale bundle), move both dates to that day and push again (backend first)
   the same day.

   The values below (11 Oct / 26 Oct 2026) are set for a deploy on Sunday
   11 Oct 2026 (moved up from 14 Oct on Manoj's request, 11 Oct: no paying
   customers yet). They are only true if the R-e frontend is verified live on
   www.bonbox.dk on 11 Oct 2026 (Copenhagen time).

   These two lines and the two in backend/app/services/terms.py are the ONLY
   places the dates live; the Terms page, the in-app notice and the tests
   read them from here. backend tests/test_terms_notice.py fails if the two
   files differ; src/__tests__/reTermsTransition.test.jsx fails if the gap is
   under 15 days. Gate line in bonbox-lab-state/releases.md ("R-e at push").

   Why +15 and not +14: the live 13 May Terms §14 promise notice "mindst 14
   dage, før ændringerne træder i kraft". The notice can only appear once the
   frontend is live, part-way through the deploy day, and the Terms apply from
   00:00 Copenhagen on TERMS_EXISTING_FROM.
   ═══════════════════════════════════════════════════════════════════════ */

/* The Terms of Service version. TermsPage shows it as "Sidst opdateret" /
   "Last updated"; the backend stamps the same value on an account that
   accepts the Terms. Change it — and the Terms text — in one commit. It is
   also the date the Terms apply to NEW accounts from. */
export const TERMS_VERSION = "2026-10-11";

/* The date these Terms apply to EXISTING accounts from (Manoj, 10 Oct 2026):
   every account without an acceptance of TERMS_VERSION. The Terms page
   prints both dates; the in-app notice (components/TermsUpdateNotice) runs
   until 00:00 Copenhagen on this one. */
export const TERMS_EXISTING_FROM = "2026-10-26";

/* /privacy's own "Last updated" date. Push 3 changed /privacy together with
   the Terms (the page then showed TERMS_VERSION). The nightly-backup release
   changes /privacy on its own (a new processor row: the encrypted backup
   copy in Frankfurt), so the page carries its own date and the Terms date
   and notice stay untouched.

   !!! RELEASE-TIME, PROVISIONAL: the Copenhagen day on which the FRONTEND
   bundle with the backup row is verified live on www.bonbox.dk. "2026-10-15"
   is the planned backup push (plan_to_90, Thu 15 Oct). If it goes live on
   another day, move this date to that day in the same push. Never earlier
   than TERMS_VERSION (src/__tests__/push3Privacy.test.jsx checks). If the
   backup row ships in the same release as push 3, set it to TERMS_VERSION. */
export const PRIVACY_UPDATED = "2026-10-15";

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
