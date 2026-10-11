/**
 * Wide-screen layout for the landing page: fill the screen, scale with it.
 *
 * Owner, 11 Oct 2026, looking at the page on a ~2000px screen: "still looks
 * gaps — should auto fill according to screen size". Measured: every band was
 * a fixed 1052px column (1180px box, 64px gutters), so the side margins grew
 * from 13% of the screen at 1440 to 29.5% at 2560, and type and artwork
 * stopped growing at ~1290px. A 2560 screen showed a 1440 layout floating in
 * the middle.
 *
 * NOTHING HERE APPLIES BELOW 1041px. Every class is behind min-[1041px]: or
 * min-[1441px]:, the width where the two-column layouts start, so phones and
 * tablets render exactly as before.
 *
 * Three rules, from 1041px up:
 *
 * 1. GUTTERS ARE A SHARE OF THE SCREEN. Each band's content box is the screen
 *    minus 5% on each side (WIDE). Nav, footer and every band use the same
 *    box, so their edges line up.
 *
 * 2. ABOVE 1440px THE PAGE GROWS WITH THE SCREEN. The layout is fitted at
 *    1440px. Wider than that, the root sets --lx = screen width / 1440 (1 at
 *    1440, 1.33 at 1920, capped at 1.65 from 2376px), and every block of text
 *    and every card is drawn at --lx via CSS `zoom` (TEXT). Past the cap the
 *    content box stops growing (WIDE) and the gutters take the extra, so a
 *    3440px monitor gets the 2376px composition centred, not a stretched
 *    one. Zoom, not a font-size per element, because it scales the type, the
 *    spacing around it, the icons and the buttons by the same factor: the
 *    hand-fitted proportions of the 1440 layout are kept, just larger. Band
 *    padding and column gaps use calc(… * var(--lx)) for the same reason.
 *
 *    100vw / 1440px is a ratio of two lengths, which CSS can only turn into a
 *    plain number with tan(atan2(a, b)) — the tangent of the angle whose
 *    sides are a and b is a / b. Supported by Chrome 111, Safari 15.4 and
 *    Firefox 108 (zoom itself: Firefox 126). In a browser without it --lx
 *    stays 1 (see ROOT), the artwork zoom declarations are dropped, and the
 *    page renders at its 1440 sizes inside the wider gutters.
 *
 * 3. PRODUCT ARTWORK FILLS ITS COLUMN. The hero card, floor plan, phone fan,
 *    AI chat and gavekort cards are fixed-size drawings. Left at their own
 *    width they sat centred in a column that kept growing, which is where the
 *    dead gap between the two columns came from. Each now sits in a size
 *    container (CELL) and is zoomed to the column's width: 100cqw is the
 *    column, and tan(atan2(100cqw, 600px)) is "how many 600px drawings fit".
 *    The lower bound is 1, so between 1041 and ~1300px, where a column is
 *    narrower than the drawing, the card reflows at its own size exactly as
 *    before; only the phone fan, which cannot reflow, may go below 1. Those
 *    class strings live in their components because the natural width
 *    differs per drawing (Tailwind only sees complete class names).
 */

/**
 * Band content box: 5% gutters. Above 1440px the content is capped at the
 * 1440 layout's content width (1296px) times --lx, so once --lx stops at its
 * cap the composition stays the 1440 one, scaled, and the gutters take the
 * rest instead of the columns stretching.
 */
export const WIDE =
  "min-[1041px]:max-w-none min-[1041px]:px-[min(5vw,128px)] min-[1441px]:max-w-[calc(1296px*var(--lx)+2*min(5vw,128px))]";

/** Band vertical padding. 6vw is 86.4px at 1440; above that it scales with --lx. */
export const WIDE_PY = "min-[1441px]:py-[calc(86.4px*var(--lx))]";

/** A block of text or a card: drawn at --lx above 1440px. */
export const TEXT = "min-[1441px]:[zoom:var(--lx)]";

/** Every direct child drawn at --lx (bands that are a plain stack). */
export const TEXT_CHILDREN = "min-[1441px]:[&>*]:[zoom:var(--lx)]";

/** A column whose artwork scales to its width (100cqw = this element). */
export const CELL = "min-[1041px]:[container-type:inline-size]";

/**
 * The root of the page: defines --lx. Set once, on LandingV2Page.
 * --lx is 1 first and only becomes the ratio where the browser can compute
 * it. Without that guard an older browser would carry the unparseable
 * expression into every calc(… * var(--lx)) and lose those declarations
 * outright — band padding and column gaps collapsing to 0 — instead of
 * keeping the 1440 sizes.
 */
export const ROOT =
  "min-[1441px]:[--lx:1] min-[1441px]:supports-[width:calc(tan(atan2(100vw,1440px))*1px)]:[--lx:clamp(1,tan(atan2(100vw,1440px)),1.65)]";
