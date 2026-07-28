/**
 * The BonBox mark — the notepad shape, and the only correct one.
 *
 * There is one glyph and this file is it. Before this component existed the
 * mark was hand-drawn at each brand surface and they drifted apart: Layout
 * drew this notepad, the v2 landing nav and footer drew Lucide's `Receipt`
 * (a torn-edge slip with a $ in it), and the generated favicon/app icons were
 * cut from the Receipt version — so bonbox.dk, the app chrome and the icon on
 * a shared link were three different logos. Import this instead of drawing it.
 *
 * Geometry is the one Layout.jsx has always used, on a 24x24 box:
 *   a rounded page, and three rules — long, long, short.
 * Stroke is currentColor, so the caller sets the colour with a text-* class
 * exactly as it did with the Lucide icon it replaces.
 *
 * The PNG/SVG icons in public/ are generated from these same numbers — see
 * the generator note in that folder's commit. If this path ever changes, the
 * icons have to be re-cut or the drift starts again.
 */
export default function BonBoxMark({
  size = 16,
  strokeWidth = 2.2,
  className = "",
  ...rest
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}
