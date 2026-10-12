// The refusal a new or edited booking gets when the server answers 409
// room_full — moved out of ReservationsPage.jsx (unchanged apart from the
// no-tables line) so the wording can be tested without mounting the page.
import { hm, overrunsClose, windowAt } from "./bookingTimes";

// A refused time as the 409 room_full detail describes it, for both sheets.
export function warningFrom(d, time, totalCapacity = null) {
  return {
    seats: d.seats ?? d.total_seats ?? d.capacity ?? (totalCapacity || null),
    // undefined (older backend) stays undefined, so the message falls back to
    // the previous wording rather than claiming an empty room.
    busyAtThatTime: d.tables_busy_at_that_time,
    noHours: d.hours_declared === false,
    tooBig:
      Number(d.largest_table) > 0 && Number(d.requested) > Number(d.largest_table) &&
      !(d.clash_table && Number(d.held_seats) >= Number(d.requested)),
    clashTable: d.clash_table || null,
    clashAt: d.clash_at || null,
    largest: Number(d.largest_table) || null,
    requested: Number(d.requested) || null,
    openWindows: Array.isArray(d.open_windows) ? d.open_windows : null,
    time: time || null,
    sitting: Number(d.sitting_min) || null,
  };
}

// The one line a refused time gets — New booking and Edit share it, so the
// same refusal is never explained two ways. "room_full" is raised whenever no
// table fits, which is several different facts; each gets its own sentence.
export function roomFullText(w, t, sitting, { edit = false } = {}) {
  const hours = (w.openWindows || []).map(([a, b]) => `${hm(a)}–${hm(b)}`).join(", ");
  // No tables at all — a brand-new venue. "No table fits this party at that
  // time. Opening hours aren't saved yet…" blamed hours and tables the owner
  // never set up, on the booking the empty page had just promised would work.
  // Say what is true and what the button below does.
  if (w.seats === 0) return t("rsvpNoTablesYet");
  // A taken table is its own fact — "no table seats 12 (largest 8)" was said
  // for a 12 on Bord 5 + 6 whose Bord 5 is booked at 20.00.
  if (edit && w.clashTable && !w.tooBig) {
    return t("rsvpEditClash", "{table} is booked from {time}. Save anyway and they keep no table until you give them one.", {
      table: w.clashTable, time: hm(w.clashAt),
    });
  }
  if (w.tooBig) {
    return edit
      ? t("rsvpEditTooBig", "No table seats {n} (largest: {max}). Save anyway and put tables together when they arrive.", { n: w.requested, max: w.largest })
      : t("rsvpNoTableTooBig", "No table seats {n} (largest: {max}). Book without a table and put tables together when they arrive.", { n: w.requested, max: w.largest });
  }
  if (w.noHours) return t("rsvpNoTableNoHours", "No table fits this party at that time. Opening hours aren't saved yet — add them under Settings → Opening hours.");
  if (w.busyAtThatTime === 0 && w.openWindows && w.openWindows.length === 0) {
    return t("rsvpClosedThatDay", "You're closed that day — change the opening hours under Settings to take it.");
  }
  if (w.busyAtThatTime === 0 && w.openWindows && w.time && !windowAt(w.openWindows, w.time)) {
    return t("rsvpClosedAtTime", "Closed at {time} — open {hours}.", { time: hm(w.time), hours });
  }
  if (overrunsClose(w.openWindows, w.time, w.sitting || sitting)) {
    return t("rsvpNoTableBeforeClose", "No table is free for the whole sitting before closing — pick an earlier time.");
  }
  if (w.busyAtThatTime === 0) return t("rsvpNoTableAtTime", "No table can be booked at that time.");
  return w.seats != null
    ? t("rsvpRoomFullWarn", "That time is full — {n} seats.", { n: w.seats })
    : t("rsvpRoomFullShort", "That time is full.");
}

