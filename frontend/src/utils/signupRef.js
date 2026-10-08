/**
 * Signup ref — the printed door-visit code from a leave-behind QR.
 *
 * The QR opens https://www.bonbox.dk/register?ref=r1-a-03 (round 1,
 * argument A, visit 3). The owner may not sign up on that screen: they can
 * tap Google or Apple, wander to /login, ask for an e-mail link. So the code
 * is kept until an account exists and is then sent ONCE with the register
 * call, the Google/Apple completion or the e-mail-link sign-in. The backend
 * stores it only on a brand-new account and never overwrites one
 * (backend/app/services/signup_ref.py).
 *
 * WHERE IT IS KEPT — consent first (ePrivacy Art. 5(3), cookiebekendtgørelsen
 * covers local storage too, and campaign attribution is not strictly
 * necessary):
 *   • Always in memory for this page load. That covers signing up on the
 *     same tab, Google/Apple (popups), /register → /login (router links) and
 *     the e-mail link, which carries the code in its own URL (the backend
 *     adds &ref= to the link it mails).
 *   • In local storage (bonbox_signup_ref, 30 days) ONLY while the cookie
 *     banner's Marketing choice is on — counting which printed flyer brought
 *     an account is channel measurement, which is what that category says it
 *     is for; Analytics is the in-app usage log. Given later → written then;
 *     withdrawn → removed. Without it, nothing about the code touches the
 *     device.
 *   • A Marketing "yes" counts only when it was given on or after
 *     FLYER_TEXT_SINCE, the day the banner first named the flyer code. An
 *     older "yes" was given to a text that did not mention it, so the code
 *     stays in memory until the visitor answers the banner again. (Bumping
 *     the banner's VERSION instead would also forget every Analytics "no",
 *     and the usage log only stops on an explicit "no".)
 *   • Every page load first drops a copy that is past 30 days or held
 *     without consent, so "up to 30 days" is a deletion, not just a value
 *     that is ignored.
 *   Listed on /cookies and /privacy (which also say the e-mail sign-in link
 *   carries the code).
 *
 * Rules:
 *   • Only a fieldwork code is kept: r<round>-<argument>-<visit> ("r1-a-03"),
 *     the same pattern as _FIELDWORK_RE in backend/app/services/signup_ref.py,
 *     or a QR test code "test-NN" (the backend accepts it and rolls it up
 *     under "other", so it never counts as a door visit). Anything else —
 *     a directory's or newsletter's ?ref=site — is ignored, silently: not
 *     kept, not stored, not sent. (The backend's own rule stays the wider
 *     [a-z0-9-]{1,24}; every code allowed here passes it.)
 *   • First code wins while it is fresh (30 days); a second QR does not
 *     replace it, matching "never overwrite" on the server.
 *   • A short code, not a name or e-mail — but once stored on an account it
 *     is pseudonymous personal data about that account; never return it next
 *     to an account outside the user's own export. Storage failures (private
 *     mode, blocked storage) are swallowed — a lost ref must never cost a
 *     signup.
 */
import { getCookieConsent, getCookieConsentTime } from "../components/CookieConsent";

const KEY = "bonbox_signup_ref";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
// r1-a-03 (round 1–99, argument a–z, visit 1–999) — mirrors the backend's
// _FIELDWORK_RE — or test-01 … test-99 for checking a QR end to end.
const REF_RE = /^(?:r\d{1,2}-[a-z]-\d{1,3}|test-\d{2})$/;
const CONSENT_EVENT = "bonbox-cookie-consent-changed";
// 8 Oct 2026, Copenhagen: the banner's Marketing text names the flyer code
// from this release on. See the header.
export const FLYER_TEXT_SINCE = Date.parse("2026-10-08T00:00:00+02:00");

// This page load's code: { ref, at } or null.
let memory = null;

export function cleanSignupRef(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return REF_RE.test(value) ? value : null;
}

/** Marketing consent, given to the text that names the flyer code. */
function storageAllowed() {
  try {
    if (!getCookieConsent()?.marketing) return false;
    const at = getCookieConsentTime();
    return at !== null && at >= FLYER_TEXT_SINCE;
  } catch {
    return false;
  }
}

function removeStored() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

function writeStored() {
  if (!memory) return;
  try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* storage blocked */ }
}

function readStored(now) {
  // Not read without Marketing consent — and a copy from before a
  // withdrawal is dropped.
  if (!storageAllowed()) {
    removeStored();
    return null;
  }
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ref = cleanSignupRef(parsed?.ref);
    const at = Number(parsed?.at);
    if (!ref || !Number.isFinite(at) || now - at > TTL_MS) {
      removeStored();
      return null;
    }
    return ref;
  } catch {
    return null;
  }
}

function kept(now) {
  if (memory) {
    if (now - memory.at <= TTL_MS) return memory.ref;
    memory = null;
  }
  return readStored(now);
}

/** Keep the ?ref= code from the current URL, if it is valid and none is kept. */
export function captureSignupRef(search = typeof window !== "undefined" ? window.location.search : "", now = Date.now()) {
  try {
    // Runs on every page load (main.jsx): drop a copy past 30 days or held
    // without consent, whether or not this URL carries a code.
    const already = kept(now);
    const ref = cleanSignupRef(new URLSearchParams(search || "").get("ref"));
    if (!ref) return null;
    if (already) return null; // first code wins
    memory = { ref, at: now };
    if (storageAllowed()) writeStored();
    return ref;
  } catch {
    return null;
  }
}

/**
 * The cookie banner was answered (or re-answered). Marketing on → keep this
 * page load's code for 30 days; off → remove any kept copy from the device.
 */
export function onCookieConsentChanged(choices) {
  if (choices?.marketing) writeStored();
  else removeStored();
}

/** Follow the banner's answers for the rest of this page load. Never throws. */
export function watchCookieConsentForSignupRef() {
  try {
    window.addEventListener(CONSENT_EVENT, (e) => onCookieConsentChanged(e?.detail));
  } catch { /* hardened browsers — memory-only it is */ }
}

/** The kept code, or null. */
export function getSignupRef(now = Date.now()) {
  return kept(now);
}

/** Forget the code once an account has been created or signed in. */
export function clearSignupRef() {
  memory = null;
  removeStored();
}

/** `body` plus `signup_ref` when a code is kept; `body` unchanged otherwise. */
export function withSignupRef(body) {
  const ref = getSignupRef();
  return ref ? { ...body, signup_ref: ref } : body;
}
