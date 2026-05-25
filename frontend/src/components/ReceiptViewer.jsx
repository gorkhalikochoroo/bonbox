/**
 * ReceiptViewer — modal that surfaces a saved (or just-OCR'd) receipt
 * for spot-checking against the recorded line item.
 *
 * Why this exists (May 2026):
 *   Before this, the only place a saved receipt photo could be re-viewed
 *   was the Dashboard's "Recent receipts" row (sales only, just a thumb
 *   + lightbox image). Sales-list rows and Expense rows had `receipt_photo`
 *   populated on the backend but no UI to surface it. Owners who scanned
 *   a kasserapport at 23:30 had no way to verify the saved amount against
 *   the photo when their accountant questioned it the next morning.
 *
 *   ReceiptViewer is the unified surface for that review flow:
 *
 *     • Pre-save (inside ReceiptCapture): show the photo at full height,
 *       OCR text expanded by default with detected amounts highlighted.
 *     • Post-save (Sales/Expenses list rows + Dashboard receipts row):
 *       click a thumbnail → modal with photo + recorded fields side by
 *       side, plus the URL so the owner can open the original in a new
 *       tab if they need to.
 *
 * Props:
 *   open          — controlled open flag
 *   onClose       — close handler (background tap, ✕, ESC)
 *   imageUrl      — the receipt photo URL (will be passed through
 *                   safeImageUrl — blocks data:/javascript:/SVG XSS)
 *   amount        — number (recorded amount on the saved row)
 *   currency      — string (DKK by default)
 *   date          — ISO date string (recorded on the row)
 *   paymentMethod — "cash" | "card" | "mobilepay" | "online" | "mixed" | "dankort" | etc.
 *   description   — string (optional — expense description / sale notes)
 *   ocrText       — string (optional — only set during pre-save preview;
 *                   we don't persist OCR text on save, so post-save view
 *                   doesn't have it)
 *   detectedAmounts — number[] (optional — pre-save only; highlighted in
 *                     the OCR text block)
 *   suggestedAmount — number (optional — pre-save only; the amount the
 *                     OCR pipeline picked as most likely)
 *   kind          — "sale" | "expense" (drives the title + label tone)
 *
 * The modal trusts the caller to keep the photo URL safe — but defends
 * anyway via safeImageUrl. If the URL is rejected, the modal still
 * renders with a placeholder so the user can at least see the metadata.
 */
import { useEffect } from "react";
import { Receipt } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { safeImageUrl } from "../utils/safeUrl";


/** Highlight occurrences of any of `numbers` inside `text`. Returns
 * an array of React fragments (string or <mark>). Used so the user can
 * see at a glance which amounts in the raw OCR text led to the
 * "detected amount" display.
 *
 * Implementation note: we match the LITERAL number string (e.g. "1234"
 * or "1234.50"). We don't try to be clever about thousand separators
 * or commas — the OCR pipeline already produces normalised numerics,
 * and over-matching here would highlight unrelated digits (dates, line
 * counts) which makes the UI noisy. */
function highlightAmounts(text, numbers, suggested) {
  if (!text || !numbers || numbers.length === 0) return text;
  // Build alternation regex from longest first so "12345.50" wins over
  // "12345". Escape any regex specials defensively.
  const sorted = [...new Set(numbers.map(String))].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = sorted
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return text;
  const re = new RegExp(`(${pattern})`, "g");
  const parts = text.split(re);
  return parts.map((part, i) => {
    // Even-index parts are non-matches, odd-index are matches.
    if (i % 2 === 0) return part;
    const isSuggested = suggested != null && Number(part) === Number(suggested);
    return (
      <mark
        key={i}
        className={
          isSuggested
            ? "bg-gray-200 dark:bg-gray-800/60 text-gray-900 dark:text-gray-100 px-0.5 rounded font-semibold"
            : "bg-amber-100 dark:bg-amber-700/30 text-amber-900 dark:text-amber-200 px-0.5 rounded"
        }
      >
        {part}
      </mark>
    );
  });
}


