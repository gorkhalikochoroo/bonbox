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
 * Usage:
 *   <TabPills
 *     tabs={[{id:"day",label:"Day"},{id:"week",label:"Week"},{id:"month",label:"Month"}]}
 *     activeId={range}
 *     onChange={setRange}
 *   />
 */
import React from "react";

export default function TabPills({
  tabs = [],
  activeId,
  onChange,
  wrap = true,
  className = "",
  ariaLabel = "View",
}) {
  // Build a single shared `role="tablist"` to keep keyboard semantics
  // (arrow keys etc.) consistent for screen readers. We don't need a
  // full tab-arrow implementation here — clicks are the dominant input —
  // but the role gives AT users a meaningful grouping.
  const containerClass =
    (wrap
      ? "flex flex-wrap gap-1.5"
      : "flex gap-1.5 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-none") +
    (className ? " " + className : "");

  return (
    <div role="tablist" aria-label={ariaLabel} className={containerClass}>
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
        const countClass = selected
          ? "bg-white/20 text-white dark:bg-gray-900/15 dark:text-gray-900"
          : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300";

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange?.(tab.id)}
            className={
              "inline-flex items-center px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900 " +
              pillClass
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
