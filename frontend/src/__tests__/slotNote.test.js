/**
 * The booking-slot scarcity cue.
 *
 * This is the one string on the booking page with a direct incentive to lie —
 * "Last table" makes people book faster whether or not it is true. So the tests
 * that matter are the ones proving it stays QUIET: no server number, no hint;
 * plenty of tables, no hint. The backend counter already errs low by ignoring
 * combinable tables, and this layer must not add optimism back on top.
 */
import { describe, expect, it } from "vitest";
import { slotNote, SLOT_SCARCE_AT } from "../utils/slotNote";

// Mirrors the app's t(): returns the fallback, so these assert the real copy.
const t = (_key, fallback) => fallback;

describe("slotNote", () => {
  it("says nothing when the server sent no number", () => {
    expect(slotNote(undefined, t)).toBe("");
    expect(slotNote(null, t)).toBe("");
  });

  it("says nothing for a non-number", () => {
    expect(slotNote("2", t)).toBe("");
    expect(slotNote(NaN, t)).toBe("");
    expect(slotNote(Infinity, t)).toBe("");
  });

  it("says nothing when there is plenty left", () => {
    expect(slotNote(SLOT_SCARCE_AT + 1, t)).toBe("");
    expect(slotNote(20, t)).toBe("");
  });

  it("calls one table the last table", () => {
    expect(slotNote(1, t)).toBe("Sidste bord");
  });

  it("counts down only inside the scarce band", () => {
    expect(slotNote(2, t)).toBe("2 tilbage");
    expect(slotNote(SLOT_SCARCE_AT, t)).toBe(`${SLOT_SCARCE_AT} tilbage`);
  });

  it("says nothing at zero — a bookable slot is never '0 left'", () => {
    // compute_slots only emits bookable slots, so 0 can only reach here from a
    // combo-only slot. Showing "0 left" on something you can book would be
    // nonsense; silence is correct.
    expect(slotNote(0, t)).toBe("");
  });

  it("never invents a number it was not given", () => {
    // Whatever comes out must either be empty or contain the exact input.
    for (const n of [1, 2, 3, 4, 9]) {
      const out = slotNote(n, t);
      if (out) expect(out === "Sidste bord" || out.includes(String(n))).toBe(true);
    }
  });
});
