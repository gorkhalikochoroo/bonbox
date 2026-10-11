import { useState, useRef, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import usePageTitle from "../hooks/usePageTitle";
import api from "../services/api";
import { authErrorKey } from "../utils/authErrors";
import { emailProblem } from "../utils/signupValidation";
import { clearVerifySkip, rememberVerifySkip } from "../utils/verifySkip";
import AuthShell, {
  AuthAlert, AuthHeading, AuthNote, FieldError, FieldLabel, PasswordInput, PrimaryButton,
} from "../components/auth/AuthUI";
import { SECONDARY, inputClass, linkClass } from "../components/auth/authStyles";

/**
 * /verify-email — the 6-digit code (push 6: the light shell, the full address,
 * "Forkert e-mail? Ret den", every error in the owner's language, and a calm
 * success moment).
 */
export default function VerifyEmailPage({ sendOnArrival = false }) {
  const { user, setEmailVerified, refreshUser, logout } = useAuth();
  const { t } = useLanguage();
  usePageTitle("suTitleVerify");
  const navigate = useNavigate();
  const location = useLocation();
  // Opened on purpose later (the "Bekræft din e-mail" reminder / Profile's
  // chip link here with ?now=1): the signup code has long expired, so the
  // resend button is ready at once instead of a 60-second wait.
  const openedLater = new URLSearchParams(location.search).get("now") === "1";
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  // { key, vars, action } — a dictionary line, never the server's English.
  const [error, setError] = useState(null);
  // { key, vars } — "Ny kode sendt", "Ny kode sendt til …".
  const [notice, setNotice] = useState(null);
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const inputRefs = useRef([]);

  // "Forkert e-mail? Ret den" — change the address in place (PATCH
  // /auth/profile {email, current_password}: the server marks it
  // unconfirmed, mails a fresh 30-minute code to the NEW address, and keeps
  // its own daily cap and the open-claim guard).
  const [fixOpen, setFixOpen] = useState(false);
  const [fixEmail, setFixEmail] = useState("");
  const [fixPassword, setFixPassword] = useState("");
  const [fixEmailErr, setFixEmailErr] = useState(null);
  const [fixError, setFixError] = useState(null);
  const [fixSaving, setFixSaving] = useState(false);
  const fixEmailRef = useRef(null);

  // A fresh signup was mailed a code at registration: start the 60-second
  // resend cooldown. An owner who came here on purpose (created before the
  // grace date, or skipped at signup) was mailed nothing — send one now, so
  // "We sent a 6-digit code" is true. The ref keeps it to ONE mail even when
  // React runs the effect twice.
  const arrivalSent = useRef(false);
  useEffect(() => {
    if (!sendOnArrival) {
      // Opened on purpose with ?now=1 and no fresh code owed: the resend
      // button is ready at once instead of a 60-second wait.
      if (!openedLater) setResendCooldown(60);
      return;
    }
    if (arrivalSent.current) return;
    arrivalSent.current = true;
    api
      .post("/auth/resend-verification")
      .then(() => setResendCooldown(60))
      .catch((err) => {
        const r = authErrorKey(err, "resend");
        setError({ key: r.key, vars: r.vars });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown timer for resend
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  // Focus first input on mount
  useEffect(() => {
    if (inputRefs.current[0]) {
      inputRefs.current[0].focus();
    }
  }, []);

  const handleChange = (index, value) => {
    // Only allow digits
    const digit = value.replace(/\D/g, "").slice(-1);
    const newCode = [...code];
    newCode[index] = digit;
    setCode(newCode);
    setError(null);

    // Auto-focus next input
    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 6 digits are filled
    if (digit && index === 5) {
      const fullCode = newCode.join("");
      if (fullCode.length === 6) {
        handleVerify(fullCode);
      }
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    // Allow paste
    if (e.key === "v" && (e.ctrlKey || e.metaKey)) return;
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 0) return;
    const newCode = [...code];
    for (let i = 0; i < 6; i++) {
      newCode[i] = pasted[i] || "";
    }
    setCode(newCode);
    setError(null);
    // Focus last filled input
    const lastIndex = Math.min(pasted.length - 1, 5);
    inputRefs.current[lastIndex]?.focus();
    // Auto-submit if full
    if (pasted.length === 6) {
      handleVerify(pasted);
    }
  };

  const handleVerify = async (codeStr) => {
    const fullCode = codeStr || code.join("");
    if (fullCode.length !== 6) {
      setError({ key: "enter6Digits" });
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await api.post("/auth/verify-email", { code: fullCode });
      // The success moment: the panel gives way to a calm confirmation,
      // then the existing 1.2 s hand-over to the app.
      setVerified(true);
      clearVerifySkip(user?.id);
      setEmailVerified();
      setTimeout(() => navigate("/dashboard"), 1200);
    } catch (err) {
      // Per-account limits on wrong codes (backend verify_email) and the
      // three plain answers (wrong / expired / no code) — said in the
      // owner's language, with what to do next (utils/authErrors).
      const r = authErrorKey(err, "verify");
      setError({ key: r.key, vars: r.vars, action: r.action });
      // Clear code on failure
      setCode(["", "", "", "", "", ""]);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setError(null);
    try {
      await api.post("/auth/resend-verification");
      setResendCooldown(60);
      setNotice({ key: "newCodeSent" });
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      const r = authErrorKey(err, "resend");
      setError({ key: r.key, vars: r.vars });
    }
  };

  const openFix = () => {
    setFixOpen(true);
    setFixEmail("");
    setFixPassword("");
    setFixEmailErr(null);
    setFixError(null);
    setTimeout(() => fixEmailRef.current?.focus(), 0);
  };

  const submitFix = async (e) => {
    e.preventDefault();
    setFixError(null);
    const problem = emailProblem(fixEmail);
    if (problem) {
      setFixEmailErr(problem);
      fixEmailRef.current?.focus();
      return;
    }
    setFixEmailErr(null);
    const newEmail = fixEmail.trim();
    setFixSaving(true);
    try {
      await api.patch("/auth/profile", { email: newEmail, current_password: fixPassword });
      await refreshUser?.();
      // The new code went to the new address just now.
      setResendCooldown(60);
      setCode(["", "", "", "", "", ""]);
      setError(null);
      setNotice({ key: "suChangeEmailDone", vars: { email: newEmail } });
      setFixOpen(false);
      inputRefs.current[0]?.focus();
    } catch (err) {
      const r = authErrorKey(err, "changeEmail");
      if (r.field === "email") {
        setFixEmailErr(r.key);
        fixEmailRef.current?.focus();
      } else {
        setFixError({ key: r.key, vars: r.vars, action: r.action, email: newEmail });
      }
    } finally {
      setFixSaving(false);
    }
  };

  // "Log ud, og log ind med den i stedet" — the address already has an account.
  const signOutTo = async (address) => {
    try { await logout?.(); } catch { /* signed out locally either way */ }
    navigate("/login", { state: { email: address } });
  };

  const email = user?.email || "";
  // "Vi har sendt en kode med 6 cifre til {email}." — the full address, in
  // bold, so a typo is visible (B2); the mask hid exactly that.
  const [sentPre, sentPost = ""] = String(t("suVerifySentTo")).split("{email}");

  return (
    <AuthShell logoLink={false}>
      {verified ? (
        // The success moment: one emerald tick, two calm lines, then the app.
        <div className="text-center motion-safe:animate-[bbFade_180ms_ease-out]" role="status" aria-live="polite">
          <CheckCircle2 aria-hidden="true" className="w-10 h-10 mx-auto text-emerald-600 dark:text-emerald-400" strokeWidth={1.75} />
          <h1 className="mt-4 text-[28px] leading-[1.15] font-semibold tracking-tight text-gray-900 dark:text-white">
            {t("suVerifiedTitle")}
          </h1>
          <p className="mt-1.5 text-[15px] leading-relaxed text-gray-600 dark:text-gray-400">{t("suVerifiedBody")}</p>
        </div>
      ) : (
        <>
          <AuthHeading title={t("verifyEmailHeading", "Verify your email")}>
            <p className="mt-1.5 text-[15px] leading-relaxed text-gray-600 dark:text-gray-400">
              {sentPre}
              <strong className="font-semibold text-gray-900 dark:text-white break-all">{email}</strong>
              {sentPost}
            </p>
            {!fixOpen && (
              <p className="mt-2 text-[14px]">
                <button type="button" onClick={openFix} className={`${linkClass} font-medium`}>
                  {t("suWrongEmail")}
                </button>
              </p>
            )}
          </AuthHeading>

          {fixOpen && (
            <form onSubmit={submitFix} noValidate className="mt-5 rounded-lg border border-bb-line/70 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-4">
              <div>
                <FieldLabel htmlFor="ve-new-email">{t("suChangeEmailLabel")}</FieldLabel>
                <input
                  ref={fixEmailRef}
                  id="ve-new-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={fixEmail}
                  onChange={(e) => { setFixEmail(e.target.value); if (fixEmailErr) setFixEmailErr(null); }}
                  placeholder={t("emailPlaceholder")}
                  aria-invalid={fixEmailErr ? true : undefined}
                  aria-describedby={fixEmailErr ? "ve-new-email-error" : undefined}
                  className={inputClass(!!fixEmailErr)}
                />
                <FieldError id="ve-new-email-error">{fixEmailErr ? t(fixEmailErr) : null}</FieldError>
              </div>
              <div>
                <FieldLabel htmlFor="ve-password">{t("suChangeEmailPwLabel")}</FieldLabel>
                <PasswordInput
                  id="ve-password"
                  autoComplete="current-password"
                  required
                  value={fixPassword}
                  onChange={(e) => setFixPassword(e.target.value)}
                  aria-describedby="ve-password-help"
                />
                <p id="ve-password-help" className="mt-1.5 text-[13px] text-gray-600 dark:text-gray-400">{t("suChangeEmailPwHelp")}</p>
              </div>
              {fixError && (
                <AuthAlert>
                  {t(fixError.key, fixError.vars)}
                  {fixError.action === "logout" && (
                    <>
                      {" "}
                      <button type="button" onClick={() => signOutTo(fixError.email)} className={`${linkClass} font-medium text-red-800 dark:text-red-200 decoration-red-400`}>
                        {t("logout")}
                      </button>
                    </>
                  )}
                </AuthAlert>
              )}
              <div className="grid grid-cols-2 gap-3">
                <button type="button" onClick={() => setFixOpen(false)} className={SECONDARY}>
                  {t("cancel")}
                </button>
                <PrimaryButton tone="ink" loading={fixSaving} loadingLabel={t("sending")}>
                  {t("suChangeEmailBtn")}
                </PrimaryButton>
              </div>
            </form>
          )}

          {notice && <AuthNote className="mt-5">{t(notice.key, notice.vars)}</AuthNote>}
          {error && (
            <AuthAlert className="mt-5">
              {t(error.key, error.vars)}
            </AuthAlert>
          )}

          {/* OTP input boxes */}
          <div className="mt-6">
            <p id="ve-code-label" className="block text-[14px] font-medium text-gray-800 dark:text-gray-200 mb-2">
              {t("suCodeGroupLabel")}
            </p>
            {/* Six boxes that share the row: 52 px each on a wide screen,
                narrower (gap 8 px) on a 360–390 px phone — the fixed
                3.25rem + gap-3 row was 372 px and cut the 6th box off
                (release gate, 9 Oct). */}
            <div
              className="flex gap-2 sm:gap-3 justify-center w-full"
              onPaste={handlePaste}
              data-testid="verify-code-row"
              role="group"
              aria-labelledby="ve-code-label"
            >
              {code.map((digit, index) => (
                <input
                  key={index}
                  ref={(el) => (inputRefs.current[index] = el)}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handleChange(index, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(index, e)}
                  aria-label={t("suCodeDigit", { n: index + 1 })}
                  className={`flex-1 min-w-0 max-w-[3.25rem] h-14 text-center text-2xl font-semibold tabular-nums rounded-lg border bg-white dark:bg-gray-900 text-gray-900 dark:text-white transition-colors duration-150 focus:outline-none focus:border-bb-forest focus:ring-[3px] focus:ring-bb-forest/20 dark:focus:border-gray-200 dark:focus:ring-white/20 ${
                    digit ? "border-gray-900 dark:border-gray-300" : "border-bb-line dark:border-gray-600"
                  }`}
                  disabled={loading}
                  autoComplete="one-time-code"
                />
              ))}
            </div>
          </div>

          {/* Verify button — named like the heading ("Bekræft e-mail") */}
          <PrimaryButton
            type="button"
            tone="ink"
            onClick={() => handleVerify()}
            disabled={code.join("").length !== 6}
            loading={loading}
            loadingLabel={t("verifying", "Verifying...")}
            className="mt-6"
          >
            {t("suVerifyBtn")}
          </PrimaryButton>

          {/* Resend code */}
          <div className="mt-6 text-center">
            <p className="text-[14px] text-gray-600 dark:text-gray-400">{t("verifyDidntReceive", "Didn't receive the code?")}</p>
            <button
              type="button"
              onClick={handleResend}
              disabled={resendCooldown > 0}
              className={`mt-1 min-h-11 px-3 text-[14px] font-medium rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bb-forest ${
                resendCooldown > 0
                  ? "text-gray-600 dark:text-gray-400 cursor-not-allowed tabular-nums"
                  : "text-gray-900 dark:text-white underline underline-offset-4 decoration-gray-400 hover:decoration-gray-900"
              }`}
            >
              {resendCooldown > 0
                ? t("suResendIn", { s: resendCooldown })
                : t("suResend")}
            </button>
          </div>

          {/* Skip for now */}
          <button
            type="button"
            onClick={() => {
              // Remembered for 7 days on this account, not just this
              // session; a quiet reminder stays in the app meanwhile.
              rememberVerifySkip(user?.id);
              navigate("/dashboard");
            }}
            className="w-full mt-4 min-h-11 text-[14px] text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white underline underline-offset-4 decoration-gray-400 rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bb-forest"
          >
            {t("verifySkipForNow", "Skip for now")}
          </button>
          <p className="mt-1 text-center text-[13px] text-gray-600 dark:text-gray-400">
            {t("verifySkipRemembered", "Skip, and for the next 7 days you'll see a small reminder instead of this page.")}
          </p>

          {/* Help text */}
          <p className="mt-6 pt-4 border-t border-bb-line/30 dark:border-gray-800 text-[13px] text-gray-600 dark:text-gray-400 leading-relaxed">
            {t("verifyHelpText", "Check your inbox and spam folder. The code expires in 30 minutes. If you continue to have issues, try requesting a new code.")}
          </p>
        </>
      )}
    </AuthShell>
  );
}
