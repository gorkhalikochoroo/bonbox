import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import BonBoxMark from "../BonBoxMark";
import BonBoxWordmark from "../BonBoxWordmark";
import { useLanguage } from "../../hooks/useLanguage";
import { PRIMARY, inputClass } from "./authStyles";

/**
 * The one shell and the few controls the four auth pages share — /register,
 * /login, /forgot-password and /verify-email (push 6, PQ-16).
 *
 * Premium by subtraction: paper ground, one 400 px column (it lines up with
 * Google's own button, which caps at 400 px), the forest tile, no
 * illustration, glow, pulse or blur. Motion is a 180 ms opacity fade, and only
 * under prefers-reduced-motion: no-preference.
 *
 * Contrast (measured): text gray-600 on paper 6.86:1 (gray-500 is 4.39:1 —
 * not used on paper); the field edge bb-line 3.26:1 on paper / 3.59:1 on
 * white; paper on forest 11.6:1.
 */

/**
 * The primary action. While `loading`, a spinner and `loadingLabel` replace the
 * label (aria-busy), the button stays the same width, and it cannot be pressed
 * twice.
 */
export function PrimaryButton({ loading = false, loadingLabel, tone = "forest", disabled, className = "", children, type = "submit", ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${PRIMARY[tone] || PRIMARY.forest} ${className}`}
      {...rest}
    >
      {loading ? (
        <>
          <Loader2 aria-hidden="true" className="w-[18px] h-[18px] motion-safe:animate-spin" strokeWidth={2} />
          <span>{loadingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** The forest tile and the word, 24 px above the heading. */
export function AuthLogo({ link = true }) {
  const inner = (
    <>
      <span className="w-10 h-10 rounded-lg bg-bb-forest text-bb-paper flex items-center justify-center" aria-hidden="true">
        <BonBoxMark size={32} />
      </span>
      <BonBoxWordmark height={24} className="text-bb-forest dark:text-bb-paper" />
    </>
  );
  if (!link) return <div className="flex items-center gap-2.5 mb-6">{inner}</div>;
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-2.5 mb-6 min-h-11 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bb-forest focus-visible:ring-offset-4 focus-visible:ring-offset-bb-paper"
    >
      {inner}
    </Link>
  );
}

/** h1 28/600 and the 15 px line under it (6 px apart). */
export function AuthHeading({ title, sub, children }) {
  return (
    <div>
      <h1 className="text-[28px] leading-[1.15] font-semibold tracking-tight text-balance text-gray-900 dark:text-white">{title}</h1>
      {sub && <p className="mt-1.5 text-[15px] leading-relaxed text-pretty text-gray-600 dark:text-gray-400">{sub}</p>}
      {children}
    </div>
  );
}

/**
 * The error box: red-700 on red-50, AlertCircle, announced at once. `ref` and
 * `tabIndex` pass through, so a page can bring the box into view and focus it
 * (RegisterPage: the answer to "Opret konto" lands above the form).
 */
export function AuthAlert({ children, className = "", ref, tabIndex }) {
  return (
    <div
      ref={ref}
      tabIndex={tabIndex}
      role="alert"
      aria-live="assertive"
      className={`flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-3 text-[14px] leading-relaxed text-red-700 dark:text-red-300 focus:outline-none ${className}`}
    >
      <AlertCircle aria-hidden="true" className="w-4 h-4 mt-[3px] shrink-0" strokeWidth={2} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A calm note (a code was sent, and the like): bordered white, announced politely. */
export function AuthNote({ children, className = "" }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-lg border border-bb-line/60 dark:border-gray-700 bg-white dark:bg-gray-900 px-3.5 py-3 text-[14px] leading-relaxed text-gray-800 dark:text-gray-200 ${className}`}
    >
      {children}
    </div>
  );
}

/** Label above a field: 14/500 gray-800. `aside` sits at the right (e.g. "Glemt?"). */
export function FieldLabel({ htmlFor, children, aside }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-1.5">
      <label htmlFor={htmlFor} className="block text-[14px] font-medium text-gray-800 dark:text-gray-200">
        {children}
      </label>
      {aside}
    </div>
  );
}

/** A field's own error, under it (the input carries aria-invalid + aria-describedby). */
export function FieldError({ id, children }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-[13px] leading-snug text-red-700 dark:text-red-400">
      {children}
    </p>
  );
}

