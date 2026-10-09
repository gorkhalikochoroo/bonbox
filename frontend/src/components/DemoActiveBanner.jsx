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
import { useConfirm } from "../hooks/useConfirm";
import { useAuth } from "../hooks/useAuth";
import { Icon } from "./ui";

export default function DemoActiveBanner() {
  const { t, lang } = useLanguage();
  const confirm = useConfirm();
  const { user } = useAuth();
  // Only the owner's own session can clear: an invited member (manager /
  // cashier / viewer) or a revisor sees the owner's dashboard, but the server
  // refuses their POST /demo/clear (403 read_only). They get the label — this
  // is sample data — and no button that cannot work (review fix, 9 Oct).
  const canClear = !!user && String(user.role || "owner").toLowerCase() === "owner";
  const [hasDemo, setHasDemo] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");

  useEffect(() => {
    let alive = true;
    // scope=has_demo: the one answer this banner needs (one query) — it is
    // asked on every dashboard load. (An older server ignores the scope and
    // answers in full; has_demo is in it.)
    const read = () => api.get("/demo/status", { params: { scope: "has_demo" } });
    read()
      .then((r) => alive && setHasDemo(!!r?.data?.has_demo))
      .catch(() => alive && setHasDemo(false));
    // Re-sync on data changes (dashboard dispatches this event after
    // mutations) so the banner disappears the moment seed/clear runs.
    const onSync = () => {
      read()
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
    if (clearing || !canClear) return;
    // One tap used to clear — and took the revisor and bank details the
    // owner had saved on the demo profile. Now it says what goes and what
    // stays (the server keeps everything the owner typed), and asks.
    const ok = await confirm({
      title: t("demoClearConfirmTitle", "Clear the sample data?"),
      message: t("demoClearConfirmBody", "Removed: the sample days, stock, expenses, tables and bookings — and the sample company (Mirabelle ApS) and sample revisor on your profile.\nKept: everything you added yourself — your own days and expenses, your revisor, your bank details and your own company details."),
      confirmLabel: t("demoClearConfirmBtn", "Clear sample data"),
      cancelLabel: t("cancel", "Cancel"),
      destructive: true,
    });
    if (ok !== true) return;
    setClearing(true);
    setClearError("");
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
    } catch (err) {
      // Said, in the owner's language — never a button that silently resets.
      const detail = err?.response?.data?.detail;
      const worded = detail && typeof detail === "object"
        ? (lang === "da" ? detail.message_da : detail.message)
        : null;
      setClearError(
        typeof worded === "string" && worded.trim()
          ? worded
          : t("demoActiveClearFailed", "The sample data could not be cleared — try again."),
      );
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
        <div className="min-w-0">
          <p
            className={
              "text-xs sm:text-sm text-amber-800 dark:text-amber-200 " +
              (canClear ? "truncate" : "leading-snug")
            }
          >
            {canClear
              ? t(
                  "demoActiveBanner",
                  "Showing sample data so you can explore. Clear it whenever you're ready to add your own.",
                )
              : t(
                  "demoActiveBannerMember",
                  "This account is showing sample data — these are not real figures. Only the owner can clear it.",
                )}
          </p>
          {clearError && (
            <p role="alert" className="mt-0.5 text-xs text-red-700 dark:text-red-300">
              {clearError}
            </p>
          )}
        </div>
      </div>
      {canClear && (
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
      )}
    </div>
  );
}
