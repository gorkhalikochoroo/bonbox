/** Convert EUR_PT -> EUR, EUR_DE -> EUR, etc. for display */
export function displayCurrency(code) {
  if (!code) return "DKK";
  return code.startsWith("EUR_") ? "EUR" : code;
}

/* ───────────────────────────── formatMoney ─────────────────────────────
 * Single source of truth for displaying money values across the app.
 *
 *   formatMoney(15000, "DKK")             → "15.000,00 DKK"   (Danish locale)
 *   formatMoney(15000.5, "DKK")           → "15.000,50 DKK"
 *   formatMoney(0, "DKK")                 → "0,00 DKK"
 *   formatMoney(15000, "DKK", { compact: true })  → "15K DKK"
 *   formatMoney(15000, "DKK", { sign: true })     → "+15.000,00 DKK"
 *   formatMoney(15000, "DKK", { decimals: 0 })    → "15.000 DKK"
 *   formatMoney(null, "DKK")              → "—"
 *
 * Rules:
 *   - Locale chosen by currency (DKK→da-DK, NOK→nb-NO, etc.)
 *   - Currency code shown after the number (operator-friendly)
 *   - ALWAYS shows two decimals for currency display by default — keeps
 *     the UI and the server-generated email PDF in sync. Pass
 *     `{ decimals: 0 }` to opt out for compact display (e.g. KPI cards
 *     where two decimals add visual noise without information). The old
 *     `alwaysDecimals` option still works as a backward-compatible
 *     alias. Fixes the #148 MEDIUM-11 drift where UI rendered
 *     "1.500 DKK" while the email said "1.500,00 DKK" for the same row.
 *   - null/undefined/NaN → "—"
 * ───────────────────────────────────────────────────────────────────── */

const LOCALE_BY_CURRENCY = {
  DKK: "da-DK",
  SEK: "sv-SE",
  NOK: "nb-NO",
  EUR: "de-DE",
  GBP: "en-GB",
  USD: "en-US",
  CHF: "de-CH",
  JPY: "ja-JP",
  INR: "en-IN",
  NPR: "en-IN", // Nepali rupee uses Indian grouping
  BRL: "pt-BR",
  MXN: "es-MX",
  AUD: "en-AU",
  CAD: "en-CA",
  ZAR: "en-ZA",
  THB: "th-TH",
  PHP: "en-PH",
};

export function formatMoney(amount, currency = "DKK", options = {}) {
  if (amount == null || Number.isNaN(amount)) return "—";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (Number.isNaN(num)) return "—";

  const code = displayCurrency(currency);
  const locale = LOCALE_BY_CURRENCY[code] || "en-GB";

  // Compact mode for charts/cards — "15K DKK", "1.2M DKK"
  if (options.compact) {
    try {
      const formatter = new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      });
      return `${formatter.format(num)} ${code}`;
    } catch {
      return `${Math.round(num).toLocaleString()} ${code}`;
    }
  }

  // Always show two decimals for currency display by default so the
  // UI matches the server-generated PDF / email (which always shows
  // two decimals). Callers wanting compact display pass `decimals: 0`
  // — e.g. dashboard KPI cards where the cents add noise. The legacy
  // `alwaysDecimals: false` opt-out is still honored.
  const explicitDecimals = typeof options.decimals === "number" ? options.decimals : null;
  const wantsCompactDecimals =
    explicitDecimals === 0 || options.alwaysDecimals === false;
  const minFrac = wantsCompactDecimals ? 0 : (explicitDecimals ?? 2);
  const maxFrac = wantsCompactDecimals ? 0 : (explicitDecimals ?? 2);

  let formatted;
  try {
    formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: minFrac,
      maximumFractionDigits: maxFrac,
    }).format(num);
  } catch {
    formatted = Math.round(num).toLocaleString();
  }

  const sign = options.sign && num > 0 ? "+" : "";
  return `${sign}${formatted} ${code}`;
}

/* ─────────────────────────────── formatKr ──────────────────────────────
 * Danish-presentation money: da-DK grouping + the literal "kr." suffix
 * (NOT the "DKK" currency code that formatMoney emits). This is the
 * canonical kr.-emitting helper for owner-facing surfaces where Danish
 * vocabulary matters — the cash-flow forecast, the weekly statement, the
 * revenue-trend tooltip — so a café owner reads "15.000,00 kr." the way a
 * Danish bank statement / lønseddel reads, never "15.000 DKK".
 *
 *   formatKr(15000)                 → "15.000,00 kr."
 *   formatKr(15000, { decimals: 0 })→ "15.000 kr."
 *   formatKr(15000, { sign: true }) → "+15.000,00 kr."
 *   formatKr(null)                  → "—"
 *
 * Always da-DK grouping regardless of runtime locale (fixes the bare
 * toLocaleString() drift where an EN-locale browser rendered "15,000").
 * null/undefined/NaN → "—" so a missing value never reads as a confident 0.
 * ──────────────────────────────────────────────────────────────────────── */
