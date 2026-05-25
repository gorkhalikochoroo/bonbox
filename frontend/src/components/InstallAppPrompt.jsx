/**
 * InstallAppPrompt — encourages installing BonBox as a PWA.
 *
 * Two flows depending on browser capability:
 *
 *   1. Chrome / Edge / Android: the browser fires
 *      `beforeinstallprompt`. We capture the event, hide it from the
 *      built-in chrome (Chrome auto-popups can be annoying), and
 *      surface our own "Install BonBox →" button. On tap we replay
 *      the captured event so the system install dialog appears.
 *
 *   2. iOS Safari: does NOT fire `beforeinstallprompt`. The only way
 *      to install is the manual Share → "Add to Home Screen" flow.
 *      We detect iOS Safari + non-standalone via user agent + media
 *      query, and show a one-time instructions hint.
 *
 * Self-hides when:
 *   • Already running standalone (display-mode: standalone)
 *   • User dismissed in the last 14 days (localStorage)
 *   • App is loaded in a Capacitor native shell (window.Capacitor exists)
 *
 * Renders as a small banner above the mobile bottom-nav, or a quiet
 * toast in the bottom-right on desktop. Always dismissible.
 *
 * The pitch matters: owners install when they understand what they
 * get. Copy emphasizes "1 tap from home screen" + "morning brief
 * appears on launch."
 */
import { useEffect, useState } from "react";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";

const _DISMISS_KEY = "bonbox_pwa_install_dismissed_until";
const _DISMISS_DAYS = 14;
const _DELAY_MS = 25_000; // 25-second delay before showing — not on first paint
const _IOS_SHOWN_KEY = "bonbox_pwa_ios_hint_shown";

function _now() {
  return Date.now();
}

function _isDismissed() {
  try {
    const until = parseInt(localStorage.getItem(_DISMISS_KEY) || "0", 10);
    return Number.isFinite(until) && _now() < until;
  } catch {
    return false;
  }
}

function _dismiss(days = _DISMISS_DAYS) {
  try {
    localStorage.setItem(_DISMISS_KEY, String(_now() + days * 86400_000));
  } catch {
    // localStorage blocked — we'll just re-prompt next paint; non-fatal
  }
}

/**
 * Detect "is already installed as PWA". Uses the standard
 * display-mode: standalone media query + iOS's separate
 * navigator.standalone flag (Apple still hasn't aligned with the
 * standard).
 */
function _isStandalone() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (window.navigator?.standalone === true) return true;
  } catch {
    // matchMedia failing means we're probably in SSR — treat as not installed
  }
  return false;
}

/**
 * iOS Safari detection — UA-based. We don't try to be clever about
 * iPad-on-desktop UA mode; if the owner did that, they're a power
 * user and don't need our help.
 */
function _isIosSafari() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIOS && isSafari;
}

function _isCapacitorNative() {
  // Capacitor injects window.Capacitor on native shells. If we're in
  // a native app already, suppress the web install banner.
  if (typeof window === "undefined") return false;
  return !!(window.Capacitor || window.cordova);
}

