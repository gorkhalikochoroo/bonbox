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
 * LIGHT is BonBox paper (#f6f4ec) since 12 Oct 2026, but ONLY on a route that
 * is known to draw on the paper: the owner app (every page inside <Layout />),
 * the paper auth screens, the schedule wall screen and, since the v6 landing
 * (22 Oct 2026), the landing itself — PAPER_PATHS / PAPER_PREFIXES below.
 * Everything else is white: every guest
 * page (incl. the vanity /<slug> booking page, which a path list could never
 * enumerate), the staff portal, and the full-screen pages that paint their own
 * ground (the host stand, the /stand pairing screen, onboarding…). The list is
 * the APP side on purpose: a page nobody listed — a new guest page, a mistyped
 * URL on its way to "/" — falls to white, never to a cream flash.
 * index.html's pre-paint script carries a copy of the list, so a cold load
 * paints the right bar and ground before the bundle arrives (paper on an app
 * route, the static white everywhere else). Dark is unchanged.
 */
export const THEME_COLOR = Object.freeze({ light: "#f6f4ec", dark: "#1f2937", page: "#ffffff", guestDark: "#030712" });

/**
 * Light-mode routes that draw on the paper — the ONLY routes whose browser bar
 * and html/body are paper. Exact paths (trailing slash ignored):
 *   - every route inside <Layout /> in App.jsx (owner + /admin), including the
 *     redirect-only legacy paths, so an old bookmark is paper from first paint;
 *   - the paper auth screens (AuthShell is bg-bb-paper): /login, /register,
 *     /forgot-password, /verify-email; and /contact, which draws on the body;
 *   - /staff/schedule/stand, the schedule wall screen: no chrome, but it draws
 *     on the body like the in-app schedule;
 *   - /staff, Vagtplan's short address: it only redirects, to the schedule or
 *     to /login, both paper;
 *   - "/" and /v2, the v6 landing (PORT_PLAN 1.7): its ground is paper with
 *     night bands; while the story runs, its scroll engine writes the night
 *     colour over the bar and puts paper back (components/landing/v6/engine.js).
 *     A signed-in owner on "/" is redirected home, also paper. Both stay in
 *     LIGHT_ONLY_PATHS: the page has no dark styling.
 * NOT here (white, by being absent): /join, /onboarding,
 * /getting-started (gray-50 full-screen), /login/magic, /login/claim, legal,
 * /reservations/stand and /stand/<token> (the host stand's own gray-50 page),
 * /stand (its own gradient), /s/ /r/ /e/ /t/ /g/ /accept-invite/ and the
 * vanity /<slug>. creamCanvas.test.js makes every static route in App.jsx
 * declare its side, so a new route cannot slip through unlisted.
 * Keep equal to index.html's pre-paint copy (same test).
 */
export const PAPER_PATHS = Object.freeze([
  "/", "/v2",
  "/login", "/register", "/forgot-password", "/verify-email", "/contact", "/staff/schedule/stand", "/staff",
  "/dashboard", "/sales", "/events", "/reservations", "/gavekort", "/scan", "/expenses", "/inventory",
  "/staffing", "/weather", "/waste", "/weekly-report", "/vat-report", "/reports", "/feedback", "/cashbook",
  "/cashflow", "/tax", "/pricing", "/retention", "/expiry", "/competitors", "/branches", "/outlets",
  "/consolidated-close", "/terminals", "/modules", "/daily-close/multi", "/share-recipients", "/daily-close",
  "/workshop", "/wine-list", "/bar", "/workshop/new-job", "/recently-deleted", "/profile", "/personal",
  "/khata", "/faktura", "/faktura/review", "/customers", "/mileage", "/loans", "/imports", "/bank-import",
  "/payment-imports", "/budgets", "/team", "/staff/schedule", "/staff/hours", "/staff/time-registration",
  "/staff/tips", "/staff/payroll", "/more", "/subscription", "/bookkeeping-export", "/month-end", "/insights",
  "/daily-report", "/channel-settings", "/connections", "/accountant/clients",
  "/admin", "/admin/training", "/admin/support",
]);
/** Paper routes with a dynamic tail (/workshop/job/:id). */
export const PAPER_PREFIXES = Object.freeze(["/workshop/job/"]);

/** True on a route that draws on the paper in light (trailing slash ignored). */
export const isPaperPath = (path) => {
  if (typeof path !== "string") return false;
  const p = path.replace(/\/+$/, "") || "/";
  return PAPER_PATHS.includes(p) || PAPER_PREFIXES.some((x) => p.startsWith(x));
};

/** True on a route whose page is white in light: every route that is not paper. */
export const isWhitePagePath = (path) => !isPaperPath(path);

/**
 * Routes whose page has no dark styling at all (0 `dark:` classes): the
 * landing page (/ and its /v2 alias; paper in light, and its stylesheet keeps
 * the paper under a stored dark theme too), the staff join screen, the door-tablet
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

/**
 * forceLightTheme — the embedded booking widget (`/r/<slug>?embed=1`) is
 * ALWAYS light.
 *
 * It renders inside someone else's page: the owner's website, and the owner's
 * own "Sådan ser den ud på en telefon" preview of it. Both frames are the
 * BonBox origin, so they read the same stored theme as the app — an owner in
 * dark mode saw a dark booking form in the preview while their guests got a
 * light one, and a guest who once picked dark on bonbox.dk would get a dark
 * form dropped into a light restaurant site. The host page owns the look, so
 * the frame never follows the stored theme. index.html's pre-paint skips the
 * dark class for `embed=1` on any non-paper route (a cold load never flashes
 * dark), and the page itself holds it off while mounted (below).
 * The stored choice is never written: the app stays dark for its owner.
 */
// Takes <html> out of dark for as long as the caller is mounted and returns
// the undo (puts `dark` back only if it was there). Never touches storage.
export function forceLightTheme() {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  const wasDark = root.classList.contains("dark");
  root.classList.remove("dark");
  return () => {
    if (wasDark) root.classList.add("dark");
  };
}

/**
 * embedTheme — booking R13. An embed whose snippet opted in to the
 * restaurant's look (`look=1`) got its theme from the parse-time script
 * (<html class="bb-look">, src/lib/bookingLook.js): a dark site gets the dark
 * card, and the page leaves it alone. Every other embed is light, exactly as
 * before (forceLightTheme above).
 */
export function embedTheme() {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("bb-look")) return () => {};
  return forceLightTheme();
}

