// utils/dayState.js — the one place the booking page turns a server reason
// into a state and words (booking push p1). Pure; no page mounted.
import { describe, expect, it } from "vitest";
import {
  DAY_STATES,
  ariaWord,
  bookAheadKey,
  bookAheadText,
  chipWord,
  dayStateOf,
  markOfReason,
  maxAdvanceOf,
  noneBookableText,
  partyColsPhone,
  railLength,
  reasonSentence,
} from "../dayState";
import { en } from "../../i18n/en";

// A t() that reads the real EN dictionary, so the words below are the shipped ones.
const t = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let out = en[k] ?? (typeof fb === "string" ? fb : k);
  if (v) out = out.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return out;
};

describe("dayStateOf", () => {
  it("maps every server reason to its state", () => {
    expect(dayStateOf(null)).toBe(null);
    expect(dayStateOf(undefined)).toBe(null);
    expect(dayStateOf("")).toBe(null);
    expect(dayStateOf("closed")).toBe("closed");
    expect(dayStateOf("full")).toBe("full");
    expect(dayStateOf("no_fit")).toBe("no_fit");
    expect(dayStateOf("too_late")).toBe("too_late");
    expect(dayStateOf("not_accepting")).toBe("paused");
  });

  it("reads anything it can't name as neutral — never closed", () => {
    for (const r of ["no_times", "past", "not_yet_bookable", "closed_or_full", "out_of_window", "zzz"]) {
      expect(dayStateOf(r)).toBe("neutral");
    }
  });

  it("gives each state its chip key, aria key and calendar mark", () => {
    expect(DAY_STATES.closed).toEqual({ chip: "rsvpDayClosed", aria: "rsvpDayClosed", mark: "strike" });
    expect(DAY_STATES.full).toEqual({ chip: "rsvpDayFull", aria: "rsvpDayFullAria", mark: "dot" });
    expect(DAY_STATES.no_fit).toEqual({ chip: "rsvpDayPhoneOnly", aria: "rsvpDayPhoneAria", mark: "muted" });
    expect(DAY_STATES.too_late).toEqual({ chip: "rsvpDayTooLate", aria: "rsvpDayTooLateAria", mark: null });
    expect(DAY_STATES.neutral.chip).toBe(null);
    expect(DAY_STATES.neutral.aria).toBe("rsvpDayNoTimesAria");
  });
});

describe("chip and aria words", () => {
  it("closed / full / by phone / too late; neutral keeps the month (null)", () => {
    expect(chipWord("closed", t)).toBe("closed");
    expect(chipWord("full", t)).toBe("full");
    expect(chipWord("no_fit", t)).toBe("by phone");
    expect(chipWord("too_late", t)).toBe("too late");
    for (const r of ["no_times", "closed_or_full", "out_of_window", "zzz", null]) {
      expect(chipWord(r, t)).toBe(null);
    }
  });

  it("names the party for a table, never for an appointment", () => {
    expect(ariaWord("no_fit", t, { party: 7 })).toBe("table for 7 by phone only");
    expect(ariaWord("no_fit", t, { party: 1, apptWords: true })).toBe("by phone only");
    expect(ariaWord("full", t)).toBe("fully booked");
    expect(ariaWord("too_late", t)).toBe("too late to book online");
    expect(ariaWord("closed", t)).toBe("closed");
    expect(ariaWord("closed_or_full", t)).toBe("no available times");
    expect(ariaWord("zzz", t)).toBe("no available times");
  });

  it("marks only closed, full and by phone in the calendar", () => {
    expect(markOfReason("closed")).toBe("strike");
    expect(markOfReason("full")).toBe("dot");
    expect(markOfReason("no_fit")).toBe("muted");
    expect(markOfReason("too_late")).toBe(null);
    expect(markOfReason("closed_or_full")).toBe(null);
    expect(markOfReason(null)).toBe(null);
  });
});

describe("reasonSentence", () => {
  const ctx = { party: 2, day: "2030-01-20", today: "2030-01-08", maxAdvance: 7, lang: "en" };

  it("says each reason in a sentence, with the party only for tables", () => {
    expect(reasonSentence("closed", t, ctx)).toBe("Closed this day.");
    expect(reasonSentence("full", t, ctx)).toBe("Fully booked for 2 guests this day.");
    expect(reasonSentence("full", t, { ...ctx, party: 1 })).toBe("Fully booked for 1 guest this day.");
    expect(reasonSentence("full", t, { ...ctx, apptWords: true })).toBe("Fully booked this day.");
    expect(reasonSentence("too_late", t, ctx)).toBe("It's too late to book this day online.");
    expect(reasonSentence("no_fit", t, { ...ctx, party: 7 })).toBe("We can't find a table for 7 online.");
    expect(reasonSentence("no_fit", t, { ...ctx, apptWords: true })).toBe("We can't take this booking online.");
  });

  it("not_yet_bookable names the day booking opens (day − maxAdvance)", () => {
    // 20 Jan − 7 days = Sunday 13 January.
    expect(reasonSentence("not_yet_bookable", t, ctx)).toBe("Booking opens on Sunday 13 January.");
  });

  it("returns null when it would point at today or the past, and for past / neutral", () => {
    expect(reasonSentence("not_yet_bookable", t, { ...ctx, day: "2030-01-15" })).toBe(null); // opens 8 Jan = today
    expect(reasonSentence("not_yet_bookable", t, { ...ctx, day: "2030-01-10" })).toBe(null);
    expect(reasonSentence("past", t, ctx)).toBe(null);
    for (const r of ["no_times", "closed_or_full", "out_of_window", "zzz", null]) {
      expect(reasonSentence(r, t, ctx)).toBe(null);
    }
  });
});

describe("the booking window", () => {
  it("maxAdvanceOf mirrors the backend's int(settings.get('max_advance_days', 60))", () => {
    const inputs = [undefined, null, "", "abc", 0, 7, 60, -3];
    expect(inputs.map(maxAdvanceOf)).toEqual([60, 60, 60, 60, 0, 7, 60, 0]);
    expect(maxAdvanceOf("7")).toBe(7);
  });

  it("railLength ends the strip at the window, at most 14 days", () => {
    expect([0, 7, 60].map(railLength)).toEqual([1, 8, 14]);
    expect(railLength(13)).toBe(14);
  });

  it("partyColsPhone: one row up to 7, then two even rows", () => {
    expect([5, 6, 7, 8, 9, 10].map(partyColsPhone)).toEqual([5, 6, 7, 4, 5, 5]);
  });

  it("bookAheadKey / bookAheadText", () => {
    expect([0, 1, 9].map(bookAheadKey)).toEqual(["rsvpBookAheadToday", "rsvpBookAheadOne", "rsvpBookAheadN"]);
    expect(bookAheadText(7, t)).toBe("Book up to 7 days ahead");
    expect(bookAheadText(0, t)).toBe("Today only");
  });

  it("noneBookableText counts the strip's days, never a flat 14 under 14", () => {
    expect(noneBookableText(14, t)).toBe("No available times in the next 14 days.");
    expect(noneBookableText(8, t)).toBe("No available times in the next 8 days.");
    expect(noneBookableText(1, t)).toBe("No available times today.");
  });
});
