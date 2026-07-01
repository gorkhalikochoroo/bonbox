/**
 * Empty — the only empty-state pattern in BonBox (Copenhagen / Lunar-grade).
 *
 * A brand-new account sees empty states everywhere, so this one primitive
 * sets the app's first impression. The icon is a Lucide OUTLINE component
 * (never an emoji) sitting in a calm gray chip — not display-size emoji.
 *
 *   import { Package } from "lucide-react";
 *   <Empty
 *     icon={Package}
 *     title="No inventory yet"
 *     body="Add items to track stock, reorders, and expiry dates."
 *     cta={<Button as={Link} to="/inventory">Add first item</Button>}
 *   />
 *
 * Designed to sit inside a Card. For a full-page empty state, wrap it in
 * <Card variant="subtle"> and pass size="hero".
 *
 * Size variants:
 *   • inline  — small, top of a list with the body below (e.g. "no results")
 *   • block   — default; centers in the available height
 *   • hero    — big, full-page placeholder
 *
 * `icon` accepts a Lucide component (preferred). A rendered element is still
 * honored for legacy call sites; a stray emoji string is quietly ignored so
 * no empty state can ever render an emoji again.
 */
import React from "react";
import { Inbox } from "lucide-react";

const SIZES = {
  inline: "py-6 text-center",
  block: "py-10 text-center",
  hero: "py-16 sm:py-20 text-center",
};

// The chip is a surface (rounded-xl), sized on the 4/8 grid; the glyph inside
// is a real icon at icon-scale, tinted the calm gray-400 empty-state gray.
const CHIP = { inline: "w-9 h-9", block: "w-11 h-11", hero: "w-14 h-14" };
const GLYPH = { inline: "w-4 h-4", block: "w-5 h-5", hero: "w-6 h-6" };

export default function Empty({
  icon: Icon = Inbox,
  title,
  body = "",
  cta = null,
  size = "block",
  className = "",
}) {
  const chip = CHIP[size] || CHIP.block;
  const glyph = GLYPH[size] || GLYPH.block;

  let glyphNode;
  if (typeof Icon === "function") {
    glyphNode = <Icon className={glyph} strokeWidth={1.75} aria-hidden="true" />;
  } else if (React.isValidElement(Icon)) {
    glyphNode = Icon;
  } else {
    glyphNode = <Inbox className={glyph} strokeWidth={1.75} aria-hidden="true" />;
  }

  return (
    <div className={(SIZES[size] || SIZES.block) + " " + className}>
      <div
        className={`mx-auto mb-3 flex items-center justify-center rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 ${chip}`}
      >
        {glyphNode}
      </div>
      {title && (
        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-1">
          {title}
        </h4>
      )}
      {body && (
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto leading-relaxed">
          {body}
        </p>
      )}
      {cta && <div className="mt-4">{cta}</div>}
    </div>
  );
}
