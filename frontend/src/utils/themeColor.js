/**
 * The browser bar (`<meta name="theme-color">`) follows the app theme.
 *
 * It was a static #ffffff, so on a phone in dark mode the owner got a white
 * status/URL bar glued to a near-black page — the brightest thing on the
 * screen at night after close. Dark paints the CARD rung (#1f2937), which is
 * what the phone's own top bar sits on (1.04 against it), so the bar and the
 * header read as one strip.
 *
 * The staff portal (/s/<token>) has no dark rules at all — its pages are light
 * whatever the stored theme says — so it always keeps the light value.
 *
 * index.html's pre-paint script sets the same value before React mounts (no
 * white flash on a cold start); this helper keeps it in step when the owner
 * toggles the theme live.
 */
export const THEME_COLOR = Object.freeze({ light: "#ffffff", dark: "#1f2937" });

/** True on the staff portal, which never renders dark. */
export const isStaffPortalPath = (path) => typeof path === "string" && path.startsWith("/s/");

/** The theme-color value for this theme on this path. */
export function themeColorFor(isDark, path) {
  return isDark && !isStaffPortalPath(path) ? THEME_COLOR.dark : THEME_COLOR.light;
}

/**
 * Write the theme-color meta. No-op when there is no document or no meta
 * (tests, SSR, a page that dropped the tag).
 */
export function syncThemeColor(isDark, path) {
  if (typeof document === "undefined") return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const where = path ?? (typeof window !== "undefined" ? window.location.pathname : "");
  meta.setAttribute("content", themeColorFor(isDark, where));
}
