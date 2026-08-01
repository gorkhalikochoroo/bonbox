/**
 * Host-stand device credential — the client half.
 *
 * A paired device holds a long token in its URL (/stand/<token>) instead of an
 * owner session. Rather than fork ReservationsPage into a second data layer,
 * the api client rewrites reservation calls onto the stand's own prefix while a
 * token is active:
 *
 *     /reservations/book                    ->  /stand/<token>/book
 *     /reservations/reservations/{id}/status ->  /stand/<token>/reservations/{id}/status
 *
 * WHY THIS IS SAFE. The rewrite cannot widen what the device can reach. The
 * backend accepts a StandLink on exactly the six operations wrapped in
 * routers/stand_link.py and on nothing else, so any call this shim rewrites to
 * an unwrapped path simply 404s. Scope lives on the server, structurally; this
 * is only plumbing.
 *
 * The Authorization header is dropped on rewritten calls on purpose. A device
 * should never carry both credentials — if an owner session happened to exist
 * in the same browser, sending it would silently give the stand owner-level
 * reach and hide the very failure this design exists to prevent.
 */

const KEY = "bonbox_stand_token";

let _token = null;

/** Adopt a token for this tab (called by the /stand/:token route). */
export function setStandToken(token) {
  _token = token || null;
  try {
    if (_token) sessionStorage.setItem(KEY, _token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private mode — in-memory is enough for the session */
  }
}

/** The active device token, if this tab is a paired stand. */
export function getStandToken() {
  if (_token) return _token;
  try {
    _token = sessionStorage.getItem(KEY);
  } catch {
    _token = null;
  }
  return _token;
}

export function clearStandToken() {
  setStandToken(null);
}

/**
 * Rewrite a reservations URL onto the stand prefix. Returns null when the call
 * is not a reservations call (leave it alone) — never guesses.
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
