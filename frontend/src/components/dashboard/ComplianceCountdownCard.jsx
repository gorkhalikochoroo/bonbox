/**
 * ComplianceCountdownCard — generalized from the MOMS-only countdown.
 *
 * The original `MomsCountdownCard` was MOMS-specific. This component
 * accepts ANY deadline type so the same single-line surface can show
 * MOMS / kvartalsregnskab / SKAT lønseddel / årsregnskab as they
 * approach — whichever is next.
 *
 * Doctrine compliance:
 *   • Single-line surface — calendar icon + deadline label + days.
 *   • Severity tinting drives only the icon + days color, not the
 *     surface (per the SectionBanner / StatCard recipe). Surface stays
 *     bg-white / dark:bg-gray-900 with a 1px gray-200 border.
 *   • DK terminology lock: `MOMS`, `kvartalsregnskab`, `lønseddel`,
 *     `årsregnskab` stay Danish across all UI languages.
 *
 * Data:
 *   • Reads `ctx.compliance.nextDeadline = { type, date, daysAway, label }`
 *     when available. Falls back to MOMS-only logic via the existing
 *     `/api/tax/overview` endpoint when `ctx.compliance` isn't populated
 *     — this preserves the current MOMS behavior while the backend gets
 *     extended to surface kvartal / løn / årsregnskab deadlines too.
 *
 * TODO(backend): extend `/api/tax/overview` (or a new
 *   `/api/compliance/next` endpoint) to populate kvartalsregnskab,
 *   lønseddel, and årsregnskab deadline types so the frontend doesn't
 *   need the MOMS fallback path. The component is already deadline-type-
 *   agnostic — it just reads `nextDeadline.type` and tints accordingly.
 */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Calendar } from "lucide-react";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

// Map deadline.type → user-facing localized label. Values that stay
// Danish per DK terminology lock are passed through as-is from the
// translation entry (which keeps "MOMS", "kvartalsregnskab" etc. in
// Danish on both EN and DA blocks).
function typeToLabel(t, type) {
  switch (type) {
    case "moms":
    case "vat":
      return t("dashComplianceMomsLabel", "MOMS filing");
    case "kvartal":
    case "kvartalsregnskab":
      return t("dashComplianceKvartalLabel", "kvartalsregnskab");
    case "loen":
    case "loen_seddel":
    case "lønseddel":
      return t("dashComplianceLoenLabel", "lønseddel");
    case "aarsregnskab":
    case "årsregnskab":
      return t("dashComplianceAarLabel", "årsregnskab");
    default:
      return t("dashComplianceGenericLabel", "Filing deadline");
  }
}

// Severity selects icon + days color only — surface stays neutral.
function severityFor(daysAway) {
  if (daysAway == null || Number.isNaN(Number(daysAway))) {
    return { tone: "neutral", iconClass: "text-gray-500 dark:text-gray-400", textClass: "text-gray-700 dark:text-gray-300" };
  }
  if (daysAway < 0) {
    return { tone: "critical", iconClass: "text-red-600 dark:text-red-400", textClass: "text-red-700 dark:text-red-400" };
  }
  if (daysAway < 7) {
    return { tone: "warn", iconClass: "text-amber-600 dark:text-amber-400", textClass: "text-amber-700 dark:text-amber-400" };
  }
  return { tone: "neutral", iconClass: "text-gray-500 dark:text-gray-400", textClass: "text-gray-700 dark:text-gray-300" };
}

