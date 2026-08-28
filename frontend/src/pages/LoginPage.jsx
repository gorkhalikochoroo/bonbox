import { useState, useRef, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { GoogleLogin } from "@react-oauth/google";
import api from "../services/api";
// Task #65 — Apple Sign-In button (web). Renders nothing when the
// VITE_APPLE_CLIENT_ID env var is empty, so non-prod builds stay
// quiet without conditional imports.
import AppleSignInButton from "../components/AppleSignInButton";
import { errText } from "../utils/errText";

/* Inline SVG illustration — a fun receipt-and-boxes scene */
function HeroIllustration() {
  return (
    <svg viewBox="0 0 400 400" fill="none" className="w-full max-w-sm mx-auto drop-shadow-sm" style={{ filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.08))" }}>
      {/* Background blob */}
      <ellipse cx="200" cy="210" rx="170" ry="160" fill="#ECFDF5" />

      {/* Desk */}
      <rect x="60" y="280" width="280" height="12" rx="6" fill="#D1FAE5" />
      <rect x="80" y="292" width="8" height="50" rx="4" fill="#A7F3D0" />
      <rect x="312" y="292" width="8" height="50" rx="4" fill="#A7F3D0" />

      {/* Big receipt */}
      <g className="animate-[float_3s_ease-in-out_infinite]">
        <rect x="130" y="100" width="90" height="170" rx="8" fill="white" stroke="#D1D5DB" strokeWidth="2" />
        <rect x="145" y="120" width="60" height="6" rx="3" fill="#E5E7EB" />
        <rect x="145" y="134" width="45" height="6" rx="3" fill="#E5E7EB" />
        <rect x="145" y="148" width="55" height="6" rx="3" fill="#E5E7EB" />
        <line x1="145" y1="168" x2="205" y2="168" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="4 3" />
        <rect x="145" y="180" width="35" height="8" rx="4" fill="#10B981" />
        <text x="148" y="187" fontSize="6" fill="white" fontWeight="bold">PAID</text>
        {/* Zigzag bottom */}
        <path d="M130 270 l7-8 7 8 7-8 7 8 7-8 7 8 7-8 7 8 7-8 7 8 7-8 7 8 v0 h-90 z" fill="white" stroke="#D1D5DB" strokeWidth="2" strokeLinejoin="round" />
      </g>

      {/* Floating coin */}
      <g className="animate-[float_2.5s_ease-in-out_infinite_0.5s]">
        <circle cx="280" cy="140" r="24" fill="#FCD34D" stroke="#F59E0B" strokeWidth="2" />
        <text x="280" y="146" fontSize="16" fill="#92400E" fontWeight="bold" textAnchor="middle">$</text>
      </g>

      {/* Small box 1 */}
      <g className="animate-[float_3.5s_ease-in-out_infinite_1s]">
        <rect x="260" y="200" width="55" height="55" rx="10" fill="#34D399" stroke="#059669" strokeWidth="2" />
        <path d="M270 220 h35 M287 210 v20" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      </g>

      {/* Small box 2 */}
      <g className="animate-[float_4s_ease-in-out_infinite_0.3s]">
        <rect x="70" y="190" width="45" height="45" rx="10" fill="#A78BFA" stroke="#7C3AED" strokeWidth="2" />
        <path d="M82 212 l8 8 14-16" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* Chart mini */}
      <g className="animate-[float_3s_ease-in-out_infinite_0.8s]">
        <rect x="80" y="120" width="40" height="50" rx="6" fill="#DBEAFE" stroke="#93C5FD" strokeWidth="1.5" />
        <polyline points="88,155 95,145 102,150 112,135" stroke="#3B82F6" strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>

      {/* Sparkles */}
      <g fill="#FCD34D">
        <path d="M320 100 l3-8 3 8 -8-3 8-3z" className="animate-[twinkle_2s_ease-in-out_infinite]" />
        <path d="M100 90 l2-6 2 6 -6-2 6-2z" className="animate-[twinkle_2s_ease-in-out_infinite_0.7s]" />
        <path d="M340 250 l2-6 2 6 -6-2 6-2z" className="animate-[twinkle_2s_ease-in-out_infinite_1.4s]" />
      </g>
    </svg>
  );
}

