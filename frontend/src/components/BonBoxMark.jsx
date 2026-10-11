/**
 * The BonBox mark — the b ("Rullen", logo system v1, 11 Oct 2026).
 *
 * There is one glyph and this file is it. Import this instead of drawing it.
 * The source of truth is the logo kit, copied to docs/brand/ (README.md and
 * symbol/bonbox-symbol.svg): one path on a 24 x 24 grid, filled with
 * currentColor, so the caller sets the colour with a text-* class.
 *
 * On a tile, the kit's rule is a forest tile with a paper b
 * (`bg-bb-forest text-bb-paper`, tokens in index.css). Size the mark at about
 * 0.8 x the tile so the b fills ~60% of it, the proportion of the kit's app
 * icon. Never put it in a circle, and never make the main b emerald — emerald
 * is the Vagtplan strip only.
 *
 * Props:
 *   size        rendered px (square). Minimum 20 in the interface (kit rule).
 *   title       accessible name. Omit (or pass "") when the word BonBox sits
 *               next to the mark: it is then aria-hidden, as it always was.
 *   strokeWidth accepted for old call sites and ignored — the b is a filled
 *               shape, not a stroke.
 *
 * The PNG/SVG icons in public/ and the iOS AppIcon/Splash are cut from the
 * same kit. If this path ever changes, re-cut them too or the drift starts
 * again.
 */
const BONBOX_MARK_PATH =
  "M5 2.5V13A7.5 7.5 0 0 0 12.5 20.5A7.5 7.5 0 0 0 20 13A5.5 5.5 0 0 0 14.5 7.5A5.5 5.5 0 0 0 9 13A3.5 3.5 0 0 0 12.5 16.5V14A1 1 0 0 1 11.5 13A3 3 0 0 1 14.5 10A3 3 0 0 1 17.5 13A5 5 0 0 1 12.5 18A5 5 0 0 1 7.5 13V2.5Z";

export default function BonBoxMark({
  size = 16,
  // eslint-disable-next-line no-unused-vars -- kept off the <svg> on purpose
  strokeWidth,
  title,
  className = "",
  ...rest
}) {
  const a11y = title
    ? { role: "img", "aria-label": title }
    : { "aria-hidden": "true" };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      {...a11y}
      {...rest}
    >
      <path d={BONBOX_MARK_PATH} />
    </svg>
  );
}
