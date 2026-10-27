// A start that no longer fits (the party, the service or the date changed)
// moves to the nearest one that does — moved here verbatim from
// ReservationsPage (fix round 27 Oct): the new-booking sheet and the edit
// sheet (components/reservations/EditBookingSheet.jsx) both use it.
import { hm, openTimesFor, overrunsClose, windowAt, windowsFor } from "./bookingTimes";

// When the party, the service or the date changes, a start that no longer
// fits moves to the nearest one that does — and the sheet says so in one
// line. A silent 20:30 → 20:00 read as the form changing its mind.
export function snapStart({ dateIso, time, openHours, sitting, n, service, t }) {
  const nt = openTimesFor(dateIso, openHours, sitting);
  if (!nt.known || nt.closed || nt.times.includes(time)) return { to: time, note: "" };
  const to = nt.times.filter((q) => q <= time).pop() || nt.times[0];
  const wins = windowsFor(dateIso, openHours) || [];
  const win = windowAt(wins, time);
  let note;
  if (win && overrunsClose(wins, time, sitting)) {
    note = service
      ? t("rsvpTimeMovedCloseService", "Moved to {to} — the appointment has to end by {close}.", { to: hm(to), close: hm(win[1]) })
      : Number(n) === 1
        ? t("rsvpTimeMovedCloseOne", "Moved to {to} — 1 guest has to be done by {close}.", { to: hm(to), close: hm(win[1]) })
        : t("rsvpTimeMovedClose", "Moved to {to} — {n} guests have to be done by {close}.", { to: hm(to), n, close: hm(win[1]) });
  } else {
    note = t("rsvpTimeMovedOpen", "Moved to {to} — open {hours} that day.", {
      to: hm(to), hours: wins.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(", "),
    });
  }
  return { to, note };
}
