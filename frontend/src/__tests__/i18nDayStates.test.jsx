/**
 * The words for an unbookable day (booking push p1, utils/dayState.js).
 *
 * Every new key has real Danish and English. The two "paused" sentences make
 * no volume claim: "Vi tager ikke imod FLERE…" / "not taking MORE…" read close
 * to "full", and a paused venue is not full. The Turkish line dropped "başka"
 * (other / more) for the same reason. Salon and shop variants carry no table
 * or guest word. dayState.js passes the en.js value verbatim as each fallback.
 */
import { describe, expect, it } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";
import { WORDS } from "../utils/dayState";

const NEW_KEYS = [
  "rsvpDayFull", "rsvpDayPhoneOnly", "rsvpDayTooLate", "rsvpDayFullAria",
  "rsvpDayPhoneAria", "rsvpDayPhoneAriaAppt", "rsvpDayTooLateAria", "rsvpDayNoTimesAria",
  "rsvpBookingOpensAria", "rsvpReasonClosed", "rsvpReasonFull", "rsvpReasonFullAppt",
  "rsvpReasonTooLate", "rsvpReasonNoFit", "rsvpReasonNoFitAppt", "rsvpReasonNotYet",
  "rsvpNoFitCallHint", "rsvpContactVenueDirect", "rsvpNextOpenDay", "rsvpNoneBookableN",
  "rsvpNoneBookableToday", "rsvpNoneBookableOne", "rsvpBookAheadN", "rsvpBookAheadOne",
  "rsvpBookAheadToday",
];
// Keys the page reaches only through dayState.js's say(t, key): the key is a
// variable there, so i18n-parity.cjs and check-i18n-keys.cjs (which match a
// literal t("k")) can't see them. Every WORDS key is checked here instead.
// The only keys allowed to read the same in both languages:
const SAME_IN_BOTH = new Set([]);

describe("day-state words", () => {
  it("every new key has real Danish and English, and they differ", () => {
    for (const k of NEW_KEYS) {
      expect(typeof da[k], k).toBe("string");
      expect(typeof en[k], k).toBe("string");
      expect(da[k].trim(), k).not.toBe("");
      expect(en[k].trim(), k).not.toBe("");
      expect(da[k], k).not.toBe(en[k]);
    }
  });

  it("the placeholders match between the languages", () => {
    const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
    for (const k of NEW_KEYS) expect(vars(da[k]), k).toBe(vars(en[k]));
    expect(en.rsvpReasonFull).toContain("{party}");
    expect(da.rsvpReasonFull).toContain("{party}");
  });

  it("the paused sentences make no volume claim and never say full", () => {
    for (const dict of [da, en]) {
      for (const k of ["rsvpNotAcceptingOnline", "rsvpErrClosed"]) {
        expect(dict[k], k).not.toMatch(/flere|more|fuld|full/i);
      }
    }
    expect(da.rsvpNotAcceptingOnline).toBe("Online-booking er sat på pause lige nu.");
    expect(en.rsvpNotAcceptingOnline).toBe("Online booking is paused right now.");
    expect(da.rsvpErrClosed).toBe("Online-booking blev sat på pause, mens du bookede.");
    expect(en.rsvpErrClosed).toBe("Online booking was paused while you were booking.");
    expect(tr.rsvpErrClosed).not.toMatch(/başka/i);
  });

  it("the chip word for a closed day is still the short word", () => {
    expect(da.rsvpDayClosed).toBe("lukket");
    expect(en.rsvpDayClosed).toBe("closed");
  });

  it("salon and shop variants speak no table or guest word", () => {
    const tableWords = /bord|table|gæst|guest/i;
    for (const dict of [da, en]) {
      for (const k of NEW_KEYS.filter((x) => x.endsWith("Appt"))) {
        expect(dict[k], k).not.toMatch(tableWords);
      }
    }
    // The table variants that name a table do so on purpose.
    expect(da.rsvpReasonNoFit).toMatch(/bord/);
    expect(en.rsvpDayPhoneAria).toMatch(/table/);
  });

  it("dayState.js falls back to the en.js value, verbatim", () => {
    for (const [k, v] of Object.entries(WORDS)) expect(v, k).toBe(en[k]);
  });

  it("every key dayState.js can say has real Danish, not the English fallback", () => {
    // A future WORDS key missing from da.js would pass every repo guard and
    // show English to Danish guests; this is the guard for say(t, key).
    for (const k of Object.keys(WORDS)) {
      expect(typeof da[k], k).toBe("string");
      expect(da[k].trim(), k).not.toBe("");
      if (!SAME_IN_BOTH.has(k)) expect(da[k], k).not.toBe(en[k]);
      const vars = (x) => (x.match(/\{\w+\}/g) || []).sort().join(",");
      expect(vars(da[k]), k).toBe(vars(en[k]));
    }
  });
});
