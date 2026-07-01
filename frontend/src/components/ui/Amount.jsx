/**
 * Amount — the app-wide money-render primitive (Copenhagen / Lunar-grade).
 *
 * Renders a kr. figure so the NUMBER leads and the "kr." token whispers:
 * the amount in tabular-nums, then a de-emphasized, baseline-aligned "kr."
 * at ~0.62em in gray-400. This is the single highest-leverage number-
 * typography move — it makes a figure read like a bank statement, not a
 * spreadsheet cell.
 *
 * Always routes through formatKr (da-DK grouping, literal "kr."), so a
 * missing / NaN value renders an honest "—" (never a confident 0 kr.), and
 * a surface never mixes "kr." with "DKK".
 *
 *   <Amount value={135000} size="hero" />   → 135.000  kr.  (kr. small+light)
 *   <Amount value={n} />                     → inherits parent size/weight
 *   <Amount value={null} />                  → —
 */
import React from "react";
import { formatKr } from "../../utils/currency";

// Only the money HERO earns bold + negative tracking; kpi is the dashboard
// stat number; body is a slight emphasis; unset inherits the parent entirely.
const SIZE = {
  hero: "text-[30px] font-bold leading-none tracking-tight",
  kpi: "text-[26px] font-semibold leading-none tracking-tight",
  body: "font-medium",
};

export default function Amount({ value, decimals = 0, sign = false, size, className = "" }) {
  const str = formatKr(value, { decimals, sign });
  const sizeCls = SIZE[size] || "";

  // Missing / NaN → honest em-dash, never a currency token on no data.
  if (str === "—") {
    return <span className={`tabular-nums ${sizeCls} ${className}`.trim()}>—</span>;
  }

  // Split the trailing " kr." so the amount leads and the token de-emphasizes.
  const hasToken = /\skr\.$/.test(str);
  const num = hasToken ? str.replace(/\skr\.$/, "") : str;

  return (
    <span className={`inline-flex items-baseline tabular-nums ${sizeCls} ${className}`.trim()}>
      <span>{num}</span>
      {hasToken && (
        <span className="text-[0.62em] font-medium text-gray-400 dark:text-gray-500 ml-0.5">
          kr.
        </span>
      )}
    </span>
  );
}
