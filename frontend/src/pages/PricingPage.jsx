// Task #120 polish (Agent E): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useState, useEffect, useCallback } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";
import SmartPricingCard from "../components/SmartPricingCard";
import { PageHeader, StatCard, SectionBanner, Button } from "../components/ui";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }
function pct(n) { return n != null ? `${n.toFixed(1)}%` : "\u2014"; }

const MARGIN_COLORS = { high: "#10b981", mid: "#f59e0b", low: "#ef4444" };

function marginColor(m) {
  if (m >= 50) return MARGIN_COLORS.high;
  if (m >= 30) return MARGIN_COLORS.mid;
  return MARGIN_COLORS.low;
}

export default function PricingPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [data, setData] = useState(null);
  const [sim, setSim] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sliderVal, setSliderVal] = useState(5);
  // Smart Pricing — Day-1 wow moment. Loaded in parallel with /pricing/insights
  // so an empty Pricing page (new tenant with no sales) still has something to
  // show. See backend/app/services/smart_pricing.py for the privacy gate that
  // governs which comparisons render.
  const [marketData, setMarketData] = useState(null);
  const [marketLoading, setMarketLoading] = useState(true);

  const fetchInsights = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/pricing/insights");
      setData(res.data);
    } catch { setError("Could not load pricing data"); }
    setLoading(false);
  }, []);

  const fetchMarket = useCallback(async () => {
    setMarketLoading(true);
    try {
      const res = await api.get("/smart-pricing/all");
      setMarketData(res.data);
    } catch {
      // Soft-fail — the Market Comparison section just hides.
      setMarketData(null);
    }
    setMarketLoading(false);
  }, []);

  useEffect(() => { fetchInsights(); fetchMarket(); }, [fetchInsights, fetchMarket]);

  const runSimulation = useCallback(async (amount) => {
    try {
      const res = await api.get(`/pricing/simulate?increase=${amount}`);
      setSim(res.data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => runSimulation(sliderVal), 300);
    return () => clearTimeout(timer);
  }, [sliderVal, runSimulation]);

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">💰</div>
          <p className="text-gray-500 dark:text-gray-400">Analyzing pricing...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <div className="text-4xl mb-4">💰</div>
        <p className="text-red-500">{error}</p>
        <Button variant="secondary" onClick={fetchInsights} className="mt-4">
          Try again
        </Button>
      </div>
    );
  }

  const {
    avg_ticket, prev_avg_ticket, ticket_change, ticket_trend,
    daily_volume, monthly_revenue, total_transactions,
    top_items, low_margin_items, no_sales_items, alerts,
  } = data;

  const trendIcon = ticket_trend === "up" ? "📈" : ticket_trend === "down" ? "📉" : "➡️";
  const trendColor = ticket_trend === "up" ? "text-green-600" : ticket_trend === "down" ? "text-red-600" : "text-gray-500";

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <FadeIn>
        <PageHeader
          eyebrow="INTEL"
          title={t("priceOptimization") || "Price Optimization"}
          subtitle={t("pricingSubtitle") || "Find under-priced items, simulate increases, and benchmark against your neighborhood."}
        />
      </FadeIn>

      {/* ─── MARKET COMPARISON (Smart Pricing, Task #64) ─── */}
      {/* Lives at the top: Day-1 owners see this BEFORE any sales-derived
          insights below. Soft-fail: if marketData is null we just hide. */}
      <SmartPricingSection
        data={marketData}
        loading={marketLoading}
        currencyCode={user?.currency}
      />

      {/* ─── ALERTS ─── */}
      {alerts?.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => {
            const severity = alert.severity === "warning" ? "warn"
              : alert.severity === "positive" ? "success"
              : "info";
            return (
              <SectionBanner
                key={i}
                severity={severity}
                title={alert.title}
              >
                <p>{alert.detail}</p>
                {alert.action && (
                  <p className="text-xs mt-2 font-medium">{alert.action}</p>
                )}
              </SectionBanner>
            );
          })}
        </div>
      )}

      {/* ─── KEY METRICS ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Avg Ticket"
          value={`${fmt(avg_ticket)} ${currency}`}
          helper={`${trendIcon} ${ticket_change > 0 ? "+" : ""}${fmt(ticket_change)}`}
          accent={ticket_trend === "up" ? "success" : ticket_trend === "down" ? "critical" : "neutral"}
        />
        <StatCard
          label="Previous Period"
          value={`${fmt(prev_avg_ticket)} ${currency}`}
          helper="Last 30 days"
        />
        <StatCard
          label="Daily Volume"
          value={daily_volume}
          helper="transactions/day"
        />
        <StatCard
          label="Monthly Revenue"
          value={`${fmt(monthly_revenue)} ${currency}`}
          helper={`${total_transactions} transactions`}
        />
      </div>

      {/* ─── PRICE SIMULATOR ─── */}
      <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-6 text-white shadow-lg">
        <h2 className="font-bold text-lg mb-1">🎛️ Price Simulator</h2>
        <p className="text-sm opacity-80 mb-4">See how a small price increase per transaction impacts revenue</p>

        <div className="flex items-center gap-4 mb-4">
          <input
            type="range"
            min={1}
            max={50}
            value={sliderVal}
            onChange={(e) => setSliderVal(Number(e.target.value))}
            className="flex-1 h-2 bg-white/30 rounded-full appearance-none cursor-pointer accent-white"
          />
          <span className="text-2xl font-bold min-w-[80px] text-right">
            +{sliderVal} {currency}
          </span>
        </div>

        {sim && (
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white/10 rounded-xl p-3 sm:p-4 text-center">
              <p className="text-xs opacity-70">Monthly Impact</p>
              <p className="text-xl sm:text-3xl font-bold mt-1">+{fmt(sim.monthly_impact)}</p>
              <p className="text-xs opacity-70 mt-1">{currency}/month</p>
            </div>
            <div className="bg-white/10 rounded-xl p-3 sm:p-4 text-center">
              <p className="text-xs opacity-70">Annual Impact</p>
              <p className="text-xl sm:text-3xl font-bold mt-1">+{fmt(sim.annual_impact)}</p>
              <p className="text-xs opacity-70 mt-1">{currency}/year</p>
            </div>
          </div>
        )}
        <p className="text-xs opacity-60 mt-3">
          Based on {sim?.daily_volume || daily_volume} daily transactions. Assumes no volume change.
        </p>
      </div>

      {/* ─── TOP ITEMS MARGIN CHART ─── */}
      {top_items?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">📊 Item Margins</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={top_items.slice(0, 10)} layout="vertical" margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(val, name) => {
                    if (name === "margin_pct") return [`${val.toFixed(1)}%`, "Margin"];
                    return [val, name];
                  }}
                  contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 4px 12px rgba(0,0,0,0.1)" }}
                />
                <Bar dataKey="margin_pct" radius={[0, 6, 6, 0]} barSize={20}>
                  {top_items.slice(0, 10).map((item, i) => (
                    <Cell key={i} fill={marginColor(item.margin_pct)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 mt-3 justify-center text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-500 inline-block" /> 50%+</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-yellow-500 inline-block" /> 30-50%</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-500 inline-block" /> &lt;30%</span>
          </div>
        </div>
      )}

      {/* ─── TOP ITEMS TABLE ─── */}
      {top_items?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">🏆 Top Items by Revenue</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b dark:border-gray-700">
                  <th className="text-left py-2 px-2">Item</th>
                  <th className="text-right py-2 px-2">Qty Sold</th>
                  <th className="text-right py-2 px-2">Revenue</th>
                  <th className="text-right py-2 px-2">Avg Price</th>
                  <th className="text-right py-2 px-2">Avg Cost</th>
                  <th className="text-right py-2 px-2">Margin</th>
                </tr>
              </thead>
              <tbody>
                {top_items.map((item, i) => (
                  <tr key={i} className="border-b dark:border-gray-700/50">
                    <td className="py-3 px-2 font-medium text-gray-700 dark:text-gray-300">{item.name}</td>
                    <td className="py-3 px-2 text-right text-gray-500">{item.qty_sold}</td>
                    <td className="py-3 px-2 text-right text-gray-600 dark:text-gray-400">{fmt(item.revenue)} {currency}</td>
                    <td className="py-3 px-2 text-right text-gray-500">{fmt(item.avg_price)}</td>
                    <td className="py-3 px-2 text-right text-gray-500">{fmt(item.avg_cost)}</td>
                    <td className="py-3 px-2 text-right">
                      <span className={`text-xs px-2 py-1 rounded-full font-bold ${
                        item.margin_pct >= 50 ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" :
                        item.margin_pct >= 30 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" :
                        "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                      }`}>
                        {pct(item.margin_pct)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── LOW MARGIN WARNING ─── */}
      {low_margin_items?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-yellow-500">
          <h2 className="font-bold text-gray-800 dark:text-white mb-2">⚠️ Low Margin Items (&lt;30%)</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            These items are selling but margins are thin. Consider price adjustments or supplier renegotiation.
          </p>
          <div className="space-y-2">
            {low_margin_items.map((item, i) => (
              <div key={i} className="flex items-center justify-between bg-yellow-50 dark:bg-yellow-900/10 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{item.name}</p>
                  <p className="text-xs text-gray-500">Price: {fmt(item.avg_price)} {currency} | Cost: {fmt(item.avg_cost)} {currency}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-red-600">{pct(item.margin_pct)}</p>
                  <p className="text-xs text-gray-400">{fmt(item.revenue)} {currency} revenue</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── NO SALES ITEMS (dead stock pricing) ─── */}
      {no_sales_items?.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-blue-500">
          <h2 className="font-bold text-gray-800 dark:text-white mb-2">🏷️ No Sales This Month</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            These items are in stock but had zero sales in the last 30 days. Consider a sale, bundle, or discontinuation.
          </p>
          <div className="space-y-2">
            {no_sales_items.map((item, i) => (
              <div key={i} className="flex items-center justify-between bg-blue-50 dark:bg-blue-900/10 rounded-xl px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{item.name}</p>
                  <p className="text-xs text-gray-500">Stock: {item.stock} | Cost: {fmt(item.cost)} {currency}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-blue-600">{fmt(item.sell_price)} {currency}</p>
                  <p className="text-xs text-gray-400">sell price</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── EMPTY STATE ─── */}
      {!top_items?.length && !low_margin_items?.length && !no_sales_items?.length && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 shadow-sm text-center">
          <div className="text-5xl mb-3">📊</div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-2">No item-level data yet</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            Start logging sales with item names and costs to unlock margin analysis, price recommendations, and more.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Market Comparison section — top of PricingPage.
 *
 * Renders an empty-state hint when:
 *   • marketLoading=true → skeleton
 *   • marketData=null or undefined → silently hide (soft-fail)
 *   • needs_setup=true → owner hasn't set postal/cuisine yet
 *   • no comparisons at all → hide (nothing priced yet)
 *
 * When there ARE comparisons, render a grid of SmartPricingCard plus a
 * privacy footnote. The cards individually handle their own "not enough
 * data" empty state — so the section is a thin layout shell.
 */
function SmartPricingSection({ data, loading, currencyCode }) {
  const { t } = useLanguage();

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 shadow-sm animate-pulse">
        <div className="h-4 w-48 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="h-32 bg-gray-100 dark:bg-gray-700/50 rounded-xl" />
          <div className="h-32 bg-gray-100 dark:bg-gray-700/50 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!data) return null;

  if (data.needs_setup) {
    return (
      <SectionBanner
        severity="info"
        icon="Globe"
        title={t("smartPricingTitle") || "Market comparison"}
      >
        {t("smartPricingNeedsSetup") || "Set your postal code and cuisine in Profile to unlock neighborhood price comparisons."}
      </SectionBanner>
    );
  }

  const comparisons = data.comparisons || [];
  if (comparisons.length === 0) return null;

  const privacyNote = (t("smartPricingPrivacyNote") ||
    "All comparisons aggregate at least {n} businesses. We never show individual prices.")
    .replace("{n}", comparisons[0]?.min_samples || 5);

  return (
    <div>
      <div className="mb-3">
        <h2 className="text-lg font-bold text-gray-800 dark:text-white">
          🌍 {t("smartPricingTitle") || "Market comparison"}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("smartPricingSubtitle") || "How your prices compare to neighborhood businesses."}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {comparisons.map((cmp) => (
          <SmartPricingCard
            key={cmp.canonical_name}
            comparison={cmp}
            currencyCode={currencyCode}
          />
        ))}
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500 italic mt-2">{privacyNote}</p>
    </div>
  );
}
