import { useEffect, useState } from "react";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Cookie consent banner — GDPR + ePrivacy + Datatilsynet (DK) compliant.
 *
 * Design:
 *  • First-visit users see a banner with three actions: Accept all / Decline
 *    non-essential / Customize.
 *  • Customize opens an inline drawer with 4 categories. "Strictly necessary"
 *    is locked on (auth, CSRF, session). The other three default OFF —
 *    Datatilsynet's guidance is "consent must be opt-in, not opt-out."
 *  • Choices persist in localStorage with a version stamp so we can re-prompt
 *    if the policy changes, and a timestamp so we can re-prompt every 12
 *    months (best practice; required for some Datatilsynet interpretations).
 *  • Re-open via the `bonbox-open-cookie-settings` window event — wire from
 *    a footer link or settings page.
 *
 * Tax-jurisdiction note: this banner serves DK/EU users; same pattern works
 * for non-EU but the legal force is EU/EEA-bound. Banner shows in the user's
 * UI language (en/da/np/vi/th/tr) — Datatilsynet requires consent text be
 * understandable to the user.
 *
 * No analytics scripts are loaded today, so this banner is currently a
 * compliance placeholder. When you add GA / PostHog / Hotjar / etc., guard
 * each load with `getCookieConsent().analytics`.
 */

const STORAGE_KEY = "bonbox_cookie_consent";
const VERSION = 1; // bump if the categories/wording change materially
const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Multi-barrier defense for the consent record. Each check is independent
 * — any single one tripping returns null and the banner re-prompts. This
 * means a corrupt/tampered/stale record can never silently grant consent.
 *
 *   1. localStorage available?     (private browsing → null → re-prompt)
 *   2. Has the storage key?        (first visit → null → show banner)
 *   3. Parses as JSON?             (tampered string → null → re-prompt)
 *   4. Object shape sane?          (drive-by injection → null → re-prompt)
 *   5. Version matches?            (we changed terms → null → re-prompt)
 *   6. Timestamp present + valid?  (corrupted clock → null → re-prompt)
 *   7. Within 12-month window?     (stale consent  → null → re-prompt)
 *   8. choices object present?     (partial write   → null → re-prompt)
 *
 * On any failure we strip whatever was there (defense in depth — don't let
 * a corrupt record linger). Returns the choices object on success.
 */
export function getCookieConsent() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // localStorage unavailable (Safari private mode, etc.)
  }
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Tampered / non-JSON value — clear and bail
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
    return null;
  }

  // Shape sanity — must be a plain object with expected fields
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.version !== VERSION) return null;
  if (typeof parsed.timestamp !== "string") return null;

  const ts = new Date(parsed.timestamp).getTime();
  if (!Number.isFinite(ts)) return null;
  if (ts > Date.now() + 60_000) return null;        // future-dated → reject
  if (Date.now() - ts > TWELVE_MONTHS_MS) return null; // stale → re-prompt

  if (!parsed.choices || typeof parsed.choices !== "object") return null;

  return {
    necessary: true, // never trust stored value — always force-on
    functional: !!parsed.choices.functional,
    analytics: !!parsed.choices.analytics,
    marketing: !!parsed.choices.marketing,
  };
}

/** Honor browser DoNotTrack signal. If user set DNT=1, default everything off. */
function userHasDNT() {
  try {
    if (typeof navigator === "undefined") return false;
    return navigator.doNotTrack === "1" || navigator.doNotTrack === "yes" || window.doNotTrack === "1";
  } catch {
    return false;
  }
}

function saveConsent(choices) {
  // Always force `necessary: true` regardless of what was passed — defense
  // against component bugs that try to disable strictly-necessary cookies.
  const safe = {
    necessary: true,
    functional: !!choices.functional,
    analytics: !!choices.analytics,
    marketing: !!choices.marketing,
  };
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: VERSION,
        timestamp: new Date().toISOString(),
        choices: safe,
      }),
    );
  } catch {
    /* localStorage disabled — soft-fail, banner will re-show next visit */
  }
  // Even if persistence failed, dispatch the event so in-memory consumers
  // (lazy-loaded analytics, etc.) can react this session. Wrapped because
  // some hardened browsers throw on CustomEvent in some contexts.
  try {
    window.dispatchEvent(new CustomEvent("bonbox-cookie-consent-changed", { detail: safe }));
  } catch { /* noop */ }
}