export default function ComplianceCountdownCard({
  ctx = {},
  className = "",
  // Tests / Storybook can pass a deadline directly to bypass the
  // ctx + API fallback chain.
  deadline: deadlineProp = null,
}) {
  const { t } = useLanguage();
  const [fallback, setFallback] = useState(null);
  const [loading, setLoading] = useState(false);

  // Prefer the deadline from ctx (the orchestrator's job to assemble).
  const ctxDeadline = ctx?.compliance?.nextDeadline || null;

  // Fallback: when ctx hasn't populated the deadline (legacy DashboardPage
  // or first wiring pass), pull from /tax/overview the way the original
  // MomsCountdownCard did. Silent on error — the card hides itself.
  useEffect(() => {
    if (deadlineProp || ctxDeadline) return;
    let alive = true;
    setLoading(true);
    api
      .get("/tax/overview")
      .then((r) => {
        if (!alive) return;
        const upcoming = r?.data?.upcoming_deadlines || [];
        const next =
          upcoming.find((d) => d?.type === "vat" || d?.type === "moms") ||
          upcoming[0] ||
          null;
        if (!next || !next.date) {
          setFallback(null);
          return;
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const due = new Date(next.date + "T00:00:00");
        const daysAway = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
        setFallback({
          type: next.type || "moms",
          date: next.date,
          daysAway,
          label: typeToLabel(t, next.type || "moms"),
          periodLabel: next.period_label || null,
        });
      })
      .catch(() => {
        if (alive) setFallback(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // We intentionally re-fetch only when the source-of-truth deadline
    // toggles between "missing" and "present" — the t-fn is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadlineProp, ctxDeadline]);

  const deadline = deadlineProp || ctxDeadline || fallback;

  if (loading && !deadline) {
    // Low-noise skeleton — never block the rest of the dashboard.
    return (
      <div
        className={
          "rounded-xl border border-gray-200 dark:border-gray-800 " +
          "bg-white dark:bg-gray-900 p-5 animate-pulse " +
          (className || "")
        }
        aria-hidden="true"
      >
        <div className="h-4 bg-gray-100 dark:bg-gray-800 rounded w-2/3" />
      </div>
    );
  }

  if (!deadline || !deadline.date) {
    // No deadline data — silently hide rather than show a broken-looking
    // empty card. Matches the original MomsCountdownCard behavior.
    return null;
  }

  const days = Number(deadline.daysAway);
  const severity = severityFor(days);
  const label =
    deadline.label || typeToLabel(t, deadline.type);

  // Single line phrasing: "{label} in {n} days" (overdue and due-today
  // variants reuse the existing MOMS countdown keys so we don't add a
  // new bag of strings for the generalized case).
  let daysText;
  if (days < 0) {
    daysText = t("momsOverdueBy", "Overdue by {n} days").replace(
      "{n}",
      String(Math.abs(days)),
    );
  } else if (days === 0) {
    daysText = t("momsDueToday", "Due today");
  } else if (days === 1) {
    daysText = t("momsDueTomorrow", "Due tomorrow");
  } else {
    daysText = t("dashComplianceInDays", "in {n} days").replace(
      "{n}",
      String(days),
    );
  }

  return (
    <Link
      to="/tax"
      className={
        "block rounded-xl border border-gray-200 dark:border-gray-800 " +
        "bg-white dark:bg-gray-900 p-5 sm:p-6 " +
        "hover:shadow-sm transition-shadow " +
        "focus-visible:outline-none focus-visible:ring-2 " +
        "focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
        "focus-visible:ring-offset-1 " +
        (className || "")
      }
      data-component="ComplianceCountdownCard"
      data-deadline-type={deadline.type || "unknown"}
      aria-label={t(
        "dashComplianceCardAria",
        "Open compliance details — {label} {days}",
      )
        .replace("{label}", label)
        .replace("{days}", daysText)}
    >
      <div className="flex items-center gap-3">
        <div
          className={
            "shrink-0 inline-flex items-center justify-center " +
            "w-9 h-9 rounded-full bg-gray-50 dark:bg-gray-800 " +
            "border border-gray-200 dark:border-gray-800"
          }
          aria-hidden="true"
        >
          <Calendar
            size={18}
            strokeWidth={2}
            className={severity.iconClass}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className={
              "text-[11px] font-semibold uppercase tracking-wider " +
              "text-gray-400 dark:text-gray-500 mb-0.5"
            }
          >
            {t("dashComplianceNextLabel", "Next deadline")}
          </p>
          <p className="text-sm text-gray-900 dark:text-gray-100 leading-snug">
            <span className="font-semibold">{label}</span>{" "}
            <span className={severity.textClass + " font-medium"}>
              {daysText}
            </span>
            <span className="text-gray-500 dark:text-gray-400 ml-1.5 text-xs">
              · {fmtDate(deadline.date)}
              {deadline.periodLabel ? ` · ${deadline.periodLabel}` : ""}
            </span>
          </p>
        </div>
      </div>
    </Link>
  );
}
