import { useState } from "react";
import { calcTaxBreakdown, getTaxConfig, displayCurrency } from "../utils/currency";
import { getVatTerms } from "../utils/currency";

/**
 * Shows a live tax breakdown below amount inputs with a toggle for tax-exempt items.
 * Adapts to the user's currency — Moms for DKK, VAT for NPR, GST for INR, etc.
 *
 * @param {{ amount: string|number, currencyCode: string, type?: "sales"|"expenses" }} props
 */
export default function TaxBreakdown({ amount, currencyCode, type = "sales" }) {
  const [includeTax, setIncludeTax] = useState(true);
  const num = parseFloat(amount);
  const tax = getTaxConfig(currencyCode);
  const vat = getVatTerms(currencyCode);
  const cur = displayCurrency(currencyCode);

  // Don't show if no amount or currency has 0% tax (USD)
  if (!num || num <= 0 || tax.rate === 0) return null;

  const { amountInclTax, amountExclTax, taxAmount, taxName } = calcTaxBreakdown(num, currencyCode);
  const pct = Math.round(tax.rate * 100 * 10) / 10;

  // Use correct labels based on context (sales vs expenses)
  const inclLabel = type === "expenses"
    ? (vat.expensesInclVat || `${vat.expensesSection} incl. ${taxName}`)
    : (vat.salesInclVat || `${vat.salesSection} incl. ${taxName}`);
  const exclLabel = type === "expenses"
    ? (vat.expensesExclVat || `${vat.expensesSection} excl. ${taxName}`)
    : (vat.salesExclVat || `${vat.salesSection} excl. ${taxName}`);

  return (
    <div className="mt-1.5 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600/50 text-xs space-y-1.5 animate-in">
      {/* Tax toggle */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setIncludeTax(!includeTax)}
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold transition ${
            includeTax
              ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700"
              : "bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400 border border-gray-300 dark:border-gray-500"
          }`}
        >
          <span className={`inline-block w-2.5 h-2.5 rounded-full transition ${includeTax ? "bg-blue-500" : "bg-gray-400"}`} />
          {includeTax ? `${taxName} ${pct}%` : `0% ${taxName}`}
        </button>
        <span className="text-[10px] text-gray-400 dark:text-gray-500">
          {includeTax ? tax.inclusive ? inclLabel : `+ ${taxName}` : `${taxName}-free`}
        </span>
      </div>

      {includeTax ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-gray-500 dark:text-gray-400">
              {tax.inclusive ? inclLabel : "Subtotal"}
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
              {tax.inclusive ? exclLabel : "Total"}
            </span>
            <span className="font-bold text-gray-800 dark:text-gray-100">
              {(tax.inclusive ? amountExclTax : amountInclTax).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {cur}
            </span>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-gray-500 dark:text-gray-400">
            {type === "expenses" ? vat.expensesSection : vat.salesSection} ({taxName}-free)
          </span>
          <span className="font-bold text-gray-800 dark:text-gray-100">
            {num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {cur}
          </span>
        </div>
      )}
    </div>
  );
}
