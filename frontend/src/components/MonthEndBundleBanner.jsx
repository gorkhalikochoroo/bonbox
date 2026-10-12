import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { ClipboardCheck } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";

/**
 * MonthEndBundleBanner — nudges the owner into Månedsafslutning (/month-end):
 * what is still open for the month, and the revisor package (summary PDF,
 * CSVs, every bilag) to download or send.
 *
 * Visible window:
 *   • Last 5 days of the current month  (heads-up: "coming up")
 *   • First 5 days of the next month     (do-it-now: previous month closed)
 *
 * Hidden window: middle of the month — no nag fatigue.
 *
 * Dismissible per-month: clicking ✕ stores the YYYY-MM in localStorage so
 * the banner doesn't re-appear for the same period. Different month, new
 * banner — that's intentional, this is a once-a-month action.
 *
 * Tone matches the other top-of-dashboard banners (SmartDrift, AnomalyAlerts):
 * unobtrusive, single-action, time-relevant.
 */
export default function MonthEndBundleBanner() {
  const { t, lang } = useLanguage();
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState("heads_up"); // or "do_it_now"
  const [targetPeriod, setTargetPeriod] = useState(""); // YYYY-MM of the period to export

  useEffect(() => {
    const today = new Date();
    const dayOfMonth = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

    let activePhase = null;
    let period;

    if (dayOfMonth >= daysInMonth - 4) {
      // Last 5 days of current month — heads-up that close is coming.
      activePhase = "heads_up";
      period = today;
    } else if (dayOfMonth <= 5) {
      // First 5 days of new month — previous month is ready to send.
      activePhase = "do_it_now";
      period = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    } else {
      activePhase = null;
    }

    if (!activePhase) return;

    const yyyy = period.getFullYear();
    const mm = String(period.getMonth() + 1).padStart(2, "0");
    const periodKey = `${yyyy}-${mm}`;

    // Dismissed for this period? Stay hidden.
    try {
      const dismissed = localStorage.getItem(`bonbox_bundle_banner_dismissed_${periodKey}`);
      if (dismissed === "1") return;
    } catch {
      /* localStorage off — banner stays visible, no harm */
    }

    setPhase(activePhase);
    setTargetPeriod(periodKey);
    setVisible(true);
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(`bonbox_bundle_banner_dismissed_${targetPeriod}`, "1");
    } catch {
      /* ignore */
    }
    setVisible(false);
  };

  if (!visible) return null;

  const monthName = (() => {
    if (!targetPeriod) return "";
    const [y, m] = targetPeriod.split("-").map(Number);
    const d = new Date(y, m - 1, 1);
    // The app's language, not the browser's: a Danish sentence names the
    // month in Danish.
    return d.toLocaleDateString(lang === "da" ? "da-DK" : "en-GB", { month: "long", year: "numeric" });
  })();

  const title =
    phase === "do_it_now"
      ? t("bundleBannerTitleNow", "Month-end: send last month to your revisor")
      : t("bundleBannerTitleSoon", "Month-end is coming up");
  const body =
    phase === "do_it_now"
      // The month was written into a `||` fallback the populated key shadows,
      // so the banner named no month at all.
      ? t("bundleBannerBodyNow",
          "See what's still open for {month}, fix it, and send the revisor package — summary, CSV files and every receipt.",
          { month: monthName })
      : t("bundleBannerBodySoon",
          "Check what's still open for {month} — days without a close, expenses without a receipt — before the month ends.",
          { month: monthName });
  const cta =
    phase === "do_it_now"
      ? t("bundleBannerCtaNow", "Open month-end")
      : t("bundleBannerCtaSoon", "See what's open");

  // Distinct visual treatment per phase: amber for heads-up (passive),
  // green for do-it-now (active CTA).
  const wrapStyle =
    phase === "do_it_now"
      ? "bg-gray-50/80 dark:bg-[rgb(var(--surface-subtle))] border-gray-100 dark:border-[rgb(var(--surface-line))]"
      : "bg-amber-50/70 dark:bg-amber-900/15 border-amber-200 dark:border-amber-800";
  const btnStyle =
    phase === "do_it_now"
      ? "bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-600 dark:text-white dark:hover:bg-gray-500"
      : // Dark: an amber TINT with an amber edge, not a solid amber-600 slab
        // (the brightest solid on a night screen). Same hue as light.
        "bg-amber-600 hover:bg-amber-700 text-white dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/25 dark:shadow-[inset_0_0_0_1px_var(--color-amber-700)]";

  return (
    <div
      className={`relative rounded-xl border p-5 pr-12 ${wrapStyle}`}
      role="note"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("dismiss") || "Dismiss"}
        className="absolute top-3 right-3 w-7 h-7 rounded-full inline-flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 transition opacity-60 hover:opacity-100"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      <div className="flex items-start gap-4">
        <ClipboardCheck size={22} strokeWidth={1.75} className="shrink-0 mt-0.5 text-gray-500 dark:text-gray-400" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">
            {title}
          </h3>
          <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed mb-3">
            {body}
          </p>
          <Link
            to={targetPeriod ? `/month-end?month=${targetPeriod}` : "/month-end"}
            className={`inline-block px-4 py-2 rounded-xl text-sm font-semibold transition ${btnStyle}`}
          >
            {cta}
          </Link>
        </div>
      </div>
    </div>
  );
}
