import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import usePageTitle from "../hooks/usePageTitle";
import { authErrorKey } from "../utils/authErrors";
import { emailProblem } from "../utils/signupValidation";
import AuthShell, {
  AuthAlert, AuthHeading, AuthNote, FieldError, FieldLabel, PasswordInput, PrimaryButton,
} from "../components/auth/AuthUI";
import { PRIMARY, inputClass, linkClass } from "../components/auth/authStyles";

export default function ForgotPasswordPage() {
  const { t } = useLanguage();
  usePageTitle("suTitleForgot");
  const location = useLocation();
  const navigate = useNavigate();
  // Arrived from "Vælg en ny adgangskode" right after securing the account
  // (LoginMagicPage): the address comes as router state — never in the URL —
  // and the code is sent at once, so only the code and the new password
  // are left to type.
  const handedEmail = typeof location.state?.email === "string" ? location.state.email.trim() : "";
  // Push 6 — "Glemt?" on /login, "Lav en ny adgangskode" after a wrong
  // password, "Glemt adgangskoden?" on /register and Profile's delete hint
  // only FILL IN the address (prefillEmail): nothing is mailed until the
  // owner presses the button.
  const prefilledEmail = typeof location.state?.prefillEmail === "string" ? location.state.prefillEmail.trim() : "";
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState(handedEmail || prefilledEmail);
  const [emailErr, setEmailErr] = useState(null);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // { key, vars } — every message is a dictionary line (utils/authErrors);
  // the server's English never reaches the page.
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const emailRef = useRef(null);

  const requestCode = async (address) => {
    setError(null);
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: address });
      setStep(2);
    } catch (err) {
      const r = authErrorKey(err, "forgot");
      if (r.field === "email") {
        setEmailErr(r.key);
        emailRef.current?.focus();
      } else {
        setError({ key: r.key, vars: r.vars });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRequestReset = async (e) => {
    e?.preventDefault?.();
    const problem = emailProblem(email);
    if (problem) {
      setEmailErr(problem);
      emailRef.current?.focus();
      return;
    }
    setEmailErr(null);
    await requestCode(email.trim());
  };

  // One code per hand-over: the state is dropped at once, so a reload (or
  // React's double effect in development) does not mail a second code.
  const sentForHandOver = useRef(false);
  useEffect(() => {
    if (!handedEmail || sentForHandOver.current) return;
    sentForHandOver.current = true;
    navigate(location.pathname, { replace: true, state: null });
    requestCode(handedEmail);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError({ key: "passwordsDontMatch" });
      return;
    }
    if (newPassword.length < 8) {
      setError({ key: "passwordMinLength" });
      return;
    }
    setLoading(true);
    try {
      // The server's own "message" is English and is not shown: the page
      // says suResetDone in the owner's language.
      await api.post("/auth/reset-password", {
        email: email.trim(),
        reset_token: code,
        new_password: newPassword,
      });
      setStep(3);
    } catch (err) {
      const r = authErrorKey(err, "reset");
      setError({ key: r.key, vars: r.vars });
    } finally {
      setLoading(false);
    }
  };

  const typedEmail = email.trim();

  return (
    <AuthShell>
      <AuthHeading
        title={t("fpResetPasswordTitle", "Reset password")}
        sub={step === 1 ? t("forgotPwStep1") : step === 2 ? t("forgotPwStep2") : t("fpAllSet", "You're all set!")}
      />

      {/* Step indicator */}
      <div className="flex items-center gap-2 mt-6" aria-hidden="true">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors duration-150 ${
              step >= s
                ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                : "bg-white border border-bb-line text-gray-600 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-400"
            }`}>
              {step > s ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
              ) : s}
            </div>
            {s < 3 && <div className={`flex-1 h-0.5 rounded ${step > s ? "bg-emerald-600" : "bg-gray-300 dark:bg-gray-700"}`} />}
          </div>
        ))}
      </div>

      {error && <AuthAlert className="mt-6">{t(error.key, error.vars)}</AuthAlert>}

      {step === 1 && (
        <form onSubmit={handleRequestReset} noValidate className="mt-6 space-y-4">
          <div>
            <FieldLabel htmlFor="fp-email">{t("fpEmailAddress", "Email address")}</FieldLabel>
            <input
              ref={emailRef}
              id="fp-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (emailErr) setEmailErr(null); }}
              placeholder={t("emailPlaceholder")}
              aria-invalid={emailErr ? true : undefined}
              aria-describedby={emailErr ? "fp-email-error" : undefined}
              className={inputClass(!!emailErr)}
            />
            <FieldError id="fp-email-error">{emailErr ? t(emailErr) : null}</FieldError>
          </div>
          <PrimaryButton tone="ink" loading={loading} loadingLabel={t("sending")} className="mt-2">
            {t("sendResetCode")}
          </PrimaryButton>
          <p className="text-center text-[14px]">
            <Link to="/login" state={{ email: typedEmail }} className={`${linkClass} font-medium`}>
              {t("fpBackToSignIn", "Back to sign in")}
            </Link>
          </p>
        </form>
      )}

      {step === 2 && (
        <div className="mt-6">
          <AuthNote>
            <p>
              {t("fpAccountExistsPre", "If an account exists with")} <strong className="font-semibold break-all">{email}</strong>{t("fpAccountExistsPost", ", we've sent a reset code.")}
            </p>
            <p className="text-[13px] text-gray-600 dark:text-gray-400 mt-1">{t("fpCheckInboxSpam", "Check inbox & spam")}</p>
          </AuthNote>
          <form onSubmit={handleResetPassword} noValidate className="mt-6 space-y-4">
            <div>
              <FieldLabel htmlFor="fp-code">{t("fpSixDigitCode", "6-digit code")}</FieldLabel>
              <input
                id="fp-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className={`${inputClass(false)} text-center text-2xl font-semibold tracking-[0.5em] tabular-nums`}
                placeholder="------"
                required
              />
            </div>
            <div>
              <FieldLabel htmlFor="fp-new">{t("fpNewPassword", "New Password")}</FieldLabel>
              <PasswordInput
                id="fp-new"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t("min8chars")}
                required
                minLength={8}
              />
            </div>
            <div>
              <FieldLabel htmlFor="fp-confirm">{t("fpConfirmPassword", "Confirm Password")}</FieldLabel>
              <PasswordInput
                id="fp-confirm"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t("reenterPassword")}
                required
                minLength={8}
              />
            </div>
            <PrimaryButton tone="ink" loading={loading} loadingLabel={t("resettingDots")} disabled={code.length !== 6} className="mt-2">
              {t("resetPasswordBtn")}
            </PrimaryButton>
            <div className="flex justify-between gap-4 text-[14px] pt-1">
              <button type="button" onClick={() => { setStep(1); setError(null); setCode(""); }} className={`${linkClass} font-medium`}>
                {t("fpTryDifferentEmail", "Try different email")}
              </button>
              <button type="button" onClick={handleRequestReset} className={linkClass}>
                {t("resendCode", "Resend code")}
              </button>
            </div>
          </form>
        </div>
      )}

      {step === 3 && (
        <div className="mt-6 text-center space-y-5 motion-safe:animate-[bbFade_180ms_ease-out]">
          <CheckCircle2 aria-hidden="true" className="w-10 h-10 mx-auto text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />
          <AuthNote>
            <p className="font-medium">{t("suResetDone")}</p>
          </AuthNote>
          <Link to="/login" state={{ email: typedEmail }} className={PRIMARY.ink}>
            {t("fpSignInNewPassword", "Sign in with new password")}
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
