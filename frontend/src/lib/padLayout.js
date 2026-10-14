import { useCallback, useSyncExternalStore } from "react";

/**
 * The iPad (tablet) layout of the staff portal — BonBox Vagtplan, and the same
 * screens at bonbox.dk/s/<token> in a tablet browser.
 *
 * ONE definition, used twice:
 *   • CSS — the `tablet:`, `pad:` and `pad-wide:` Tailwind variants in
 *     index.css (`@custom-variant`). They MUST say exactly what TABLET_QUERY,
 *     PAD_QUERY and PAD_WIDE_QUERY say; src/__tests__/staffPortalPadLayout.test.jsx
 *     reads index.css and fails if they drift apart.
 *   • JS — usePadLayout(), for the few decisions CSS cannot make (the
 *     Messages master-detail split, the cookie banner's bar measurement, and
 *     keeping the user's place when the layout changes under them).
 *
 * Why a height floor and not plain `md:`:
 *   A phone turned sideways is 844–932 px wide but only 375–440 px tall. It
 *   is still a phone, and it must keep the phone layout it has today. Every
 *   iPad, in every orientation and in Split View, is at least 744 px tall.
 *   600 sits safely between the two.
 *
 * Why 744 for the width:
 *   744 is the narrowest full-screen iPad (iPad mini, portrait), so every
 *   iPad held normally gets the iPad layout. No phone reaches 744 px wide
 *   while being 600 px tall.
 *
 * What a multitasking window gets (iPadOS Split View / Slide Over / Stage
 * Manager) — decided by the window, not the device:
 *   • Slide Over (≈320) and 1/3 windows (< 480): the phone layout.
 *   • 1/2 and 2/3 of a PORTRAIT iPad (≈507–694): the phone layout, with the
 *     `tablet:` touches below (Join / PIN cards and bottom sheets sized to the
 *     512 px phone column instead of the whole window).
 *   • 2/3 of a LANDSCAPE iPad (≈768–981 wide, 820–1024 tall): that window is
 *     iPad-sized, so it gets the iPad layout — the sidebar plus a content
 *     column of ≈480–700 px (one column; two columns need PAD_WIDE).
 *
 * Why 1100 for two columns (pad-wide):
 *   Two columns beside the 14rem sidebar need about 1100 px before each column
 *   is wider than a phone (≈410 px). iPad Pro 12.9"/13" PORTRAIT is 1024 wide:
 *   split there, each column came out ≈340–370 px — narrower than an iPhone —
 *   so it keeps the single 720 px column. Landscape 11"/13" (1180–1366) and
 *   iPad mini landscape (1133) split.
 *
 * Why range syntax (`width >= …`), in CSS AND here:
 *   Lightning CSS minifies the built `min-width` query to range syntax anyway,
 *   and Tailwind's own breakpoints already ship as range syntax. Safari only
 *   understands it from 16.4. Writing the JS query the same way means an older
 *   WebView fails BOTH sides closed — CSS and JS agree on "phone" — instead of
 *   JS rendering the iPad master-detail into a phone-styled page.
 *
 * Below the pad breakpoint NOTHING changes: every pad decision is either a
 * `pad:` class (inert below the breakpoint) or behind usePadLayout() === false.
 * `tablet:` (≥ 480 wide AND ≥ 600 tall) touches no phone either: a portrait
 * phone is under 480 wide and a sideways phone is under 600 tall.
 */
export const PAD_MIN_WIDTH = 744;
export const PAD_WIDE_MIN_WIDTH = 1100;
export const PAD_MIN_HEIGHT = 600;
export const TABLET_MIN_WIDTH = 480;

export const PAD_QUERY = `(width >= ${PAD_MIN_WIDTH}px) and (height >= ${PAD_MIN_HEIGHT}px)`;
/** Wide enough for two columns beside the sidebar (landscape iPads, not the 12.9"/13" in portrait). */
export const PAD_WIDE_QUERY = `(width >= ${PAD_WIDE_MIN_WIDTH}px) and (height >= ${PAD_MIN_HEIGHT}px)`;
/** Any iPad window from a 1/2 Split View up (pad ⊂ tablet). CSS only, as `tablet:`. */
export const TABLET_QUERY = `(width >= ${TABLET_MIN_WIDTH}px) and (height >= ${PAD_MIN_HEIGHT}px)`;

/** Sidebar width on pad, in rem — the content offset uses the same number. */
export const PAD_RAIL_REM = 14;

function mql(query) {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

/** Synchronous read. No matchMedia (jsdom, very old WebViews) → false, the phone layout. */
export function matchesPad(query = PAD_QUERY) {
  const m = mql(query);
  return !!(m && m.matches);
}

function subscribe(query, onChange) {
  const m = mql(query);
  if (!m) return () => {};
  if (typeof m.addEventListener === "function") {
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }
  // Safari < 14 only knows the deprecated pair.
  if (typeof m.addListener === "function") {
    m.addListener(onChange);
    return () => m.removeListener(onChange);
  }
  return () => {};
}

/**
 * Live answer to "is this the iPad layout?" — re-renders when the window
 * crosses the breakpoint (rotation, Split View resize). Defaults to false.
 */
export function usePadLayout(query = PAD_QUERY) {
  // Stable per query, so React does not re-subscribe on every render.
  const sub = useCallback((cb) => subscribe(query, cb), [query]);
  const snap = useCallback(() => matchesPad(query), [query]);
  return useSyncExternalStore(sub, snap, () => false);
}
