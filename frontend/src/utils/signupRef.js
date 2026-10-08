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
 *     banner's Analytics choice is on. Given later → written then; withdrawn
 *     → removed. Without it, nothing about the code touches the device.
 *   Listed on /cookies and /privacy.
 *
 * Rules:
 *   • Only [a-z0-9-]{1,24} is kept — anything else is ignored, silently.
 *   • First code wins while it is fresh (30 days); a second QR does not
 *     replace it, matching "never overwrite" on the server.
 *   • It is a code, never personal data. Storage failures (private mode,
 *     blocked storage) are swallowed — a lost ref must never cost a signup.
 */
import { getCookieConsent } from "../components/CookieConsent";

const KEY = "bonbox_signup_ref";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REF_RE = /^[a-z0-9-]{1,24}$/;
const CONSENT_EVENT = "bonbox-cookie-consent-changed";

// This page load's code: { ref, at } or null.
let memory = null;

export function cleanSignupRef(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return REF_RE.test(value) ? value : null;
}

function analyticsAllowed() {
  try {
    return !!getCookieConsent()?.analytics;
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
  // Not read without Analytics consent — and a copy from before a
  // withdrawal is dropped.
  if (!analyticsAllowed()) {
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
    const ref = cleanSignupRef(new URLSearchParams(search || "").get("ref"));
    if (!ref) return null;
    if (kept(now)) return null; // first code wins
    memory = { ref, at: now };
    if (analyticsAllowed()) writeStored();
    return ref;
  } catch {
    return null;
  }
}

/**
 * The cookie banner was answered (or re-answered). Analytics on → keep this
 * page load's code for 30 days; off → remove any kept copy from the device.
 */
export function onCookieConsentChanged(choices) {
  if (choices?.analytics) writeStored();
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
