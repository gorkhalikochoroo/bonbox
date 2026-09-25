/**
 * A table booked for tonight is free at lunch.
 *
 * THE DEFECT. deriveFloorState marked ANY table with a confirmed booking later
 * today as "upcoming", with no horizon. The floor headline only counts "free"
 * tables, so on a Friday at 11:40 — three parties seated, five tables empty,
 * the evening well booked — it read "All tables occupied · next frees 12.30".
 * A host trusting that turns walk-ins away from empty tables, and the busier
 * the evening, the more tables it wrongly takes off the floor.
 *
 * Reproduced on a live test account before the fix: a table booked for 20:00
 * was painted amber at 11:40 and counted as not-free.
 */
import { describe, it, expect } from "vitest";
import { deriveFloorState, HOLD_WINDOW_MIN } from "../utils/floorState";

// A fixed "now": Friday 25 Sep 2026, 11:40 local.
const NOW = new Date(2026, 8, 25, 11, 40).getTime();
const at = (h, m) => new Date(2026, 8, 25, h, m).toISOString();
const table = (id, seats = 2) => ({ id, label: `Bord ${id}`, capacity_seats: seats, kind: "table", is_active: true });
const booking = (id, resource_id, [h, m], status = "confirmed", mins = 90) => ({
  id, resource_id, guest_name: `G${id}`, party_size: 2, status,
  starts_at: at(h, m),
  ends_at: new Date(new Date(at(h, m)).getTime() + mins * 60000).toISOString(),
});
const statusOf = (cells, id) => cells.find((c) => String(c.res.id) === id).status;

describe("the floor's hold window", () => {
  it("a table booked for 20:00 is FREE at 11:40", () => {
    const cells = deriveFloorState([booking("x", "8", [20, 0])], [table("8")], NOW);
    expect(statusOf(cells, "8")).toBe("free");
    // …with no booking attached, so the walk-in picker also reads it as free.
    expect(cells[0].booking).toBeNull();
  });

  it("a table whose party arrives in 20 minutes is HELD", () => {
    const cells = deriveFloorState([booking("x", "7", [12, 0])], [table("7")], NOW);
    expect(statusOf(cells, "7")).toBe("upcoming");
    expect(cells[0].booking.eta).toBe(20);
  });

  it("the boundary is the hold window, and it moves with the clock", () => {
    // Exactly at the window: still held. One minute past it: free.
    const edge = new Date(NOW + HOLD_WINDOW_MIN * 60000);
    const past = new Date(NOW + (HOLD_WINDOW_MIN + 1) * 60000);
    const b = (d) => ({ ...booking("x", "2", [0, 0]), starts_at: d.toISOString() });
    expect(statusOf(deriveFloorState([b(edge)], [table("2")], NOW), "2")).toBe("upcoming");
    expect(statusOf(deriveFloorState([b(past)], [table("2")], NOW), "2")).toBe("free");
    // Later the same day, that far booking is close — the floor flips it itself.
    const later = NOW + 60 * 60000;
    expect(statusOf(deriveFloorState([b(past)], [table("2")], later), "2")).toBe("upcoming");
  });

  it("a LATE party (start already passed, not seated) stays held — the host must see it", () => {
    const cells = deriveFloorState([booking("x", "3", [11, 0])], [table("3", 4)], NOW);
    expect(statusOf(cells, "3")).toBe("upcoming");
  });

  it("a seated table is seated regardless of what is booked on it later", () => {
    const cells = deriveFloorState(
      [booking("a", "6", [11, 15], "seated"), booking("b", "6", [18, 30])],
      [table("6", 6)], NOW,
    );
    expect(statusOf(cells, "6")).toBe("seated");
  });

  it("the real Friday: 3 seated, 4 arriving soon, 1 booked tonight → 1 free, not 'all occupied'", () => {
    const tables = ["1", "2", "3", "4", "5", "6", "7", "8"].map((id) => table(id, 4));
    const res = [
      booking("s1", "6", [11, 15], "seated"),
      booking("s2", "3", [11, 0], "seated"),
      booking("s3", "1", [11, 30], "seated"),
      booking("u1", "7", [12, 0]),
      booking("u2", "4", [12, 15]),
      booking("u3", "5", [12, 30]),
      booking("u4", "2", [13, 0]),
      booking("e1", "8", [20, 0]),   // tonight
    ];
    const cells = deriveFloorState(res, tables, NOW);
    const count = (s) => cells.filter((c) => c.status === s).length;
    expect(count("seated")).toBe(3);
    expect(count("upcoming")).toBe(4);
    expect(count("free")).toBe(1);  // before the fix: 0 → "All tables occupied"
  });
});
