// What the guest booking page says about a day it can't book online.
//
// The server names the reason (backend reservation_service.DAY_REASONS):
//   null              the day has times
//   past              before today
//   not_yet_bookable  after today + max_advance_days
//   not_accepting     online booking is paused (never named further)
//   closed            the venue's opening hours say closed that weekday
//   no_times          no bookable window, but nobody declared it closed
//   no_fit            online can't seat this party (call instead)
//   too_late          every start is inside the lead time
//   full              every start is taken (bookings or the owner's pacing)
//   closed_date       the owner closed this date for online booking (R1) —
//                     the day carries the owner's `note` and `kind`
//                     ("closed" | "pause"); it reads "lukket" like `closed`
//   closed_or_full    reason unknown (a failed classification, an older server)
// This file turns a reason into a state and the state into words. "Lukket"
// is said only for `closed`: a retired, unknown or failed reason reads
// neutral — "no available times" — never "closed" (booking push p1).
//
// Every t() here passes the en.js value verbatim as its fallback (WORDS);
// i18nDayStates.test.jsx pins WORDS against en.js.
import { fmtDayLabel } from "./guestLocale";

export const WORDS = {
  rsvpDayClosed: "closed",
  rsvpDayFull: "full",
  rsvpDayPhoneOnly: "by phone",
  rsvpDayTooLate: "too late",
  rsvpDayFullAria: "fully booked",
  rsvpDayPhoneAria: "table for {n} by phone only",
  rsvpDayPhoneAriaAppt: "by phone only",
  rsvpDayTooLateAria: "too late to book online",
  rsvpDayNoTimesAria: "no available times",
  rsvpBookingOpensAria: "booking opens {date}",
  rsvpReasonClosed: "Closed this day.",
  rsvpReasonFull: "Fully booked for {party} this day.",
  rsvpReasonFullAppt: "Fully booked this day.",
  rsvpReasonTooLate: "It's too late to book this day online.",
  rsvpReasonNoFit: "We can't find a table for {n} online.",
  rsvpReasonNoFitAppt: "We can't take this booking online.",
  rsvpReasonNotYet: "Booking opens on {date}.",
  rsvpNoFitCallHint: "We're happy to sort it out by phone.",
  rsvpContactVenueDirect: "Contact the venue directly to book.",
  rsvpNextOpenDay: "Next available day: {day}",
  rsvpNoneBookableN: "No available times today or in the next {n} days.",
  rsvpNoneBookableOne: "No available times today or tomorrow.",
  rsvpNoneBookableToday: "No available times today.",
  rsvpBookAheadN: "Book up to {n} days ahead",
  rsvpBookAheadOne: "Book up to 1 day ahead",
  rsvpBookAheadToday: "Today only",
  rsvpFullOrClosedWeek: "No available times in the next 14 days.",
  rsvpNoSlotsDay: "No available times on this day.",
  rsvpPartyOne: "1 guest",
  rsvpPartyN: "{n} guests",
  rsvpReasonPaused: "Online booking is paused this day. Call us to book.",
  rsvpPausedReopens: "Online booking opens again {date}.",
};

const say = (t, key, vars) => (vars ? t(key, WORDS[key], vars) : t(key, WORDS[key]));

// The ONE reading of max_advance_days, mirroring the backend's
// int(settings.get("max_advance_days", 60)): missing / blank / junk → 60,
// 0 → today only, negatives → 0 (the backend then offers nothing). The page
// used to read `Number(x) || 60`, which turned a stored 0 into 60 days.
export function maxAdvanceOf(raw) {
  if (raw === undefined || raw === null) return 60;
  if (typeof raw === "string" && raw.trim() === "") return 60;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 60;
  const whole = Math.trunc(n);
  return whole < 0 ? 0 : whole;
}

// Days on the date strip: today … today + maxAdvance, at most 14. The strip
// ends at the booking window instead of showing days nobody can book.
export function railLength(maxAdvance) {
  return Math.max(1, Math.min(14, maxAdvance + 1));
}

// Party chips per row on a phone: one row while it fits (≤ 7), else two
// even rows — 8 → 4 + 4, 9 → 5 + 4, 10 → 5 + 5.
export function partyColsPhone(n) {
  return n <= 7 ? n : Math.ceil(n / 2);
}

// reason → "closed" | "full" | "no_fit" | "too_late" | "paused" | "neutral"
// | null (open). Anything the page can't name — no_times, past,
// not_yet_bookable, closed_or_full, the retired out_of_window, ANY unknown
// string — is "neutral".
export function dayStateOf(reason) {
  if (reason === null || reason === undefined || reason === "") return null;
  switch (reason) {
    case "closed":
    case "closed_date":
      return "closed";
    case "full":
      return "full";
    case "no_fit":
      return "no_fit";
    case "too_late":
      return "too_late";
    case "not_accepting":
      return "paused";
    default:
      return "neutral";
  }
}

