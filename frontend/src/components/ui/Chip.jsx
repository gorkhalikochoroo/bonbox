/**
 * Chip — single source of truth for "tap-to-select" affordances.
 *
 * Used for:
 *   • Amount presets in EntryCard (500 / 1000 / 2500 / 5000 DKK)
 *   • Payment method selection (Cash / MobilePay / Card / Bank)
 *   • Category filters in Inventory + Reports
 *   • Day-of-week pickers in Recurring Expenses
 *
 * Before this, each page rolled its own selected-chip story:
 *   • Sales: `bg-green-500 text-white` (Brand-green selection)
 *   • Expenses: `bg-red-100 text-red-700` (Negative-money chrome)
 *   • Faktura: `bg-blue-100 ring-blue-500` (Generic blue)
 *   • Inventory: emoji prefix + colored border
 * Five different "selected" treatments inside one product. The doctrine
 * picks ONE: gray-900 fill, white text. Confident, quiet, accounting-grade.
 *
 * Unselected:
 *   White surface + 1px gray-200 border. Hover bumps the border to
 *   gray-300 — no fill change, no shadow, no glow. The chip stays
 *   visually quiet so a row of 6 presets doesn't out-shout the rest of
 *   the form.
 *
 * Selected:
 *   bg-gray-900 / white text. Same color as the primary Button intent so
 *   "selected chip" and "primary action" share the same visual weight —
 *   the user reads the chip as "this is the active choice, the next tap
 *   on the [Log] button will use it".
 *
 * Accessibility:
 *   Renders as a real <button type="button"> so it's keyboard activatable
 *   (Space/Enter) and announced as a button. `aria-pressed` reflects the
 *   selected prop so SRs announce "pressed" vs "not pressed". For a
 *   single-select group (radio-like), the parent owns the keyboard arrow
 *   navigation — Chip itself stays primitive.
 *
 * Sizes:
 *   • sm — h-8 px-3 text-xs (dense filter rows, day-of-week pickers)
 *   • md — h-9 px-3.5 text-sm (default; matches Button md height)
 *
 * Usage:
 *   <Chip selected={amount === 500} onClick={() => setAmount(500)}>
 *     500 DKK
 *   </Chip>
 *   <Chip size="sm" selected={cat === "lunch"} onClick={...}>Lunch</Chip>
 */
import React from "react";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium " +
  "border transition-colors whitespace-nowrap select-none " +
  "focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-gray-400 dark:focus-visible:ring-gray-500 " +
  "focus-visible:ring-offset-1 focus-visible:ring-offset-white " +
  "dark:focus-visible:ring-offset-gray-900 " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

const UNSELECTED =
  "bg-white dark:bg-gray-900 " +
  "border-gray-200 dark:border-gray-700 " +
  "text-gray-700 dark:text-gray-300 " +
  "hover:border-gray-300 dark:hover:border-gray-600 " +
  "hover:bg-gray-50 dark:hover:bg-gray-800/60";

const SELECTED =
  "bg-gray-900 dark:bg-gray-50 " +
  "border-gray-900 dark:border-gray-50 " +
  "text-white dark:text-gray-900 " +
  "hover:bg-gray-800 dark:hover:bg-white";

const SIZES = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-3.5 text-sm",
};

const Chip = React.forwardRef(function Chip(
  {
    selected = false,
    onClick,
    size = "md",
    children,
    className = "",
    type = "button",
    disabled = false,
    iconLeft = null,
    iconRight = null,
    ...rest
  },
  ref,
) {
  const classes =
    BASE + " " +
    (SIZES[size] || SIZES.md) + " " +
    (selected ? SELECTED : UNSELECTED) +
    (className ? " " + className : "");

  return (
    <button
      ref={ref}
      type={type}
      onClick={onClick}
      aria-pressed={selected}
      disabled={disabled}
      className={classes}
      {...rest}
    >
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </button>
  );
});

export default Chip;
