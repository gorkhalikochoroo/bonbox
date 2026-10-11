import { useState, useRef, useEffect } from "react";
import { useNavigate, Link, useLocation, Navigate } from "react-router-dom";
import { Check } from "lucide-react";
import api from "../services/api";
import { oauthErrText } from "../utils/errText";
import { authErrorKey } from "../utils/authErrors";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import usePageTitle from "../hooks/usePageTitle";
// Push 6 — Google's button drawn in the page's language (GoogleButton.jsx).
import GoogleButton from "../components/GoogleButton";
// Task #65 — Apple Sign-In button (web). Self-renders nothing when
// VITE_APPLE_CLIENT_ID is unset, so dev builds stay quiet.
import AppleSignInButton from "../components/AppleSignInButton";
// Release R-e — "Ved at oprette en konto accepterer du vores
// Handelsbetingelser. Læs om, hvordan vi behandler dine data, i vores
// Privatlivspolitik." (LEG-11 / PQ-03).
import SignupTermsLine from "../components/SignupTermsLine";
import { rememberVerifySkip, postLoginPath } from "../utils/verifySkip";
import { homeFor } from "../lib/appMode";
import { emailProblem, passwordState } from "../utils/signupValidation";
import AuthShell, {
  AuthAlert, AuthDivider, AuthHeading, FieldError, FieldLabel, PasswordInput, PrimaryButton,
} from "../components/auth/AuthUI";
import { PRIMARY, inputClass, linkClass } from "../components/auth/authStyles";

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

