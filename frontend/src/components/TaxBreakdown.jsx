import { calcTaxBreakdown, getTaxConfig, displayCurrency } from "../utils/currency";
import { getVatTerms } from "../utils/currency";

/**
 * Shows a live tax breakdown below amount inputs.
 * Adapts to the user's currency — Moms for DKK, VAT for NPR, GST for INR, etc.
 *
 * @param {{ amount: string|number, currencyCode: string }} props
 */
export default function TaxBreakdown({ amount, currencyCode }) {
  const num = parseFloat(amount);
  const tax = getTaxConfig(currencyCode);
  const vat = getVatTerms(currencyCode);
  const cur = displayCurrency(currencyCode);

  // Don't show if no amount, or currency has 0% tax (USD)
  if (!num || num <= 0 || tax.rate === 0) return null;

  const { amountInclTax, amountExclTax, taxAmount, taxName } = calcTaxBreakdown(num, currencyCode);
  const pct = Math.round(tax.rate * 100 * 10) / 10; // e.g. 25, 13, 8.1

  return (
    <div className="mt-1.5 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600/50 text-xs space-y-1 animate-in">
      <div className="flex items-center justify-between">
        <span className="text-gray-500 dark:text-gray-400">
          {tax.inclusive ? vat.salesInclVat?.split(" ")[0] || "Amount" : "Subtotal"}
        </span>
        <span className="font-semibold text-gray-700 dark:text-gray-200">
          {(tax.inclusive ? num : amountExclTax).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {cur}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-gray-500 dark:text-gray-400">
          {taxName} ({pct}%)
        </span>
        <span className="font-semibold text-blue-600 dark:text-blue-400">
          {taxAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {cur}
        </span>
      </div>
      <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-600/50 pt-1">
        <span className="text-gray-500 dark:text-gray-400 font-medium">
          {tax.inclusive ? vat.salesExclVat?.split(" ")[0] || "Excl." : "Total"}
        </span>
        <span className="font-bold text-gray-800 dark:text-gray-100">
          {(tax.inclusive ? amountExclTax : amountInclTax).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {cur}
        </span>
      </div>
    </div>
  );
}