export default function ReceiptViewer({
  open,
  onClose,
  imageUrl,
  amount,
  currency = "DKK",
  date,
  paymentMethod,
  description,
  ocrText,
  detectedAmounts,
  suggestedAmount,
  kind = "sale",
}) {
  const { t } = useLanguage();

  // Close on ESC. Mounted only when open so we don't leak listeners.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const safeUrl = safeImageUrl(imageUrl);
  const titleKey = kind === "expense" ? "receiptViewerExpenseTitle" : "receiptViewerSaleTitle";
  const titleFallback = kind === "expense" ? "Expense receipt" : "Sale receipt";
  const title = t(titleKey) || titleFallback;

  const formattedAmount = (amount != null && !Number.isNaN(Number(amount)))
    ? Number(amount).toLocaleString()
    : "—";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-sm max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-700/60">
          <div className="flex items-center gap-2">
            <Receipt className="w-5 h-5 text-gray-500 dark:text-gray-400" aria-hidden="true" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label={t("close") || "Close"}
            className="w-8 h-8 inline-flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — image left, metadata + OCR right (md+); stacked on mobile.
            object-contain on the photo because receipts are TALL — cropping
            (object-cover) was hiding totals on the original implementation
            and is what motivated this rewrite. */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid md:grid-cols-2 gap-0">
            {/* Photo column */}
            <div className="bg-gray-50 dark:bg-gray-800/40 p-4 flex items-start justify-center md:border-r border-gray-100 dark:border-gray-700/60">
              {safeUrl ? (
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block max-h-[70vh] overflow-hidden rounded-xl shadow"
                  title={t("receiptViewerOpenOriginal") || "Open full size"}
                >
                  <img
                    src={safeUrl}
                    alt={t("receiptViewerImageAlt") || "Receipt photo"}
                    className="block max-h-[70vh] w-auto object-contain"
                  />
                </a>
              ) : (
                <div className="w-full aspect-[3/4] flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-xl text-gray-400">
                  <Receipt className="w-12 h-12" />
                </div>
              )}
            </div>

            {/* Metadata + OCR column */}
            <div className="p-5 space-y-4">
              {/* Recorded amount — the hero number — large + bold so the
                  owner can compare it against the photo at a glance. */}
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  {t("receiptViewerRecordedAmount") || "Recorded amount"}
                </div>
                <div className="mt-1 text-3xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
                  {formattedAmount} <span className="text-base font-normal text-gray-500 dark:text-gray-400">{currency}</span>
                </div>
              </div>

              {/* Other recorded fields — tight, so the photo dominates. */}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {date && (
                  <>
                    <dt className="text-gray-500 dark:text-gray-400">{t("date") || "Date"}</dt>
                    <dd className="text-gray-800 dark:text-gray-200 font-medium">{date}</dd>
                  </>
                )}
                {paymentMethod && (
                  <>
                    <dt className="text-gray-500 dark:text-gray-400">{t("paymentMethod") || "Payment"}</dt>
                    <dd className="text-gray-800 dark:text-gray-200 font-medium capitalize">{t(paymentMethod) || paymentMethod}</dd>
                  </>
                )}
                {description && (
                  <>
                    <dt className="text-gray-500 dark:text-gray-400 col-span-2 mt-1">{t("description") || "Description"}</dt>
                    <dd className="col-span-2 text-gray-800 dark:text-gray-200">{description}</dd>
                  </>
                )}
              </dl>

              {/* OCR text — only present in pre-save mode (we don't persist
                  it on the row). Expanded by default so users can spot
                  mistakes before confirming. Detected amounts highlighted;
                  the suggested one in green so the user can see at a glance
                  which match drove the "detected amount" pick. */}
              {ocrText && (
                <div>
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                      {t("receiptViewerOcrText") || "Receipt text recognized"}
                    </div>
                    {Array.isArray(detectedAmounts) && detectedAmounts.length > 0 && (
                      <div className="text-[10px] text-gray-400 dark:text-gray-500">
                        {(t("receiptViewerOcrLegend") || "{n} amount{s} found")
                          .replace("{n}", detectedAmounts.length)
                          .replace("{s}", detectedAmounts.length === 1 ? "" : "s")}
                      </div>
                    )}
                  </div>
                  <pre className="mt-2 p-3 bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/60 rounded-lg text-xs text-gray-700 dark:text-gray-200 whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
                    {highlightAmounts(ocrText, detectedAmounts || [], suggestedAmount)}
                  </pre>
                </div>
              )}

              {/* Open-original hint — when caller passed an imageUrl we
                  also expose it as a real <a> on the image; this is a
                  text reinforcement for keyboard / screen-reader users. */}
              {safeUrl && (
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  <a href={safeUrl} target="_blank" rel="noreferrer" className="underline hover:text-gray-700 dark:hover:text-gray-200">
                    {t("receiptViewerOpenOriginal") || "Open full size in new tab"}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
