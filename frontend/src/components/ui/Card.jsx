/**
 * Card — the only way to render a content section in BonBox.
 *
 * Sidebar-matched aesthetic (palette unified with Layout.jsx, May 2026):
 *   • neutral surface one rung above the page ground
 *   • 1px hairline instead of heavy shadow
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
 * SURFACE LADDER (Sep 2026 — see the ladder block in index.css).
 *   This file used to hard-code `dark:bg-gray-900`, which is the EXACT colour
 *   of the dark page ground — so a resting card was a 1.00:1 rectangle and the
 *   only thing drawing it was a hairline lighter than the card it outlined.
 *   Meanwhile ~400 hand-rolled call sites used dark:bg-gray-800 and separated
 *   fine. Cards now read the ladder tokens, which land on gray-800 in dark
 *   (1.21:1 against the ground) and white in light — so the primitive and the
 *   hand-rolled surfaces finally say the same thing.
 *
 *   The tokens are written as `bg-[rgb(var(--…))]` rather than a class defined
 *   in index.css on purpose: an arbitrary utility lands in Tailwind's own
 *   utilities layer, so a caller passing `className="bg-…"` still overrides it
 *   by source order, exactly as it did when this said `bg-white`.
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

// The three rungs of the ladder, resolved per theme by index.css:
//   default  — rung 1, a resting card sitting on the ground
//   subtle   — rung ½. Half a step below a card, NOT the ground: this variant
//              is used both nested inside a card and standing alone on the bare
//              page (19 call sites, ProfilePage and SubscriptionPage among
//              them), so it has to be visible against BOTH. In dark it is
//              1.10:1 from each of them.
//   emphasis — rung 2, lifted off its neighbours (stronger hairline + shadow;
//              in light nothing is lighter than white, so the shadow IS the
//              lift — see the ladder block's note)
const SURFACE = {
  default:
    "bg-[rgb(var(--surface-card))] border border-[rgb(var(--surface-line))]",
  subtle:
    "bg-[rgb(var(--surface-subtle))] border border-[rgb(var(--surface-line))]",
  emphasis:
    "bg-[rgb(var(--surface-raised))] border border-[rgb(var(--surface-line-strong))] " +
    "shadow-sm",
};

// Focus ring on the brand accent — one of the five identity uses in the BRAND
// GREEN block. The ring used to be a fixed `emerald-500`, which measured
// 2.54:1 against a white card: below the 3:1 WCAG non-text floor, so the
// keyboard affordance was the least visible thing on the surface in light mode.
// The token is emerald-600 in light (3.77:1) and emerald-400 in dark (7.64:1).
// The OFFSET is the card itself, not a hard-coded white/gray-900 pair, so the
// ring keeps its gap on whatever rung the card is on.
const INTERACTIVE_EXTRA =
  " transition-shadow hover:shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-[rgb(var(--brand-green-accent))] " +
  "focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-[rgb(var(--surface-card))] cursor-pointer";

function Card({
  variant = "default",
  to = null,
  onClick = null,
  padding = "default",
  className = "",
  children,
  ...rest
}) {
  // Density knob — `compact` is opt-in (the /expenses capture keypad asks
  // for a tighter card). Default keeps the byte-identical p-5 sm:p-6 token,
  // so every other consumer renders exactly as before. Swap the TOKEN here
  // rather than appending a `p-4` via className — two padding utilities on
  // one element resolve by Tailwind source order, which is unpredictable.
  const pad = padding === "compact" ? "p-4" : "p-5 sm:p-6";
  const base =
    "rounded-xl " + pad + " " + (SURFACE[variant] || SURFACE.default);
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
function CardHeader({ title, subtitle, icon = null, action = null, dense = false }) {
  return (
    <div className={"flex items-start justify-between gap-3 " + (dense ? "mb-3" : "mb-4")}>
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
