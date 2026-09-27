// Pages a restaurant's GUESTS use — the public booking page at /r/<slug> and
// the vanity /<slug> — keep only strictly-necessary storage: no event log, no
// analytics (see CookiePolicyPage: the optional category has nothing behind
// it). Like the embedded booking widget, they owe no consent banner, and on a
// phone the banner covered most of the booking form on a guest's first visit.
//
// The vanity route cannot be told apart from an app page by its path alone,
// so the page marks itself while it is mounted; CookieConsent checks the mark
// and listens for it.

export const GUEST_SURFACE_EVENT = "bonbox-guest-surface";

let mounted = 0;

export function markGuestSurface() {
  mounted += 1;
  try {
    window.dispatchEvent(new Event(GUEST_SURFACE_EVENT));
  } catch {
    /* no window (tests, SSR) — the flag alone is enough */
  }
  return () => {
    mounted = Math.max(0, mounted - 1);
  };
}

export function isGuestSurface() {
  if (mounted > 0) return true;
  try {
    return window.location.pathname.startsWith("/r/");
  } catch {
    return false;
  }
}
