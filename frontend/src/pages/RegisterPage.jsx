import { useState, useRef, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import api from "../services/api";
import { errText } from "../utils/errText";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { GoogleLogin } from "@react-oauth/google";
// Task #65 — Apple Sign-In button (web). Self-renders nothing when
// VITE_APPLE_CLIENT_ID is unset, so dev builds stay quiet.
import AppleSignInButton from "../components/AppleSignInButton";

/* Inline SVG — growth / rocket scene for registration */
function RegisterIllustration() {
  return (
    <svg viewBox="0 0 400 400" fill="none" className="w-full max-w-sm mx-auto" style={{ filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.08))" }}>
      <ellipse cx="200" cy="210" rx="170" ry="160" fill="#ECFDF5" className="dark:opacity-10" />
      {/* Ground */}
      <rect x="60" y="300" width="280" height="10" rx="5" fill="#D1FAE5" />
      {/* Rising bar chart */}
      <g className="animate-[float_3s_ease-in-out_infinite]">
        <rect x="100" y="220" width="30" height="80" rx="6" fill="#6EE7B7" />
        <rect x="145" y="190" width="30" height="110" rx="6" fill="#34D399" />
        <rect x="190" y="155" width="30" height="145" rx="6" fill="#10B981" />
        <rect x="235" y="130" width="30" height="170" rx="6" fill="#059669" />
      </g>
      {/* Arrow going up */}
      <g className="animate-[float_2.5s_ease-in-out_infinite_0.3s]">
        <path d="M120 210 L250 100" stroke="#10B981" strokeWidth="3" strokeLinecap="round" strokeDasharray="6 4" />
        <polygon points="255,95 245,95 250,82" fill="#10B981" />
      </g>
      {/* Star burst */}
      <g className="animate-[float_3.5s_ease-in-out_infinite_0.6s]">
        <circle cx="310" cy="120" r="28" fill="#FCD34D" stroke="#F59E0B" strokeWidth="2" />
        <path d="M310 108 l3 8 8-3 -6 6 6 6 -8-3 -3 8 -3-8 -8 3 6-6 -6-6 8 3z" fill="white" />
      </g>
      {/* Small receipt */}
      <g className="animate-[float_4s_ease-in-out_infinite_1s]">
        <rect x="70" y="110" width="50" height="70" rx="6" fill="white" stroke="#D1D5DB" strokeWidth="1.5" />
        <rect x="80" y="122" width="30" height="4" rx="2" fill="#E5E7EB" />
        <rect x="80" y="132" width="22" height="4" rx="2" fill="#E5E7EB" />
        <rect x="80" y="142" width="26" height="4" rx="2" fill="#E5E7EB" />
        <rect x="80" y="155" width="18" height="6" rx="3" fill="#10B981" />
      </g>
      {/* Floating heart */}
      <g className="animate-[float_3s_ease-in-out_infinite_0.5s]">
        <path d="M330 210 c0-8 12-14 12-6 c0 8-12 18-12 18 s-12-10-12-18 c0-8 12-2 12 6z" fill="#F472B6" />
      </g>
      {/* Sparkles */}
      <g fill="#FCD34D">
        <path d="M160 90 l3-8 3 8 -8-3 8-3z" className="animate-[twinkle_2s_ease-in-out_infinite]" />
        <path d="M340 280 l2-6 2 6 -6-2 6-2z" className="animate-[twinkle_2s_ease-in-out_infinite_0.7s]" />
        <path d="M80 270 l2-6 2 6 -6-2 6-2z" className="animate-[twinkle_2s_ease-in-out_infinite_1.4s]" />
      </g>
    </svg>
  );
}

const inputCls = "w-full pl-11 pr-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent text-base text-gray-800 dark:text-gray-200 placeholder:text-gray-400 transition";
const selectCls = "w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent text-base text-gray-800 dark:text-gray-200 transition appearance-none";

export default function RegisterPage() {
  const { register, googleLogin, googleOauthLogin, appleOauthLogin } = useAuth();
  // Sign-in surface differs per platform:
  //   • Web:    Google (via @react-oauth/google JS SDK) + Apple JS SDK
  //   • iOS:    Apple via our in-project Capacitor plugin (Task #90 —
  //             ios/App/App/AppleSignInPlugin.swift). Google on iOS still
  //             needs a separate native Capacitor plugin since the web
  //             @react-oauth/google flow doesn't work inside WKWebView;
  //             that's a follow-up.
  const isNative = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.();
  const hasGoogle = !!import.meta.env.VITE_GOOGLE_CLIENT_ID && !isNative;
  // Feature-detect the native plugin so older TestFlight builds (which
  // shipped without the bridge) gracefully fall back to email/password.
  const hasAppleNative =
    isNative &&
    !!(typeof window !== "undefined" && window.Capacitor?.Plugins?.AppleSignIn?.signIn);
  const [appleNativeBusy, setAppleNativeBusy] = useState(false);
  // Task #65 — web Apple Sign-Up via Apple's JS SDK. Hidden on native
  // (the Capacitor plugin handles that path) and when no Service ID
  // is configured.
  const APPLE_CLIENT_ID_WEB = import.meta.env.VITE_APPLE_CLIENT_ID || "";
  const hasAppleWeb = !!APPLE_CLIENT_ID_WEB && !isNative;

  /**
   * Task #90 — Native iOS Apple Sign-Up. Same flow as the LoginPage handler
   * (POST /auth/oauth/apple), but lands on /dashboard rather than checking
   * the email-verified gate — Apple-verified emails skip our verify step.
   */
  const handleAppleNativeSignUp = async () => {
    if (appleNativeBusy) return;
    setError("");
    setAppleNativeBusy(true);
    try {
      const plugin = window.Capacitor?.Plugins?.AppleSignIn;
      if (!plugin?.signIn) {
        setError(t("appleSignupFailed") || t("appleSigninFailed") || "Apple sign-up failed");
        return;
      }
      const res = await plugin.signIn();
      const idToken = res?.identityToken;
      if (!idToken) {
        setError(t("appleSignupFailed") || "Apple sign-up failed");
        return;
      }
      const name =
        [res.givenName, res.familyName].filter(Boolean).join(" ").trim() || null;
      await appleOauthLogin(idToken, name);
      navigate("/dashboard");
    } catch (err) {
      const code = err?.code || err?.errorMessage || "";
      if (code === "user_cancelled" || String(err?.message || "").includes("user_cancelled")) {
        return;
      }
      setError(errText(err, t("appleSignupFailed") || t("appleSigninFailed") || "Apple sign-up failed"));
    } finally {
      setAppleNativeBusy(false);
    }
  };

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
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  const navigate = useNavigate();
  // Apple Guideline 3.1.1 — the iOS app must NOT offer account registration
  // (sign-up is the on-ramp to an off-platform subscription). Native is
  // sign-in only; new businesses register on the web. Bounce any direct hit
  // on /register to the login screen.
  useEffect(() => {
    if (isNative) navigate("/login", { replace: true });
  }, [isNative, navigate]);
  const [form, setForm] = useState({
    email: "",
    password: "",
    business_name: "",
    business_type: "",
    currency: "DKK",
    // Anti-bot honeypot — visually-hidden input below. Real users
    // never see or touch this field; naive form-fillers populate every
    // visible-looking input and trigger a server-side rejection.
    website: "",
  });
  const [error, setError] = useState("");
  const [alreadyExists, setAlreadyExists] = useState(false);
  const [loading, setLoading] = useState(false);

  // ── Email-domain CVR autofill ──────────────────────────────────────
  // Watches the email field. When the domain looks like a real
  // company domain (.dk / .no / .co.uk), debounces a background CVR
  // search. If we find a match, shows a "Are you Mirabelle ApS?" banner
  // below the email input — one tap prefills business_name +
  // business_type + currency, and the CVR data is saved to the
  // BusinessProfile immediately after register so the new owner lands
  // on a fully-set-up profile with the Verified badge already showing.
  const [cvrSuggestions, setCvrSuggestions] = useState([]);  // up to 3 matches
  const [cvrSelected, setCvrSelected] = useState(null);      // applied suggestion
  const [cvrSearching, setCvrSearching] = useState(false);
  const [cvrDismissed, setCvrDismissed] = useState(false);
  const cvrTimer = useRef(null);

  // Map branchekode_inference.business_type → dropdown option value.
  // Direct match for most; workshop maps to closest dropdown option.
  const _BT_FROM_BRANCHEKODE = {
    restaurant: "restaurant",
    cafe:       "cafe",
    bar:        "bar",
    bakery:     "bakery",
    kiosk:      "kiosk",
    workshop:   "mobile_repair",  // closest dropdown match
    retail:     "retail",
  };

  // Country → currency default. Used when applying a CVR suggestion
  // to set the form's currency field correctly.
  const _CCY_FROM_COUNTRY = { DK: "DKK", NO: "NOK", GB: "GBP" };

  // Debounced lookup — fires when email looks like user@domain.tld.
  useEffect(() => {
    if (cvrDismissed) return;
    clearTimeout(cvrTimer.current);
    const m = /^[^\s@]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(form.email.trim());
    if (!m) { setCvrSuggestions([]); return; }
    const domain = m[1].toLowerCase();
    // Skip the obvious freemail providers — they yield no useful CVR
    const freemail = new Set([
      "gmail.com", "googlemail.com", "yahoo.com", "yahoo.dk", "yahoo.co.uk",
      "hotmail.com", "hotmail.dk", "outlook.com", "outlook.dk",
      "live.com", "live.dk", "icloud.com", "me.com", "protonmail.com",
      "proton.me", "msn.com", "aol.com", "mail.ru", "yandex.com",
    ]);
    if (freemail.has(domain)) { setCvrSuggestions([]); return; }
    // Country derived from TLD; default DK
    const tld = domain.split(".").pop();
    const country = tld === "no" ? "NO"
                  : (tld === "uk" || tld === "co" || domain.endsWith(".co.uk")) ? "GB"
                  : "DK";

    cvrTimer.current = setTimeout(async () => {
      setCvrSearching(true);
      try {
        const res = await api.get("/business/signup-lookup", {
          params: { domain, country },
        });
        setCvrSuggestions(Array.isArray(res.data) ? res.data : []);
      } catch {
        // Silent — never block signup. User just fills the form manually.
        setCvrSuggestions([]);
      } finally {
        setCvrSearching(false);
      }
    }, 700);

    return () => clearTimeout(cvrTimer.current);
  }, [form.email, cvrDismissed]);

  const applyCvrSuggestion = (sug) => {
    const inferredBt = sug?.branchekode_inference?.business_type;
    const mappedBt = inferredBt ? _BT_FROM_BRANCHEKODE[inferredBt] : "";
    const ccy = _CCY_FROM_COUNTRY[sug.country] || "DKK";
    setForm(f => ({
      ...f,
      business_name: sug.name || f.business_name,
      business_type: mappedBt || f.business_type,
      currency: ccy,
    }));
    setCvrSelected(sug);  // remember for post-register PUT /business
    setCvrSuggestions([]);  // collapse the suggestion strip
  };

  const dismissCvrSuggestion = () => {
    setCvrSuggestions([]);
    setCvrDismissed(true);
  };

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setAlreadyExists(false);
    // Client-side password validation (backend requires letters + digits)
    if (form.password.length < 8) {
      setError(t("pwMinLength"));
      return;
    }
    if (!/[a-zA-Z]/.test(form.password) || !/[0-9]/.test(form.password)) {
      setError(t("pwLetterNumber"));
      return;
    }
    // On native iOS, default business fields (Apple 3.1.1 compliance)
    const submitData = isNative
      ? { ...form, business_type: form.business_type || "personal", business_name: form.business_name || "My Dashboard" }
      : form;
    if (!isNative && !form.business_type) { setError(t("pleaseSelectType")); return; }
    setLoading(true);
    try {
      await register(submitData);

      // If the user accepted a CVR auto-fill suggestion, persist it
      // to BusinessProfile NOW (the auth session is active immediately
      // after register). This means the new owner lands on a fully
      // set-up profile with the "✓ Verified · cvrapi.dk · just now"
      // banner already showing. Failure is silent — they can still
      // re-enter on the Profile page later.
      if (cvrSelected) {
        try {
          await api.put("/business", {
            company_name: cvrSelected.name || submitData.business_name,
            org_number: cvrSelected.org_number || "",
            country: cvrSelected.country || "DK",
            address: cvrSelected.address || "",
            city: cvrSelected.city || "",
            zipcode: cvrSelected.zipcode || "",
            industry: cvrSelected.industry || "",
            industry_code: cvrSelected.industry_code || "",
            source: "cvrapi.dk",  // backend stamps cvr_verified_at on this signal
          });
        } catch { /* signup proceeds even if profile save fails */ }
      }

      // On native apps, skip email verification and go straight to dashboard
      if (isNative) {
        sessionStorage.setItem("skip_email_verify", "1");
        navigate("/dashboard");
      } else {
        navigate("/verify-email");
      }
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail;
      if (status === 429) {
        setError(t("tooManyAttempts"));
      } else if (status === 409 || detail === "Email already registered") {
        setAlreadyExists(true);
      } else if (status === 422 && Array.isArray(detail)) {
        // Pydantic validation errors — extract first readable message
        const first = detail[0] || {};
        const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : "";
        const msg = (first.msg || "Validation error").replace(/^Value error,\s*/, "");
        setError(field ? `${field}: ${msg}` : msg);
      } else if (typeof detail === "string") {
        setError(detail);
      } else {
        setError(err.code === "ECONNABORTED" || !err.response ? t("slowConnection") : t("registrationFailed"));
      }
    } finally {
      setLoading(false);
    }
  };

  // Native shell never renders the registration form — Apple 3.1.1. The
  // redirect above moves them to /login; this guard stops a one-frame flash.
  if (isNative) return null;

  return (
    <>
      <style>{`
        @keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        @keyframes twinkle { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.6); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      `}</style>

      <div className="min-h-screen flex bg-[#fafaf7] dark:bg-gray-950">
        {/* Left panel — minimalist Copenhagen-style copy, no illustration overload */}
        <div className="hidden lg:flex lg:w-1/2 items-center justify-center p-16 border-r border-gray-200/60 dark:border-gray-800">
          <div className="max-w-sm" style={{ animation: "fadeIn 0.8s ease-out" }}>
            <h2 className="text-[34px] font-semibold tracking-tight leading-[1.1] text-gray-900 dark:text-white">
              {t("startFreeTrial")}
            </h2>
            <p className="text-[15px] text-gray-600 dark:text-gray-400 mt-4 leading-relaxed">
              {t("trialDescription")}
            </p>
            <ul className="mt-8 space-y-3 text-[14px] text-gray-700 dark:text-gray-300">
              {[
                t("trialBenefit1"),
                t("trialBenefit2"),
                // trialBenefit3 names the founding subscription price; hidden
                // on native (Apple 3.1.1 — no subscription pricing in-app).
                ...(isNative ? [] : [t("trialBenefit3")]),
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <span className="mt-[7px] w-1 h-1 rounded-full bg-gray-400 dark:bg-gray-500 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Right panel — form */}
        <div className="flex-1 flex items-center justify-center px-6 py-10 overflow-y-auto">
          <div className="w-full max-w-md" style={{ animation: "slideUp 0.5s ease-out" }}>
            {/* Logo + heading */}
            <div className="mb-6">
              {/* Brand mark — emerald-600 tile per the "BRAND GREEN" token
                  contract. Same shape as the sidebar + landing logo so the
                  user sees the same brand mark across every entry surface. */}
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 bg-emerald-600 rounded-lg flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
                    <rect x="4" y="2" width="20" height="24" rx="3" stroke="currentColor"
                          className="text-white" strokeWidth="2.2"/>
                    <path d="M9 8h10M9 12h10M9 16h6" stroke="currentColor"
                          className="text-white" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
                <span className="text-xl font-bold text-gray-800 dark:text-white">BonBox</span>
              </div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t("createYourAccount")}</h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1.5">{t("registerSubheading")}</p>
            </div>

            {alreadyExists && (
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 p-4 rounded-xl mb-5 text-center" style={{ animation: "slideUp 0.3s ease-out" }}>
                <p className="text-sm text-blue-800 dark:text-blue-300 font-medium mb-2">{t("emailAlreadyRegistered")}</p>
                <Link to="/login" className="inline-block bg-gray-900 dark:bg-white text-white dark:text-gray-900 px-4 py-2 rounded-lg text-[13px] font-medium hover:bg-gray-800 dark:hover:bg-gray-100 transition">
                  {t("signInInstead")}
                </Link>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3.5 rounded-xl mb-5 text-sm" style={{ animation: "slideUp 0.3s ease-out" }}>
                <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* ── Task #65 — OAuth row (Apple + Google) ─────────────
                Placed above the form so third-party sign-up is the
                dominant choice (mirrors the LoginPage layout). Each
                button no-ops cleanly when its env var is unset. */}
            {(hasAppleWeb || hasAppleNative || hasGoogle) && (
              <div className="mb-5 space-y-2.5">
                {hasAppleNative && (
                  // Task #90 — native iOS SIWA. Same visual treatment as
                  // the web button so the OAuth row reads consistently.
                  <button
                    type="button"
                    onClick={handleAppleNativeSignUp}
                    disabled={appleNativeBusy}
                    aria-label={t("signUpWithApple") || "Sign up with Apple"}
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
                    <span>{appleNativeBusy ? "…" : (t("signUpWithApple") || "Sign up with Apple")}</span>
                  </button>
                )}
                {hasAppleWeb && (
                  <AppleSignInButton
                    clientId={APPLE_CLIENT_ID_WEB}
                    label={t("signUpWithApple") || "Sign up with Apple"}
                    mode="signup"
                    onSuccess={async ({ idToken, name }) => {
                      setError("");
                      try {
                        await appleOauthLogin(idToken, name);
                        navigate("/dashboard");
                      } catch (err) {
                        setError(errText(err, t("appleSignupFailed") || t("appleSigninFailed") || "Apple sign-up failed"));
                      }
                    }}
                    onError={(msg) =>
                      setError(msg || t("appleSignupFailed") || "Apple sign-up failed")
                    }
                  />
                )}
                {hasGoogle && (
                  <div ref={googleWrap} className="flex justify-center [&>div]:w-full overflow-hidden">
                    <GoogleLogin
                      onSuccess={(res) => {
                        setError("");
                        const fn = googleOauthLogin || googleLogin;
                        fn(res.credential)
                          .then(() => navigate("/dashboard"))
                          .catch((err) => setError(errText(err, t("googleSignupFailed"))));
                      }}
                      onError={() => setError(t("googleSignupFailed"))}
                      shape="rectangular"
                      size="large"
                      width={String(googleWidth)}
                      text="signup_with"
                      theme={typeof window !== "undefined" && document.documentElement.classList.contains("dark") ? "filled_black" : "outline"}
                    />
                  </div>
                )}
                <div className="flex items-center gap-3 pt-2">
                  <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                  <span className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
                    {t("orUseEmail") || "or use email"}
                  </span>
                  <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Honeypot — visually hidden + aria-hidden + tabindex=-1.
                  Real users never see, focus, or fill this. Bots that
                  scrape the DOM and fill every input populate this and
                  get rejected server-side with a generic 422. */}
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: "-9999px",
                  width: "1px",
                  height: "1px",
                  overflow: "hidden",
                  opacity: 0,
                  pointerEvents: "none",
                }}
              >
                <label htmlFor="website-confirm">
                  Your website (leave blank — anti-spam)
                </label>
                <input
                  type="text"
                  id="website-confirm"
                  name="website"
                  value={form.website}
                  onChange={handleChange}
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t("email")}</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                  </span>
                  <input type="email" name="email" value={form.email} onChange={handleChange}
                    placeholder="you@company.com" className={inputCls} required />
                </div>

                {/* CVR auto-detect suggestion — only on web (skip in
                    native iOS for App Store compliance / friction). */}
                {!isNative && (cvrSearching || cvrSuggestions.length > 0 || cvrSelected) && (
                  <div className="mt-2">
                    {cvrSearching && (
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 px-2">
                        🎯 {t("cvrSignupSearching") || "Looking up your company in CVR…"}
                      </p>
                    )}

                    {/* Selected — show a confirmation chip */}
                    {cvrSelected && (
                      <div className="px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 text-xs flex items-center gap-2">
                        <span className="text-emerald-600">✓</span>
                        <span className="text-gray-700 dark:text-gray-300 flex-1">
                          {t("cvrSignupApplied") || "Auto-filled from"}{" "}
                          <strong>{cvrSelected.name}</strong>
                          {cvrSelected.org_number && (
                            <span className="ml-1 opacity-70">· CVR {cvrSelected.org_number}</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => { setCvrSelected(null); setCvrDismissed(true); }}
                          className="text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
                        >
                          {t("cvrSignupClear") || "Clear"}
                        </button>
                      </div>
                    )}

                    {/* Active suggestions strip */}
                    {!cvrSelected && cvrSuggestions.length > 0 && (
                      <div className="px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-xs space-y-2">
                        <p className="text-blue-700 dark:text-blue-300 font-semibold">
                          🎯 {t("cvrSignupTitle") || "Found a match in the company register"}
                        </p>
                        <div className="space-y-1.5">
                          {cvrSuggestions.map((s, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => applyCvrSuggestion(s)}
                              className="block w-full text-left px-2.5 py-1.5 rounded bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-700 hover:border-blue-500 transition"
                            >
                              <p className="font-semibold text-gray-800 dark:text-gray-200">
                                {s.name}
                                {s.org_number && (
                                  <span className="ml-2 text-[10px] font-normal text-gray-500">CVR {s.org_number}</span>
                                )}
                              </p>
                              {s.address && (
                                <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate">{s.address}</p>
                              )}
                              {s.industry && (
                                <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-0.5">{s.industry}</p>
                              )}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={dismissCvrSuggestion}
                          className="text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
                        >
                          {t("cvrSignupNotMine") || "None of these — I'll type manually"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t("password")}</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                  </span>
                  <input type="password" name="password" value={form.password} onChange={handleChange}
                    placeholder={t("regPasswordPlaceholder", "8+ characters with letters and numbers")} className={inputCls} required
                    minLength={8} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{isNative ? t("displayName") : (form.business_type === "personal" ? t("displayName") : t("businessName"))}</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                  </span>
                  <input type="text" name="business_name" value={form.business_name} onChange={handleChange}
                    placeholder={t("businessNamePlaceholder")} className={inputCls} required />
                </div>
              </div>
              {/* Hide business type/currency on native iOS (Apple 3.1.1 compliance) */}
              {!isNative && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t("businessType")}</label>
                  <select name="business_type" value={form.business_type} onChange={handleChange}
                    className={selectCls} required>
                    <option value="" disabled>{t("selectType")}</option>
                    <optgroup label={t("foodAndDrink")}>
                      <option value="restaurant">{t("btRestaurant")}</option>
                      <option value="cafe">{t("btCafe")}</option>
                      <option value="bar">{t("btBar")}</option>
                      <option value="bakery">{t("btBakery")}</option>
                      <option value="takeaway">{t("btTakeaway")}</option>
                      <option value="food_truck">{t("btFoodTruck")}</option>
                      <option value="tea_shop">{t("btTeaShop")}</option>
                    </optgroup>
                    <optgroup label={t("retail")}>
                      <option value="clothing">{t("btClothing")}</option>
                      <option value="online_clothing">{t("btOnlineClothing")}</option>
                      <option value="grocery">{t("btGrocery")}</option>
                      <option value="veggie_shop">{t("btVeggieShop")}</option>
                      <option value="kiosk">{t("btKiosk")}</option>
                      <option value="electronics">{t("btElectronics")}</option>
                      <option value="pharmacy">{t("btPharmacy")}</option>
                      <option value="cosmetics">{t("btCosmetics")}</option>
                      <option value="stationery">{t("btStationery")}</option>
                      <option value="hardware">{t("btHardware")}</option>
                      <option value="flower_shop">{t("btFlowerShop")}</option>
                      <option value="jewelry">{t("btJewelry")}</option>
                      <option value="thrift">{t("btThrift")}</option>
                    </optgroup>
                    <optgroup label={t("services")}>
                      <option value="salon">{t("btSalon")}</option>
                      <option value="mobile_repair">{t("btMobileRepair")}</option>
                      <option value="laundry">{t("btLaundry")}</option>
                    </optgroup>
                    <optgroup label={t("other")}>
                      <option value="retail">{t("btGeneralRetail")}</option>
                      <option value="wholesale">{t("btWholesale")}</option>
                      <option value="personal">{t("personalFinance")}</option>
                      <option value="other">{t("other")}</option>
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">{t("currency")}</label>
                  <select name="currency" value={form.currency} onChange={handleChange} className={selectCls}>
                    <option value="DKK">{t("currDKK")}</option>
                    <option value="EUR">{t("currEUR")}</option>
                    <option value="SEK">{t("currSEK")}</option>
                    <option value="NOK">{t("currNOK")}</option>
                    <option value="USD">{t("currUSD")}</option>
                    <option value="GBP">{t("currGBP")}</option>
                  </select>
                </div>
              </div>
              )}

              {/* Create-account primary CTA — emerald-600 (brand-green).
                  Marketing surface, so it earns the saturated brand mark
                  (mirror of /register on landing's hero CTA). */}
              <button type="submit" disabled={loading}
                className="w-full bg-emerald-600 text-white py-2.5 rounded-lg
                  text-[14px] font-medium hover:bg-emerald-700
                  disabled:opacity-60 disabled:cursor-not-allowed
                  flex items-center justify-center gap-2 mt-2 transition">
                {loading ? (
                  <>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                    {t("creatingAccount")}
                  </>
                ) : t("createAccount")}
              </button>
            </form>

            {/* OAuth providers (Apple + Google) live ABOVE the form
                now — see the OAuth row injected before <form> above.
                The legacy /auth/apple iOS Capacitor button is still
                wired through `appleLogin()` in useAuth for when the
                plugin ships a Cap-8 release. */}

            <p className="mt-5 text-center text-sm text-gray-500 dark:text-gray-400">
              {t("alreadyHaveAccount")}{" "}
              <Link to="/login" className="text-gray-900 dark:text-white font-medium underline-offset-2 hover:underline">{t("signIn")}</Link>
            </p>

            <div className="mt-6 flex justify-center">
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                aria-label={t("regLanguageLabel", "Language")}
                className="text-[12px] bg-transparent border border-gray-200 dark:border-gray-700 rounded-md px-2.5 py-1
                  text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500
                  focus:outline-none focus:ring-2 focus:ring-gray-900 cursor-pointer"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} className="bg-white dark:bg-gray-900">
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
