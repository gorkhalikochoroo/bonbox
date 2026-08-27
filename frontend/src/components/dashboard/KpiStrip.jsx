/**
 * KpiStrip — the 3-tile KPI row used at the top of Zone 1.
 *
 * Replaces the previous 4-tile grid (Today / Week / Avg / Payments). The
 * v2 spec collapses to 3 tiles: Today / Week / Compliance-next. The
 * WeekComparisonCard's standalone surface is killed — its delta arrow
 * lives INSIDE the Week tile as `↑ Up vs last week`.
 *
 * Composition rules (doctrine):
 *   • Composes existing <StatCard> primitives — never re-rolls KPI
 *     chrome. StatCard handles surface / border / dark-mode.
 *   • Mobile: stacks to 3 vertical cards on `<lg`. We use a CSS grid
 *     with `grid-cols-1 lg:grid-cols-3` so the breakpoint logic is
 *     declarative — no JS resize listeners.
 *   • Delta arrow colors (`text-emerald-600` up / `text-red-600` down)
 *     ARE signal — they carry the "growing" / "shrinking" information.
 *     Doctrine-allowed.
 *
 * Props:
 *   • tiles      — ["today", "week", "complianceNext"]. Order matters.
 *   • showDelta  — when true, the week tile renders its WeekComparison
 *                  delta as part of the helper text, as an arrow + a
 *                  direction WORD ("↑ Up vs last week") — never a raw
 *                  percentage, and withheld entirely when there is no fair
 *                  baseline. The arrow + word are the only colored pixels
 *                  in the tile. (The today tile's delta is dead — the
 *                  backend emits no today_change_pct.)
 *   • ctx        — the assembled Dashboard context (see dashboardCardSets.js).
 *                  Sourced for revenue numbers, currency, weekComparison
 *                  deltas, compliance.daysToNext, etc.
 */
import React from "react";
import { TrendingUp, TrendingDown, Minus, Calendar } from "lucide-react";
import { StatCard, Amount } from "../ui";
import { useLanguage } from "../../hooks/useLanguage";

/**
 * DeltaIndicator — the colored arrow + direction WORD that doctrine allows
 * (color is signal here, not decoration). Rendered as a small inline
 * row so it composes inside the StatCard `helper` slot.
 *
 * This used to print a raw period-over-period percentage ("+12%", and — worse
 * — a bare "0%"). That is the exact thing the house convention forbids, and
 * RevenueTrendChart.jsx:177-186 writes down why: on a young or sparse account
 * the prior window is near-empty, so the ratio reads as a precise-looking but
 * meaningless number. This now follows that same convention — the direction
 * word, behind the same ±5% dead band, so a 1% wobble is not called growth.
 *
 * `pct` arriving null means "no fair baseline" and the whole indicator is
 * withheld (honest absence) rather than rendered as zero. DashboardPage gates
 * that on last_week_revenue.
 */
function DeltaIndicator({ pct, label }) {
  const { t } = useLanguage();
  if (pct == null || Number.isNaN(Number(pct))) return null;
  const n = Number(pct);
  // ±5 percent, matching RevenueTrendChart's ±0.05 ratio dead band.
  const direction = n >= 5 ? "up" : n <= -5 ? "down" : "flat";
  const colorClass =
    direction === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : direction === "down"
      ? "text-red-600 dark:text-red-400"
      : "text-gray-500 dark:text-gray-400";
  const Arrow =
    direction === "up"
      ? TrendingUp
      : direction === "down"
      ? TrendingDown
      : Minus;
  const word =
    direction === "up"
      ? t("trendUp", "Up")
      : direction === "down"
        ? t("trendDown", "Down")
        : t("trendFlat", "Stable");
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className={`inline-flex items-center gap-0.5 font-medium ${colorClass}`}>
        {Arrow && <Arrow size={12} strokeWidth={2} aria-hidden="true" />}
        <span>{word}</span>
      </span>
      {label && (
        <span className="text-gray-500 dark:text-gray-400">{label}</span>
      )}
    </span>
  );
}