export default function InstallAppPrompt() {
  const { t } = useLanguage();
  const [installEvent, setInstallEvent] = useState(null);  // captured beforeinstallprompt
  const [iosHint, setIosHint] = useState(false);
  const [visible, setVisible] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    // Bail out cleanly when the app is already installed, dismissed, or
    // running in a native shell. We never want to nag users who already
    // have us on their home screen.
    if (_isStandalone() || _isDismissed() || _isCapacitorNative()) return;

    // Chrome / Edge / Android path
    const onBeforeInstallPrompt = (e) => {
      e.preventDefault();         // suppress the browser's auto-popup
      setInstallEvent(e);         // stash for our own button to replay
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);

    // iOS Safari path — no event, just check + show hint once
    if (_isIosSafari()) {
      let iosShown = false;
      try {
        iosShown = localStorage.getItem(_IOS_SHOWN_KEY) === "1";
      } catch { /* localStorage blocked — show anyway */ }
      if (!iosShown) {
        setIosHint(true);
      }
    }

    // Delay before showing so we don't pop up the moment the dashboard
    // paints. Owners reading the brief shouldn't be interrupted.
    const timer = setTimeout(() => setVisible(true), _DELAY_MS);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      clearTimeout(timer);
    };
  }, []);

  // After install (Chrome) the event becomes unusable. Listen for the
  // 'appinstalled' event to clean up and persist a permanent dismiss
  // so we never show this again.
  useEffect(() => {
    const onInstalled = () => {
      setInstallEvent(null);
      setVisible(false);
      _dismiss(365 * 10);  // effectively forever
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => window.removeEventListener("appinstalled", onInstalled);
  }, []);

  if (!visible) return null;
  if (!installEvent && !iosHint) return null;  // nothing to show

  const onInstallClick = async () => {
    if (!installEvent) return;
    setInstalling(true);
    try {
      installEvent.prompt();
      const choice = await installEvent.userChoice;
      if (choice?.outcome === "accepted") {
        setVisible(false);
        _dismiss(365 * 10);
      } else {
        // User dismissed the system prompt — back off for 14 days
        _dismiss();
        setVisible(false);
      }
    } catch {
      // Some browsers (Samsung Internet?) throw if the event is stale
      setVisible(false);
    } finally {
      setInstalling(false);
    }
  };

  const onIosDismiss = () => {
    try { localStorage.setItem(_IOS_SHOWN_KEY, "1"); } catch { /* fine */ }
    _dismiss();
    setVisible(false);
  };

  const onDismiss = () => {
    _dismiss();
    setVisible(false);
  };

  // iOS: instructional hint card. No system install — owner has to do
  // it manually via Share → Add to Home Screen. We describe the path
  // visually rather than relying on text-only directions.
  // Note: this is a non-modal dialog (role="dialog" without aria-modal)
  // because it sits in the corner and the rest of the app remains
  // interactive while it's visible — owner can still use the dashboard.
  if (iosHint) {
    return (
      <div
        className="fixed bottom-20 sm:bottom-6 left-3 right-3 sm:left-auto sm:right-6 sm:w-[360px] z-40 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-4"
        role="dialog"
        aria-labelledby="install-app-prompt-title"
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-start gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 text-gray-700 dark:text-gray-300">
              <Icon name="Sparkles" size={16} strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <h3 id="install-app-prompt-title" className="text-[14px] font-semibold text-gray-900 dark:text-gray-100">
                {t("installPromptIosTitle") || "Add BonBox to your home screen"}
              </h3>
              <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
                {t("installPromptIosSub") ||
                  "One tap to launch, no Safari chrome, brief opens on launch."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onIosDismiss}
            aria-label={t("dismiss") || "Dismiss"}
            className="w-7 h-7 -mr-1 -mt-1 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700/60 dark:hover:text-gray-200 transition flex items-center justify-center shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Visual path: Share icon → "Add to Home Screen". Two short
            inline rows, each with the visual cue users will hunt for
            in the iOS share sheet. */}
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-2 text-[12.5px] text-gray-700 dark:text-gray-200">
            <span className="text-gray-500 dark:text-gray-400" aria-hidden="true">1.</span>
            <span>{t("installPromptIosStep1") || "Tap the"}</span>
            <span className="inline-flex items-center justify-center w-5 h-5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                <polyline points="16 6 12 2 8 6" />
                <line x1="12" y1="2" x2="12" y2="15" />
              </svg>
            </span>
            <span>{t("installPromptIosShareBtn") || "Share button"}</span>
          </div>
          <div className="flex items-center gap-2 text-[12.5px] text-gray-700 dark:text-gray-200">
            <span className="text-gray-500 dark:text-gray-400" aria-hidden="true">2.</span>
            <span>
              {t("installPromptIosStep2") || "Tap"}{" "}
              <span className="font-semibold">
                {t("installPromptIosAdd") || "Add to Home Screen"}
              </span>
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Chrome / Android path — the system install dialog is one tap away
  return (
    <div
      className="fixed bottom-20 sm:bottom-6 left-3 right-3 sm:left-auto sm:right-6 sm:w-[340px] z-40 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-4"
      role="dialog"
      aria-labelledby="install-app-prompt-title-2"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 text-gray-700 dark:text-gray-300">
            <Icon name="Sparkles" size={16} strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h3 id="install-app-prompt-title-2" className="text-[14px] font-semibold text-gray-900 dark:text-gray-100">
              {t("installPromptTitle") || "Install BonBox"}
            </h3>
            <p className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
              {t("installPromptSub") ||
                "One tap from your phone, no browser tabs, brief opens on launch."}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("dismiss") || "Dismiss"}
          className="w-7 h-7 -mr-1 -mt-1 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700/60 dark:hover:text-gray-200 transition flex items-center justify-center shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <button
        type="button"
        onClick={onInstallClick}
        disabled={installing}
        className="w-full px-3 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-lg text-[13px] font-semibold hover:bg-gray-700 dark:hover:bg-gray-200 transition disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-800"
      >
        {installing
          ? (t("installPromptInstalling") || "Installing…")
          : (t("installPromptCta") || "Install on this device")}
      </button>
    </div>
  );
}
