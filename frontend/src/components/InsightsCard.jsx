import { useEffect, useState } from "react";
import api from "../services/api";
import { trackEvent } from "../hooks/useEventLog";

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
    <div className={`bg-gradient-to-br from-purple-50 via-indigo-50 to-blue-50 dark:from-purple-900/20 dark:via-indigo-900/20 dark:to-blue-900/20 border border-indigo-200/60 dark:border-indigo-800/40 rounded-2xl p-4 sm:p-5 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">✨</span>
          <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">
            Insights for your business
          </h2>
        </div>
        <span className="text-xs text-gray-500 dark:text-gray-400">{visible.length} active</span>
      </div>

      <div className="space-y-2.5">
        {visible.slice(0, 5).map((p) => {
          const fb = localFeedback[p.id] || p.feedback;
          const sevColors =
            p.severity === "critical"
              ? "border-red-300/60 bg-white/80 dark:bg-gray-800/60"
              : p.severity === "warning"
              ? "border-amber-300/60 bg-white/80 dark:bg-gray-800/60"
              : "border-gray-200/80 dark:border-gray-700/60 bg-white/80 dark:bg-gray-800/60";
          return (
            <div
              key={p.id}
              className={`rounded-xl border p-3 ${sevColors}`}
            >
              <div className="flex items-start gap-2 mb-1">
                {p.severity === "critical" && <span className="text-red-500">⚠</span>}
                {p.severity === "warning" && <span className="text-amber-500">⚠</span>}
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex-1">{p.title}</h3>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-2">{p.detail}</p>
              {p.suggested_action && (
                <p className="text-xs text-indigo-700 dark:text-indigo-400 font-medium mb-2">
                  → {p.suggested_action}
                </p>
              )}

              <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50">
                <div className="flex gap-1.5">
                  <button
                    onClick={() => handleFeedback(p.id, "useful")}
                    disabled={!!fb}
                    aria-label="Useful insight"
                    className={`text-xs px-2 py-1 rounded-md transition ${
                      fb === "useful"
                        ? "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
                    }`}
                  >
                    👍 {fb === "useful" ? "Thanks" : "Useful"}
                  </button>
                  <button
                    onClick={() => handleFeedback(p.id, "not_useful")}
                    disabled={!!fb}
                    aria-label="Not useful"
                    className={`text-xs px-2 py-1 rounded-md transition ${
                      fb === "not_useful"
                        ? "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500"
                    }`}
                  >
                    👎 {fb === "not_useful" ? "Noted" : "Not useful"}
                  </button>
                </div>
                <div className="flex gap-1.5">
                  {p.suggested_action && (
                    <button
                      onClick={() => handleActed(p.id)}
                      className="text-xs px-2 py-1 rounded-md text-indigo-700 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 font-medium"
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
