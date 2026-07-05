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
//
// Dismiss: each row has a small X. Dismissals live in localStorage (the
// server stores nothing). Date-anchored findings (a specific close) stay
// dismissed for good — their dates travel to the backend as a `skip` param
// so the worst-only detectors surface the NEXT-worst close instead of the
// whole row silently masking every other broken close behind it. Ongoing
// conditions (stale bank feed, unconfirmed bookings) only snooze: a
// persisting problem resurfaces after 7 days, and a changed booking count
// re-keys immediately.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CalendarCheck, Landmark, FileClock, Scale, CalendarX, ChevronRight, X } from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { formatKr } from "../utils/currency";

const STORAGE_KEY = "bonbox_nyq_dismissed"; // { [key]: dismissedAtMs }
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORED = 120;
// Codes whose finding is anchored to a specific date → permanent dismissal,
// sent to the backend as skip tokens. Must mirror _SKIPPABLE in
// routers/diagnostics.py.
const DATED_CODES = new Set(["close_missing", "stale_draft_close", "close_unreconciled"]);

// Stable identity per finding: the date where there is one, else the most
// distinguishing meta (a changed reservation count re-surfaces the row).
const keyFor = (f) => `${f.code}|${f.meta?.date ?? f.meta?.provider ?? f.meta?.count ?? ""}`;

function loadDismissed() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const now = Date.now();
    const kept = Object.entries(raw)
      .filter(([k, ts]) => {
        if (typeof ts !== "number") return false;
        // dated = permanent; ongoing conditions expire (snooze) after 7 days
        return DATED_CODES.has(k.split("|")[0]) || now - ts < SNOOZE_MS;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_STORED);
    return Object.fromEntries(kept);
  } catch {
    return {};
  }
}

// Dated dismissals → "code:YYYY-MM-DD" CSV for the backend skip param.
const skipParamFor = (dismissed) =>
  Object.keys(dismissed)
    .filter((k) => {
      const [code, anchor] = k.split("|");
      return DATED_CODES.has(code) && anchor;
    })
    .slice(0, 60)
    .map((k) => k.replace("|", ":"))
    .join(",");

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
  // Your public booking page has no free slots for the next 14 days — a
  // customer who opens the link just bounces. Flagged by the public-surface
  // monitor (dead-on-arrival), surfaced here so you can fix opening hours /
  // tables. Never fires for a demo's missing name (that stays admin-only).
  public_booking_dead: {
    icon: CalendarX,
    title: (t) =>
      t("nyqBookingDead", "Your booking page has no free times for the next 14 days — customers can't book"),
    action: (t) => t("nyqBookingDeadAction", "Fix booking setup"),
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
  const [dismissed, setDismissed] = useState(loadDismissed);

  // Refetch when the dated skip-set changes: dismissing the worst
  // unreconciled close immediately surfaces the next-worst one.
  const skip = skipParamFor(dismissed);
  useEffect(() => {
    let alive = true;
    api
      .get("/diagnostics/needs-you", { params: skip ? { skip } : {} })
      .then((res) => {
        if (alive) setFindings(Array.isArray(res.data?.findings) ? res.data.findings : []);
      })
      .catch(() => {
        if (alive) setFindings([]); // quiet on error — never a scary empty box
      });
    return () => {
      alive = false;
    };
  }, [skip]);

  const dismiss = (f) => {
    const next = { ...dismissed, [keyFor(f)]: Date.now() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage full/blocked — dismissal still applies for this session */
    }
    setDismissed(next);
  };

  // Client-side filter covers the snoozed (non-dated) codes + fetch latency.
  const visible = findings.filter((f) => !(keyFor(f) in dismissed));

  if (!visible.length) return null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t("nyqTitle", "Needs you now")}
        </h3>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {visible.map((f) => {
          const r = RENDERERS[f.code];
          if (!r) return null; // unknown code → skip (forward-compatible)
          const RowIcon = r.icon || AlertTriangle;
          return (
            <li key={keyFor(f)} className="flex items-center">
              <button
                type="button"
                onClick={() => navigate(f.deep_link)}
                className="min-w-0 flex-1 flex items-center gap-3 pl-4 pr-2 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 active:scale-[0.997] transition"
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
              <button
                type="button"
                onClick={() => dismiss(f)}
                aria-label={t("nyqDismiss", "Dismiss")}
                title={t("nyqDismiss", "Dismiss")}
                className="shrink-0 p-2 mr-2 rounded-lg text-gray-300 hover:text-gray-500 hover:bg-gray-50 dark:text-gray-600 dark:hover:text-gray-400 dark:hover:bg-gray-800/50 transition"
              >
                <X className="w-4 h-4" strokeWidth={1.75} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
