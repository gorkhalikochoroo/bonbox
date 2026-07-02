/**
 * AgentDataCards — the rich data cards the BonBox AI chat renders under a
 * reply (revenue, expenses, inventory, khata, staff, health…).
 *
 * Design-system locked (see docs/design-system-doctrine.md): white card +
 * gray-900 text in both the light app and the dark chat panel (the card is
 * a light island — its text must be DARK), status colors only (red/amber/
 * emerald where they carry data, never per-card identity colors), money via
 * the <Amount> primitive ("9.000 kr.", token whispered — never "DKK 9,000"),
 * Lucide outline icons, tabular-nums, no count-up on any number (money must
 * never animate), one 350ms entrance beat and then stillness.
 */
import Amount from "./ui/Amount";
import { formatOwnerMoney } from "../utils/currency";
import { useLanguage } from "../hooks/useLanguage";
import {
  TrendingUp,
  TrendingDown,
  Package,
  Trash2,
  UsersRound,
  Activity,
  AlertTriangle,
  Check,
  Info,
  Target,
  BarChart3,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Shared: CSS-only mini sparkline (bar chart) — neutral data viz      */
/* ------------------------------------------------------------------ */
function MiniSparkBars({ values = [], height = 32 }) {
  const max = Math.max(...values, 1);
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-sm bg-gray-300 dark:bg-gray-600"
          style={{ height: `${Math.max((v / max) * 100, 4)}%` }}
          title={v.toLocaleString()}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared: Change badge (up / down) — status color carries the data    */
/* ------------------------------------------------------------------ */
function ChangeBadge({ pct }) {
  if (pct == null) return null;
  const positive = pct >= 0;
  const Arrow = positive ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-semibold tabular-nums ${
        positive
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"
          : "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-400"
      }`}
    >
      <Arrow className="w-3 h-3" strokeWidth={2} aria-hidden />
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared: Card shell — one entrance beat, then stillness              */
/* ------------------------------------------------------------------ */
function CardShell({ children, className = "" }) {
  return (
    <div
      className={`
        relative overflow-hidden rounded-xl border border-gray-200
        bg-white dark:bg-gray-900 dark:border-gray-800
        p-4 max-h-[200px]
        ${className}
      `}
      style={{ animation: "agentCardIn 0.35s ease-out both" }}
    >
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

/* Shared header: eyebrow label + neutral icon chip. Identity is TYPE,
   not a color — every card gets the same calm gray chrome. */
function CardEyebrow({ children }) {
  return (
    <p className="text-[11px] uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold mb-1">
      {children}
    </p>
  );
}

function IconChip({ icon }) {
  const Glyph = icon;
  return (
    <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0">
      <Glyph className="w-4 h-4 text-gray-500 dark:text-gray-400" strokeWidth={1.75} aria-hidden />
    </div>
  );
}

/* The big card number: dark on the white card, light in dark mode. */
const VALUE_CLS = "text-2xl font-bold text-gray-900 dark:text-gray-100";

/* ------------------------------------------------------------------ */
/*  Shared: Payment method pills — neutral, method name is the info     */
/* ------------------------------------------------------------------ */
function PaymentPills({ methods = {} }) {
  const entries = Object.entries(methods).filter(([, v]) => v > 0);
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {entries.map(([method, amount]) => (
        <span
          key={method}
          className="text-[10px] font-medium px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700 tabular-nums"
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
  const { t } = useLanguage();
  if (!data) return null;
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
    <CardShell>
      <div className="flex items-start justify-between mb-2">
        <div>
          <CardEyebrow>{t("revenue")}</CardEyebrow>
          <div className="flex items-baseline gap-2">
            <Amount value={total_revenue} currency={currency} className={VALUE_CLS} />
            {change_pct != null && <ChangeBadge pct={change_pct} />}
          </div>
          {sale_count != null && (
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
              {sale_count} {t("transactions")}{avg_per_day ? ` / ${t("avgPerDayShort", { amount: formatOwnerMoney(avg_per_day, currency) })}` : ""}
            </p>
          )}
        </div>
        <IconChip icon={TrendingUp} />
      </div>

      {/* mini sparkline */}
      {daily_breakdown.length > 1 && (
        <MiniSparkBars values={daily_breakdown.map((d) => d.total)} height={28} />
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
  const { t } = useLanguage();
  if (!data) return null;
  const { total_expenses = 0, expense_count = 0, change_pct, by_category = [] } = data;

  // Category split reads through SHADE, not hue — color is never identity.
  const palette = [
    "bg-gray-900 dark:bg-gray-200",
    "bg-gray-600 dark:bg-gray-400",
    "bg-gray-400 dark:bg-gray-500",
    "bg-gray-300 dark:bg-gray-600",
    "bg-gray-200 dark:bg-gray-700",
  ];

  return (
    <CardShell>
      <div className="flex items-start justify-between mb-3">
        <div>
          <CardEyebrow>{t("expenses")}</CardEyebrow>
          <div className="flex items-baseline gap-2">
            <Amount value={total_expenses} currency={currency} className={VALUE_CLS} />
            {change_pct != null && <ChangeBadge pct={change_pct} />}
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{expense_count} {t("entries")}</p>
        </div>
        <IconChip icon={TrendingDown} />
      </div>

      {/* stacked horizontal bar */}
      {by_category.length > 0 && (
        <>
          <div className="flex h-3 rounded-full overflow-hidden mb-2">
            {by_category.map((cat, i) => (
              <div
                key={cat.category}
                className={palette[i % palette.length]}
                style={{ width: `${(cat.total / total_expenses) * 100}%` }}
                title={`${cat.category}: ${formatOwnerMoney(cat.total, currency)}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {by_category.slice(0, 5).map((cat, i) => (
              <div key={cat.category} className="flex items-center gap-1.5 text-[10px] text-gray-600 dark:text-gray-300">
                <span className={`w-2 h-2 rounded-full ${palette[i % palette.length]}`} />
                <span className="truncate max-w-[80px]">{cat.category}</span>
                <span className="text-gray-400 dark:text-gray-500 tabular-nums">
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
  const { t } = useLanguage();
  if (!data) return null;
  const { total_items = 0, total_stock_value, items = [], low_stock_count = 0 } = data;

  // Filter to show low-stock items first, or all items if none are low
  const lowStockItems = items.filter((i) => i.is_low_stock);
  const displayItems = lowStockItems.length > 0 ? lowStockItems : items;

  // Status colors — this dot IS data.
  function stockColor(qty, min) {
    if (qty <= 0) return "bg-red-500";
    if (qty <= min) return "bg-amber-400";
    return "bg-emerald-400";
  }

  return (
    <CardShell>
      <div className="flex items-start justify-between mb-3">
        <div>
          <CardEyebrow>{t("inventory")}</CardEyebrow>
          <div className="flex items-baseline gap-3">
            <span className={`${VALUE_CLS} tabular-nums`}>
              {total_items} {t("items")}
            </span>
            {total_stock_value != null && (
              <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                {t("valueColon")} {total_stock_value.toLocaleString()}
              </span>
            )}
          </div>
          {low_stock_count > 0 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">{low_stock_count} {t("lowStockShort")}</p>
          )}
        </div>
        <IconChip icon={Package} />
      </div>

      {/* item list */}
      {displayItems.length > 0 && (
        <div className="space-y-1.5 overflow-y-auto max-h-[80px] scrollbar-thin">
          {displayItems.slice(0, 5).map((item) => (
            <div key={item.id || item.name} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${stockColor(item.quantity, item.min_threshold)}`} />
                <span className="text-gray-700 dark:text-gray-200 truncate max-w-[140px]">{item.name}</span>
              </div>
              <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                {item.quantity} / {item.min_threshold}
              </span>
            </div>
          ))}
          {displayItems.length > 5 && (
            <p className="text-[10px] text-gray-400 dark:text-gray-500 pl-3">+{displayItems.length - 5} {t("moreLabel")}</p>
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
  const { t } = useLanguage();
  if (!data) return null;
  const { total_cost = 0, waste_count = 0, change_pct, by_reason = [] } = data;
  const maxCost = Math.max(...by_reason.map((r) => r.total_cost), 1);

  return (
    <CardShell>
      <div className="flex items-start justify-between mb-3">
        <div>
          <CardEyebrow>{t("waste")}</CardEyebrow>
          <div className="flex items-baseline gap-2">
            <Amount value={total_cost} currency={currency} className={VALUE_CLS} />
            {change_pct != null && <ChangeBadge pct={change_pct} />}
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{waste_count} {t("entries")}</p>
        </div>
        <IconChip icon={Trash2} />
      </div>

      {/* reason bars */}
      {by_reason.length > 0 && (
        <div className="space-y-1.5">
          {by_reason.slice(0, 4).map((r) => (
            <div key={r.reason}>
              <div className="flex items-center justify-between text-[10px] mb-0.5">
                <span className="text-gray-600 dark:text-gray-300 capitalize truncate max-w-[120px]">{r.reason}</span>
                <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                  {formatOwnerMoney(r.total_cost, currency)} ({r.count})
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gray-900 dark:bg-gray-300"
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
  const { t } = useLanguage();
  if (!data) return null;
  const { total_outstanding = 0, overdue_count = 0, customers = [] } = data;

  // Only show customers with outstanding balance
  const withBalance = customers.filter((c) => c.outstanding > 0);

  return (
    <CardShell>
      <div className="flex items-start justify-between mb-3">
        <div>
          <CardEyebrow>{t("khataCredit")}</CardEyebrow>
          <Amount value={total_outstanding} currency={currency} className={VALUE_CLS} />
          <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
            {t("outstanding")}{overdue_count > 0 ? ` ${t("nOverdue", { n: overdue_count })}` : ""}
          </p>
        </div>
        <IconChip icon={UsersRound} />
      </div>

      {/* customer list */}
      {withBalance.length > 0 && (
        <div className="space-y-1.5 overflow-y-auto max-h-[80px] scrollbar-thin">
          {withBalance.slice(0, 5).map((c) => (
            <div key={c.id || c.name} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${c.is_overdue ? "bg-red-500" : "bg-gray-300 dark:bg-gray-600"}`} />
                <span className="text-gray-700 dark:text-gray-200 truncate max-w-[120px]">{c.name}</span>
                <span className={`text-[9px] ${c.is_overdue ? "text-red-600 dark:text-red-400" : "text-gray-400 dark:text-gray-500"}`}>
                  {c.is_overdue ? t("overdueStatus") : t("currentStatus")}
                </span>
              </div>
              <span className="text-gray-600 dark:text-gray-300 tabular-nums">
                {formatOwnerMoney(c.outstanding, currency)}
              </span>
            </div>
          ))}
          {withBalance.length > 5 && (
            <p className="text-[10px] text-gray-400 dark:text-gray-500 pl-3">+{withBalance.length - 5} {t("moreLabel")}</p>
          )}
        </div>
      )}
    </CardShell>
  );
}

/* ================================================================== */
/*  STAFF CARD                                                         */
/* ================================================================== */
export function StaffCard({ data }) {
  const { t } = useLanguage();
  if (!data) return null;
  const { total_staff = 0, staff = [] } = data;

  return (
    <CardShell>
      <div className="flex items-start justify-between mb-3">
        <div>
          <CardEyebrow>{t("navStaff")}</CardEyebrow>
          <span className={`${VALUE_CLS} tabular-nums`}>
            {total_staff} {t("members")}
          </span>
        </div>
        <IconChip icon={UsersRound} />
      </div>

      {/* staff list */}
      {staff.length > 0 && (
        <div className="space-y-1.5 overflow-y-auto max-h-[80px] scrollbar-thin">
          {staff.slice(0, 6).map((s) => (
            <div key={s.id || s.name} className="flex items-center justify-between text-[11px]">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-[9px] font-bold text-gray-600 dark:text-gray-300 shrink-0">
                  {(s.name || "?").charAt(0).toUpperCase()}
                </span>
                <span className="text-gray-700 dark:text-gray-200 truncate max-w-[120px]">{s.name}</span>
              </div>
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700">
                {s.role || t("navStaff")}
              </span>
            </div>
          ))}
          {staff.length > 6 && (
            <p className="text-[10px] text-gray-400 dark:text-gray-500 pl-3">+{staff.length - 6} {t("moreLabel")}</p>
          )}
        </div>
      )}
    </CardShell>
  );
}

/* ================================================================== */
/*  SUGGESTIONS / ADVICE CARD                                          */
/* ================================================================== */
export function SuggestionsCard({ data }) {
  const { t } = useLanguage();
  if (!data) return null;
  const suggestions = data.suggestions || [];
  if (suggestions.length === 0) return null;

  // Only warning/success carry semantic color; the rest stay neutral.
  const typeStyles = {
    warning: {
      box: "bg-amber-50 border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30",
      text: "text-amber-700 dark:text-amber-400",
      icon: AlertTriangle,
    },
    success: {
      box: "bg-emerald-50 border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/30",
      text: "text-emerald-700 dark:text-emerald-400",
      icon: Check,
    },
    action: {
      box: "bg-gray-50 border-gray-200 dark:bg-gray-800/60 dark:border-gray-700",
      text: "text-gray-700 dark:text-gray-200",
      icon: Target,
    },
    info: {
      box: "bg-gray-50 border-gray-200 dark:bg-gray-800/60 dark:border-gray-700",
      text: "text-gray-700 dark:text-gray-200",
      icon: Info,
    },
    insight: {
      box: "bg-gray-50 border-gray-200 dark:bg-gray-800/60 dark:border-gray-700",
      text: "text-gray-700 dark:text-gray-200",
      icon: BarChart3,
    },
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3.5 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-gray-500 dark:text-gray-400 font-semibold text-[10px] uppercase tracking-widest">
          {t("suggestionsLabel")}
        </span>
        <span className="text-[10px] text-gray-400 dark:text-gray-500">({suggestions.length})</span>
      </div>
      {suggestions.map((s, i) => {
        const style = typeStyles[s.type] || typeStyles.info;
        const RowIcon = style.icon;
        return (
          <div key={i} className={`${style.box} border rounded-lg p-2.5`}>
            <div className="flex items-center gap-1.5 mb-1">
              <RowIcon className={`w-3.5 h-3.5 ${style.text}`} strokeWidth={1.75} aria-hidden />
              <span className={`${style.text} font-semibold text-xs`}>{s.title}</span>
            </div>
            <p className="text-[11px] text-gray-600 dark:text-gray-300 leading-relaxed">{s.text}</p>
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================== */
/*  HEALTH / OVERVIEW CARD                                             */
/* ================================================================== */
export function HealthCard({ data, currency }) {
  const { t } = useLanguage();
  if (!data) return null;
  const {
    today_revenue = 0,
    month_revenue = 0,
    month_expenses = 0,
    profit_margin_pct: profit_margin,
    low_stock_count: inventory_alerts = 0,
    khata_outstanding: khata_receivable = 0,
  } = data;

  // Neutral values by default; only margin + stock alerts are status-colored.
  const marginColor =
    profit_margin >= 20
      ? "text-emerald-700 dark:text-emerald-400"
      : profit_margin >= 0
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  const metrics = [
    { label: t("today"), display: formatOwnerMoney(today_revenue, currency) },
    { label: t("monthRev"), display: formatOwnerMoney(month_revenue, currency) },
    { label: t("expenses"), display: formatOwnerMoney(month_expenses, currency) },
    {
      label: t("margin"),
      display: `${(profit_margin ?? 0).toFixed(1)}%`,
      color: marginColor,
    },
    {
      label: t("stockAlerts"),
      display: String(inventory_alerts),
      color: inventory_alerts > 0 ? "text-amber-600 dark:text-amber-400" : undefined,
    },
    { label: t("receivable"), display: formatOwnerMoney(khata_receivable, currency) },
  ];

  return (
    <CardShell className="max-h-[220px]">
      <div className="flex items-center justify-between mb-3">
        <CardEyebrow>{t("businessHealth")}</CardEyebrow>
        <Activity className="w-4 h-4 text-gray-400 dark:text-gray-500" strokeWidth={1.75} aria-hidden />
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-2.5">
        {metrics.map((m) => (
          <div key={m.label} className="min-w-0">
            <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate mb-0.5">{m.label}</p>
            <p className={`text-sm font-semibold leading-tight tabular-nums ${m.color || "text-gray-900 dark:text-gray-100"}`}>
              {m.display}
            </p>
          </div>
        ))}
      </div>
    </CardShell>
  );
}