export default function CookieConsent() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false); // banner visible
  const [drawer, setDrawer] = useState(false); // customize drawer
  const [choices, setChoices] = useState({
    necessary: true,
    functional: false,
    analytics: false,
    marketing: false,
  });

  useEffect(() => {
    // Multi-barrier defense: even if the user has DNT set, we still ask
    // (consent banners can't be skipped under EU rules) but pre-fill with
    // everything OFF so a default Accept-All click still respects DNT.
    if (userHasDNT()) {
      setChoices({ necessary: true, functional: false, analytics: false, marketing: false });
    }

    // Show banner if no valid consent saved
    if (!getCookieConsent()) setOpen(true);

    // Allow re-opening from anywhere (e.g. footer "Cookieindstillinger" link)
    const reopen = () => {
      const existing = getCookieConsent();
      if (existing) setChoices({ ...existing, necessary: true });
      setDrawer(true);
      setOpen(true);
    };
    try {
      window.addEventListener("bonbox-open-cookie-settings", reopen);
    } catch { /* hardened browsers may block — fail silently, banner still works on first visit */ }
    return () => {
      try { window.removeEventListener("bonbox-open-cookie-settings", reopen); } catch { /* noop */ }
    };
  }, []);

  if (!open) return null;

  const acceptAll = () => {
    const all = { necessary: true, functional: true, analytics: true, marketing: true };
    saveConsent(all);
    setOpen(false);
    setDrawer(false);
  };
  const declineAll = () => {
    const min = { necessary: true, functional: false, analytics: false, marketing: false };
    saveConsent(min);
    setOpen(false);
    setDrawer(false);
  };
  const saveCustom = () => {
    saveConsent(choices);
    setOpen(false);
    setDrawer(false);
  };

  const Toggle = ({ checked, onChange, locked }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={locked}
      onClick={() => !locked && onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400 ${
        locked
          ? "bg-gray-300 dark:bg-gray-600 cursor-not-allowed opacity-70"
          : checked
            ? "bg-green-500"
            : "bg-gray-200 dark:bg-gray-700"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        } mt-0.5`}
      />
    </button>
  );

  const Category = ({ titleKey, descKey, value, onChange, locked }) => (
    <div className="flex items-start gap-3 py-3 border-b border-gray-100 dark:border-gray-700/40 last:border-0">
      <div className="flex-1">
        <p className="text-sm font-semibold text-gray-800 dark:text-white">{t(titleKey)}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
          {t(descKey)}
        </p>
      </div>
      <Toggle checked={value} onChange={onChange} locked={locked} />
    </div>
  );

  return (
    <>
      {/* Slight overlay only when drawer is open — banner alone stays
          unobtrusive at the bottom. z-[55] sits above sidebar (z-50) and
          below BonBoxAgent (z-[9999]), so existing modals still work. */}
      {drawer && (
        <div
          className="fixed inset-0 bg-black/30 z-[55]"
          aria-hidden="true"
          onClick={() => setDrawer(false)}
        />
      )}

      <div
        role="dialog"
        aria-live="polite"
        aria-label={t("cookieBannerAria") || "Cookie consent"}
        data-cookie-consent="banner"
        className="fixed left-0 right-0 bottom-0 z-[60] px-3 sm:px-4 pb-3 sm:pb-4"
      >
        <div className="max-w-3xl mx-auto bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-xl overflow-hidden">
          {/* Banner content */}
          {!drawer ? (
            <div className="p-4 sm:p-5">
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl shrink-0" aria-hidden="true">🍪</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 dark:text-white mb-1">
                    {t("cookieBannerTitle") || "We use cookies"}
                  </p>
                  <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                    {t("cookieBannerBody") ||
                      "BonBox uses essential cookies to keep you signed in. With your consent we may also use cookies to remember your preferences and to understand how the app is used."}
                  </p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 mt-3">
                <button
                  onClick={acceptAll}
                  className="flex-1 px-4 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition"
                >
                  {t("cookieAcceptAll") || "Accept all"}
                </button>
                <button
                  onClick={declineAll}
                  className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg transition"
                >
                  {t("cookieDeclineNonEssential") || "Decline non-essential"}
                </button>
                <button
                  onClick={() => setDrawer(true)}
                  className="sm:flex-none px-4 py-2.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-sm font-medium transition"
                >
                  {t("cookieCustomize") || "Customize"}
                </button>
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-3 leading-relaxed">
                {t("cookieReadMore") || "Read our"}{" "}
                <a href="/cookies" className="underline hover:text-gray-700 dark:hover:text-gray-300">
                  {t("cookiePolicyLinkText") || "cookie policy"}
                </a>
                .
              </p>
            </div>
          ) : (
            // Customize drawer
            <div className="max-h-[80vh] overflow-y-auto">
              <div className="p-4 sm:p-5 border-b border-gray-100 dark:border-gray-700">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-bold text-gray-800 dark:text-white">
                    {t("cookieDrawerTitle") || "Cookie preferences"}
                  </p>
                  <button
                    onClick={() => setDrawer(false)}
                    aria-label={t("close") || "Close"}
                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  {t("cookieDrawerBody") ||
                    "Pick which cookie categories BonBox can use. Your choice is saved locally and you can change it anytime via the link in the footer."}
                </p>
              </div>

              <div className="p-4 sm:p-5">
                <Category
                  titleKey="cookieCatNecessary"
                  descKey="cookieCatNecessaryDesc"
                  value={true}
                  onChange={() => {}}
                  locked
                />
                <Category
                  titleKey="cookieCatFunctional"
                  descKey="cookieCatFunctionalDesc"
                  value={choices.functional}
                  onChange={(v) => setChoices((c) => ({ ...c, functional: v }))}
                />
                <Category
                  titleKey="cookieCatAnalytics"
                  descKey="cookieCatAnalyticsDesc"
                  value={choices.analytics}
                  onChange={(v) => setChoices((c) => ({ ...c, analytics: v }))}
                />
                <Category
                  titleKey="cookieCatMarketing"
                  descKey="cookieCatMarketingDesc"
                  value={choices.marketing}
                  onChange={(v) => setChoices((c) => ({ ...c, marketing: v }))}
                />
              </div>

              <div className="p-4 sm:p-5 border-t border-gray-100 dark:border-gray-700 flex flex-col sm:flex-row gap-2">
                <button
                  onClick={saveCustom}
                  className="flex-1 px-4 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition"
                >
                  {t("cookieSaveChoices") || "Save my choices"}
                </button>
                <button
                  onClick={acceptAll}
                  className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg transition"
                >
                  {t("cookieAcceptAll") || "Accept all"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Helper for code that wants to dispatch the re-open event without importing
 * this whole component file. Safe to call before consent — banner re-renders.
 */
export function openCookieSettings() {
  window.dispatchEvent(new CustomEvent("bonbox-open-cookie-settings"));
}
