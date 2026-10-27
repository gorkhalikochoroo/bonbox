// The public booking page's picker tiles — party size, day and time (R3,
// "Refined, finished", judge 24 Oct 2026).
//
// Booking-local on purpose: the shared ui/Chip serves amount presets, filters
// and day pickers across the owner app and keeps its outlined look. Here the
// 29 outlined boxes read as a form, so they become quiet tiles:
//   rest    gray-50 fill on a 6 % hairline
//   hover   one rule for all three pickers, fine pointers only
//   picked  one calm ink (gray-900) with a 1–2 px contact shadow
//   closed  no box at all — the faded day and its word carry the message
// The motion lives in index.css (`.bb-tile`): a new pick settles in 200 ms,
// the released chip lets go in 120 ms, and a touch press eases back over
// 200 ms. Every class has its dark pair for the standalone page (the embed
// forces light).
//
// WHY 450 px (`min-[450px]:`). The page has two layouts: a phone (the date
// strip a swipe rail, the widget flat — it IS the page) and a frame in a
// restaurant's website or a bigger screen (a date grid, balanced times, the
// one card). The owner's snippet is 460 px wide (some hosts make it 520), so
// `sm:` (640) never fired there and the rail cut a chip at the frame's edge.
// The judge proposed 480, measured in a 520 px frame; at the default 460 that
// would still have been the phone layout. 450 sits above every phone (the
// widest, iPhone 16 Pro Max, is 440 — its fold ladder stays as measured) and
// below the snippet's 460.

export const TILE_REST =
  "bb-tile border bg-gray-50 border-gray-900/[0.06] text-gray-800 " +
  "dark:bg-white/[0.04] dark:border-white/[0.08] dark:text-gray-100";

export const TILE_HOVER =
  "pointer-fine:hover:bg-gray-100 pointer-fine:hover:border-gray-900/[0.12] " +
  "dark:pointer-fine:hover:bg-white/[0.08] dark:pointer-fine:hover:border-white/[0.16]";

// The contact shadow composes with the focus ring (Tailwind 4 stacks
// --tw-shadow under --tw-ring-shadow), so a focused pick keeps both.
// `bb-pick` (R5): under a venue's accent colour ([data-bb-accent] on the
// page root, index.css "BOOKING ACCENT") the pick wears that colour instead
// of the ink, with its text picked by contrast. Without one, nothing changes.
export const TILE_PICKED =
  "bb-tile bb-pick border bg-gray-900 border-gray-900 text-white " +
  "shadow-[0_1px_2px_rgb(16_24_40/0.16),0_2px_6px_-2px_rgb(16_24_40/0.18)] " +
  "dark:bg-gray-100 dark:border-gray-100 dark:text-gray-900 dark:shadow-[0_1px_2px_rgb(0_0_0/0.45)]";

export const TILE_CLOSED =
  "bb-tile border border-transparent bg-transparent text-gray-900 dark:text-gray-100";

/** The class set for one tile. */
export function tileClass({ picked = false, closed = false } = {}) {
  if (closed) return TILE_CLOSED;
  return picked ? TILE_PICKED : TILE_REST + " " + TILE_HOVER;
}

// The skeleton is the shape of what replaces it: tiles of the same material,
// 44 px at 12 px corners, the grid's own columns, three rows reserved — the
// block used to jump from 104 to 148 px when the times landed.
export const SKELETON_TILE =
  "h-11 rounded-xl bg-gray-50 border border-gray-900/[0.06] " +
  "dark:bg-white/[0.04] dark:border-white/[0.08] motion-safe:animate-[bbBreathe_1.6s_ease-in-out_infinite]";
export const SKELETON_GRID = "grid grid-cols-4 min-[450px]:grid-cols-5 gap-2";
/** 3 rows: 12 tiles below 450 px (4 across), 15 from 450 px (5 across). */
export const SKELETON_COUNT = 15;
export const skeletonTileClass = (i) => SKELETON_TILE + (i >= 12 ? " max-[450px]:hidden" : "");

/**
 * Columns for a service's times, so no time sits alone on its last row.
 * Below 450 px the grid is 4 across, from 450 px 5 across (the snippet is
 * 460–520 px, so `sm:` at 640 never fired inside a restaurant's website).
 * When the count would leave one time alone, the next candidate is taken:
 * phone 4 → 5 → 3, from 450 px 5 → 6 → 4. 11 times → 6 + 5 from 450 px,
 * 9 times → 5 + 4 on a phone, 21 → 3 rows of 7 on a phone.
 * With a scarcity note under the digits ("Sidste bord") the columns stay put:
 * a narrower chip would cut the note.
 * Whole class names (Tailwind reads this file for them).
 */
const PHONE_COLS = { 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };
const WIDE_COLS = { 4: "min-[450px]:grid-cols-4", 5: "min-[450px]:grid-cols-5", 6: "min-[450px]:grid-cols-6" };
const balanced = (n, candidates) => candidates.find((c) => n <= c || n % c !== 1) ?? candidates[0];

export function timeGridCols(n, { notes = false } = {}) {
  const count = Number(n) || 0;
  const phone = notes ? 4 : balanced(count, [4, 5, 3]);
  const wide = notes ? 5 : balanced(count, [5, 6, 4]);
  return `${PHONE_COLS[phone]} ${WIDE_COLS[wide]}`;
}

/**
 * Columns for the date strip from 450 px up: a window of up to 8 days sits in
 * ONE row (8 days in a 7-column grid left the 8th alone on a second row; as a
 * rail at 520 px the 6th chip was cut at the frame's edge). Never fewer than
 * 5 columns, so a short window keeps day-sized chips. Longer windows keep two
 * weeks of 7.
 */
export function dateRailCols(railLen) {
  const n = Number(railLen) || 0;
  return n <= 8 ? Math.max(n, 5) : 7;
}
