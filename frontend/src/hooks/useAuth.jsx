import { createContext, useContext, useState, useEffect } from "react";
import api from "../services/api";
import { trackEvent } from "./useEventLog";
import { clearStoredMode } from "../lib/appMode";
import { withSignupRef, clearSignupRef } from "../utils/signupRef";
import { withTermsAcceptance } from "../legal/terms";
import { verifyWallSkipsRole } from "../utils/verifyWallRole";
import { forgetSessionVerifySkip } from "../utils/verifySkip";
import { setQueueAccount } from "../utils/dailyCloseQueue";
import { accountKeyFor, setCacheAccount } from "../lib/swrCache";
import { isQuietEmbed } from "../lib/embedMode";

const AuthContext = createContext(null);

/**
 * Detect the browser's IANA timezone — silently push to the server if it
 * differs from what we have stored. Fail-quietly: a wrong / missing TZ
 * isn't worth blocking auth flows.
 */
function syncTimezoneIfChanged(currentUserTz) {
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserTz && browserTz !== currentUserTz) {
      api.patch("/auth/profile", { timezone: browserTz }).catch(() => {});
    }
  } catch {
    // Some old browsers don't expose Intl.DateTimeFormat — skip
  }
}

// Web sessions ride on the HttpOnly bonbox_session cookie set by the backend
// on /auth/login. Persisting the JWT in localStorage on web is what lets XSS
// steal sessions — so we don't. Native (Capacitor iOS) still uses localStorage
// because the cross-site cookie isn't reliable inside WKWebView under Safari
// ITP; the JWT there sits in an app-sandboxed WebView that other origins can't
// read anyway.
function isNativeShell() {
  try { return !!window.Capacitor?.isNativePlatform?.(); } catch { return false; }
}

// ── Start-up (D, speed push) ────────────────────────────────────────────
// index.html may have started GET /auth/me at parse time (window.__bbBootMe:
// { url, promise }). Used once, and only when it is the very request the
// provider would send now: web (a native shell authenticates with a bearer
// the boot probe does not carry — taking its 401 would sign the phone out),
// no stored bearer, the same URL.
function bootProbe(native, legacyToken) {
  try {
    if (native || legacyToken || typeof window === "undefined") return null;
    const boot = window.__bbBootMe;
    window.__bbBootMe = null;
    if (!boot || !boot.promise || typeof boot.promise.then !== "function") return null;
    const base = String(api.defaults?.baseURL || "").replace(/\/+$/, "");
    if (!base || boot.url !== `${base}/auth/me`) return null;
    return boot.promise;
  } catch {
    return null;
  }
}

// "This browser had a signed-in owner last time" — lets App.jsx fetch the
// app shell and Home's code alongside the session check on the next start,
// instead of after it. A hint, not a credential: it unlocks nothing, and it is
// cleared on sign-out and whenever the session check fails.
const HAD_SESSION_KEY = "bb_had_session";
function markHadSession(on) {
  try {
    if (on) localStorage.setItem(HAD_SESSION_KEY, "1");
    else localStorage.removeItem(HAD_SESSION_KEY);
  } catch { /* storage blocked — the hint is only a head start */ }
}