export function formatKr(amount, options = {}) {
  if (amount == null || Number.isNaN(amount)) return "—";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (Number.isNaN(num)) return "—";

  const explicitDecimals = typeof options.decimals === "number" ? options.decimals : null;
  const compact = explicitDecimals === 0 || options.alwaysDecimals === false;
  const frac = compact ? 0 : (explicitDecimals ?? 2);

  let formatted;
  try {
    formatted = new Intl.NumberFormat("da-DK", {
      minimumFractionDigits: frac,
      maximumFractionDigits: frac,
    }).format(num);
  } catch {
    formatted = String(Math.round(num));
  }

  const sign = options.sign && num > 0 ? "+" : "";
  return `${sign}${formatted} kr.`;
}

/* ─────────────────────────── formatOwnerMoney ──────────────────────────
 * The canonical STRING money formatter for owner-facing surfaces — the
 * plain-string sibling of the <Amount> ui primitive (same branch logic):
 * DKK routes through formatKr ("15.000 kr.", da-DK), everything else
 * through formatMoney (locale-correct grouping + the currency code).
 * Use this in template literals, tooltips, toasts, button labels and
 * clipboard text where JSX can't go; use <Amount> in rendered value slots.
 * Defaults to whole kroner (decimals: 0) — pass decimals: 2 on ledger-
 * exact surfaces (kassekladde). null/NaN → "—".
 * ──────────────────────────────────────────────────────────────────────── */
export function formatOwnerMoney(amount, currency = "DKK", options = {}) {
  const opts = { decimals: 0, ...options };
  const code = displayCurrency(currency);
  return code === "DKK" ? formatKr(amount, opts) : formatMoney(amount, code, opts);
}

