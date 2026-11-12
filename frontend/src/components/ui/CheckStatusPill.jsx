/**
 * CheckStatusPill — the ONE place the egenkontrol status colours live.
 *
 * Colour with meaning (doctrine rules 1/3/4 keep raw emerald inside ui/):
 *   ok    — emerald: registered on time, inside the limit
 *   warn  — amber:   due soon, registered late, a closed deviation
 *   bad   — red:     missing (overdue), an open deviation, out of limit
 *   muted — gray:    later today, "når det sker"
 * Emerald, never green-* (index.css remaps green to the brand accent).
 * Dark mode only through the app's .dark class.
 *
 * Variants:
 *   pill  — dot + words (the list rows, the folder)
 *   text  — words in the tone, no chrome (the "For varmt" line)
 *   cell  — a filled square (the 30-day strip); children = screen-reader text
 *   dot   — a small dot (legends)
 *   count — a small filled count (the sidebar badge)
 */
import React from "react";

const DOT = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  muted: "bg-gray-300 dark:bg-gray-600",
};

const PILL = {
  ok: "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  warn: "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  bad: "bg-red-50 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  muted: "bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
};

const TEXT = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-700 dark:text-red-400",
  muted: "text-gray-600 dark:text-gray-400",
};

const CELL = {
  ok: "bg-emerald-500 dark:bg-emerald-600",
  warn: "bg-amber-400 dark:bg-amber-500",
  bad: "bg-red-500 dark:bg-red-600",
  muted: "bg-gray-200 dark:bg-gray-700",
};

export default function CheckStatusPill({ tone = "muted", variant = "pill", children = null, className = "", title, ...rest }) {
  const t = DOT[tone] ? tone : "muted";
  if (variant === "dot") {
    return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${DOT[t]} ${className}`} {...rest} />;
  }
  if (variant === "cell") {
    return (
      <span title={title} className={`block rounded-lg ${CELL[t]} ${className}`} {...rest}>
        {children ? <span className="sr-only">{children}</span> : null}
      </span>
    );
  }
  if (variant === "count") {
    return (
      <span
        className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold tabular-nums text-white ${t === "bad" ? "bg-red-600" : t === "warn" ? "bg-amber-600" : t === "ok" ? "bg-emerald-600" : "bg-gray-500"} ${className}`}
        {...rest}
      >
        {children}
      </span>
    );
  }
  if (variant === "text") {
    return <span className={`${TEXT[t]} ${className}`} {...rest}>{children}</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[13px] font-medium leading-snug ${PILL[t]} ${className}`}
      {...rest}
    >
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full shrink-0 ${DOT[t]}`} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
