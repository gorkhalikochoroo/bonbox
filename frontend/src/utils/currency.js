/** Convert EUR_PT -> EUR, EUR_DE -> EUR, etc. for display */
export function displayCurrency(code) {
  if (!code) return "DKK";
  return code.startsWith("EUR_") ? "EUR" : code;
}

/**
 * VAT terminology by currency/country.
 * Returns localized terms for VAT concepts based on the user's currency selection.
 */
const VAT_TERMS = {
  DKK: {
    vatName: "Moms",
    sidebarLabel: "Moms",
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
