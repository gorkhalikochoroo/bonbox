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

/* Push-day placeholder for PRIVACY_UPDATED (Landing v6 + Frankfurt release,
   22 Oct 2026). A valid ISO day so the pages and the date rules keep working
   before the push, and one nobody would take for a real date ("31. december
   2099" on the page). The release packet replaces PRIVACY_UPDATED's value
   with the Copenhagen push day; src/__tests__/privacyUpdatedPushDay.test.js
   fails until it has. */
export const PRIVACY_PUSH_DAY_PLACEHOLDER = "2099-12-31";

/* The "Last updated" date of BOTH /privacy AND /cookies — PrivacyPolicyPage
   and CookiePolicyPage each print this one constant, so the two pages never
   disagree on when. Push 3 changed /privacy together with the Terms (the
   page then showed TERMS_VERSION). The ops/privacy bundle (backup + R-i + R-h
   + R-sec) changes /privacy on its own — a new processor row (the encrypted
   backup copy in Frankfurt) and the R-h sentences that browser usage events
   need a yes to Analytics — and /cookies' analytics text in the same release,
   so the two pages carry their own date and the Terms date and notice stay
   untouched. Any other /privacy or /cookies change that ships in the same
   push (release-brand's clock-in location sentence, the last-seen and
   analytics-pause wording) goes live under this date too.

   !!! RELEASE-TIME, PROVISIONAL — SET IT TO THE DEPLOY DAY: the Copenhagen
   day on which the FRONTEND bundle that carries these /privacy and /cookies
   changes is verified live on www.bonbox.dk. "2026-10-11" is only a
   placeholder: the push that ships this bundle (combined with release-brand
   and the sign-up redesign, per the 11 Oct release order) has no deploy day
   yet. Set it to that day on the integrated tip, in the same push — it dates
   both pages at once. Never earlier than TERMS_VERSION
   (src/__tests__/push3Privacy.test.jsx checks), and both pages must print
   this constant, not TERMS_VERSION or a hard-coded date
   (src/__tests__/privacyDateMergeGuard.test.jsx).

   Landing v6 + Frankfurt (22 Oct 2026): /privacy changes again — the main
   Supabase row moves to Frankfurt and, while it exists, the old project's
   fallback copy gets its own row (IRELAND_COPY_ROW below). The value is the
   placeholder until the packet step on push day; it was "2026-10-12". */
export const PRIVACY_UPDATED = "2026-10-28";

/* The fallback copy in the old Supabase project (database and files moved to
   Frankfurt on 20 Oct 2026; the old project is kept unchanged as a fallback
   until Manoj says delete, around 27 Oct). While it exists, /privacy lists it
   as its own processor row, the only place either language names its
   location; IRELAND_COPY_DELETE_BY is the "deleted by" day that row promises.

   !!! RELEASE-TIME: right before the push, check the Supabase project list.
   Old project still there → true. Deleted → false: the row disappears from
   /privacy in both languages (src/__tests__/frankfurtEverywhere.test.js and
   backupPrivacyRow / push3Privacy hold both cases); re-run those tests and
   rebuild the Vagtplan bundle (npm run build:scheduler-app). */
export const IRELAND_COPY_ROW = true;
/* 23 Oct 2026: moved from 2026-10-31. Receipt pictures uploaded before the move
   are still loaded from the old project through stored links, so it is deleted
   only after a backend release re-links them to Frankfurt and a check shows no
   row still points at the old project. */
export const IRELAND_COPY_DELETE_BY = "2026-11-30";

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
