/**
 * "Spring over for nu" on the e-mail verification wall — remembered for 7 days.
 *
 * It lived in sessionStorage only, so the wall came back on every new session:
 * the owner who skipped it on Monday met it again on Tuesday morning, on their
 * own phone, between them and the day's close. Now the skip is kept per
 * account in localStorage with an expiry (7 days); after that the wall asks
 * once more and can be skipped again. A quiet "Bekræft din e-mail" reminder
 * (VerifyEmailReminder) stays visible while the skip is active.
 *
 * The old session flag ("skip_email_verify") is still read and still written:
 * the native signup sets it, and a tab that skipped before this change keeps
 * its skip. It now names the account it is for (release gate R-b, 9 Oct: a
 * plain "1" skipped the wall for EVERY account signing in in that tab, also
 * after "Log ud"), and logout removes it (forgetSessionVerifySkip). A bare
 * "1" — an older build, or no account id known — is still honoured.
 *
 * Every storage access is wrapped: private mode / blocked storage must never
 * throw into a route guard. Without storage the skip simply lasts as long as
 * the session flag does — the old behaviour.
 */

import { verifyWallSkipsRole } from "./verifyWallRole";

export const VERIFY_SKIP_DAYS = 7;
export const VERIFY_SKIP_MS = VERIFY_SKIP_DAYS * 24 * 60 * 60 * 1000;
const SESSION_FLAG = "skip_email_verify";
const KEY_PREFIX = "bonbox_verify_skip_until";

function keyFor(userId) {
  return userId ? `${KEY_PREFIX}:${userId}` : KEY_PREFIX;
}

/** Remember "skip for now" for this account for 7 days from `now`. */
export function rememberVerifySkip(userId, now = Date.now()) {
  const forWhom = userId != null && String(userId) !== "" ? String(userId) : "1";
  try { sessionStorage.setItem(SESSION_FLAG, forWhom); } catch { /* storage blocked */ }
  try { localStorage.setItem(keyFor(userId), String(now + VERIFY_SKIP_MS)); } catch { /* storage blocked */ }
}

/** Is a skip in force for this account right now? */
export function verifySkipActive(userId, now = Date.now()) {
  try {
    const flag = sessionStorage.getItem(SESSION_FLAG);
    // This account's, or a bare "1" (older build / no id known).
    if (flag && (flag === "1" || (userId != null && flag === String(userId)))) return true;
  } catch { /* storage blocked */ }
  try {
    const until = parseInt(localStorage.getItem(keyFor(userId)) || "0", 10);
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

/** The account is verified (or the owner wants the wall back): forget it. */
export function clearVerifySkip(userId) {
  try { sessionStorage.removeItem(SESSION_FLAG); } catch { /* storage blocked */ }
  try { localStorage.removeItem(keyFor(userId)); } catch { /* storage blocked */ }
}

/** "Log ud": the tab's skip is not handed to the next account that signs in
 *  on this device. (Each account's own 7-day skip stays with it.) */
export function forgetSessionVerifySkip() {
  try { sessionStorage.removeItem(SESSION_FLAG); } catch { /* storage blocked */ }
}

/**
 * The routes the wall never takes the owner away from. The day's close is
 * the one job that must always be reachable: an expired skip re-rendering the
 * route guard mid-close would otherwise throw the typed numbers away.
 */
export function verifyWallExempt(pathname) {
  const p = String(pathname || "");
  return p === "/daily-close" || p.startsWith("/daily-close/");
}

/**
 * Where a fresh sign-in lands (LoginPage: password, Google, Apple). The
 * verify wall only for an unconfirmed owner created after the grace date who
 * has NOT tapped "Spring over for nu" in the last 7 days — the rule
 * ProtectedRoute applies. The login used to skip the skip check, so a skipped
 * owner met the wall again on every sign-in and VerifyEmailRoute mailed them
 * a fresh code each time (review, 8 Oct). Purposeful arrivals (Profile,
 * "Bekræft nu", the ?now=1 reminder) still reach /verify-email directly.
 */
export const VERIFICATION_GRACE_DATE = "2026-04-13T00:00:00";

// A revisor login is never sent to the verification wall — the rule lives in
// utils/verifyWallRole (production's home for it); re-exported here so the
// 7-day skip's callers keep one import.
export { verifyWallSkipsRole };

export function postLoginPath(user, now = Date.now()) {
  if (
    user &&
    !verifyWallSkipsRole(user) &&
    !user.email_verified &&
    user.created_at &&
    new Date(user.created_at) >= new Date(VERIFICATION_GRACE_DATE) &&
    !verifySkipActive(user.id, now)
  ) {
    return "/verify-email";
  }
  return "/dashboard";
}
