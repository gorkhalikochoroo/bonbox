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
 *     need a clickable tile, pass `onClick` (see below).
 *
 * Color via `accent` is the EXCEPTION not the rule:
 *   • neutral (default) — gray-900 value text
 *   • critical          — red-600 value text (e.g. overdue MOMS)
 *   • warn              — amber-600 (e.g. low stock, pending invoices)
 *   • success           — emerald-600 (the one money-moment accent)
 *
 * Clickable variant (Task #119 Phase 3):
 *   When `onClick` is set, the tile renders as a real <button> (semantic,
 *   tab-focusable, real keyboard activation) with hover + focus chrome.
 *   `expandable={true}` swaps the indicator to ChevronDown so the
 *   click-to-expand affordance is visible. `selected={true}` adds a
 *   quiet gray-900 ring + gray-50 surface — NO emerald, NO blue,
 *   matches the sidebar's "no tech-glow" active-state rule.
 *
 * Hierarchy is built by SIZE + WEIGHT, not color. Label is small uppercase
 * 11px; value is the 26px bold tabular-nums number that does the heavy
 * lifting; helper is 11.5px gray-500. `tabular-nums` keeps the digits
 * aligned across a row of tiles — critical for "scan the row" patterns.
 *
 * Usage:
 *   <StatCard label="Revenue today" value="12,480 DKK" helper="vs 9,830 yest." />
 *   <StatCard label="MOMS owed" value="3,120" accent="critical" helper="Due 24 May" />
 *   <StatCard label="Low stock" value={3} accent="critical"
 *             onClick={() => setFilter("low")} selected={filter === "low"}
 *             expandable />
 */
import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

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
  // Clickable variant — when set, the tile becomes a real <button>.
  onClick = null,
  // Active state — quiet gray-900 ring + gray-50 surface. No tech-glow.
  selected = false,
  // When true, the chevron indicator hints "click to expand" via
  // ChevronDown (rotates 180° when selected). When false but onClick
  // is set, a ChevronRight is shown instead so the affordance still
  // reads as "this navigates somewhere" without promising an inline panel.
  expandable = false,
  // Accessibility — when the button toggles a panel below it,
  // callers can pass aria-expanded + aria-controls so screen readers
  // announce the relationship. Falls back to inferring from `selected`.
  ariaExpanded = undefined,
  ariaControls = undefined,
  // Dense — shrinks padding + value size ON MOBILE ONLY (sm: restores the
  // full scale). Lets a caller pack a row of tiles into a tighter phone
  // grid without touching tablet/desktop. Default false → byte-identical
  // to the original classes for every existing caller.
  dense = false,
}) {
  const valueClass = ACCENT_VALUE_CLASS[accent] || ACCENT_VALUE_CLASS.neutral;
  const isClickable = typeof onClick === "function";

  // Dense scale is mobile-only: the sm: breakpoint always lands back on the
  // canonical px-4 py-3.5 / 26px so tablet + desktop stay pixel-identical.
  const padClass = dense ? "px-3 py-2.5 sm:px-4 sm:py-3.5" : "px-4 py-3.5";
  // Non-dense steps down on a phone too, and returns to 26px from sm: up.
  // Dense stays a notch smaller than default on mobile (20 vs 22), so the two
  // scales keep their relationship instead of collapsing into each other.
  const valueSizeClass = dense
    ? "text-[20px] sm:text-[26px]"
    : "text-[22px] sm:text-[26px]";

  // Label class shifts to gray-900 when selected — quiet but unambiguous
  // active state. Stays gray-400 in the default + non-selected hover state
  // so a row of tiles still reads as a single block.
  const labelClass = selected
    ? "text-[11px] font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-100"
    : "text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500";

  // Surface chrome — base for both static + clickable variants. The
  // selected state pulls in a 1px gray-900 ring + gray-50 surface,
  // matching the sidebar's "active item" treatment exactly (Layout.jsx).
  const baseChrome =
    "rounded-xl border text-left transition " + padClass + " " +
    (selected
      ? "ring-1 ring-gray-900 dark:ring-gray-100 bg-gray-50 dark:bg-gray-900/60 border-gray-300 dark:border-gray-700 "
      : "bg-white border-gray-200 dark:bg-gray-900 dark:border-gray-800 ");
  // Clickable-only chrome — hover surface + focus-visible ring. The
  // hover is gray-50 (not a colored tint) so it stays in the calm
  // palette; focus-visible uses gray-900 ring to match the selected
  // state — same color, dotted by the browser's outline behavior.
  const clickableChrome = isClickable
    ? "cursor-pointer hover:bg-gray-50 hover:border-gray-300 dark:hover:bg-gray-800/60 dark:hover:border-gray-700 " +
      "focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
      "focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-950 active:scale-[0.99] "
    : "";

  // Chevron — ChevronDown when the tile expands an inline panel
  // (rotates 180° on selected), ChevronRight when it just filters /
  // navigates without an expansion. Always gray-400 so it doesn't
  // compete with the value number for attention.
  const Chevron = expandable ? ChevronDown : ChevronRight;
  const chevronRotation = expandable && selected ? "rotate-180" : "";

  const inner = (
    <>
      {/* Reserve two lines of label height on a phone, released from sm: up.
          In a 3-across dense row at 402pt each tile is ~117pt wide, which fits
          "COVERS" on one line and wraps "SEATED NOW" and "ON WAITLIST" onto
          two. The value sits below the label, so a wrapped neighbour pushed its
          number down and the row's figures landed on different baselines — the
          ragged look. Tiles are wide enough not to wrap from sm: up, so the
          reservation is phone-only and desktop stays pixel-identical. */}
      <div className="flex items-start justify-between gap-2 min-h-[2.125rem] sm:min-h-0">
        <p className={labelClass}>{label}</p>
        {isClickable && (
          <Chevron
            size={12}
            className={
              "text-gray-400 dark:text-gray-500 transition-transform shrink-0 " +
              chevronRotation
            }
            aria-hidden="true"
          />
        )}
      </div>
      {/* Value — 26px bold. `tabular-nums` keeps digit widths constant
          across the row, so 12,480 and 9,830 vertically align under the
          comma and the decimal. Owners scan a row of tiles; alignment
          matters more than a flashier font. */}
      <p
        className={
          valueSizeClass + " font-bold tabular-nums leading-tight mt-0.5 " + valueClass
        }
      >
        {value}
      </p>
      {helper && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
          {helper}
        </p>
      )}
    </>
  );

  if (isClickable) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        aria-expanded={ariaExpanded !== undefined ? ariaExpanded : (expandable ? selected : undefined)}
        aria-controls={ariaControls}
        className={baseChrome + clickableChrome + className}
      >
        {inner}
      </button>
    );
  }

  return <div className={baseChrome + className}>{inner}</div>;
}
