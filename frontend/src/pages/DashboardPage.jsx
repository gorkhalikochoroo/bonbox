import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import ReceiptCapture from "../components/ReceiptCapture";
import Onboarding from "../components/Onboarding";
import {
  AnimatedCounter,
  SkeletonCard,
  SkeletonChart,
  useToast,
  useKeyboardShortcuts,
  ShortcutsHelp,
  QuickSaleModal,
  PullToRefresh,
} from "../components/BonBoxPolishKit";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area,
  BarChart, Bar, Cell, ReferenceLine,
} from "recharts";
import { displayCurrency } from "../utils/currency";
import { formatDateShort } from "../utils/dateFormat";

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */

const PERIODS = ["today", "thisWeek", "thisMonth", "last30"];

function getDateRange(period) {
  const now = new Date();
  const fmt = (d) => d.toISOString().split("T")[0];
  const today = fmt(now);
  switch (period) {
    case "today": return { from: today, to: today };
    case "thisWeek": { const d = new Date(now); d.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1)); return { from: fmt(d), to: today }; }
    case "thisMonth": return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case "last30": { const d = new Date(now); d.setDate(d.getDate() - 30); return { from: fmt(d), to: today }; }
    default: return { from: "", to: "" };
  }
}

/* ═══════════════════════════════════════════════════════════
   MINI SPARKLINE — tiny inline chart for KPI cards
   ═══════════════════════════════════════════════════════════ */

