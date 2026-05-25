import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { trackEvent } from "../hooks/useEventLog";
import Icon from "./ui/Icon";

/**
 * Active per-owner AI insights with 👍/👎 feedback.
 *
 * Shown on the dashboard. Each card represents one detected pattern from
 * the backend's owner_patterns engine. The thumbs feedback IS the thesis
 * RQ1 instrument — captures which AI suggestions correlate with retention.
 *
 * If the user has fewer than ~14 days of data, the backend returns an empty
 * list and this component renders nothing (no fake-content placeholder).
 */
export default function InsightsCard({ className = "" }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  // Local optimistic state for items the user just dismissed / acted-on /
  // gave feedback. We don't refetch until they reload — feels snappier.
  const [localFeedback, setLocalFeedback] = useState({});

  useEffect(() => {
    let cancelled = false;
    api
      .get("/patterns/active")
      .then((res) => {
        if (!cancelled) setItems(res.data || []);
      })
      .catch(() => {
        // Silent — patterns are optional, never block the dashboard
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleFeedback = async (id, value) => {
    setLocalFeedback((prev) => ({ ...prev, [id]: value }));
    try {
      await api.post(`/patterns/${id}/feedback`, { feedback: value });
      trackEvent("insight_feedback", "dashboard", `${value}`);
    } catch {
      // Roll back optimistic update on failure
      setLocalFeedback((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleDismiss = async (id) => {
    setLocalFeedback((prev) => ({ ...prev, [id]: "dismissed" }));
    try {
      await api.post(`/patterns/${id}/dismiss`);
      trackEvent("insight_dismissed", "dashboard", id);
    } catch {
      setLocalFeedback((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleActed = async (id) => {
    setLocalFeedback((prev) => ({ ...prev, [id]: "acted" }));
    try {
      await api.post(`/patterns/${id}/acted`);
      trackEvent("insight_acted", "dashboard", id);
    } catch {
      setLocalFeedback((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  // Render nothing while loading or if no insights — don't pollute dashboard
  // with a "no insights yet" empty state. The component should be invisible
  // until it has something useful to say.
  if (loading || items.length === 0) return null;

  // Filter out items the user already dismissed/acted-on this session
  const visible = items.filter((i) => {
    const local = localFeedback[i.id];
    return local !== "dismissed" && local !== "acted";
  });
  if (visible.length === 0) return null;

  return (
    // Neutral surface — same recipe Card uses (rounded-xl, gray-200 border,
    // white bg). Previously a lavender / indigo gradient that violated the
    // "gray-* only" DNA rule. The Sparkles icon (gray-500) gives the panel
    // its identity without painting the whole container.
    <div className={`bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-4 sm:p-5 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon name="Sparkles" size={20} className="text-gray-500 dark:text-gray-400" />
          <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">
            Insights for your business
          </h2>
        </div>
        <Link
          to="/insights"
          className="text-xs text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white font-medium"
        >
          View all ({visible.length}) →
        </Link>
      </div>

      <div className="space-y-2.5">
        {visible.slice(0, 5).map((p) => {
          const fb = localFeedback[p.id] || p.feedback;
          // Severity nests inside the neutral panel — sub-cards keep the
          // semantic accent (red / amber) only when the severity is
          // data-meaningful. "info" stays fully neutral.
          const sevColors =
            p.severity === "critical"
              ? "border-red-200 bg-white dark:bg-gray-800/60"
              : p.severity === "warning"
              ? "border-amber-200 bg-white dark:bg-gray-800/60"
              : "border-gray-200 dark:border-gray-700/60 bg-white dark:bg-gray-800/60";
          return (
            <div
              key={p.id}
              className={`rounded-xl border p-3 ${sevColors}`}
            >
              <div className="flex items-start gap-2 mb-1">
                {p.severity === "critical" && (
                  <Icon name="AlertTriangle" size={14} className="text-red-500 dark:text-red-400 mt-0.5 shrink-0" />
                )}
                {p.severity === "warning" && (
                  <Icon name="AlertTriangle" size={14} className="text-amber-500 dark:text-amber-400 mt-0.5 shrink-0" />
                )}
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex-1">{p.title}</h3>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-2">{p.detail}</p>
              {p.suggested_action && (
                <p className="text-xs text-gray-700 dark:text-gray-300 font-medium mb-2">
                  → {p.suggested_action}
                </p>
              )}

              <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50">
                <div className="flex gap-1.5">
                  <button
                    onClick={() => handleFeedback(p.id, "useful")}
                    disabled={!!fb}
                    aria-label="Useful insight"
                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition ${
                      fb === "useful"
                        ? "bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
                    }`}
                  >
                    <Icon name="ThumbsUp" size={14} />
                    <span>{fb === "useful" ? "Thanks" : "Useful"}</span>
                  </button>
                  <button
                    onClick={() => handleFeedback(p.id, "not_useful")}
                    disabled={!!fb}
                    aria-label="Not useful"
                    className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition ${
                      fb === "not_useful"
                        ? "bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
                    }`}
                  >
                    <Icon name="ThumbsDown" size={14} />
                    <span>{fb === "not_useful" ? "Noted" : "Not useful"}</span>
                  </button>
                </div>
                <div className="flex gap-1.5">
                  {p.suggested_action && (
                    <button
                      onClick={() => handleActed(p.id)}
                      className="text-xs px-2 py-1 rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 font-medium"
                    >
                      Done it
                    </button>
                  )}
                  <button
                    onClick={() => handleDismiss(p.id)}
                    aria-label="Dismiss"
                    className="text-xs px-2 py-1 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
