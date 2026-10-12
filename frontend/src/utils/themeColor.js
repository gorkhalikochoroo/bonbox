import { isGuestSurface } from "../lib/guestSurface";

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
 *
 * LIGHT is BonBox paper (#f6f4ec) since 12 Oct 2026: the app's light ground and
 * its light shell (sidebar, top bar, bottom nav) are paper, so a white bar
 * above them was a white strip on a cream screen. Pages that paint their OWN
 * white / near-white page keep the white bar in light (WHITE_PAGE_PATHS,
 * WHITE_PAGE_PREFIXES, and any mounted guest page — lib/guestSurface.js, which
 * is how the vanity /<slug> booking page is told apart from an app page).
 * index.html's pre-paint script leaves light at the static #ffffff, so a cold
 * load of a guest page never shows a cream bar; the app's paper bar arrives
 * with React's first commit (useThemeColorSync). Dark is unchanged.
 */
export const THEME_COLOR = Object.freeze({ light: "#f6f4ec", dark: "#1f2937", page: "#ffffff" });

/**
 * Light-mode routes whose page paints its own white / near-white ground over
 * the paper body, so the browser bar stays white there: the landing (/, /v2),
 * the staff join screen (#f5f7fb), the magic-link / claim screens and
 * onboarding (slate-50 / gray-50), the legal pages (white) and the guest-facing
 * pages — staff portal /s/, booking /r/, events /e/, tickets /t/, gift cards
 * /g/, invites. NOT /stand: the door-tablet pairing screen draws on the body,
 * i.e. on paper, as do /login and /register (AuthShell is paper).
 */
export const WHITE_PAGE_PATHS = Object.freeze(["/", "/v2", "/join", "/login/magic", "/login/claim", "/onboarding", "/privacy", "/terms", "/cookies"]);
export const WHITE_PAGE_PREFIXES = Object.freeze(["/s/", "/r/", "/e/", "/t/", "/g/", "/accept-invite/"]);

/** True on a route that paints its own white page in light (trailing slash ignored). */
export const isWhitePagePath = (path) => {
  if (typeof path !== "string") return false;
  const p = path.replace(/\/+$/, "") || "/";
  return WHITE_PAGE_PATHS.includes(p) || WHITE_PAGE_PREFIXES.some((x) => p.startsWith(x));
};

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
export function themeColorFor(isDark, path, { guest = false } = {}) {
  // Dark: exactly what shipped — card rung, white on the light-only pages.
  if (isDark) return isLightOnlyPath(path) ? THEME_COLOR.page : THEME_COLOR.dark;
  // Light: paper, except on a page that paints its own white.
  return guest || isWhitePagePath(path) ? THEME_COLOR.page : THEME_COLOR.light;
}

/** The class on <html> that paints html + body white in light (index.css). */
export const WHITE_PAGE_CLASS = "bb-page-white";

/**
 * Write the theme-color meta, and mark <html> when the page paints its own
 * white page so the safe-area / overscroll strips are white too (light only,
 * by CSS). No-op without a document; the meta write is skipped when there is
 * no meta (tests, SSR, a page that dropped the tag).
 */
export function syncThemeColor(isDark, path) {
  if (typeof document === "undefined") return;
  const where = path ?? (typeof window !== "undefined" ? window.location.pathname : "");
  const guest = isGuestSurface();
  document.documentElement.classList.toggle(WHITE_PAGE_CLASS, guest || isWhitePagePath(where));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute("content", themeColorFor(isDark, where, { guest }));
}
