/**
 * Landing first paint (push 9, E) — the two questions the app asks before
 * it lets the logged-out landing paint without waiting:
 *
 *   isLandingPath(path)  is this the marketing front door ("/" or "/v2")?
 *   mightBeSignedIn()    could this browser hold a session?
 *
 * mightBeSignedIn reads the bonbox_csrf cookie: the backend sets it beside
 * the HttpOnly session cookie on every login, with the same lifetime and the
 * same Domain=.bonbox.dk scope, and clears it on logout — and it is readable
 * by page scripts on purpose (it is the CSRF double-submit token; see the
 * cookie policy). The native app keeps its token in localStorage ("token").
 * Nothing new is stored: both already exist.
 *
 * When neither is there, the visitor is almost certainly a prospect, so the
 * landing renders at once instead of behind a spinner while /auth/me answers
 * (one CORS preflight + one request: ~1.1 s on a 562 ms-RTT phone). If
 * /auth/me does find a session after all, App.jsx still redirects — the
 * landing simply showed for that moment instead of a spinner.
 */
export const LANDING_PATHS = ["/", "/v2"];

export function isLandingPath(pathname) {
  const p = String(pathname || "").replace(/\/+$/, "") || "/";
  return LANDING_PATHS.includes(p);
}

export function mightBeSignedIn() {
  try {
    if (/(?:^|;\s*)bonbox_csrf=/.test(document.cookie || "")) return true;
  } catch {
    /* cookies blocked: fall through */
  }
  try {
    if (localStorage.getItem("token")) return true;
  } catch {
    /* storage blocked */
  }
  return false;
}

/** True on the landing, for a visitor with no session, in a plain browser. */
export function landingFirstPaint() {
  try {
    if (import.meta.env.VITE_APP_MODE === "scheduler") return false;
    if (typeof window === "undefined") return false;
    if (window.Capacitor?.isNativePlatform?.()) return false;
    return isLandingPath(window.location.pathname) && !mightBeSignedIn();
  } catch {
    return false;
  }
}

/**
 * Speed (10 Nov 2026): when React mounts. `start` renders the app. With no
 * `waits` (null: a session sign, the native shell, any other path, the
 * Vagtplan build) it runs at once, exactly as before. On the landing for a
 * prospect it runs once every promise in `waits` has settled (App.jsx
 * landingBoot: the landing chunk's import, so React's first commit already
 * holds the page) — resolved or rejected alike — or after `capMs`, whichever
 * comes first, and never twice.
 */
export function mountWhenReady(start, waits, capMs, timer = setTimeout) {
  if (!waits) {
    start();
    return;
  }
  let begun = false;
  const once = () => {
    if (begun) return;
    begun = true;
    start();
  };
  Promise.allSettled(waits).then(once, once);
  timer(once, capMs);
}

/**
 * Speed (10 Nov 2026): the landing's first screen drawn by the HTML
 * (vite.config.js landingFirstScreen: #lp6-first inside #root). React's first
 * commit empties #root. holdFirstScreen() keeps a reference to that node right
 * before the mount; App.jsx's landing fallback (KeepFirstScreen) puts it back
 * with takeFirstScreen() when the landing's chunk is late or retrying, so the
 * visitor never looks at a blank page meanwhile. Taken once.
 */
let heldFirstScreen = null;
export function holdFirstScreen() {
  try {
    heldFirstScreen = document.getElementById("lp6-first");
  } catch {
    heldFirstScreen = null;
  }
  return heldFirstScreen;
}
export function takeFirstScreen() {
  const node = heldFirstScreen;
  heldFirstScreen = null;
  return node;
}
