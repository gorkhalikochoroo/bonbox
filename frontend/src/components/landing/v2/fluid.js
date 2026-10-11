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
 * From 1041px up:
 *
 * 1. THE BOX FILLS THE SCREEN. Each band's content box is the screen minus
 *    5% on each side (WIDE), up to 2138px of content (reached at 2376px; a
 *    2560 screen keeps 8% each side, a 3440 one gets wider margins rather
 *    than 3000px lines). Nav, footer and every band use the same box, so
 *    their edges line up. The box does NOT depend on the type scale below.
 *
 * 2. TYPE GROWS AT HALF THE SCREEN'S RATE, AND STOPS AT 1.4. The layout is
 *    fitted at 1440px. Wider than that the root sets
 *      --lx = 1 + (screen / 1440 - 1) / 2,  capped at 1.4
 *    (1.17 at 1920, 1.39 at 2560), and every block of text and every card
 *    is drawn at --lx with CSS `zoom` (TEXT). Zoom, not a font-size per
 *    element, because it scales the type, the spacing around it, the icons
 *    and the buttons by the same factor: the hand-fitted proportions of the
 *    1440 layout are kept. Band padding and column gaps use
 *    calc(… * var(--lx)) for the same reason.
 *    Why half rate and a cap (review, 11 Oct): at the full rate (screen /
 *    1440, up to 1.65) the type grew one-for-one with the window, so the
 *    browser's own zoom stopped working — at 1920 zooming out to 80% left the
 *    text the same size, and 200% made it only ~1.2x bigger at 2560 (WCAG
 *    1.4.4, failure F94) — and a 2560 screen read as large print (92px h1,
 *    28px body). At half rate browser zoom still moves the text in both
 *    directions, and the largest size is 1.4x the smallest, well inside the
 *    2.5x that keeps 200% text reachable with browser zoom.
 *    The nav and the footer are chrome and grow slower still: --lc grows at
 *    a quarter of the rate and stops at 1.2 (79px nav at 2560, not 110px).
 *
 *    100vw / 2880px is a ratio of two lengths, which CSS can only turn into a
 *    plain number with tan(atan2(a, b)) — the tangent of the angle whose
 *    sides are a and b is a / b. Supported by Chrome 111, Safari 15.4 and
 *    Firefox 108; zoom itself by Chrome, Safari and Firefox 126. The scales
 *    are only set where `zoom` accepts that exact expression (ROOT's
 *    @supports tests zoom, not width), so a browser that cannot zoom by it
 *    keeps --lx and --lc at 1, drops the artwork zoom declarations, and
 *    renders the 1440 sizes inside the wider box. Checked 11 Oct 2026 in
 *    Chromium and in the system WebKit (Safari 27): same zoom values and the
 *    same boxes to within 3px at 1280-2560.
 *
 * 3. PRODUCT ARTWORK FILLS ITS COLUMN, BUT NEVER OUT-RANKS THE COPY. The hero
 *    card, booking card, floor plan, phone fan, AI chat and gavekort cards
 *    are fixed-size drawings. Left at their own width they sat centred in a
 *    column that kept growing, which is where the dead gap between the two
 *    columns came from. Each sits in a size container (CELL) and is zoomed
 *    to the column's width: 100cqw is the column, tan(atan2(100cqw, 600px))
 *    is "how many 600px drawings fit". The lower bound is 1, so between 1041
 *    and ~1300px, where a column is narrower than the drawing, the card
 *    reflows at its own size exactly as before (the phone fan, which cannot
 *    reflow, may go below 1).
 *    The upper bound ties the artwork to the copy (review, 11 Oct: the chat's
 *    bubbles came out bigger than the paragraph explaining them):
 *      - UI mock-ups full of running text (hero card, booking card, AI chat)
 *        stop at 1.1 x the type scale (--la): their running text (13-14px)
 *        stays below the 17px copy beside them at every width.
 *      - Drawings with little text (floor plan, phone fan, gavekort cards,
 *        running text 9-11.5px) stop at 1.3 x (--ld).
 *    A block-level mock-up wider than its drawing at that zoom lays out a
 *    little wider instead (the column still ends where the card ends).
 *    The hero card is also capped by the screen's HEIGHT so it ends above
 *    the fold (ART_HERO_CARD).
 */

/**
 * Band content box: 5% gutters, content capped at 2138px (0.9 x 2376).
 * Independent of --lx: the type grows slower than the screen, the box does
 * not, so the gutters hold at 5% up to 2376px.
 */
