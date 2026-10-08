import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { verifySkipActive, verifyWallExempt } from "../utils/verifySkip";

/**
 * The quiet "Bekræft din e-mail" reminder — the other half of the 7-day
 * "Spring over for nu" (utils/verifySkip).
 *
 * The wall no longer returns every session, so the reminder is what keeps the
 * unverified address in view: one thin row at the top of the page, a link to
 * the verification page (?now=1, so the skip does not bounce the tap back),
 * and a × that hides it for the rest of this session.
 *
 * Shown only while the account needs verifying AND the owner chose to skip
 * (without a skip they are on the wall, not here). Never on the day's close —
 * nothing competes with the close. Renders nothing otherwise.
 */
const HIDE_KEY = "bonbox_verify_reminder_hidden";

function hiddenThisSession() {
  try { return sessionStorage.getItem(HIDE_KEY) === "1"; } catch { return false; }
}

export default function VerifyEmailReminder() {
  const { user, needsEmailVerification } = useAuth();
  const { t } = useLanguage();
  const location = useLocation();
  const [hidden, setHidden] = useState(hiddenThisSession);

  if (hidden || !user) return null;
  if (typeof needsEmailVerification !== "function" || !needsEmailVerification()) return null;
  if (!verifySkipActive(user.id)) return null;
  if (verifyWallExempt(location.pathname)) return null;

  const hide = () => {
    try { sessionStorage.setItem(HIDE_KEY, "1"); } catch { /* storage blocked */ }
    setHidden(true);
  };

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 sm:px-6 py-1.5 border-b border-gray-100 dark:border-gray-700/50 bg-gray-50/40 dark:bg-gray-800/20 text-[12px]"
      role="status"
      data-testid="verify-email-reminder"
    >
      <p className="min-w-0 text-gray-600 dark:text-gray-400 truncate">
        {t("verifyReminderText", "Your e-mail isn't confirmed yet.")}
      </p>
      <div className="flex items-center gap-1 shrink-0">
        <Link
          to="/verify-email?now=1"
          className="font-medium text-gray-900 dark:text-gray-100 hover:underline px-1.5 py-1"
        >
          {t("verifyReminderCta", "Confirm your e-mail")}
        </Link>
        <button
          type="button"
          onClick={hide}
          title={t("verifyReminderHide", "Hide for now")}
          aria-label={t("verifyReminderHide", "Hide for now")}
          className="w-6 h-6 inline-flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-gray-700/40 transition"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
