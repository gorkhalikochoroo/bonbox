/**
 * ComplianceCountdownCard — the MOMS foresight hero (S1-8 / #355).
 *
 * Upgraded from the single-line deadline countdown into the home surface for
 * the forward foresight engine (#348–#354). It answers the one question an
 * owner cares about — "will I cover the MOMS bill?" — in a single glanceable,
 * one-tap card.
 *
 * Two render paths (graceful degradation):
 *   1. FORESIGHT HERO — when `/cashflow/forecast → foresight` is available:
 *      verdict headline + the next afregningsfrist + ONE action (set aside
 *      X/week, or "connect your bank" when there's no balance yet).
 *   2. FALLBACK COUNTDOWN — the original single-line "next deadline" surface,
 *      used when the foresight payload isn't available (older backend, no MOMS
 *      config, or a non-MOMS deadline carried via ctx).
 *
 * Doctrine:
 *   • Simple + easy-tap — the WHOLE card is one tap target; no nested controls.
 *   • Status-colors-only — verdict tone tints the icon + a status dot, never
 *     the surface (stays bg-white / dark:bg-gray-900, 1px gray-200 border).
 *   • Fail-closed honesty — INSUFFICIENT_DATA (no bank balance) NEVER reads as
 *     "covered"; it shows the expected bill + a connect-bank prompt instead.
 *   • DK terminology lock — MOMS / afregningsfrist stay Danish across languages.
 */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Calendar,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Landmark,
  ArrowRight,
} from "lucide-react";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";
import { formatMoney } from "../../utils/currency";

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

function severityFor(daysAway) {
  if (daysAway == null || Number.isNaN(Number(daysAway))) {
    return { iconClass: "text-gray-500 dark:text-gray-400", textClass: "text-gray-700 dark:text-gray-300" };
  }
  if (daysAway < 0) {
    return { iconClass: "text-red-600 dark:text-red-400", textClass: "text-red-700 dark:text-red-400" };
  }
  if (daysAway < 7) {
    return { iconClass: "text-amber-600 dark:text-amber-400", textClass: "text-amber-700 dark:text-amber-400" };
  }
  return { iconClass: "text-gray-500 dark:text-gray-400", textClass: "text-gray-700 dark:text-gray-300" };
}

// "in {n} days" / overdue / today / tomorrow — reuses the existing MOMS keys.
function daysPhrase(t, days) {
  if (days == null || Number.isNaN(Number(days))) return "";
  const n = Number(days);
  if (n < 0) return t("momsOverdueBy", "Overdue by {n} days").replace("{n}", String(Math.abs(n)));
  if (n === 0) return t("momsDueToday", "Due today");
  if (n === 1) return t("momsDueTomorrow", "Due tomorrow");
  return t("dashComplianceInDays", "in {n} days").replace("{n}", String(n));
}

// Verdict → icon + tone + headline. INSUFFICIENT_DATA is the connect-bank state.
const TONE = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  neutral: "text-gray-500 dark:text-gray-400",
};

function verdictConfig(t, verdict) {
  switch (verdict) {
    case "ON_TRACK":
      return { Icon: CheckCircle2, tone: "ok", headline: t("fsVerdictOnTrack", "You're covered for MOMS") };
    case "TIGHT":
      return { Icon: AlertTriangle, tone: "warn", headline: t("fsVerdictTight", "Covered — but it'll be tight") };
    case "AT_RISK":
      return { Icon: AlertTriangle, tone: "warn", headline: t("fsVerdictAtRisk", "Set a little aside to be safe") };
    case "SHORT":
      return { Icon: AlertCircle, tone: "bad", headline: t("fsVerdictShort", "You're heading short on MOMS") };
    default:
      return { Icon: Landmark, tone: "neutral", headline: t("fsVerdictConnect", "Connect your bank to see if you're covered") };
  }
}

