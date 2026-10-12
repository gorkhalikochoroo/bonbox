import { useState, useRef, useEffect } from "react";
import { useNavigate, Link, useLocation } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import usePageTitle from "../hooks/usePageTitle";
// Push 6 — Google's button drawn in the page's language (GoogleButton.jsx).
import GoogleButton from "../components/GoogleButton";
import api from "../services/api";
// Task #65 — Apple Sign-In button (web). Renders nothing when the
// VITE_APPLE_CLIENT_ID env var is empty, so non-prod builds stay
// quiet without conditional imports.
import AppleSignInButton from "../components/AppleSignInButton";
import { oauthErrText } from "../utils/errText";
import { authErrorKey } from "../utils/authErrors";
import { emailProblem } from "../utils/signupValidation";
import { dismissKeyboard, enterToNext } from "../utils/phoneForm";
import { inAppBrowserName } from "../utils/inAppBrowser";
import { withSignupRef } from "../utils/signupRef";
// R-e fix-up — Google, Apple and the e-mail link create an account here too
// when the address is new, so this page shows the Terms acceptance line
// ("Ved at fortsætte accepterer du vores Handelsbetingelser.") beside those
// buttons and tells the server so (accept_terms). The server stamps the
// Terms version only on a NEW account; a sign-in never changes the record.
import SignupTermsLine from "../components/SignupTermsLine";
import { withTermsAcceptance } from "../legal/terms";
import { postLoginPath } from "../utils/verifySkip";
import AuthShell, {
  AuthAlert, AuthDivider, AuthHeading, FieldError, FieldLabel, PasswordInput, PrimaryButton,
} from "../components/auth/AuthUI";
import { inputClass, linkClass } from "../components/auth/authStyles";

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
  const { login, googleLogin, googleOauthLogin, appleOauthLogin } = useAuth();
  const { t } = useLanguage();
  usePageTitle("suTitleLogin");
  const navigate = useNavigate();
  const location = useLocation();
  // Push 6 — an address typed on /register ("Log ind", or "Den e-mail har
  // allerede en konto") comes along as router state, never in the URL.
  const handedEmail = typeof location.state?.email === "string" ? location.state.email.trim() : "";
  const [email, setEmail] = useState(handedEmail);
  const [password, setPassword] = useState("");
  // { key, vars, action } — rendered with t() so it follows a language
  // switch; { text } for a line already in the owner's language (Google/Apple).
  const [error, setError] = useState(null);
  // Inline field messages (push 6): shown under the field, not in the box.
  const [fieldErr, setFieldErr] = useState({});
  const [loading, setLoading] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  // Magic-link mode swaps the password field for an email-only form.
  // Toggled via the "Email me a sign-in link instead" link below the
  // password row. Tracked here (rather than its own route) because
  // users sometimes change their mind half-way — letting them flip
  // back to password without losing the email they already typed.
  const [magicMode, setMagicMode] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [magicSending, setMagicSending] = useState(false);
  // Sign-in surface differs per platform:
  //   • Web: Google (Google's own button, drawn by GoogleButton) + Apple JS SDK
  //   • iOS: Apple via our in-project Capacitor plugin (Task #90 —
  //     ios/App/App/AppleSignInPlugin.swift), which covers Apple
  //     guideline 4.8 by offering an OAuth provider on iOS. Google on
  //     iOS would need a SEPARATE native Capacitor plugin since the
  //     web Google flow doesn't work reliably inside the
  //     Capacitor WebView. v1.x follow-up.
  const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
  const googleConfigured = !!import.meta.env.VITE_GOOGLE_CLIENT_ID && !isNative;
  // Push 7 — Google refuses its sign-in inside Instagram's, Facebook's and
  // Messenger's own browsers ("disallowed_useragent"): there the button gives
  // way to one line saying so (utils/inAppBrowser), as on /register.
  const googleBlockedIn = googleConfigured ? inAppBrowserName() : null;
  const hasGoogle = googleConfigured && !googleBlockedIn;
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

  /** Show a server answer: under its field when it names one, else in the box. */
  const showAuthError = (r) => {
    if (r.field === "email") {
      setFieldErr({ email: r.key });
      emailRef.current?.focus();
      return;
    }
    setError({ key: r.key, vars: r.vars, action: r.action });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setRetryStatus(null);
    setSuggestMagic(false);
    // Said under the field, in the page's language — not a browser bubble.
    const emailKey = emailProblem(email);
    const pwKey = password ? null : "enterPassword";
    if (emailKey || pwKey) {
      setFieldErr({ email: emailKey, password: pwKey });
      (emailKey ? emailRef : passwordRef).current?.focus();
      return;
    }
    setFieldErr({});
    // The keyboard closes, so the busy button can be seen (utils/phoneForm).
    dismissKeyboard();
    setLoading(true);
    try {
      const data = await login(email.trim(), password);
      navigate(postLoginPath(data.user));
    } catch (err) {
      // A wrong password reads "E-mail eller adgangskode passer ikke" with
      // the way out beside it; no answer at all says so (utils/authErrors).
      showAuthError(authErrorKey(err, "login"));
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
    setError(null);
    setAppleNativeBusy(true);
    try {
      const plugin = window.Capacitor?.Plugins?.AppleSignIn;
      if (!plugin?.signIn) {
        // Defensive — hasAppleNative should already guard this branch.
        setError({ text: t("appleSigninFailed") || "Apple sign-in failed" });
        return;
      }
      const res = await plugin.signIn();
      const idToken = res?.identityToken;
      if (!idToken) {
        setError({ text: t("appleSigninFailed") || "Apple sign-in failed" });
        return;
      }
      // Apple sends fullName only on FIRST sign-in — flatten to a single
      // string for the backend's business_name first-touch logic.
      const name =
        [res.givenName, res.familyName].filter(Boolean).join(" ").trim() || null;
      const data = await appleOauthLogin(idToken, name, { acceptTerms: true });
      navigate(postLoginPath(data.user));
    } catch (err) {
      // The plugin rejects user-cancellation with code "user_cancelled" —
      // swallow silently (parity with the web button's popup_closed_by_user).
      const code = err?.code || err?.errorMessage || "";
      if (code === "user_cancelled" || String(err?.message || "").includes("user_cancelled")) {
        return;
      }
      setError({ text: oauthErrText(err, t("appleSigninFailed") || "Apple sign-in failed", t) });
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
    setError(null);
    const emailKey = emailProblem(email);
    if (emailKey) {
      setFieldErr({ email: emailKey });
      emailRef.current?.focus();
      return;
    }
    setFieldErr({});
    dismissKeyboard();
    setMagicSending(true);
    try {
      // withSignupRef: a kept door-visit code rides along so the mailed link
      // carries it (&ref=) to whichever tab or browser opens it.
      // accept_terms — the Terms line sits under the "send link" button in
      // this mode; the mailed link then carries &terms=1 (backend).
      await api.post(
        "/auth/magic-link/request",
        withSignupRef(withTermsAcceptance({ email: email.trim().toLowerCase() }, { acceptTerms: true })),
      );
      setMagicSent(true);
    } catch (err) {
      // Router-level IP rate limit (10/hour) → magicLinkRateLimited; the
      // service-level e-mail limit is swallowed for enumeration safety.
      showAuthError(authErrorKey(err, "magic"));
    } finally {
      setMagicSending(false);
    }
  };

  const switchToMagicMode = () => {
    setError(null);
    setFieldErr({});
    setMagicMode(true);
    setPassword("");
  };

  const switchToPasswordMode = () => {
    setError(null);
    setFieldErr({});
    setMagicMode(false);
    setMagicSent(false);
  };

  const typedEmail = email.trim();
  // Push 7 — in Instagram / Facebook / Messenger: one calm line where
  // Google's button would be (in the Apple row when there is one, else on its
  // own above the form), naming the two ways that work.
  const googleInAppNote = googleBlockedIn ? (
    <p data-testid="google-inapp-note" className="text-[14px] leading-relaxed text-pretty text-gray-600 dark:text-gray-400">
      {t("googleInAppNote", { app: googleBlockedIn })}
    </p>
  ) : null;

  return (
    <AuthShell
      language
      footer={
        /* Footer — quietly Danish */
        <footer className="px-6 sm:px-10 py-5 text-[12px] text-gray-600 dark:text-gray-400 flex items-center justify-between border-t border-bb-line/30 dark:border-gray-800">
          <span>{t("madeInCph")}</span>
          <div className="flex items-center gap-4">
            {/* 44 px tall and wide hit areas that do not move the line. */}
            <Link to="/privacy" className="inline-flex items-center justify-center min-h-11 min-w-11 -my-3 px-1.5 -mx-1.5 hover:text-gray-900 dark:hover:text-white">{t("privacyLink")}</Link>
            <Link to="/terms" className="inline-flex items-center justify-center min-h-11 min-w-11 -my-3 px-1.5 -mx-1.5 hover:text-gray-900 dark:hover:text-white">{t("termsLink")}</Link>
          </div>
        </footer>
      }
    >
      <AuthHeading title={t("welcomeBack")} sub={t("signInDescription")} />

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
          <svg className="w-4 h-4 shrink-0 mt-0.5 motion-safe:animate-spin" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <span>
            {retryStatus.coldStart
              ? t("loginWarmingUp", "Can't reach BonBox right now — retrying.")
              : t("loginRetrying", "Network hiccup — retrying.")}
            {" "}
            <span className="text-amber-800 ml-1">
              {t("loginAttemptOf", "Attempt {n} of {max}")
                .replace("{n}", retryStatus.attempt)
                .replace("{max}", retryStatus.max)}
            </span>
          </span>
        </div>
      )}

      {error && (
        <AuthAlert className="mt-6">
          {error.key ? t(error.key, error.vars) : error.text}
          {/* The next step, on its own line under the sentence. */}
          {error.action === "reset" && (
            <p className="mt-1.5">
              <Link to="/forgot-password" state={{ prefillEmail: typedEmail }} className={`${linkClass} font-semibold text-red-800 dark:text-red-200 decoration-red-400`}>
                {t("suResetLink")}
              </Link>
            </p>
          )}
        </AuthAlert>
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
                setError(null);
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
        <div className="mt-6 space-y-2.5">
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
                setError(null);
                try {
                  const data = await appleOauthLogin(idToken, name, { acceptTerms: true });
                  navigate(postLoginPath(data.user));
                } catch (err) {
                  setError({ text: oauthErrText(err, t("appleSigninFailed") || "Apple sign-in failed", t) });
                }
              }}
              onError={(msg) =>
                setError({ text: msg || t("appleSigninFailed") || "Apple sign-in failed" })
              }
            />
          )}
          {hasGoogle && (
            <div ref={googleWrap} className="flex justify-center [&>div]:w-full overflow-hidden">
              {/* The button's own label follows the page's language, on the
                  first load and on every switch (GoogleButton.jsx) — an
                  English page used to show "Log ind med Google" above
                  "Welcome back". */}
              <GoogleButton
                onSuccess={(res) => {
                  setError(null);
                  // Prefer the new unified endpoint when wired up;
                  // fall back to the legacy /auth/google helper if
                  // anything goes wrong (e.g. brand-new install
                  // hitting an old backend during a deploy).
                  const fn = googleOauthLogin || googleLogin;
                  fn(res.credential, { acceptTerms: true })
                    .then((data) => {
                      navigate(postLoginPath(data.user));
                    })
                    .catch((err) => setError({ text: oauthErrText(err, t("googleSigninFailed"), t) }));
                }}
                onError={() => setError({ text: t("googleSigninFailed") })}
                width={googleWidth}
                text="signin_with"
                theme="outline"
              />
            </div>
          )}
          {googleInAppNote}
          {/* R-e fix-up — the Terms acceptance line beside the
              Google/Apple row (those buttons create an account when
              the address is new). Once, before the e-mail divider. */}
          <SignupTermsLine variant="continue" isNative={isNative} className="pt-1" />
          <div className="pt-3">
            <AuthDivider label={t("orUseEmail") || (t("or") + " " + (t("emailLabel") || "email")).toLowerCase()} />
          </div>
        </div>
      )}
      {!magicMode && !(hasAppleWeb || hasAppleNative || hasGoogle) && googleInAppNote && (
        <div className="mt-6">{googleInAppNote}</div>
      )}

      {/* Magic-link sent confirmation — replaces the form entirely
          once the request goes through. We don't blur the email
          or reveal whether the address is registered (just like
          the backend's enumeration-safe 200). */}
      {magicMode && magicSent ? (
        <div className="mt-6 rounded-lg border border-bb-line/70 dark:border-gray-700 bg-white dark:bg-gray-900 p-5" role="status" aria-live="polite">
          <div className="flex items-start gap-3">
            <CheckCircle2 aria-hidden="true" className="w-6 h-6 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />
            <div className="flex-1 min-w-0">
              <p className="text-[16px] font-semibold text-gray-900 dark:text-white">{t("magicLinkSent") || "Check your email"}</p>
              <p className="text-[14px] text-gray-800 dark:text-gray-200 mt-1 leading-relaxed">
                {/* The address was written into a `||` fallback the
                    populated key shadows — so someone who mistyped their
                    email was told "your email", and waited. */}
                {t("magicLinkSentDetail",
                  "If {email} is registered, we've sent a sign-in link. It expires in 15 minutes.",
                  { email })}
              </p>
              <button
                type="button"
                onClick={switchToPasswordMode}
                className={`mt-3 text-[14px] font-medium ${linkClass}`}
              >
                {t("usePasswordInstead") || "Use password instead"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <form
          onSubmit={magicMode ? handleMagicSubmit : handleSubmit}
          noValidate
          className={`${!magicMode && (hasAppleWeb || hasAppleNative || hasGoogle) ? "mt-5" : "mt-6"} space-y-4`}
        >
          <div>
            <FieldLabel htmlFor="email">{t("emailLabel")}</FieldLabel>
            <input
              ref={emailRef}
              id="email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldErr.email) setFieldErr((f) => ({ ...f, email: null }));
              }}
              placeholder={t("emailPlaceholder")}
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              // Password mode: the keyboard's key goes on to the password.
              // E-mail-link mode: it is the only field, so the key sends.
              enterKeyHint={magicMode ? "send" : "next"}
              onKeyDown={magicMode ? undefined : enterToNext(passwordRef)}
              required
              aria-invalid={fieldErr.email ? true : undefined}
              aria-describedby={fieldErr.email ? "login-email-error" : undefined}
              className={inputClass(!!fieldErr.email)}
            />
            <FieldError id="login-email-error">{fieldErr.email ? t(fieldErr.email) : null}</FieldError>
          </div>

          {/* Password field — hidden in magic-link mode */}
          {!magicMode && (
            <div>
              <FieldLabel
                htmlFor="password"
                aside={
                  <Link to="/forgot-password" state={{ prefillEmail: typedEmail }} className={`text-[14px] ${linkClass}`}>
                    {t("forgotShort")}
                  </Link>
                }
              >
                {t("passwordLabel")}
              </FieldLabel>
              <PasswordInput
                ref={passwordRef}
                id="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (fieldErr.password) setFieldErr((f) => ({ ...f, password: null }));
                }}
                placeholder="••••••••"
                autoComplete="current-password"
                enterKeyHint="go"
                required
                aria-invalid={fieldErr.password ? true : undefined}
                aria-describedby={fieldErr.password ? "login-password-error" : undefined}
                invalid={!!fieldErr.password}
              />
              <FieldError id="login-password-error">{fieldErr.password ? t(fieldErr.password) : null}</FieldError>
            </div>
          )}

          {/* Primary sign-in CTA — forest with paper text on /register and
              /login (push 6, Manoj's B7): 11.6:1, where the old emerald-600
              with white text measured 3.65:1. */}
          <PrimaryButton
            loading={magicMode ? magicSending : loading}
            loadingLabel={magicMode ? (t("magicLinkSending") || "Sending…") : t("signingIn")}
            className="mt-2"
          >
            {magicMode ? (t("magicLinkSend") || "Email me a sign-in link") : t("suSignInBtn")}
          </PrimaryButton>
          {/* R-e fix-up — the e-mail link creates an account when the
              address is new: the Terms line sits under its button. */}
          {magicMode && <SignupTermsLine variant="continue" isNative={isNative} />}

          {/* Mode-toggle link — sits under the primary CTA so it
              never competes for the eye. In password mode this
              is "Email me a sign-in link instead"; in magic-link
              mode it's "Use password instead". */}
          <div className="text-center pt-1">
            <button
              type="button"
              onClick={magicMode ? switchToPasswordMode : switchToMagicMode}
              className={`text-[14px] ${linkClass}`}
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
        <p className="mt-4 text-center text-[13px] text-gray-600">
          {t("loginGoogleHintNative") ||
            "Signed up with Google on the web? Tap “Forgot?” next to the password above to set an app password."}
        </p>
      )}

      {/* Apple Guideline 3.1.1 — no account registration on the iOS
          app (sign-up is the on-ramp to an off-platform subscription).
          Native is sign-in only; new businesses register on the web.
          Hide the "create account" link in the native shell. */}
      {!isNative && (
        <p className="mt-6 text-center text-[14px] text-gray-600 dark:text-gray-400">
          {t("newToBonBox")}{" "}
          <Link to="/register" state={{ email: typedEmail }} className={`${linkClass} font-medium`}>
            {t("createAccount")}
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
