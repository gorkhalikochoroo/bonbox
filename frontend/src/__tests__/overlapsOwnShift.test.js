/**
 * "Does this offered shift clash with one I already work?"
 *
 * This decides whether a staffer is shown a shift as takeable, so it fails in
 * two very different directions:
 *
 *   • a MISSED clash costs a wasted tap — the server refuses it anyway;
 *   • a FALSE clash blocks someone from a shift they could have worked, and
 *     they never find out it was wrong.
 *
 * The second is much worse, so every ambiguous case must resolve to "not
 * blocked". These tests exist mainly to pin that asymmetry.
 */
import { describe, expect, it } from "vitest";

import { overlapsOwnShift } from "../utils/overlapsOwnShift";

const own = (date, start_time, end_time) => ({ date, start_time, end_time });
const MINE = [own("2026-08-13", "16:00", "23:00"), own("2026-08-20", "07:00", "15:00")];

describe("overlapsOwnShift", () => {
  it("catches an exact same-slot clash", () => {
    expect(overlapsOwnShift("2026-08-13", "16:00–23:00", MINE)).toBe(true);
  });

  it("catches a partial overlap from either side", () => {
    expect(overlapsOwnShift("2026-08-13", "14:00–17:00", MINE)).toBe(true);
    expect(overlapsOwnShift("2026-08-13", "22:00–23:30", MINE)).toBe(true);
  });

  it("catches an offer fully inside one of mine", () => {
    expect(overlapsOwnShift("2026-08-13", "18:00–19:00", MINE)).toBe(true);
  });

  it("catches one of mine fully inside the offer", () => {
    expect(overlapsOwnShift("2026-08-13", "10:00–23:59", MINE)).toBe(true);
  });

  it("does NOT block a different day", () => {
    expect(overlapsOwnShift("2026-08-14", "16:00–23:00", MINE)).toBe(false);
  });

  it("does NOT block a back-to-back handover", () => {
    // Finishing at 15:00 and starting at 15:00 is a real rota pattern, not a
    // clash. Blocking it would refuse a shift the roster already permits.
    expect(overlapsOwnShift("2026-08-20", "15:00–20:00", MINE)).toBe(false);
    expect(overlapsOwnShift("2026-08-13", "12:00–16:00", MINE)).toBe(false);
  });

  it("does NOT block when the time is unparseable", () => {
    // Never invent a refusal from a string we did not understand.
    for (const t of ["all day", "", "16:00", "abc–def", null, undefined]) {
      expect(overlapsOwnShift("2026-08-13", t, MINE)).toBe(false);
    }
  });

  it("does NOT block on an overnight span it cannot reason about", () => {
    // 22:00–02:00 crosses midnight; comparing minutes-since-midnight would give
    // a wrong answer, so it declines to judge.
    expect(overlapsOwnShift("2026-08-13", "22:00–02:00", MINE)).toBe(false);
  });

  it("accepts both dash characters", () => {
    expect(overlapsOwnShift("2026-08-13", "16:00-23:00", MINE)).toBe(true);   // hyphen
    expect(overlapsOwnShift("2026-08-13", "16:00–23:00", MINE)).toBe(true);   // en dash
  });

  it("survives missing or malformed own-shift rows", () => {
    const junk = [null, {}, { date: "2026-08-13" }, own("2026-08-13", "x", "y")];
    expect(overlapsOwnShift("2026-08-13", "16:00–23:00", junk)).toBe(false);
  });

  it("returns false rather than throwing on a bad shift list", () => {
    expect(overlapsOwnShift("2026-08-13", "16:00–23:00", null)).toBe(false);
    expect(overlapsOwnShift("2026-08-13", "16:00–23:00", undefined)).toBe(false);
  });

  it("returns false with no date", () => {
    expect(overlapsOwnShift(null, "16:00–23:00", MINE)).toBe(false);
  });
});
