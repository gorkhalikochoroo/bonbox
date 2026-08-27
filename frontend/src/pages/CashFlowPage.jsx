// Slice-4 chart polish (Foresight honesty pass): the projection chart now
// reads as an HONEST estimate, not a confident filed figure —
//   • money routes through formatKr (da-DK "15.000 kr.", never "15.000 DKK")
//   • a visible "(estimat)" tag + uncertainty band (cone) widening toward the
//     deadline from foresight.moms.low/high — sparse per-day balance is NOT
//     smoothed into a tight confident curve
//   • a vertical "I dag" reference line marks the actuals→projection boundary
//   • foresight verdict / fail-closed states (LEARNING, AT_RISK, STALE,
//     INSUFFICIENT_DATA) surface instead of a pretty green default
//   • status-only colors (emerald=ok / amber=warn / red=risk), Lucide icons,
//     no rainbow, no decorative gradient, no emoji chrome.
import { Link } from "react-router-dom";
import { useState, useEffect } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Wallet, BarChart3, Calendar, AlertTriangle, AlertCircle,
  CheckCircle2, TrendingUp, TrendingDown, Lightbulb,
} from "lucide-react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { formatKr } from "../utils/currency";
import { formatDateClear } from "../utils/dateFormat";
import { FadeIn } from "../components/AnimationKit";
import { PageHeader, StatCard, Button, Amount } from "../components/ui";

// da-DK weekday short names, indexed by Mon=0 (backend WEEKDAY_NAMES order).
const WEEKDAY_SHORT = {
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  da: ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"],
};

function weekdayShort(dayName, lang) {
  // Backend sends English full weekday ("Monday"…). Map to localized short.
  const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const idx = order.indexOf(dayName);
  if (idx < 0) return (dayName || "").slice(0, 3);
  return (WEEKDAY_SHORT[lang] || WEEKDAY_SHORT.en)[idx];
}

