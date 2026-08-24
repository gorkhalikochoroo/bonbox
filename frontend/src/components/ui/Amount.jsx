/**
 * Amount — the app-wide money-render primitive (Copenhagen / Lunar-grade).
 *
 * Renders a money figure so the NUMBER leads and the currency token
 * whispers: the amount in tabular-nums, then a de-emphasized, baseline-
 * aligned token at ~0.62em in gray-400. This is the single highest-
 * leverage number-typography move — it makes a figure read like a bank
 * statement, not a spreadsheet cell.
 *
 * DKK (the default) routes through formatKr (da-DK grouping, literal
 * "kr." — a Danish owner reads a bank statement, never "DKK"). Pass a
 * `currency` prop for user-currency surfaces: non-DKK routes through
 * formatMoney (locale-correct grouping + the "EUR"/"GBP" code token),
 * and the code gets the same whisper treatment as "kr.". Either way a
 * missing / NaN value renders an honest "—" (never a confident 0 kr.),
 * and one surface never mixes "kr." with "DKK".
 *
 *   <Amount value={135000} size="hero" />          → 135.000  kr.  (kr. small+light)
 *   <Amount value={n} currency={user?.currency} /> → 15.000  kr.  (DKK) / 15.000  EUR
 *   <Amount value={n} />                            → inherits parent size/weight
 *   <Amount value={null} />                         → —
 */
import React from "react";
import { formatOwnerMoney } from "../../utils/currency";

// Only the money HERO earns bold + negative tracking; kpi is the dashboard
// stat number; body is a slight emphasis; unset inherits the parent entirely.
// Both display sizes step down on a phone and land back on the canonical
// desktop size from sm: up, so tablet and desktop stay pixel-identical — the
// same mobile-only rule StatCard's dense scale follows. A 30px hero and a 26px
// kpi were desktop figures rendered unchanged on a 402pt screen, where a stack
// of three "0 kr." cards could take more vertical room than the content under
// them. The number still leads; it just stops shouting on a handset.
const SIZE = {
  hero: "text-[24px] sm:text-[30px] font-bold leading-none tracking-tight",
  kpi: "text-[20px] sm:text-[26px] font-semibold leading-none tracking-tight",
  body: "font-medium",
};

export default function Amount({ value, decimals = 0, sign = false, size, currency, className = "" }) {
  // Same branch as the string helper (formatOwnerMoney): no currency prop
  // or DKK → the Danish "kr." presentation; anything else → formatMoney's
  // locale + trailing code. One source of truth for the owner-money rules.
  const str = formatOwnerMoney(value, currency || "DKK", { decimals, sign });
  const sizeCls = SIZE[size] || "";

  // Missing / NaN → honest em-dash, never a currency token on no data.
  if (str === "—") {
    return <span className={`tabular-nums ${sizeCls} ${className}`.trim()}>—</span>;
  }

  // Split the trailing token (" kr." or " EUR") so the amount leads and
  // the token de-emphasizes.
  const m = str.match(/\s(kr\.|[A-Z]{2,4})$/);
  const token = m ? m[1] : null;
  const num = m ? str.slice(0, m.index) : str;

  return (
    <span className={`inline-flex items-baseline tabular-nums ${sizeCls} ${className}`.trim()}>
      <span>{num}</span>
      {token && (
        <span className="text-[0.62em] font-medium text-gray-400 dark:text-gray-500 ml-0.5">
          {token}
        </span>
      )}
    </span>
  );
}
