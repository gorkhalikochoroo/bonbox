/**
 * Signup ref — the printed door-visit code from a leave-behind QR.
 *
 * The QR opens https://www.bonbox.dk/register?ref=r1-a-03 (round 1,
 * argument A, visit 3). The owner may not sign up on that screen: they can
 * tap Google or Apple, wander to /login, close the tab and come back in the
 * evening. So the code is kept in this browser until an account exists and is
 * then sent ONCE with the register call or the Google/Apple completion. The
 * backend stores it only on a brand-new account and never overwrites one
 * (backend/app/services/signup_ref.py).
 *
 * Rules:
 *   • Only [a-z0-9-]{1,24} is kept — anything else is ignored, silently.
 *   • First code wins while it is fresh (30 days); a second QR does not
 *     replace it, matching "never overwrite" on the server.
 *   • It is a code, never personal data. Storage failures (private mode,
 *     blocked storage) are swallowed — a lost ref must never cost a signup.
 */

const KEY = "bonbox_signup_ref";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REF_RE = /^[a-z0-9-]{1,24}$/;

export function cleanSignupRef(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return REF_RE.test(value) ? value : null;
}

function readStored(now = Date.now()) {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ref = cleanSignupRef(parsed?.ref);
    const at = Number(parsed?.at);
    if (!ref || !Number.isFinite(at) || now - at > TTL_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return ref;
  } catch {
    return null;
  }
}

/** Keep the ?ref= code from the current URL, if it is valid and none is kept. */
export function captureSignupRef(search = typeof window !== "undefined" ? window.location.search : "", now = Date.now()) {
  try {
    const ref = cleanSignupRef(new URLSearchParams(search || "").get("ref"));
    if (!ref) return null;
    if (readStored(now)) return null; // first code wins
    localStorage.setItem(KEY, JSON.stringify({ ref, at: now }));
    return ref;
  } catch {
    return null;
  }
}

/** The kept code, or null. */
export function getSignupRef(now = Date.now()) {
  return readStored(now);
}

/** Forget the code once an account has been created or signed in. */
export function clearSignupRef() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

/** `body` plus `signup_ref` when a code is kept; `body` unchanged otherwise. */
export function withSignupRef(body) {
  const ref = getSignupRef();
  return ref ? { ...body, signup_ref: ref } : body;
}
