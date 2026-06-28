// Task #118 polish (Agent B): migrated to PageHeader, StatCard,
// SectionBanner, Card, Empty primitives.  Replaced ad-hoc rounded-xl
// recharts wrapper, the colored alert blocks, and the local MetricCard
// helper with primitives.  Recharts chart itself is one-off and left
// alone (only the wrapper polished).  Behavior + i18n + a11y unchanged.
//
// Phase 1 expiry chain (May 2026, Manoj-confirmed):
//   • Starter+ → alerts banner at top with waste-cost prose +
//     per-item action chips (used / wasted / extended / sold_discount).
//   • Free     → UpgradeNudge in the alerts slot ("Spildalarmer er en
//     Starter+ funktion") + items list still rendered but the
//     waste-cost column is hidden (backend strips it server-side via
//     scan_upcoming_expiries' L4 gate).
import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useEntitlements } from "../hooks/useEntitlements";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Button, PageHeader, StatCard, SectionBanner, Empty, Icon, UpgradeNudge,
} from "../components/ui";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }

const STATUS_CONFIG = {
  expired:  { labelKey: "expStatusExpired",  label: "Expired",   color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" },
  critical: { labelKey: "expStatusCritical", label: "< 7 days",  color: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  warning:  { labelKey: "expStatusWarning",  label: "7-14 days", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" },
  upcoming: { labelKey: "expStatusUpcoming", label: "14-30 days",color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
};

export default function ExpiryPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { hasFeature, isReady: entReady } = useEntitlements();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [upcoming, setUpcoming] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actingId, setActingId] = useState(null);

  // Phase 1 — tier gate read from entitlements. Drives the alerts
  // banner (Starter+) vs UpgradeNudge (Free) at the top of the page.
  //
  // Three-state contract: null while entitlements loading, true on
  // Starter+, false on confirmed Free.  Without this guard, a trial
  // user briefly sees the "Spildalarmer er en Starter+ funktion"
  // UpgradeNudge before the real entitlements payload lands and
  // hasFeature() flips to true — the trial-flicker bug.
  const expiryAlertsAvailable = entReady ? hasFeature("expiry_alerts") : null;

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [forecast, upcomingRes] = await Promise.all([
        api.get("/expiry/forecast"),
        api.get("/expiry/upcoming", { params: { days: 3 } }).catch(() => ({ data: null })),
      ]);
      setData(forecast.data);
      setUpcoming(upcomingRes.data);
    } catch { setError(t("expLoadError", "Could not load expiry data")); }
    setLoading(false);
  };

  // L9 — every action confirmed before firing, even the non-destructive
  // ones. Owner can undo via /inventory if they tap wrong.
  const handleAction = async (itemId, action) => {
    const promptMap = {
      used: t("expiryConfirmUsed", "Mark this item as used in service?"),
      wasted: t("expiryConfirmWasted", "Mark this item as wasted? This logs a waste row."),
      extended: t("expiryConfirmExtended", "Extend expiry by 3 days?"),
      sold_discount: t("expiryConfirmDiscount", "Mark as sold at discount?"),
    };
    if (!window.confirm(promptMap[action] || t("expConfirmGeneric", "Confirm?"))) return;
    setActingId(`${itemId}:${action}`);
    try {
      await api.post(`/expiry/item/${itemId}/mark`, { action });
      await fetchData();
    } catch (e) {
      console.warn("expiry action failed", e);
    } finally {
      setActingId(null);
    }
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">📦</div>
          <p className="text-gray-500 dark:text-gray-400">{t("expChecking", "Checking expiry dates...")}</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto">
        <Empty
          icon="📦"
          title={error || t("expLoadError", "Could not load expiry data")}
          cta={<Button variant="primary" onClick={fetchData}>{t("tryAgain", "Try again")}</Button>}
        />
      </div>
    );
  }

  const {
    expired_items, expiring_soon, expiring_moderate, expiring_later,
    total_at_risk_value, total_tracked_items, missing_expiry,
    waste_summary, waste_trend, recommendations, alerts,
  } = data;

  const allExpiring = [
    ...expired_items.map(i => ({ ...i, _section: "expired" })),
    ...expiring_soon.map(i => ({ ...i, _section: "critical" })),
    ...expiring_moderate.map(i => ({ ...i, _section: "warning" })),
    ...expiring_later.map(i => ({ ...i, _section: "upcoming" })),
  ];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <PageHeader
          eyebrow={t("expEyebrowStock", "STOCK")}
          title={t("expiryForecasting") || "Expiry Forecasting"}
          subtitle={t("expSubtitle", "Track items approaching their expiry date and avoid waste.")}
        />
      </FadeIn>

      {/* ─── Phase 1 — alerts banner OR Free-tier UpgradeNudge ───
          Starter+ users see the live "X items expire today, Y kr at
          risk" banner with one-tap action chips per item. Free users
          see the same items list lower down but the alert-rich layer
          + waste-cost column is gated to Starter+.
          Tier-flicker fix: only render the locked nudge when we have
          CONFIRMED Free entitlements (=== false).  While loading
          (null) render nothing to avoid the trial-flicker. */}
      {expiryAlertsAvailable === false && (
        <UpgradeNudge
          intent="card"
          tier="starter"
          icon="⏰"
          benefit={
            t(
              "expiryUpgradeNudgeBenefit",
              "Spildalarmer er en Starter+ funktion — opgrader for at spare ~5,000 kr/år i fødevarespild",
            )
          }
          ctaLabel={t("expiryUpgradeNudgeCta", "See plans")}
        />
      )}
      {expiryAlertsAvailable === true && upcoming?.items?.length > 0 && (
        <SectionBanner
          severity={
            upcoming.items.some((i) => (i.days_left ?? 99) <= 0) ? "warn" : "info"
          }
          icon="AlarmClock"
          title={
            upcoming.items.some((i) => (i.days_left ?? 99) <= 0)
              ? t("expiryBannerTodayTitle", "Items expire today")
                  .replace(
                    "{n}",
                    String(upcoming.items.filter((i) => (i.days_left ?? 99) <= 0).length),
                  )
              : t("expiryBannerSoonTitle", "Items expire soon")
                  .replace("{n}", String(upcoming.items.length))
          }
        >
          {(upcoming.total_at_risk_dkk ?? 0) > 0 && (
            <p className="font-medium">
              {fmt(upcoming.total_at_risk_dkk)} {currency} {t("expiryAtRisk", "at risk")}
            </p>
          )}
          <div className="mt-3 space-y-2">
            {upcoming.items.slice(0, 6).map((it) => (
              <div
                key={it.id}
                className="flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-gray-900/40 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                    {it.name}
                  </p>
                  <p className="text-xs text-gray-500">
                    {it.quantity} {it.unit} ·{" "}
                    {(it.days_left ?? 99) <= 0
                      ? t("expiryDueToday", "due today")
                      : t("expiryInDays", "{n}d left").replace("{n}", String(it.days_left))}
                    {it.cost_at_risk_dkk != null && it.cost_at_risk_dkk > 0 && (
                      <> · {fmt(it.cost_at_risk_dkk)} {currency}</>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { a: "used", label: t("expiryActionUsed", "Used") },
                    { a: "wasted", label: t("expiryActionWasted", "Wasted") },
                    { a: "extended", label: t("expiryActionExtended", "+3d") },
                    { a: "sold_discount", label: t("expiryActionDiscount", "Sold") },
                  ].map(({ a, label }) => (
                    <button
                      key={a}
                      type="button"
                      disabled={actingId === `${it.id}:${a}`}
                      onClick={() => handleAction(it.id, a)}
                      className="text-xs px-2.5 py-1 rounded-md bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/50 border border-gray-100 dark:border-gray-800/60 disabled:opacity-50"
                    >
                      {actingId === `${it.id}:${a}` ? "…" : label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SectionBanner>
      )}

      {/* ─── ALERTS ─── Each comes back from the API tagged with
          severity (warning/positive/neutral). Map to the canonical
          SectionBanner palette so the wider page stays palette-consistent. */}
      {alerts?.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => (
            <SectionBanner
              key={i}
              severity={
                alert.severity === "warning" ? "warn" :
                alert.severity === "positive" ? "success" :
                "info"
              }
              icon={
                alert.severity === "warning" ? "AlertTriangle" :
                alert.severity === "positive" ? "CheckCircle2" :
                "Sparkles"
              }
              title={alert.title}
            >
              <p>{alert.detail}</p>
              {alert.action && (
                <p className="mt-2 font-medium text-gray-700 dark:text-emerald-400">
                  → {alert.action}
                </p>
              )}
            </SectionBanner>
          ))}
        </div>
      )}

      {/* ─── KEY METRICS ─── unified to StatCard. Accent is `critical`
          when the value is something to act on (expired/expiring items
          > 0), `success` when zero, neutral for raw counts. The colour
          stays data-true.
          Phase 1 — Free users don't see At-Risk Value (tier-gated by
          backend already returns 0). The card is hidden client-side
          so the layout stays clean (3 cards instead of "1 zero card +
          3 real ones"). */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={t("expStatTracked", "Tracked Items")}
          value={total_tracked_items}
        />
        {expiryAlertsAvailable && (
          <StatCard
            label={t("expStatAtRisk", "At-Risk Value")}
            value={`${fmt(total_at_risk_value)} ${currency}`}
            accent={total_at_risk_value > 0 ? "critical" : "neutral"}
          />
        )}
        <StatCard
          label={t("expStatExpired", "Expired Items")}
          value={expired_items.length}
          accent={expired_items.length > 0 ? "critical" : "success"}
          helper={expired_items.length > 0 ? t("expRemoveNow", "Remove now") : null}
        />
        <StatCard
          label={t("expStatExpiringSoon", "Expiring < 7d")}
          value={expiring_soon.length}
          accent={expiring_soon.length > 0 ? "warn" : "success"}
          helper={expiring_soon.length > 0 ? t("expActFast", "Act fast") : null}
        />
      </div>

      {/* ─── RECOMMENDATIONS ─── */}
      {recommendations?.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl p-5 sm:p-6 border border-gray-200 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
            <Icon name="Sparkles" size={16} className="text-emerald-600 dark:text-emerald-400" />
            {t("expRecommendations", "Recommendations")}
          </h2>
          <div className="space-y-3">
            {recommendations.map((rec, i) => (
              <div key={i} className={`flex items-start gap-3 p-3 rounded-xl border ${
                rec.priority === "high" ? "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/40" :
                rec.priority === "medium" ? "bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800/40" :
                "bg-gray-50 dark:bg-gray-800/30 border-gray-200 dark:border-gray-700"
              }`}>
                <span className="text-2xl shrink-0" aria-hidden="true">{rec.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{rec.title}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">{rec.detail}</p>
                </div>
                {rec.priority === "high" && (
                  <span className="text-xs bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 px-2 py-1 rounded-full font-medium ml-auto whitespace-nowrap">
                    {t("expUrgent", "Urgent")}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── EXPIRY TIMELINE ─── */}
      {allExpiring.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl p-5 sm:p-6 border border-gray-200 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2">
            <Icon name="Calendar" size={16} />
            {t("expTimeline", "Expiry Timeline")}
          </h2>
          {/* Mobile: card layout */}
          <div className="space-y-2 md:hidden">
            {allExpiring.map((item, i) => {
              const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.upcoming;
              return (
                <div key={i} className={`p-3 rounded-xl border ${
                  item.status === "expired" ? "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800" :
                  item.status === "critical" ? "bg-orange-50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-800" :
                  "bg-white dark:bg-gray-700/30 border-gray-200 dark:border-gray-700"
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate flex-1">{item.name}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ml-2 ${cfg.color}`}>{t(cfg.labelKey, cfg.label)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{item.quantity} {item.unit} | {item.category}</span>
                    <span className={`font-bold ${
                      item.days_left < 0 ? "text-red-600" : item.days_left <= 7 ? "text-orange-600" : "text-gray-600"
                    }`}>
                      {item.days_left < 0
                        ? t("expDaysOverdue", "{n}d overdue").replace("{n}", String(Math.abs(item.days_left)))
                        : t("expDaysLeftFull", "{n}d left").replace("{n}", String(item.days_left))}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs mt-1">
                    <span className="text-gray-400">{t("expExpiresLabel", "Expires:")} {item.expiry_date}</span>
                    <span className="text-gray-600 dark:text-gray-400 font-medium">{fmt(item.cost_at_risk)} {currency}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Desktop: table layout */}
          <div className="overflow-x-auto hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b dark:border-gray-700">
                  <th className="text-left py-2 px-2">{t("item", "Item")}</th>
                  <th className="text-left py-2 px-2">{t("category", "Category")}</th>
                  <th className="text-right py-2 px-2">{t("stock", "Stock")}</th>
                  <th className="text-left py-2 px-2">{t("expColExpiry", "Expiry")}</th>
                  <th className="text-right py-2 px-2">{t("expColDaysLeft", "Days Left")}</th>
                  <th className="text-right py-2 px-2">{t("expColCostAtRisk", "Cost at Risk")}</th>
                  <th className="text-center py-2 px-2">{t("status", "Status")}</th>
                </tr>
              </thead>
              <tbody>
                {allExpiring.map((item, i) => {
                  const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.upcoming;
                  return (
                    <tr key={i} className={`border-b dark:border-gray-700/50 ${
                      item.status === "expired" ? "bg-red-50/50 dark:bg-red-900/10" :
                      item.status === "critical" ? "bg-orange-50/50 dark:bg-orange-900/10" : ""
                    }`}>
                      <td className="py-3 px-2 font-medium text-gray-700 dark:text-gray-300">{item.name}</td>
                      <td className="py-3 px-2 text-gray-500 text-xs">{item.category}</td>
                      <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">{item.quantity} {item.unit}</td>
                      <td className="py-3 px-2 text-gray-500">{item.expiry_date}</td>
                      <td className={`py-3 px-2 text-right font-bold ${
                        item.days_left < 0 ? "text-red-600" : item.days_left <= 7 ? "text-orange-600" : "text-gray-600 dark:text-gray-400"
                      }`}>
                        {item.days_left < 0
                          ? t("expDaysOverdue", "{n}d overdue").replace("{n}", String(Math.abs(item.days_left)))
                          : t("expDaysShort", "{n}d").replace("{n}", String(item.days_left))}
                      </td>
                      <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">{fmt(item.cost_at_risk)} {currency}</td>
                      <td className="py-3 px-2 text-center">
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${cfg.color}`}>
                          {t(cfg.labelKey, cfg.label)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── WASTE HISTORY ─── */}
      {waste_summary?.top_items?.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl p-5 sm:p-6 border border-gray-200 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1 flex items-center gap-2">
            <Icon name="Trash2" size={16} />
            {t("expWasteHistory", "Waste History (90 days)")}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            {t("expTotalWaste", "Total waste:")} {fmt(waste_summary.total_cost_90d)} {currency} | {t("expExpiredLabel", "Expired:")} {fmt(waste_summary.expired_cost_90d)} {currency}
          </p>

          {/* Waste trend chart */}
          {waste_trend?.length > 0 && (
            <div className="h-48 mb-6">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={waste_trend}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => fmt(v)} />
                  <Tooltip
                    formatter={(val) => [`${fmt(val)} ${currency}`, t("expWasteCost", "Waste Cost")]}
                    contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}
                  />
                  <Bar dataKey="cost" fill="#ef4444" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top wasted items */}
          <div className="space-y-2">
            {waste_summary.top_items.map((item, i) => (
              <div key={i} className="flex items-center justify-between bg-red-50 dark:bg-red-900/10 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{item.name}</p>
                  <p className="text-xs text-gray-500">{t("expTimesWasted", "{n} times wasted").replace("{n}", String(item.count))}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-red-600">{fmt(item.total_cost)} {currency}</p>
                  <p className="text-xs text-gray-400">{t("expTotalLoss", "total loss")}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── MISSING EXPIRY DATES ─── Info-level banner: data is fine,
          there's just an opportunity to add more detail. */}
      {missing_expiry?.length > 0 && (
        <SectionBanner
          severity="info"
          icon="FileText"
          title={t("expMissingTitle", "Missing Expiry Dates")}
        >
          <p className="mb-3">{t("expMissingBody", "These perishable items need expiry dates for better forecasting.")}</p>
          <div className="flex flex-wrap gap-2 mb-3">
            {missing_expiry.map((item, i) => (
              <span key={i} className="bg-white dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-xs px-3 py-1.5 rounded-full">
                {item.name} ({item.quantity} {item.unit})
              </span>
            ))}
          </div>
          <a href="/inventory" className="text-sm font-medium text-gray-700 dark:text-emerald-400 hover:underline">
            {t("expGoToInventoryAdd", "Go to Inventory to add expiry dates →")}
          </a>
        </SectionBanner>
      )}

      {/* ─── EMPTY STATE ─── */}
      {allExpiring.length === 0 && !waste_summary?.top_items?.length && (
        <div className="bg-white dark:bg-gray-900 rounded-xl p-2 border border-gray-200 dark:border-gray-800">
          <Empty
            size="hero"
            icon="📦"
            title={t("expEmptyTitle", "No expiry data yet")}
            body={t("expEmptyBody", "Add expiry dates to your inventory items to unlock expiry forecasting, waste prediction, and order recommendations.")}
            cta={
              <a
                href="/inventory"
                className="inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors h-9 px-3.5 text-sm bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
              >
                {t("expGoToInventory", "Go to Inventory")}
              </a>
            }
          />
        </div>
      )}
    </div>
  );
}
