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
export function isQuietEmbed(loc = typeof window !== "undefined" ? window.location : undefined) {
  try {
    if (!loc) return false;
    if (!/^\/r\/[^/]+\/?$/.test(loc.pathname || "")) return false;
    return new URLSearchParams(loc.search || "").get("embed") === "1";
  } catch {
    return false;
  }
}
