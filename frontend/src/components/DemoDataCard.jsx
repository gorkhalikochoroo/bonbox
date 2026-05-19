/**
 * DemoDataCard — Task #68
 *
 * "Try BonBox with sample data" CTA shown on the empty Dashboard so
 * a brand-new owner can immediately see what the product looks like
 * with 30 days of realistic Mirabelle-style closes, inventory, and
 * expenses populated on their OWN account.
 *
 * Self-hide rules:
 *   • has_real === true  → the owner has real data already, nothing
 *                          to demo; never render.
 *   • has_demo === true  → already seeded; the "Clear demo data"
 *                          control lives on the Profile → Privacy
 *                          section, not here, so this card stays
 *                          hidden once seeded.
 *   • localStorage dismissal (30 days) — the owner can wave it away
 *                          if they prefer the empty state.
 *
 * Privacy:
 *   • The seed is per-user, tenant-scoped server-side.  No data
 *     about this user is sent to any third party.
 *   • Every seed/clear is audit-logged for GDPR compliance.
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";

const DISMISS_KEY = "bonbox_demo_card_dismissed_until";

function _isDismissed() {
  try {
    const until = parseInt(localStorage.getItem(DISMISS_KEY) || "0", 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

function _dismissFor(days = 30) {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + days * 86400_000));
  } catch {
    /* ignore — best effort */
  }
}

export default function DemoDataCard() {
  const { t } = useLanguage();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(() => _isDismissed());

  useEffect(() => {
    if (hidden) return;
    let alive = true;
    api
      .get("/demo/status")
      .then((r) => alive && setStatus(r.data || {}))
      .catch(() => {
        // Best-effort: if the endpoint fails we just don't show the
        // card.  Better than risking a broken dashboard on a side feature.
        if (alive) setStatus({ has_demo: false, has_real: true });
      });
    return () => {
      alive = false;
    };
  }, [hidden]);

  if (hidden) return null;
  if (!status) return null;
  // The two conditions where we should not render
  if (status.has_real || status.has_demo) return null;

  const onSeed = async () => {
    setLoading(true);
    setError("");
    try {
      await api.post("/demo/seed");
      // Tell the rest of the dashboard to refresh — DailyBrief, summary,
      // breakdown, etc. all listen for this event.
      try {
        window.dispatchEvent(new CustomEvent("bonbox-data-changed"));
      } catch {
        /* no-op */
      }
      // Reload the page state so the new data renders immediately.
      // setTimeout gives the dispatched event a microtask to drain
      // before the navigation kick.
      setTimeout(() => {
        window.location.reload();
      }, 150);
    } catch (err) {
      const reason = err?.response?.data?.detail?.reason || "";
      if (reason === "user has real data") {
        // Edge: the user just typed in something. Re-fetch status.
        setStatus({ has_demo: false, has_real: true });
      } else if (reason === "demo data already seeded") {
        setStatus({ has_demo: true, has_real: false });
      } else {
        setError(
          t(
            "demoSeedError",
            "Could not load sample data. Please try again.",
          ),
        );
      }
      setLoading(false);
    }
  };

  const onDismiss = () => {
    _dismissFor(30);
    setHidden(true);
  };

  return (
    <div
      className="bg-gradient-to-br from-violet-50 to-indigo-50
                 dark:from-violet-900/15 dark:to-indigo-900/15
                 rounded-2xl p-5 sm:p-6 border border-violet-200/60
                 dark:border-violet-800/40 shadow-sm"
      role="region"
      aria-label={t("demoCardAria", "Try BonBox with sample data")}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 p-2 rounded-xl bg-violet-100 dark:bg-violet-900/30">
          <Icon
            name="Sparkles"
            className="w-5 h-5 text-violet-600 dark:text-violet-400"
          />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            {t("demoCardTitle", "See BonBox in action")}
          </h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            {t(
              "demoCardBody",
              "Load 30 days of sample restaurant data (closes, inventory, expenses) onto your account so you can explore the dashboard, brief, and reports before adding your own. Clear it any time from Profile → Privacy.",
            )}
          </p>

          {error && (
            <div
              className="mt-3 text-xs text-red-600 dark:text-red-400"
              role="alert"
            >
              {error}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onSeed}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl
                         bg-violet-600 hover:bg-violet-700 active:bg-violet-800
                         disabled:opacity-60 disabled:cursor-wait
                         text-white text-sm font-medium shadow-sm
                         focus:outline-none focus:ring-2 focus:ring-violet-500
                         focus:ring-offset-2 dark:focus:ring-offset-gray-900"
            >
              {loading ? (
                <>
                  <Icon name="Loader" className="w-4 h-4 animate-spin" />
                  {t("demoCardLoading", "Loading sample data…")}
                </>
              ) : (
                <>
                  <Icon name="Sparkles" className="w-4 h-4" />
                  {t("demoCardCta", "Try with sample data")}
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onDismiss}
              className="px-3 py-2 rounded-xl text-sm text-gray-600
                         dark:text-gray-300 hover:bg-white/60
                         dark:hover:bg-gray-800/60 focus:outline-none
                         focus:ring-2 focus:ring-violet-500"
            >
              {t("demoCardSkip", "No thanks")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
