import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";

/**
 * "Your revisor's invite is saved, but not e-mailed yet" — after the wizard.
 *
 * The onboarding wizard's revisor step can end with an invite the server
 * SAVED but did not e-mail (the owner's own e-mail is unconfirmed, so BonBox
 * holds the invitation). The wizard finishes and redirects at once, so a
 * notice inside it was on screen for one round-trip. The wizard now passes
 * { revisorInviteHeld: true } as router state, and the page it lands on — the
 * full-screen "Du er klar" (/getting-started) or any page in the app layout —
 * shows this one row: what happened, and the one tap that fixes it.
 *
 * Renders nothing without that state, or once the owner's address is
 * confirmed (then Team → Revisor's "Send invitation" is the next step, and the
 * row there says "gemt · ikke sendt endnu" after any reload).
 */
export default function RevisorInviteHeldNotice({ className = "" }) {
  const location = useLocation();
  const { user } = useAuth() || {};
  const { t } = useLanguage();
  const [hidden, setHidden] = useState(false);

  if (hidden || !location?.state?.revisorInviteHeld) return null;
  if (user?.email_verified === true) return null;

  return (
    <div
      role="status"
      data-testid="revisor-invite-held-after-onboarding"
      className={
        "flex items-start justify-between gap-3 px-4 sm:px-6 py-2 text-[12px] " +
        "border-b border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/20 " +
        "text-amber-800 dark:text-amber-200 " + className
      }
    >
      <p className="min-w-0">
        {t("onbRevisorInviteHeld")}{" "}
        <Link
          to="/verify-email?now=1"
          className="font-semibold underline underline-offset-2 whitespace-nowrap"
        >
          {t("verifyEmailNowCta", "Confirm now")}
        </Link>
      </p>
      <button
        type="button"
        onClick={() => setHidden(true)}
        title={t("verifyReminderHide", "Hide for now")}
        aria-label={t("verifyReminderHide", "Hide for now")}
        className="w-6 h-6 shrink-0 inline-flex items-center justify-center rounded-full text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-800/40 transition"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
