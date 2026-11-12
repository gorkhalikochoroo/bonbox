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

/**
 * Landing speed, step 4 (10 Nov 2026): can this browser hold a session at
 * all? On www.bonbox.dk (and every *.bonbox.dk page) talking to
 * api.bonbox.dk, the page sees the bonbox_csrf cookie the backend sets beside
 * the HttpOnly session cookie (same Domain=.bonbox.dk, same lifetime,
 * re-issued together). No such cookie, no stored token and not the native
 * shell = no session: GET /auth/me could only answer 401, which Chrome prints
 * in red on every logged-out visit (and on a desktop the landing's first text
 * waited for it). hooks/useAuth.jsx then does not ask. On any other host or
 * API (a preview, a dev machine, another API host) the cookie says nothing,
 * so the check stays exactly as before.
 * VITE_BENCH_COOKIE_HOST: a build-time flag for the LOCAL speed bench only (it
 * serves the build on localhost); production never sets it
 * (landingSpeedAuthProbe.test.jsx reads .env.production).
 */
export function sessionCookieVisibleHere(hostname, apiBase) {
  try {
    const h = String(hostname || "");
    const bench = import.meta.env.VITE_BENCH_COOKIE_HOST || "";
    const pageOk = h === "bonbox.dk" || h.endsWith(".bonbox.dk") || (!!bench && h === bench);
    if (!pageOk) return false;
    return new URL(String(apiBase || ""), `https://${h}/`).hostname === "api.bonbox.dk";
  } catch {
    return false;
  }
}

export function cannotHoldASession(apiBase) {
  try {
    if (window.Capacitor?.isNativePlatform?.()) return false;
    return sessionCookieVisibleHere(window.location.hostname, apiBase) && !mightBeSignedIn();
  } catch {
    return false;
  }
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
let heldFocus = null;
export function holdFirstScreen() {
  heldFocus = null;
  try {
    heldFirstScreen = document.getElementById("lp6-first");
    // keyboard focus on one of its controls right now: moved to the same control of the real page (replayFirstScreen)
    const f = window.__lp6First;
    if (heldFirstScreen && f && f.focus && heldFirstScreen.contains(document.activeElement)) heldFocus = f.focus;
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

/**
 * Speed (10 Nov 2026): between the first screen the HTML drew and the app's
 * takeover, the flags, "Priser", "Se priser", the headline words and the logo
 * are plain HTML and do nothing. The head script (scripts/landingFirstScreen.mjs)
 * remembers the last tap or key on one of them (window.__lp6First.tap) and the
 * control that had keyboard focus; once the real landing is mounted (App.jsx
 * FirstScreenHandover) the same control there is clicked and focused.
 * A control is { r: "top" | "hero", s: selector, i: index }; only the
 * selectors the first screen can produce are accepted.
 */
// v7 (12 Nov 2026): its first screen's language button and its in-page links (the wordmark, the section links, "Se en dag
// i restauranten") are replayable too; "Prøv gratis" and "Log ind" stay real links.
const REPLAYABLE = /^(?:button\[lang="(?:da|en)"\]|button\.lang-btn|a\[href="#(?:main|pricing|s1|s2|s6|top|dag|vagterne|bordene|kassen|tilvalg|priser)"\])$/;
export function controlIn(root, c) {
  if (!root || !c || (c.r !== "top" && c.r !== "hero") || !REPLAYABLE.test(String(c.s)) || !(c.i >= 0)) return null;
  const region = root.querySelector("." + c.r);
  return (region && region.querySelectorAll(c.s)[c.i]) || null;
}
export function replayFirstScreen(root) {
  let f = null;
  try {
    f = window.__lp6First;
  } catch {
    f = null;
  }
  const tap = f && f.tap;
  const focus = heldFocus;
  heldFocus = null;
  if (f) {
    f.tap = null;
    f.focus = null;
  }
  try {
    const t = controlIn(root, tap);
    if (t) t.click();
    const k = controlIn(root, focus);
    if (k && typeof k.focus === "function") k.focus({ preventScroll: true });
  } catch {
    /* a replay is a courtesy: never let it break the page */
  }
}
