/**
 * SmartDriftBanner — surfaces "things have changed" findings on the
 * Dashboard.
 *
 * The weekly cron job runs Smart inferences against fresh data and,
 * when something materially differs from what's saved, persists a
 * SmartDriftFinding. The dashboard fetches open findings on mount
 * and renders one calm banner per finding:
 *
 *    "Your hours look different lately"
 *    "Friday hours: 09:00–17:00 → 10:00–22:00"
 *    [Update]  [Not now]
 *
 * Behaviours:
 *   • "Update" routes to the relevant Smart card (Profile page for
 *     staffing) and POSTs /smart-drift/{id}/apply to close the finding.
 *   • "Not now" POSTs /smart-drift/{id}/dismiss with a 14d cooldown.
 *   • Telemetry: viewed / applied / dismissed events fired through
 *     useSmartTelemetry so we can learn how often drift is acted on.
 *
 * Multi-layer security:
 *   • Endpoint is auth-gated, tenant-scoped.
 *   • Frontend never touches another owner's findings — server filters.
 *   • Optimistic UI: row removes immediately on action; rollback if the
 *     POST fails (rare; we surface a small inline error).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useSmartTelemetry } from "../hooks/useSmartTelemetry";


export default function SmartDriftBanner() {
  const { t } = useLanguage();
  const { track } = useSmartTelemetry();
  const navigate = useNavigate();
  const [findings, setFindings] = useState([]);
  const [busy, setBusy] = useState({});  // { id: "applying" | "dismissing" }
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.get("/smart-drift")
      .then((res) => {
        if (!alive) return;
        const list = res?.data?.findings || [];
        setFindings(list);
        for (const f of list) {
          // Map kind → telemetry page so we can slice by surface later.
          const page = f.kind === "staffing" ? "smart_staffing"
                     : f.kind === "inventory" ? "smart_inventory"
                     : "smart_terminals";
          track("smart_proposal_viewed", page, {
            drift_kind: f.kind,
          });
        }
      })
      .catch(() => {
        // Silent — banner is non-critical. A real failure is surfaced
        // via /event-log anyway so we'll see it in the admin telemetry.
        if (alive) setFindings([]);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!findings.length) return null;

  async function dismiss(f) {
    setBusy((b) => ({ ...b, [f.id]: "dismissing" }));
    setError("");
    // Optimistic UI
    const prev = findings;
    setFindings((rows) => rows.filter((r) => r.id !== f.id));
    try {
      await api.post(`/smart-drift/${f.id}/dismiss`);
      const page = f.kind === "staffing" ? "smart_staffing"
                 : f.kind === "inventory" ? "smart_inventory"
                 : "smart_terminals";
      track("smart_proposal_cancelled", page, { drift_kind: f.kind });
    } catch (err) {
      // Roll back
      setFindings(prev);
      setError(err?.response?.data?.detail || (t("smartDriftDismissFailed") || "Couldn't dismiss."));
    } finally {
      setBusy((b) => { const c = { ...b }; delete c[f.id]; return c; });
    }
  }

  async function applyAndNavigate(f) {
    setBusy((b) => ({ ...b, [f.id]: "applying" }));
    setError("");
    try {
      // Mark applied so the banner doesn't re-surface; the actual
      // saving of the new profile happens in the destination Smart
      // card when the owner taps "Save these hours".
      await api.post(`/smart-drift/${f.id}/apply`);
      const page = f.kind === "staffing" ? "smart_staffing"
                 : f.kind === "inventory" ? "smart_inventory"
                 : "smart_terminals";
      track("smart_proposal_accepted", page, { drift_kind: f.kind });
      // Route to the Smart card. Staffing lives on the Profile page;
      // inventory on the inventory page; terminals on multi-close.
      const dest = f.kind === "staffing" ? "/profile"
                 : f.kind === "inventory" ? "/inventory"
                 : "/daily-close/multi";
      navigate(dest);
    } catch (err) {
      setError(err?.response?.data?.detail || (t("smartDriftApplyFailed") || "Couldn't open."));
      setBusy((b) => { const c = { ...b }; delete c[f.id]; return c; });
    }
  }

  return (
    <div className="space-y-2 mb-4">
      {findings.map((f) => (
        <div
          key={f.id}
          role="region"
          aria-label={f.title}
          className="rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-900/10 px-4 py-3 flex items-start gap-3"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {f.title}
            </div>
            {f.summary && (
              <div className="text-[12px] text-gray-600 dark:text-gray-300 mt-0.5">
                {f.summary}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => dismiss(f)}
              disabled={!!busy[f.id]}
              className="px-2.5 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md disabled:opacity-50"
            >
              {t("smartDriftNotNow") || "Not now"}
            </button>
            <button
              type="button"
              onClick={() => applyAndNavigate(f)}
              disabled={!!busy[f.id]}
              className="px-3 py-1 text-xs font-semibold rounded-md bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white disabled:opacity-50"
            >
              {t("smartDriftUpdate") || "Update"}
            </button>
          </div>
        </div>
      ))}
      {error && (
        <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
      )}
    </div>
  );
}