export default function KpiStrip({
  tiles = ["today", "week", "complianceNext"],
  showDelta = false,
  ctx = {},
  className = "",
}) {
  const { t } = useLanguage();
  const todayDelta = ctx?.weekComparison?.todayDeltaPct ?? null;
  const weekDelta = ctx?.weekComparison?.weekDeltaPct ?? null;
  const complianceDays = ctx?.compliance?.daysToNext ?? null;
  const complianceLabel =
    ctx?.compliance?.nextDeadlineLabel ||
    ctx?.compliance?.nextDeadline?.label ||
    t("dashComplianceNextLabel", "Next deadline");

  // Render each requested tile in order. Unknown tile ids are skipped
  // silently — easier to ship a tier-trimmed variant later.
  const tileSpecs = {
    today: {
      label: t("liveRevenueToday", "Revenue today"),
      value: <Amount value={ctx?.summary?.todayRevenue ?? 0} currency={ctx?.currency} />,
      helper: showDelta ? (
        <DeltaIndicator
          pct={todayDelta}
          label={t("vsLastWeek", "vs last week")}
        />
      ) : null,
      accent: "neutral",
    },
    week: {
      label: t("liveRevenueWeek", "Revenue this week"),
      value: <Amount value={ctx?.summary?.weekRevenue ?? 0} currency={ctx?.currency} />,
      helper: showDelta ? (
        <DeltaIndicator
          pct={weekDelta}
          label={t("vsLastWeek", "vs last week")}
        />
      ) : null,
      accent: "neutral",
    },
    // "This month" — replaces the old duplicate MOMS-deadline tile (the
    // foresight hero below owns MOMS). A number the owner acts on more
    // often, and the natural today → week → month progression.
    month: {
      label: t("liveRevenueMonth", "This month"),
      value: <Amount value={ctx?.summary?.month_revenue ?? 0} currency={ctx?.currency} />,
      helper: null,
      accent: "neutral",
    },
    complianceNext: {
      label: complianceLabel,
      value:
        complianceDays == null
          ? "—"
          : complianceDays < 0
          ? t("momsOverdueBy", "Overdue by {n} days").replace(
              "{n}",
              String(Math.abs(complianceDays)),
            )
          : complianceDays === 0
          ? t("momsDueToday", "Due today")
          : t("momsDueInDays", "{n} days").replace(
              "{n}",
              String(complianceDays),
            ),
      helper:
        complianceDays != null && complianceDays >= 0 && complianceDays < 7
          ? t("complianceSoon", "Filing window opens soon")
          : null,
      // Severity drives just the value color (StatCard accent), not the
      // surface — keeps the row reading as one calm block.
      accent:
        complianceDays != null && complianceDays < 0
          ? "critical"
          : complianceDays != null && complianceDays < 7
          ? "warn"
          : "neutral",
    },
  };

  // Add a calendar icon-prefixed label for the compliance tile by
  // overriding label — StatCard accepts plain strings or nodes.
  tileSpecs.complianceNext.label = (
    <span className="inline-flex items-center gap-1.5">
      <Calendar
        size={11}
        strokeWidth={2}
        aria-hidden="true"
        className="text-gray-400 dark:text-gray-500"
      />
      <span>{complianceLabel}</span>
    </span>
  );

  return (
    <div
      className={
        // Fluid, not stepped. `sm:grid-cols-3` locked three columns from
        // 640px upward, so the tiles stretched instead of the strip gaining
        // density on a wide screen. auto-fit sizes to whatever fits, and
        // min(100%,220px) keeps a single tile from overflowing a phone.
        "grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3 " +
        (className || "")
      }
      data-zone="1"
      data-component="KpiStrip"
    >
      {tiles.map((id) => {
        const spec = tileSpecs[id];
        if (!spec) return null;
        return (
          <StatCard
            key={id}
            label={spec.label}
            value={spec.value}
            helper={spec.helper}
            accent={spec.accent}
          />
        );
      })}
    </div>
  );
}