function CustomTooltip({ active, payload, t, lang }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-white dark:bg-gray-800 p-3 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 text-sm">
      <p className="font-semibold text-gray-900 dark:text-white">
        {weekdayShort(d.day, lang)} · {formatDateClear(d.date)}
      </p>
      <div className="mt-1 space-y-0.5">
        <p className={`font-semibold tabular-nums ${d.balance >= 0 ? "text-emerald-600" : "text-red-600"}`}>
          {t("cfpColBalance")}: {formatKr(d.balance, { decimals: 0 })}
          <span className="ml-1 text-[10px] font-normal text-gray-400">({t("cfpEstimateTag")})</span>
        </p>
        {d.revenue > 0 && (
          <p className="text-gray-600 dark:text-gray-300 tabular-nums">
            <TrendingUp size={11} strokeWidth={2} className="inline text-emerald-600 mr-1 -mt-0.5" />
            {t("cfpColRevenue")}: {formatKr(d.revenue, { decimals: 0 })}
          </p>
        )}
        {d.expenses > 0 && (
          <p className="text-gray-600 dark:text-gray-300 tabular-nums">
            <TrendingDown size={11} strokeWidth={2} className="inline text-red-600 mr-1 -mt-0.5" />
            {t("cfpColExpenses")}: {formatKr(d.expenses, { decimals: 0 })}
          </p>
        )}
        {d.recurring?.length > 0 && (
          <p className="text-gray-500 dark:text-gray-400 text-xs">
            <Calendar size={11} strokeWidth={2} className="inline mr-1 -mt-0.5" />
            {d.recurring.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

// Verdict → tone + Lucide icon + headline, reusing the existing fsVerdict*
// keys (same pattern as ComplianceCountdownCard). INSUFFICIENT_DATA is the
// honest "add a balance" state — NEVER a confident "you're covered".
function verdictConfig(t, verdict) {
  switch (verdict) {
    case "ON_TRACK":
      return { Icon: CheckCircle2, tone: "ok", headline: t("fsVerdictOnTrack") };
    case "TIGHT":
      return { Icon: AlertTriangle, tone: "warn", headline: t("fsVerdictTight") };
    case "AT_RISK":
      return { Icon: AlertTriangle, tone: "warn", headline: t("fsVerdictAtRisk") };
    case "SHORT":
      return { Icon: AlertCircle, tone: "bad", headline: t("fsVerdictShort") };
    default:
      return { Icon: Wallet, tone: "neutral", headline: t("fsVerdictEnterBalance") };
  }
}

const TONE_TEXT = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  neutral: "text-gray-500 dark:text-gray-400",
};
const TONE_BORDER = {
  ok: "border-emerald-500",
  warn: "border-amber-500",
  bad: "border-red-600",
  neutral: "border-gray-300 dark:border-gray-700",
};

/* The foresight payload's `moms.confidence` is a WORD — "high" | "medium" |
   "low", the share of the bill already booked (foresight_service.py:283) —
   NOT a 0-1 fraction. This screen used to render
   Math.round(confidence * 100), so "low" * 100 gave NaN and the owner was
   shown "NaN% confidence" underneath a MOMS estimate.
   Worded rather than numeric is also the house rule, already written down at
   components/ui/SuggestionCard.jsx:64 — "worded band, never a %". An unknown
   value renders nothing at all rather than guessing a level. */
const CONFIDENCE_KEY = {
  high: "cfpConfidenceHigh",
  medium: "cfpConfidenceMedium",
  low: "cfpConfidenceLow",
};

export default function CashFlowPage() {
  const { t, lang } = useLanguage();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchForecast = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get("/cashflow/forecast");
      setData(res.data);
    } catch {
      setError(t("cfpError"));
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchForecast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Wallet size={32} strokeWidth={1.5} className="mx-auto mb-3 text-gray-400 animate-pulse" />
          <p className="text-gray-500 dark:text-gray-400">{t("cfpLoading")}</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <BarChart3 size={32} strokeWidth={1.5} className="mx-auto mb-4 text-gray-400" />
        <p className="text-red-500">{error || t("cfpError")}</p>
        <button onClick={fetchForecast} className="mt-4 text-sm text-emerald-600 hover:underline">
          {t("cfpTryAgain")}
        </button>
      </div>
    );
  }

  const { projection, alerts, current_balance, safety_threshold, lowest_point,
    danger_days, receivables, total_receivable, recurring_expenses,
    has_data, foresight } = data;

  // The real uncertainty + fail-closed signals the engine already computes.
  const fs = foresight && foresight.available ? foresight : null;

  // Chart data — keep raw ISO date for the localized formatters; add a
  // fuzzy uncertainty band derived from foresight.moms range. We do NOT have
  // per-day low/high (the projection points carry only a scalar balance), so
  // we widen a band toward the deadline using the MOMS range spread, never
  // fabricating a precise per-day cone. The band is rendered low-opacity so it
  // reads as "range", not an exact figure.
  const momsSpread =
    fs && fs.moms && fs.moms.low != null && fs.moms.high != null
      ? Math.max(0, Number(fs.moms.high) - Number(fs.moms.low))
      : 0;
  const horizon = Math.max(1, projection.length - 1);
  const chartData = projection.map((p, i) => {
    // Widen linearly from 0 (today, known) to the full MOMS spread at the
    // far edge. half-spread above/below the projected balance.
    const half = (momsSpread / 2) * (i / horizon);
    return {
      ...p,
      bandLow: momsSpread > 0 ? p.balance - half : null,
      // recharts stacks the band as [low, low+range]; store the range height.
      bandRange: momsSpread > 0 ? half * 2 : null,
    };
  });

  const todayDate = projection[0]?.date;

  const minBalance = Math.min(...projection.map(p => p.balance), 0) - momsSpread / 2;
  const maxBalance = Math.max(...projection.map(p => p.balance)) + momsSpread / 2;
  const yMin = Math.floor(minBalance / 1000) * 1000 - 1000;
  const yMax = Math.ceil(maxBalance / 1000) * 1000 + 1000;

  // Status color for the balance line + fill: emerald above safety, amber in
  // the warn band (0..safety), red below zero. Encodes risk, not decoration.
  const lowBal = lowest_point?.balance ?? current_balance;
  const lineStatus =
    lowBal < 0 ? "#dc2626" : lowBal < safety_threshold ? "#d97706" : "#059669";

  // Alert severity → Lucide icon + status tone (no rainbow, no raw emoji).
  const alertVisual = (severity) => {
    switch (severity) {
      case "critical":
        return { Icon: AlertCircle, border: "border-red-600", bg: "bg-red-50 dark:bg-red-900/20", icon: "text-red-600 dark:text-red-400" };
      case "warning":
        return { Icon: AlertTriangle, border: "border-amber-500", bg: "bg-amber-50 dark:bg-amber-900/20", icon: "text-amber-600 dark:text-amber-400" };
      case "medium":
        return { Icon: AlertTriangle, border: "border-amber-500", bg: "bg-amber-50 dark:bg-amber-900/20", icon: "text-amber-600 dark:text-amber-400" };
      case "positive":
        return { Icon: CheckCircle2, border: "border-emerald-500", bg: "bg-emerald-50 dark:bg-emerald-900/20", icon: "text-emerald-600 dark:text-emerald-400" };
      default:
        return { Icon: AlertCircle, border: "border-gray-300 dark:border-gray-700", bg: "bg-gray-50 dark:bg-gray-800/50", icon: "text-gray-500 dark:text-gray-400" };
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <PageHeader
          eyebrow="MONEY"
          title={t("cfpTitle")}
          actions={
            <Button variant="secondary" onClick={fetchForecast}>
              {t("refresh")}
            </Button>
          }
        />
      </FadeIn>

      {/* ─── FORESIGHT VERDICT BAND — the honest "will you cover MOMS?" read.
          Fail-closed: INSUFFICIENT_DATA shows "add a balance", never a
          confident green. STALE tints amber. ─── */}
      {fs && (() => {
        const { Icon, tone, headline } = verdictConfig(t, fs.verdict);
        const iconTone = fs.balance_stale ? "warn" : tone;
        const expected = fs.moms?.expected != null ? formatKr(fs.moms.expected, { decimals: 0 }) : "—";
        const low = fs.moms?.low != null ? formatKr(fs.moms.low, { decimals: 0 }) : null;
        const high = fs.moms?.high != null ? formatKr(fs.moms.high, { decimals: 0 }) : null;
        return (
          <div className={`rounded-xl border-l-4 ${TONE_BORDER[iconTone]} bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4`}>
            <div className="flex items-start gap-3">
              <Icon size={20} strokeWidth={2} className={`shrink-0 mt-0.5 ${TONE_TEXT[iconTone]}`} aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-base font-semibold text-gray-900 dark:text-gray-100 leading-snug">
                  {headline}
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                  {t("cfpMomsExpected")
                    .replace("{amt}", expected)} {" "}
                  <span className="text-gray-400">({t("cfpEstimateTag")})</span>
                </p>
                {low && high && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 tabular-nums">
                    {t("cfpRange")}: {low} – {high}
                    {CONFIDENCE_KEY[fs.moms?.confidence] ? ` · ${t(CONFIDENCE_KEY[fs.moms.confidence])}` : ""}
                  </p>
                )}
                {fs.balance_stale && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{t("cfpStale")}</p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ─── KEY METRICS — accents only when the data warrants it ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={t("cfpCurrentBalance")}
          value={<Amount value={current_balance} />}
          accent={current_balance >= 0 ? "success" : "critical"}
        />
        <StatCard
          label={t("cfpLowestPoint")}
          value={<Amount value={lowest_point.balance} />}
          accent={
            lowest_point.balance >= safety_threshold
              ? "success"
              : lowest_point.balance >= 0
              ? "warn"
              : "critical"
          }
          helper={`${formatDateClear(lowest_point.date)} · ${t("cfpEstimateTag")}`}
        />
        <StatCard
          label={t("cfpDangerDays")}
          value={String(danger_days)}
          accent={danger_days === 0 ? "success" : danger_days <= 5 ? "warn" : "critical"}
          helper={t("cfpOf30")}
        />
        <StatCard
          label={t("cfpReceivables")}
          value={<Amount value={total_receivable} />}
          helper={t("cfpCustomersCount").replace("{n}", String(receivables.length))}
        />
      </div>

      {/* ─── ALERTS ─── */}
      {alerts.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => {
            const v = alertVisual(alert.severity);
            const Icon = v.Icon;
            return (
              <div key={i} className={`p-4 rounded-xl border-l-4 ${v.border} ${v.bg}`}>
                <div className="flex items-start gap-3">
                  <Icon size={20} strokeWidth={2} className={`shrink-0 mt-0.5 ${v.icon}`} aria-hidden="true" />
                  <div className="flex-1">
                    <p className="text-sm font-bold text-gray-800 dark:text-gray-200">{alert.title}</p>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{alert.detail}</p>
                    {alert.action && (
                      <p className="text-xs text-gray-700 dark:text-gray-300 mt-2 font-medium flex items-start gap-1.5">
                        <Lightbulb size={13} strokeWidth={2} className="shrink-0 mt-0.5 text-gray-500" aria-hidden="true" />
                        <span>{alert.action}</span>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── 30-DAY CHART ─── */}
      {has_data && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <h2 className="font-bold text-gray-800 dark:text-white">{t("cfpChartTitle")}</h2>
            <span className="text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
              {t("cfpEstimateTag")}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            {t("cfpSubtitle")}
          </p>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" opacity={0.5} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(iso) => formatDateClear(iso).replace(/\s\d{2}$/, "")}
                  interval={4}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(v) => `${new Intl.NumberFormat("da-DK").format(Math.round(v / 1000))} ${t("thousandShort")}`}
                  domain={[yMin, yMax]}
                  width={56}
                />
                <Tooltip content={<CustomTooltip t={t} lang={lang} />} />
                {/* Fuzzy uncertainty band (cone) — invisible base + low-opacity
                    range stacked on top. Widens toward the deadline; honest
                    "range", never a precise per-day figure. */}
                {momsSpread > 0 && (
                  <>
                    <Area
                      type="monotone"
                      dataKey="bandLow"
                      stackId="cone"
                      stroke="none"
                      fill="none"
                      dot={false}
                      activeDot={false}
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="bandRange"
                      stackId="cone"
                      stroke="none"
                      fill={lineStatus}
                      fillOpacity={0.1}
                      dot={false}
                      activeDot={false}
                      isAnimationActive={false}
                    />
                  </>
                )}
                <ReferenceLine
                  y={safety_threshold}
                  stroke="#d97706"
                  strokeDasharray="5 5"
                  strokeWidth={1.5}
                  label={{ value: t("cfpSafetyBuffer"), fill: "#d97706", fontSize: 10, position: "insideTopRight" }}
                />
                <ReferenceLine y={0} stroke="#dc2626" strokeWidth={1} />
                {todayDate && (
                  <ReferenceLine
                    x={todayDate}
                    stroke="#9ca3af"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    label={{ value: t("cfpToday"), fill: "#9ca3af", fontSize: 10, position: "insideTopLeft" }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke={lineStatus}
                  strokeWidth={2}
                  fill="none"
                  dot={false}
                  activeDot={{ r: 5, fill: lineStatus }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-3 text-xs text-gray-500 flex-wrap">
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 inline-block rounded" style={{ background: lineStatus }} /> {t("cfpBalanceLegend")} ({t("cfpEstimateTag")})</span>
            {momsSpread > 0 && (
              <span className="flex items-center gap-1"><span className="w-3 h-2 inline-block rounded-sm" style={{ background: lineStatus, opacity: 0.15 }} /> {t("cfpRange")}</span>
            )}
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-amber-500 inline-block rounded" /> {t("cfpSafetyBuffer")} ({formatKr(safety_threshold, { decimals: 0 })})</span>
            <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-500 inline-block rounded" /> {t("cfpZeroLine")}</span>
          </div>
        </div>
      )}

      {/* ─── DAILY BREAKDOWN TABLE ─── */}
      {has_data && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">{t("cfpDailyBreakdown")}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b dark:border-gray-700">
                  <th className="text-left py-2 px-2">{t("cfpColDate")}</th>
                  <th className="text-left py-2 px-2">{t("cfpColDay")}</th>
                  <th className="text-right py-2 px-2">{t("cfpColRevenue")}</th>
                  <th className="text-right py-2 px-2">{t("cfpColExpenses")}</th>
                  <th className="text-right py-2 px-2">{t("cfpColBalance")}</th>
                  <th className="text-left py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {projection.slice(0, 14).map((p, i) => (
                  <tr key={i} className={`border-b dark:border-gray-700/50 ${
                    p.is_danger ? "bg-red-50/50 dark:bg-red-900/10" : ""
                  }`}>
                    <td className="py-2 px-2 text-gray-700 dark:text-gray-300">{formatDateClear(p.date).replace(/\s\d{2}$/, "")}</td>
                    <td className="py-2 px-2 text-gray-500 dark:text-gray-400">{weekdayShort(p.day, lang)}</td>
                    <td className="py-2 px-2 text-right text-emerald-600 tabular-nums">
                      {p.revenue > 0 ? formatKr(p.revenue, { decimals: 0, sign: true }) : "—"}
                    </td>
                    <td className="py-2 px-2 text-right text-red-600 tabular-nums">
                      {p.expenses > 0 ? `-${formatKr(p.expenses, { decimals: 0 })}` : "—"}
                    </td>
                    <td className={`py-2 px-2 text-right font-semibold tabular-nums ${
                      p.balance < 0 ? "text-red-600" : p.is_danger ? "text-amber-600" : "text-gray-800 dark:text-white"
                    }`}>
                      {formatKr(p.balance, { decimals: 0 })}
                    </td>
                    <td className="py-2 px-2">
                      <span className="inline-flex items-center gap-1">
                        {p.is_danger && <AlertTriangle size={13} strokeWidth={2} className="text-red-600" aria-label={t("cfpDangerDays")} />}
                        {p.recurring?.length > 0 && <Calendar size={13} strokeWidth={2} className="text-gray-400" aria-label={t("cfpRecurringTitle")} />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {projection.length > 14 && (
            <p className="text-xs text-gray-400 text-center mt-3">{t("cfpFirst14")}</p>
          )}
        </div>
      )}

      {/* ─── TOP RECEIVABLES ─── */}
      {receivables.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-1 flex items-center gap-2">
            <Wallet size={16} strokeWidth={2} className="text-gray-500" aria-hidden="true" />
            {t("cfpReceivablesTitle")}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            {t("cfpReceivablesHelp").replace("{amt}", formatKr(total_receivable, { decimals: 0 }))}
          </p>
          <div className="space-y-2">
            {receivables.map((r, i) => {
              const pct = total_receivable > 0 ? (r.outstanding / total_receivable) * 100 : 0;
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-sm font-bold text-gray-600 dark:text-gray-300">
                    {i + 1}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{r.customer_name}</span>
                      <span className="text-sm font-bold text-gray-900 dark:text-gray-100 tabular-nums">{formatKr(r.outstanding, { decimals: 0 })}</span>
                    </div>
                    <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full mt-1 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── RECURRING EXPENSES ─── */}
      {recurring_expenses.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4 flex items-center gap-2">
            <Calendar size={16} strokeWidth={2} className="text-gray-500" aria-hidden="true" />
            {t("cfpRecurringTitle")}
          </h2>
          <div className="space-y-2">
            {recurring_expenses.map((re, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{re.description}</p>
                  <p className="text-xs text-gray-500">{re.category} · {t("cfpDueOn").replace("{date}", formatDateClear(re.next_due))}</p>
                </div>
                <span className="text-sm font-bold text-red-600 tabular-nums">-{formatKr(re.amount, { decimals: 0 })}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No data prompt — honest LEARNING state */}
      {!has_data && (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-8 shadow-sm text-center">
          <BarChart3 size={40} strokeWidth={1.5} className="mx-auto mb-4 text-gray-400" />
          <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-2">{t("cfpEmptyTitle")}</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-2">{t("cfpEmptyBody")}</p>
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-4">{t("cfpLearning")}</p>
          <div className="flex gap-3 justify-center">
            <Link to="/sales" className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition">
              {t("cfpLogSales")}
            </Link>
            <Link to="/cashbook" className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-600 transition">
              {t("cfpCashBook")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
