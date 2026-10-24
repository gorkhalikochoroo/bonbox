// A HELD online booking (R1 D7, 24 Oct 2026; fix round the same day): the
// anonymous booking door (backend services/booking_screen.py) stored it as a
// request instead of confirming it — unusually many bookings in a short time,
// a form filled in very fast, a link in the name, or the same guest already
// holding several. It holds no table or chair until the owner says yes.
//
// The book says so itself since the fix round: a held row carries
// `held: {reason, quiet, wanted, pinned}` and every row carries
// `guest_mailed`. An older server sends neither, and then a held booking is
// told apart from a GROUP request (a party at or above the venue's request
// threshold asks on purpose) by its size: a public request for fewer people
// than that. A salon has no group requests, so every public request there is
// a held one.
//
// `groupThreshold`: the venue's group_request_threshold (for the older
// server). Unknown (a paired stand device cannot read the settings) reads as
// the default, 8. A stored 0 means the venue takes no group requests, so
// every public request is held.
export function isHeldForCheck(r, groupThreshold) {
  if (!r || r.status !== "requested" || r.source !== "public") return false;
  if (r.held && typeof r.held === "object") return true;
  if ("guest_mailed" in r) return false; // the server said: not held
  let threshold = 8;
  if (groupThreshold !== undefined && groupThreshold !== null && groupThreshold !== "") {
    const n = Number(groupThreshold);
    threshold = Number.isFinite(n) && n > 0 ? n : Infinity;
  }
  return Number(r.party_size) < threshold;
}

// Why the booking was held, as the i18n key of the drawer's sentence (with
// its English fallback). An unknown or missing reason → the general one.
const WHY = {
  fast_fill: ["rsvpHeldWhyFast", "The form was filled in faster than a person can — often a robot. Confirm it only if you know the guest."],
  link_in_name: ["rsvpHeldWhyLink", "There was a link in the name. Confirm it if it looks real."],
  honeypot: ["rsvpHeldWhyTrap", "A hidden field only robots see was filled in — a browser's autofill can do that too. Confirm it if it looks real."],
  contact_active: ["rsvpHeldWhyContact", "This guest already has 3 or more bookings ahead with you. Confirm it if it looks real."],
  requests_full: ["rsvpHeldWhyRequests", "Many group requests came in today. Confirm it if it looks real."],
  venue_hour: ["rsvpHeldWhyBusy", "Held for your OK: unusually many online bookings came in a short time. Confirm it if it looks real."],
  venue_day: ["rsvpHeldWhyBusy", "Held for your OK: unusually many online bookings came in a short time. Confirm it if it looks real."],
  sitting_full: ["rsvpHeldWhyBusy", "Held for your OK: unusually many online bookings came in a short time. Confirm it if it looks real."],
  plan_day: ["rsvpHeldWhyBusy", "Held for your OK: unusually many online bookings came in a short time. Confirm it if it looks real."],
};
const WHY_DEFAULT = ["rsvpHeldWhy", "Held for your OK: there were unusually many bookings in a short time, or the form was filled in very fast. Confirm it if it looks real."];

export function heldWhy(r, t) {
  const [key, fallback] = WHY[r?.held?.reason] || WHY_DEFAULT;
  return t(key, fallback);
}

// What it was booked for ("Bord 3", "Bord 1 + Bord 2", "Mia"), or "".
export function heldWanted(r) {
  const w = r?.held?.wanted;
  return Array.isArray(w) && w.length ? w.filter(Boolean).join(" + ") : "";
}
