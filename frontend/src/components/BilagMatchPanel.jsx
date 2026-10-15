import { Link2 } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { formatOwnerMoney } from "../utils/currency";
import { formatDateClear } from "../utils/dateFormat";

/**
 * "Knyt til eksisterende udgift" — the photo-later offer.
 *
 * Owners type the day's expenses and photograph the receipts later. When a
 * receipt (a scan, a Scan bunke draft, a forwarded mail) matches a typed
 * expense that has no bilag yet (±0,50 kr., ±3 days — the server decides),
 * this offers to staple the bilag onto that expense instead of booking the
 * purchase a second time. It never links on its own: one tap per decision,
 * and "Nej, det er en ny udgift" is always there.
 *
 * Props:
 *   candidates   — rows from /expenses/bilag-matches (or the queue's batch)
 *   receiptAmount — what the receipt says, to name a small difference
 *   currency     — the ACCOUNT currency (never the browser's)
 *   busyId       — the candidate id being linked right now
 *   onLink(c)    — link to candidate c
 *   onNew()      — optional: "no, it's a new expense"
 *   compact      — the queue's tighter row variant
 *   scrollList   — cap the candidate list and scroll inside it, for a host
 *                  that pins the panel (ReceiptCapture's footer): with 2+
 *                  candidates the uncapped panel covered the amount and date
 *                  the owner was checking (Push 8 gate). Title and "Nej, det
 *                  er en ny udgift" stay in view.
 */
export default function BilagMatchPanel({
  candidates = [],
  receiptAmount = null,
  currency = "DKK",
  busyId = null,
  onLink,
  onNew = null,
  compact = false,
  scrollList = false,
}) {
  const { t } = useLanguage();
  if (!candidates.length) return null;
  const one = candidates.length === 1;
  const money = (v) => formatOwnerMoney(v, currency, { decimals: 2 });
  return (
    <div
      className={`rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 ${compact ? "p-3 mt-2" : "p-4"}`}
      role="group"
      aria-label={t("bilagMatchTitle", "Already typed this expense?")}
      data-testid="bilag-match-panel"
    >
      <div className="flex items-start gap-2.5">
        <Link2 size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t("bilagMatchTitle", "Already typed this expense?")}
          </p>
          {!compact && (
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 leading-relaxed">
              {t("bilagMatchSub", "This receipt matches an expense that has no receipt yet. Attach it there instead of adding a new expense — the input VAT then counts once.")}
            </p>
          )}
        </div>
      </div>
      <ul
        className={`mt-2.5 space-y-2${scrollList ? " max-h-[18vh] overflow-y-auto overscroll-contain" : ""}`}
        data-testid="bilag-match-list"
      >
        {candidates.map((c) => {
          const diff = receiptAmount != null && Math.abs(Number(receiptAmount) - Number(c.amount)) >= 0.005;
          return (
            <li
              key={c.id}
              // Stacked on a phone: side by side, the button squeezed the
              // supplier and amount down to "1." at 390 px.
              className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {c.description || c.category_name || "—"}
                  </span>
                  <span className="text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100 shrink-0">
                    {money(c.amount)}
                  </span>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {formatDateClear(c.date)}
                  {c.category_name ? ` · ${c.category_name}` : ""}
                </div>
                {diff && (
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {t("bilagMatchAmountDiff", "The receipt says {amount}; the expense keeps {typed}.", {
                      amount: money(receiptAmount), typed: money(c.amount),
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onLink?.(c)}
                disabled={!!busyId}
                className="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-1.5 text-[13px] sm:text-sm font-medium px-3 py-2 sm:py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white transition disabled:opacity-40"
              >
                {busyId === c.id ? "…" : one ? t("bilagMatchLinkOne", "Attach to existing expense") : t("bilagMatchLink", "Attach")}
              </button>
            </li>
          );
        })}
      </ul>
      {onNew && (
        <button
          type="button"
          onClick={onNew}
          disabled={!!busyId}
          className="mt-2.5 text-xs font-medium text-gray-600 dark:text-gray-300 underline underline-offset-2 hover:text-gray-900 dark:hover:text-white disabled:opacity-40"
        >
          {t("bilagMatchNew", "No, it's a new expense")}
        </button>
      )}
    </div>
  );
}
