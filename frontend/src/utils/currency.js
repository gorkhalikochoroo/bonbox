/** Convert EUR_PT -> EUR, EUR_DE -> EUR, etc. for display */
export function displayCurrency(code) {
  if (!code) return "DKK";
  return code.startsWith("EUR_") ? "EUR" : code;
}
