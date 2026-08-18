/**
 * PageShell — the only page wrapper in BonBox.
 *
 * Locks gutters + max-width to THREE named values. No page invents its
 * own `max-w-4xl` or `px-8` ever again.
 *
 * Width tokens (semantics, not pixels):
 *   • narrow   — settings, auth, profile, single-column read flows.
 *                max-w-3xl (768px). Reads like a document.
 *   • default  — the money pages (Sales, Expenses, Faktura, CashBook,
 *                BankImport). max-w-6xl (1152px). Entry card + KPIs +
 *                recent-table fits comfortably.
 *   • wide     — dashboards, reports, multi-column overviews. 1280px, and
 *                up to 1728px from the 2xl breakpoint so a large monitor
 *                does not fill with dead margin. See WIDTH below.
 *
 * The outer wrapper carries the page gutters (matching the doctrine spec
 * `p-4 sm:p-6`). The inner wrapper carries the max-width + vertical
 * rhythm (`space-y-6` between page sections — also doctrine-locked).
 *
 * Anything more opinionated lives inside the page content. PageShell
 * deliberately doesn't render a header, body, footer, etc. — composition
 * via children keeps it the calm wrapper it's supposed to be.
 *
 * Usage:
 *   <PageShell width="default">
 *     <PageHeader title="Sales" eyebrow="MONEY" />
 *     <EntryCard ... />
 *     <DataTable ... />
 *   </PageShell>
 */
import React from "react";

const WIDTH = {
  narrow: "max-w-3xl",
  // Same ladder as `wide` below, one step down. max-w-6xl alone left 272px of
  // dead margin each side on a 1920 screen across all eight money pages —
  // the same defect the dashboard had, just less visible because these pages
  // are denser. Tables and entry cards read fine at 1400; beyond that the
  // line length starts to hurt, which is why this stops lower than `wide`.
  default: "max-w-6xl 2xl:max-w-[1400px]",
  // `wide` grows on large displays. max-w-7xl alone is a hard 1280px cap, so
  // every pixel past ~1550 became dead margin: measured on a 1920 screen it
  // left 208px of empty gutter each side, and 528px at 2560. The wider the
  // monitor, the emptier the page looked — which is the opposite of what a
  // dashboard should do with space.
  //
  // Capped at 1728px rather than removed, deliberately. With the cap off at
  // 2560 the content reaches 2288px, but the grids inside are `lg:grid-cols-2`
  // and `sm:grid-cols-3` — they stop adding columns past `lg`, so the extra
  // width only stretches cards to ~1130px each. More space, no more
  // information. 1728 fills a 1920 screen completely (224 sidebar + 48 gutters
  // leaves 1648) while keeping cards a sane size on anything larger.
  //
  // Raising this further only helps once the dashboard grids gain a 2xl column
  // step; until then it would just make the cards bigger.
  wide: "max-w-7xl 2xl:max-w-[1728px]",
};

export default function PageShell({
  width = "default",
  className = "",
  children,
}) {
  const innerMax = WIDTH[width] || WIDTH.default;
  return (
    <div className={"min-h-full px-4 sm:px-6 py-4 sm:py-6 " + className}>
      <div className={"mx-auto space-y-6 " + innerMax}>{children}</div>
    </div>
  );
}