function MiniSparkline({ data, color = "#22C55E", height = 32 }) {
  if (!data || data.length < 2) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data.map((v, i) => ({ v, i }))}>
        <defs>
          <linearGradient id={`spark-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#spark-${color.replace("#", "")})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ═══════════════════════════════════════════════════════════
   KPI CARD — polished card with sparkline + change indicator
   ═══════════════════════════════════════════════════════════ */

function KpiCard({ title, numericValue, value, currency: cur, change, changeLabel, subtitle, alert, sparkData, onClick, highlight }) {
  const isPositive = change >= 0;
  const showChange = change !== undefined && change !== null && Math.abs(change) <= 500;
  const isNew = change !== undefined && (change === -100 || Math.abs(change) > 500);

  return (
    <button
      onClick={onClick}
      className={`relative overflow-hidden rounded-2xl p-4 sm:p-5 text-left w-full transition-all duration-200 cursor-pointer group
        hover:scale-[1.02] hover:shadow-lg active:scale-[0.98]
        ${highlight
          ? "bg-gradient-to-br from-green-500/10 to-emerald-500/5 dark:from-green-500/15 dark:to-emerald-500/5 border-2 border-green-400/30 dark:border-green-500/20"
          : alert
            ? "bg-white dark:bg-gray-800 border-2 border-red-300/50 dark:border-red-500/30"
            : "bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/60"
        } shadow-sm`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{title}</p>
        <svg className="w-4 h-4 text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </div>

      <div className="flex items-baseline gap-1.5 mt-2">
        <span className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
          {numericValue !== undefined ? <AnimatedCounter value={numericValue} /> : value}
        </span>
        {cur && <span className="text-sm font-medium text-gray-400 dark:text-gray-500">{cur}</span>}
      </div>

      <div className="flex items-center gap-2 mt-2">
        {showChange && (
          <span className={`inline-flex items-center gap-0.5 text-xs font-semibold px-1.5 py-0.5 rounded-md
            ${isPositive
              ? "text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30"
              : "text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-900/30"
            }`}>
            {isPositive ? "▲" : "▼"} {Math.abs(change)}%
          </span>
        )}
        {isNew && <span className="text-xs text-blue-500 dark:text-blue-400 font-medium">New day ✨</span>}
        {changeLabel && <span className="text-xs text-gray-400 dark:text-gray-500">{changeLabel}</span>}
        {subtitle && !changeLabel && <span className="text-xs text-gray-400 dark:text-gray-500">{subtitle}</span>}
      </div>

      {/* Sparkline */}
      {sparkData && sparkData.length > 1 && (
        <div className="mt-2 -mx-1">
          <MiniSparkline data={sparkData} color={isPositive || change === undefined ? "#22C55E" : "#EF4444"} height={28} />
        </div>
      )}
    </button>
  );
}

/* ═══════════════════════════════════════════════════════════
   REVENUE TREND — gradient filled line with avg reference
   ═══════════════════════════════════════════════════════════ */

function RevenueTrendChart({ data, currency, onNavigate }) {
  if (!data || data.length === 0) return null;
  const avg = Math.round(data.reduce((s, d) => s + d.amount, 0) / data.length);

  return (
    <div
      onClick={onNavigate}
      className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Revenue Trend</h3>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Daily revenue with average reference</p>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-green-500 rounded-full inline-block" /> Daily
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0 border-t border-dashed border-gray-400 inline-block" style={{ width: 12 }} /> Avg {avg.toLocaleString()}
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22C55E" stopOpacity={0.15} />
              <stop offset="100%" stopColor="#22C55E" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(156,163,175,0.15)" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#9CA3AF" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "#9CA3AF" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip
            contentStyle={{ background: "rgba(17,24,39,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, color: "#f1f1f1", fontSize: 13 }}
            formatter={(v) => [`${v.toLocaleString()} ${currency}`, "Revenue"]}
          />
          <ReferenceLine y={avg} stroke="rgba(156,163,175,0.4)" strokeDasharray="5 5" />
          <Area type="monotone" dataKey="amount" stroke="#22C55E" strokeWidth={2} fill="url(#revenueGrad)" dot={false} activeDot={{ r: 4, fill: "#22C55E" }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   UNIFIED FORECAST + WEATHER + STAFFING — the killer panel
   ═══════════════════════════════════════════════════════════ */

const WEATHER_ICONS = { clear: "☀️", cloudy: "☁️", rain: "🌧️", drizzle: "🌦️", snow: "❄️", storm: "⛈️", fog: "🌫️" };
const CONDITION_ICON = (c) => WEATHER_ICONS[c] || "⛅";

function ForecastWeatherStaffing({ forecast, weather, staffing, currency, onNavigate }) {
  const [sel, setSel] = useState(null);
  if (!forecast?.forecast?.length) return null;

  const data = forecast.forecast;
  const total = forecast.total_predicted || data.reduce((s, f) => s + f.predicted_revenue, 0);
  const weekendDays = ["Fri", "Sat", "Sun", "Friday", "Saturday", "Sunday"];
  const maxRev = Math.max(...data.map((f) => f.predicted_revenue));

  // Match weather/staffing by day index
  const weatherDays = weather?.days || [];
  const staffDays = staffing?.recommendations || [];

  const selected = sel !== null ? data[sel] : null;
  const selWeather = sel !== null ? weatherDays[sel] : null;
  const selStaff = sel !== null ? staffDays[sel] : null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700/60 shadow-sm overflow-hidden">
      {/* Header + Bars */}
      <div className="p-5 sm:p-6 pb-0">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Revenue Forecast</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              Next 7 days &bull; {forecast.confidence || 95}% confidence
              &bull; {forecast.trend_direction === "up" ? "📈 Up" : forecast.trend_direction === "down" ? "📉 Down" : "📊 Stable"}
            </p>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{total.toLocaleString()} {currency}</p>
          </div>
        </div>

        {/* Interactive bars */}
        <div className="flex items-end gap-1.5 sm:gap-2 mt-4" style={{ height: 100 }}>
          {data.map((f, i) => {
            const isActive = sel === i;
            const isWeekend = weekendDays.some((d) => f.day?.startsWith(d));
            const barH = maxRev > 0 ? (f.predicted_revenue / maxRev) * 85 : 10;
            return (
              <div key={i} onClick={() => setSel(isActive ? null : i)}
                className="flex-1 flex flex-col items-center gap-1 cursor-pointer group">
                <span className={`text-[10px] font-medium transition-colors ${isActive ? "text-white dark:text-white" : "text-gray-400"}`}>
                  {(f.predicted_revenue / 1000).toFixed(1)}k
                </span>
                <div
                  className="w-full rounded-t-md transition-all duration-200"
                  style={{
                    height: barH,
                    background: isActive ? "#3B82F6" : isWeekend ? "rgba(59,130,246,0.6)" : "rgba(59,130,246,0.25)",
                    boxShadow: isActive ? "0 -4px 14px rgba(59,130,246,0.3)" : "none",
                    transform: isActive ? "scaleY(1.05)" : "scaleY(1)",
                    transformOrigin: "bottom",
                  }}
                />
                <span className={`text-[11px] font-medium ${isActive ? "text-blue-400" : isWeekend ? "text-blue-500 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`}>
                  {(f.day || "").slice(0, 3)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Weather row */}
      {weatherDays.length > 0 && (
        <div className="px-5 sm:px-6 py-2 border-t border-gray-100 dark:border-gray-700/40">
          <div className="flex gap-1">
            {weatherDays.slice(0, 7).map((w, i) => {
              const isActive = sel === i;
              const temp = Math.round(w.temp_max || w.temp || 0);
              return (
                <div key={i} onClick={() => setSel(isActive ? null : i)}
                  className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-lg cursor-pointer transition ${isActive ? "bg-gray-100 dark:bg-gray-700/40" : ""}`}>
                  <span className="text-sm">{CONDITION_ICON(w.condition)}</span>
                  <span className={`text-[11px] font-semibold ${temp >= 14 ? "text-green-500" : temp <= 8 ? "text-blue-400" : "text-gray-300"}`}>{temp}°</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Staffing row */}
      {staffDays.length > 0 && (
        <div className="px-5 sm:px-6 py-2.5 border-t border-gray-100 dark:border-gray-700/40">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">Smart Staffing</span>
            <span className="text-[10px] text-gray-400">Recommended headcount</span>
          </div>
          <div className="flex gap-1">
            {staffDays.slice(0, 7).map((s, i) => {
              const isActive = sel === i;
              const level = s.business_level || "Normal";
              const color = level === "Busy" ? "#EF4444" : level === "Normal" ? "#F59E0B" : "#3B82F6";
              return (
                <div key={i} onClick={() => setSel(isActive ? null : i)}
                  className={`flex-1 flex flex-col items-center gap-1 py-1.5 rounded-lg cursor-pointer transition ${isActive ? "bg-gray-100 dark:bg-gray-700/40" : ""}`}>
                  <div className="flex flex-col items-center gap-0.5">
                    {Array.from({ length: s.recommended_staff || 3 }, (_, j) => (
                      <div key={j} className="w-1.5 h-1.5 rounded-full" style={{ background: color, opacity: 0.5 + (j / (s.recommended_staff || 3)) * 0.5 }} />
                    ))}
                  </div>
                  <span className="text-[11px] font-bold" style={{ color }}>{s.recommended_staff || 3}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Detail panel when a day is selected */}
      {selected && (
        <div className="px-5 sm:px-6 py-3 border-t border-gray-100 dark:border-gray-700/40 bg-gray-50/50 dark:bg-gray-700/10">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-gray-800 dark:text-white">{selected.day}</span>
              {selWeather && <span className="text-sm">{CONDITION_ICON(selWeather.condition)} {Math.round(selWeather.temp_max || 0)}°</span>}
            </div>
            {selStaff && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase"
                style={{
                  background: selStaff.business_level === "Busy" ? "rgba(239,68,68,0.1)" : "rgba(59,130,246,0.1)",
                  color: selStaff.business_level === "Busy" ? "#EF4444" : "#3B82F6",
                }}>{selStaff.business_level || "Normal"}</span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[10px] text-gray-400">Revenue</p>
              <p className="text-sm font-bold text-gray-800 dark:text-white">{selected.predicted_revenue.toLocaleString()}</p>
            </div>
            {selStaff && (
              <div>
                <p className="text-[10px] text-gray-400">Staff</p>
                <p className="text-sm font-bold text-blue-500">{selStaff.recommended_staff} ppl</p>
              </div>
            )}
            {selWeather && (
              <div>
                <p className="text-[10px] text-gray-400">Precip</p>
                <p className="text-sm font-bold text-gray-600 dark:text-gray-300">{selWeather.precipitation || 0}mm</p>
              </div>
            )}
          </div>
        </div>
      )}

      {!selected && (
        <div className="px-5 sm:px-6 py-2 border-t border-gray-100 dark:border-gray-700/40">
          <p className="text-center text-[11px] text-gray-400 py-1 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer" onClick={onNavigate}>
            Tap any day for details &bull; View full forecast →
          </p>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   INVENTORY PANEL — with days-left, expiry, reorder
   ═══════════════════════════════════════════════════════════ */

function InventoryPanel({ items, currency, onNavigate }) {
  const [filter, setFilter] = useState("all");
  if (!items || items.length === 0) return null;

  // Process items
  const processed = items.map((it) => {
    const qty = parseFloat(it.quantity) || 0;
    const min = parseFloat(it.min_threshold) || 0;
    const cost = parseFloat(it.cost_per_unit) || 0;
    const isLow = qty <= min;
    const stockPct = min > 0 ? (qty / (min * 2)) * 100 : 100;
    // Expiry
    let daysToExpiry = 999;
    if (it.expiry_date) {
      const exp = new Date(it.expiry_date);
      daysToExpiry = Math.ceil((exp - new Date()) / 86400000);
    }
    const isExpiring = daysToExpiry <= 3;
    const urgency = isLow ? (qty <= min * 0.5 ? 3 : 2) : isExpiring ? 2 : 0;
    const status = urgency >= 2 ? "critical" : isLow || isExpiring ? "warning" : "ok";
    return { ...it, qty, min, cost, isLow, stockPct, daysToExpiry, isExpiring, urgency, status };
  });

  let list = [...processed];
  if (filter === "low") list = list.filter((i) => i.isLow);
  if (filter === "exp") list = list.filter((i) => i.isExpiring);
  list.sort((a, b) => b.urgency - a.urgency || a.qty - b.qty);

  const lowCount = processed.filter((i) => i.isLow).length;
  const expCount = processed.filter((i) => i.isExpiring).length;
  const totalValue = Math.round(processed.reduce((s, i) => s + i.qty * i.cost, 0));

  const statusStyles = {
    critical: "bg-red-50 dark:bg-red-900/10 border-red-200/60 dark:border-red-800/30",
    warning: "bg-amber-50 dark:bg-amber-900/10 border-amber-200/60 dark:border-amber-800/30",
    ok: "bg-transparent border-gray-100 dark:border-gray-700/40",
  };
  const barColors = { critical: "#EF4444", warning: "#F59E0B", ok: "#22C55E" };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Inventory</h3>
          <p className="text-xs text-gray-400 mt-0.5">{items.length} items</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold text-gray-800 dark:text-white">{totalValue.toLocaleString()}</p>
          <p className="text-[10px] text-gray-400">{currency} stock value</p>
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex gap-1.5 mb-3">
        {[
          { k: "all", label: `All (${items.length})`, color: "#3B82F6" },
          { k: "low", label: `Low (${lowCount})`, color: "#EF4444" },
          { k: "exp", label: `Expiring (${expCount})`, color: "#F59E0B" },
        ].map((f) => (
          <button key={f.k} onClick={() => setFilter(f.k)}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition
              ${filter === f.k
                ? "border-current"
                : "border-transparent bg-gray-100 dark:bg-gray-700/40 text-gray-500 dark:text-gray-400"
              }`}
            style={filter === f.k ? { color: f.color, background: `${f.color}15` } : {}}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Item list */}
      <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
        {list.slice(0, 8).map((it, i) => (
          <div key={i} className={`px-3 py-2 rounded-xl border ${statusStyles[it.status]}`}>
            <div className="flex items-center justify-between mb-1">
              <span className={`text-sm text-gray-700 dark:text-gray-200 ${it.status !== "ok" ? "font-semibold" : ""}`}>{it.name}</span>
              {it.status !== "ok" && (
                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded
                  ${it.status === "critical" ? "text-red-600 bg-red-100 dark:bg-red-900/20" : "text-amber-600 bg-amber-100 dark:bg-amber-900/20"}`}>
                  {it.status === "critical" ? "Critical" : "Low"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, it.stockPct)}%`, background: barColors[it.status] }} />
              </div>
              <span className="text-xs font-semibold min-w-[40px] text-right" style={{ color: barColors[it.status] }}>
                {it.qty} {it.unit || ""}
              </span>
            </div>
            <div className="flex gap-3 mt-1 text-[10px] text-gray-400">
              <span>Min: {it.min}</span>
              {it.daysToExpiry < 999 && (
                <span className={it.daysToExpiry <= 3 ? "text-amber-500 font-semibold" : ""}>
                  Exp: {it.daysToExpiry}d
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Reorder banner */}
      {lowCount > 0 && (
        <div className="mt-3 px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-900/10 border border-red-200/50 dark:border-red-800/30">
          <p className="text-xs font-semibold text-red-600 dark:text-red-400 mb-1">
            📦 Reorder needed ({lowCount} items)
          </p>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
            {processed.filter((i) => i.isLow).map((i) => i.name).slice(0, 4).join(", ")}
          </p>
          <button onClick={(e) => { e.stopPropagation(); onNavigate(); }}
            className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition">
            View Inventory
          </button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   DISMISSABLE ALERTS — actionable alerts with dismiss
   ═══════════════════════════════════════════════════════════ */

function AlertsPanel({ actionItems, summary, weekComparison, onNavigate }) {
  const [dismissed, setDismissed] = useState(new Set());
  const [filter, setFilter] = useState("all");

  // Build alerts from real data
  const alerts = [];

  // Action items from API
  if (actionItems?.length > 0) {
    actionItems.forEach((item) => {
      const typeMap = { restock: "critical", expiring: "warning", cost: "warning", tip: "info" };
      const iconMap = { restock: "📦", expiring: "⏰", cost: "💸", tip: "💡" };
      alerts.push({
        type: typeMap[item.type] || "info",
        icon: iconMap[item.type] || "💡",
        title: item.title,
        desc: item.detail,
        action: item.type === "restock" ? "View Inventory" : item.type === "cost" ? "Check Expenses" : "View Details",
        route: item.type === "restock" ? "/inventory" : item.type === "cost" ? "/expenses" : "/reports",
        id: `action-${item.title}`,
      });
    });
  }

  // Week comparison
  if (weekComparison && weekComparison.change_pct !== 0) {
    const up = weekComparison.change_pct > 0;
    alerts.push({
      type: up ? "success" : "warning",
      icon: up ? "📈" : "📉",
      title: `Weekly revenue ${up ? "up" : "down"} ${Math.abs(weekComparison.change_pct)}%`,
      desc: `This week: ${Math.round(weekComparison.this_week_revenue).toLocaleString()} vs last: ${Math.round(weekComparison.last_week_revenue).toLocaleString()}`,
      action: "View Reports", route: "/reports", id: "week-change",
    });
  }

  // Margin alert
  if (summary) {
    const margin = summary.profit_margin || 0;
    if (margin > 0 && margin < 15) {
      alerts.push({
        type: "warning", icon: "⚡",
        title: `Profit margin at ${margin}%`,
        desc: "Below the 15% healthy threshold. Review expense categories.",
        action: "Review Expenses", route: "/expenses", id: "margin-low",
      });
    } else if (margin >= 15) {
      alerts.push({
        type: "success", icon: "💪",
        title: `Healthy ${margin}% profit margin`,
        desc: "On track for profitability this month.",
        action: "View Reports", route: "/reports", id: "margin-ok",
      });
    }
    if (summary.inventory_alerts > 0) {
      alerts.push({
        type: "critical", icon: "📦",
        title: `${summary.inventory_alerts} items below minimum`,
        desc: "Stock levels critically low on some items.",
        action: "View Inventory", route: "/inventory", id: "inv-alerts",
      });
    }
  }

  if (alerts.length === 0) {
    alerts.push({ type: "success", icon: "✅", title: "All clear", desc: "No alerts right now.", action: "View Reports", route: "/reports", id: "all-clear" });
  }

  const visible = alerts.filter((a) => !dismissed.has(a.id) && (filter === "all" || a.type === filter || (filter === "info" && a.type === "success")));
  const critCount = alerts.filter((a) => a.type === "critical" && !dismissed.has(a.id)).length;

  const typeStyles = {
    critical: "bg-red-50 dark:bg-red-900/10 border-red-200/60 dark:border-red-800/30",
    warning: "bg-amber-50 dark:bg-amber-900/10 border-amber-200/60 dark:border-amber-800/30",
    info: "bg-blue-50 dark:bg-blue-900/10 border-blue-200/60 dark:border-blue-800/30",
    success: "bg-green-50 dark:bg-green-900/10 border-green-200/60 dark:border-green-800/30",
  };
  const typeColors = { critical: "#EF4444", warning: "#F59E0B", info: "#3B82F6", success: "#22C55E" };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Alerts</h3>
          {critCount > 0 && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-500 text-white animate-pulse">{critCount}</span>
          )}
        </div>
        <span className="text-[11px] text-gray-400">{visible.length} active</span>
      </div>

      {/* Filter pills */}
      <div className="flex gap-1.5 mb-3 overflow-x-auto">
        {[
          { k: "all", label: "All", color: "#f1f1f1" },
          { k: "critical", label: `Critical (${critCount})`, color: "#EF4444" },
          { k: "warning", label: "Warnings", color: "#F59E0B" },
          { k: "info", label: "Info", color: "#3B82F6" },
        ].map((f) => (
          <button key={f.k} onClick={() => setFilter(f.k)}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-md border whitespace-nowrap transition
              ${filter === f.k ? "border-current" : "border-transparent bg-gray-100 dark:bg-gray-700/40 text-gray-500 dark:text-gray-400"}`}
            style={filter === f.k ? { color: f.color, background: `${f.color}15` } : {}}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Alert cards */}
      <div className="space-y-2 max-h-[320px] overflow-y-auto">
        {visible.map((a) => (
          <div key={a.id} className={`px-3 py-2.5 rounded-xl border ${typeStyles[a.type]}`}>
            <div className="flex items-start gap-2">
              <span className="text-sm mt-0.5">{a.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">{a.title}</span>
                  <button onClick={() => setDismissed(new Set([...dismissed, a.id]))}
                    className="text-gray-400 hover:text-gray-600 text-sm leading-none flex-shrink-0">&times;</button>
                </div>
                <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed mb-1.5">{a.desc}</p>
                <button onClick={() => onNavigate(a.route)}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-md border transition"
                  style={{ color: typeColors[a.type], background: `${typeColors[a.type]}10`, borderColor: `${typeColors[a.type]}30` }}>
                  {a.action}
                </button>
              </div>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="text-center py-4 text-sm text-gray-400">✅ All clear — no active alerts</p>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   P&L SUMMARY — compact profit/loss card
   ═══════════════════════════════════════════════════════════ */

function PLCard({ revenue, expenses, profit, margin, currency, onNavigate }) {
  const isProfit = profit >= 0;
  return (
    <div
      onClick={onNavigate}
      className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm cursor-pointer hover:shadow-md transition-shadow flex-1"
    >
      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Profit & Loss</h3>
      <p className="text-xs text-gray-400 mt-0.5 mb-4">This month</p>

      <div className="border-b border-gray-100 dark:border-gray-700 pb-3 mb-3 space-y-2">
        <div className="flex justify-between">
          <span className="text-sm text-gray-500 dark:text-gray-400">Revenue</span>
          <span className="text-sm font-semibold text-green-600 dark:text-green-400">+{revenue.toLocaleString()} {currency}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-gray-500 dark:text-gray-400">Expenses</span>
          <span className="text-sm font-semibold text-red-500 dark:text-red-400">-{expenses.toLocaleString()} {currency}</span>
        </div>
      </div>

      <div className="flex justify-between items-baseline">
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Net Profit</span>
        <div className="text-right">
          <p className={`text-xl font-bold ${isProfit ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
            {isProfit ? "+" : ""}{profit.toLocaleString()} {currency}
          </p>
          <p className="text-xs text-gray-400">Margin: {margin}%</p>
        </div>
      </div>

      <div className={`mt-3 px-3 py-2.5 rounded-xl text-xs leading-relaxed
        ${isProfit
          ? "bg-green-50 dark:bg-green-900/15 text-green-700 dark:text-green-400 border border-green-200/50 dark:border-green-800/30"
          : "bg-red-50 dark:bg-red-900/15 text-red-600 dark:text-red-400 border border-red-200/50 dark:border-red-800/30"
        }`}>
        {isProfit
          ? "On track for profitability this month. Keep up the momentum!"
          : "Expenses are exceeding revenue. Consider reviewing your top cost categories."}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   EXPENSE BREAKDOWN — horizontal bars (replaces donut)
   ═══════════════════════════════════════════════════════════ */

const EXPENSE_COLORS = ["#EF4444", "#F59E0B", "#22C55E", "#3B82F6", "#8B5CF6", "#EC4899", "#14B8A6", "#F97316"];

function ExpenseBreakdown({ breakdown, currency, onNavigate }) {
  if (!breakdown || breakdown.length === 0) return null;

  const total = breakdown.reduce((s, e) => s + e.amount, 0);
  const sorted = [...breakdown].sort((a, b) => b.amount - a.amount);
  const maxAmount = sorted[0]?.amount || 1;

  return (
    <div
      onClick={onNavigate}
      className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm cursor-pointer hover:shadow-md transition-shadow flex-1"
    >
      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Expense Breakdown</h3>
      <p className="text-xs text-gray-400 mt-0.5 mb-4">This month by category</p>

      <div className="space-y-3">
        {sorted.slice(0, 6).map((e, i) => {
          const pct = total > 0 ? Math.round((e.amount / total) * 100) : 0;
          const barWidth = Math.max((e.amount / maxAmount) * 100, 4);
          const color = EXPENSE_COLORS[i % EXPENSE_COLORS.length];
          return (
            <div key={i}>
              <div className="flex justify-between items-baseline mb-1">
                <span className="text-sm text-gray-700 dark:text-gray-200">{e.category}</span>
                <span className="text-sm text-gray-400">
                  {Math.round(e.amount).toLocaleString()} {currency} &middot; {pct}%
                </span>
              </div>
              <div className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${barWidth}%`, background: color }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {total > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 flex justify-between">
          <span className="text-sm text-gray-500 dark:text-gray-400">Total</span>
          <span className="text-sm font-bold text-gray-700 dark:text-gray-200">{Math.round(total).toLocaleString()} {currency}</span>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TOP SELLERS — full-width with Qty / Revenue toggle + bars
   ═══════════════════════════════════════════════════════════ */

const TOP_BAR_COLORS = ["#22C55E", "#3B82F6", "#8B5CF6", "#F59E0B", "#EF4444", "#EC4899", "#14B8A6", "#F97316"];

function TopSellersCard({ topSellers, currency, onNavigate }) {
  const [mode, setMode] = useState("revenue"); // "revenue" | "qty"
  if (!topSellers || topSellers.length === 0) return null;

  const medals = ["🥇", "🥈", "🥉"];

  const sorted = [...topSellers].sort((a, b) =>
    mode === "revenue" ? b.revenue - a.revenue : b.sales - a.sales
  );
  const maxVal = mode === "revenue"
    ? Math.max(...sorted.map((s) => s.revenue), 1)
    : Math.max(...sorted.map((s) => s.sales), 1);
  const totalRev = topSellers.reduce((s, i) => s + i.revenue, 0);
  const totalQty = topSellers.reduce((s, i) => s + i.sales, 0);

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
      onClick={onNavigate}
    >
      {/* Header with toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Top Sellers</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            {topSellers.length} products &bull; {mode === "revenue" ? `${totalRev.toLocaleString()} ${currency}` : `${totalQty.toLocaleString()} sold`}
          </p>
        </div>
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700/50 rounded-lg p-0.5">
          {[
            { k: "revenue", label: `Revenue (${currency})` },
            { k: "qty", label: "Qty Sold" },
          ].map((opt) => (
            <button
              key={opt.k}
              onClick={(e) => { e.stopPropagation(); setMode(opt.k); }}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-all
                ${mode === opt.k
                  ? "bg-white dark:bg-gray-600 text-gray-800 dark:text-white shadow-sm"
                  : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Items with horizontal bars */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {sorted.slice(0, 8).map((item, i) => {
          const val = mode === "revenue" ? item.revenue : item.sales;
          const barW = Math.max((val / maxVal) * 100, 4);
          const color = TOP_BAR_COLORS[i % TOP_BAR_COLORS.length];
          return (
            <div key={i} className="flex items-center gap-3">
              <span className="text-sm w-6 text-center flex-shrink-0">{medals[i] || <span className="text-xs text-gray-400 font-medium">{i + 1}</span>}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">{item.name}</span>
                  <span className="text-sm font-bold flex-shrink-0 ml-2" style={{ color }}>
                    {mode === "revenue" ? `${item.revenue.toLocaleString()}` : item.sales}
                  </span>
                </div>
                <div className="h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${barW}%`, background: color }} />
                </div>
                {mode === "revenue" ? (
                  <span className="text-[10px] text-gray-400 mt-0.5 block">{item.sales} sold</span>
                ) : (
                  <span className="text-[10px] text-gray-400 mt-0.5 block">{item.revenue.toLocaleString()} {currency}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   PAYMENT METHODS — horizontal bar summary
   ═══════════════════════════════════════════════════════════ */

function PaymentBreakdownCard({ paymentBreakdown, currency, onNavigate }) {
  if (!paymentBreakdown || paymentBreakdown.length === 0) return null;
  const total = paymentBreakdown.reduce((s, p) => s + p.amount, 0);
  const methodColors = { cash: "#22C55E", card: "#3B82F6", mobilepay: "#8B5CF6" };

  return (
    <div
      onClick={onNavigate}
      className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm cursor-pointer hover:shadow-md transition-shadow flex-1"
    >
      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Payment Methods</h3>
      <p className="text-xs text-gray-400 mt-0.5 mb-4">This month</p>

      {/* Stacked bar */}
      {total > 0 && (
        <div className="flex h-3 rounded-full overflow-hidden mb-4">
          {paymentBreakdown.sort((a, b) => b.amount - a.amount).map((p, i) => (
            <div
              key={i}
              className="h-full transition-all duration-500"
              style={{ width: `${(p.amount / total) * 100}%`, background: methodColors[p.method] || "#9CA3AF" }}
            />
          ))}
        </div>
      )}

      <div className="space-y-2">
        {paymentBreakdown.sort((a, b) => b.amount - a.amount).map((p) => {
          const pct = total > 0 ? Math.round((p.amount / total) * 100) : 0;
          const color = methodColors[p.method] || "#9CA3AF";
          const label = p.method.charAt(0).toUpperCase() + p.method.slice(1);
          return (
            <div key={p.method} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                <span className="text-sm text-gray-700 dark:text-gray-200">{label}</span>
                <span className="text-xs text-gray-400">{p.count} sales</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">{Math.round(p.amount).toLocaleString()}</span>
                <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   WEEK COMPARISON — clean side-by-side
   ═══════════════════════════════════════════════════════════ */

function WeekComparisonCard({ weekComparison, currency, onNavigate }) {
  if (!weekComparison) return null;

  const rows = [
    { label: "Revenue", thisWeek: weekComparison.this_week_revenue, lastWeek: weekComparison.last_week_revenue, goodUp: true },
    { label: "Expenses", thisWeek: weekComparison.this_week_expenses, lastWeek: weekComparison.last_week_expenses, goodUp: false },
    { label: "Profit", thisWeek: weekComparison.this_week_profit, lastWeek: weekComparison.last_week_profit, goodUp: true },
  ];

  return (
    <div
      onClick={onNavigate}
      className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
    >
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Week vs Last Week</h3>
          <p className="text-xs text-gray-400 mt-0.5">Performance comparison</p>
        </div>
        {weekComparison.change_pct !== 0 && (
          <span className={`text-sm font-bold px-2.5 py-1 rounded-lg
            ${weekComparison.change_pct > 0
              ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
              : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
            }`}>
            {weekComparison.change_pct > 0 ? "↑" : "↓"} {Math.abs(weekComparison.change_pct)}%
          </span>
        )}
      </div>

      <div className="space-y-2">
        {rows.map((row) => {
          const diff = row.lastWeek > 0 ? Math.round(((row.thisWeek - row.lastWeek) / Math.abs(row.lastWeek)) * 100) : 0;
          const clampedDiff = Math.max(-500, Math.min(500, diff));
          const isUp = clampedDiff > 0;
          const isGood = row.goodUp ? isUp : !isUp;
          return (
            <div key={row.label} className="flex items-center justify-between py-2.5 px-3 bg-gray-50 dark:bg-gray-700/20 rounded-xl">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-300 w-20">{row.label}</span>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="text-xs text-gray-400">This week</p>
                  <p className="text-sm font-bold text-gray-800 dark:text-white">{Math.round(row.thisWeek).toLocaleString()}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-400">Last week</p>
                  <p className="text-sm text-gray-500">{Math.round(row.lastWeek).toLocaleString()}</p>
                </div>
                {clampedDiff !== 0 && (
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded-md
                    ${isGood
                      ? "text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30"
                      : "text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-900/30"
                    }`}>
                    {isUp ? "↑" : "↓"}{Math.abs(clampedDiff)}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   BUSINESS HEALTH SCORE — circular gauge
   ═══════════════════════════════════════════════════════════ */

function HealthScore({ summary, monthlyData, onNavigate }) {
  const factors = [];

  const margin = summary?.profit_margin || 0;
  factors.push({ label: "Profitability", score: Math.min(Math.round(margin * 1.5), 30), max: 30 });

  const dailyRevenue = monthlyData?.daily_revenue || [];
  const daysWithSales = dailyRevenue.filter((d) => d.amount > 0).length;
  const totalDays = Math.max(dailyRevenue.length, 1);
  factors.push({ label: "Consistency", score: Math.min(Math.round((daysWithSales / totalDays) * 25), 25), max: 25 });

  const growthChange = Math.max(-500, Math.min(500, summary?.today_revenue_change || 0));
  const growthScore = growthChange > 0 ? Math.min(Math.round(growthChange), 20) : growthChange === 0 ? 10 : Math.max(10 + Math.round(growthChange / 2), 0);
  factors.push({ label: "Growth", score: growthScore, max: 20 });

  const expenseRatio = (summary?.month_revenue || 0) > 0 ? (summary?.month_expenses || 0) / summary.month_revenue : 1;
  factors.push({ label: "Cost Control", score: Math.round(Math.max(0, (1 - expenseRatio)) * 15), max: 15 });

  factors.push({ label: "Activity", score: (summary?.today_revenue || 0) > 0 ? 10 : 0, max: 10 });

  const total = factors.reduce((s, f) => s + f.score, 0);
  const color = total >= 75 ? "#22C55E" : total >= 50 ? "#F59E0B" : total >= 25 ? "#F97316" : "#EF4444";
  const label = total >= 75 ? "Excellent" : total >= 50 ? "Good" : total >= 25 ? "Needs Work" : "Critical";

  const circumference = 2 * Math.PI * 34;
  const filled = (total / 100) * circumference;

  return (
    <div
      onClick={onNavigate}
      className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        {/* Gauge */}
        <div className="flex items-center sm:flex-col gap-4 sm:gap-2">
          <div className="relative w-20 h-20 flex-shrink-0">
            <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="34" fill="none" stroke="currentColor" strokeWidth="5" className="text-gray-100 dark:text-gray-700" />
              <circle cx="40" cy="40" r="34" fill="none" strokeWidth="5" strokeLinecap="round" stroke={color}
                strokeDasharray={`${filled} ${circumference}`}
                style={{ transition: "stroke-dasharray 1s ease" }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xl font-bold" style={{ color }}>{total}</span>
            </div>
          </div>
          <div className="sm:text-center">
            <p className="text-sm font-semibold text-gray-800 dark:text-white">Business Health</p>
            <p className="text-xs font-medium" style={{ color }}>{label}</p>
          </div>
        </div>

        {/* Factor bars */}
        <div className="flex-1 space-y-2">
          {factors.map((f) => (
            <div key={f.label} className="flex items-center gap-3">
              <span className="text-xs text-gray-500 dark:text-gray-400 w-20 shrink-0">{f.label}</span>
              <div className="flex-1 h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(f.score / f.max) * 100}%`, background: color }} />
              </div>
              <span className="text-xs text-gray-400 w-8 text-right">{f.score}/{f.max}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   GOAL TRACKER — daily + monthly progress bars
   ═══════════════════════════════════════════════════════════ */

function GoalTracker({ todayRevenue, monthRevenue }) {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const [dailyGoal, setDailyGoal] = useState(user?.daily_goal || 0);
  const [monthlyGoal, setMonthlyGoal] = useState(user?.monthly_goal || 0);
  const [editing, setEditing] = useState(null);
  const [inputVal, setInputVal] = useState("");

  const saveGoal = async (type) => {
    const val = parseFloat(inputVal);
    if (!val || val <= 0) return;
    try {
      if (type === "daily") { await api.patch("/auth/daily-goal", null, { params: { goal: val } }); setDailyGoal(val); }
      else { await api.patch("/auth/monthly-goal", null, { params: { goal: val } }); setMonthlyGoal(val); }
      setEditing(null);
    } catch { /* ignore */ }
  };

  const GoalBar = ({ label, current, goal, type, color }) => {
    const pct = goal > 0 ? Math.min(Math.round((current / goal) * 100), 100) : 0;
    const hit = pct >= 100;
    return (
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {label} {hit && <span className="text-green-600 text-xs ml-1">🎯 {t("reached")}</span>}
          </p>
          {editing === type ? (
            <div className="flex gap-1.5">
              <input type="number" value={inputVal} onChange={(e) => setInputVal(e.target.value)} placeholder={String(goal)}
                className="w-24 px-2 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                autoFocus onKeyDown={(e) => e.key === "Enter" && saveGoal(type)} />
              <button onClick={() => saveGoal(type)} className="px-2 py-1 bg-blue-600 text-white rounded-lg text-xs font-medium">{t("save")}</button>
              <button onClick={() => setEditing(null)} className="text-gray-400 text-xs">✕</button>
            </div>
          ) : goal > 0 ? (
            <button onClick={() => { setEditing(type); setInputVal(String(goal)); }} className="text-xs text-blue-500 hover:underline">{t("edit")}</button>
          ) : (
            <button onClick={() => { setEditing(type); setInputVal(""); }} className="text-xs text-blue-600 font-medium hover:underline">{t("setGoal")}</button>
          )}
        </div>
        {goal > 0 ? (
          <>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">{current.toLocaleString()} / {goal.toLocaleString()} {currency}</span>
              <span className={`text-xs font-semibold ${hit ? "text-green-600" : "text-gray-500"}`}>{pct}%</span>
            </div>
            <div className="w-full h-2.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all duration-500 ${hit ? "bg-green-500" : color}`} style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : (
          <p className="text-xs text-gray-400">{t("trackProgress")}</p>
        )}
      </div>
    );
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm space-y-4">
      <GoalBar label={t("dailyGoal")} current={todayRevenue} goal={dailyGoal} type="daily" color="bg-blue-500" />
      <GoalBar label={t("monthlyGoal")} current={monthRevenue} goal={monthlyGoal} type="monthly" color="bg-purple-500" />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN DASHBOARD
   ═══════════════════════════════════════════════════════════ */

export default function DashboardPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { showToast, ToastContainer } = useToast();

  // ── State ──
  const [summary, setSummary] = useState(null);
  const [monthlyData, setMonthlyData] = useState(null);
  const [lastSale, setLastSale] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [quickMsg, setQuickMsg] = useState("");
  const [forecast, setForecast] = useState(null);
  const [period, setPeriod] = useState("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [periodStats, setPeriodStats] = useState(null);
  const [categories, setCategories] = useState([]);
  const [benchmarks, setBenchmarks] = useState(null);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [topSellers, setTopSellers] = useState([]);
  const [actionItems, setActionItems] = useState([]);
  const [weekComparison, setWeekComparison] = useState(null);
  const [paymentBreakdown, setPaymentBreakdown] = useState([]);
  const [weather, setWeather] = useState(null);
  const [staffing, setStaffing] = useState(null);
  const [saleModal, setSaleModal] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [lightboxImg, setLightboxImg] = useState(null);

  // ── Keyboard shortcuts ──
  useKeyboardShortcuts({
    s: () => setSaleModal(true),
    e: () => navigate("/expenses"),
    d: () => navigate("/dashboard"),
    i: () => navigate("/inventory"),
    r: () => navigate("/reports"),
    "?": () => setHelpOpen(true),
    escape: () => { setSaleModal(false); setHelpOpen(false); },
  });

  // ── Derived data ──
  const dateRange = useMemo(() => {
    if (period === "custom") return { from: customFrom, to: customTo };
    return getDateRange(period);
  }, [period, customFrom, customTo]);

  const invStats = useMemo(() => {
    let lowStock = 0;
    inventoryItems.forEach((i) => {
      if (parseFloat(i.quantity) <= parseFloat(i.min_threshold)) lowStock++;
    });
    return { lowStock, count: inventoryItems.length };
  }, [inventoryItems]);

  // ── Data fetching ──
  const fetchAll = () => {
    api.get("/dashboard/summary").then((r) => setSummary(r.data)).catch(() => {});
    const now = new Date();
    api.get("/reports/monthly", { params: { month: now.getMonth() + 1, year: now.getFullYear() } }).then((r) => setMonthlyData(r.data)).catch(() => {});
    api.get("/sales/latest").then((r) => setLastSale(r.data)).catch(() => {});
    api.get("/sales/receipts").then((r) => setReceipts(r.data)).catch(() => {});
    api.get("/reports/forecast", { params: { days: 7 } }).then((r) => setForecast(r.data)).catch(() => {});
    api.get("/expenses/categories").then((r) => setCategories(r.data)).catch(() => {});
    api.get("/dashboard/benchmarks").then((r) => setBenchmarks(r.data)).catch(() => {});
    api.get("/inventory").then((r) => setInventoryItems(r.data)).catch(() => {});
    api.get("/dashboard/top-sellers").then((r) => setTopSellers(r.data)).catch(() => {});
    api.get("/dashboard/action-items").then((r) => setActionItems(r.data)).catch(() => {});
    api.get("/dashboard/week-comparison").then((r) => setWeekComparison(r.data)).catch(() => {});
    api.get("/dashboard/payment-breakdown").then((r) => setPaymentBreakdown(r.data)).catch(() => {});
    api.get("/weather/forecast").then((r) => setWeather(r.data)).catch(() => {});
    api.get("/staffing/forecast").then((r) => setStaffing(r.data)).catch(() => {});
  };

  // Fetch period-specific stats
  useEffect(() => {
    if (!dateRange.from || !dateRange.to) return;
    if (period === "today") { setPeriodStats(null); return; }
    const params = { from: dateRange.from, to: dateRange.to };
    Promise.all([api.get("/sales", { params }), api.get("/expenses", { params })]).then(([salesRes, expRes]) => {
      const sales = salesRes.data;
      const expenses = expRes.data;
      const totalRevenue = sales.reduce((s, x) => s + parseFloat(x.amount), 0);
      const totalExpenses = expenses.reduce((s, x) => s + parseFloat(x.amount), 0);
      const catMap = {};
      expenses.forEach((e) => { catMap[e.category_id || "other"] = (catMap[e.category_id || "other"] || 0) + parseFloat(e.amount); });
      const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
      let topExpenseCategoryName = null;
      if (topCat) { const catObj = categories.find((c) => c.id === topCat[0]); topExpenseCategoryName = catObj ? catObj.name : "Other"; }
      const dailyMap = {}, dailyExpMap = {};
      sales.forEach((s) => { dailyMap[s.date] = (dailyMap[s.date] || 0) + parseFloat(s.amount); });
      expenses.forEach((e) => { dailyExpMap[e.date] = (dailyExpMap[e.date] || 0) + parseFloat(e.amount); });
      const allDates = new Set([...Object.keys(dailyMap), ...Object.keys(dailyExpMap)]);
      const dailyRevenue = [...allDates].sort().map((date) => ({
        date, amount: Math.round(dailyMap[date] || 0), expenses: Math.round(dailyExpMap[date] || 0), profit: Math.round((dailyMap[date] || 0) - (dailyExpMap[date] || 0)),
      }));
      setPeriodStats({
        totalRevenue: Math.round(totalRevenue), totalExpenses: Math.round(totalExpenses),
        profit: Math.round(totalRevenue - totalExpenses),
        margin: totalRevenue > 0 ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0,
        topExpenseAmount: topCat ? Math.round(topCat[1]) : 0, topExpenseCategoryName, dailyRevenue, salesCount: sales.length,
      });
    }).catch(() => {});
  }, [dateRange.from, dateRange.to, period, categories]);

  useEffect(() => {
    fetchAll();
    const onDataChanged = () => fetchAll();
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

  // ── Quick actions ──
  const handleQuickSale = async (amount) => {
    try {
      await api.post("/sales", { amount, date: new Date().toISOString().split("T")[0], payment_method: "cash", description: t("quickSaleDesc") });
      showToast(`${t("saleLogged")} ${amount.toLocaleString()} ${currency}`, "success");
      fetchAll();
    } catch { showToast(t("failedToLogSale"), "error"); }
  };

  const repeatYesterday = async () => {
    try { await api.post("/sales/repeat-yesterday"); setQuickMsg(t("yesterdayCopied")); fetchAll(); setTimeout(() => setQuickMsg(""), 3000); }
    catch { setQuickMsg(t("noYesterdaySale")); setTimeout(() => setQuickMsg(""), 3000); }
  };

  const downloadPdf = async () => {
    try {
      const now = new Date();
      const res = await api.get("/reports/monthly/pdf", { params: { month: now.getMonth() + 1, year: now.getFullYear() }, responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a"); a.href = url; a.download = `report_${now.getFullYear()}_${now.getMonth() + 1}.pdf`; a.click();
      window.URL.revokeObjectURL(url);
    } catch { setQuickMsg(t("downloadPdf") + " failed"); setTimeout(() => setQuickMsg(""), 3000); }
  };

  // ── Computed values ──
  const dailyRevData = periodStats?.dailyRevenue || monthlyData?.daily_revenue || [];
  const weekSparkData = dailyRevData.slice(-7).map((d) => d.amount);
  const monthSparkData = dailyRevData.slice(-14).map((d) => d.amount);
  const revenue = periodStats ? periodStats.totalRevenue : summary?.month_revenue || 0;
  const expenses = periodStats ? periodStats.totalExpenses : summary?.month_expenses || 0;
  const profit = periodStats ? periodStats.profit : summary?.month_profit || 0;
  const marginPct = periodStats ? periodStats.margin : summary?.profit_margin || 0;

  // ── Yesterday's revenue for daily summary ──
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().split("T")[0];
  const yesterdayData = dailyRevData.find((d) => d.date === yesterdayKey);
  const yesterdayRev = yesterdayData ? yesterdayData.amount : 0;

  // ── Week avg ──
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() === 0 ? 6 : weekStart.getDay() - 1));
  const weekDays = dailyRevData.filter((d) => d.date >= weekStart.toISOString().split("T")[0]);
  const weekAvg = weekDays.length > 0 ? Math.round(weekDays.reduce((s, d) => s + d.amount, 0) / weekDays.length) : 0;

  // ── Best day ──
  const bestDay = dailyRevData.length > 0 ? dailyRevData.reduce((best, d) => d.amount > best.amount ? d : best, dailyRevData[0]) : null;

  // ── Loading state ──
  if (!summary) {
    return (
      <div className="p-4 sm:p-6 space-y-6">
        <SkeletonCard />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3"><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>
        <SkeletonChart />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6"><SkeletonChart /><SkeletonChart /></div>
      </div>
    );
  }

  return (
    <PullToRefresh onRefresh={async () => fetchAll()}>
      <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto">
        <ToastContainer />
        <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        <QuickSaleModal open={saleModal} onClose={() => setSaleModal(false)} onSubmit={handleQuickSale} currency={currency} />

        {/* ── HEADER ── */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-gray-100">
              {t("welcome")}, {user?.business_name}
            </h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSaleModal(true)} className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 transition-colors shadow-sm">
              + {t("quickSale")}
            </button>
            <ReceiptCapture onSaleCreated={fetchAll} />
            <button onClick={repeatYesterday} className="px-4 py-2 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors">
              {t("repeatYesterday")}
              {lastSale && <span className="ml-1 text-green-600 dark:text-green-400">({parseFloat(lastSale.amount).toLocaleString()})</span>}
            </button>
            <button onClick={downloadPdf} className="px-4 py-2 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 rounded-xl text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors">
              📄 {t("downloadPdf")}
            </button>
          </div>
        </div>

        {quickMsg && (
          <div className="bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-4 py-2.5 rounded-xl text-sm font-medium">{quickMsg}</div>
        )}

        {/* ── PERIOD SELECTOR ── */}
        <div className="flex flex-wrap items-center gap-2">
          {PERIODS.map((p) => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all
                ${period === p
                  ? "bg-green-600 text-white shadow-sm"
                  : "bg-gray-100 dark:bg-gray-700/60 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}>
              {p === "today" ? t("today") : p === "thisWeek" ? t("thisWeek") : p === "thisMonth" ? t("thisMonth") : t("last30Days")}
            </button>
          ))}
        </div>

        <Onboarding summary={summary} />

        {/* ═══════════════════════════════════════════════════
           ROW 1: KPI CARDS — 4 columns with sparklines
           ═══════════════════════════════════════════════════ */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <KpiCard
            title={period === "today" ? t("todayRevenue") : period === "thisWeek" ? t("thisWeekRevenue") : period === "thisMonth" ? t("thisMonthRevenue") : t("last30Revenue")}
            numericValue={periodStats ? periodStats.totalRevenue : summary.today_revenue}
            currency={currency}
            change={period === "today" ? summary.today_revenue_change : undefined}
            changeLabel={period === "today" ? t("vsYesterday") : periodStats ? `${periodStats.salesCount} sales` : undefined}
            sparkData={weekSparkData}
            onClick={() => navigate("/sales")}
            highlight
          />
          <KpiCard
            title="Yesterday"
            numericValue={yesterdayRev}
            currency={currency}
            subtitle={yesterdayRev > 0 ? formatDateShort(yesterdayKey) : "No sales"}
            onClick={() => navigate("/sales")}
          />
          <KpiCard
            title="Week Avg"
            numericValue={weekAvg}
            currency={currency}
            subtitle={`${currency}/day`}
            sparkData={weekSparkData}
            onClick={() => navigate("/reports")}
          />
          <KpiCard
            title="Best Day"
            numericValue={bestDay ? bestDay.amount : 0}
            currency={currency}
            subtitle={bestDay ? formatDateShort(bestDay.date) : "—"}
            sparkData={monthSparkData}
            onClick={() => navigate("/reports")}
          />
        </div>

        {/* ═══════════════════════════════════════════════════
           ROW 2: TOP SELLERS — Qty / Revenue toggle (full width)
           ═══════════════════════════════════════════════════ */}
        <TopSellersCard topSellers={topSellers} currency={currency} onNavigate={() => navigate("/sales")} />

        {/* ═══════════════════════════════════════════════════
           ROW 3: FORECAST+WEATHER+STAFFING + P&L side by side
           ═══════════════════════════════════════════════════ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ForecastWeatherStaffing forecast={forecast} weather={weather} staffing={staffing} currency={currency} onNavigate={() => navigate("/weather")} />
          <PLCard revenue={revenue} expenses={expenses} profit={profit} margin={marginPct} currency={currency} onNavigate={() => navigate("/reports")} />
        </div>

        {/* ═══════════════════════════════════════════════════
           ROW 4: SALES (payments) + EXPENSES together
           ═══════════════════════════════════════════════════ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <PaymentBreakdownCard paymentBreakdown={paymentBreakdown} currency={currency} onNavigate={() => navigate("/sales")} />
          <ExpenseBreakdown breakdown={monthlyData?.expense_breakdown} currency={currency} onNavigate={() => navigate("/expenses")} />
        </div>

        {/* ═══════════════════════════════════════════════════
           ROW 5: INVENTORY + ALERTS
           ═══════════════════════════════════════════════════ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <InventoryPanel items={inventoryItems} currency={currency} onNavigate={() => navigate("/inventory")} />
          <AlertsPanel actionItems={actionItems} summary={summary} weekComparison={weekComparison} onNavigate={navigate} />
        </div>

        {/* Ask Agent CTA */}
        <button
          onClick={() => {
            const agentBtn = document.querySelector("[data-bonbox-agent-toggle]");
            if (agentBtn) agentBtn.click();
          }}
          className="w-full flex items-center gap-3 px-5 py-4 bg-gradient-to-r from-blue-500/5 via-purple-500/5 to-pink-500/5 dark:from-blue-500/10 dark:via-purple-500/10 dark:to-pink-500/10 rounded-2xl border border-gray-100 dark:border-gray-700/60 shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] active:scale-[0.99] transition-all"
        >
          <span className="text-2xl">💬</span>
          <div className="text-left flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">Ask anything about your business...</p>
            <p className="text-xs text-gray-400 mt-0.5">Powered by BonBox Agent</p>
          </div>
          <span className="text-[10px] font-bold text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-2 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0">Live</span>
        </button>

        {/* ═══════════════════════════════════════════════════
           ROW 6: WEEK COMPARISON + HEALTH SCORE
           ═══════════════════════════════════════════════════ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <WeekComparisonCard weekComparison={weekComparison} currency={currency} onNavigate={() => navigate("/reports")} />
          <HealthScore summary={summary} monthlyData={monthlyData} onNavigate={() => navigate("/reports")} />
        </div>

        {/* ═══════════════════════════════════════════════════
           ROW 7: GOALS
           ═══════════════════════════════════════════════════ */}
        <GoalTracker todayRevenue={summary.today_revenue} monthRevenue={summary.month_revenue} />

        {/* ═══════════════════════════════════════════════════
           ROW 8: REVENUE TREND (detailed chart)
           ═══════════════════════════════════════════════════ */}
        <RevenueTrendChart data={dailyRevData} currency={currency} onNavigate={() => navigate("/reports")} />

        {/* ═══════════════════════════════════════════════════
           ROW 8: RECEIPTS (if any)
           ═══════════════════════════════════════════════════ */}
        {receipts.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 sm:p-6 border border-gray-100 dark:border-gray-700/60 shadow-sm">
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-4">{t("recentReceipts")}</h3>
            <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-3">
              {receipts.map((r) => (
                <div key={r.id} className="group relative cursor-pointer rounded-xl overflow-hidden" onClick={() => r.receipt_photo && setLightboxImg(r.receipt_photo)}>
                  {r.receipt_photo ? (
                    <img src={r.receipt_photo} alt={`Receipt ${r.date}`}
                      className="w-full h-24 object-cover"
                      onError={(e) => { e.target.style.display = "none"; e.target.nextSibling.style.display = "flex"; }} />
                  ) : null}
                  <div className="w-full h-24 bg-gray-50 dark:bg-gray-700 flex items-center justify-center" style={{ display: r.receipt_photo ? "none" : "flex" }}>
                    <span className="text-2xl">🧾</span>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent text-white text-[10px] px-2 py-1.5">
                    <p className="font-semibold">{r.amount.toLocaleString()} {currency}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lightbox */}
        {lightboxImg && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightboxImg(null)}>
            <button onClick={() => setLightboxImg(null)} className="absolute top-4 right-4 text-white text-3xl font-bold hover:text-gray-300">&times;</button>
            <img src={lightboxImg} alt="Receipt" className="max-w-full max-h-[90vh] rounded-xl shadow-2xl object-contain" onClick={(e) => e.stopPropagation()} />
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}
