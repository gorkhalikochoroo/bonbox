/**
 * SmartLanguageToast — one-time "we picked Danish from your browser"
 * notice with a "switch to English" shortcut.
 *
 * Why this exists:
 *   With auto-detect, the dashboard might quietly load in Danish for a
 *   user whose first instinct was English. Without telling them why, it
 *   feels like a bug. This toast says "we picked X from {your browser /
 *   your currency}" once, then never again.
 *
 * Rendered at the top of <Layout> if and only if:
 *   • localStorage["bonbox_lang_auto_picked"] is set ("browser" or
 *     "currency"), AND
 *   • localStorage["bonbox_lang_toast_shown"] is NOT set
 *
 * Calm UX:
 *   • Single line, dismissable. Doesn't block.
 *   • "Switch to English" link clears the auto-pick and sets lang=en.
 *   • Marks itself shown on close so it never re-appears.
 */
import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";


const SHOWN_KEY = "bonbox_lang_toast_shown";
// How long the one-time notice stays before it steps aside on its own.
export const AUTO_HIDE_MS = 8000;
const AUTO_PICKED_KEY = "bonbox_lang_auto_picked";

const NATIVE_LABEL = {
  en: "English",
  da: "Dansk",
  np: "नेपाली",
  vi: "Tiếng Việt",
  th: "ภาษาไทย",
  tr: "Türkçe",
};


export default function SmartLanguageToast() {
  const { t, lang, setLang } = useLanguage();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    const auto = localStorage.getItem(AUTO_PICKED_KEY);
    const shown = localStorage.getItem(SHOWN_KEY);
    if (auto && !shown && lang !== "en") {
      setSource(auto);
      setOpen(true);
    }
  }, [lang]);

  // Shown ONCE, for a few seconds. It is fixed at the top of every screen and
  // had no timeout, so until the owner found the × it covered each page's
  // title (Kasserapport, Forsiden, Vagtplan, Reservationer) and the e-mail
  // banner (first-15 walk, 12 Oct). Marked shown when it goes, exactly as a
  // tap on × does; the language stays switchable in the menu.
  useEffect(() => {
    if (!open) return undefined;
    const id = setTimeout(() => {
      setOpen(false);
      try { localStorage.setItem(SHOWN_KEY, "1"); } catch { /* storage refused — it simply shows again next visit */ }
    }, AUTO_HIDE_MS);
    return () => clearTimeout(id);
  }, [open]);

  function dismiss() {
    setOpen(false);
    try { localStorage.setItem(SHOWN_KEY, "1"); } catch { /* silent */ }
  }

  function switchToEnglish() {
    setLang("en");
    dismiss();
  }

  if (!open) return null;

  const nativeLabel = NATIVE_LABEL[lang] || lang;
  const sourceText = source === "browser"
    ? (t("smartLangSourceBrowser") || "from your browser")
    : (t("smartLangSourceCurrency") || "from your currency");

  // dark:z-40 — under the page's own toasts (ToastContainer, z-50). Since the
  // dark card went opaque, this notice sat ON TOP of a real error at 390: both
  // are fixed at the same top offset and this one renders later, so "Hent PDF
  // failed" was covered completely. A one-time language notice must never
  // hide a failure. Light keeps its z-order in this dark-only pass (it has
  // the same overlap under a 95%-opaque gray-900 — logged for the owner).
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 z-50 dark:z-40 max-w-md w-[92vw] sm:w-auto px-4 py-2.5 rounded-xl bg-gray-900/95 text-white shadow-sm dark:bg-[rgb(var(--surface-raised))] dark:ring-1 dark:ring-[rgb(var(--surface-line-strong))] dark:shadow-[0_4px_12px_rgb(0_0_0/0.4)] flex items-center gap-3 text-[13px] top-[calc(env(safe-area-inset-top,0px)+4.25rem)] md:top-[max(1rem,env(safe-area-inset-top))]"
    >
      <span className="flex-1 min-w-0">
        <Globe className="inline w-3.5 h-3.5 mr-1.5 -mt-0.5 opacity-80" aria-hidden="true" />
        {(t("smartLangPicked") || "We picked {lang} {source}.")
          .replace("{lang}", nativeLabel)
          .replace("{source}", sourceText)}
      </span>
      <button
        type="button"
        onClick={switchToEnglish}
        className="text-gray-300 hover:text-gray-200 underline-offset-2 hover:underline font-semibold whitespace-nowrap"
      >
        {t("smartLangSwitchEn") || "Switch to English"}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("close") || "Close"}
        className="text-gray-400 hover:text-white text-base leading-none"
      >
        ×
      </button>
    </div>
  );
}
