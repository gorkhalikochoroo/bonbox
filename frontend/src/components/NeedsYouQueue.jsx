// NeedsYouQueue — the read-only "Skal ses nu" action queue.
//
// One calm place that says: here are the few things that need you right now,
// in order, each a one-tap deep-link to the exact spot. It renders findings
// from GET /api/diagnostics/needs-you (a read-only detector sweep — it observes
// and routes, never mutates or auto-resolves money). Localized HERE by `code`
// so DK terminology + i18n stay on the client.
//
// Quiet by design: nothing renders while loading, on error, or when there's
// nothing to do (no "all clear" clutter). Severity uses status colors only
// (amber/red), Lucide outline icons, no emoji.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CalendarCheck, Landmark, FileClock, Scale, ChevronRight } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { formatKr } from "../utils/currency";

// code → { icon, title(t, meta), action(t) }. Adding a detector server-side +
// a row here is all it takes to extend the queue.
const RENDERERS = {
  unconfirmed_reservations: {
    icon: CalendarCheck,
    title: (t, m) => t("nyqUnconfirmed", "{count} booking(s) waiting for your reply", { count: m.count }),
    action: (t) => t("nyqUnconfirmedAction", "Review"),
  },
  stale_bank_feed: {
    icon: Landmark,
    title: (t, m) =>
      m.days == null
        ? t("nyqStaleFeedNever", "Your bank feed hasn't synced yet")
        : t("nyqStaleFeed", "Bank feed not synced for {days} days", { days: m.days }),
    action: (t) => t("nyqStaleFeedAction", "Open connections"),
  },
  close_missing: {
    icon: CalendarCheck,
    title: (t, m) => t("nyqCloseMissing", "You didn't close {date}", { date: m.date }),
    action: (t) => t("nyqCloseMissingAction", "Close the day"),
  },
  // A draft kasserapport left unlocked past its day. When it doesn't tie out
  // we say so ("…der ikke stemmer") — that's the trust-critical signal: a
  // close that won't reconcile must be caught BEFORE it reaches the revisor.
  stale_draft_close: {
    icon: FileClock,
    title: (t, m) =>
      t("nyqStaleDraft", "Unlocked kladde from {date}{notTie} — review and lock", {
        date: m.date,
        notTie: m.ties_out === false ? t("nyqNotTie", ", that doesn't tie out") : "",
      }),
    action: (t) => t("nyqStaleDraftAction", "Review"),
  },
  // A confirmed (locked) close whose payments clearly don't match revenue.
  close_unreconciled: {
    icon: Scale,
    title: (t, m) =>
      t("nyqUnreconciled", "The {date} lukning doesn't tie out: payments {payment} ≠ omsætning {revenue}", {
        date: m.date,
        payment: formatKr(m.payment_total),
        revenue: formatKr(m.revenue_total),
      }),
    action: (t) => t("nyqUnreconciledAction", "Review"),
  },
};

// Status-color dot per severity (palette: amber/red only; info = quiet gray).
const SEVERITY_DOT = {
  urgent: "bg-red-500",
  warn: "bg-amber-500",
  info: "bg-gray-300 dark:bg-gray-600",
};

export default function NeedsYouQueue() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [findings, setFindings] = useState([]);

  useEffect(() => {
    let alive = true;
    api
      .get("/diagnostics/needs-you")
      .then((res) => {
        if (alive) setFindings(Array.isArray(res.data?.findings) ? res.data.findings : []);
      })
      .catch(() => {
        if (alive) setFindings([]); // quiet on error — never a scary empty box
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!findings.length) return null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t("nyqTitle", "Needs you now")}
        </h3>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {findings.map((f) => {
          const r = RENDERERS[f.code];
          if (!r) return null; // unknown code → skip (forward-compatible)
          const RowIcon = r.icon || AlertTriangle;
          return (
            <li key={f.code}>
              <button
                type="button"
                onClick={() => navigate(f.deep_link)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 active:scale-[0.997] transition"
              >
                <span className={`h-2 w-2 rounded-full shrink-0 ${SEVERITY_DOT[f.severity] || SEVERITY_DOT.info}`} aria-hidden />
                <RowIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" strokeWidth={1.75} aria-hidden />
                <span className="min-w-0 flex-1 text-sm text-gray-800 dark:text-gray-100 truncate">
                  {r.title(t, f.meta || {})}
                </span>
                <span className="shrink-0 text-[12.5px] font-medium text-gray-900 dark:text-gray-100 inline-flex items-center gap-0.5">
                  {r.action(t)}
                  <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
