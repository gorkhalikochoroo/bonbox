import { useEffect, useState } from "react";
import api from "../services/api";

/**
 * Anomaly Alerts Card — small banner above the dashboard listing
 * un-dismissed alerts from the past week. Only renders when alerts
 * exist; otherwise the component returns null and takes zero space.
 *
 * Renders ONLY pure text — title and detail strings come from
 * AnomalyAlert.title / .detail, both validated server-side (max
 * lengths, no HTML, numeric-fact match against the source candidate).
 *
 * Severity → colour:
 *   high   → red dot
 *   medium → amber dot
 *   low    → slate dot
 */

const KIND_ICONS = {
  sale_outlier: "💰",
  unusual_hour: "🕒",
  velocity_burst: "⚡",
  expense_outlier: "💸",
  failed_logins: "🔒",
  many_deletions: "🗑",
  khata_large: "📒",
  margin_drop: "📉",
};

function dotColor(severity) {
  if (severity === "high") return "#dc2626";    // red-600
  if (severity === "medium") return "#f59e0b";  // amber-500
  return "#94a3b8";                             // slate-400
}

export default function AnomalyAlertsCard() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(new Set());

  const fetchAlerts = () => {
    api
      .get("/dashboard/anomalies")
      .then((res) => setAlerts(Array.isArray(res.data?.alerts) ? res.data.alerts : []))
      .catch(() => setAlerts([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAlerts();
  }, []);

  const onDismiss = async (id) => {
    if (dismissing.has(id)) return;
    setDismissing((prev) => new Set(prev).add(id));
    // Optimistic remove so the UI feels instant
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    try {
      await api.post(`/dashboard/anomalies/${id}/dismiss`, { reason: "ignore" });
    } catch {
      // On failure, refetch to restore truth
      fetchAlerts();
    } finally {
      setDismissing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  // Hide entirely while loading or when nothing to show
  if (loading || alerts.length === 0) return null;

  const visible = expanded ? alerts : alerts.slice(0, 3);
  const hiddenCount = Math.max(0, alerts.length - visible.length);

  // Highest severity present sets the card's accent
  const hasHigh = alerts.some((a) => a.severity === "high");
  const accent = hasHigh ? "#dc2626" : "#f59e0b";

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-xl border shadow-sm p-5 sm:p-6"
      style={{ borderColor: hasHigh ? "rgba(220,38,38,0.25)" : "rgba(245,158,11,0.25)" }}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: hasHigh ? "rgba(220,38,38,0.10)" : "rgba(245,158,11,0.10)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h3 className="text-[15px] sm:text-[15.5px] font-semibold text-gray-900 dark:text-white tracking-tight truncate">
            {alerts.length === 1 ? "1 thing to review" : `${alerts.length} things to review`}
          </h3>
        </div>
        <span className="text-[11px] uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500 shrink-0">
          {alerts.some((a) => a.polished_by_ai) ? "AI watchdog" : "BonBox watchdog"}
        </span>
      </div>

      <ul className="space-y-2.5">
        {visible.map((a) => (
          <li
            key={a.id}
            className="flex items-start gap-2.5 p-2.5 rounded-lg bg-gray-50/60 dark:bg-gray-800/40 border border-gray-100 dark:border-gray-700/60"
          >
            <span
              className="w-1.5 h-1.5 rounded-full mt-[8px] shrink-0"
              style={{ backgroundColor: dotColor(a.severity) }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <p className="text-[13.5px] font-medium text-gray-900 dark:text-gray-100 leading-snug">
                {KIND_ICONS[a.kind] ? `${KIND_ICONS[a.kind]} ` : ""}{a.title}
              </p>
              {a.detail && (
                <p className="text-[12.5px] text-gray-600 dark:text-gray-400 mt-0.5 leading-relaxed">
                  {a.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(a.id)}
              disabled={dismissing.has(a.id)}
              aria-label="Dismiss alert"
              title="Mark reviewed"
              className="w-7 h-7 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700/60 dark:hover:text-gray-200 disabled:opacity-50 transition flex items-center justify-center shrink-0"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 text-[12px] text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition"
        >
          Show {hiddenCount} more…
        </button>
      )}
    </div>
  );
}
