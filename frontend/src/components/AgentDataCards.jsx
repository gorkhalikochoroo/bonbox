import { useState, useEffect, useRef } from "react";
import { displayCurrency } from "../utils/currency";

/* ------------------------------------------------------------------ */
/*  Shared: Animated number that counts up on mount / value change     */
/* ------------------------------------------------------------------ */
function CountUp({ value, decimals = 0, duration = 700, className = "" }) {
  const [display, setDisplay] = useState(0);
  const prev = useRef(0);
  const raf = useRef(null);

  useEffect(() => {
    const start = prev.current;
    const t0 = performance.now();
    function tick(now) {
      const p = Math.min((now - t0) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setDisplay(start + (value - start) * ease);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else prev.current = value;
    }
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);

  return (
    <span className={className}>
      {display.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared: CSS-only mini sparkline (bar chart)                        */
/* ------------------------------------------------------------------ */
function MiniSparkBars({ values = [], color = "bg-emerald-400", height = 32 }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {values.map((v, i) => (
        <div
          key={i}
          className={`flex-1 rounded-t-sm ${color} opacity-70 hover:opacity-100 transition-opacity`}
          style={{
            height: `${Math.max((v / max) * 100, 4)}%`,
            animationDelay: `${i * 40}ms`,
          }}
          title={v.toLocaleString()}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared: Change badge (up / down / neutral)                         */
/* ------------------------------------------------------------------ */
function ChangeBadge({ pct }) {
  if (pct == null) return null;
  const positive = pct >= 0;
  return (
    <span
      className={`
        inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-semibold
        ${positive
          ? "bg-emerald-500/15 text-emerald-400"
          : "bg-red-500/15 text-red-400"
        }
      `}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" className={positive ? "" : "rotate-180"}>
        <path d="M5 2L8 6H2L5 2Z" fill="currentColor" />
      </svg>
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared: Card shell                                                 */
/* ------------------------------------------------------------------ */
function CardShell({ children, gradient = "from-gray-900/80 to-gray-800/60", className = "" }) {
  return (
    <div
      className={`
        relative overflow-hidden rounded-xl border border-white/[0.06]
        bg-gradient-to-br ${gradient}
        shadow-lg shadow-black/10
        dark:shadow-black/30
        p-4 max-h-[200px]
        backdrop-blur-sm
        ${className}
      `}
      style={{ animation: "agentCardIn 0.35s ease-out both" }}
    >
      {/* subtle top highlight line */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      {children}
      <style>{`
        @keyframes agentCardIn {
          from { opacity: 0; transform: translateY(8px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared: Payment method pills                                       */
/* ------------------------------------------------------------------ */
function PaymentPills({ methods = {} }) {
  const colors = {
    cash: "bg-amber-500/20 text-amber-300 border-amber-500/20",
    card: "bg-sky-500/20 text-sky-300 border-sky-500/20",
    mobile: "bg-violet-500/20 text-violet-300 border-violet-500/20",
    online: "bg-indigo-500/20 text-indigo-300 border-indigo-500/20",
  };
  const entries = Object.entries(methods).filter(([, v]) => v > 0);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {entries.map(([method, amount]) => (
        <span
          key={method}
          className={`
            text-[10px] font-medium px-2 py-0.5 rounded-full border
            ${colors[method] || "bg-gray-500/20 text-gray-300 border-gray-500/20"}
          `}
        >
          {method}: {amount.toLocaleString()}
        </span>
      ))}
    </div>
  );
}

/* ================================================================== */
/*  REVENUE CARD                                                       */
/* ================================================================== */
export function RevenueCard({ data, currency }) {
  if (!data) return null;
  const cur = displayCurrency(currency);
  const {
    total_revenue = 0, sale_count, avg_per_day, change_pct,
    daily_breakdown = [], payment_split = {},
  } = data;

  // Flatten payment_split {cash: {total, count}} -> {cash: total}
  const paymentMethods = {};
  for (const [method, info] of Object.entries(payment_split)) {
    paymentMethods[method] = info?.total || 0;
  }

  return (
    <CardShell gradient="from-emerald-950/80 to-gray-900/70">
      <div className="flex items-start justify-between mb-2">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-emerald-400/70 font-semibold mb-1">Revenue</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {cur} <CountUp value={total_revenue} decimals={0} />
            </span>
            {change_pct != null && <ChangeBadge pct={change_pct} />}
          </div>
          {sale_count != null && (
            <p className="text-[11px] text-gray-400 mt-0.5">
              {sale_count} transactions{avg_per_day ? ` / avg ${cur} ${avg_per_day.toLocaleString()}/day` : ""}
            </p>
          )}
        </div>
        {/* icon */}
        <div className="w-8 h-8 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
            <polyline points="22,7 13.5,15.5 8.5,10.5 2,17" />
            <polyline points="16,7 22,7 22,13" />
          </svg>
        </div>
      </div>

      {/* mini sparkline */}
      {daily_breakdown.length > 1 && (
        <MiniSparkBars values={daily_breakdown.map((d) => d.total)} color="bg-emerald-400" height={28} />
      )}

      {/* payment methods */}
      <PaymentPills methods={paymentMethods} />
    </CardShell>
  );
}

/* ================================================================== */
/*  EXPENSE CARD                                                       */
/* ================================================================== */
export function ExpenseCard({ data, currency }) {
  if (!data) return null;
  const cur = displayCurrency(currency);
  const { total_expenses = 0, expense_count = 0, change_pct, by_category = [] } = data;

  // color palette for category bars
  const palette = [
    "bg-rose-500", "bg-amber-500", "bg-sky-500", "bg-violet-500",
    "bg-teal-500", "bg-pink-500", "bg-indigo-500", "bg-orange-500",
  ];

  return (
    <CardShell gradient="from-rose-950/60 to-gray-900/70">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-rose-400/70 font-semibold mb-1">Expenses</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {cur} <CountUp value={total_expenses} decimals={0} />
            </span>
            {change_pct != null && <ChangeBadge pct={change_pct} />}
          </div>
          <p className="text-[11px] text-gray-400 mt-0.5">{expense_count} entries</p>
        </div>
        <div className="w-8 h-8 rounded-lg bg-rose-500/15 flex items-center justify-center shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-rose-400">
            <polyline points="22,17 13.5,8.5 8.5,13.5 2,7" />
            <polyline points="16,17 22,17 22,11" />
          </svg>
        </div>
      </div>

      {/* stacked horizontal bar */}
      {by_category.length > 0 && (
        <>
          <div className="flex h-3 rounded-full overflow-hidden mb-2">
            {by_category.map((cat, i) => (
              <div
                key={cat.category}
                className={`${palette[i % palette.length]} transition-all`}
                style={{ width: `${(cat.total / total_expenses) * 100}%` }}
                title={`${cat.category}: ${cur} ${cat.total.toLocaleString()}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {by_category.slice(0, 5).map((cat, i) => (
              <div key={cat.category} className="flex items-center gap-1.5 text-[10px] text-gray-300">
                <span className={`w-2 h-2 rounded-full ${palette[i % palette.length]}`} />
                <span className="truncate max-w-[80px]">{cat.category}</span>
                <span className="text-gray-500">
                  {total_expenses > 0 ? `${Math.round((cat.total / total_expenses) * 100)}%` : ""}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </CardShell>
  );
}

/* ================================================================== */
/*  INVENTORY CARD                                                     */
/* ================================================================== */
export function InventoryCard({ data }) {
  if (!data) return null;
  const { total_items = 0, total_stock_value, items = [], low_stock_count = 0 } = data;

  // Filter to show low-stock items first, or all items if none are low
  const lowStockItems = items.filter((i) => i.is_low_stock);
  const displayItems = lowStockItems.length > 0 ? lowStockItems : items;

  function stockColor(qty, min) {
    if (qty <= 0) return "bg-red-500";
    if (qty <= min) return "bg-amber-400";
    return "bg-emerald-400";
  }

  return (
    <CardShell gradient="from-sky-950/60 to-gray-900/70">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-sky-400/70 font-semibold mb-1">Inventory</p>
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold text-white">
              <CountUp value={total_items} /> items
            </span>
            {total_stock_value != null && (
              <span className="text-xs text-gray-400">
                value: <CountUp value={total_stock_value} decimals={0} />
              </span>
            )}
          </div>
          {low_stock_count > 0 && (
            <p className="text-[11px] text-amber-400 mt-0.5">{low_stock_count} low stock</p>
          )}
        </div>
        <div className="w-8 h-8 rounded-lg bg-sky-500/15 flex items-center justify-center shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-sky-400">
            <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
            <polyline points="3.27,6.96 12,12.01 20.73,6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
        </div>
      </div>

      {/* item list */}
      {displayItems.length > 0 && (
        <div className="space-y-1.5 overflow-y-auto max-h-[80px] scrollbar-thin">
          {displayItems.slice(0, 5).map((item) => (
            <div key={item.id || item.name} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${stockColor(item.quantity, item.min_threshold)}`} />
                <span className="text-gray-200 truncate max-w-[140px]">{item.name}</span>
              </div>
              <span className="text-gray-400 font-mono tabular-nums">
                {item.quantity} / {item.min_threshold}
              </span>
            </div>
          ))}
          {displayItems.length > 5 && (
            <p className="text-[10px] text-gray-500 pl-3">+{displayItems.length - 5} more</p>
          )}
        </div>
      )}
    </CardShell>
  );
}

/* ================================================================== */
/*  WASTE CARD                                                         */
/* ================================================================== */
export function WasteCard({ data, currency }) {
  if (!data) return null;
  const cur = displayCurrency(currency);
  const { total_cost = 0, waste_count = 0, change_pct, by_reason = [] } = data;
  const maxCost = Math.max(...by_reason.map((r) => r.total_cost), 1);

  return (
    <CardShell gradient="from-amber-950/60 to-gray-900/70">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-amber-400/70 font-semibold mb-1">Waste</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {cur} <CountUp value={total_cost} decimals={0} />
            </span>
            {change_pct != null && <ChangeBadge pct={change_pct} />}
          </div>
          <p className="text-[11px] text-gray-400 mt-0.5">{waste_count} entries</p>
        </div>
        <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
            <polyline points="3,6 5,6 21,6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </div>
      </div>

      {/* reason bars */}
      {by_reason.length > 0 && (
        <div className="space-y-1.5">
          {by_reason.slice(0, 4).map((r) => (
            <div key={r.reason}>
              <div className="flex items-center justify-between text-[10px] mb-0.5">
                <span className="text-gray-300 capitalize truncate max-w-[120px]">{r.reason}</span>
                <span className="text-gray-400 font-mono tabular-nums">
                  {cur} {r.total_cost.toLocaleString()} ({r.count})
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-400 transition-all"
                  style={{ width: `${(r.total_cost / maxCost) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

/* ================================================================== */
/*  KHATA CARD  (credit / receivables)                                 */
/* ================================================================== */
export function KhataCard({ data, currency }) {
  if (!data) return null;
  const cur = displayCurrency(currency);
  const { total_outstanding = 0, overdue_count = 0, customers = [] } = data;

  // Only show customers with outstanding balance
  const withBalance = customers.filter((c) => c.outstanding > 0);

  function statusStyle(c) {
    if (c.is_overdue) return "bg-red-500 shadow-red-500/40 shadow-sm";
    return "bg-emerald-400 shadow-emerald-400/40 shadow-sm";
  }

  function statusLabel(c) {
    if (c.is_overdue) return "Overdue";
    return "Current";
  }

  return (
    <CardShell gradient="from-violet-950/60 to-gray-900/70">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-violet-400/70 font-semibold mb-1">Khata / Credit</p>
          <span className="text-2xl font-bold text-white">
            {cur} <CountUp value={total_outstanding} decimals={0} />
          </span>
          <p className="text-[11px] text-gray-400 mt-0.5">
            outstanding{overdue_count > 0 ? ` (${overdue_count} overdue)` : ""}
          </p>
        </div>
        <div className="w-8 h-8 rounded-lg bg-violet-500/15 flex items-center justify-center shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-violet-400">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 00-3-3.87" />
            <path d="M16 3.13a4 4 0 010 7.75" />
          </svg>
        </div>
      </div>

      {/* customer list */}
      {withBalance.length > 0 && (
        <div className="space-y-1.5 overflow-y-auto max-h-[80px] scrollbar-thin">
          {withBalance.slice(0, 5).map((c) => (
            <div key={c.id || c.name} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${statusStyle(c)}`} />
                <span className="text-gray-200 truncate max-w-[120px]">{c.name}</span>
                <span className="text-[9px] text-gray-500">{statusLabel(c)}</span>
              </div>
              <span className="text-gray-300 font-mono tabular-nums">
                {cur} {c.outstanding.toLocaleString()}
              </span>
            </div>
          ))}
          {withBalance.length > 5 && (
            <p className="text-[10px] text-gray-500 pl-3">+{withBalance.length - 5} more</p>
          )}
        </div>
      )}
    </CardShell>
  );
}

/* ================================================================== */
/*  HEALTH / OVERVIEW CARD                                             */
/* ================================================================== */
export function HealthCard({ data, currency }) {
  if (!data) return null;
  const cur = displayCurrency(currency);
  const {
    today_revenue = 0,
    month_revenue = 0,
    month_expenses = 0,
    profit_margin_pct: profit_margin,
    low_stock_count: inventory_alerts = 0,
    khata_outstanding: khata_receivable = 0,
  } = data;

  const metrics = [
    {
      label: "Today",
      value: today_revenue,
      prefix: cur,
      color: "text-emerald-400",
      iconBg: "bg-emerald-500/15",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12,6 12,12 16,14" />
        </svg>
      ),
    },
    {
      label: "Month Rev",
      value: month_revenue,
      prefix: cur,
      color: "text-sky-400",
      iconBg: "bg-sky-500/15",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-sky-400">
          <polyline points="22,7 13.5,15.5 8.5,10.5 2,17" />
        </svg>
      ),
    },
    {
      label: "Expenses",
      value: month_expenses,
      prefix: cur,
      color: "text-rose-400",
      iconBg: "bg-rose-500/15",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-rose-400">
          <polyline points="22,17 13.5,8.5 8.5,13.5 2,7" />
        </svg>
      ),
    },
    {
      label: "Margin",
      value: profit_margin ?? 0,
      suffix: "%",
      color: profit_margin >= 20 ? "text-emerald-400" : profit_margin >= 0 ? "text-amber-400" : "text-red-400",
      iconBg: profit_margin >= 20 ? "bg-emerald-500/15" : profit_margin >= 0 ? "bg-amber-500/15" : "bg-red-500/15",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={profit_margin >= 20 ? "text-emerald-400" : profit_margin >= 0 ? "text-amber-400" : "text-red-400"}>
          <rect x="2" y="2" width="20" height="20" rx="5" />
          <path d="M16 8l-8 8M8 8h8v8" />
        </svg>
      ),
    },
    {
      label: "Stock Alerts",
      value: inventory_alerts,
      color: inventory_alerts > 0 ? "text-amber-400" : "text-gray-400",
      iconBg: inventory_alerts > 0 ? "bg-amber-500/15" : "bg-gray-500/15",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={inventory_alerts > 0 ? "text-amber-400" : "text-gray-400"}>
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      ),
    },
    {
      label: "Receivable",
      value: khata_receivable,
      prefix: cur,
      color: "text-violet-400",
      iconBg: "bg-violet-500/15",
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-violet-400">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
          <circle cx="9" cy="7" r="4" />
        </svg>
      ),
    },
  ];

  return (
    <CardShell gradient="from-gray-900/90 to-gray-800/70" className="max-h-[220px]">
      <p className="text-[11px] uppercase tracking-wider text-white/50 font-semibold mb-3">Business Health</p>
      <div className="grid grid-cols-3 gap-x-3 gap-y-2.5">
        {metrics.map((m) => (
          <div key={m.label} className="min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`w-5 h-5 rounded-md ${m.iconBg} flex items-center justify-center shrink-0`}>
                {m.icon}
              </span>
              <span className="text-[10px] text-gray-500 truncate">{m.label}</span>
            </div>
            <p className={`text-sm font-bold ${m.color} leading-tight font-mono tabular-nums`}>
              {m.prefix ? `${m.prefix} ` : ""}
              <CountUp value={m.value} decimals={m.suffix === "%" ? 1 : 0} />
              {m.suffix || ""}
            </p>
          </div>
        ))}
      </div>
    </CardShell>
  );
}
