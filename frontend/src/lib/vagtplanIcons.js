/**
 * The staff schedule is its own app — Vagtplan — so its tab and its iOS
 * home-screen icon are the Vagtplan files (docs/brand: paper tile, forest b,
 * emerald strip), not the owner app's.
 *
 * index.html already makes this swap during the parse when the FIRST page is
 * /s/<token> (the reason it does it there is in its comment). But a staffer
 * who arrives through /join is sent to /s/<token> by the SPA router: the head
 * script never re-runs, so the tab favicon and the apple-touch-icon iOS takes
 * for Add to Home Screen stayed the owner's until a reload. StaffPortalPage
 * calls this on mount to make the same swap; the returned function puts the
 * previous hrefs back on unmount.
 *
 * Same rule as the head script, so the two cannot drift: apple-touch-icon ->
 * the Vagtplan apple-touch-icon; every rel="icon" -> its "/vagtplan-favicon"
 * twin (public/ has one for each). Idempotent: "/vagtplan-favicon…" has no
 * "/favicon" in it, so a second swap changes nothing.
 */
export const VAGTPLAN_APPLE_TOUCH_ICON = "/vagtplan-apple-touch-icon.png?v=3";

export function applyVagtplanIcons(doc = typeof document !== "undefined" ? document : null) {
  if (!doc) return () => {};
  const changed = [];
  try {
    const links = doc.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]');
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const next = link.getAttribute("rel") === "apple-touch-icon"
        ? VAGTPLAN_APPLE_TOUCH_ICON
        : href.replace("/favicon", "/vagtplan-favicon").replace("/icon-192", "/vagtplan-icon-192");
      if (next !== href) {
        changed.push([link, href]);
        link.setAttribute("href", next);
      }
    }
  } catch {
    /* an icon must never break the portal — keep whatever is there */
  }
  return () => {
    for (const [link, href] of changed) {
      try { link.setAttribute("href", href); } catch { /* link gone */ }
    }
  };
}