// Per state: the strip chip's bottom word, its aria suffix and the calendar
// mark. A neutral chip shows the month name (no state word).
export const DAY_STATES = {
  closed: { chip: "rsvpDayClosed", aria: "rsvpDayClosed", mark: "strike" },
  full: { chip: "rsvpDayFull", aria: "rsvpDayFullAria", mark: "dot" },
  no_fit: { chip: "rsvpDayPhoneOnly", aria: "rsvpDayPhoneAria", mark: "muted" }, // apptWords → rsvpDayPhoneAriaAppt
  too_late: { chip: "rsvpDayTooLate", aria: "rsvpDayTooLateAria", mark: null },
  neutral: { chip: null /* month name */, aria: "rsvpDayNoTimesAria", mark: null },
  paused: { chip: null, aria: null, mark: null },
};

// The chip word for a reason, or null (the caller shows the month name).
export function chipWord(reason, t) {
  const key = DAY_STATES[dayStateOf(reason)]?.chip;
  return key ? say(t, key) : null;
}

// The aria suffix for an unbookable day ("… — fully booked"). Never null for
// a disabled day: an unnamed state says "no available times".
export function ariaWord(reason, t, { party, apptWords = false } = {}) {
  const state = dayStateOf(reason);
  if (state === "no_fit") {
    return apptWords ? say(t, "rsvpDayPhoneAriaAppt") : say(t, "rsvpDayPhoneAria", { n: party });
  }
  const key = DAY_STATES[state]?.aria || "rsvpDayNoTimesAria";
  return say(t, key);
}

// The calendar mark for a reason: "strike" | "dot" | "muted" | null.
export function markOfReason(reason) {
  return DAY_STATES[dayStateOf(reason)]?.mark || null;
}

// "1 guest" / "2 guests" — the same words as the page's partyLabel.
function partyText(n, t) {
  return Number(n) === 1 ? say(t, "rsvpPartyOne") : say(t, "rsvpPartyN", { n });
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The time area's sentence for an unbookable day; null → the caller uses the
// neutral rsvpNoSlotsDay. not_yet_bookable names the date booking opens
// (day − maxAdvance), and only when that date is after today.
export function reasonSentence(reason, t, { party, apptWords = false, day, today, maxAdvance, lang, closure } = {}) {
  switch (reason) {
    case "closed":
      return say(t, "rsvpReasonClosed");
    case "closed_date": {
      // The owner's own words, verbatim ("Lukket juleaften"); without a note,
      // a pause asks for a call and a closed date says closed.
      const note = typeof closure?.note === "string" ? closure.note.trim() : "";
      if (note) return note;
      return closure?.kind === "pause" ? say(t, "rsvpReasonPaused") : say(t, "rsvpReasonClosed");
    }
    case "full":
      return apptWords ? say(t, "rsvpReasonFullAppt") : say(t, "rsvpReasonFull", { party: partyText(party, t) });
    case "too_late":
      return say(t, "rsvpReasonTooLate");
    case "no_fit":
      return apptWords ? say(t, "rsvpReasonNoFitAppt") : say(t, "rsvpReasonNoFit", { n: party });
    case "not_yet_bookable": {
      if (!day || !today || !Number.isFinite(maxAdvance)) return null;
      const opens = addDaysIso(day, -maxAdvance);
      if (opens <= today) return null;
      return say(t, "rsvpReasonNotYet", { date: fmtDayLabel(opens, lang) });
    }
    default:
      return null;
  }
}

// "Book up to 7 days ahead" — the header text that replaces "Other date"
// when the whole booking window already fits on the strip.
export function bookAheadKey(n) {
  if (n <= 0) return "rsvpBookAheadToday";
  if (n === 1) return "rsvpBookAheadOne";
  return "rsvpBookAheadN";
}

export function bookAheadText(n, t) {
  const key = bookAheadKey(n);
  return key === "rsvpBookAheadN" ? say(t, key, { n }) : say(t, key);
}

// The window line for a booking window of today + `maxAdvance` days, in the
// header's own number: "Book op til 7 dage frem" over "Ingen ledige tider i
// dag eller de næste 7 dage." (it used to say 8 — the strip's chip count — on
// the same screen). A window of 14+ days fills the 14-day strip, which is
// what that line counts.
export function noneBookableText(maxAdvance, t) {
  if (maxAdvance >= 14) return say(t, "rsvpFullOrClosedWeek");
  if (maxAdvance <= 0) return say(t, "rsvpNoneBookableToday");
  if (maxAdvance === 1) return say(t, "rsvpNoneBookableOne");
  return say(t, "rsvpNoneBookableN", { n: maxAdvance });
}

// The calendar legend words (MonthCalendar `labels.legend`).
export function calendarLegend(t, maxAdvance) {
  return {
    strike: say(t, "rsvpDayClosed"),
    dot: say(t, "rsvpDayFull"),
    muted: say(t, "rsvpDayPhoneOnly"),
    beyond: bookAheadText(maxAdvance, t),
  };
}

// The aria suffix for a calendar day past the booking window.
export function bookingOpensAria(iso, t, { maxAdvance, lang } = {}) {
  return say(t, "rsvpBookingOpensAria", { date: fmtDayLabel(addDaysIso(iso, -maxAdvance), lang) });
}
