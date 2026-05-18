/**
 * Card — the only way to render a content section in BonBox.
 *
 * Claude-inspired aesthetic:
 *   • warm white surface (cream-tinged in light mode, stone-900 in dark)
 *   • 1px stone-200 border instead of heavy shadow
 *   • generous padding (24px) — content breathes
 *   • single radius (rounded-xl) — no bubbly 2xl
 *
 * Variants:
 *   • default    — the standard surface
 *   • subtle     — bg slightly tinted (for nested cards)
 *   • emphasis   — a little more presence (for "this section matters"
 *                   like the readiness badge at the bottom of a close)
 *
 * Optional header pattern:
 *   <Card.Header title="Today" subtitle="Live" action={<Button …/>} />
 *   <Card.Body>…</Card.Body>
 *
 * Or just pass children directly — the wrapper enforces consistent
 * spacing either way.
 *
 * Interactive cards: pass `as="button"` or `to="/route"` (Link) and
 * the card gets hover/focus states. Otherwise it's a plain div.
 */
import React from "react";
import { Link } from "react-router-dom";

const SURFACE = {
  default:
    "bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800",
  subtle:
    "bg-stone-50 dark:bg-stone-900/60 border border-stone-200/70 dark:border-stone-800/70",
  emphasis:
    "bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-700 " +
    "shadow-sm",
};

const INTERACTIVE_EXTRA =
  " transition-shadow hover:shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-emerald-500 cursor-pointer";

function Card({
  variant = "default",
  to = null,
  onClick = null,
  className = "",
  children,
  ...rest
}) {
  const base =
    "rounded-xl p-5 sm:p-6 " + (SURFACE[variant] || SURFACE.default);
  const interactive = !!(to || onClick);
  const classes =
    base + (interactive ? INTERACTIVE_EXTRA : "") +
    (className ? " " + className : "");

  if (to) {
    return (
      <Link to={to} className={classes} {...rest}>
        {children}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes} {...rest}>
        {children}
      </button>
    );
  }
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

/** Card.Header — top of a card. Title + optional subtitle + action. */
function CardHeader({ title, subtitle, icon = null, action = null }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {icon && <span className="text-stone-500 shrink-0">{icon}</span>}
          <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100 truncate">
            {title}
          </h3>
        </div>
        {subtitle && (
          <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

Card.Header = CardHeader;

export default Card;
