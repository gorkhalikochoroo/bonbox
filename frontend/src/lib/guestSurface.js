// Pages a restaurant's GUESTS use — the public booking page at /r/<slug> and
// the vanity /<slug> — must show nothing that belongs to the owner.
//
// Two things read this:
// - CookieConsent: guest pages keep only strictly-necessary storage (no event
//   log, no analytics — see CookiePolicyPage), so like the embedded booking
//   widget they owe no consent banner, which on a phone covered most of the
//   booking form on a guest's first visit.
// - LiveAlertsProvider: an owner logged in on the same device (the iPad at the
//   door, the owner's own phone) would otherwise see — and show a guest —
//   other guests' names, party sizes and allergy notes as pop-ups over the
//   booking form. Allergy notes are health data.
//
// The vanity route cannot be told apart from an app page by its path alone,
// so the page marks itself while it is mounted, and every change is broadcast
// so a subscriber re-renders the moment the page mounts or unmounts.

import { useSyncExternalStore } from "react";

export const GUEST_SURFACE_EVENT = "bonbox-guest-surface";

let mounted = 0;

function announce() {
  try {
    window.dispatchEvent(new Event(GUEST_SURFACE_EVENT));
  } catch {
    /* no window (tests, SSR) — the counter alone is enough */
  }
}

export function markGuestSurface() {
  mounted += 1;
  announce();
  return () => {
    mounted = Math.max(0, mounted - 1);
    announce();
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

function subscribe(onChange) {
  try {
    window.addEventListener(GUEST_SURFACE_EVENT, onChange);
    return () => window.removeEventListener(GUEST_SURFACE_EVENT, onChange);
  } catch {
    return () => {};
  }
}

/** True while a guest-facing page is on screen; re-renders when that changes. */
export function useGuestSurface() {
  return useSyncExternalStore(subscribe, isGuestSurface, () => false);
}