/** Convenience: parse a money string back to number. Tolerant of locale separators. */
export function parseMoney(str) {
  if (str == null) return null;
  const cleaned = String(str)
    .replace(/[^\d.,-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

/**
 * VAT terminology by currency/country.
 * Returns localized terms for VAT concepts based on the user's currency selection.
 */
const VAT_TERMS = {
  DKK: {
    // DK terminology lock: standalone abbreviation is UPPERCASE `MOMS`
    // everywhere it appears as a brand-style token (rate labels, file
    // names, "MOMS Payable", section headers like "Expenses MOMS
    // Breakdown"). Idiomatic Danish noun phrases below (e.g.
    // "Salg inkl. moms", "Indgående moms") keep lowercase per Danish
    // orthography — those are separate fields, not the standalone token.
    vatName: "MOMS",
    sidebarLabel: "MOMS",
    reportTitle: "Momsopg\u00f8relse",
    salesSection: "Salg",
    salesInclVat: "Salg inkl. moms",
    salesExclVat: "Salg ekskl. moms",
    outputVat: "Udg\u00e5ende moms",
    expensesSection: "Udgifter",
    expensesInclVat: "Udgifter inkl. moms",
    expensesExclVat: "Udgifter ekskl. moms",
    inputVat: "Indg\u00e5ende moms",
    vatPayable: "Moms til betaling",
    payableTo: "Bel\u00f8b der skal indbetales til SKAT",
    refundFrom: "Bel\u00f8b til gode fra SKAT",
    taxAuthority: "SKAT",
    locale: "da-DK",
  },
  SEK: {
    vatName: "Moms",
    sidebarLabel: "Moms",
    reportTitle: "Momsredovisning",
    salesSection: "F\u00f6rs\u00e4ljning",
    salesInclVat: "F\u00f6rs\u00e4ljning inkl. moms",
    salesExclVat: "F\u00f6rs\u00e4ljning exkl. moms",
    outputVat: "Utg\u00e5ende moms",
    expensesSection: "Utgifter",
    expensesInclVat: "Utgifter inkl. moms",
    expensesExclVat: "Utgifter exkl. moms",
    inputVat: "Ing\u00e5ende moms",
    vatPayable: "Moms att betala",
    payableTo: "Belopp att betala till Skatteverket",
    refundFrom: "\u00c5terbetalning fr\u00e5n Skatteverket",
    taxAuthority: "Skatteverket",
    locale: "sv-SE",
  },
  NOK: {
    vatName: "MVA",
    sidebarLabel: "MVA",
    reportTitle: "MVA-oppgave",
    salesSection: "Salg",
    salesInclVat: "Salg inkl. MVA",
    salesExclVat: "Salg ekskl. MVA",
    outputVat: "Utg\u00e5ende MVA",
    expensesSection: "Utgifter",
    expensesInclVat: "Utgifter inkl. MVA",
    expensesExclVat: "Utgifter ekskl. MVA",
    inputVat: "Inng\u00e5ende MVA",
    vatPayable: "MVA \u00e5 betale",
    payableTo: "Bel\u00f8p \u00e5 betale til Skatteetaten",
    refundFrom: "Tilgode fra Skatteetaten",
    taxAuthority: "Skatteetaten",
    locale: "nb-NO",
  },
  EUR_DE: {
    vatName: "MwSt",
    sidebarLabel: "MwSt",
    reportTitle: "Umsatzsteuererkl\u00e4rung",
    salesSection: "Ums\u00e4tze",
    salesInclVat: "Ums\u00e4tze inkl. MwSt",
    salesExclVat: "Ums\u00e4tze exkl. MwSt",
    outputVat: "Umsatzsteuer",
    expensesSection: "Ausgaben",
    expensesInclVat: "Ausgaben inkl. MwSt",
    expensesExclVat: "Ausgaben exkl. MwSt",
    inputVat: "Vorsteuer",
    vatPayable: "MwSt-Zahllast",
    payableTo: "An das Finanzamt zu zahlen",
    refundFrom: "Erstattung vom Finanzamt",
    taxAuthority: "Finanzamt",
    locale: "de-DE",
  },
  EUR_FR: {
    vatName: "TVA",
    sidebarLabel: "TVA",
    reportTitle: "D\u00e9claration de TVA",
    salesSection: "Ventes",
    salesInclVat: "Ventes TTC",
    salesExclVat: "Ventes HT",
    outputVat: "TVA collect\u00e9e",
    expensesSection: "D\u00e9penses",
    expensesInclVat: "D\u00e9penses TTC",
    expensesExclVat: "D\u00e9penses HT",
    inputVat: "TVA d\u00e9ductible",
    vatPayable: "TVA \u00e0 payer",
    payableTo: "Montant \u00e0 payer aux imp\u00f4ts",
    refundFrom: "Cr\u00e9dit de TVA",
    taxAuthority: "DGFiP",
    locale: "fr-FR",
  },
  EUR_ES: {
    vatName: "IVA",
    sidebarLabel: "IVA",
    reportTitle: "Declaraci\u00f3n de IVA",
    salesSection: "Ventas",
    salesInclVat: "Ventas con IVA",
    salesExclVat: "Ventas sin IVA",
    outputVat: "IVA repercutido",
    expensesSection: "Gastos",
    expensesInclVat: "Gastos con IVA",
    expensesExclVat: "Gastos sin IVA",
    inputVat: "IVA soportado",
    vatPayable: "IVA a pagar",
    payableTo: "A ingresar en Hacienda",
    refundFrom: "A devolver por Hacienda",
    taxAuthority: "Hacienda",
    locale: "es-ES",
  },
  EUR_PT: {
    vatName: "IVA",
    sidebarLabel: "IVA",
    reportTitle: "Declara\u00e7\u00e3o de IVA",
    salesSection: "Vendas",
    salesInclVat: "Vendas com IVA",
    salesExclVat: "Vendas sem IVA",
    outputVat: "IVA liquidado",
    expensesSection: "Despesas",
    expensesInclVat: "Despesas com IVA",
    expensesExclVat: "Despesas sem IVA",
    inputVat: "IVA dedut\u00edvel",
    vatPayable: "IVA a pagar",
    payableTo: "Montante a pagar \u00e0 AT",
    refundFrom: "Reembolso da AT",
    taxAuthority: "AT",
    locale: "pt-PT",
  },
  EUR_IT: {
    vatName: "IVA",
    sidebarLabel: "IVA",
    reportTitle: "Dichiarazione IVA",
    salesSection: "Vendite",
    salesInclVat: "Vendite IVA inclusa",
    salesExclVat: "Vendite IVA esclusa",
    outputVat: "IVA a debito",
    expensesSection: "Spese",
    expensesInclVat: "Spese IVA inclusa",
    expensesExclVat: "Spese IVA esclusa",
    inputVat: "IVA a credito",
    vatPayable: "IVA da versare",
    payableTo: "Da versare all'Agenzia delle Entrate",
    refundFrom: "Credito dall'Agenzia delle Entrate",
    taxAuthority: "Agenzia delle Entrate",
    locale: "it-IT",
  },
  EUR_NL: {
    vatName: "BTW",
    sidebarLabel: "BTW",
    reportTitle: "BTW-aangifte",
    salesSection: "Verkoop",
    salesInclVat: "Verkoop incl. BTW",
    salesExclVat: "Verkoop excl. BTW",
    outputVat: "Verschuldigde BTW",
    expensesSection: "Uitgaven",
    expensesInclVat: "Uitgaven incl. BTW",
    expensesExclVat: "Uitgaven excl. BTW",
    inputVat: "Voorbelasting",
    vatPayable: "Te betalen BTW",
    payableTo: "Te betalen aan de Belastingdienst",
    refundFrom: "Terug te ontvangen van de Belastingdienst",
    taxAuthority: "Belastingdienst",
    locale: "nl-NL",
  },
  NPR: {
    vatName: "VAT",
    sidebarLabel: "VAT",
    reportTitle: "\u0915\u0930 \u092A\u094D\u0930\u0924\u093F\u0935\u0947\u0926\u0928 / VAT Return",
    salesSection: "Sales",
    salesInclVat: "Sales incl. VAT",
    salesExclVat: "Sales excl. VAT",
    outputVat: "Output VAT",
    expensesSection: "Expenses",
    expensesInclVat: "Expenses incl. VAT",
    expensesExclVat: "Expenses excl. VAT",
    inputVat: "Input VAT",
    vatPayable: "VAT Payable",
    payableTo: "Amount payable to IRD Nepal",
    refundFrom: "Refund from IRD Nepal",
    taxAuthority: "IRD",
    locale: "ne-NP",
  },
  GBP: {
    vatName: "VAT",
    sidebarLabel: "VAT",
    reportTitle: "VAT Return",
    salesSection: "Sales",
    salesInclVat: "Sales incl. VAT",
    salesExclVat: "Sales excl. VAT",
    outputVat: "Output VAT",
    expensesSection: "Expenses",
    expensesInclVat: "Expenses incl. VAT",
    expensesExclVat: "Expenses excl. VAT",
    inputVat: "Input VAT",
    vatPayable: "VAT Payable",
    payableTo: "Amount payable to HMRC",
    refundFrom: "Refund from HMRC",
    taxAuthority: "HMRC",
    locale: "en-GB",
  },
  INR: {
    vatName: "GST",
    sidebarLabel: "GST",
    reportTitle: "GST Return",
    salesSection: "Sales",
    salesInclVat: "Sales incl. GST",
    salesExclVat: "Sales excl. GST",
    outputVat: "Output GST",
    expensesSection: "Expenses",
    expensesInclVat: "Expenses incl. GST",
    expensesExclVat: "Expenses excl. GST",
    inputVat: "Input GST",
    vatPayable: "GST Payable",
    payableTo: "Amount payable to GST Council",
    refundFrom: "GST refund",
    taxAuthority: "GST Council",
    locale: "en-IN",
  },
  AUD: {
    vatName: "GST",
    sidebarLabel: "GST",
    reportTitle: "GST Report",
    salesSection: "Sales",
    salesInclVat: "Sales incl. GST",
    salesExclVat: "Sales excl. GST",
    outputVat: "GST on Sales",
    expensesSection: "Expenses",
    expensesInclVat: "Expenses incl. GST",
    expensesExclVat: "Expenses excl. GST",
    inputVat: "GST on Purchases",
    vatPayable: "GST Payable",
    payableTo: "Amount payable to ATO",
    refundFrom: "Refund from ATO",
    taxAuthority: "ATO",
    locale: "en-AU",
  },
  CHF: {
    vatName: "MWST",
    sidebarLabel: "MWST",
    reportTitle: "MWST-Abrechnung",
    salesSection: "Ums\u00e4tze",
    salesInclVat: "Ums\u00e4tze inkl. MWST",
    salesExclVat: "Ums\u00e4tze exkl. MWST",
    outputVat: "Geschuldete MWST",
    expensesSection: "Ausgaben",
    expensesInclVat: "Ausgaben inkl. MWST",
    expensesExclVat: "Ausgaben exkl. MWST",
    inputVat: "Vorsteuer",
    vatPayable: "MWST-Zahllast",
    payableTo: "An die ESTV zu zahlen",
    refundFrom: "R\u00fcckerstattung von der ESTV",
    taxAuthority: "ESTV",
    locale: "de-CH",
  },
};

/**
 * Tax rates by currency/country.
 * rate = standard VAT/GST/tax rate as decimal (0.25 = 25%)
 * inclusive = whether prices typically include tax (true for most countries except US)
 * label = how to describe the amount field
 */
export const TAX_RATES = {
  DKK:    { rate: 0.25, inclusive: true,  label: "inkl. moms" },
  SEK:    { rate: 0.25, inclusive: true,  label: "inkl. moms" },
  NOK:    { rate: 0.25, inclusive: true,  label: "inkl. MVA" },
  EUR:    { rate: 0.21, inclusive: true,  label: "incl. VAT" },
  EUR_DE: { rate: 0.19, inclusive: true,  label: "inkl. MwSt" },
  EUR_FR: { rate: 0.20, inclusive: true,  label: "TTC" },
  EUR_ES: { rate: 0.21, inclusive: true,  label: "con IVA" },
  EUR_PT: { rate: 0.23, inclusive: true,  label: "com IVA" },
  EUR_IT: { rate: 0.22, inclusive: true,  label: "IVA inclusa" },
  EUR_NL: { rate: 0.21, inclusive: true,  label: "incl. BTW" },
  GBP:    { rate: 0.20, inclusive: true,  label: "incl. VAT" },
  NPR:    { rate: 0.13, inclusive: true,  label: "incl. VAT" },
  INR:    { rate: 0.18, inclusive: true,  label: "incl. GST" },
  AUD:    { rate: 0.10, inclusive: true,  label: "incl. GST" },
  CHF:    { rate: 0.081, inclusive: true, label: "inkl. MWST" },
  USD:    { rate: 0,    inclusive: false, label: "excl. Tax" },
  CAD:    { rate: 0.05, inclusive: false, label: "excl. GST" },
  JPY:    { rate: 0.10, inclusive: true,  label: "税込" },
};

/**
 * Get tax config for a currency.
 * @param {string} currencyCode
 * @returns {{ rate: number, inclusive: boolean, label: string }}
 */
export function getTaxConfig(currencyCode) {
  if (!currencyCode) return TAX_RATES.DKK;
  return TAX_RATES[currencyCode] || { rate: 0, inclusive: false, label: "excl. Tax" };
}

/**
 * Calculate tax breakdown from an amount.
 * @param {number} amount - The entered amount
 * @param {string} currencyCode - User's currency
 * @returns {{ amountInclTax: number, amountExclTax: number, taxAmount: number, rate: number, taxName: string }}
 */
export function calcTaxBreakdown(amount, currencyCode) {
  const tax = getTaxConfig(currencyCode);
  const vat = getVatTerms(currencyCode);
  const rate = tax.rate;
  if (!amount || rate === 0) {
    return { amountInclTax: amount || 0, amountExclTax: amount || 0, taxAmount: 0, rate: 0, taxName: vat.vatName };
  }
  if (tax.inclusive) {
    // Amount includes tax → extract tax
    const exclTax = amount / (1 + rate);
    const taxAmt = amount - exclTax;
    return { amountInclTax: amount, amountExclTax: exclTax, taxAmount: taxAmt, rate, taxName: vat.vatName };
  } else {
    // Amount excludes tax → add tax
    const taxAmt = amount * rate;
    return { amountInclTax: amount + taxAmt, amountExclTax: amount, taxAmount: taxAmt, rate, taxName: vat.vatName };
  }
}

// Default English/USD fallback
const DEFAULT_VAT_TERMS = {
  vatName: "Sales Tax",
  sidebarLabel: "Tax/VAT",
  reportTitle: "Tax Report",
  salesSection: "Sales",
  salesInclVat: "Sales incl. Tax",
  salesExclVat: "Sales excl. Tax",
  outputVat: "Output Tax",
  expensesSection: "Expenses",
  expensesInclVat: "Expenses incl. Tax",
  expensesExclVat: "Expenses excl. Tax",
  inputVat: "Input Tax",
  vatPayable: "Tax Payable",
  payableTo: "Amount payable to tax authority",
  refundFrom: "Tax refund",
  taxAuthority: "Tax Authority",
  locale: "en-US",
};

/**
 * Get VAT terminology for a given currency code.
 * @param {string} currencyCode - e.g. "DKK", "EUR_DE", "GBP", "USD"
 * @returns {object} VAT terms object
 */
export function getVatTerms(currencyCode) {
  if (!currencyCode) return VAT_TERMS.DKK;
  return VAT_TERMS[currencyCode] || DEFAULT_VAT_TERMS;
}

/* ──────────────────────────── parseLocaleAmount ────────────────────────
 * The INVERSE of formatKr: read a human-typed / speech-transcribed amount
 * back into a Number, without silently mangling Danish notation.
 *
 * Danish writes money the opposite way round from English:
 *   "1.234,56"  = one thousand two hundred thirty-four kroner, 56 øre
 *   "150,50"    = one hundred fifty kroner, 50 øre
 * so a naive parseFloat(s.replace(/,/g, "")) — the English "strip the
 * thousands commas" idiom — turns 150,50 kr into 15.050 kr (100x) and
 * 2.000 kr into 2 kr. Both silent, both in the books.
 *
 * Rules, in order:
 *   • Both separators present → the RIGHTMOST is the decimal, the other
 *     is grouping.  "1.234,56" → 1234.56   "1,234.56" → 1234.56
 *   • One separator, appearing more than once → grouping.  "1.234.567"
 *   • One separator, exactly 3 digits after it → genuinely ambiguous
 *     ("1.234" is 1234 in DK, 1.234 in EN), so the LOCALE decides.
 *   • One separator, any other digit count → decimal.  "150,5" "45,00"
 *
 * Returns NaN for anything that isn't a number, so callers can refuse
 * rather than book a guess.
 *
 * DO NOT use this on an <input type="number"> value. The browser already
 * normalises those to canonical dot-decimal whatever the user's locale,
 * so "0.134" IS zero-point-one-three-four — but the ambiguity rule above
 * would read its 3-digit tail as a thousands group and return 134. Use
 * parseFloat there. This function is for HUMAN text: speech transcripts,
 * free-text fields, pasted values — anywhere "1.234" might really mean
 * one thousand.
 * ──────────────────────────────────────────────────────────────────────── */

// Locales that use "," as the decimal separator (i.e. "." groups).
const _COMMA_DECIMAL_LOCALE = /^(da|de|nb|nn|no|sv|fi|is|nl|fr|es|it|pt|pl|cs|tr|id|vi|ru|uk|ro|hu|el|hr|sr|sl|sk|bg|lt|lv|et)/i;

export function parseLocaleAmount(raw, locale = "da-DK") {
  if (raw == null) return NaN;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;

  // Drop everything that isn't a digit, separator or leading sign —
  // strips "kr.", "DKK", "kroner", stray spaces and NBSPs.
  let s = String(raw).trim().replace(/[^\d.,-]/g, "");
  // A dangling separator is punctuation, not notation — "1.234,56 kr."
  // reduces to "1.234,56." and that trailing dot would otherwise be read
  // as the decimal point, giving 1.23456.
  s = s.replace(/^[.,]+/, "").replace(/[.,]+$/, "");
  if (!s) return NaN;

  const negative = s.startsWith("-");
  s = s.replace(/-/g, "");
  if (!s) return NaN;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const commaDecimalLocale = _COMMA_DECIMAL_LOCALE.test(String(locale || "da-DK"));

  let decimalSep = null;

  if (lastComma !== -1 && lastDot !== -1) {
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma !== -1 || lastDot !== -1) {
    const sep = lastComma !== -1 ? "," : ".";
    const occurrences = s.split(sep).length - 1;
    const tail = s.slice(s.lastIndexOf(sep) + 1);
    if (occurrences > 1) {
      decimalSep = null;                      // "1.234.567" — grouping
    } else if (tail.length === 3) {
      // Ambiguous: DK reads "1.234" as 1234 and "1,234" as 1.234.
      decimalSep = commaDecimalLocale ? (sep === "," ? "," : null)
                                      : (sep === "." ? "." : null);
    } else {
      decimalSep = sep;                       // "150,5" / "45,00" / "1.5"
    }
  }

  let normalized;
  if (decimalSep === null) {
    normalized = s.replace(/[.,]/g, "");
  } else {
    const groupSep = decimalSep === "," ? "." : ",";
    normalized = s.split(groupSep).join("").replace(decimalSep, ".");
  }

  const n = parseFloat(normalized);
  if (!Number.isFinite(n)) return NaN;
  return negative ? -n : n;
}