// Grace date: users created before this date are not forced to verify email
const VERIFICATION_GRACE_DATE = "2026-04-13T00:00:00";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // Booking R4: the booking frame on a restaurant's own website makes no
  // session check (below), so it is never "loading" one.
  const [loading, setLoading] = useState(() => !isQuietEmbed());

  // Home's in-memory copy of the figures belongs to ONE account
  // (lib/swrCache): a different signed-in user — or none — empties it first.
  // Said HERE, during this provider's render, not in an effect: a page that
  // mounts in the same render as a new user (it renders after this line,
  // before any effect runs) must already find the copy emptied.
  // Idempotent: the same key twice changes nothing.
  const cacheKey = accountKeyFor(user);
  const signedIn = !!user;
  setCacheAccount(cacheKey);
  // A sign-in by any route (password, Google, Apple, magic link) leaves the
  // start-up hint for next time; sign-out and a failed check clear it.
  useEffect(() => { if (signedIn) markHadSession(true); }, [signedIn]);

  useEffect(() => {
    const native = isNativeShell();
    const legacyToken = localStorage.getItem("token");
    // Web: always probe /auth/me — the HttpOnly cookie may authenticate us
    //   even when no localStorage token is present (post-migration users).
    // Native: only probe when there's a stored bearer token, since the
    //   cross-site cookie isn't available inside the WebView.
    if (native && !legacyToken) {
      setLoading(false);
      return;
    }
    // Booking R4: the booking form inside a restaurant's own website
    // (/r/<slug>?embed=1) has no session to find. The check answered 401 —
    // a red error in the restaurant's own console — and where a cookie did
    // ride along (the owner's preview) it woke the owner app inside a
    // guest's form. No check, no state touched: the start-up hint for the
    // owner's own app is neither set nor cleared from here. (`loading`
    // started false for it.)
    if (isQuietEmbed()) return;
    // Bootstrap auth probe — must NOT block the landing page when the
    // backend is cold (Render free dyno spin-up).  Without `_noRetry`
    // the axios retry interceptor would backoff for 26s on 503, leaving
    // every first-of-day visitor staring at "Loading..." while the
    // marketing copy stays hidden behind a spinner.  Treat 503 the
    // same as 401: "we don't know who you are yet — show the landing
    // and let the user act".
    //
    // D (speed push): on the web, index.html starts this same probe while the
    // page is still parsing — before the app bundle has even downloaded —
    // and leaves it on window.__bbBootMe. Take it over when it is exactly the
    // request this line would send: web, no bearer token (the boot probe
    // carries the cookie only), and the same URL. Anything else probes here
    // as before. Either way the answer is handled by the lines below.
    (bootProbe(native, legacyToken) || api.get("/auth/me", { _noRetry: true }))
      .then((res) => {
        setUser(res.data);
        markHadSession(true);
        // One-time migration: once cookie auth is confirmed working on web,
        // drop the legacy bearer token so XSS can't read it.
        if (!native && legacyToken) {
          try { localStorage.removeItem("token"); } catch {}
        }
      })
      .catch(() => {
        // 401 / 503 / network error — all mean "render the landing now".
        // Stale localStorage token (if any) gets cleared so we don't
        // keep retrying with bad credentials on the next route.
        try { localStorage.removeItem("token"); } catch {}
        markHadSession(false);
      })
      .finally(() => setLoading(false));
  }, []);

  // After a successful login/register/google response, decide where to keep
  // the JWT. Backend always sets the HttpOnly cookie, so on web we keep the
  // bearer out of JS reach entirely. Native still stores it because Capacitor
  // doesn't get the cross-site cookie.
  const persistTokenIfNeeded = (jwt) => {
    if (isNativeShell()) {
      localStorage.setItem("token", jwt);
    } else {
      try { localStorage.removeItem("token"); } catch {}
    }
  };

  const login = async (email, password) => {
    const res = await api.post("/auth/login", { email, password });
    // An existing account signed in — a kept door-visit code is not theirs
    // to carry to a later signup in this browser.
    clearSignupRef();
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("login_success", "login", "password"); } catch {}
    return res.data;
  };

  const register = async (data) => {
    // withSignupRef: the leave-behind QR's code, if one is kept (utils/signupRef.js).
    const res = await api.post("/auth/register", withSignupRef(data));
    clearSignupRef();
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("signup_completed", "register", res.data.user?.business_type || null); } catch {}
    return res.data;
  };

  // `opts.acceptTerms` — true ONLY from a page that showed the Terms
  // acceptance line next to the button (RegisterPage, SignupTermsLine). The
  // server then records the Terms version on a NEW account. Everywhere else
  // (the login page) it is left out, and no acceptance is recorded.
  const googleLogin = async (credential, opts = {}) => {
    const res = await api.post("/auth/google", withSignupRef(withTermsAcceptance({ credential }, opts)));
    clearSignupRef();
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("login_success", "login", "google"); } catch {}
    return res.data;
  };

  /**
   * Sign in with Apple. Mirrors googleLogin: takes the identity token
   * Capacitor's Apple Sign-In plugin returns + an optional full name
   * (Apple only sends name on the FIRST sign-in; the iOS button wrapper
   * is responsible for stashing it locally for subsequent calls).
   * Backend verifies the JWT against Apple's public keys and either
   * find-or-creates the user.
   */
  const appleLogin = async (identityToken, fullName, opts = {}) => {
    const res = await api.post("/auth/apple", withSignupRef(withTermsAcceptance({
      identity_token: identityToken,
      full_name: fullName || null,
    }, opts)));
    clearSignupRef();
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("login_success", "login", "apple"); } catch {}
    return res.data;
  };

  /**
   * Task #65 — unified OAuth endpoints. These hit the new
   * /auth/oauth/apple + /auth/oauth/google routes that share the same
   * find-or-create + link semantics and stamp users.oauth_provider.
   *
   * The legacy googleLogin / appleLogin helpers above stay in place so
   * the iOS Capacitor flow (which targets /auth/apple specifically) and
   * any in-the-wild magic links keep working during the cut-over.
   */
  const googleOauthLogin = async (idToken, opts = {}) => {
    const res = await api.post("/auth/oauth/google", withSignupRef(withTermsAcceptance({ id_token: idToken }, opts)));
    clearSignupRef();
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("login_success", "login", "google_oauth"); } catch {}
    return res.data;
  };

  const appleOauthLogin = async (idToken, name, opts = {}) => {
    const res = await api.post("/auth/oauth/apple", withSignupRef(withTermsAcceptance({
      id_token: idToken,
      name: name || null,
    }, opts)));
    clearSignupRef();
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("login_success", "login", "apple_oauth"); } catch {}
    return res.data;
  };

  const logout = async () => {
    // Track BEFORE clearing token (otherwise the API call has no auth header)
    try { trackEvent("logout", "logout", null); } catch {}
    // Clear the server-side HttpOnly cookie. Fire-and-forget — if the network
    // call fails we still wipe local state below; the cookie will expire on
    // its own at ACCESS_TOKEN_EXPIRE_MINUTES.
    try { await api.post("/auth/logout"); } catch {}
    try { localStorage.removeItem("token"); } catch {}
    // Shared device: the next account must not inherit this one's mode —
    // nor this tab's "Spring over for nu" on the verify wall (release gate R-b).
    clearStoredMode();
    forgetSessionVerifySkip();
    // R-c round 2 fix-up (CMS-1) — nor this account's Daily close queue (a
    // sync still on its way stops; a form gone with the page sends nothing
    // more on the next account's session, and keeps its copies for this
    // account: utils/dailyCloseQueue withQueueAccount) — nor the branch it
    // picked (filed under it, every close of the next account was refused).
    setQueueAccount(null);
    try { localStorage.removeItem("bonbox_branch"); } catch { /* storage blocked: nothing kept */ }
    // Nor this account's figures on Home (lib/swrCache) — emptied now, not on
    // the next render.
    setCacheAccount(null);
    markHadSession(false);
    setUser(null);
  };

  /** Mark email as verified in local state (after successful verification) */
  const setEmailVerified = () => {
    setUser((prev) => prev ? { ...prev, email_verified: true } : prev);
  };

  /**
   * Re-pull /auth/me into local state. Used after mutations that change
   * user shape on the server (onboarding completion, business_type
   * change, etc.) so the React tree sees the new value without forcing
   * a full reload. Best-effort — silent failure leaves stale state, which
   * the next natural /auth/me on next navigation will correct.
   */
  const refreshUser = async () => {
    try {
      const res = await api.get("/auth/me");
      setUser(res.data);
      return res.data;
    } catch {
      return null;
    }
  };

  /**
   * Whether this user needs email verification.
   * Returns false for legacy users created before the grace date,
   * and false for already-verified users.
   */
  const needsEmailVerification = () => {
    if (!user) return false;
    if (user.email_verified) return false;
    // A revisor login is read-only and cannot request or check a code (the
    // server refuses both) — never a wall for it (utils/verifyWallRole).
    if (verifyWallSkipsRole(user)) return false;
    // Grace: users created before the feature launch date are exempt
    if (user.created_at && new Date(user.created_at) < new Date(VERIFICATION_GRACE_DATE)) {
      return false;
    }
    // If created_at is not available in the response, check email_verified only
    // (new users will have email_verified=false, legacy users who got the column
    //  added via migration also get false but won't have created_at in response,
    //  so we default to NOT forcing them — safe fallback)
    if (!user.created_at) return false;
    return true;
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, googleLogin, appleLogin, googleOauthLogin, appleOauthLogin, logout, setEmailVerified, needsEmailVerification, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
