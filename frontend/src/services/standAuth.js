/**
 * Host-stand device credential — the client half.
 *
 * A paired device holds a long token in its URL (/stand/<token>) instead of an
 * owner session. Rather than fork ReservationsPage into a second data layer,
 * the api client rewrites reservation calls onto the stand's own prefix while
 * the page is a stand page:
 *
 *     /reservations/book                    ->  /stand/<token>/book
 *     /reservations/reservations/{id}/status ->  /stand/<token>/reservations/{id}/status
 *
 * WHY THIS IS SAFE. The rewrite cannot widen what the device can reach. The
 * backend accepts a StandLink on exactly the operations wrapped in
 * routers/stand_link.py and on nothing else, so any call this shim rewrites to
 * an unwrapped path simply 404s. Scope lives on the server, structurally; this
 * is only plumbing.
 *
 * The Authorization header is dropped on rewritten calls on purpose. A device
 * should never carry both credentials — if an owner session happened to exist
 * in the same browser, sending it would silently give the stand owner-level
 * reach and hide the very failure this design exists to prevent.
 *
 * R10 — THE ADDRESS BAR IS THE CREDENTIAL'S ONLY SOURCE. The token used to be
 * adopted by StandTokenRoute during its render and cached in sessionStorage.
 * Two things went wrong with that:
 *   • A COLD START landed on the owner login, 13 times out of 13. The app
 *     holds every route behind FullDictionaryGate while the dictionary loads,
 *     so StandTokenRoute had not rendered yet when the live-alert poll (which
 *     sits above the routes) sent its first request. That request went out as
 *     the owner's /reservations/changes with no session, got a 401, and the
 *     401 handler sent the door iPad to /login.
 *   • The cached token OUTLIVED the stand. In a tab that left /stand/<token>
 *     ("Log ud", then an owner signing in), every owner reservation call was
 *     still rewritten onto the stand prefix.
 * Reading the token from window.location at the moment of each request fixes
 * both: it is true from the very first request, and a tab that leaves the
 * stand stops being one.
 *
 * REMEMBERING THE PAIRING. Separately, the device remembers the last link that
 * opened a book (localStorage), so /stand — the pairing page, and the start
 * page of the installed stand app — reopens tonight's book after a restart
 * instead of asking for a code again. It is only a bookmark: nothing sends a
 * request with it unless the device is on /stand/<that token>.
 */

const REMEMBER_KEY = "bonbox_stand_device";
// The pre-R10 tab cache. Never read any more; cleared when seen so a token
// does not linger on a shared device.
const LEGACY_KEY = "bonbox_stand_token";

/**
 * The token in a /stand/<token> path, raw (undecoded) — the api client
 * rebuilds the same path from it, and re-encoding a decoded segment is how a
 * token silently stops matching. null for every other path, including /stand
 * itself (the pairing page) and the owner's pop-out at /reservations/stand.
 */
export function standTokenFromPath(pathname) {
  const m = /^\/stand\/([^/?#]+)/.exec(typeof pathname === "string" ? pathname : "");
  return m ? m[1] : null;
}

/** The active device token: this page's, if this page is a paired stand. */
export function getStandToken() {
  try {
    return standTokenFromPath(window.location.pathname);
  } catch {
    return null;
  }
}

/** The pairing this device remembers (see above), or null. */
export function rememberedStandToken() {
  try {
    const v = localStorage.getItem(REMEMBER_KEY);
    return v && /^[A-Za-z0-9_-]{8,128}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Remember (or, with a falsy token, forget) the pairing on this device.
 * Called once a link has proved itself: a redeemed code, or a book that
 * actually loaded through it.
 */
export function setStandToken(token) {
  try {
    sessionStorage.removeItem(LEGACY_KEY);
  } catch {
    /* private mode */
  }
  try {
    if (token) {
      if (localStorage.getItem(REMEMBER_KEY) !== token) localStorage.setItem(REMEMBER_KEY, token);
    } else {
      localStorage.removeItem(REMEMBER_KEY);
    }
  } catch {
    /* private mode — the URL still carries the link */
  }
}

/** Forget the pairing ("Afbryd denne skærm", "Forbind med en ny kode"). */
export function clearStandToken() {
  setStandToken(null);
}

/**
 * Rewrite a reservations URL onto the stand prefix. Returns null when the call
 * is not a reservations call, or this page is not a paired stand (leave it
 * alone) — never guesses.
 */
export function standRewrite(url) {
  const token = getStandToken();
  if (!token || typeof url !== "string") return null;
  if (!url.startsWith("/reservations")) return null;
  // "/reservations/reservations/{id}/status" -> "/reservations/{id}/status"
  // "/reservations/book"                     -> "/book"
  const tail = url.slice("/reservations".length);
  return `/stand/${token}${tail}`;
}
