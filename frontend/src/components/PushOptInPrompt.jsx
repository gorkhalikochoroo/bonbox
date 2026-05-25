/**
 * PushOptInPrompt — small dashboard card that nudges the owner to
 * enable native push notifications for the 8am morning brief (Task #72).
 *
 * Strategic role: the email brief is the existing surface. Native
 * push gets 2-3× the open-rate in the first 10 minutes — the
 * difference between "advisor that arrives" and "tab I'll check
 * later". This card sits near the ConnectionsProgressCard on the
 * dashboard for ~1 day after signup, then dismisses for 30 days on
 * the user's click of "Not now".
 *
 * Visibility rules (ALL must be true to render):
 *   • Notification API supported (rules out IE / some embeds)
 *   • permission === 'default' (we never re-prompt after denied)
 *   • User has had BonBox for at least 1 day (no signup-flash spam)
 *   • Not dismissed in the last 30 days (localStorage)
 *   • Not currently subscribed (the hook tells us this from the SW)
 *
 * iOS-Safari-not-installed-as-PWA path:
 *   The Web Push API on iOS only works inside the standalone (home-
 *   screen-installed) PWA. If we detect iOS Safari that's NOT running
 *   as standalone, we DON'T show the subscribe button — we show a
 *   "Add to Home Screen first" hint with a pointer to the existing
 *   InstallAppPrompt flow. Pressing subscribe here would silently
 *   noop on iOS, which is a worse UX than just being honest.
 */
import { useEffect, useState } from "react";
import usePushNotifications from "../hooks/usePushNotifications";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { Button, Icon } from "./ui";

const _DISMISS_KEY = "bonbox_push_optin_dismissed_until";
const _DISMISS_DAYS = 30;
const _MIN_AGE_HOURS = 24;  // wait one full day before nudging

function _isDismissed() {
  try {
    const until = parseInt(localStorage.getItem(_DISMISS_KEY) || "0", 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

function _dismissFor(days = _DISMISS_DAYS) {
  try {
    localStorage.setItem(_DISMISS_KEY, String(Date.now() + days * 86400_000));
  } catch {
    // localStorage blocked — fall through; will re-render next paint.
  }
}

function _isStandalone() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (window.navigator?.standalone === true) return true;
  } catch { /* SSR / sandbox — treat as not standalone */ }
  return false;
}

function _isIos() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // Modern iPadOS reports as Mac, so we additionally check touch.
  const isIosUa = /iPad|iPhone|iPod/.test(ua);
  const isIpadOs = /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
  return isIosUa || isIpadOs;
}

function _isCapacitorNative() {
  if (typeof window === "undefined") return false;
  return !!(window.Capacitor || window.cordova);
}

function _ageHours(createdAt) {
  if (!createdAt) return 0;
  try {
    const t = new Date(createdAt).getTime();
    if (!Number.isFinite(t)) return 0;
    return (Date.now() - t) / 3600_000;
  } catch {
    return 0;
  }
}

export default function PushOptInPrompt() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const {
    supported, permission, subscribed, busy, subscribe,
  } = usePushNotifications();

  const [dismissed, setDismissed] = useState(() => _isDismissed());
  const [errorKey, setErrorKey] = useState(null);

  // Cheap re-render trigger when the localStorage flag changes from
  // another tab (e.g. user clicked "Not now" elsewhere). Not strictly
  // needed but it costs us nothing.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === _DISMISS_KEY) setDismissed(_isDismissed());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // ─── Visibility gate ─────────────────────────────────────────────────

  // Native shells (Capacitor): the @capacitor/push surface handles
  // permission via the existing requestPermission() in the legacy
  // hook. We don't need to show this card.
  if (_isCapacitorNative()) return null;

  if (!supported) return null;
  if (permission !== "default") return null;     // user already decided
  if (subscribed) return null;                    // already subscribed
  if (dismissed) return null;
  // Wait for the user to spend a day in BonBox before nudging — we
  // don't want this on signup-flash where they're still onboarding.
  if (_ageHours(user?.created_at) < _MIN_AGE_HOURS) return null;

  // iOS-Safari special case: Web Push only works if BonBox is
  // installed as a PWA. Show a different copy + no subscribe button
  // when we detect iOS without standalone.
  const iosInstallFirst = _isIos() && !_isStandalone();

  const onSubscribe = async () => {
    setErrorKey(null);
    const result = await subscribe();
    if (result?.ok) {
      // Persist dismiss so we don't keep nudging if the user
      // unsubscribes later (they can re-enable from Profile).
      _dismissFor(365);
      setDismissed(true);
    } else if (result?.error === "denied") {
      setErrorKey("pushDenied");
      _dismissFor(365);  // browser will never re-prompt anyway
      setDismissed(true);
    } else if (result?.error === "push_disabled") {
      setErrorKey("pushUnavailable");
    } else if (result?.error) {
      setErrorKey("pushGenericError");
    }
  };

  const onDismiss = () => {
    _dismissFor(_DISMISS_DAYS);
    setDismissed(true);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 mt-0.5 text-gray-700 dark:text-gray-300">
            <Icon name="Bell" size={16} strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15.5px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
              {t("pushOptInTitle") || "Get the morning brief as a push"}
            </h2>
            <p className="text-[12.5px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
              {iosInstallFirst
                ? (t("pushIosInstallFirst") ||
                   "On iPhone, add BonBox to your Home Screen first (Share → Add to Home Screen). Then push works.")
                : (t("pushOptInBody") ||
                   "8am Copenhagen, lock-screen pop. Same brief, on time, before email lands.")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("pushDismiss") || "Dismiss for 30 days"}
          title={t("pushDismiss") || "Dismiss for 30 days"}
          className="w-7 h-7 -mr-1 -mt-1 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700/60 dark:hover:text-gray-200 transition flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {errorKey && (
        <p
          role="alert"
          className="text-[12px] text-amber-700 dark:text-amber-400 mb-3"
        >
          {t(errorKey) ||
            (errorKey === "pushDenied"
              ? "Push is blocked in your browser settings."
              : "Couldn't enable push. Try again from Profile → Notifications.")}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {iosInstallFirst ? (
          <span className="text-[12px] text-gray-500 dark:text-gray-400 italic">
            {t("pushIosHint") || "Tap Share, then Add to Home Screen, then re-open BonBox from your icon."}
          </span>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={onSubscribe}
            busy={busy}
          >
            {t("pushEnable") || "Enable push"}
          </Button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="text-[13px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition px-2"
        >
          {t("pushOptInNotNow") || "Not now"}
        </button>
      </div>
    </div>
  );
}
