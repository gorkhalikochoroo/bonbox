import { useCallback, useSyncExternalStore } from "react";

/**
 * The iPad (tablet) layout of the staff portal — BonBox Vagtplan, and the same
 * screens at bonbox.dk/s/<token> in a tablet browser.
 *
 * ONE definition, used twice:
 *   • CSS — the `pad:` and `pad-wide:` Tailwind variants in index.css
 *     (`@custom-variant`). They MUST say exactly what PAD_QUERY and
 *     PAD_WIDE_QUERY say; src/__tests__/staffPortalPadLayout.test.jsx reads
 *     index.css and fails if the two drift apart.
 *   • JS — usePadLayout(), for the few decisions CSS cannot make (the
 *     Messages master-detail split, the cookie banner's bar measurement).
 *
 * Why a height floor and not plain `md:`:
 *   A phone turned sideways is 844–932 px wide but only 375–440 px tall. It
 *   is still a phone, and it must keep the phone layout it has today. Every
 *   iPad, in every orientation and in Split View, is at least 744 px tall.
 *   600 sits safely between the two.
 *
 * Why 744 for the width:
 *   744 is the narrowest full-screen iPad (iPad mini, portrait), so every
 *   iPad held normally gets the iPad layout. iPad Split View at 1/2 and 2/3
 *   of a portrait iPad (≈507–694 px) and Slide Over (≈320 px) are phone-sized
 *   columns and get the phone layout — consistently, for every screen and
 *   every sheet, so a resize never leaves one surface on the other layout.
 *   No phone reaches 744 px wide while being 600 px tall.
 *
 * Below the pad breakpoint NOTHING changes: every pad decision is either a
 * `pad:` class (inert below the breakpoint) or behind usePadLayout() === false.
 */
export const PAD_MIN_WIDTH = 744;
export const PAD_WIDE_MIN_WIDTH = 1024;
export const PAD_MIN_HEIGHT = 600;

export const PAD_QUERY = `(min-width: ${PAD_MIN_WIDTH}px) and (min-height: ${PAD_MIN_HEIGHT}px)`;
/** Wide enough for two columns beside the sidebar (iPad 11"/13" in either orientation). */
export const PAD_WIDE_QUERY = `(min-width: ${PAD_WIDE_MIN_WIDTH}px) and (min-height: ${PAD_MIN_HEIGHT}px)`;

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
