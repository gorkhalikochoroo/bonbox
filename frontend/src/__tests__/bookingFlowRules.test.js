/**
 * Rules behind the public booking page's review fixes (Sep 2026).
 *
 * - contactState: a half-typed email left on the hidden tab used to 422 the
 *   whole booking, forever, from a field the guest could no longer see. Only
 *   valid values are sent; the shown field decides whether the form is ready.
 * - rescueDay: a date picked in the calendar beyond the 14-day summary was
 *   treated as closed and silently swapped for the next open day.
 * - alertSoundFor: one sound per poll — a severe allergy wins, a batch of
 *   nothing but cancellations falls, anything else rises.
 * - guest surface: the owner's live alerts must know when a guest page is up.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { contactState, emailOk, phoneOk } from "../utils/guestContact";
import { rescueDay } from "../utils/bookingDay";
import { alertSoundFor } from "../lib/liveAlertKinds";
import { markGuestSurface, useGuestSurface } from "../lib/guestSurface";

describe("guest contact — the server's own rules", () => {
  it("accepts what the server accepts and refuses what it refuses", () => {
    expect(emailOk("anna@example.com")).toBe(true);
    expect(emailOk("a@b.co.uk")).toBe(true);
    expect(emailOk("test@example")).toBe(false);
    expect(emailOk("abc")).toBe(false);
    expect(phoneOk("+45 12 34 56 78")).toBe(true);
    expect(phoneOk("12")).toBe(false);
    expect(phoneOk("1234")).toBe(false);
  });

  it("a bad value left on the hidden tab is dropped, not sent", () => {
    const c = contactState("phone", "abc", "+45 12 34 56 78");
    expect(c.ok).toBe(true);
    expect(c.payload).toEqual({ guest_email: null, guest_phone: "+45 12 34 56 78" });
  });

  it("the shown field with a typo blocks, and says so", () => {
    const c = contactState("email", "test@example", "");
    expect(c.ok).toBe(false);
    expect(c.activeInvalid).toBe(true);
  });

  it("an empty shown field is fine when the other one is valid", () => {
    const c = contactState("email", "", "+45 12 34 56 78");
    expect(c.ok).toBe(true);
    expect(c.activeInvalid).toBe(false);
  });

  it("both valid → both sent (email for the confirmation, phone for the venue)", () => {
    const c = contactState("email", " anna@example.com ", "+45  12 34 56 78");
    expect(c.payload).toEqual({ guest_email: "anna@example.com", guest_phone: "+45 12 34 56 78" });
  });
});

describe("rescueDay", () => {
  const map = { "2026-09-27": false, "2026-09-28": true };
  it("keeps a day outside the 14-day summary", () => {
    expect(rescueDay("2026-11-20", map, "2026-09-28")).toBe("2026-11-20");
  });
  it("keeps an open day", () => {
    expect(rescueDay("2026-09-28", map, "2026-09-29")).toBe("2026-09-28");
  });
  it("moves off a day the summary knows is closed", () => {
    expect(rescueDay("2026-09-27", map, "2026-09-28")).toBe("2026-09-28");
  });
  it("seeds an empty selection with the next open day", () => {
    expect(rescueDay("", map, "2026-09-28")).toBe("2026-09-28");
  });
});

describe("alertSoundFor", () => {
  it("a severe allergy always wins", () => {
    expect(alertSoundFor([{ kind: "cancelled" }, { kind: "new", severe: true }])).toBe("urgent");
  });
  it("only cancellations → the falling cancel chime", () => {
    expect(alertSoundFor([{ kind: "cancelled" }, { kind: "cancelled" }])).toBe("cancel");
  });
  it("any arrival in the batch → the rising chime", () => {
    expect(alertSoundFor([{ kind: "cancelled" }, { kind: "new" }])).toBe("chime");
    expect(alertSoundFor([{ kind: "changed" }])).toBe("chime");
  });
  it("nothing → no sound", () => {
    expect(alertSoundFor([])).toBe(null);
  });
});

describe("guest surface", () => {
  it("subscribers see a guest page appear and disappear", () => {
    const { result } = renderHook(() => useGuestSurface());
    expect(result.current).toBe(false);
    let unmark;
    act(() => {
      unmark = markGuestSurface();
    });
    expect(result.current).toBe(true);
    act(() => unmark());
    expect(result.current).toBe(false);
  });
});
