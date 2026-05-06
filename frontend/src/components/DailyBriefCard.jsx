import { useEffect, useState } from "react";
import api from "../services/api";

/**
 * Daily AI Brief — Copenhagen-style card at the top of the dashboard.
 *
 * Renders ONLY pure text — no dangerouslySetInnerHTML, no markdown parsing,
 * no URLs from the response. The backend already validates every number
 * the model produced against precomputed data, so the strings here are
 * already cross-checked.
 *
 * Loading: skeleton placeholder.
 * Error: silently hidden (fail-quiet — never tell the user "AI unavailable",
 *   the dashboard is still useful below).
 */
export default function DailyBriefCard() {
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let mounted = true;
    api
      .get("/dashboard/daily-brief")
      .then((res) => { if (mounted) setBrief(res.data); })
      .catch(() => { if (mounted) setHidden(true); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await api.get("/dashboard/daily-brief", { params: { refresh: true } });
      setBrief(res.data);
    } catch {
      // Fail quiet — keep showing the previous brief
    } finally {
      setRefreshing(false);
    }
  };

  if (hidden) return null;

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700/60 p-6 sm:p-7 animate-pulse">
        <div className="h-3 w-40 bg-gray-100 dark:bg-gray-700 rounded mb-4" />
        <div className="h-5 w-3/4 bg-gray-100 dark:bg-gray-700 rounded mb-3" />
        <div className="h-3 w-2/3 bg-gray-100 dark:bg-gray-700 rounded mb-2" />
        <div className="h-3 w-1/2 bg-gray-100 dark:bg-gray-700 rounded" />
      </div>
    );
  }

  if (!brief) return null;

  // Empty-state path: no candidates yet (brand-new user). The backend
  // already returns a friendly headline; just don't render the divider/footer
  const isEmpty = (!brief.insights || brief.insights.length === 0);
  const canRefresh = (brief.refreshes_left ?? 0) > 0;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700/60 shadow-sm p-6 sm:p-7">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-[#22c55e]/10 dark:bg-[#22c55e]/15 flex items-center justify-center shrink-0 mt-0.5">
            {/* Sun glyph — calm, no emoji */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1 1M17.4 17.4l1 1M5.6 18.4l1-1M17.4 6.6l1-1" />
            </svg>
          </div>
          <div className="min-w-0">
            <h2 className="text-[17px] sm:text-[18px] font-semibold text-gray-900 dark:text-white tracking-tight truncate">
              {brief.greeting || "Today's brief"}
            </h2>
            <p className="text-[12.5px] text-gray-500 dark:text-gray-400 mt-0.5">{brief.date_label}</p>
          </div>
        </div>
        {canRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh brief"
            className="text-[12px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50 transition shrink-0"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>

      <p className="text-[15.5px] sm:text-[16px] leading-snug text-gray-900 dark:text-gray-100 mb-4">
        {brief.headline}
      </p>

      {!isEmpty && (
        <ul className="space-y-2.5">
          {brief.insights.map((ins, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span
                className="w-1.5 h-1.5 rounded-full mt-[8px] shrink-0"
                style={{ backgroundColor: dotColor(ins.type) }}
                aria-hidden="true"
              />
              <p className="text-[14px] sm:text-[14.5px] leading-relaxed text-gray-700 dark:text-gray-300">
                {ins.text}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 pt-3.5 border-t border-gray-100 dark:border-gray-700/60 flex items-center justify-between">
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">
          {brief.ai_polished ? "AI Insight · BonBox" : "BonBox Insight"}
        </span>
        {brief.from_cache && (
          <span className="text-[10.5px] text-gray-400 dark:text-gray-500">
            Updated today
          </span>
        )}
      </div>
    </div>
  );
}

function dotColor(type) {
  if (type === "win") return "#22c55e";    // green-500
  if (type === "watch") return "#f59e0b";  // amber-500
  if (type === "action") return "#3b82f6"; // blue-500
  return "#94a3b8";                        // slate-400 fallback
}