export default function RegisterPage() {
  const { register, googleLogin, googleOauthLogin, appleOauthLogin, user, loading: authLoading } = useAuth();
  // True from the moment THIS page starts making the account (e-mail form,
  // Google, Apple): the signed-in guard below is for owners who ARRIVE here
  // signed in, never for the account this page has just made — that one
  // goes on to /verify-email (or /dashboard) by the page's own navigate.
  const [signingUpHere, setSigningUpHere] = useState(false);
  // Sign-in surface differs per platform:
  //   • Web:    Google (Google's own button, drawn by GoogleButton) + Apple JS SDK
  //   • iOS:    Apple via our in-project Capacitor plugin (Task #90 —
  //             ios/App/App/AppleSignInPlugin.swift). Google on iOS still
  //             needs a separate native Capacitor plugin since the web
  //             Google flow doesn't work inside WKWebView;
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
    setError(null);
    setAppleNativeBusy(true);
    try {
      const plugin = window.Capacitor?.Plugins?.AppleSignIn;
      if (!plugin?.signIn) {
        setError({ text: t("appleSignupFailed") || t("appleSigninFailed") || "Apple sign-up failed" });
        return;
      }
      const res = await plugin.signIn();
      const idToken = res?.identityToken;
      if (!idToken) {
        setError({ text: t("appleSignupFailed") || "Apple sign-up failed" });
        return;
      }
      const name =
        [res.givenName, res.familyName].filter(Boolean).join(" ").trim() || null;
      setSigningUpHere(true);
      await appleOauthLogin(idToken, name);
      navigate("/dashboard");
    } catch (err) {
      setSigningUpHere(false);
      const code = err?.code || err?.errorMessage || "";
      if (code === "user_cancelled" || String(err?.message || "").includes("user_cancelled")) {
        return;
      }
      setError({ text: oauthErrText(err, t("appleSignupFailed") || t("appleSigninFailed") || "Apple sign-up failed", t) });
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
  const { t, lang } = useLanguage();
  usePageTitle("suTitleRegister");
  const navigate = useNavigate();
  const location = useLocation();
  // Apple Guideline 3.1.1 — the iOS app must NOT offer account registration
  // (sign-up is the on-ramp to an off-platform subscription). Native is
  // sign-in only; new businesses register on the web. Bounce any direct hit
  // on /register to the login screen.
  useEffect(() => {
    if (isNative) navigate("/login", { replace: true });
  }, [isNative, navigate]);

  // Push 6 — an address typed on /login ("Opret konto") comes along as router
  // state, never in the URL.
  const handedEmail = typeof location.state?.email === "string" ? location.state.email.trim() : "";
  // ?plan=starter|pro from the landing's price table — not personal data.
  const plan = new URLSearchParams(location.search).get("plan");
  const planNoteKey = isNative ? null : plan === "starter" ? "suPlanStarterNote" : plan === "pro" ? "suPlanProNote" : null;

  // Three typed inputs (push 6, B1). Business type and currency are no
  // longer asked here: the wizard asks the type (OnboardingPage, step 2) and
  // DKK is the default. The CVR suggestion below still fills both when it
  // knows them (type from the branchekode, NOK/GBP from the country).
  const [form, setForm] = useState({
    email: handedEmail,
    password: "",
    business_name: "",
    business_type: "",
    currency: "DKK",
    // Anti-bot honeypot — visually-hidden input below. Real users
    // never see or touch this field; naive form-fillers populate every
    // visible-looking input and trigger a server-side rejection.
    website: "",
  });
  // { key, vars } for a line from the dictionary, { text } for one already
  // in the owner's language (the Google/Apple helpers).
  const [error, setError] = useState(null);
  // The "this e-mail already has an account" panel: the key to show.
  const [existsKey, setExistsKey] = useState(null);
  const [loading, setLoading] = useState(false);
  // "Langsom forbindelse — arbejder stadig på det…" — only once a request
  // has really been on its way for 8 s, and only while it still is.
  const [slow, setSlow] = useState(false);
  // An earlier attempt in this page session got no answer: a 409 now most
  // likely means that attempt DID create the account.
  const noAnswerBefore = useRef(false);
  // The answer to "Opret konto" that is not about one field (the "already
  // has an account" panel, offline, too many tries, a server error) renders
  // ABOVE the form. On a phone the owner has scrolled down to the button, so
  // it would land off screen and only the spinner would come and go: bring
  // it into view and give it the focus (tabIndex -1). A field's own message
  // already moves the focus to that field.
  const answerRef = useRef(null);
  const [answerSeq, setAnswerSeq] = useState(0);
  useEffect(() => {
    if (!answerSeq) return;
    const el = answerRef.current;
    if (!el) return;
    try { el.scrollIntoView?.({ block: "center" }); } catch { /* old engines: the focus below still scrolls it into view */ }
    try { el.focus({ preventScroll: true }); } catch { el.focus?.(); }
  }, [answerSeq]);

  // Inline validation: on blur first, then live once a field was touched.
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [pwFocused, setPwFocused] = useState(false);
  // What the server said about one field ({ email: "suErrDomain" }, …).
  const [serverField, setServerField] = useState({});
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const nameRef = useRef(null);

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

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (serverField[name]) setServerField((s) => ({ ...s, [name]: null }));
    if (name === "email" && existsKey) setExistsKey(null);
  };
  // Leaving a field the owner has typed in checks it; tabbing past an empty
  // one says nothing yet (that waits for "Opret konto").
  const touch = (name) => {
    if (!String(form[name] || "").trim()) return;
    setTouched((s) => (s[name] ? s : { ...s, [name]: true }));
  };

  // The three fields' messages, from what is typed now.
  const emailKey = serverField.email || ((touched.email || submitted) ? emailProblem(form.email) : null);
  const nameKey = serverField.business_name ||
    ((touched.business_name || submitted) && !form.business_name.trim() ? "suErrBusinessNameEmpty" : null);
  const pw = passwordState(form.password);
  // Red only once the owner has left the field (or pressed Opret konto) —
  // never while they are still typing in it.
  const pwInvalid = !!serverField.password || ((touched.password || submitted) && !pw.ok);
  const pwRed = !!serverField.password || (pwInvalid && !pwFocused);
  const pwLine = serverField.password ? { key: serverField.password } : pw;
  const pwTone = pwRed
    ? "text-red-700 dark:text-red-400"
    : pw.ok
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-gray-600 dark:text-gray-400";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setExistsKey(null);
    setSubmitted(true);
    // The first field that is not right yet gets the focus; its message is
    // under it (no wall of errors at the top).
    const firstBad = emailProblem(form.email)
      ? emailRef
      : !pw.ok
        ? passwordRef
        : !form.business_name.trim()
          ? nameRef
          : null;
    if (firstBad) {
      firstBad.current?.focus();
      return;
    }
    // On native iOS, default business fields (Apple 3.1.1 compliance)
    // `ui_language` — the language this form is shown in. The server writes
    // the verification code and welcome mails in it (a Danish signup used to
    // get both in English) and saves it as the account's app language.
    // accept_terms — this page shows the Terms acceptance line
    // (SignupTermsLine) wherever its sign-up buttons are, so the server records
    // the Terms version on the new account (backend services/terms.py).
    //
    // business_type is LEFT OUT when the owner was not asked (push 6): the
    // server's default "restaurant" is the food-service archetype with the
    // 06:00 business-day cutoff. Sending "" would stamp the generic archetype
    // with a midnight cutoff on the new profile, and the wizard's re-apply
    // does not overwrite a non-default value.
    const { business_type: chosenType, ...rest } = form;
    const base = { ...rest, email: form.email.trim(), business_name: form.business_name.trim() };
    const submitData = isNative
      ? { ...form, business_type: form.business_type || "personal", business_name: form.business_name || "My Dashboard", ui_language: lang, accept_terms: true }
      : { ...base, ...(chosenType ? { business_type: chosenType } : {}), ui_language: lang, accept_terms: true };
    setLoading(true);
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 8000);
    setSigningUpHere(true);
    try {
      const res = await register(submitData);

      // Not asked for a type, and the CVR suggestion did not know one: the
      // wizard asks (OnboardingPage reads this flag for this account only).
      if (!isNative && !submitData.business_type && res?.user?.id != null) {
        try { localStorage.setItem("bonbox_type_unasked", String(res.user.id)); } catch { /* storage blocked: the wizard keeps restaurant preselected */ }
      }

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
        // …and for the next 7 days, so the wall does not meet them on the
        // app's next launch either (utils/verifySkip).
        rememberVerifySkip(res?.user?.id);
        navigate("/dashboard");
      } else {
        navigate("/verify-email");
      }
    } catch (err) {
      setSigningUpHere(false);
      // Every answer becomes a Danish (or English) line with a next step —
      // never the server's English (utils/authErrors.js).
      const r = authErrorKey(err, "register", { timedOut: noAnswerBefore.current });
      if (r.network) noAnswerBefore.current = true;
      if (r.action === "login") {
        setExistsKey(r.key);
        setAnswerSeq((n) => n + 1);
      } else if (r.field === "email" || r.field === "password" || r.field === "business_name") {
        setServerField({ [r.field]: r.key });
        const ref = r.field === "email" ? emailRef : r.field === "password" ? passwordRef : nameRef;
        ref.current?.focus();
      } else {
        setError({ key: r.key, vars: r.vars });
        setAnswerSeq((n) => n + 1);
      }
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      setLoading(false);
    }
  };

  // Native shell never renders the registration form — Apple 3.1.1. The
  // redirect above moves them to /login; this guard stops a one-frame flash.
  if (isNative) return null;

  // Already signed in (web): the back button from /verify-email — the natural
  // "wrong e-mail" gesture — used to show a blank sign-up form, and sending it
  // made a SECOND account while the first (typo) one was left behind, its
  // address already mailed a code. An owner who still has to confirm goes to
  // /verify-email (where "Forkert e-mail? Ret den" fixes the address on the
  // same account); everyone else goes to their app, exactly where the app's
  // own guards would send them. Replace, so back does not loop. Checked once
  // the session probe is done; until then the form shows as before.
  if (!authLoading && user && !signingUpHere) {
    // postLoginPath: the wall's own rule (grace date, revisor, 7-day skip).
    const dest = postLoginPath(user);
    return <Navigate to={dest === "/verify-email" ? dest : homeFor(user)} replace />;
  }

  // Release R-c placed the documents ONCE, where every sign-up path passes
  // them; release R-e turns that line into the Terms acceptance line
  // (SignupTermsLine): beside the Google / Apple row (those create the
  // account without the form), or under "Opret konto" when there is no
  // such row. Every request this page sends carries accept_terms=true.
  const hasOAuthRow = hasAppleWeb || hasAppleNative || hasGoogle;
  const typedEmail = form.email.trim();

  // Desktop only: what the trial is, in three true lines (push 6). The
  // founding-price line is hidden on native (Apple 3.1.1 — no subscription
  // pricing in-app); native never reaches this page anyway.
  const aside = (
    <aside className="hidden lg:flex lg:w-[46%] items-center justify-center px-16 py-16 border-r border-bb-line/30 dark:border-gray-800">
      <div className="max-w-sm">
        <h2 className="text-[30px] font-semibold tracking-tight leading-[1.15] text-balance text-gray-900 dark:text-white">
          {t("suPanelHeading")}
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-gray-600 dark:text-gray-400">
          {t("suPanelBody")}
        </p>
        <ul className="mt-8 space-y-3.5 text-[15px] leading-relaxed text-gray-800 dark:text-gray-200">
          {[
            t("suPanelBenefit1"),
            t("suPanelBenefit2"),
            ...(isNative ? [] : [t("trialBenefit3")]),
          ].map((item) => (
            <li key={item} className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-[9px] w-1.5 h-1.5 rounded-full bg-bb-forest dark:bg-emerald-400 shrink-0" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );

  return (
    <AuthShell aside={aside} language>
      <AuthHeading
        title={t("createYourAccount")}
        // Web: the door question first ("koster det noget, skal jeg give kort?") —
        // shown on phones too, where the trial panel is hidden. Native
        // keeps a price-free line (Apple 3.1.1).
        sub={t(isNative ? "registerSubheading" : "registerSubheadingWeb")}
      >
        {planNoteKey && (
          <p data-testid="register-plan-note" className="mt-2 text-[14px] leading-relaxed text-gray-600 dark:text-gray-400">
            {t(planNoteKey)}
          </p>
        )}
      </AuthHeading>

      {existsKey && (
        <div
          ref={answerRef}
          tabIndex={-1}
          role="alert"
          data-testid="register-exists"
          className="mt-6 rounded-lg border border-bb-line/70 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 focus:outline-none"
        >
          <p className="text-[15px] leading-relaxed text-gray-900 dark:text-gray-100">{t(existsKey)}</p>
          <Link to="/login" state={{ email: typedEmail }} className={`${PRIMARY.forest} mt-3`}>
            {t("signInInstead")}
          </Link>
          <p className="mt-3 text-center text-[14px]">
            <Link to="/forgot-password" state={{ prefillEmail: typedEmail }} className={linkClass}>
              {t("suForgotQ")}
            </Link>
          </p>
        </div>
      )}
      {error && (
        <AuthAlert ref={existsKey ? undefined : answerRef} tabIndex={-1} className="mt-6">
          {error.key ? t(error.key, error.vars) : error.text}
        </AuthAlert>
      )}

      {/* ── Task #65 — OAuth row (Apple + Google) ─────────────
          Placed above the form so third-party sign-up is the
          dominant choice (mirrors the LoginPage layout). Each
          button no-ops cleanly when its env var is unset. */}
      {hasOAuthRow && (
        <div className="mt-6 space-y-2.5">
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
                setError(null);
                setSigningUpHere(true);
                try {
                  await appleOauthLogin(idToken, name, { acceptTerms: true });
                  navigate("/dashboard");
                } catch (err) {
                  setSigningUpHere(false);
                  setError({ text: oauthErrText(err, t("appleSignupFailed") || t("appleSigninFailed") || "Apple sign-up failed", t) });
                }
              }}
              onError={(msg) =>
                setError({ text: msg || t("appleSignupFailed") || "Apple sign-up failed" })
              }
            />
          )}
          {hasGoogle && (
            <div ref={googleWrap} className="flex justify-center [&>div]:w-full overflow-hidden">
              <GoogleButton
                onSuccess={(res) => {
                  setError(null);
                  setSigningUpHere(true);
                  const fn = googleOauthLogin || googleLogin;
                  fn(res.credential, { acceptTerms: true })
                    .then(() => navigate("/dashboard"))
                    .catch((err) => {
                      setSigningUpHere(false);
                      setError({ text: oauthErrText(err, t("googleSignupFailed"), t) });
                    });
                }}
                onError={() => setError({ text: t("googleSignupFailed") })}
                width={googleWidth}
                text="signup_with"
                theme={typeof window !== "undefined" && document.documentElement.classList.contains("dark") ? "filled_black" : "outline"}
              />
            </div>
          )}
          {/* Release R-e — the Terms acceptance line, beside the
              Google/Apple row: those buttons create the account
              without the form, so the line must be seen here. It also
              covers the e-mail form below — it renders once. (It
              replaces R-c's informational "Læs vores …" line.) The auth
              shell gives its two links a taller hit area and the line
              gray-600 for contrast; words and place unchanged. */}
          <SignupTermsLine isNative={isNative} className="pt-1" />
          <div className="pt-3">
            <AuthDivider label={t("orUseEmail") || "or use email"} />
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className={`${hasOAuthRow ? "mt-5" : "mt-6"} space-y-4`}>
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
          <FieldLabel htmlFor="su-email">{t("email")}</FieldLabel>
          <input
            ref={emailRef}
            id="su-email"
            type="email"
            name="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            value={form.email}
            onChange={handleChange}
            onBlur={() => touch("email")}
            placeholder={t("emailPlaceholder", "you@company.com")}
            aria-invalid={emailKey ? true : undefined}
            aria-describedby={emailKey ? "su-email-error" : undefined}
            className={inputClass(!!emailKey)}
          />
          <FieldError id="su-email-error">{emailKey ? t(emailKey) : null}</FieldError>

          {/* CVR auto-detect suggestion — only on web (skip in
              native iOS for App Store compliance / friction). */}
          {!isNative && (cvrSearching || cvrSuggestions.length > 0 || cvrSelected) && (
            <div className="mt-2">
              {cvrSearching && (
                <p className="text-[13px] text-gray-600 dark:text-gray-400 px-0.5" role="status">
                  {t("cvrSignupSearching") || "Looking up your company in CVR…"}
                </p>
              )}

              {/* Selected — show a confirmation chip */}
              {cvrSelected && (
                <div className="px-3 py-2 rounded-lg bg-white dark:bg-gray-900 border border-bb-line/70 dark:border-gray-700 text-[13px] flex items-center gap-2">
                  <Check aria-hidden="true" className="w-4 h-4 text-emerald-700 dark:text-emerald-400 shrink-0" strokeWidth={2} />
                  <span className="text-gray-800 dark:text-gray-200 flex-1 min-w-0">
                    {t("cvrSignupApplied") || "Auto-filled from"}{" "}
                    <strong className="font-semibold">{cvrSelected.name}</strong>
                    {cvrSelected.org_number && (
                      <span className="ml-1 text-gray-600 dark:text-gray-400">· CVR {cvrSelected.org_number}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setCvrSelected(null); setCvrDismissed(true); }}
                    className="text-[13px] text-gray-700 dark:text-gray-300 underline underline-offset-4 decoration-gray-400 hover:text-gray-900"
                  >
                    {t("cvrSignupClear") || "Clear"}
                  </button>
                </div>
              )}

              {/* Active suggestions strip */}
              {!cvrSelected && cvrSuggestions.length > 0 && (
                <div className="p-3 rounded-lg bg-white dark:bg-gray-900 border border-bb-line/70 dark:border-gray-700 text-[13px] space-y-2">
                  <p className="font-semibold text-gray-900 dark:text-gray-100">
                    {t("cvrSignupTitle") || "Found a match in the company register"}
                  </p>
                  <div className="space-y-1.5">
                    {cvrSuggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => applyCvrSuggestion(s)}
                        className="block w-full text-left px-3 py-2 rounded-md bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 hover:border-bb-forest dark:hover:border-gray-300 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bb-forest"
                      >
                        <p className="font-semibold text-gray-900 dark:text-gray-100">
                          {s.name}
                          {s.org_number && (
                            <span className="ml-2 text-[12px] font-normal text-gray-600 dark:text-gray-400">CVR {s.org_number}</span>
                          )}
                        </p>
                        {s.address && (
                          <p className="text-[12px] text-gray-600 dark:text-gray-400 truncate">{s.address}</p>
                        )}
                        {s.industry && (
                          <p className="text-[12px] text-gray-600 dark:text-gray-400 mt-0.5">{s.industry}</p>
                        )}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={dismissCvrSuggestion}
                    className="text-[13px] text-gray-700 dark:text-gray-300 underline underline-offset-4 decoration-gray-400 hover:text-gray-900"
                  >
                    {t("cvrSignupNotMine") || "None of these — I'll type manually"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <FieldLabel htmlFor="su-password">{t("password")}</FieldLabel>
          <PasswordInput
            ref={passwordRef}
            id="su-password"
            name="password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={handleChange}
            onFocus={() => setPwFocused(true)}
            onBlur={() => { setPwFocused(false); touch("password"); }}
            aria-invalid={pwInvalid ? true : undefined}
            aria-describedby="su-password-hint"
            invalid={pwRed}
          />
          {/* Always there, so the form never jumps: the rule while it is
              not met, then "Klar" — red only after leaving the field. */}
          <p
            id="su-password-hint"
            className={`mt-1.5 min-h-[18px] text-[13px] leading-snug ${pwTone}`}
            {...(pwRed ? { role: "alert" } : {})}
          >
            {t(pwLine.key, pwLine.vars)}
          </p>
        </div>
        <div>
          <FieldLabel htmlFor="su-business-name">{t("businessName")}</FieldLabel>
          <input
            ref={nameRef}
            id="su-business-name"
            type="text"
            name="business_name"
            autoComplete="organization"
            autoCapitalize="words"
            required
            value={form.business_name}
            onChange={handleChange}
            onBlur={() => touch("business_name")}
            placeholder={t("suBusinessNamePlaceholder")}
            aria-invalid={nameKey ? true : undefined}
            aria-describedby={nameKey ? "su-business-name-error" : undefined}
            className={inputClass(!!nameKey)}
          />
          <FieldError id="su-business-name-error">{nameKey ? t(nameKey) : null}</FieldError>
        </div>

        <PrimaryButton loading={loading} loadingLabel={t("suCreating")} className="mt-2">
          {t("suCreateAccount")}
        </PrimaryButton>
        {/* Release R-e — with no Google/Apple row, the Terms acceptance
            line sits under "Opret konto" instead (it renders once). */}
        {!(hasAppleWeb || hasAppleNative || hasGoogle) && (
          <SignupTermsLine isNative={isNative} className="-mt-1" />
        )}
        {/* While the request is out: after 8 s, say the connection is slow
            (true at that moment — it is still on its way). */}
        {loading && slow && (
          <p role="status" className="text-center text-[13px] text-gray-600 dark:text-gray-400">
            {t("slowConnection")}
          </p>
        )}
      </form>

      {/* OAuth providers (Apple + Google) live ABOVE the form
          now — see the OAuth row injected before <form> above.
          The legacy /auth/apple iOS Capacitor button is still
          wired through `appleLogin()` in useAuth for when the
          plugin ships a Cap-8 release. */}

      <p className="mt-6 text-center text-[14px] text-gray-600 dark:text-gray-400">
        {t("alreadyHaveAccount")}{" "}
        <Link to="/login" state={{ email: typedEmail }} className={`${linkClass} font-medium`}>
          {t("suSignInLink")}
        </Link>
      </p>
    </AuthShell>
  );
}
