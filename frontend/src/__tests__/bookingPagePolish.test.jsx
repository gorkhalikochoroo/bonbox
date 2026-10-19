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
import { markGuestSurface, isGuestSurface, wasGuestPath } from "../lib/guestSurface";

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
    expect(screen.getByRole("button", { name: "Previous month" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("October 2026")).toBeTruthy();
  });

  it("marks closed / full / by-phone days its own way and names only the marks it shows", () => {
    // Booking push p1: struck = closed, a dot = full, plain disabled = by phone.
    const marks = { "2026-09-28": "muted", "2026-09-29": "strike", "2026-09-30": "dot" };
    const words = { strike: "closed", dot: "fully booked", muted: "by phone only" };
    render(
      <MonthCalendar
        value="2026-09-27"
        min="2026-09-27"
        max="2026-10-27"
        isClosed={(iso) => (iso in marks ? true : undefined)}
        markOf={(iso) => marks[iso] || null}
        onPick={vi.fn()}
        locale="en-GB"
        labels={{
          ...labels,
          stateOf: (iso) => words[marks[iso]],
          notYet: () => "booking opens later",
          legend: { strike: "closed", dot: "full", muted: "by phone", beyond: "Book up to 30 days ahead" },
        }}
      />,
    );
    const day = (n, m = "September") => screen.getByRole("button", { name: new RegExp(`\\b${n} ${m}`) });
    expect(day(29).className).toContain("line-through");
    expect(day(29).getAttribute("aria-label")).toMatch(/— closed$/);
    expect(day(30).disabled).toBe(true);
    expect(day(30).className).not.toContain("line-through");
    expect(day(30).querySelector('[data-mark="dot"]')).toBeTruthy();
    expect(day(30).getAttribute("aria-label")).toMatch(/— fully booked$/);
    expect(day(28).disabled).toBe(true);
    expect(day(28).className).not.toContain("line-through");
    expect(day(28).querySelector('[data-mark="dot"]')).toBeNull();
    expect(day(28).getAttribute("aria-label")).toMatch(/— by phone only$/);
    const legend = screen.getByTestId("calendar-legend").textContent;
    expect(legend).toContain("closed");
    expect(legend).toContain("full");
    expect(legend).toContain("by phone");
  });

  it("the legend lists only the marks present in the visible month, and the window only past max", () => {
    const marks = { "2026-09-29": "strike", "2026-09-30": "dot" };
    render(
      <MonthCalendar
        value="2026-09-28"
        min="2026-09-27"
        max="2026-10-27"
        isClosed={(iso) => (iso in marks ? true : undefined)}
        markOf={(iso) => marks[iso] || null}
        onPick={vi.fn()}
        locale="en-GB"
        labels={{
          ...labels,
          stateOf: () => "x",
          notYet: () => "booking opens later",
          legend: { strike: "closed", dot: "full", muted: "by phone", beyond: "Book up to 30 days ahead" },
        }}
      />,
    );
    const legend = () => screen.queryByTestId("calendar-legend");
    expect(legend().textContent).toContain("closed");
    expect(legend().textContent).toContain("full");
    expect(legend().textContent).not.toContain("by phone");
    expect(legend().textContent).not.toContain("Book up to"); // September holds no day past max
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    // October: no marked day, but 28–31 Oct lie past max → only the window line.
    expect(legend().textContent).toBe("Book up to 30 days ahead");
    expect(screen.getByRole("button", { name: /\b30 October — booking opens later$/ }).disabled).toBe(true);
  });

  it("without the new props a closed day looks and reads as before", () => {
    render(
      <MonthCalendar
        value="2026-09-28"
        min="2026-09-27"
        max="2026-10-27"
        isClosed={(iso) => (iso === "2026-09-29" ? true : undefined)}
        onPick={vi.fn()}
        locale="en-GB"
        labels={{ ...labels, closed: "closed" }}
      />,
    );
    const d = screen.getByRole("button", { name: /\b29 September/ });
    expect(d.className).toContain("line-through");
    expect(d.getAttribute("aria-label")).toMatch(/— closed$/);
    expect(screen.queryByTestId("calendar-legend")).toBeNull();
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

describe("a crashed guest page is still known as one", () => {
  // React unmounts a crashed page BEFORE the crash screen renders, so the live
  // counter already says "no guest page". The crash screen asks wasGuestPath —
  // a guest must be offered their booking page back, not bonbox.dk's front page.
  it("remembers the guest path after the page unmounts", () => {
    window.history.replaceState(null, "", "/bistro");
    const unmark = markGuestSurface();
    unmark();
    expect(isGuestSurface()).toBe(false);
    expect(wasGuestPath("/bistro")).toBe(true);
    expect(wasGuestPath("/dashboard")).toBe(false);
    window.history.replaceState(null, "", "/");
  });
});
