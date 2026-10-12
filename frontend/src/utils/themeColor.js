/**
 * The browser bar (`<meta name="theme-color">`) follows the app theme.
 *
 * It was a static #ffffff, so on a phone in dark mode the owner got a white
 * status/URL bar glued to a near-black page — the brightest thing on the
 * screen at night after close. Dark paints the CARD rung (#1f2937), which is
 * what the phone's own top bar sits on (1.04 against it), so the bar and the
 * header read as one strip.
 *
 * Pages that never render dark keep the light value whatever the stored theme
 * says: the staff portal (/s/<token>) and LIGHT_ONLY_PATHS below. Without that,
 * an owner who uses dark mode and signs out got a dark #1f2937 bar glued to the
 * white landing page — the same mismatch, reversed, on the front door.
 *
 * index.html's pre-paint script sets the same value before React mounts (no
 * white flash on a cold start) and carries a copy of the list; this helper
 * keeps it in step when the owner toggles the theme live (useDarkMode) and on
 * every route change (useThemeColorSync, mounted once in App).
 */
export const THEME_COLOR = Object.freeze({ light: "#ffffff", dark: "#1f2937" });

/**
 * Routes whose page has no dark styling at all (0 `dark:` classes): the
 * landing page (/ and its /v2 alias), the staff join screen, the door-tablet
 * pairing screen and the magic-link / claim screens. Exact paths: /stand/<token>
 * is the (dark-aware) reservation book. Keep equal to index.html's copy.
 */
export const LIGHT_ONLY_PATHS = Object.freeze(["/", "/v2", "/join", "/stand", "/login/magic", "/login/claim"]);

/** True on the staff portal, which never renders dark. */
export const isStaffPortalPath = (path) => typeof path === "string" && path.startsWith("/s/");

/** True on any route that never renders dark (trailing slash ignored). */
export const isLightOnlyPath = (path) =>
  typeof path === "string" &&
  (isStaffPortalPath(path) || LIGHT_ONLY_PATHS.includes(path.replace(/\/+$/, "") || "/"));

/** The theme-color value for this theme on this path. */
export function themeColorFor(isDark, path) {
  return isDark && !isLightOnlyPath(path) ? THEME_COLOR.dark : THEME_COLOR.light;
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
