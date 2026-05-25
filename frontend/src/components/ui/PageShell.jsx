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
 *   • wide     — dashboards, reports, multi-column overviews. max-w-7xl
 *                (1280px). Charts get room.
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
  default: "max-w-6xl",
  wide: "max-w-7xl",
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
