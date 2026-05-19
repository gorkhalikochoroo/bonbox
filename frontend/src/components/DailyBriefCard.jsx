import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { Icon } from "./ui";
import { useLanguage } from "../hooks/useLanguage";

/**
 * Daily AI Brief — Copenhagen-style card at the top of the dashboard.
 *
 * Brief 2.0 (May 2026) adds:
 *   • Per-insight CTA chips — "Open Tax Autopilot", "Review matches",
 *     etc. — so each observation becomes a tap-to-action.
 *   • "Forward" affordance — owner can copy or email the brief to a
 *     co-founder / partner. This is the viral moment we engineered for.
 *
 * Renders ONLY pure text — no dangerouslySetInnerHTML, no markdown parsing,
 * no URLs from the response except the in-app cta_url (which the backend
 * controls; not user input). The backend already validates every number
 * the model produced against precomputed data, so the strings here are
 * already cross-checked.
 *
 * Loading: skeleton placeholder.
 * Error: silently hidden (fail-quiet — never tell the user "AI unavailable",
 *   the dashboard is still useful below).
 * Dismiss: × button stores bonbox_brief_dismissed_YYYY-MM-DD in localStorage;
 *   the card stays hidden for the rest of that day. Resets at next day's brief.
 */

function _todayKey() {
  // Use the user's local date, not UTC — same key the backend uses.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function _dismissKey() {
  return `bonbox_brief_dismissed_${_todayKey()}`;
}

/**
 * Restrict CTA URLs to in-app paths. The backend only emits paths like
 * "/tax", "/faktura", "/bank-import" — but defense in depth: reject
 * anything that doesn't start with a single slash (and isn't a double
 * slash, which would be protocol-relative).
 */
function _safeCtaPath(url) {
  if (typeof url !== "string") return null;
  if (!url.startsWith("/") || url.startsWith("//")) return null;
  if (url.includes("javascript:") || url.includes("data:")) return null;
  return url;
}

function _buildShareText(brief) {
  if (!brief) return "";
  const lines = [];
  if (brief.greeting) lines.push(brief.greeting);
  if (brief.date_label) lines.push(brief.date_label);
  if (lines.length) lines.push("");
  if (brief.headline) lines.push(brief.headline);
  for (const ins of brief.insights || []) {
    if (ins?.text) lines.push(`• ${ins.text}`);
  }
  lines.push("");
  lines.push("— BonBox");
  return lines.join("\n");
}

