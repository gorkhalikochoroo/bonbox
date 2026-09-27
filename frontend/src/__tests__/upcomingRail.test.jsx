/**
 * "Kommende" — the side column's list of who is still to arrive.
 *
 * It filled an empty strip under the month calendar. What it must get right:
 *   - only bookings nobody has seated yet (requested / confirmed), by time;
 *   - a late party stays listed and SAYS it is late (not colour alone);
 *   - a day that is over lists nothing, rather than yesterday's unmarked
 *     bookings as if they were on their way;
 *   - it caps its length (the column is sticky) and says how many more;
 *   - one tap opens the booking; the waitlist line appears only with a queue.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import UpcomingRail from "../components/reservations/UpcomingRail";
import { selectUpcoming, UPCOMING_MAX_ROWS } from "../utils/upcomingArrivals";

const t = (k, fallback, vars) =>
  String(fallback).replace(/\{(\w+)\}/g, (_, v) => (vars && v in vars ? vars[v] : `{${v}}`));
const at = (h, m) => new Date(2026, 8, 27, h, m).toISOString();
const booking = (id, [h, m], status = "confirmed", extra = {}) => ({
  id, status, starts_at: at(h, m), party_size: 2, guest_name: `Gæst ${id}`, resource_id: "t1", ...extra,
});

describe("selectUpcoming", () => {
  const list = [
    booking("c", [13, 0]),
    booking("s", [12, 0], "seated"),
    booking("r", [12, 30], "requested"),
    booking("x", [12, 15], "cancelled"),
    booking("d", [12, 45], "completed"),
    booking("n", [11, 0], "no_show"),
  ];

  it("keeps requested + confirmed only, earliest first", () => {
    const rows = selectUpcoming(list, { day: "2026-09-27", today: "2026-09-27" });
    expect(rows.map((r) => r.id)).toEqual(["r", "c"]);
  });

  it("a future day lists its bookings; a past day lists nothing", () => {
    expect(selectUpcoming(list, { day: "2026-09-28", today: "2026-09-27" })).toHaveLength(2);
    expect(selectUpcoming(list, { day: "2026-09-26", today: "2026-09-27" })).toEqual([]);
  });
});

describe("UpcomingRail", () => {
  const base = {
    t, isToday: true, nowMs: new Date(2026, 8, 27, 12, 40).getTime(),
    tableLabel: () => "Bord 4", onOpen: () => {}, onShowAll: () => {},
  };

  it("names a late party and a request in words, and flags an allergy", () => {
    render(
      <UpcomingRail
        {...base}
        rows={[
          booking("late", [12, 30]),
          booking("req", [13, 0], "requested", { allergen_tags: ["gluten"] }),
        ]}
      />,
    );
    expect(screen.getByText("late")).toBeTruthy();
    expect(screen.getByText("to confirm")).toBeTruthy();
    expect(screen.getByLabelText("Allergy")).toBeTruthy();
    expect(screen.getAllByText("2 · Bord 4")).toHaveLength(2);
  });

  it("caps the list and says how many more", () => {
    const rows = Array.from({ length: UPCOMING_MAX_ROWS + 3 }, (_, i) => booking(`b${i}`, [13, i]));
    render(<UpcomingRail {...base} rows={rows} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(UPCOMING_MAX_ROWS);
    expect(screen.getByText("+3 more")).toBeTruthy();
  });

  it("one tap opens that booking", () => {
    const onOpen = vi.fn();
    const r = booking("open", [13, 0]);
    render(<UpcomingRail {...base} rows={[r]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Gæst open/ }));
    expect(onOpen).toHaveBeenCalledWith(r);
  });

  it("says the day is done instead of showing an empty box", () => {
    render(<UpcomingRail {...base} rows={[]} />);
    expect(screen.getByText("No more arrivals today")).toBeTruthy();
  });

  it("shows the waitlist line only when someone is waiting", () => {
    const { rerender } = render(<UpcomingRail {...base} rows={[]} waitlistCount={0} />);
    expect(screen.queryByText(/Waitlist/)).toBeNull();
    const onOpenWaitlist = vi.fn();
    rerender(<UpcomingRail {...base} rows={[]} waitlistCount={2} onOpenWaitlist={onOpenWaitlist} />);
    fireEvent.click(screen.getByText("Waitlist · 2").closest("button"));
    expect(onOpenWaitlist).toHaveBeenCalledTimes(1);
  });
});