/**
 * followSystemTheme — booking R13. The booking page opened on its own
 * follows the phone's dark mode (prefers-color-scheme), not only a theme
 * stored by the owner app: a guest's phone at night gets the dark page that
 * was already designed for it. index.html's pre-paint does the same before
 * the first paint; this keeps it while the page is mounted (and follows a
 * switch of the phone's setting). The stored choice is never written: stored
 * "dark" stays dark, and on leaving the page <html> is back to what it says.
 */
export function followSystemTheme() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const root = document.documentElement;
  let stored = false;
  try {
    stored = localStorage.getItem("theme") === "dark";
  } catch {
    /* storage blocked: the phone decides alone */
  }
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => root.classList.toggle("dark", stored || !!mq?.matches);
  const onChange = () => {
    apply();
    const dark = root.classList.contains("dark");
    syncThemeColor(dark);
    // R13 fix: Safari kept the dark toolbar band after a live dark → light
    // switch — it reads theme-color when the tag arrives, not when its
    // content changes. A fresh tag with the new content repaints it.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.replaceWith(meta.cloneNode(true));
    // …and the band UNDER its bottom bar is the page's canvas, which Safari
    // samples late: say the new ground and scheme on <html> itself
    // (fix round 2; cleared when the page goes).
    try {
      root.style.colorScheme = dark ? "dark" : "light";
      const ground = window.getComputedStyle(document.body || root).backgroundColor;
      if (ground) root.style.backgroundColor = ground;
    } catch {
      /* no computed style: nothing to say */
    }
  };
  apply();
  mq?.addEventListener?.("change", onChange);
  return () => {
    mq?.removeEventListener?.("change", onChange);
    root.classList.toggle("dark", stored);
    root.style.removeProperty("color-scheme");
    root.style.removeProperty("background-color");
  };
}

/** The theme-color value for this theme on this path. */
export function themeColorFor(isDark, path, { guest = false } = {}) {
  // Dark: the card rung, white on the light-only pages — and a restaurant's
  // booking page its own ground, gray-950 (R13 fix round 3: Safari painted
  // its bars #111827 / #1f2937 next to a #030712 page).
  if (isDark) return guest ? THEME_COLOR.guestDark : isLightOnlyPath(path) ? THEME_COLOR.page : THEME_COLOR.dark;
  // Light: paper on a known paper route, white everywhere else. A mounted guest
  // page is white even if it somehow sat on a paper path.
  return guest || isWhitePagePath(path) ? THEME_COLOR.page : THEME_COLOR.light;
}

/** The class on <html> that paints html + body white in light (index.css). */
export const WHITE_PAGE_CLASS = "bb-page-white";

/**
 * Write the theme-color meta, and mark <html> on every route that is not paper
 * so the safe-area / overscroll strips are white too (light only, by CSS). No-op without a document; the meta write is skipped when there is
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