export default function DailyBriefCard() {
  const { t } = useLanguage();
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [shareToast, setShareToast] = useState("");
  // Task #54 — quiet "Get this by email" affordance at the bottom of
  // the card. If the user has the toggle ON, we show a passive line
  // ("Arrives in your inbox at 8 am"). If OFF, we show a one-tap
  // enable link. The pref is fetched once on mount; the optimistic
  // toggle below mutates locally + PATCHes.
  const [briefEmailEnabled, setBriefEmailEnabled] = useState(null);
  const [briefPrefBusy, setBriefPrefBusy] = useState(false);

  // Respect the user's choice to dismiss for the day before we even fetch
  // — saves an API round trip if they've already dismissed today.
  useEffect(() => {
    try {
      if (localStorage.getItem(_dismissKey()) === "1") {
        setHidden(true);
        setLoading(false);
        return;
      }
    } catch { /* localStorage blocked — fall through and show */ }

    let mounted = true;
    api
      .get("/dashboard/daily-brief")
      .then((res) => { if (mounted) setBrief(res.data); })
      .catch(() => { if (mounted) setHidden(true); })
      .finally(() => { if (mounted) setLoading(false); });
    // Task #54 — Daily Brief email pref. Soft-fetch — if it 401s or
    // 5xxs we just don't render the footer affordance.
    api
      .get("/email/preferences")
      .then((res) => {
        if (mounted && res?.data) {
          setBriefEmailEnabled(res.data.daily_brief_email_enabled ?? true);
        }
      })
      .catch(() => { /* silent — footer line just won't render */ });
    return () => { mounted = false; };
  }, []);

  // Task #54 — quietly opt the user IN to the morning email. Optimistic
  // update + rollback on error. We PATCH the full pref triple to avoid
  // server-side ambiguity (the backend treats the payload as the new
  // source of truth for all three flags).
  const enableBriefEmail = async () => {
    if (briefPrefBusy) return;
    setBriefPrefBusy(true);
    setBriefEmailEnabled(true);
    try {
      // Fetch current to avoid clobbering the other prefs.
      const current = await api.get("/email/preferences");
      await api.patch("/email/preferences", {
        ...current.data,
        daily_brief_email_enabled: true,
      });
    } catch {
      setBriefEmailEnabled(false); // rollback
    } finally {
      setBriefPrefBusy(false);
    }
  };

  const onDismiss = () => {
    try { localStorage.setItem(_dismissKey(), "1"); } catch { /* fine, it'll just show again next refresh */ }
    setHidden(true);
  };

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

  // Copy-to-clipboard for the forward-to-partner viral moment. Tries the
  // modern async clipboard API first, falls back to a textarea trick on
  // browsers that block it (older Safari, embedded webviews). Either way
  // shows the same toast so the user gets feedback.
  const onCopy = async () => {
    const text = _buildShareText(brief);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setShareToast("Copied!");
      setTimeout(() => setShareToast(""), 2000);
    } catch {
      setShareToast("Couldn't copy — long-press to select.");
      setTimeout(() => setShareToast(""), 3000);
    }
  };

  // Forward via email — opens the user's mail client with the brief
  // pre-filled. Subject is "Today at BonBox — Tuesday 19 May 2026"
  // style. Body is plain text (no HTML — survives every mail client).
  const onForward = () => {
    const text = _buildShareText(brief);
    const subject = `Today at BonBox — ${brief?.date_label || ""}`.trim();
    const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    window.location.href = url;
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
  // Defensive dedup — drop any insight whose text matches the headline.
  // Backend already dedups in _validate_llm_output, but cached briefs
  // generated before that fix shipped (or any future drift) won't have
  // run through it. Doing it here too means the UI stays clean
  // regardless of when the brief was generated.
  const _normForDedup = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const _headNorm = _normForDedup(brief.headline);
  const visibleInsights = (brief.insights || []).filter(
    (ins) => _normForDedup(ins?.text) !== _headNorm,
  );
  const isEmpty = visibleInsights.length === 0;
  const canRefresh = (brief.refreshes_left ?? 0) > 0;
  const headlineCta = _safeCtaPath(brief.headline_cta_url);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700/60 shadow-sm p-6 sm:p-7">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/15 flex items-center justify-center shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400">
            <Icon name="Sparkles" size={16} strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[17px] sm:text-[18px] font-semibold text-gray-900 dark:text-white tracking-tight truncate">
              {brief.greeting || "Today's brief"}
            </h2>
            <p className="text-[12.5px] text-gray-500 dark:text-gray-400 mt-0.5">{brief.date_label}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh brief"
              className="text-[12px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50 transition"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss brief for today"
            title="Dismiss for today"
            className="w-7 h-7 -mr-1 -mt-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700/60 dark:hover:text-gray-200 transition flex items-center justify-center"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <p className="text-[15.5px] sm:text-[16px] leading-snug text-gray-900 dark:text-gray-100 mb-2">
        {brief.headline}
      </p>
      {/* Headline-level CTA — Brief 2.0. Only renders for in-app paths. */}
      {headlineCta && (
        <Link
          to={headlineCta}
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 mb-3 transition"
        >
          {brief.headline_cta_label || "Open"}
          <span aria-hidden="true">→</span>
        </Link>
      )}

      {!isEmpty && (
        <ul className="space-y-3 mt-2">
          {visibleInsights.map((ins, i) => {
            const cta = _safeCtaPath(ins?.cta_url);
            return (
              <li key={i} className="flex items-start gap-2.5">
                <span
                  className="w-1.5 h-1.5 rounded-full mt-[8px] shrink-0"
                  style={{ backgroundColor: dotColor(ins.type) }}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] sm:text-[14.5px] leading-relaxed text-gray-700 dark:text-gray-300">
                    {ins.text}
                  </p>
                  {cta && (
                    <Link
                      to={cta}
                      className="inline-flex items-center gap-1 mt-1 text-[12px] font-medium text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 transition"
                    >
                      {ins.cta_label || "Open"}
                      <span aria-hidden="true">→</span>
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5 pt-3.5 border-t border-gray-100 dark:border-gray-700/60 flex items-center justify-between gap-3">
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-gray-400 dark:text-gray-500">
          {brief.ai_polished ? "AI Insight · BonBox" : "BonBox Insight"}
        </span>
        <div className="flex items-center gap-2">
          {shareToast && (
            <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
              {shareToast}
            </span>
          )}
          {/* Share affordances — the viral moment we engineered for.
              Copy goes to clipboard; Forward opens the mail client.
              Both build the same plain-text brief from the response. */}
          <button
            type="button"
            onClick={onCopy}
            aria-label="Copy brief to clipboard"
            title="Copy"
            className="w-7 h-7 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700/60 dark:hover:text-gray-200 transition flex items-center justify-center"
          >
            <Icon name="ClipboardList" size={14} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={onForward}
            aria-label="Forward brief by email"
            title="Forward"
            className="w-7 h-7 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700/60 dark:hover:text-gray-200 transition flex items-center justify-center"
          >
            <Icon name="Send" size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* Task #54 — quiet "Get this by email" line. Single visual row,
          no redesign. Renders only when we successfully fetched the
          pref; silent on auth/network errors so the card still works. */}
      {briefEmailEnabled !== null && (
        <div className="mt-2 text-[11.5px] text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
          <Icon name="Mail" size={12} strokeWidth={1.75} />
          {briefEmailEnabled ? (
            <span>{t("arrivesAt8amInbox")}</span>
          ) : (
            <button
              type="button"
              onClick={enableBriefEmail}
              disabled={briefPrefBusy}
              className="text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 transition disabled:opacity-50"
            >
              {t("getThisByEmail")} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function dotColor(type) {
  if (type === "win") return "#22c55e";    // green-500
  if (type === "watch") return "#f59e0b";  // amber-500
  if (type === "action") return "#3b82f6"; // blue-500
  return "#94a3b8";                        // slate-400 fallback
}
