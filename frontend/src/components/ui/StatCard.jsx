/**
 * StatCard — the calm, accounting-software-grade KPI tile.
 *
 * Before this, the dashboard rendered KPIs as a riot of color: emerald
 * gradient backgrounds on revenue cards, indigo on order count, red
 * shadows on margin, etc. The "tech-glow" treatment read as a developer
 * dashboard, not a tool for a café owner closing the till at 22:30.
 *
 * The sidebar's design comment (Layout.jsx ~line 500) explicitly rejects
 * colored pills on active items in favor of a neutral gray bg + bold
 * dark text — accounting tools like Dinero, Billy, e-conomic do this.
 * StatCard applies the same restraint to KPI tiles.
 *
 * Defaults:
 *   • bg-white with a 1px gray-200 border (gray-800 in dark mode)
 *   • px-4 py-3.5, rounded-xl — same radius as Card
 *   • No hover ring, no gradient, no shadow — these read as
 *     "interactive" and KPI tiles are read-only by default. If you
 *     need a clickable tile, wrap it in <Card to="…"> instead.
 *
 * Color via `accent` is the EXCEPTION not the rule:
 *   • neutral (default) — gray-900 value text
 *   • critical          — red-600 value text (e.g. overdue MOMS)
 *   • warn              — amber-600 (e.g. low stock, pending invoices)
 *   • success           — emerald-600 (the one money-moment accent)
 *
 * Hierarchy is built by SIZE + WEIGHT, not color. Label is small uppercase
 * 11px; value is the 26px bold tabular-nums number that does the heavy
 * lifting; helper is 11.5px gray-500. `tabular-nums` keeps the digits
 * aligned across a row of tiles — critical for "scan the row" patterns.
 *
 * Usage:
 *   <StatCard label="Revenue today" value="12,480 DKK" helper="vs 9,830 yest." />
 *   <StatCard label="MOMS owed" value="3,120" accent="critical" helper="Due 24 May" />
 */
import React from "react";

// Accent palette — only the VALUE color changes. Background/border stay
// neutral so a row of mixed-accent tiles still reads as a single block.
const ACCENT_VALUE_CLASS = {
  neutral: "text-gray-900 dark:text-gray-100",
  critical: "text-red-600 dark:text-red-400",
  warn: "text-amber-600 dark:text-amber-400",
  success: "text-emerald-600 dark:text-emerald-400",
};

export default function StatCard({
  label,
  value,
  accent = "neutral",
  helper = null,
  className = "",
}) {
  const valueClass = ACCENT_VALUE_CLASS[accent] || ACCENT_VALUE_CLASS.neutral;

  return (
    <div
      className={
        "rounded-xl border border-gray-200 bg-white px-4 py-3.5 " +
        "dark:bg-gray-900 dark:border-gray-800 " + className
      }
    >
      {/* Label — matches the sidebar group-header rhythm (11px,
          font-semibold, uppercase, tracking-wider, gray-400). Reusing
          this exact treatment ties KPI tiles to nav typography. */}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        {label}
      </p>
      {/* Value — 26px bold. `tabular-nums` keeps digit widths constant
          across the row, so 12,480 and 9,830 vertically align under the
          comma and the decimal. Owners scan a row of tiles; alignment
          matters more than a flashier font. */}
      <p
        className={
          "text-[26px] font-bold tabular-nums leading-tight mt-0.5 " + valueClass
        }
      >
        {value}
      </p>
      {helper && (
        <p className="text-[11.5px] text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
          {helper}
        </p>
      )}
    </div>
  );
}
