/**
 * Empty — the only empty-state pattern in BonBox.
 *
 * Before this, six different empty states existed across the app
 * (some returned null, some emoji+text, some had CTAs, some didn't).
 * This component bakes the one true pattern:
 *
 *   <Empty
 *     icon="📦"
 *     title="No inventory yet"
 *     body="Add items to track stock, reorders, and expiry dates."
 *     cta={<Button as={Link} to="/inventory">Add first item</Button>}
 *   />
 *
 * Designed to sit inside a Card. If you need a full-page empty state,
 * wrap it in <Card variant="subtle">.
 *
 * Size variants:
 *   • inline  — small, sits at the top of a list with the body still
 *               having room beneath (e.g. "no results yet" in a search)
 *   • block   — default; centers in the available height
 *   • hero    — big, used as a full-page placeholder
 */
import React from "react";

const SIZES = {
  inline: "py-6 text-center",
  block: "py-10 text-center",
  hero: "py-16 sm:py-20 text-center",
};

const ICON_SIZES = {
  inline: "text-3xl",
  block: "text-4xl",
  hero: "text-5xl sm:text-6xl",
};

export default function Empty({
  icon = "📭",
  title,
  body = "",
  cta = null,
  size = "block",
  className = "",
}) {
  return (
    <div className={(SIZES[size] || SIZES.block) + " " + className}>
      <div className={(ICON_SIZES[size] || ICON_SIZES.block) + " mb-3 opacity-90"}>
        {icon}
      </div>
      {title && (
        <h4 className="text-sm font-semibold text-stone-800 dark:text-stone-100 mb-1">
          {title}
        </h4>
      )}
      {body && (
        <p className="text-sm text-stone-500 dark:text-stone-400 max-w-sm mx-auto leading-relaxed">
          {body}
        </p>
      )}
      {cta && <div className="mt-4">{cta}</div>}
    </div>
  );
}
