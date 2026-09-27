import React from "react";
import { ChevronRight } from "lucide-react";
import { ACCENT_VALUE_CLASS } from "./statAccents";

/**
 * StatStrip — a row of small stats in ONE card.
 *
 * For pages where the numbers SUPPORT a bigger working surface (a floor plan,
 * a timeline) rather than being the point of the page. StatCard is the right
 * tile when the numbers are the page (a dashboard); six of them in a row above
 * the Reservations floor were a ~95px band of boxes, four of which usually said
 * "0", pushing the room the host actually works from down the screen.
 *
 * One card, hairline dividers; each cell stacks a small label, the value, and
 * a one-line helper under it. About 80px tall — the six tiles it replaced were
 * 116-133px — and the same shape on a phone, three across.
 *
 * items: [{
 *   key, label, value,
 *   helper?,            short note on one line, truncated if it does not fit —
 *                       put the part that matters most FIRST
 *   accent?,            "neutral" | "success" | "warn" | "critical" (value colour)
 *   onClick?, selected?,  a clickable cell is a real <button> with a chevron
 *   hideOnPhone?,       hide below sm: (only pass true when the cell is quiet)
 * }]
 */
export default function StatStrip({ items, className = "" }) {
  // On a phone the strip is three across and quiet cells hide, so its last row
  // is often short — four cells left one stat beside a blank white box. The
  // phone grid is 6 columns with each cell spanning 2; the cells of a short
  // last row share the full width instead (1 left → all 6, 2 left → 3 each).
  const phoneKeys = items.filter((i) => !i.hideOnPhone).map((i) => i.key || i.label);
  const tail = phoneKeys.length % 3;
  const tailKeys = new Set(tail ? phoneKeys.slice(-tail) : []);
  const tailSpan = tail === 1 ? "col-span-6" : "col-span-3";
  return (
    // The dividers are each cell's right + bottom hairline, drawn as an
    // outside box-shadow and clipped by the card at its edges. Unlike a
    // gap-px grid over a line-coloured background, that works for any column
    // count and leaves NO grey block when the last row is short — which it is
    // on a phone whenever a quiet cell hides.
    <div
      className={
        "grid grid-cols-6 sm:grid-cols-3 lg:grid-cols-6 overflow-hidden rounded-xl border " +
        "border-[rgb(var(--surface-line))] bg-[rgb(var(--surface-card))] " +
        className
      }
    >
      {items.map(({ key, ...item }) => (
        <StatStripCell
          key={key || item.label}
          phoneSpan={tailKeys.has(key || item.label) ? tailSpan : "col-span-2"}
          {...item}
        />
      ))}
    </div>
  );
}

function StatStripCell({
  label,
  value,
  helper = null,
  accent = "neutral",
  onClick = null,
  selected = false,
  hideOnPhone = false,
  phoneSpan = "col-span-2",
}) {
  const isClickable = typeof onClick === "function";
  const valueClass = ACCENT_VALUE_CLASS[accent] || ACCENT_VALUE_CLASS.neutral;
  const cls =
    (hideOnPhone ? "hidden sm:block " : "block ") +
    phoneSpan + " sm:col-span-1 min-w-0 px-3 py-2 text-left " +
    "shadow-[1px_0_0_0_rgb(var(--surface-line)),0_1px_0_0_rgb(var(--surface-line))] " +
    (selected ? "bg-[rgb(var(--surface-subtle))] " : "") +
    (isClickable
      ? "cursor-pointer transition hover:bg-[rgb(var(--surface-subtle))] " +
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset " +
        "focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 "
      : "");

  const inner = (
    <>
      {/* Sentence-case 12px labels, one line, and no chevron on a phone.
          Uppercase tracked labels ("NÆSTE ANKOMST", "PÅ VENTELISTE") wrap in
          a ~120px phone cell, and a wrapped label pushes its value off the
          row's baseline — the fix for THAT was reserving two label lines,
          which is exactly the height this strip exists to remove. */}
      <span className="flex items-center justify-between gap-1 min-w-0">
        <span
          className={
            "text-xs leading-4 font-medium truncate " +
            (selected
              ? "text-gray-900 dark:text-gray-100"
              : "text-gray-500 dark:text-gray-400")
          }
        >
          {label}
        </span>
        {isClickable && (
          <ChevronRight
            size={12}
            className="hidden sm:block shrink-0 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
        )}
      </span>
      {/* Label, value, helper — always stacked. Side by side it measured 64px
          instead of ~80, but the cells are only ~140px wide once the app's
          sidebar is open, so the helper was cut to "11 reservati…" and
          "højest k…" exactly where the owner reads it. */}
      <span className="mt-0.5 flex flex-col min-w-0">
        <span className={"text-[21px] leading-tight font-bold tabular-nums shrink-0 " + valueClass}>
          {value}
        </span>
        {helper && (
          <span
            className="text-xs leading-snug text-gray-500 dark:text-gray-400 truncate"
            title={typeof helper === "string" ? helper : undefined}
          >
            {helper}
          </span>
        )}
      </span>
    </>
  );

  if (isClickable) {
    return (
      <button type="button" onClick={onClick} aria-pressed={selected} className={cls}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}
