/**
 * DemoActiveBanner — Task #68 polish
 *
 * Visible reminder that the dashboard is showing sample data so the
 * owner never confuses demo numbers with real ones.  Renders just
 * below the dashboard header when `/demo/status` reports has_demo.
 *
 * Self-hides automatically once demo data is cleared.  No
 * localStorage dismissal — the only way to dismiss is to actually
 * clear the data, which is the right outcome.
 *
 * Privacy: this hits the same `/demo/status` endpoint as
 * DemoDataCard.  No sensitive fields fetched.
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";

export default function DemoActiveBanner() {
  const { t } = useLanguage();
  const [hasDemo, setHasDemo] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get("/demo/status")
      .then((r) => alive && setHasDemo(!!r?.data?.has_demo))
      .catch(() => alive && setHasDemo(false));
    // Re-sync on data changes (dashboard dispatches this event after
    // mutations) so the banner disappears the moment seed/clear runs.
    const onSync = () => {
      api
        .get("/demo/status")
        .then((r) => alive && setHasDemo(!!r?.data?.has_demo))
        .catch(() => {});
    };
    window.addEventListener("bonbox-data-changed", onSync);
    return () => {
      alive = false;
      window.removeEventListener("bonbox-data-changed", onSync);
    };
  }, []);

  const onClear = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await api.post("/demo/clear");
      setHasDemo(false);
      try {
        window.dispatchEvent(new CustomEvent("bonbox-data-changed"));
      } catch {
        /* no-op */
      }
      // Force a clean reload so every chart drops back to its empty
      // state — there are 20+ subscribers; a single event won't reach
      // them all reliably.
      setTimeout(() => window.location.reload(), 150);
    } catch {
      setClearing(false);
    }
  };

  if (!hasDemo) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-between gap-3 px-3.5 py-2.5
                 rounded-xl border border-amber-200/70 dark:border-amber-900/40
                 bg-amber-50/80 dark:bg-amber-900/15"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon
          name="Sparkles"
          size={16}
          className="text-amber-600 dark:text-amber-400 shrink-0"
        />
        <p className="text-xs sm:text-sm text-amber-800 dark:text-amber-200 truncate">
          {t(
            "demoActiveBanner",
            "Showing sample data so you can explore. Clear it whenever you're ready to add your own.",
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={onClear}
        disabled={clearing}
        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5
                   rounded-lg text-xs font-medium
                   bg-amber-100 hover:bg-amber-200
                   dark:bg-amber-900/30 dark:hover:bg-amber-900/50
                   text-amber-900 dark:text-amber-100
                   disabled:opacity-60 disabled:cursor-wait
                   focus:outline-none focus-visible:ring-2
                   focus-visible:ring-amber-500 focus-visible:ring-offset-2
                   dark:focus-visible:ring-offset-gray-900"
      >
        <Icon name="Eraser" size={14} />
        {clearing
          ? t("demoActiveClearing", "Clearing…")
          : t("demoActiveClear", "Clear sample data")}
      </button>
    </div>
  );
}
