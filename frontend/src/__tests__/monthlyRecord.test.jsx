/**
 * Måned for måned — the booking record in Indsigt.
 *
 * The owner asked "are we keeping a record of how many bookings we get, month
 * by month?" — and for it to stay uncluttered. So:
 *   - a new venue sees its months since the first booking, not a wall of 0s;
 *   - the current month is marked, older months are plain;
 *   - the quiet second line appears only when there were no-shows / online;
 *   - nothing at all renders until there is a booking to show.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { visibleMonths, monthName } from "../utils/monthlyRecord";

// A FRESH spy per test (see beforeEach) — not one shared spy cleared or reset
// between tests: in Vitest 3 a cleared/reset spy's own promise tracking
// re-raises a rejection the component has already handled, which failed the
// failed-load test on the very error the card swallows correctly.
let get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a) } }));
vi.mock("../hooks/useLanguage", () => ({ useLanguage: () => ({ lang: "da" }) }));

const { MonthlyCard } = await import("../components/reservations/InsightsSection");

const t = (k, fallback, vars) =>
  String(fallback).replace(/\{(\w+)\}/g, (_, v) => (vars && v in vars ? vars[v] : `{${v}}`));
const m = (month, bookings = 0, extra = {}) => ({
  month, bookings, guests: bookings * 2, no_shows: 0, cancelled: 0, online: 0, current: false, ...extra,
});

describe("visibleMonths", () => {
  it("starts at the first month with any booking, newest first", () => {
    const months = [m("2026-09", 0, { current: true }), m("2026-08", 5), m("2026-07", 2), m("2026-06"), m("2026-05")];
    expect(visibleMonths(months).map((x) => x.month)).toEqual(["2026-09", "2026-08", "2026-07"]);
  });

  it("a month with only cancelled bookings still counts as the start", () => {
    const months = [m("2026-09", 1), m("2026-08", 0, { cancelled: 2 }), m("2026-07")];
    expect(visibleMonths(months)).toHaveLength(2);
  });

  it("nothing booked ever → nothing to show", () => {
    expect(visibleMonths([m("2026-09"), m("2026-08")])).toEqual([]);
    expect(visibleMonths(undefined)).toEqual([]);
  });
});

describe("monthName", () => {
  it("names the month in the app language, capitalised", () => {
    expect(monthName("2026-09", "da")).toBe("September 2026");
    expect(monthName("2026-09", "da", false)).toBe("September");
  });
});

describe("MonthlyCard", () => {
  beforeEach(() => {
    get = vi.fn();
  });
  const settle = async () => {
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
  };

  it("lists the months with bookings and guests, marks this month", async () => {
    get.mockResolvedValue({
      data: {
        months: [
          m("2026-09", 58, { current: true, guests: 190, no_shows: 2, online: 21 }),
          m("2026-08", 212, { guests: 640 }),
          m("2026-07"),
        ],
      },
    });
    render(<MonthlyCard t={t} />);
    await waitFor(() => expect(screen.getByText("September 2026")).toBeTruthy());
    expect(get).toHaveBeenCalledWith("/reservations/monthly", { params: { months: 12 } });
    expect(screen.getByText("this month")).toBeTruthy();
    expect(screen.getByText("58")).toBeTruthy();
    expect(screen.getByText("190")).toBeTruthy();
    expect(screen.getByText("No-shows 2 · Online 21")).toBeTruthy();
    expect(screen.getByText("August 2026")).toBeTruthy();
    // July had nothing and is older than the first booking — no row.
    expect(screen.queryByText("Juli 2026")).toBeNull();
    // August had no no-shows or online bookings — no second line for it.
    expect(screen.getAllByText(/No-shows|Online/)).toHaveLength(1);
  });

  it("renders nothing until there is a booking to show", async () => {
    get.mockResolvedValue({ data: { months: [m("2026-09"), m("2026-08")] } });
    const { container } = render(<MonthlyCard t={t} />);
    await settle();
    expect(container.innerHTML).toBe("");
  });

  it("a failed load says so — it never shows an empty record", async () => {
    get.mockRejectedValue({ response: { status: 500 } });
    render(<MonthlyCard t={t} />);
    await settle();
    expect(screen.getByText("Couldn't load the monthly record right now.")).toBeTruthy();
    expect(screen.queryByText("this month")).toBeNull();
  });
});
