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
import { AlertTriangle, ChevronRight, X } from "lucide-react";
import api from "../services/api";
import { peekGet } from "../lib/swrCache";
import { useLanguage } from "../hooks/useLanguage";
import { keyFor, loadDismissed, saveDismissal, skipParamFor, RENDERERS } from "./needsYouRenderers";

const SEVERITY_DOT = {
  urgent: "bg-red-500",
  warn: "bg-amber-500",
  info: "bg-gray-300 dark:bg-gray-500",
};

export default function NeedsYouQueue() {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(loadDismissed);

  // Refetch when the dated skip-set changes: dismissing the worst
  // unreconciled close immediately surfaces the next-worst one.
  const skip = skipParamFor(dismissed);
  // Back on Home: the last answer is drawn at once, then refreshed
  // underneath (lib/swrCache — owner, this account, memory only).
  const [findings, setFindings] = useState(() => {
    const kept = peekGet("/diagnostics/needs-you", skip ? { skip } : {});
    return Array.isArray(kept?.findings) ? kept.findings : [];
  });
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

  // saveDismissal also tells the rail's badges to re-read (DISMISS_EVENT).
  const dismiss = (f) => setDismissed(saveDismissal(dismissed, f));

  // Client-side filter covers the snoozed (non-dated) codes + fetch latency.
  const visible = findings.filter((f) => !(keyFor(f) in dismissed));

  if (!visible.length) return null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-[rgb(var(--surface-line))]">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {t("nyqTitle", "Needs you now")}
        </h3>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-[rgb(var(--surface-line))]">
        {visible.map((f) => {
          const r = RENDERERS[f.code];
          if (!r) return null; // unknown code → skip (forward-compatible)
          const RowIcon = r.icon || AlertTriangle;
          return (
            <li key={keyFor(f)} className="flex items-center">
              <button
                type="button"
                onClick={() => navigate(f.deep_link)}
                className="min-w-0 flex-1 flex items-center gap-3 pl-4 pr-2 py-3 text-left hover:bg-gray-50 dark:hover:bg-[rgb(var(--surface-raised))] active:scale-[0.997] transition"
              >
                <span className={`h-2 w-2 rounded-full shrink-0 ${SEVERITY_DOT[f.severity] || SEVERITY_DOT.info}`} aria-hidden />
                <RowIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" strokeWidth={1.75} aria-hidden />
                {/* Two lines on a phone: one line cut "Du lukkede ikke 26…"
                    right where the date that makes it actionable starts. */}
                <span className="min-w-0 flex-1 text-sm text-gray-800 dark:text-gray-100 line-clamp-2 sm:line-clamp-1">
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
                className="shrink-0 p-2 mr-2 rounded-lg text-gray-300 hover:text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-[rgb(var(--surface-raised))] transition"
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
