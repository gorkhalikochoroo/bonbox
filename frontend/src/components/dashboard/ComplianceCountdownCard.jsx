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
import { dateLocale } from "../../utils/dateFormat";
import { Link } from "react-router-dom";
import {
  Calendar,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Wallet,
  ArrowRight,
} from "lucide-react";
import api from "../../services/api";
import { useLanguage } from "../../hooks/useLanguage";
import { formatKr } from "../../utils/currency";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString(dateLocale(), {
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
      return { Icon: Wallet, tone: "neutral", headline: t("fsVerdictEnterBalance", "Add your bank balance to see if you're covered") };
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
  const [balanceOpen, setBalanceOpen] = useState(false);
  // Local bump: after the owner saves their balance, re-pull foresight so the
  // card flips to the real verdict without a page reload.
  const [localBump, setLocalBump] = useState(0);

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
  }, [foresightProp, ctxForesight, refreshNonce, localBump]);

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
    const noBalance = fs.verdict === "INSUFFICIENT_DATA";

    const expectedNum = Number(moms.expected ?? 0);
    const expected = moms.expected != null ? formatKr(moms.expected, { decimals: 0 }) : null;

    // PROVENANCE. `expected` is realized + a run-rate projection of the days
    // that have not elapsed yet (foresight_service.py:246-250), so early in a
    // MOMS period most of the headline can be forecast rather than booked. The
    // backend already grades this as `confidence` — the share already realized:
    // high >=80%, medium >=40%, low below that. We surface the split ONLY when
    // the projection is material (confidence != "high"), so the common,
    // near-settled case keeps its shorter line and its balance prompt.
    // Deliberately reads `realized`, never `low` — low is
    // realized + projected*(1-band) and still contains a projection.
    const realizedNum = moms.realized != null ? Number(moms.realized) : null;
    const momsIsMostlyEstimate =
      realizedNum != null && moms.confidence && moms.confidence !== "high" && expectedNum > 0;
    const realizedStr = realizedNum != null ? formatKr(realizedNum, { decimals: 0 }) : null;

    // Balance-free value: even with NO balance we can give the owner the
    // safe plan — what to set aside each week to fund the bill from zero by
    // the deadline (conservative; adding a balance only lowers it). Turns
    // the hero from a "type your balance" ask into an actionable number.
    // Rounded up to a clean 100 kr so it reads tidy and never under-funds.
    const _daysUntil = Number(dl.days_until ?? 0);
    const _weeksToDeadline = Math.max(1, Math.round(_daysUntil / 7));
    // Inside the final week a weekly RATE is the wrong frame. With 4 days left
    // Math.round(4/7) collapses to 1, so "set aside ~101.800 kr./week" is
    // arithmetically just the whole bill — but it reads as a recurring
    // commitment, and next to a shop that has taken 1.234 kr it reads as
    // broken. Same number, honest framing: say it is due, and when.
    const _dueImminently = _daysUntil >= 0 && _daysUntil < 7;
    const weeklyToFund =
      noBalance && expectedNum > 0 && !_dueImminently
        ? Math.ceil(expectedNum / _weeksToDeadline / 100) * 100
        : 0;

    let displayHeadline = headline;
    let detail;
    if (noBalance && _dueImminently && expectedNum > 0) {
      displayHeadline = (
        _daysUntil <= 0
          ? t("fsDueTodayHeadline")
          : _daysUntil === 1
            ? t("fsDueTomorrowHeadline")
            : t("fsDueInDaysHeadline").replace("{n}", String(_daysUntil))
      ).replace("{amt}", expected || "—");
      detail = (
        momsIsMostlyEstimate
          ? t("fsFundDetailEstimated", "~{amt} due {date} · {realized} booked, rest estimated")
              .replace("{realized}", realizedStr)
          : t("fsConnectDetail", "Expected MOMS ~{amt} · due {date}")
      )
        .replace("{amt}", expected || "—")
        .replace("{date}", fmtDate(dl.date));
    } else if (noBalance && weeklyToFund > 0) {
      displayHeadline = t("fsFundHeadline", "Set aside ~{amt}/week to cover MOMS")
        .replace("{amt}", formatKr(weeklyToFund, { decimals: 0 }));
      detail = (
        momsIsMostlyEstimate
          ? t("fsFundDetailEstimated", "~{amt} due {date} · {realized} booked, rest estimated")
              .replace("{realized}", realizedStr)
          : t(
              "fsFundDetail",
              "~{amt} due {date} · add your balance to see if you're already covered",
            )
      )
        .replace("{amt}", expected || "—")
        .replace("{date}", fmtDate(dl.date));
    } else if (noBalance) {
      detail = (
        momsIsMostlyEstimate
          ? t("fsConnectDetailEstimated", "MOMS ~{amt} due {date} · {realized} booked, rest estimated")
              .replace("{realized}", realizedStr)
          : t("fsConnectDetail", "Expected MOMS ~{amt} · due {date}")
      )
        .replace("{amt}", expected || "—")
        .replace("{date}", fmtDate(dl.date));
    } else if (fs.verdict === "SHORT" && action && !action.already_covered) {
      detail = t("fsActionWeekly", "Set aside {amt}/week")
        .replace("{amt}", formatKr(action.weekly_rate, { decimals: 0 }));
    } else if (fs.verdict === "AT_RISK" && action && !action.already_covered) {
      detail = t("fsActionWeeklySafe", "Set aside {amt}/week to be safe")
        .replace("{amt}", formatKr(action.weekly_rate, { decimals: 0 }));
    } else if (fs.verdict === "TIGHT" && fs.balance && fs.balance.lowest) {
      detail = t("fsTightDetail", "Dips to {low} before the deadline")
        .replace("{low}", formatKr(fs.balance.lowest.balance, { decimals: 0 }));
    } else {
      detail = t("fsCoveredDetail", "Expected MOMS ~{amt} — on track")
        .replace("{amt}", expected || "—");
    }

    const eyebrow = `MOMS${dl.period_label ? " · " + dl.period_label : ""} · ${daysPhrase(t, dl.days_until)}`;

    // Balance footer + freshness — only when the owner has typed a balance.
    const hasManualBalance =
      fs.balance_source === "manual" && fs.balance && fs.balance.starting != null;
    const balanceStr = hasManualBalance
      ? formatKr(fs.balance.starting, { decimals: 0 })
      : null;
    const balanceFooter = !hasManualBalance
      ? null
      : fs.balance_stale
      ? t("fsBalanceStale", "Balance {bal} — tap to update for an accurate read").replace("{bal}", balanceStr)
      : t("fsBalanceFooter", "Balance {bal} · tap to update").replace("{bal}", balanceStr);
    // A stale balance tints the icon amber as a gentle nudge.
    const iconTone = fs.balance_stale ? "warn" : tone;

    return (
      <>
        <button
          type="button"
          onClick={() => setBalanceOpen(true)}
          className={
            "w-full text-left block rounded-xl border border-gray-200 dark:border-gray-800 " +
            "bg-white dark:bg-gray-900 p-5 sm:p-6 " +
            "hover:shadow-sm transition-shadow group " +
            "focus-visible:outline-none focus-visible:ring-2 " +
            "focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
            "focus-visible:ring-offset-1 " +
            (className || "")
          }
          data-component="ComplianceCountdownCard"
          data-foresight-verdict={fs.verdict}
          aria-label={t("fsHeroAria", "Open MOMS foresight — {headline}").replace("{headline}", displayHeadline)}
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
              <Icon size={18} strokeWidth={2} className={TONE[iconTone]} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1">
                {eyebrow}
              </p>
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100 leading-snug">
                {displayHeadline}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5 leading-snug">
                {detail}
              </p>
              {balanceFooter && (
                <p
                  className={
                    "text-xs mt-1.5 " +
                    (fs.balance_stale
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-gray-400 dark:text-gray-500")
                  }
                >
                  {balanceFooter}
                </p>
              )}
            </div>
            <ArrowRight
              size={18}
              strokeWidth={2}
              className="shrink-0 mt-1 text-gray-300 dark:text-gray-600 group-hover:text-gray-400 transition-colors"
              aria-hidden="true"
            />
          </div>
        </button>
        {balanceOpen && (
          <BalanceModal
            t={t}
            current={hasManualBalance ? fs.balance.starting : null}
            onClose={() => setBalanceOpen(false)}
            onSaved={() => setLocalBump((n) => n + 1)}
          />
        )}
      </>
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

// ── Balance editor — the no-provider seed. The owner types their current bank
// balance; saving re-pulls foresight so the card flips to the real verdict.
function BalanceModal({ t, current, onClose, onSaved }) {
  const [value, setValue] = useState(current != null ? String(Math.round(current)) : "");
  const [saving, setSaving] = useState(false);

  const submit = async (clear) => {
    setSaving(true);
    try {
      await api.put("/cashflow/balance", { balance: clear ? null : Number(value) || 0 });
      onSaved();
    } catch {
      // best-effort — keep the modal forgiving on a transient error
    } finally {
      setSaving(false);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 p-6 shadow-xl border border-gray-200 dark:border-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t("fsBalanceTitle", "Your bank balance")}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 leading-snug">
          {t("fsBalanceHelp", "Type what's in your account now — we'll tell you if it covers your MOMS bill.")}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            placeholder="0"
            className="flex-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2.5 text-lg text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100"
          />
          <span className="text-gray-500 dark:text-gray-400 text-sm shrink-0">kr</span>
        </div>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={saving || value === ""}
          className="mt-4 w-full rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 py-2.5 font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {t("fsBalanceSave", "Save")}
        </button>
        {current != null && (
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={saving}
            className="mt-2 w-full text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 py-1"
          >
            {t("fsBalanceClear", "Remove balance")}
          </button>
        )}
      </div>
    </div>
  );
}
