// "Adding your first table switched online booking on" — said to the owner
// (R9, 27 Oct 2026; rubric R10).
//
// The server switches the public page on when a venue gets its FIRST
// bookable resource (reservations._activate_reservations_on_first_resource),
// and only if the owner never set the switch. It reports it in the answer:
//   • POST /reservations/resources        → `reservations_activated` (R9)
//   • POST /reservations/resources/bulk   → `reservations_activated`
//   • POST /reservations/salon/stylists   → `activation` (R7, another track)
// The app showed none of it, so an owner who built a floor found out from a
// guest. Every create path hands its answer to takeActivation() and passes
// the facts to announceActivation(); BookingLiveNotice listens.

export const ACTIVATION_EVENT = "bonbox-booking-activated";

function validFacts(x) {
  if (!x || typeof x !== "object") return null;
  if (x.reservations_enabled === false) return null;
  const url = typeof x.public_url === "string" ? x.public_url : "";
  if (!url) return null;
  return { public_url: url, reservation_slug: x.reservation_slug || null };
}

// {resource, activated}: the answer without the activation key (so the
// resource list never carries it), and the facts — or null.
export function takeActivation(data) {
  if (!data || typeof data !== "object") return { resource: data, activated: null };
  const activated = validFacts(data.reservations_activated) || validFacts(data.activation);
  if (!("reservations_activated" in data)) return { resource: data, activated };
  const { reservations_activated: _drop, ...resource } = data;
  return { resource, activated };
}

// `kind`: what was added — "table" | "place" | "stylist" (the notice's words).
export function announceActivation(activated, kind = "table") {
  if (!activated || typeof window === "undefined") return false;
  try {
    window.dispatchEvent(new CustomEvent(ACTIVATION_EVENT, { detail: { ...activated, kind } }));
    return true;
  } catch {
    return false;
  }
}
