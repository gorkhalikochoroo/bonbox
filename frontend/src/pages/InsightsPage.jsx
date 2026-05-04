import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { trackEvent } from "../hooks/useEventLog";

/**
 * /insights — full AI insights inbox.
 *
 * The Dashboard surfaces only the top 5 active. This page is the full
 * archive: active, acted, dismissed, expired. Each pattern keeps its
 * 👍/👎 feedback so the user can review what they've taught the system.
 *
 * The "Refresh insights" button re-runs detection on demand. Cheap call —
 * the heavy lifting is statistical, not LLM.
 */
export default function InsightsPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("active"); // active | dismissed | acted | expired | all
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  // Optimistic local state so feedback / dismiss / acted feel snappy
  const [overrides, setOverrides] = useState({});

  useEffect(() => {
    loadAll();
  }, [filter]);

  async function loadAll() {
    setLoading(true);
    try {
      const params = filter === "all" ? {} : { state: filter };
      const res = await api.get("/patterns", { params });
      setItems(res.data || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function refreshNow() {
    setRefreshing(true);
    setRefreshMsg("");
    try {
      const res = await api.post("/patterns/refresh");
      const n = res.data?.new_patterns ?? 0;
      setRefreshMsg(
        n > 0
          ? `Found ${n} new insight${n === 1 ? "" : "s"}.`
          : "No new insights right now — patterns need at least 14 days of activity."
      );
      trackEvent("insights_refreshed", "insights", String(n));
      await loadAll();
    } catch {
      setRefreshMsg("Couldn't refresh — try again in a moment.");
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(""), 6000);
    }
  }

  async function feedback(id, val) {
    setOverrides((p) => ({ ...p, [id]: { ...(p[id] || {}), feedback: val } }));
    try {
      await api.post(`/patterns/${id}/feedback`, { feedback: val });
      trackEvent("insight_feedback", "insights", val);
    } catch {
      setOverrides((p) => {
        const next = { ...p };
        if (next[id]) delete next[id].feedback;
        return next;
      });
    }
  }

  async function dismiss(id) {
    setOverrides((p) => ({ ...p, [id]: { ...(p[id] || {}), state: "dismissed" } }));
    try {
      await api.post(`/patterns/${id}/dismiss`);
      trackEvent("insight_dismissed", "insights", id);
    } catch {
      setOverrides((p) => {
        const next = { ...p };
        if (next[id]) delete next[id].state;
        return next;
      });
    }
  }

  async function acted(id) {
    setOverrides((p) => ({ ...p, [id]: { ...(p[id] || {}), state: "acted" } }));
    try {
      await api.post(`/patterns/${id}/acted`);
      trackEvent("insight_acted", "insights", id);
    } catch {
      setOverrides((p) => {
        const next = { ...p };
        if (next[id]) delete next[id].state;
        return next;
      });
    }
  }

  // Apply overrides + (when filter is active) hide rows the user just dismissed/acted
  const visible = useMemo(() => {
    return items
      .map((it) => ({ ...it, ...(overrides[it.id] || {}) }))
      .filter((it) => {
        if (filter === "all") return true;
        return it.state === filter;
      });
  }, [items, overrides, filter]);

  // Counts for tab pills
  const counts = useMemo(() => {
    const c = { active: 0, acted: 0, dismissed: 0, expired: 0 };
    items.forEach((it) => {
      const merged = overrides[it.id] || {};
      const state = merged.state || it.state;
      if (state in c) c[state] += 1;
    });
    return c;
  }, [items, overrides]);

  // Stats for the summary card
  const stats = useMemo(() => {
    let useful = 0, notUseful = 0, acted = 0;
    items.forEach((it) => {
      const merged = overrides[it.id] || {};
      const fb = merged.feedback ?? it.feedback;
      const state = merged.state || it.state;
      if (fb === "useful") useful += 1;
      if (fb === "not_useful") notUseful += 1;
      if (state === "acted") acted += 1;
    });
    return { useful, notUseful, acted };
  }, [items, overrides]);

  const FILTERS = [
    { key: "active", label: "Active", icon: "✨" },
    { key: "acted", label: "Done", icon: "✅" },
    { key: "dismissed", label: "Dismissed", icon: "🙈" },
    { key: "expired", label: "Expired", icon: "🗓️" },
    { key: "all", label: "All", icon: "📋" },
  ];

  return (
    <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-4xl mx-auto pb-24">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <span>✨</span> Insights
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xl">
            Patterns BonBox AI detected about your business — anomalies, routines,
            dormant features. Your 👍/👎 feedback teaches the system which
            insights are worth surfacing again.
          </p>
        </div>
        <button
          onClick={refreshNow}
          disabled={refreshing}
          className="self-start sm:self-end px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-sm font-medium rounded-lg shadow-sm disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh insights"}
        </button>
      </div>

      {refreshMsg && (
        <div className="mb-4 text-sm bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 rounded-lg px-3 py-2">
          {refreshMsg}
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label="👍 Useful" value={stats.useful} accent="green" />
        <StatCard label="👎 Not useful" value={stats.notUseful} accent="red" />
        <StatCard label="✅ Acted on" value={stats.acted} accent="blue" />
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2 mb-5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition flex items-center gap-1.5
              ${filter === f.key
                ? "bg-indigo-600 text-white shadow-sm"
                : "bg-gray-100 dark:bg-gray-700/60 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"}`}
          >
            <span>{f.icon}</span>
            {f.label}
            {f.key !== "all" && counts[f.key] !== undefined && (
              <span className={`text-xs ${filter === f.key ? "text-indigo-200" : "text-gray-400"}`}>
                ({counts[f.key]})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-28 bg-gray-100 dark:bg-gray-800 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <div className="space-y-3">
          {visible.map((p) => (
            <InsightCard
              key={p.id}
              pattern={p}
              onFeedback={(v) => feedback(p.id, v)}
              onDismiss={() => dismiss(p.id)}
              onActed={() => acted(p.id)}
            />
          ))}
        </div>
      )}

      {/* Footer */}
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-8 leading-relaxed text-center">
        Insights are computed on our servers from your account data only. We never
        share insights about your business with anyone, and they're never used to
        train external AI models.
      </p>
    </div>
  );
}

/* ───── Sub-components ───── */

function StatCard({ label, value, accent }) {
  const cls =
    accent === "green" ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400" :
    accent === "red" ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400" :
    "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400";
  return (
    <div className={`${cls} rounded-xl p-3 text-center`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs uppercase tracking-wide mt-0.5 opacity-80">{label}</div>
    </div>
  );
}

function InsightCard({ pattern, onFeedback, onDismiss, onActed }) {
  const sevColors =
    pattern.severity === "critical"
      ? "border-red-300/70 dark:border-red-700/50"
      : pattern.severity === "warning"
      ? "border-amber-300/70 dark:border-amber-700/50"
      : "border-gray-200 dark:border-gray-700";

  const stateColors = {
    active: "bg-white dark:bg-gray-800",
    acted: "bg-green-50/40 dark:bg-green-900/10",
    dismissed: "bg-gray-50/60 dark:bg-gray-800/40 opacity-70",
    expired: "bg-gray-50/40 dark:bg-gray-800/30 opacity-60",
  };

  const stateLabel = {
    acted: "Done",
    dismissed: "Dismissed",
    expired: "Expired",
  }[pattern.state];

  return (
    <div className={`${stateColors[pattern.state] || stateColors.active} ${sevColors} border rounded-xl p-4`}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          {pattern.severity === "critical" && <span className="text-red-500">⚠</span>}
          {pattern.severity === "warning" && <span className="text-amber-500">⚠</span>}
          {pattern.title}
        </h3>
        {stateLabel && (
          <span className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
            {stateLabel}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mt-1">{pattern.detail}</p>
      {pattern.suggested_action && (
        <p className="text-xs text-indigo-700 dark:text-indigo-400 font-medium mt-2">
          → {pattern.suggested_action}
        </p>
      )}
      <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-2">
        Detected {timeAgo(pattern.detected_at)}{" "}
        {pattern.valid_until && pattern.state === "active" && (
          <>· valid until {new Date(pattern.valid_until).toLocaleDateString()}</>
        )}
      </p>

      {pattern.state === "active" && (
        <div className="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-gray-100 dark:border-gray-700/60">
          <div className="flex gap-1.5">
            <FeedbackButton
              active={pattern.feedback === "useful"}
              onClick={() => onFeedback("useful")}
              icon="👍"
              label="Useful"
              activeBg="bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300"
            />
            <FeedbackButton
              active={pattern.feedback === "not_useful"}
              onClick={() => onFeedback("not_useful")}
              icon="👎"
              label="Not useful"
              activeBg="bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300"
            />
          </div>
          <div className="flex gap-1.5">
            {pattern.suggested_action && (
              <button
                onClick={onActed}
                className="text-xs px-2.5 py-1 rounded-md text-indigo-700 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 font-medium"
              >
                Done it
              </button>
            )}
            <button
              onClick={onDismiss}
              className="text-xs px-2.5 py-1 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {pattern.feedback && pattern.state !== "active" && (
        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-2">
          You marked this {pattern.feedback === "useful" ? "👍 Useful" : "👎 Not useful"}
        </p>
      )}
    </div>
  );
}

function FeedbackButton({ active, onClick, icon, label, activeBg }) {
  return (
    <button
      onClick={onClick}
      disabled={active}
      className={`text-xs px-2.5 py-1 rounded-md transition font-medium ${
        active ? activeBg : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
      }`}
    >
      {icon} {label}
    </button>
  );
}

function EmptyState({ filter }) {
  if (filter === "active") {
    return (
      <div className="text-center py-12 px-4 bg-gradient-to-br from-purple-50 to-indigo-50 dark:from-purple-900/10 dark:to-indigo-900/10 rounded-2xl border border-purple-200/40 dark:border-purple-800/30">
        <div className="text-4xl mb-2">✨</div>
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">No active insights right now</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-md mx-auto">
          BonBox AI needs at least 14 days of business activity (sales, expenses, daily closes)
          before it can detect meaningful patterns. Keep using BonBox — insights will start appearing here.
        </p>
      </div>
    );
  }
  return (
    <div className="text-center py-12 text-gray-400 dark:text-gray-500">
      No insights in this view.
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return "—";
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
