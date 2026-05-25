/**
 * OutstandingFakturaCard — Zone 1, Sudip's #1 cashflow pain.
 *
 * Surfaces overdue fakturaer (Danish term — stays "faktura" across all
 * UI languages per the DK terminology lock). Reads `ctx.invoices.overdue`
 * and renders the top 3 with their amounts + days overdue.
 *
 * Renders only when `ctx.activations.hasOutstandingInvoices` is true
 * (i.e. overdueCount >= 1). There's no empty state here — when there's
 * nothing overdue, the card simply isn't rendered. That's why Zone 3
 * needs `AllClearCard` but Zone 1 doesn't.
 *
 * Doctrine compliance:
 *   • Neutral surface — bg-white / dark:bg-gray-900, 1px gray-200 border,
 *     rounded-xl, p-5 sm:p-6 (matches Card recipe exactly).
 *   • Single colored icon — AlertCircle in text-red-600 carries the
 *     "urgent" signal. Title, amounts, body text stay neutral gray.
 *   • Amount column uses tabular-nums so DKK totals align vertically.
 *
 * Note on labels:
 *   • Title says "Outstanding invoices" in EN but "fakturaer" stays
 *     Danish per the DK terminology lock. The translation keys keep
 *     "faktura" / "fakturaer" verbatim in both en and da blocks.
 *   • "Review all →" CTA links to /faktura?filter=overdue so the user
 *     lands on the same filtered list they're peeking at.
 */
import React from "react";
import { AlertCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";

function fmtDKK(n, currency = "DKK") {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n).toLocaleString("da-DK", { maximumFractionDigits: 0 })} ${currency}`;
}

export default function OutstandingFakturaCard({ ctx = {}, className = "" }) {
  const { t } = useLanguage();

  const overdue = Array.isArray(ctx?.invoices?.overdue)
    ? ctx.invoices.overdue
    : [];
  const overdueCount =
    ctx?.invoices?.overdueCount ?? overdue.length;
  const overdueTotal =
    ctx?.invoices?.overdueTotal ??
    overdue.reduce((sum, row) => sum + (Number(row?.amount) || 0), 0);
  const currency = ctx?.summary?.currency || "DKK";

  // Top 3 by daysOverdue desc (oldest first feels most urgent to act on).
  // Stable sort: fall back to original order for ties.
  const top = [...overdue]
    .sort((a, b) => (b?.daysOverdue ?? 0) - (a?.daysOverdue ?? 0))
    .slice(0, 3);

  return (
    <div
      className={
        "rounded-xl border border-gray-200 dark:border-gray-800 " +
        "bg-white dark:bg-gray-900 p-5 sm:p-6 " +
        (className || "")
      }
      data-zone="1"
      data-component="OutstandingFakturaCard"
    >
      <div className="flex items-start gap-3">
        <div
          className={
            "shrink-0 inline-flex items-center justify-center " +
            "w-9 h-9 rounded-full bg-red-50 dark:bg-red-900/20 " +
            "border border-red-200/70 dark:border-red-800/40"
          }
          aria-hidden="true"
        >
          <AlertCircle
            size={18}
            strokeWidth={2}
            className="text-red-600 dark:text-red-400"
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t("dashOutstandingTitle", "Outstanding fakturaer")}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 tabular-nums">
                {t(
                  "dashOutstandingSubtitle",
                  "{count} overdue · {total}",
                )
                  .replace("{count}", String(overdueCount))
                  .replace("{total}", fmtDKK(overdueTotal, currency))}
              </p>
            </div>
            <Link
              to="/faktura?filter=overdue"
              className={
                "shrink-0 inline-flex items-center gap-1 text-xs font-medium " +
                "text-gray-700 dark:text-gray-300 " +
                "hover:text-gray-900 dark:hover:text-gray-100 " +
                "transition-colors focus-visible:outline-none " +
                "focus-visible:ring-2 focus-visible:ring-gray-900 " +
                "dark:focus-visible:ring-gray-100 rounded px-1 py-0.5"
              }
              aria-label={t("dashOutstandingReviewAria", "Review all overdue fakturaer")}
            >
              {t("dashOutstandingReviewAll", "Review all")}
              <span aria-hidden="true">→</span>
            </Link>
          </div>

          {top.length > 0 && (
            <ul
              className="mt-3 space-y-1.5"
              aria-label={t("dashOutstandingListAria", "Top overdue fakturaer")}
            >
              {top.map((row, i) => {
                const days = Number(row?.daysOverdue) || 0;
                const customer = row?.customer || t("dashOutstandingUnknownCustomer", "Customer");
                return (
                  <li
                    key={`${row?.id || i}-${customer}`}
                    className={
                      "flex items-center justify-between gap-3 text-sm " +
                      "text-gray-700 dark:text-gray-300"
                    }
                  >
                    <div className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {customer}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                        {t("dashOutstandingDaysOverdue", "{n}d overdue").replace(
                          "{n}",
                          String(days),
                        )}
                      </span>
                    </div>
                    <span className="shrink-0 tabular-nums font-medium text-gray-900 dark:text-gray-100">
                      {fmtDKK(row?.amount, currency)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
