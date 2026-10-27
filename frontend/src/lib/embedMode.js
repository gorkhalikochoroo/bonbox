// The booking form inside a restaurant's OWN website (booking R4, "a quiet
// embed"): the frame loads /r/<slug>?embed=1 — the only route an owner's
// snippet ever frames (utils/bookingEmbed.js).
//
// That document is a guest's booking form and nothing else, so the app's
// start-up calls stay home:
//   - GET /api/health (the keep-alive ping): the booking page's own first
//     request wakes the server anyway;
//   - GET /api/config/features: owner-app flags no guest screen reads;
//   - GET /auth/me: the session check. A guest has no session, so it
//     answered 401 — a red error in the restaurant's own browser console,
//     on their website. And where it did find one (the owner's own preview,
//     or an owner whose browser lets the frame carry the cookie), it woke the
//     owner app inside the guest's form: entitlements, the device PIN status,
//     the account language sync.
//
// Read from the address at the moment of asking: the frame's address is
// fixed for the life of that document. Only the /r/ route — "?embed=1" on any
// other path (the owner app) changes nothing.
import { isBookingPath } from "./bookingPath";

export function isQuietEmbed(loc = typeof window !== "undefined" ? window.location : undefined) {
  try {
    if (!loc) return false;
    if (!/^\/r\/[^/]+\/?$/.test(loc.pathname || "")) return false;
    return new URLSearchParams(loc.search || "").get("embed") === "1";
  } catch {
    return false;
  }
}

// Booking R5 — the same quiet for the guest's booking page on its own
// (/r/<slug>, and the vanity /<slug> an owner shares; lib/bookingPath.js).
// A guest has no session: the check answered 401 (a red line in the guest's
// console), and the flags and the keep-alive were three more requests on a
// slow phone before the page's own (rubric G14). The page needs none of
// them: it makes no owner-app call, and its own first request wakes the
// server. Decided once, when the providers mount: the guest page has no link
// into the owner app (its only link, the privacy policy, opens a new tab),
// so a page that starts quiet never becomes the owner app in place.
// One line to switch the standalone page back (the embed stays quiet, R4):
export const QUIET_GUEST_PAGE = true;

export function isQuietGuestPage(loc = typeof window !== "undefined" ? window.location : undefined) {
  if (isQuietEmbed(loc)) return true;
  if (!QUIET_GUEST_PAGE) return false;
  try {
    if (!loc) return false;
    if (import.meta.env?.VITE_APP_MODE === "scheduler") return false;
    if (typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.()) return false;
    return isBookingPath(loc.pathname);
  } catch {
    return false;
  }
}
