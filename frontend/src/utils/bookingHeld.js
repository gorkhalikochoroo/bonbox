// A HELD online booking (R1 D7, 24 Oct 2026): the anonymous booking door
// (backend services/booking_screen.py) stored it as a request instead of
// confirming it — unusually many bookings in a short time, a form filled in
// very fast, a link in the name, or the same guest already holding several.
// It holds no table until the owner says yes.
//
// Told apart from a GROUP request (a party at or above the venue's request
// threshold asks on purpose): a held booking is a public request for fewer
// people than that. A salon has no group requests, so every public request
// there is a held one.
//
// `groupThreshold`: the venue's group_request_threshold. Unknown (a paired
// stand device cannot read the settings) reads as the default, 8. A stored 0
// means the venue takes no group requests, so every public request is held.
export function isHeldForCheck(r, groupThreshold) {
  if (!r || r.status !== "requested" || r.source !== "public") return false;
  let threshold = 8;
  if (groupThreshold !== undefined && groupThreshold !== null && groupThreshold !== "") {
    const n = Number(groupThreshold);
    threshold = Number.isFinite(n) && n > 0 ? n : Infinity;
  }
  return Number(r.party_size) < threshold;
}
