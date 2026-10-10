import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import { verifyWallExempt } from "../utils/verifySkip";
import {
  TERMS_EXISTING_FROM,
  TERMS_VERSION,
  termsDate,
  termsNoticeWindowOpen,
} from "../legal/terms";

/**
 * "Vi har opdateret vores Handelsbetingelser" — the in-app notice to EXISTING
 * accounts (Manoj, 10 Oct 2026, decision a: in-app only, no e-mail; the Terms
 * apply to existing accounts from TERMS_EXISTING_FROM, 14 days after their
 * date, as the 13 May Terms §14 promise).
 *
 * Who sees it is the server's answer (user.terms_notice_due from /auth/me,
 * services/terms.py): the account owner, account from before the Terms'
 * date, no acceptance of the current version, not closed, before
 * TERMS_EXISTING_FROM. This row adds two local guards: it stops at 00:00
 * Copenhagen on that date even in a tab opened before it, and it is never on
 * the day's close (nothing competes with the close — same rule as
 * VerifyEmailReminder).
 *
 * The × closes it for the account on every device
 * (POST /auth/terms-notice/dismiss) and on this device at once (localStorage,
 * so a failed request still keeps it closed here). Closing is NOT acceptance:
 * the server writes only terms_notice_dismissed_version.
 *
 * Calm and neutral: the same quiet row as VerifyEmailReminder (gray, 12px,
 * border-b), the "what changed" list behind a disclosure.
 */
const LOCAL_KEY = "bonbox_terms_notice_closed";

function closedOnThisDevice(userId) {
  try { return localStorage.getItem(`${LOCAL_KEY}:${userId}`) === TERMS_VERSION; } catch { return false; }
}

export default function TermsUpdateNotice() {
  const { user } = useAuth() || {};
  const { t, lang } = useLanguage();
  const location = useLocation();
  const [closed, setClosed] = useState(false);
  const [open, setOpen] = useState(false);

  if (closed || !user || user.terms_notice_due !== true) return null;
  if (!termsNoticeWindowOpen()) return null;
  if (verifyWallExempt(location?.pathname)) return null;
  if (closedOnThisDevice(user.id)) return null;

  const date = termsDate(TERMS_EXISTING_FROM, lang === "da" ? "da" : "en");

  const close = () => {
    setClosed(true);
    try { localStorage.setItem(`${LOCAL_KEY}:${user.id}`, TERMS_VERSION); } catch { /* storage blocked */ }
    // Fire and forget: the row is already gone; the server keeps it closed
    // on the owner's other devices. Never an acceptance.
    Promise.resolve()
      .then(() => api.post("/auth/terms-notice/dismiss"))
      .catch(() => {});
  };

  return (
    <div
      role="status"
      data-testid="terms-update-notice"
      className="px-4 sm:px-6 py-1.5 border-b border-gray-100 dark:border-gray-700/50 bg-gray-50/40 dark:bg-gray-800/20 text-[12px]"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-gray-600 dark:text-gray-400 py-1">
          {t("termsNoticeText", "We have updated our Terms of Service. They apply to your account from {date}.", { date })}{" "}
          <Link
            to="/terms"
            className="font-medium text-gray-900 dark:text-gray-100 hover:underline whitespace-nowrap"
          >
            {t("termsNoticeRead", "Read the terms")}
          </Link>
          {/* The dot travels with the button, so a phone never starts a line with it. */}
          <span className="whitespace-nowrap">
            <span aria-hidden="true" className="text-gray-400"> · </span>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls="terms-update-notice-changes"
              className="font-medium text-gray-900 dark:text-gray-100 hover:underline"
            >
              {t("termsNoticeWhatChanged", "What changed?")}
            </button>
          </span>
        </p>
        <button
          type="button"
          onClick={close}
          title={t("termsNoticeHide", "Hide")}
          aria-label={t("termsNoticeHide", "Hide")}
          data-testid="terms-update-notice-close"
          className="w-6 h-6 mt-0.5 shrink-0 inline-flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-gray-700/40 transition"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {open && (
        <div id="terms-update-notice-changes" className="pb-1.5 text-gray-600 dark:text-gray-400">
          <ul className="list-disc pl-5 space-y-0.5">
            <li>{t("termsNoticeChangeRenewal", "Starter and Pro renew automatically every month. A cancellation takes effect at the end of the period you have paid for, and we do not refund part of a period.")}</li>
            <li>{t("termsNoticeChangeFounding", "You keep the founding price as long as your subscription stays active without a break.")}</li>
            <li>{t("termsNoticeChangePrice", "We give at least 30 days' notice by e-mail before a price change applies to your running subscription.")}</li>
            <li>{t("termsNoticeChangeBusiness", "Paid subscriptions are for businesses only.")}</li>
          </ul>
          <p className="mt-1">
            {t("termsNoticeObject", "If you do not want to continue on the new terms, you can cancel your subscription or delete your account before {date}.", { date })}
          </p>
        </div>
      )}
    </div>
  );
}
