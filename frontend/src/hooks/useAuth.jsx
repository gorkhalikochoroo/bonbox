import { createContext, useContext, useState, useEffect } from "react";
import api from "../services/api";
import { trackEvent } from "./useEventLog";

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

// Grace date: users created before this date are not forced to verify email
const VERIFICATION_GRACE_DATE = "2026-04-13T00:00:00";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

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
    api
      .get("/auth/me")
      .then((res) => {
        setUser(res.data);
        // One-time migration: once cookie auth is confirmed working on web,
        // drop the legacy bearer token so XSS can't read it.
        if (!native && legacyToken) {
          try { localStorage.removeItem("token"); } catch {}
        }
      })
      .catch(() => {
        // Token (if any) is invalid or session expired — wipe it so we
        // don't keep retrying with stale credentials.
        try { localStorage.removeItem("token"); } catch {}
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
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("login_success", "login", "password"); } catch {}
    return res.data;
  };

  const register = async (data) => {
    const res = await api.post("/auth/register", data);
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("signup_completed", "register", res.data.user?.business_type || null); } catch {}
    return res.data;
  };

  const googleLogin = async (credential) => {
    const res = await api.post("/auth/google", { credential });
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
  const appleLogin = async (identityToken, fullName) => {
    const res = await api.post("/auth/apple", {
      identity_token: identityToken,
      full_name: fullName || null,
    });
    persistTokenIfNeeded(res.data.access_token);
    setUser(res.data.user);
    syncTimezoneIfChanged(res.data.user?.timezone);
    try { trackEvent("login_success", "login", "apple"); } catch {}
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
    <AuthContext.Provider value={{ user, loading, login, register, googleLogin, appleLogin, logout, setEmailVerified, needsEmailVerification, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