/** Password input with a 44 x 44 show/hide toggle. */
export function PasswordInput({ invalid = false, className = "", ...inputProps }) {
  const { t } = useLanguage();
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        {...inputProps}
        type={show ? "text" : "password"}
        className={`${inputClass(invalid)} pr-12 ${className}`}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? t("hidePassword") : t("showPassword")}
        aria-pressed={show}
        className="absolute right-0.5 top-1/2 -translate-y-1/2 w-11 h-11 grid place-items-center rounded-md text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bb-forest dark:focus-visible:ring-gray-200"
      >
        {show ? <EyeOff aria-hidden="true" className="w-[18px] h-[18px]" strokeWidth={1.75} /> : <Eye aria-hidden="true" className="w-[18px] h-[18px]" strokeWidth={1.75} />}
      </button>
    </div>
  );
}

/** "eller brug e-mail" between the Google/Apple row and the form. */
export function AuthDivider({ label }) {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span className="flex-1 h-px bg-gray-300/80 dark:bg-gray-700" aria-hidden="true" />
      <span className="text-[13px] text-gray-600 dark:text-gray-400" aria-hidden="true">{label}</span>
      <span className="flex-1 h-px bg-gray-300/80 dark:bg-gray-700" aria-hidden="true" />
    </div>
  );
}

/** The language picker, bottom-centre on /register and /login. */
export function AuthLanguageSelect({ labelKey = "regLanguageLabel" }) {
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  if (!Array.isArray(LANGUAGES) || LANGUAGES.length < 2) return null;
  return (
    <div className="mt-8 flex justify-center">
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        aria-label={t(labelKey, "Language")}
        className="text-[13px] bg-transparent border border-bb-line dark:border-gray-600 rounded-md px-2.5 py-1 pointer-coarse:min-h-11
          text-gray-700 dark:text-gray-300 hover:border-gray-600 dark:hover:border-gray-400
          focus:outline-none focus-visible:ring-2 focus-visible:ring-bb-forest dark:focus-visible:ring-gray-200 cursor-pointer"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} className="bg-white dark:bg-gray-900">
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The page frame: paper ground, the 400 px column, the logo on top.
 *
 *   aside       the desktop panel (register) — rendered left of the form, lg+
 *   footer      a footer under everything (login keeps its own)
 *   logoLink    the logo links to the front page (not on the code screen,
 *               where "/" only leads back here)
 *   language    the language picker under the column
 *
 * A fixed strip the height of the status bar keeps scrolled content out from
 * under the clock in the iOS app (the webview overlays the status bar and
 * the body pads by env(safe-area-inset-top)); on the web it is 0 px tall.
 * The page pads its bottom by the compact cookie banner's height
 * (--bb-consent-h, CookieConsent.jsx), so the form can always be scrolled
 * clear of the banner (at rest it may sit over the lower fields on a small
 * phone; the Terms line and Google's button, above the form, stay clear).
 */
export default function AuthShell({ children, aside = null, footer = null, logoLink = true, language = false }) {
  return (
    <div
      className={
        "min-h-[100dvh] flex flex-col bg-bb-paper dark:bg-gray-950 text-gray-900 dark:text-gray-100 " +
        // The Terms acceptance line (SignupTermsLine, frozen) is gray-500,
        // 4.39:1 on paper: below 4.5. On these pages it reads gray-600
        // (6.86:1; gray-400 in dark), and its two links get a taller hit
        // area that does not move the text. Its words and places are
        // untouched.
        "[&_[data-testid=signup-terms-line]]:text-gray-600 dark:[&_[data-testid=signup-terms-line]]:text-gray-400 " +
        "[&_[data-testid=signup-terms-line]_a]:py-[15px]"
      }
      style={{ paddingBottom: "var(--bb-consent-h, 0px)" }}
    >
      <div aria-hidden="true" className="fixed inset-x-0 top-0 z-40 h-[env(safe-area-inset-top,0px)] bg-bb-paper dark:bg-gray-950" />
      <div className="flex-1 flex">
        {aside}
        <main className="flex-1 flex justify-center items-start sm:items-center px-4 sm:px-6 pt-6 pb-10 sm:py-14">
          <div className="w-full max-w-[400px] motion-safe:animate-[bbFade_180ms_ease-out]">
            <AuthLogo link={logoLink} />
            {children}
            {language && <AuthLanguageSelect />}
          </div>
        </main>
      </div>
      {footer}
    </div>
  );
}
