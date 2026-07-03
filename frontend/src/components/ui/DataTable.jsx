/**
 * DataTable — the only way to render tabular data in BonBox.
 *
 * Before this, 64 raw <table> instances drifted across the app, each
 * with its own:
 *   • Header type-treatment (some uppercase, some not; some 11px, some 12px)
 *   • Row hover color (gray, stone, emerald-tint, blue-tint)
 *   • Empty-state implementation (some null, some "No data", some
 *     full-width <Empty> cards)
 *   • Mobile story (most broke horizontally below 640px)
 *   • Action-cell pattern (raw text links, raw buttons, icon-only buttons,
 *     dropdown menus)
 *
 * This component bakes the one true pattern.
 *
 * Desktop:
 *   Real <table> inside a scroll container. Header is sticky inside the
 *   scroll so vertical scrolling keeps column labels visible. Row hover
 *   is gray-50, selected row is gray-100 — no colored tints.
 *
 * Mobile (below `mobileBreakpoint`):
 *   Rows render as stacked <Card>s. Each column becomes a "label: value"
 *   pair. The action column collapses into a horizontal button strip at
 *   the bottom of each card. This is the only honest mobile story for a
 *   table with >3 columns — horizontal scrolling on mobile is a UX dead end.
 *
 * Loading:
 *   Renders 3 skeleton rows (animate-pulse on gray-200 bars). The
 *   skeleton matches the column widths so the page doesn't jump on load.
 *
 * Empty:
 *   When rows.length === 0 && !loading, render the `empty` slot. Pages
 *   should pass <Empty title="..." body="..." cta={...} /> — keeps the
 *   empty-state pattern unified across the app.
 *
 * Columns:
 *   Each column is a {id, label, align, width, render} object.
 *   • align: "left" | "right" | "center" — right for numbers, left for
 *     text. Default left.
 *   • width: Tailwind utility (e.g. "w-32") or a percentage class. Skip
 *     for auto-width columns.
 *   • render(row, ctx): the cell renderer. `ctx` has `isMobile` so a
 *     column can adapt presentation (e.g. show fewer details on mobile).
 *
 * Row actions:
 *   `rowActions(row) => [{ label, icon, onClick, variant }]` — each
 *   returned action renders as a <Button variant="ghost" size="sm"> in
 *   the action cell. Variant "danger" applies the danger Button variant.
 *
 * Selection:
 *   When `selectable=true`, the table renders a checkbox column on the
 *   left. `selectedIds` is a Set; `onToggleSelect(id)` and `onToggleAll`
 *   are the callbacks. Bulk-action UI lives outside this component — we
 *   only own the checkboxes.
 *
 * Usage:
 *   <DataTable
 *     columns={[
 *       { id: "date", label: "Date", width: "w-28",
 *         render: (r) => formatDate(r.date) },
 *       { id: "amount", label: "Amount", align: "right",
 *         render: (r) => formatMoney(r.amount) },
 *       { id: "method", label: "Method",
 *         render: (r) => <span className="capitalize">{r.method}</span> },
 *     ]}
 *     rows={sales}
 *     rowKey="id"
 *     empty={<Empty title="No sales yet" body="Log your first sale above." />}
 *     loading={loading}
 *     rowActions={(r) => [
 *       { label: "Edit", icon: <Pencil size={14} />, onClick: () => edit(r) },
 *       { label: "Delete", icon: <Trash size={14} />, onClick: () => del(r),
 *         variant: "danger" },
 *     ]}
 *   />
 */
import React from "react";
import Button from "./Button";
import Card from "./Card";
import { useLanguage } from "../../hooks/useLanguage";

const ALIGN = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

const MOBILE_HIDE_CLASS = {
  sm: "hidden sm:table-cell sm:table-row",
  md: "hidden md:table-cell md:table-row",
  lg: "hidden lg:table-cell lg:table-row",
};

// Mobile breakpoint → tailwind responsive prefix. Tables render as
// stacked Cards below this breakpoint, real <table> above it.
const BREAKPOINT_TABLE_HIDE = {
  sm: "hidden sm:table",
  md: "hidden md:table",
  lg: "hidden lg:table",
};
const BREAKPOINT_CARDS_HIDE = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden",
};

function resolveKey(row, rowKey, idx) {
  if (typeof rowKey === "function") return rowKey(row);
  if (typeof rowKey === "string" && row && row[rowKey] != null) {
    return row[rowKey];
  }
  return idx;
}

