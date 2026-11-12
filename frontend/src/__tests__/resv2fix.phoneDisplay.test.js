/**
 * Fix round 12 Nov (#5): one service showed "20 55 66 77", "+4511223344" and
 * "+45 20 44 55 66" side by side. displayPhone writes a number it can read
 * as Danish or Portuguese one way, with its code; anything else is shown as
 * typed. The stored value is never changed (display only).
 */
import { describe, it, expect } from "vitest";
import { displayPhone } from "../utils/phoneDisplay";

describe("displayPhone", () => {
  it("writes the three spellings from the waiter test the same way", () => {
    expect(displayPhone("20 55 66 77", "DK")).toBe("+45 20 55 66 77");
    expect(displayPhone("+4511223344", "DK")).toBe("+45 11 22 33 44");
    expect(displayPhone("+45 20 44 55 66", "DK")).toBe("+45 20 44 55 66");
  });

  it("reads a bare 8-digit number as Danish when the venue's country is unknown", () => {
    expect(displayPhone("20556677", null)).toBe("+45 20 55 66 77");
    expect(displayPhone("20556677")).toBe("+45 20 55 66 77");
  });

  it("keeps a number's own code (+ or 00)", () => {
    expect(displayPhone("004520556677", "PT")).toBe("+45 20 55 66 77");
    expect(displayPhone("+351912345678", "DK")).toBe("+351 912 345 678");
    expect(displayPhone("00351 912 345 678", "DK")).toBe("+351 912 345 678");
  });

  it("reads a bare 9-digit number as Portuguese at a Portuguese venue", () => {
    expect(displayPhone("912 345 678", "PT")).toBe("+351 912 345 678");
    expect(displayPhone("912345678", "pt")).toBe("+351 912 345 678");
  });

  it("leaves a number it cannot place as typed (trimmed)", () => {
    // A Portuguese mobile typed bare at a Danish venue: not ours to guess.
    expect(displayPhone("912 345 678", "DK")).toBe("912 345 678");
    // A Danish 8 digits at a Portuguese venue.
    expect(displayPhone("20556677", "PT")).toBe("20556677");
    // 9 digits at a Portuguese venue that are no Portuguese mobile: a Spanish
    // mobile typed without +34, a landline — never "+351 612 345 678".
    expect(displayPhone("612 345 678", "PT")).toBe("612 345 678");
    expect(displayPhone("212345678", "PT")).toBe("212345678");
    // A Swedish number with its code.
    expect(displayPhone(" +46 70 123 45 67 ", "DK")).toBe("+46 70 123 45 67");
    // Words typed in the phone field.
    expect(displayPhone("ring efter 17", "DK")).toBe("ring efter 17");
  });

  it("passes nothing through as nothing", () => {
    expect(displayPhone(null, "DK")).toBeNull();
    expect(displayPhone(undefined, "DK")).toBeUndefined();
    expect(displayPhone("  ", "DK")).toBe("");
  });

  it("never changes the value it was given", () => {
    const raw = "+4511223344";
    displayPhone(raw, "DK");
    expect(raw).toBe("+4511223344");
  });
});
