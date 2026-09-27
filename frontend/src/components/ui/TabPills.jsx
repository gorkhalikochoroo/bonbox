/**
 * TabPills — horizontal pill-shaped tab control.
 *
 * Used for switching between views of the same data — e.g. on Reports,
 * the user toggles between "Day / Week / Month / Quarter"; on Tax
 * Autopilot, between "Income tax / MOMS / Payroll"; on Inventory,
 * between "All / Low stock / Expiring soon".
 *
 * Why pills, not the underlined-tab pattern?
 *   Underlined tabs work best when they live inside a contained header
 *   block (like a Card.Header). BonBox pages typically have a PageHeader
 *   at the top and the tabs sit BETWEEN the header and the section grid,
 *   so they need to be visually self-contained. A pill row reads as
 *   "filter / segmented control" which is the right mental model.
 *
 * Why bg-gray-900 (not bg-emerald-600) for the selected pill?
 *   The sidebar's design comment in Layout.jsx around line 500 explicitly
 *   rejects "tech glow" colored active states in favor of a neutral dark
 *   pill. Dinero / Billy / e-conomic — the accounting tools BonBox is
 *   benchmarked against — all use this neutral-dark pattern. Reserving
 *   emerald for the one money-moment CTA (the "File MOMS" button) keeps
 *   that accent meaningful instead of one-of-many.
 *
 * Optional count chip:
 *   <TabPills tabs={[{ id:"all", label:"All", count: 42 }, …]} … />
 *   Renders a small darker chip after the label. Switches to a contrast
 *   version when the pill is selected (light chip on dark pill bg).
 *
 * Mobile overflow:
 *   When wrap=false, the pill row scrolls horizontally with a negative
 *   margin trick to bleed into the page edges (-mx-4 px-4), so users
 *   see "there's more to swipe to" instead of a clipped row.
 *
 * Phone presentation (opt-in, below sm: only):
 *   phone="underline" — a page's SECTIONS. One row that scrolls if it must, a
 *     hairline under the row and a bar under the current section. Wrapped
 *     pills put two rows of equal-weight buttons at the top of a phone screen,
 *     with the last section alone on the second row.
 *   phone="segmented" — LENSES on the same data (List / Floor / Timeline). One
 *     full-width control, equal segments, the current one a filled thumb.
 *     The whole 40px row is the tap target: the thumb is each segment's
 *     background clipped inside a transparent border, not a smaller button.
 *   Both are 40px with 13px text on a phone (index.css's global 44px touch
 *   floor is released for them) — 44px pills read as slabs at phone width.
 *   Every phone class is `max-sm:`, so from sm: up the pill row renders
 *   exactly as before — tablet and desktop are unchanged by construction.
 *
 * Usage:
 *   <TabPills
 *     tabs={[{id:"day",label:"Day"},{id:"week",label:"Week"},{id:"month",label:"Month"}]}
 *     activeId={range}
 *     onChange={setRange}
 *   />
 */
import React, { useEffect, useRef } from "react";

const PHONE_ROW = {
  underline:
    "max-sm:flex-nowrap max-sm:gap-6 max-sm:overflow-x-auto max-sm:-mx-4 max-sm:px-4 " +
    "max-sm:border-b max-sm:border-[rgb(var(--surface-line))] " +
    "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
  segmented:
    "max-sm:flex-nowrap max-sm:gap-0 max-sm:rounded-lg max-sm:border " +
    "max-sm:border-[rgb(var(--surface-line))] max-sm:bg-[rgb(var(--surface-card))]",
};

// Colour is set per state, for both themes, so the pill colours underneath
// (and the dark theme's white selected pill) never show through on a phone.
const PHONE_TAB = {
  underline: {
    base:
      "max-sm:h-10 max-sm:min-h-0! max-sm:px-0 max-sm:rounded-none max-sm:text-[13px] " +
      "max-sm:bg-transparent max-sm:dark:bg-transparent",
    on: "max-sm:text-gray-900 max-sm:dark:text-white max-sm:shadow-[inset_0_-2px_0_0_currentColor]",
    off: "max-sm:text-gray-500 max-sm:dark:text-gray-400",
  },
  segmented: {
    base:
      "max-sm:flex-1 max-sm:h-[38px] max-sm:min-h-0! max-sm:px-2 max-sm:text-[13px] max-sm:rounded-lg " +
      "max-sm:border-[3px] max-sm:border-transparent max-sm:bg-clip-padding",
    on: "max-sm:text-white max-sm:dark:bg-gray-600 max-sm:dark:text-white",
    off: "max-sm:bg-transparent max-sm:dark:bg-transparent max-sm:text-gray-600 max-sm:dark:text-gray-300",
  },
};