export default function LoginPage() {
  // Task #90 — Apple Sign-In on iOS native now goes through our in-project
  // Capacitor plugin (ios/App/App/AppleSignInPlugin.swift), which wraps the
  // system AuthenticationServices framework. We rolled our own instead of
  // pulling @capacitor-community/apple-sign-in because that plugin still
  // pins capacitor-swift-pm ^7 (incompatible with our @capacitor/*@8.x).
  // The native flow returns an identityToken in the SAME shape as Apple's
  // web JS SDK, so it hits POST /api/auth/oauth/apple unchanged — no
  // backend changes needed.
  const { login, googleLogin, googleOauthLogin, appleOauthLogin, needsEmailVerification } = useAuth();
  const { lang, setLang, LANGUAGES, t } = useLanguage();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  // Magic-link mode swaps the password field for an email-only form.
  // Toggled via the "Email me a sign-in link instead" link below the
  // password row. Tracked here (rather than its own route) because
  // users sometimes change their mind half-way — letting them flip
  // back to password without losing the email they already typed.
  const [magicMode, setMagicMode] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [magicSending, setMagicSending] = useState(false);
  // Sign-in surface differs per platform:
  //   • Web: Google (via @react-oauth/google JS SDK) + Apple JS SDK
  //   • iOS: Apple via our in-project Capacitor plugin (Task #90 —
  //     ios/App/App/AppleSignInPlugin.swift), which covers Apple
  //     guideline 4.8 by offering an OAuth provider on iOS. Google on
  //     iOS would need a SEPARATE native Capacitor plugin since the
  //     web @react-oauth/google flow doesn't work reliably inside the
  //     Capacitor WebView. v1.x follow-up.
  const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
  const hasGoogle = !!import.meta.env.VITE_GOOGLE_CLIENT_ID && !isNative;
  // Task #90 — true on iOS native when our custom AppleSignInPlugin is
  // registered. We feature-detect via window.Capacitor.Plugins.AppleSignIn
  // so a stale TestFlight build that predates the plugin gracefully
  // falls back to email/password instead of crashing on a missing bridge.
  const hasAppleNative =
    isNative &&
    !!(typeof window !== "undefined" && window.Capacitor?.Plugins?.AppleSignIn?.signIn);
  const [appleNativeBusy, setAppleNativeBusy] = useState(false);
  // Web Apple Sign-In (Task #65) — Apple Service ID (e.g. dk.bonbox.web).
  // Hidden inside Capacitor's WebView for the same reason as Google: the
  // popup-based flow doesn't pair well with WKWebView. Native iOS uses
  // the Capacitor plugin path (hasAppleNative above).
  const APPLE_CLIENT_ID_WEB = import.meta.env.VITE_APPLE_CLIENT_ID || "";
  const hasAppleWeb = !!APPLE_CLIENT_ID_WEB && !isNative;

  // Google button width is fixed-pixel — measure container so it fits any phone
  const googleWrap = useRef(null);
  const [googleWidth, setGoogleWidth] = useState(320);
  useEffect(() => {
    if (!googleWrap.current) return;
    const measure = () => {
      const w = googleWrap.current?.offsetWidth || 320;
      setGoogleWidth(Math.max(240, Math.min(400, w)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [hasGoogle]);

  // Task #97 — multi-layer cold-start UX.
  //
  // When the axios retry interceptor is mid-backoff against a sleeping
  // Render dyno, we want the user to SEE that we're working on it
  // instead of staring at a silent spinner.  We listen to the
  // `bonbox:api-retry` event the interceptor fires per attempt and
  // surface the friendly progress message.  After the final retry
  // exhausts (`bonbox:api-retry-exhausted`) we surface the magic-link
  // fallback prominently so the user isn't dead-ended on password.
  const [retryStatus, setRetryStatus] = useState(null); // { attempt, max, delayMs, coldStart }
  const [suggestMagic, setSuggestMagic] = useState(false);
  useEffect(() => {
    const onRetry = (e) => {
      const d = e?.detail || {};
      // Only show progress for auth flows the user explicitly triggered.
      const url = d.url || "";
      if (!url.includes("/auth/")) return;
      setRetryStatus({
        attempt: d.attempt || 1,
        max: d.maxAttempts || 4,
        delayMs: d.delayMs || 0,
        coldStart: !!d.isColdStart,
      });
    };
    const onExhausted = (e) => {
      const d = e?.detail || {};
      const url = d.url || "";
      if (!url.includes("/auth/")) return;
      setRetryStatus(null);
      setSuggestMagic(true);
    };
    window.addEventListener("bonbox:api-retry", onRetry);
    window.addEventListener("bonbox:api-retry-exhausted", onExhausted);
    return () => {
      window.removeEventListener("bonbox:api-retry", onRetry);
      window.removeEventListener("bonbox:api-retry-exhausted", onExhausted);
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setRetryStatus(null);
    setSuggestMagic(false);
    setLoading(true);
    try {
      const data = await login(email, password);
      if (data.user && !data.user.email_verified && data.user.created_at && new Date(data.user.created_at) >= new Date("2026-04-13T00:00:00")) {
        navigate("/verify-email");
      } else {
        navigate("/dashboard");
      }
    } catch (err) {
      let msg;
      const detail = err.response?.data?.detail;
      if (typeof detail === "string") {
        // Server returned a specific string error message
        msg = detail;
      } else if (Array.isArray(detail)) {
        // Pydantic validation errors — extract first readable message
        const first = detail[0] || {};
        msg = (first.msg || "Invalid input").replace(/^Value error,\s*/, "");
      } else if (err.code === "ECONNABORTED") {
        msg = "Server is waking up — please wait 30s and try again";
      } else if (err.code === "ERR_NETWORK" || !err.response) {
        msg = "Cannot reach server — check your connection or try again in a moment";
      } else if (err.response?.status >= 500) {
        msg = "Server error — please try again in a moment";
      } else {
        msg = "Invalid email or password";
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Task #90 — Native iOS Apple Sign-In. Calls our custom Capacitor plugin
   * (AppleSignInPlugin.swift) which presents the system SIWA sheet and
   * returns { identityToken, nonce, givenName?, familyName?, email? }.
   * The identityToken goes to the SAME /auth/oauth/apple endpoint as the
   * web SDK; the backend doesn't know or care which surface produced it.
   */
  const handleAppleNativeSignIn = async () => {
    if (appleNativeBusy) return;
    setError("");
    setAppleNativeBusy(true);
    try {
      const plugin = window.Capacitor?.Plugins?.AppleSignIn;
      if (!plugin?.signIn) {
        // Defensive — hasAppleNative should already guard this branch.
        setError(t("appleSigninFailed") || "Apple sign-in failed");
        return;
      }
      const res = await plugin.signIn();
      const idToken = res?.identityToken;
      if (!idToken) {
        setError(t("appleSigninFailed") || "Apple sign-in failed");
        return;
      }
      // Apple sends fullName only on FIRST sign-in — flatten to a single
      // string for the backend's business_name first-touch logic.
      const name =
        [res.givenName, res.familyName].filter(Boolean).join(" ").trim() || null;
      const data = await appleOauthLogin(idToken, name);
      if (
        data.user &&
        !data.user.email_verified &&
        data.user.created_at &&
        new Date(data.user.created_at) >= new Date("2026-04-13T00:00:00")
      ) {
        navigate("/verify-email");
      } else {
        navigate("/dashboard");
      }
    } catch (err) {
      // The plugin rejects user-cancellation with code "user_cancelled" —
      // swallow silently (parity with the web button's popup_closed_by_user).
      const code = err?.code || err?.errorMessage || "";
      if (code === "user_cancelled" || String(err?.message || "").includes("user_cancelled")) {
        return;
      }
      setError(errText(err, t("appleSigninFailed") || "Apple sign-in failed"));
    } finally {
      setAppleNativeBusy(false);
    }
  };

  /**
   * Magic-link request handler.
   *
   * The backend ALWAYS returns 200 (enumeration-safe), so we don't
   * differentiate "registered" vs "not registered" in the UI either —
   * the confirmation message is generic on purpose. We only show an
   * error for network failures / hard server errors.
   */
  const handleMagicSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!email || !email.includes("@")) {
      setError(t("magicLinkInvalidEmail") || "Please enter a valid email address");
      return;
    }
    setMagicSending(true);
    try {
      await api.post("/auth/magic-link/request", { email: email.trim().toLowerCase() });
      setMagicSent(true);
    } catch (err) {
      let msg;
      if (err.code === "ECONNABORTED") {
        msg = "Server is waking up — please wait 30s and try again";
      } else if (err.code === "ERR_NETWORK" || !err.response) {
        msg = "Cannot reach server — check your connection or try again in a moment";
      } else if (err.response?.status === 429) {
        // Router-level IP rate limit (10/hour). Service-level email
        // limit is silently swallowed for enumeration safety; this
        // 429 is the per-IP limit triggering, which IS safe to show.
        msg = t("magicLinkRateLimited") || "Too many requests. Try again in an hour.";
      } else {
        msg = t("magicLinkFallback") || "We couldn't send the link. Try password sign-in instead.";
      }
      setError(msg);
    } finally {
      setMagicSending(false);
    }
  };

  const switchToMagicMode = () => {
    setError("");
    setMagicMode(true);
    setPassword("");
  };

  const switchToPasswordMode = () => {
    setError("");
    setMagicMode(false);
    setMagicSent(false);
  };

  return (
    <>
      <style>{`
        @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div className="min-h-screen flex flex-col bg-slate-50 text-gray-900">
        {/* Top bar — wordmark left, language dropdown right (Copenhagen-style minimal nav) */}
        {/* Sticky + glass-static. capacitor.config sets
            StatusBar.overlaysWebView:true (the fix for the dark strips above
            the header and below the tab bar), which means the webview owns the
            full screen and scrolled content passes UNDER a transparent status
            bar. body pads by env(safe-area-inset-top) so this sits correctly at
            rest — but a plain non-sticky header scrolled straight up into the
            clock. The signed-in app never showed this because Layout's header
            is fixed .glass; the signed-out screens had no equivalent.
            .glass-static, not .glass: a transform on a sticky element causes
            the documented iOS scroll wobble (see index.css). */}
        <header className="sticky top-0 z-40 glass-static px-6 sm:px-10 py-5 flex items-center justify-between border-b border-gray-200/60">
          {/* Brand mark — emerald-600 per the "BRAND GREEN" token block.
              Migrated from `bg-[#22c55e]` (green-500) to the canonical
              emerald-600 (#059669) so the login logo matches the sidebar,
              landing top-bar, and Button.accent primitive. */}
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-emerald-600">
              <svg width="18" height="18" viewBox="0 0 28 28" fill="none">
                <rect x="4" y="2" width="20" height="24" rx="3" stroke="currentColor"
                      className="text-white" strokeWidth="2.2"/>
                <path d="M9 8h10M9 12h10M9 16h6" stroke="currentColor"
                      className="text-white" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-[15px] font-semibold tracking-tight">BonBox</span>
          </Link>

          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            aria-label={t("loginLanguageLabel", "Language")}
            className="text-[13px] bg-transparent border border-gray-200 rounded-md px-2.5 py-1.5
              text-gray-700 hover:border-gray-400
              focus:outline-none focus:ring-2 focus:ring-gray-900 cursor-pointer"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code} className="bg-white">
                {l.label}
              </option>
            ))}
          </select>
        </header>

        {/* Body — single column, generous whitespace */}
        <main className="flex-1 flex items-center justify-center px-6 py-12 sm:py-20">
          <div className="w-full max-w-[400px]" style={{ animation: "slideUp 0.4s ease-out" }}>
            <h1 className="text-[28px] sm:text-[32px] font-semibold tracking-tight leading-[1.15] text-gray-900">
              {t("welcomeBack")}
            </h1>
            <p className="text-[15px] text-gray-500 mt-2 leading-relaxed">
              {t("signInDescription")}
            </p>

            {/* Task #97 — multi-layer cold-start UX banner.  While the
                axios retry interceptor is mid-backoff against a sleeping
                Render dyno, show "Server is waking up…" instead of the
                silent button-spinner so the user knows we're not stuck. */}
            {retryStatus && (loading || magicSending) && (
              <div
                role="status"
                aria-live="polite"
                className="mt-6 flex items-start gap-2.5 bg-amber-50
                border border-amber-200 text-amber-900 px-3.5 py-3 rounded-lg text-[13px]"
              >
                <svg className="w-4 h-4 shrink-0 mt-0.5 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                <span>
                  {retryStatus.coldStart
                    ? t("loginWarmingUp", "Server is waking up — this usually takes 20-30 seconds the first time.")
                    : t("loginRetrying", "Network hiccup — retrying.")}
                  {" "}
                  <span className="text-amber-700/80 ml-1">
                    {t("loginAttemptOf", "Attempt {n} of {max}")
                      .replace("{n}", retryStatus.attempt)
                      .replace("{max}", retryStatus.max)}
                  </span>
                </span>
              </div>
            )}

            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="mt-6 flex items-start gap-2.5 bg-red-50
                border border-red-200 text-red-700 px-3.5 py-3 rounded-lg text-[13px]"
              >
                <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z"/>
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Task #97 — when password retries are exhausted, surface
                magic-link as a one-click fallback so the user isn't
                dead-ended.  Magic-link uses a different code path
                (email-only, no /auth/login) so it can succeed when
                password POST keeps timing out. */}
            {suggestMagic && !loading && !magicSending && (
              <div
                role="status"
                aria-live="polite"
                className="mt-3 flex items-start gap-2.5 bg-blue-50
                border border-blue-200 text-blue-900 px-3.5 py-3 rounded-lg text-[13px]"
              >
                <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M3 8l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                </svg>
                <span>
                  {t("loginPasswordStuckTryMagic", "Password sign-in is having trouble. Try the one-click email link instead — it works even when the API is slow.")}
                  {" "}
                  <button
                    type="button"
                    onClick={() => {
                      setSuggestMagic(false);
                      setError("");
                      if (!magicMode) {
                        // switchToMagicMode is declared elsewhere; inlined here
                        // to avoid the cross-reference dance.
                        if (typeof switchToMagicMode === "function") switchToMagicMode();
                      }
                    }}
                    className="underline font-medium text-blue-700 hover:text-blue-900"
                  >
                    {t("loginUseMagicLink", "Send me a sign-in link")}
                  </button>
                </span>
              </div>
            )}

            {/* ── Task #65 — OAuth row (Apple + Google) ───────────────
                Sits ABOVE the email/password form so the third-party
                options are the dominant choice. Each provider verifies
                its own token server-side via /auth/oauth/{provider}.
                Both buttons render only when their respective client
                IDs are configured AND we're not inside Capacitor's
                WebView (which has its own native sign-in surface). */}
            {!magicMode && (hasAppleWeb || hasAppleNative || hasGoogle) && (
              <div className="mt-7 space-y-2.5">
                {hasAppleNative && (
                  // Task #90 — native iOS SIWA button. Visual parity with
                  // AppleSignInButton (web): black bg, Apple glyph, 44px tap
                  // target. On tap we call our Capacitor plugin which
                  // presents the system sheet.
                  <button
                    type="button"
                    onClick={handleAppleNativeSignIn}
                    disabled={appleNativeBusy}
                    aria-label={t("signInWithApple") || "Sign in with Apple"}
                    className="w-full flex items-center justify-center gap-2 bg-black text-white rounded-lg
                      h-[44px] px-4 text-[15px] font-medium hover:bg-gray-900 transition
                      disabled:opacity-60 disabled:cursor-not-allowed
                      focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-black"
                  >
                    <svg width="16" height="18" viewBox="0 0 16 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <path
                        d="M13.2 13.7c-.3.7-.7 1.4-1.2 2-.7.9-1.5 1.5-2.4 1.5-.4 0-.9-.1-1.5-.4-.6-.3-1.1-.4-1.6-.4-.5 0-1 .1-1.7.4-.6.2-1.1.4-1.5.4-.9 0-1.7-.7-2.5-1.6C.4 14.1 0 12.4 0 10.5c0-1.7.4-3.1 1.3-4.2.7-.9 1.6-1.4 2.7-1.4.4 0 1 .1 1.7.4.7.3 1.2.4 1.4.4.2 0 .7-.1 1.6-.4.8-.3 1.5-.4 2.1-.3 1.5.1 2.7.7 3.4 1.8-1.3.8-2 1.9-2 3.3 0 1.1.4 2 1.2 2.7.4.3.7.6 1.2.7-.1.3-.2.6-.3 1zM11.5 0c.1.7-.2 1.5-.7 2.2-.6.8-1.4 1.3-2.3 1.2-.1-.7.2-1.5.7-2.1.3-.4.7-.7 1.1-.9.4-.2.9-.3 1.2-.4z"
                        fill="currentColor"
                      />
                    </svg>
                    <span>{appleNativeBusy ? "…" : (t("signInWithApple") || "Sign in with Apple")}</span>
                  </button>
                )}
                {hasAppleWeb && (
                  <AppleSignInButton
                    clientId={APPLE_CLIENT_ID_WEB}
                    label={t("signInWithApple") || "Sign in with Apple"}
                    mode="signin"
                    onSuccess={async ({ idToken, name }) => {
                      setError("");
                      try {
                        const data = await appleOauthLogin(idToken, name);
                        if (
                          data.user &&
                          !data.user.email_verified &&
                          data.user.created_at &&
                          new Date(data.user.created_at) >= new Date("2026-04-13T00:00:00")
                        ) {
                          navigate("/verify-email");
                        } else {
                          navigate("/dashboard");
                        }
                      } catch (err) {
                        setError(errText(err, t("appleSigninFailed") || "Apple sign-in failed"));
                      }
                    }}
                    onError={(msg) =>
                      setError(msg || t("appleSigninFailed") || "Apple sign-in failed")
                    }
                  />
                )}
                {hasGoogle && (
                  <div ref={googleWrap} className="flex justify-center [&>div]:w-full overflow-hidden">
                    <GoogleLogin
                      onSuccess={(res) => {
                        setError("");
                        // Prefer the new unified endpoint when wired up;
                        // fall back to the legacy /auth/google helper if
                        // anything goes wrong (e.g. brand-new install
                        // hitting an old backend during a deploy).
                        const fn = googleOauthLogin || googleLogin;
                        fn(res.credential)
                          .then((data) => {
                            if (data.user && !data.user.email_verified && data.user.created_at && new Date(data.user.created_at) >= new Date("2026-04-13T00:00:00")) {
                              navigate("/verify-email");
                            } else {
                              navigate("/dashboard");
                            }
                          })
                          .catch((err) => setError(errText(err, t("googleSigninFailed"))));
                      }}
                      onError={() => setError(t("googleSigninFailed"))}
                      shape="rectangular"
                      size="large"
                      width={String(googleWidth)}
                      text="signin_with"
                      theme="outline"
                    />
                  </div>
                )}
                <div className="flex items-center gap-3 pt-3">
                  <div className="flex-1 h-px bg-gray-200" />
                  <span className="text-[11px] uppercase tracking-wider text-gray-400">
                    {t("orUseEmail") || (t("or") + " " + (t("emailLabel") || "email")).toLowerCase()}
                  </span>
                  <div className="flex-1 h-px bg-gray-200" />
                </div>
              </div>
            )}

            {/* Magic-link sent confirmation — replaces the form entirely
                once the request goes through. We don't blur the email
                or reveal whether the address is registered (just like
                the backend's enumeration-safe 200). */}
            {magicMode && magicSent ? (
              <div className="mt-7 bg-gray-50 border border-gray-100 rounded-xl p-5">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7"/>
                    </svg>
                  </div>
                  <div className="flex-1">
                    <p className="text-[15px] font-semibold text-gray-900">{t("magicLinkSent") || "Check your email"}</p>
                    <p className="text-[13px] text-gray-800 mt-1 leading-relaxed">
                      {t("magicLinkSentDetail") ||
                        `If ${email} is registered, we've sent a sign-in link. It expires in 15 minutes.`}
                    </p>
                    <button
                      type="button"
                      onClick={switchToPasswordMode}
                      className="mt-3 text-[13px] text-gray-700 hover:text-gray-900 underline-offset-2 hover:underline font-medium"
                    >
                      {t("usePasswordInstead") || "Use password instead"}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <form
                onSubmit={magicMode ? handleMagicSubmit : handleSubmit}
                className="mt-7 space-y-4"
              >
                <div>
                  <label htmlFor="email" className="block text-[13px] font-medium text-gray-700 mb-1.5">
                    {t("emailLabel")}
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("emailPlaceholder")}
                    autoComplete="email"
                    className="w-full px-3.5 py-2.5 bg-white border border-gray-300
                      rounded-lg text-[15px] text-gray-900 placeholder:text-gray-400
                      focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-gray-900 transition"
                    required
                  />
                </div>

                {/* Password field — hidden in magic-link mode */}
                {!magicMode && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label htmlFor="password" className="block text-[13px] font-medium text-gray-700">
                        {t("passwordLabel")}
                      </label>
                      <Link to="/forgot-password"
                            className="text-[13px] text-gray-600 hover:text-gray-900 underline-offset-2 hover:underline">
                        {t("forgotShort")}
                      </Link>
                    </div>
                    <div className="relative">
                      <input
                        id="password"
                        type={showPass ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        autoComplete="current-password"
                        className="w-full px-3.5 pr-11 py-2.5 bg-white border border-gray-300
                          rounded-lg text-[15px] text-gray-900 placeholder:text-gray-400
                          focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-gray-900 transition"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPass(!showPass)}
                        aria-label={showPass ? (t("hidePassword") || "Hide password") : (t("showPassword") || "Show password")}
                        aria-pressed={showPass}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-gray-500 hover:text-gray-800 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                      >
                        {showPass ? (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18"/></svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Primary sign-in CTA — emerald-600 (brand-green). Marketing
                    surfaces (landing, login, register) earn brand-green;
                    interior app primary CTAs stay gray-900 per doctrine.
                    Migrated from #22c55e → emerald-600 (#059669) for token
                    consistency with Layout sidebar + landing + Button.accent. */}
                <button
                  type="submit"
                  disabled={magicMode ? magicSending : loading}
                  className="w-full bg-emerald-600 text-white py-2.5 rounded-lg
                    text-[14px] font-medium hover:bg-emerald-700
                    disabled:opacity-60 disabled:cursor-not-allowed transition
                    flex items-center justify-center gap-2"
                >
                  {(magicMode ? magicSending : loading) ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                      {magicMode ? (t("magicLinkSending") || "Sending…") : t("signingIn")}
                    </>
                  ) : magicMode ? (t("magicLinkSend") || "Email me a sign-in link") : t("signIn")}
                </button>

                {/* Mode-toggle link — sits under the primary CTA so it
                    never competes for the eye. In password mode this
                    is "Email me a sign-in link instead"; in magic-link
                    mode it's "Use password instead". */}
                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={magicMode ? switchToPasswordMode : switchToMagicMode}
                    className="text-[13px] text-gray-600 hover:text-gray-900 underline-offset-2 hover:underline"
                  >
                    {magicMode
                      ? (t("usePasswordInstead") || "Use password instead")
                      : (t("useEmailInstead") || "Email me a sign-in link instead")}
                  </button>
                </div>
              </form>
            )}

            {/* Task #90 — native Apple Sign-In moved into the OAuth row
                above (rendered conditionally on hasAppleNative). We
                replaced the @capacitor-community/apple-sign-in plugin
                (which pinned capacitor-swift-pm ^7) with a thin in-project
                Swift wrapper around AuthenticationServices — see
                ios/App/App/AppleSignInPlugin.swift. */}

            {/* iOS-only hint for users who signed up via Google on web.
                Even with Apple SIWA available, we still hide Google on
                iOS (no native Google Capacitor plugin yet). So
                Google-account users still need the "Forgot password"
                bridge until we add native Google. */}
            {isNative && (
              <p className="mt-4 text-center text-[12px] text-gray-500">
                {t("loginGoogleHintNative") ||
                  "Signed up with Google on the web? Tap “Forgot password” above to set an app password — takes 30 seconds."}
              </p>
            )}

            {/* Apple Guideline 3.1.1 — no account registration on the iOS
                app (sign-up is the on-ramp to an off-platform subscription).
                Native is sign-in only; new businesses register on the web.
                Hide the "create account" link in the native shell. */}
            {!isNative && (
            <p className="mt-7 text-center text-[13px] text-gray-500">
              {t("newToBonBox")}{" "}
              <Link to="/register" className="text-gray-900 font-medium underline-offset-2 hover:underline">
                {t("createAccount")}
              </Link>
            </p>
            )}
          </div>
        </main>

        {/* Footer — quietly Danish */}
        <footer className="px-6 sm:px-10 py-5 text-[12px] text-gray-400 flex items-center justify-between border-t border-gray-200/60">
          <span>{t("madeInCph")}</span>
          <div className="flex items-center gap-4">
            <Link to="/privacy" className="hover:text-gray-700">{t("privacyLink")}</Link>
            <Link to="/terms" className="hover:text-gray-700">{t("termsLink")}</Link>
          </div>
        </footer>
      </div>
    </>
  );
}