function actionIconClasses(v) {
  // Row actions render as icon-only buttons. Color is the SIGNAL:
  // destructive = red on hover. Everything else stays neutral gray
  // because actions appear on every row — a bright red pill in every
  // row would dominate the page (Linear/Notion/Stripe pattern).
  if (v === "danger") {
    return (
      "text-gray-500 hover:text-red-600 hover:bg-red-50 " +
      "dark:text-gray-400 dark:hover:text-red-400 dark:hover:bg-red-950/30"
    );
  }
  return (
    "text-gray-500 hover:text-gray-900 hover:bg-gray-100 " +
    "dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
  );
}

export default function DataTable({
  columns = [],
  rows = [],
  rowKey = "id",
  empty = null,
  loading = false,
  rowActions = null,
  selectable = false,
  selectedIds = null,
  onToggleSelect = null,
  onToggleAll = null,
  mobileBreakpoint = "md",
  className = "",
  // Optional: make each row/card clickable (e.g. open a detail drawer).
  // Row-action buttons already stopPropagation, so they won't double-fire.
  onRowClick = null,
}) {
  const { t } = useLanguage();
  const tableHide = BREAKPOINT_TABLE_HIDE[mobileBreakpoint] || BREAKPOINT_TABLE_HIDE.md;
  const cardsHide = BREAKPOINT_CARDS_HIDE[mobileBreakpoint] || BREAKPOINT_CARDS_HIDE.md;

  const showEmpty = !loading && rows.length === 0 && empty != null;
  const selectedSet = selectedIds instanceof Set ? selectedIds : null;
  const allChecked =
    selectable &&
    selectedSet &&
    rows.length > 0 &&
    rows.every((r, i) => selectedSet.has(resolveKey(r, rowKey, i)));

  const renderRowActions = (row) => {
    if (typeof rowActions !== "function") return null;
    const actions = rowActions(row) || [];
    if (actions.length === 0) return null;
    return (
      <div className="flex items-center justify-end gap-1 flex-wrap">
        {actions.map((a, i) => {
          // Opt-in visible label: `text: true` renders the word beside the
          // icon (auto-width pill) instead of a bare icon button. Icon-only
          // is ambiguous on touch surfaces (no hover tooltip) — see the
          // reservations row actions. Default stays icon-only for callers
          // that pass no `text`, so existing tables are unchanged.
          const withText = !!a.text;
          return (
            <button
              key={a.id || a.label || i}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (typeof a.onClick === "function") a.onClick(row);
              }}
              title={a.label /* native tooltip on hover */}
              aria-label={a.ariaLabel || a.label}
              disabled={a.disabled}
              className={
                (withText
                  ? "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium "
                  : "inline-flex items-center justify-center h-8 w-8 rounded-lg ") +
                "transition-colors focus-visible:outline-none focus-visible:ring-2 " +
                "focus-visible:ring-gray-400 disabled:opacity-40 " +
                "disabled:cursor-not-allowed " +
                actionIconClasses(a.variant)
              }
            >
              {a.icon}
              {withText && <span>{a.label}</span>}
            </button>
          );
        })}
      </div>
    );
  };

  // ───────────────────────── Desktop ─────────────────────────
  const desktop = (
    <div
      className={
        tableHide +
        " w-full overflow-auto rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
      }
    >
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900/80 backdrop-blur">
          <tr className="border-b border-gray-200 dark:border-gray-800">
            {selectable && (
              <th className="w-10 px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  checked={!!allChecked}
                  onChange={onToggleAll}
                  aria-label={t("dtSelectAllRows", "Select all rows")}
                  className="rounded border-gray-300 dark:border-gray-700 text-gray-900 focus:ring-gray-400"
                />
              </th>
            )}
            {columns.map((c) => (
              <th
                key={c.id}
                className={
                  "px-3 py-2.5 text-xs font-medium uppercase tracking-wide " +
                  "text-gray-500 dark:text-gray-400 " +
                  (ALIGN[c.align] || ALIGN.left) +
                  (c.width ? " " + c.width : "")
                }
                scope="col"
              >
                {c.label}
              </th>
            ))}
            {typeof rowActions === "function" && (
              <th className="px-3 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 w-px whitespace-nowrap">
                <span className="sr-only">{t("actions", "Actions")}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {loading &&
            // Skeleton rows — 3 placeholders with animate-pulse. The bar
            // widths vary slightly per column to feel less mechanical.
            Array.from({ length: 3 }).map((_, i) => (
              <tr key={"sk-" + i}>
                {selectable && (
                  <td className="px-3 py-3">
                    <div className="h-4 w-4 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
                  </td>
                )}
                {columns.map((c, ci) => (
                  <td
                    key={c.id}
                    className={"px-3 py-3 " + (ALIGN[c.align] || ALIGN.left)}
                  >
                    <div
                      className="h-3 rounded bg-gray-200 dark:bg-gray-800 animate-pulse"
                      style={{ width: ci % 2 === 0 ? "60%" : "80%" }}
                    />
                  </td>
                ))}
                {typeof rowActions === "function" && (
                  <td className="px-3 py-3">
                    <div className="h-3 w-12 ml-auto rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
                  </td>
                )}
              </tr>
            ))}
          {!loading &&
            rows.map((row, idx) => {
              const key = resolveKey(row, rowKey, idx);
              const isSelected = selectedSet ? selectedSet.has(key) : false;
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  role={onRowClick ? "button" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  className={
                    "transition-colors " +
                    (onRowClick ? "cursor-pointer " : "") +
                    (isSelected
                      ? "bg-gray-100 dark:bg-gray-800"
                      : "hover:bg-gray-50 dark:hover:bg-gray-800/50")
                  }
                >
                  {selectable && (
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() =>
                          onToggleSelect && onToggleSelect(key, row)
                        }
                        aria-label={t("dtSelectRow", "Select row {n}", { n: idx + 1 })}
                        className="rounded border-gray-300 dark:border-gray-700 text-gray-900 focus:ring-gray-400"
                      />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={
                        "px-3 py-3 text-gray-900 dark:text-gray-100 " +
                        (ALIGN[c.align] || ALIGN.left)
                      }
                    >
                      {typeof c.render === "function"
                        ? c.render(row, { isMobile: false })
                        : row[c.id]}
                    </td>
                  ))}
                  {typeof rowActions === "function" && (
                    <td className="px-3 py-2 text-right">
                      {renderRowActions(row)}
                    </td>
                  )}
                </tr>
              );
            })}
          {showEmpty && (
            <tr>
              <td
                colSpan={
                  columns.length +
                  (selectable ? 1 : 0) +
                  (typeof rowActions === "function" ? 1 : 0)
                }
                className="px-3 py-8"
              >
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  // ───────────────────────── Mobile (cards) ─────────────────────────
  const mobile = (
    <div className={cardsHide + " space-y-3"}>
      {loading &&
        Array.from({ length: 3 }).map((_, i) => (
          <Card key={"mk-" + i}>
            <div className="space-y-2">
              <div className="h-3 w-1/3 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
              <div className="h-3 w-2/3 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
              <div className="h-3 w-1/2 rounded bg-gray-200 dark:bg-gray-800 animate-pulse" />
            </div>
          </Card>
        ))}
      {!loading &&
        rows.map((row, idx) => {
          const key = resolveKey(row, rowKey, idx);
          const isSelected = selectedSet ? selectedSet.has(key) : false;
          return (
            <Card
              key={key}
              className={
                isSelected ? "ring-1 ring-gray-900 dark:ring-gray-100" : ""
              }
            >
              <dl
                className={"space-y-2" + (onRowClick ? " cursor-pointer" : "")}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
              >
                {selectable && (
                  <div
                    className="flex items-center justify-between"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <label className="text-xs text-gray-500 dark:text-gray-400">
                      {t("dtSelect", "Select")}
                    </label>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() =>
                        onToggleSelect && onToggleSelect(key, row)
                      }
                      aria-label={`Select row ${idx + 1}`}
                      className="rounded border-gray-300 dark:border-gray-700 text-gray-900 focus:ring-gray-400"
                    />
                  </div>
                )}
                {columns.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 shrink-0">
                      {c.label}
                    </dt>
                    <dd
                      className={
                        "text-sm text-gray-900 dark:text-gray-100 min-w-0 " +
                        (c.align === "left" ? "text-left" : "text-right")
                      }
                    >
                      {typeof c.render === "function"
                        ? c.render(row, { isMobile: true })
                        : row[c.id]}
                    </dd>
                  </div>
                ))}
              </dl>
              {typeof rowActions === "function" && (
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 flex flex-wrap gap-1 justify-end">
                  {renderRowActions(row)}
                </div>
              )}
            </Card>
          );
        })}
      {showEmpty && <Card variant="subtle">{empty}</Card>}
    </div>
  );

  return (
    <div className={className}>
      {desktop}
      {mobile}
    </div>
  );
}
