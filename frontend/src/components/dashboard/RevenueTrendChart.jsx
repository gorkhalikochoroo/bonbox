/**
 * RevenueTrendChart — Zone 2 hero chart. Days window (7/30/90) driven
 * by tier features via the `days` prop the card-set config supplies.
 *
 * Owner-clarity pass:
 *   • X-axis shows readable da-DK dates ("14. jun"), auto-thinned to a
 *     handful of ticks — no wall of raw ISO strings.
 *   • A single at-a-glance up/down chip (↑/↓ % over the period) answers
 *     the owner's #1 question — "is revenue growing?" — before they read
 *     a single number. Emerald/red are the ONLY colours, used as a real
 *     status signal (allowed), never decoration.
 *
 * Doctrine compliance:
 *   • Neutral surface (rounded-xl, gray-200 border, bg-white)
 *   • Single chart series in gray-700 (no rainbow, no gradient)
 *   • Clickable card → /reports for the deep view
 *
 * Honest timeline: the backend now emits `revenue_trend` — a rolling,
 * zero-filled last-90-days series (dashboard.py) — so a quiet day reads
 * as a real dip to zero, not a gap the line smooths over. Because every
 * calendar day is present, the empty / sparse / average / trend logic
 * below keys off the count of days that actually had revenue, never the
 * raw array length. The leading no-sale runway (before the owner's first
 * sale in the window) is trimmed so a sparse seller starts at real
 * activity; gaps between sales and any recent quiet run are kept.
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useLanguage } from "../../hooks/useLanguage";
import { formatKr } from "../../utils/currency";
import { UpgradeNudge } from "../ui";

// Full readable date with weekday for the tooltip — "lør 14. jun" / "Sat 14 Jun".
function fmtTrendDate(label, lang) {
  try {
    const d = new Date(label + "T00:00:00");
    const locale = lang === "da" ? "da-DK" : "en-GB";
    return d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  } catch {
    return label;
  }
}

// Compact axis date — "14. jun" / "14 Jun". No weekday/year so the ticks
// stay short and the owner reads the timeline at a glance.
function fmtAxisDate(label, lang) {
  try {
    const d = new Date(label + "T00:00:00");
    const locale = lang === "da" ? "da-DK" : "en-GB";
    return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
  } catch {
    return label;
  }
}

// Mean over the days that actually had revenue. The series is now
// zero-filled, so a plain mean would divide a typical trading day by all
// the closed days and read far too low — this keeps "Avg" + the trend
// comparison meaning "a typical day you were open".
const meanNonZero = (arr) => {
  const nz = arr.filter((d) => (d.amount || 0) > 0);
  return nz.length ? nz.reduce((s, d) => s + d.amount, 0) / nz.length : 0;
};

export default function RevenueTrendChart({ ctx = {}, days = 30 }) {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const windowed = (ctx?.dailyRevData || []).slice(-days);
  // Adaptive start: trim the leading no-sale days so the chart begins at
  // the owner's first sale within the window instead of drawing a long
  // flat-zero runway before they were active. Gaps BETWEEN sales and any
  // recent quiet run are kept — those are real signal, not empty space.
  const firstSold = windowed.findIndex((d) => (d.amount || 0) > 0);
  const data = firstSold > 0 ? windowed.slice(firstSold) : windowed;
  const soldDays = data.filter((d) => (d.amount || 0) > 0);
  // Month-to-date revenue — lets a tier-capped short window (Free = 7 days)
  // stay honest + value-forward instead of reading "no data" on a quiet
  // recent week when the month itself is strong.
  const monthRev = Number(ctx?.summary?.month_revenue || 0);

  const cardCls =
    "rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition";
  const staticCardCls =
    "rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6";

  // Honest tier-gate: `days` is the tier-capped window (Free = 7, paid = 90),
  // but ctx.dailyRevData is the FULL rolling series. So we can tell apart
  // "no data" from "you HAVE a trend, it's just outside your window." Only the
  // second case earns an upgrade prompt — and it shows the real count of days
  // with sales, so it can never over-promise. This is the exact dead-end an
  // owner hits when a trial lapses: the chart silently emptied instead of
  // saying why. `days < 90` == on the capped (Free) window.
  const fullSoldCount = (ctx?.dailyRevData || []).filter((d) => (d.amount || 0) > 0).length;
  const windowHidesTrend =
    days < 90 && fullSoldCount >= 3 && soldDays.length < 3;

  if (windowHidesTrend) {
    return (
      <div className={staticCardCls} data-zone="2" data-component="RevenueTrendChart">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t("revenueTrend", "Revenue trend")}
        </h3>
        {monthRev > 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
            {t("revenueTrendMonthSoFar", "This month so far: {amt}").replace(
              "{amt}", formatKr(monthRev, { decimals: 0 }))}
          </p>
        )}
        <UpgradeNudge
          intent="inline"
          tier="starter"
          iconName="LineChart"
          benefit={t(
            "revenueTrendUnlockBenefit",
            "See your full 90-day trend — you have sales on {n} days",
          ).replace("{n}", String(fullSoldCount))}
          ctaLabel={t("revenueTrendUnlockCta", "See plans")}
          cta="/subscription"
        />
      </div>
    );
  }

  if (!data.length || soldDays.length === 0) {
    return (
      <div onClick={() => navigate("/reports")} className={cardCls} data-zone="2" data-component="RevenueTrendChart">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t("revenueTrend", "Revenue trend")}
        </h3>
        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {monthRev > 0
            ? t("revenueTrendMonthSoFar", "This month so far: {amt}").replace("{amt}", formatKr(monthRev, { decimals: 0 }))
            : t("revenueTrendEmpty", "Log your first sale to start the chart.")}
        </p>
      </div>
    );
  }

  const avg = Math.round(meanNonZero(data));

  // Sparse-data honesty: with fewer than 3 days of actual revenue a
  // connecting line reads as a confident "trend" that doesn't exist.
  // List the real days (not the zero-filled gaps) + an honest notice.
  if (soldDays.length < 3) {
    return (
      <div onClick={() => navigate("/reports")} className={cardCls} data-zone="2" data-component="RevenueTrendChart">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t("revenueTrend", "Revenue trend")}
        </h3>
        <ul className="space-y-1.5 mt-2">
          {soldDays.map((d) => (
            <li key={d.date} className="flex items-center justify-between text-sm text-gray-700 dark:text-gray-300 tabular-nums">
              <span className="text-gray-500 dark:text-gray-400">{fmtTrendDate(d.date, lang)}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{formatKr(d.amount, { decimals: 0 })}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {monthRev > 0
            ? t("revenueTrendMonthSoFar", "This month so far: {amt}").replace("{amt}", formatKr(monthRev, { decimals: 0 }))
            : t("revenueTrendSparse", "Not enough days yet to show a trend — keep logging sales.")}
        </p>
      </div>
    );
  }

  // HONEST momentum chip. The anchor is the MEASURED period total — the sum of
  // effective revenue over the window — so it moves krone-for-krone when the
  // owner adds/edits/deletes a sale (delete a 500-kr sale → the total drops 500)
  // and tracks the confirmed DailyClose on close-wins dates. We NEVER show a raw
  // period-over-period % here: on a young or sparse account the prior window is
  // near-empty, so a ratio reads as a precise-looking but meaningless "+258%"
  // that barely budges on a delete — the exact bug owners hit. Instead a plain
  // direction WORD (Op / Ned / Stabil) appears ONLY when the prior window is a
  // FAIR baseline; otherwise we withhold it entirely (honest absence) and let
  // the measured total stand alone.
  const fullSeries = ctx?.dailyRevData || [];
  const curWindow = fullSeries.slice(-days);
  const prevWindow = fullSeries.slice(-days * 2, -days);
  const curTotal = curWindow.reduce((s, d) => s + (d.amount || 0), 0);
  const prevTotal = prevWindow.reduce((s, d) => s + (d.amount || 0), 0);
  const prevSold = prevWindow.filter((d) => (d.amount || 0) > 0).length;

  // Fair-baseline gate: a full prior window, enough trading days that one lucky
  // sale can't define it, and a real kr floor so a near-zero denominator can't
  // manufacture a swing. Deliberately NO relative-magnitude floor (e.g. "prev ≥
  // half of current") — that is algebraically "growth ≤ +100%" and would
  // silently suppress the direction word on genuine strong growth, the one
  // signal an owner most wants to see. Density + the absolute floor already stop
  // the near-zero-denominator and single-sale-leverage problems.
  const baselineFair =
    prevWindow.length >= days &&
    prevSold >= Math.max(5, Math.ceil(days / 3)) &&
    prevTotal >= 5000;
  const ratio = baselineFair ? (curTotal - prevTotal) / prevTotal : null;
  const dir = ratio == null ? null : ratio >= 0.05 ? "up" : ratio <= -0.05 ? "down" : "flat";

  const TrendIcon = dir === "down" ? TrendingDown : dir === "up" ? TrendingUp : Minus;
  const trendColor =
    dir === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : dir === "down"
        ? "text-red-600 dark:text-red-400"
        : "text-gray-500 dark:text-gray-400";
  const trendWord =
    dir === "up"
      ? t("trendUp", "Up")
      : dir === "down"
        ? t("trendDown", "Down")
        : t("trendFlat", "Stable");

  return (
    <div onClick={() => navigate("/reports")} className={cardCls} data-zone="2" data-component="RevenueTrendChart">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("revenueTrend", "Revenue trend")}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {t("revenueTrendWindow", "Last {n} days").replace("{n}", String(days))}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100 tabular-nums leading-tight">
            {formatKr(curTotal, { decimals: 0 })}
          </p>
          {dir && (
            <span
              className={`inline-flex items-center gap-1 text-sm font-medium tabular-nums ${trendColor}`}
              title={t("revenueTrendVsPrev", "vs. previous period")}
            >
              <TrendIcon className="w-4 h-4" strokeWidth={2.25} aria-hidden="true" />
              {trendWord}
            </span>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums mt-0.5">
            {t("avgShort", "Avg")}: {formatKr(avg, { decimals: 0 })}
          </p>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(156,163,175,0.15)" />
          <XAxis
            dataKey="date"
            tickFormatter={(v) => fmtAxisDate(v, lang)}
            minTickGap={36}
            tick={{ fontSize: 11, fill: "#9CA3AF" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#9CA3AF" }}
            axisLine={false}
            tickLine={false}
            width={48}
            tickCount={4}
            tickFormatter={(v) =>
              v >= 1000
                ? `${new Intl.NumberFormat("da-DK").format(Math.round(v / 1000))} ${t("thousandShort", "t.kr.")}`
                : new Intl.NumberFormat("da-DK").format(Number(v))
            }
          />
          <Tooltip
            cursor={{ stroke: "#9CA3AF", strokeWidth: 1, strokeDasharray: "3 3" }}
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #E5E7EB",
              borderRadius: 8,
              boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
              padding: "8px 12px",
            }}
            labelStyle={{ color: "#6B7280", fontSize: 11, fontWeight: 500, marginBottom: 2, textTransform: "none" }}
            itemStyle={{ color: "#111827", fontSize: 13, fontWeight: 600, padding: 0 }}
            formatter={(v) => [formatKr(v, { decimals: 0 }), t("revenue", "Revenue")]}
            labelFormatter={(label) => fmtTrendDate(label, lang)}
          />
          <Area type="monotone" dataKey="amount" stroke="#374151" strokeWidth={2} fill="rgba(55,65,81,0.08)" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
