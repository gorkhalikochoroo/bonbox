// The booking page's wait, in ONE shape for all three moments it can show
// (booking R5, "fast on slow phones"):
//   1. index.html, at the first paint — before any of the app's code has
//      arrived (scripts/bookingBoot.mjs writes skeletonHtml() into the
//      parse-time script; a blank white box used to sit there for ~3.4 s on
//      slow 4G);
//   2. the route's Suspense fallback while the page's own code downloads
//      (App.jsx GuestPage → BookingSkeleton);
//   3. the page itself while its data is on the way (ReservationPublicPage).
// Same markup, same classes, so the hand-over between them is invisible:
// nothing moves, nothing flashes. Plain JS (no JSX, no imports) on purpose —
// vite.config.js imports it at build time to write the HTML version.
//
// The geometry is the R3 skeleton's (judge 24 Oct): the embed's one card from
// 450 px, the flat embed, the phone/tablet column and the desktop's two
// columns. The word ("Henter…") is the page's own (moment 3); the first two
// keep its line but leave it empty — they run before any words are here.

// Grayscale anti-aliasing on the guest page only (R3).
export const ROOT_FINISH = "antialiased";
// The embed's ground from 450 px: transparent (the host's colour shows), and
// padding round the one card so its shadow is never cut by the frame. 40 px
// below it (G10 item 4, judge 27 Oct): the card's shadow reaches 36 px down
// (16 px offset + 40 px blur − 20 px spread) and pb-6 cut it in a straight
// line at the frame's edge. The frame posts its whole height (the padding
// with it), on every step — the host sizes it to fit.
export const EMBED_GROUND = "min-[450px]:bg-transparent min-[450px]:px-4 min-[450px]:pt-4 min-[450px]:pb-10";
// The one elevation: white, 16 px corners (the hero rung), a 5 % ring and
// one soft shadow. Light only — the embed forces light.
export const EMBED_CARD =
  "min-[450px]:bg-white min-[450px]:rounded-[16px] " +
  "min-[450px]:shadow-[0_0_0_1px_rgb(16_24_40/0.05),0_1px_2px_rgb(16_24_40/0.04),0_16px_40px_-20px_rgb(16_24_40/0.18)]";
// How wide the booking may get inside the frame (booking R4).
export const EMBED_MAX = "max-w-[560px]";

const BREATHE = "motion-safe:animate-[bbBreathe_1.6s_ease-in-out_infinite]";
const WORD = "text-sm text-gray-500 dark:text-gray-400 text-center pt-4";

/** The four looks: "plain" (phone/tablet), "wide" (desktop ≥ 1024, not in a
 *  frame), "embedCard" (?embed=1, the card from 450 px), "embedFlat" (&flat=1). */
export const SKELETON_VARIANTS = ["plain", "wide", "embedCard", "embedFlat"];

/** Which look a booking address gets — the page's own rule (isEmbed, flat,
 *  wide = ≥ 1024 px and neither embedded nor framed). */
export function skeletonVariant({ embed = false, flat = false, wide = false } = {}) {
  if (embed) return flat ? "embedFlat" : "embedCard";
  return wide ? "wide" : "plain";
}

// A tiny element tree: [tag, className, children | text]. `null` text = the
// empty word line.
function el(tag, className, children = []) {
  return { tag, className, children };
}

export function skeletonTree(variant) {
  if (variant === "wide") {
    return el("div", `min-h-screen ${ROOT_FINISH} bg-gray-50 dark:bg-gray-950 pt-10 pb-12`, [
      el("div", "grid grid-cols-[minmax(0,1fr)_28rem] gap-12 max-w-5xl mx-auto px-8 items-start", [
        el("div", "space-y-6", [
          el("div", `${BREATHE} rounded-xl bg-gray-200/70 dark:bg-gray-800 w-16 h-16`),
          el("div", `${BREATHE} rounded-lg bg-gray-200/70 dark:bg-gray-800 h-8 w-2/3`),
        ]),
        el("div", "w-full rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900 px-6 py-8 space-y-4", [
          el("div", `${BREATHE} rounded-lg bg-gray-100 dark:bg-gray-800 h-8 w-2/3`),
          el("div", `${BREATHE} rounded-xl bg-gray-100 dark:bg-gray-800 h-32`),
          el("p", WORD, null),
        ]),
      ]),
    ]);
  }
  const embed = variant === "embedCard" || variant === "embedFlat";
  const card = variant === "embedCard";
  return el(
    "div",
    `${embed ? "" : "min-h-screen"} ${ROOT_FINISH} bg-white dark:bg-gray-950 px-4 py-12` + (card ? " " + EMBED_GROUND : ""),
    [
      el(
        "div",
        (embed ? EMBED_MAX : "max-w-md") + " mx-auto space-y-4" +
          (card ? " " + EMBED_CARD + " min-[450px]:px-4 min-[450px]:py-8" : ""),
        [
          el("div", `${BREATHE} rounded-lg bg-gray-100 dark:bg-gray-800 h-8 w-2/3`),
          el("div", `${BREATHE} rounded-xl bg-gray-100 dark:bg-gray-800 h-32`),
          el("p", WORD, null),
        ],
      ),
    ],
  );
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** The same skeleton as an HTML string (the empty word line holds a no-break
 *  space, so it keeps the line's height). Marked data-bb-wait so the page and
 *  its tests can tell it is the wait. */
export function skeletonHtml(variant) {
  const walk = (node, root) => {
    const attrs = ` class="${esc(node.className)}"` + (root ? ` data-bb-wait="${esc(variant)}" aria-hidden="true"` : "");
    const inner = node.children === null ? "&nbsp;" : node.children.map((c) => walk(c, false)).join("");
    return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
  };
  return walk(skeletonTree(variant), true);
}

/** The look for the address the browser is on now — the route's fallback,
 *  before the page's own code has arrived (App.jsx GuestPage): the page's
 *  own rule, read from the address, the frame and the screen. */
export function variantForHere() {
  try {
    const q = new URLSearchParams(window.location.search || "");
    const embed = q.get("embed") === "1";
    let framed = false;
    try {
      framed = window.self !== window.top;
    } catch {
      framed = true; // a cross-origin parent: a frame as well (utils/framed.js)
    }
    const wide =
      !embed && !framed && typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1024px)").matches;
    return skeletonVariant({ embed, flat: q.get("flat") === "1", wide });
  } catch {
    return "plain";
  }
}
