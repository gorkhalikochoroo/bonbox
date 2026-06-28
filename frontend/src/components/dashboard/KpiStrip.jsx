/**
 * KpiStrip — the 3-tile KPI row used at the top of Zone 1.
 *
 * Replaces the previous 4-tile grid (Today / Week / Avg / Payments). The
 * v2 spec collapses to 3 tiles: Today / Week / Compliance-next. The
 * WeekComparisonCard's standalone surface is killed — its delta arrow
 * lives INSIDE the Today tile as `↑12% vs last week`.
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
 *   • showDelta  — when true, the today + week tiles render their
 *                  WeekComparison delta as part of the helper text
 *                  (e.g. "↑12% vs last week"). The arrow + percent are
 *                  the only colored pixels in the tile.
 *   • ctx        — the assembled Dashboard context (see dashboardCardSets.js).
 *                  Sourced for revenue numbers, currency, weekComparison
 *                  deltas, compliance.daysToNext, etc.
 */
import React from "react";
import { TrendingUp, TrendingDown, Calendar } from "lucide-react";
import { StatCard } from "../ui";
import { useLanguage } from "../../hooks/useLanguage";
import { formatKr } from "../../utils/currency";

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  // Always show sign so the arrow + percent read together (↑12%, ↓4%).
  const sign = n > 0 ? "+" : n < 0 ? "" : "";
  return `${sign}${Number(n).toFixed(0)}%`;
}

/**
 * DeltaIndicator — the colored arrow + percent that doctrine allows
 * (color is signal here, not decoration). Rendered as a small inline
 * row so it composes inside the StatCard `helper` slot.
 */
function DeltaIndicator({ pct, label }) {
  if (pct == null || Number.isNaN(Number(pct))) return null;
  const direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
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
      : null;
  const pretty = fmtPct(pct);
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px]">
      <span className={`inline-flex items-center gap-0.5 font-medium ${colorClass}`}>
        {Arrow && <Arrow size={12} strokeWidth={2} aria-hidden="true" />}
        <span>{pretty}</span>
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
      value: formatKr(ctx?.summary?.todayRevenue ?? 0, { decimals: 0 }),
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
      value: formatKr(ctx?.summary?.weekRevenue ?? 0, { decimals: 0 }),
      helper: showDelta ? (
        <DeltaIndicator
          pct={weekDelta}
          label={t("vsLastWeek", "vs last week")}
        />
      ) : null,
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
        "grid grid-cols-1 sm:grid-cols-3 gap-3 " + (className || "")
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
