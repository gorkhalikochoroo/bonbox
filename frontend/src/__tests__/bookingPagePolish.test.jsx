/**
 * The public booking page, mobile polish (Sep 2026).
 *
 * - The venue monogram used the first CHARACTER of each word, so
 *   "Testcafé (lokal)" rendered "T(" in the green tile.
 * - "Other date" opened the phone's native date field; it is now the page's own
 *   month grid — Monday first, past and closed days not pickable.
 * - The cookie banner covered most of the booking form on a guest's first
 *   visit. Guest pages keep only strictly-necessary storage (the embedded
 *   widget already skipped the banner for that reason), so the page marks
 *   itself and the banner stays away — everywhere else it still asks.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (key, fallback) => fallback ?? key, lang: "en" }),
}));

import { venueMonogram } from "../utils/venueMonogram";
import MonthCalendar from "../components/MonthCalendar";
import CookieConsent from "../components/CookieConsent";
import { markGuestSurface } from "../lib/guestSurface";

describe("venueMonogram", () => {
  it("takes letters, not brackets", () => {
    expect(venueMonogram("Testcafé (lokal)")).toBe("TL");
    expect(venueMonogram("Café (Nørrebro)")).toBe("CN");
  });
  it("keeps the old behaviour for ordinary names", () => {
    expect(venueMonogram("BonBox")).toBe("BO");
    expect(venueMonogram("Bistro Nord")).toBe("BN");
    expect(venueMonogram("")).toBe("·");
  });
});

describe("MonthCalendar", () => {
  const labels = { prev: "Previous month", next: "Next month" };

  it("starts the week on Monday and blocks past and closed days", () => {
    const onPick = vi.fn();
    render(
      <MonthCalendar
        value="2026-09-27"
        min="2026-09-27"
        max="2026-11-30"
        isClosed={(iso) => (iso === "2026-09-29" ? true : undefined)}
        onPick={onPick}
        locale="en-GB"
        labels={labels}
      />,
    );
    // September 2026 starts on a Tuesday: one empty Monday cell, then the 1st.
    expect(screen.getByText("Mon")).toBeTruthy();
    const day = (n) => screen.getByRole("button", { name: new RegExp(`\\b${n} September`) });
    expect(day(26).disabled).toBe(true); // past
    expect(day(29).disabled).toBe(true); // closed
    expect(day(28).disabled).toBe(false);
    fireEvent.click(day(28));
    expect(onPick).toHaveBeenCalledWith("2026-09-28");
    // Cannot page back before the first bookable month.
    expect(screen.getByRole("button", { name: "Previous month" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("October 2026")).toBeTruthy();
  });
});

describe("cookie banner on guest pages", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  const renderBanner = () =>
    render(
      <MemoryRouter>
        <CookieConsent />
      </MemoryRouter>,
    );

  it("still asks on an ordinary page", () => {
    vi.useFakeTimers();
    renderBanner();
    act(() => vi.advanceTimersByTime(700));
    expect(document.body.textContent).toMatch(/cookie/i);
  });

  it("stays away while a guest booking page is mounted", () => {
    vi.useFakeTimers();
    const unmark = markGuestSurface();
    renderBanner();
    act(() => vi.advanceTimersByTime(700));
    expect(document.body.textContent).not.toMatch(/cookie/i);
    unmark();
  });
});
