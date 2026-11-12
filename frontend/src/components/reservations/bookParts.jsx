/**
 * Small pieces the reservation book draws in more than one lens — the list,
 * the drawer and the timeline (components/reservations/TimelineView.jsx).
 * Moved unchanged from pages/ReservationsPage.jsx (fix round 12 Nov 2026) so
 * the timeline can live in its own file: the door screen's build loads that
 * lens on first use (scripts/standBuild.mjs, its JS budget).
 */

// Zone colours: utils/zoneColors (hollow rings, clear of the status hues).
export function ZoneDot({ dot }) {
  if (!dot) return null;
  return <span className={"inline-block w-2 h-2 rounded-full border-2 shrink-0 " + dot.cls} role="img" aria-label={dot.zone} title={dot.zone} />;
}

// Status → localized label. Shared by the Liste status column + (later) the
// floor/timeline. Mirrors the map ReservationRow used.
// `checkedIn`: a shop or a workshop (appointment words, no chair) — its
// customer is checked in ("Tjek ind" → "Tjekket ind"), nobody "sits". The
// salon keeps "Sidder": its customer is in the chair.
export function statusLabels(t, checkedIn = false) {
  return {
    requested: t("rsvpStatusRequested", "Requested"),
    confirmed: t("rsvpStatusConfirmed", "Confirmed"),
    seated: checkedIn ? t("rsvpStatusSeatedAppt", "Checked in") : t("rsvpStatusSeated", "Seated"),
    completed: t("rsvpStatusCompleted", "Completed"),
    no_show: t("rsvpStatusNoShow", "No-show"),
    cancelled: t("rsvpStatusCancelled", "Cancelled"),
  };
}

// Minutes since midnight for an ISO datetime (the timeline's X axis).
export function minOfDay(iso) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}
