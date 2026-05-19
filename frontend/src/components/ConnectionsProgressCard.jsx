/**
 * ConnectionsProgressCard — surfaces incomplete setup directly on the
 * Dashboard so owners don't have to hunt for /connections.
 *
 * Renders a single Card with:
 *   • A progress meter — "3 of 5 connections complete"
 *   • A 1-line list of what's still missing
 *   • A "Finish setup →" CTA → /connections
 *
 * Self-hides when every tracked connection is done. Self-hides when the
 * user has dismissed it for 30 days (per-account flag, not localStorage —
 * so dismissing on phone also dismisses on laptop).
 *
 * Pulls from the SAME endpoints ConnectionsPage uses; defensive (silent
 * no-op on any fetch failure so the rest of the dashboard never blocks).
 */
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";

const _DISMISS_KEY = "bonbox_connections_nudge_dismissed_until";

function _isDismissed() {
  try {
    const until = parseInt(localStorage.getItem(_DISMISS_KEY) || "0", 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

function _dismissFor(days = 30) {
  try {
    localStorage.setItem(_DISMISS_KEY, String(Date.now() + days * 86400_000));
  } catch {
    // localStorage blocked — fall through; it'll re-show on next render
  }
}

export default function ConnectionsProgressCard() {
  const { t } = useLanguage();
  const [profile, setProfile] = useState(null);
  const [grants, setGrants] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [hidden, setHidden] = useState(() => _isDismissed());

  useEffect(() => {
    if (hidden) return;
    let alive = true;
    Promise.all([
      api.get("/business").then(r => r.data).catch(() => null),
      api.get("/accountants/grants").then(r => r.data || []).catch(() => []),
      api.get("/email-settings/preferences").then(r => r.data).catch(() => null),
    ]).then(([p, g, e]) => {
      if (!alive) return;
      setProfile(p);
      setGrants(g);
      setPrefs(e);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [hidden]);

  // 5 tracked connections — same set as ConnectionsPage's "actionable"
  // cards (we exclude things owners can't directly affect, like sales
  // channels or the export bridge which is always "ready").
  const items = useMemo(() => {
    if (!loaded) return null;
    const bank = !!(profile?.bank_account_number || profile?.iban);
    const mobilepay = !!profile?.mobilepay_number;
    const accountantEmail = !!profile?.accountant_email;
    const revisor = (grants || []).some(g => g.status === "active");
    const brief = !!prefs?.daily_brief_email_enabled;
    return [
      { id: "bank",        done: bank,            label: t("connsProgBank",       "Bank account") },
      { id: "mobilepay",   done: mobilepay,       label: t("connsProgMobilePay",  "MobilePay number") },
      { id: "accountant",  done: accountantEmail, label: t("connsProgAccountant", "Accountant email") },
      { id: "revisor",     done: revisor,         label: t("connsProgRevisor",    "Revisor invited") },
      { id: "briefEmail",  done: brief,           label: t("connsProgBrief",      "Brief email on") },
    ];
  }, [loaded, profile, grants, prefs, t]);

  if (hidden || !loaded || !items) return null;

  const doneCount = items.filter(i => i.done).length;
  const total = items.length;
  // Auto-hide when everything is set up — the nudge has earned itself
  // off the dashboard. (Owner can still visit /connections directly.)
  if (doneCount >= total) return null;

  const missing = items.filter(i => !i.done);
  const pct = Math.round((doneCount / total) * 100);

  const onDismiss = () => {
    _dismissFor(30);
    setHidden(true);
  };

  return (
    <div className="bg-white dark:bg-stone-800 rounded-2xl border border-stone-200 dark:border-stone-700 shadow-sm p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/15 flex items-center justify-center shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400">
            <Icon name="Link2" size={16} strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15.5px] font-semibold text-stone-900 dark:text-stone-100 tracking-tight">
              {t("connsProgTitle", "Finish your setup")}
            </h2>
            <p className="text-[12.5px] text-stone-500 dark:text-stone-400 mt-0.5">
              {t("connsProgSubtitle", "Each one is under 60 seconds.")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("connsProgDismiss", "Dismiss for 30 days")}
          title={t("connsProgDismiss", "Dismiss for 30 days")}
          className="w-7 h-7 -mr-1 -mt-1 rounded-md text-stone-400 hover:text-stone-700 hover:bg-stone-100 dark:hover:bg-stone-700/60 dark:hover:text-stone-200 transition flex items-center justify-center"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Progress meter */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-sm font-semibold text-stone-900 dark:text-stone-100 shrink-0">
          {doneCount}/{total}
        </span>
        <div className="flex-1 h-2 bg-stone-100 dark:bg-stone-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-[11.5px] text-stone-500 dark:text-stone-400 shrink-0">
          {pct}%
        </span>
      </div>

      {/* Missing items — short row, capped at 4 visible */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {missing.slice(0, 4).map(item => (
          <span
            key={item.id}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] bg-stone-100 dark:bg-stone-700/60 text-stone-600 dark:text-stone-300"
          >
            <span className="w-1 h-1 rounded-full bg-stone-400 dark:bg-stone-500" aria-hidden="true" />
            {item.label}
          </span>
        ))}
        {missing.length > 4 && (
          <span className="text-[11.5px] text-stone-500 dark:text-stone-400 px-1">
            {t("connsProgMore", "+{n} more").replace("{n}", String(missing.length - 4))}
          </span>
        )}
      </div>

      <Link
        to="/connections"
        className="inline-flex items-center gap-1 text-[13px] font-medium text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 transition"
      >
        {t("connsProgCta", "Finish setup")} <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
