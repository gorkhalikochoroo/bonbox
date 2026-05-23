/**
 * Card — the only way to render a content section in BonBox.
 *
 * Sidebar-matched aesthetic (palette unified with Layout.jsx, May 2026):
 *   • neutral white surface in light mode, gray-900 in dark mode
 *   • 1px gray-200 border instead of heavy shadow
 *   • generous padding (24px) — content breathes
 *   • single radius (rounded-xl) — no bubbly 2xl
 *
 * Why gray-* and not stone-* (which the old design tokens used)?
 *   The sidebar (Layout.jsx) uses gray-100 / gray-400 / gray-700 / gray-900
 *   throughout. Cards in the page area used to live in a parallel
 *   stone-* palette which read as "warmer / off-tone" next to the
 *   sidebar — subtle but ~5pt of color drift per surface. Unifying on
 *   gray-* makes the whole app read as a single calm canvas.
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
    "bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800",
  subtle:
    "bg-gray-50 dark:bg-gray-900/60 border border-gray-200/70 dark:border-gray-800/70",
  emphasis:
    "bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 " +
    "shadow-sm",
};

const INTERACTIVE_EXTRA =
  " transition-shadow hover:shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-emerald-500 " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-white " +
  "dark:focus-visible:ring-offset-gray-900 cursor-pointer";

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
          {icon && <span className="text-gray-500 shrink-0">{icon}</span>}
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
            {title}
          </h3>
        </div>
        {subtitle && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
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
