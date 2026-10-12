/**
 * The top of the page, at once — not an animation.
 *
 * html has scroll-behavior: smooth (index.css), so a plain scrollTo(0, 0) is
 * an animated scroll, and a page that focuses a field as it arrives cuts it
 * short: /verify-email opened ~275 px down on a 375 x 667 phone (its heading
 * off screen) after the owner had scrolled down to "Opret konto" (mobile
 * walk, 12 Oct 2026). The smooth setting is lifted for this one call only, so
 * in-page anchors keep their smooth scroll. Used on a route change
 * (App.jsx ScrollManager) and a new onboarding step.
 */
export function jumpToTop(win = typeof window !== "undefined" ? window : null) {
  if (!win || typeof win.scrollTo !== "function") return;
  // Already there: nothing to do (and nothing to animate).
  if (!win.scrollY && !win.scrollX && !win.pageYOffset && !win.pageXOffset) return;
  const root = win.document && win.document.documentElement;
  const prev = root ? root.style.scrollBehavior : "";
  if (root) root.style.scrollBehavior = "auto";
  // Chromium does not update style before scrollTo, so without this read it
  // still sees "smooth" and animates (review, 12 Oct). Reading the computed
  // value forces the style flush; WebKit already does it.
  try {
    if (root && typeof win.getComputedStyle === "function") void win.getComputedStyle(root).scrollBehavior;
  } catch {
    /* a test DOM without styles — the scroll below still runs */
  }
  try {
    win.scrollTo(0, 0);
  } catch {
    /* no scrolling here (a test DOM) — nothing to undo */
  } finally {
    if (root) root.style.scrollBehavior = prev;
  }
}

export default jumpToTop;