// On an underline row the count chip sits on the page, not on a dark pill.
const PHONE_COUNT_ON_PAGE =
  "max-sm:bg-gray-100 max-sm:text-gray-600 max-sm:dark:bg-gray-800 max-sm:dark:text-gray-300";

export default function TabPills({
  tabs = [],
  activeId,
  onChange,
  wrap = true,
  className = "",
  ariaLabel = "View",
  size = "md",
  phone = null,
}) {
  const phoneRow = PHONE_ROW[phone] || "";
  const phoneTab = PHONE_TAB[phone] || null;
  const rowRef = useRef(null);

  // A section row that scrolls keeps the current section in view — the one
  // chosen last time may be the one sitting past the edge.
  useEffect(() => {
    if (phone !== "underline") return;
    const row = rowRef.current;
    const tab = row?.querySelector('[aria-selected="true"]');
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    const r = row.getBoundingClientRect();
    const b = tab.getBoundingClientRect();
    if (b.left < r.left + 16) row.scrollLeft -= r.left + 16 - b.left;
    else if (b.right > r.right - 16) row.scrollLeft += b.right - (r.right - 16);
  }, [phone, activeId]);

  // Build a single shared `role="tablist"` to keep keyboard semantics
  // (arrow keys etc.) consistent for screen readers. We don't need a
  // full tab-arrow implementation here — clicks are the dominant input —
  // but the role gives AT users a meaningful grouping.
  //
  // `size="lg"` is an opt-in touch size for surfaces used on shared
  // host-stand tablets / Windows touch PCs, where the global
  // (pointer: coarse) 44px floor in index.css does NOT fire (a mouse or
  // stylus reports pointer: fine). It bumps each pill to a 44px tap
  // target. Default `md` keeps every existing caller pixel-identical.
  const pillSizeClass =
    size === "lg"
      ? "min-h-[44px] px-4 text-sm"
      : "px-3 py-1.5 text-[13px]";
  const containerClass =
    (wrap
      ? "flex flex-wrap gap-1.5"
      : "flex gap-1.5 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-none") +
    (phoneRow ? " " + phoneRow : "") +
    (className ? " " + className : "");

  return (
    <div ref={rowRef} role="tablist" aria-label={ariaLabel} className={containerClass}>
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        // Selected = bg-gray-900 (almost-black) + white text. Unselected
        // = bg-gray-100 + gray-700. Hover on unselected bumps to gray-200
        // to signal interactivity without the green sidebar accent.
        const pillClass = selected
          ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
          : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700";

        // Count chip — flips light/dark based on parent pill state so it
        // remains legible against either bg.
        const countClass =
          (selected
            ? "bg-white/20 text-white dark:bg-gray-900/15 dark:text-gray-900"
            : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300") +
          (phone === "underline" ? " " + PHONE_COUNT_ON_PAGE : "");

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange?.(tab.id)}
            className={
              // Focus ring on the BRAND GREEN token, not a fixed emerald-500:
              // that literal measures 2.54:1 on a white card, below the 3:1
              // WCAG non-text floor, which made the keyboard affordance the
              // least visible thing on the surface in light. The token is
              // emerald-600 in light (3.77:1) and emerald-400 in dark
              // (7.64:1). The OFFSET is the card the pills sit on — it used to
              // be hard-coded gray-900, the page ground, which drew a dark
              // halo around a control standing on a lighter card.
              "inline-flex items-center justify-center rounded-full font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--brand-green-accent))] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(var(--surface-card))] " +
              pillSizeClass + " " +
              pillClass +
              (phoneTab
                ? " " + phoneTab.base + " " + (selected ? phoneTab.on : phoneTab.off)
                : "")
            }
          >
            <span>{tab.label}</span>
            {typeof tab.count === "number" && (
              <span
                className={
                  "ml-1.5 text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full " +
                  countClass
                }
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