export default function ComplianceCountdownCard({
  ctx = {},
  className = "",
  deadline: deadlineProp = null,
  // Tests/Storybook can inject a foresight payload to bypass the fetch.
  foresight: foresightProp = null,
}) {
  const { t } = useLanguage();
  const [fallback, setFallback] = useState(null);
  const [loading, setLoading] = useState(false);
  const [foresight, setForesight] = useState(null);

  const ctxDeadline = ctx?.compliance?.nextDeadline || null;
  const ctxForesight = ctx?.foresight || null;
  // Bumped by the dashboard on every data refresh (e.g. after a Quick Sale) so
  // the foresight re-fetches and the verdict/MOMS stay in sync with the KPIs,
  // instead of going stale until a full page reload.
  const refreshNonce = ctx?.refreshNonce;

  // ── Fetch the foresight payload (the hero's data source) ──────────────
  useEffect(() => {
    if (foresightProp || ctxForesight) return;
    let alive = true;
    api
      .get("/cashflow/forecast")
      .then((r) => {
        if (alive) setForesight(r?.data?.foresight || null);
      })
      .catch(() => {
        if (alive) setForesight(null);
      });
    return () => {
      alive = false;
    };
  }, [foresightProp, ctxForesight, refreshNonce]);

  // ── Fallback deadline (only fetched when the hero won't render) ────────
  const fs = foresightProp || ctxForesight || foresight;
  const heroAvailable = !!(fs && fs.available && fs.verdict);

  useEffect(() => {
    if (deadlineProp || ctxDeadline || heroAvailable) return;
    // Don't fetch the fallback until we know the hero isn't coming.
    if (fs === null && !foresightProp && !ctxForesight) return;
    let alive = true;
    setLoading(true);
    api
      .get("/tax/overview")
      .then((r) => {
        if (!alive) return;
        const next = (r?.data?.upcoming_deadlines || [])[0] || null;
        if (!next || !next.deadline) {
          setFallback(null);
          return;
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const due = new Date(next.deadline + "T00:00:00");
        const daysAway =
          next.days_until != null
            ? Number(next.days_until)
            : Math.ceil((due - today) / (1000 * 60 * 60 * 24));
        setFallback({
          type: "moms",
          date: next.deadline,
          daysAway,
          label: typeToLabel(t, "moms"),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadlineProp, ctxDeadline, heroAvailable, fs]);

  // ─────────────────────────────────────────────────────────────────────
  // PATH 1 — FORESIGHT HERO
  // ─────────────────────────────────────────────────────────────────────
  if (heroAvailable) {
    const { Icon, tone, headline } = verdictConfig(t, fs.verdict);
    const dl = fs.deadline || {};
    const moms = fs.moms || {};
    const action = fs.action || null;
    const isConnect = fs.verdict === "INSUFFICIENT_DATA";

    const expected = moms.expected != null ? formatMoney(moms.expected, "DKK", { decimals: 0 }) : null;

    let detail;
    if (isConnect) {
      detail = t("fsConnectDetail", "Expected MOMS ~{amt} · due {date}")
        .replace("{amt}", expected || "—")
        .replace("{date}", fmtDate(dl.date));
    } else if (fs.verdict === "SHORT" && action && !action.already_covered) {
      detail = t("fsActionWeekly", "Set aside {amt}/week")
        .replace("{amt}", formatMoney(action.weekly_rate, "DKK", { decimals: 0 }));
    } else if (fs.verdict === "AT_RISK" && action && !action.already_covered) {
      detail = t("fsActionWeeklySafe", "Set aside {amt}/week to be safe")
        .replace("{amt}", formatMoney(action.weekly_rate, "DKK", { decimals: 0 }));
    } else if (fs.verdict === "TIGHT" && fs.balance && fs.balance.lowest) {
      detail = t("fsTightDetail", "Dips to {low} before the deadline")
        .replace("{low}", formatMoney(fs.balance.lowest.balance, "DKK", { decimals: 0 }));
    } else {
      detail = t("fsCoveredDetail", "Expected MOMS ~{amt} — on track")
        .replace("{amt}", expected || "—");
    }

    const eyebrow = `MOMS${dl.period_label ? " · " + dl.period_label : ""} · ${daysPhrase(t, dl.days_until)}`;
    const to = isConnect ? "/connections" : "/tax";

    return (
      <Link
        to={to}
        className={
          "block rounded-xl border border-gray-200 dark:border-gray-800 " +
          "bg-white dark:bg-gray-900 p-5 sm:p-6 " +
          "hover:shadow-sm transition-shadow group " +
          "focus-visible:outline-none focus-visible:ring-2 " +
          "focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
          "focus-visible:ring-offset-1 " +
          (className || "")
        }
        data-component="ComplianceCountdownCard"
        data-foresight-verdict={fs.verdict}
        aria-label={t("fsHeroAria", "Open MOMS foresight — {headline}").replace("{headline}", headline)}
      >
        <div className="flex items-start gap-3">
          <div
            className={
              "shrink-0 inline-flex items-center justify-center " +
              "w-9 h-9 rounded-full bg-gray-50 dark:bg-gray-800 " +
              "border border-gray-200 dark:border-gray-800"
            }
            aria-hidden="true"
          >
            <Icon size={18} strokeWidth={2} className={TONE[tone]} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
              {eyebrow}
            </p>
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100 leading-snug">
              {headline}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5 leading-snug">
              {detail}
            </p>
          </div>
          <ArrowRight
            size={18}
            strokeWidth={2}
            className="shrink-0 mt-1 text-gray-300 dark:text-gray-600 group-hover:text-gray-400 transition-colors"
            aria-hidden="true"
          />
        </div>
      </Link>
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // PATH 2 — FALLBACK COUNTDOWN (the original single-line surface)
  // ─────────────────────────────────────────────────────────────────────
  const deadline = deadlineProp || ctxDeadline || fallback;

  if (loading && !deadline) {
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
    return null;
  }

  const days = Number(deadline.daysAway);
  const severity = severityFor(days);
  const label = deadline.label || typeToLabel(t, deadline.type);
  const daysText = daysPhrase(t, days);

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
      aria-label={t("dashComplianceCardAria", "Open compliance details — {label} {days}")
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
          <Calendar size={18} strokeWidth={2} className={severity.iconClass} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-0.5">
            {t("dashComplianceNextLabel", "Next deadline")}
          </p>
          <p className="text-sm text-gray-900 dark:text-gray-100 leading-snug">
            <span className="font-semibold">{label}</span>{" "}
            <span className={severity.textClass + " font-medium"}>{daysText}</span>
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
