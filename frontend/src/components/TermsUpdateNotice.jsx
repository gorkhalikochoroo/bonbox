import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import { verifyWallExempt } from "../utils/verifySkip";
import {
  TERMS_EXISTING_FROM,
  TERMS_VERSION,
  copenhagenMidnightMs,
  termsDate,
  termsNoticeWindowOpen,
} from "../legal/terms";

/**
 * "Vi har opdateret vores Handelsbetingelser" — the in-app notice to EXISTING
 * accounts (Manoj, 10 Oct 2026, decision a: in-app only, no e-mail; the Terms
 * apply to existing accounts from TERMS_EXISTING_FROM, the deploy day + 15
 * days, so the owner gets at least the 14 days the 13 May Terms §14 promise).
 *
 * Who sees it is the server's answer (user.terms_notice_due from /auth/me,
 * services/terms.py): every account owner without an acceptance of the
 * current version (whenever the account was created), not closed, before
 * TERMS_EXISTING_FROM. This row adds two local guards: it stops at 00:00
 * Copenhagen on that date even in a tab opened before it (it re-checks the
 * clock when the tab gets focus or becomes visible, and at the cut-off
 * itself), and it is never on the day's close (nothing competes with the
 * close — same rule as VerifyEmailReminder).
 *
 * It lives in Layout, so pages outside Layout never show it: public pages,
 * /verify-email, /onboarding, /getting-started and the stand views
 * (/reservations/stand, /staff/schedule/stand, /stand/…).
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
  const due = !!user && user.terms_notice_due === true;
  // Re-read the clock: a tab left open across 00:00 Copenhagen on
  // TERMS_EXISTING_FROM drops the row when it is looked at again (focus /
  // visible) or, if it stays in front, at the cut-off itself.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!due || typeof window === "undefined") return undefined;
    const recheck = () => setClockTick((n) => n + 1);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    let timer;
    const left = copenhagenMidnightMs(TERMS_EXISTING_FROM) - Date.now();
    // setTimeout holds at most ~24.8 days; beyond that focus/visibility do it.
    if (left > 0 && left < 2147483647) timer = setTimeout(recheck, left + 1000);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      if (timer) clearTimeout(timer);
    };
  }, [due]);

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
            <li>{t("termsNoticeChangeCaps", "Every plan, Free included, has usage caps, and we may change, limit or remove features and usage caps with reasonable notice. This replaces the promise in the earlier terms that existing free functionality stays available.")}</li>
            {/* § 4: the live 13 May text had BonBox retain accounting records
                (6 years by default) and purge within 30 days; the new § 4 makes
                the owner keep them ("ikke et arkiv") and deletes the account and
                its data at once. Every owner can delete, so it sits with the
                caps bullet, ahead of the paid-plan ones. */}
            <li>{t("termsNoticeChangeRecords", "You, not BonBox, must keep your business's accounting records. BonBox is not an archive. When you delete your account, we delete the account and the data in it straight away (§ 4 lists what we keep), so download your data and the PDFs you need first.")}</li>
            <li>{t("termsNoticeChangeBusiness", "Paid subscriptions are for businesses only.")}</li>
            <li>{t("termsNoticeChangeRenewal", "Starter and Pro renew automatically every month. A cancellation takes effect at the end of the period you have paid for, and we do not refund part of a period.")}</li>
            <li>{t("termsNoticeChangeFounding", "You keep the founding price as long as your subscription stays active without a break.")}</li>
            <li>{t("termsNoticeChangePrice", "We give at least 30 days' notice by e-mail before a price change applies to your running subscription.")}</li>
          </ul>
          <p className="mt-1">
            {t("termsNoticeObject", "If you do not want to continue on the new terms, you can cancel your subscription or delete your account before {date}.", { date })}
          </p>
        </div>
      )}
    </div>
  );
}