export const WIDE =
  "min-[1041px]:max-w-none min-[1041px]:px-[min(5vw,128px)] min-[1441px]:max-w-[calc(2138px+2*min(5vw,128px))]";

/** Band vertical padding. 6vw is 86.4px at 1440; above that it scales with --lx. */
export const WIDE_PY = "min-[1441px]:py-[calc(86.4px*var(--lx))]";

/** A block of text or a card: drawn at --lx above 1440px. */
export const TEXT = "min-[1441px]:[zoom:var(--lx)]";

/** Every direct child drawn at --lx (bands that are a plain stack). */
export const TEXT_CHILDREN = "min-[1441px]:[&>*]:[zoom:var(--lx)]";

/** Nav and footer contents: drawn at --lc, the slower chrome scale. */
export const CHROME_CHILDREN = "min-[1441px]:[&>*]:[zoom:var(--lc)]";

/** A column whose artwork scales to its width (100cqw = this element). */
export const CELL = "min-[1041px]:[container-type:inline-size]";

/*
 * Artwork zoom, one class per drawing: the natural width differs per drawing
 * and Tailwind only sees complete class names. Each is
 *   clamp(lower, column / natural width, cap)
 * with cap --la (UI mock-ups) or --ld (drawings); see rule 3 above.
 */

/**
 * Hero dashboard card, 600px drawing, ~624px tall. Besides the width and the
 * --la cap it is capped by the screen height: the card's top sits at
 * nav (66 x --lc) + hero top padding (43.2 x --lx), and its bottom must stay
 * 16px above the fold, so zoom <= (100svh - that - 16px) / 624px. At full
 * width-only scale its profit bar ended at y=998 at 1920 and fell below the
 * fold of a 1920x1080 monitor's ~950px browser window. Never below 1: on a
 * screen too short for the natural card (1280x720) it is cut exactly as
 * before.
 */
export const ART_HERO_CARD =
  "min-[1041px]:[zoom:clamp(1,min(tan(atan2(100cqw,600px)),tan(atan2(100svh_-_66px*var(--lc)_-_43.2px*var(--lx)_-_16px,624px))),var(--la))]";

/** Booking card (a cell's child), 440px drawing. */
export const ART_BOOKING =
  "min-[1041px]:[&>*]:[zoom:clamp(1,tan(atan2(100cqw,440px)),var(--la))]";

/** AI chat panel, 400px drawing. */
export const ART_CHAT =
  "min-[1041px]:[zoom:clamp(1,tan(atan2(100cqw,400px)),var(--la))]";

/** Floor plan (a cell's child), 600px drawing. */
export const ART_FLOOR =
  "min-[1041px]:[&>*]:[zoom:clamp(1,tan(atan2(100cqw,600px)),var(--ld))]";

/** Phone fan (a cell's child), ~800px painted; may go below 1 (see above). */
export const ART_FAN =
  "min-[1041px]:[&>*]:[zoom:clamp(0.5,tan(atan2(100cqw,800px)),var(--ld))]";

/** Gavekort card pair, 430px drawing. */
export const ART_GAVEKORT =
  "min-[1041px]:[zoom:clamp(1,tan(atan2(100cqw,430px)),var(--ld))]";

/**
 * The root of the page: defines the scales. Set once, on LandingV2Page.
 * Each is a plain number first and only becomes the ratio where `zoom`
 * accepts it. Without that guard an older browser would carry the
 * unparseable expression into every calc(… * var(--lx)) and lose those
 * declarations outright — band padding and column gaps collapsing to 0 —
 * instead of keeping the 1440 sizes; and a browser that parses the ratio
 * but has no `zoom` would grow the padding and gaps around text that stays
 * at 1x. --la and --ld are defined from 1041px
 * because the artwork caps apply from there (at 1.1 and 1.3 up to 1440px).
 */
export const ROOT = [
  "min-[1041px]:[--lx:1]",
  "min-[1041px]:[--lc:1]",
  "min-[1041px]:[--la:calc(var(--lx)*1.1)]",
  "min-[1041px]:[--ld:calc(var(--lx)*1.3)]",
  // Complete class names (Tailwind does not see interpolated ones).
  "min-[1441px]:supports-[zoom:clamp(1,0.5_+_tan(atan2(100vw,2880px)),1.4)]:[--lx:clamp(1,0.5_+_tan(atan2(100vw,2880px)),1.4)]",
  "min-[1441px]:supports-[zoom:clamp(1,0.75_+_tan(atan2(100vw,5760px)),1.2)]:[--lc:clamp(1,0.75_+_tan(atan2(100vw,5760px)),1.2)]",
].join(" ");
