// A HELD online booking (R1 D7, 24 Oct 2026; fix round the same day): the
// anonymous booking door (backend services/booking_screen.py) stored it as a
// request instead of confirming it — unusually many bookings in a short time,
// a form filled in very fast, a link in the name, or the same guest already
// holding several. It holds no table or chair until the owner says yes.
//
// The book says so itself since the fix round: a held row carries
// `held: {reason, quiet, bot, wanted, pinned, limit?}` and every row carries
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
  contact_active: ["rsvpHeldWhyContact", "This guest already has {n} or more bookings ahead with you. Confirm it if it looks real."],
  requests_full: ["rsvpHeldWhyRequests", "Many group requests came in today. Confirm it if it looks real."],
  venue_hour: ["rsvpHeldWhyBusy", "Held for your OK: unusually many online bookings came in a short time. Confirm it if it looks real."],
  // R1b: the venue's day is 24 hours, not "a short time".
  venue_day: ["rsvpHeldWhyDay", "Held for your OK: unusually many online bookings came in over the last 24 hours. Confirm it if it looks real."],
  sitting_full: ["rsvpHeldWhyBusy", "Held for your OK: unusually many online bookings came in a short time. Confirm it if it looks real."],
  date_full: ["rsvpHeldWhyBusy", "Held for your OK: unusually many online bookings came in a short time. Confirm it if it looks real."],
  plan_day: ["rsvpHeldWhyBusy", "Held for your OK: unusually many online bookings came in a short time. Confirm it if it looks real."],
  // R1b: the plan's monthly cap is reached and the page takes requests —
  // `held.limit` is the cap. The upgrade nudge sits beside it (web only).
  plan_cap: ["rsvpHeldWhyPlanCap", "This month's {n} bookings on your plan are used, so new online bookings wait for your OK. Confirm it if it looks real."],
};
const WHY_DEFAULT = ["rsvpHeldWhy", "Held for your OK: there were unusually many bookings in a short time, or the form was filled in very fast. Confirm it if it looks real."];

// A salon, a shop or a workshop books CUSTOMERS for a time (apptWords): the
// sentences that name the person say "the customer" there, never "the
// guest" (R1a; the verticals' rule in verticalFit.apptWords.test.jsx).
const WHY_APPT = {
  fast_fill: ["rsvpHeldWhyFastAppt", "The form was filled in faster than a person can — often a robot. Confirm it only if you know the customer."],
  contact_active: ["rsvpHeldWhyContactAppt", "This customer already has {n} or more appointments ahead with you. Confirm it if it looks real."],
  requests_full: ["rsvpHeldWhyRequestsAppt", "Many requests came in today. Confirm it if it looks real."],
  plan_cap: ["rsvpHeldWhyPlanCapAppt", "This month's {n} appointments on your plan are used, so new online appointments wait for your OK. Confirm it if it looks real."],
};

// The {n} a reason names when the server sends no `held.limit`: the
// contact limit an older server used (3), the Free plan's monthly cap (20).
const LIMIT_DEFAULT = { plan_cap: 20 };

// `held.limit` is the server's real limit for a guest's bookings ahead
// (contact_active) or the plan's monthly cap (plan_cap, R1b); an older
// server sends none, and its contact limit was 3.
// `apptWords`: a salon, a shop or a workshop.
export function heldWhy(r, t, { apptWords = false } = {}) {
  const reason = r?.held?.reason;
  const [key, fallback] = (apptWords && WHY_APPT[reason]) || WHY[reason] || WHY_DEFAULT;
  const n = Number(r?.held?.limit);
  return t(key, fallback, { n: Number.isFinite(n) && n > 0 ? n : (LIMIT_DEFAULT[reason] ?? 3) });
}

// R1b: was it held because the plan's monthly cap is reached? The drawer
// then shows the upgrade nudge beside the reason.
export function heldForPlanCap(r) {
  return r?.status === "requested" && r?.held?.reason === "plan_cap";
}

// What it was booked for ("Bord 3", "Bord 1 + Bord 2", "Mia"), or "".
export function heldWanted(r) {
  const w = r?.held?.wanted;
  return Array.isArray(w) && w.length ? w.filter(Boolean).join(" + ") : "";
}
