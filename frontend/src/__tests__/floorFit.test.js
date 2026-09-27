/**
 * The floor fits the room it is drawn in.
 *
 * Table positions are a percent of the canvas; table sizes are pixels. A room
 * arranged wide and shown narrower draws the same tables closer — and on a
 * laptop this room drew Bord 3 inside Bord 6's chairs, Bord 9 over "Vindue 1"
 * and Bord 2 on the bar counter. fitRoom nudges overlapping tables apart (and
 * shrinks a crowded room a little) for the view; what is saved never changes.
 */
import { describe, it, expect } from "vitest";
import { fitRoom, overlaps, roomMinWidth, tableFootprint, MIN_SCALE } from "../utils/floorFit";

// The local demo room that overlapped, as the page drew it (positions in %).
const ROOM = [
  ["b1", "Bord 1", 2, "square", 14, 20, 1],
  ["b2", "Bord 2", 2, "square", 32, 20, 1],
  ["b3", "Bord 3", 4, "round", 52, 20, 1.1],
  ["b4", "Bord 4", 2, "square", 72, 20, 1],
  ["b5", "Bord 5", 6, "square", 24, 52, 1.3],
  ["b6", "Bord 6", 8, "square", 52, 52, 1.5],
  ["b7", "Bord 7", 4, "round", 76, 52, 1.1],
  ["b8", "Bord 8", 2, "round", 30, 84, 1],
  ["b9", "Bord 9", 4, "round", 50, 84, 1.1],
  ["b10", "Bord 10", 2, "square", 70, 84, 1],
  ["v1", "Vindue 1", 6, "round", 50, 90, 1],
];
const cells = ROOM.map(([id, label, seats]) => ({ res: { id, label, capacity_seats: seats } }));
const layout = Object.fromEntries(
  ROOM.map(([id, , , shape, x, y, scale]) => [id, { pos_x: x, pos_y: y, shape, size_scale: scale }]),
);
const LAPTOP = { w: 820, h: 512 };

describe("fitRoom", () => {
  it("the room as saved really does overlap at laptop size", () => {
    expect(overlaps(cells, layout, LAPTOP)).toBeGreaterThan(0);
  });

  it("leaves no two tables overlapping, inside the walls", () => {
    const { pos, scale } = fitRoom(cells, layout, LAPTOP);
    const fittedLayout = Object.fromEntries(
      Object.entries(layout).map(([id, p]) => [id, { ...p, ...pos[id] }]),
    );
    expect(overlaps(cells, fittedLayout, LAPTOP, scale)).toBe(0);
    for (const [id, p] of Object.entries(fittedLayout)) {
      const { hw, hh } = tableFootprint(cells.find((c) => c.res.id === id).res, p, scale);
      const x = (p.pos_x / 100) * LAPTOP.w;
      const y = (p.pos_y / 100) * LAPTOP.h;
      expect(x - hw).toBeGreaterThanOrEqual(0);
      expect(x + hw).toBeLessThanOrEqual(LAPTOP.w);
      expect(y - hh).toBeGreaterThanOrEqual(0);
      expect(y + hh).toBeLessThanOrEqual(LAPTOP.h);
    }
  });

  it("a crowded room is drawn smaller, never below the legible floor", () => {
    const { scale } = fitRoom(cells, layout, { w: 560, h: 350 });
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it("a room with space is left exactly as the owner arranged it", () => {
    const roomy = { a: { pos_x: 20, pos_y: 30, shape: "round" }, b: { pos_x: 70, pos_y: 60, shape: "round" } };
    const two = [{ res: { id: "a", capacity_seats: 2 } }, { res: { id: "b", capacity_seats: 2 } }];
    const { pos, scale, moved } = fitRoom(two, roomy, LAPTOP);
    expect(scale).toBe(1);
    expect(moved).toBe(0);
    expect(pos.a).toEqual({ pos_x: 20, pos_y: 30 });
  });

  it("keeps tables off the bar counter, which never moves", () => {
    const one = [{ res: { id: "t", capacity_seats: 2 } }];
    const onBar = { t: { pos_x: 90, pos_y: 50, shape: "square" } };
    const bar = [{ kind: "bar_counter", pos_x: 92, pos_y: 50, w_pct: 6, h_pct: 40 }];
    const { pos } = fitRoom(one, onBar, LAPTOP, bar);
    const { hw } = tableFootprint(one[0].res, { ...onBar.t, ...pos.t });
    const tableRight = (pos.t.pos_x / 100) * LAPTOP.w + hw;
    const barLeft = (0.92 - 0.03) * LAPTOP.w;
    expect(tableRight).toBeLessThanOrEqual(barLeft + 1);
  });

  it("tables that were already clear stay exactly where they were saved", () => {
    const { pos } = fitRoom(cells, layout, LAPTOP);
    // Bord 1, 2 and 4 (top row) and Bord 10 collide with nothing as saved.
    for (const id of ["b1", "b2", "b4", "b10"]) {
      expect(pos[id]).toEqual({ pos_x: layout[id].pos_x, pos_y: layout[id].pos_y });
    }
  });

  it("an owner-placed table wins its spot over one that was never placed", () => {
    const two = [
      { res: { id: "placed", capacity_seats: 4, pos_x: 50, pos_y: 50 } },
      { res: { id: "auto", capacity_seats: 4 } }, // no saved position
    ];
    const l = {
      placed: { pos_x: 50, pos_y: 50, shape: "round" },
      auto: { pos_x: 51, pos_y: 50, shape: "round" },
    };
    const { pos } = fitRoom(two, l, LAPTOP);
    expect(pos.placed).toEqual({ pos_x: 50, pos_y: 50 });
    expect(pos.auto).not.toEqual({ pos_x: 51, pos_y: 50 });
  });

  it("does nothing before the canvas has a size", () => {
    expect(fitRoom(cells, layout, { w: 0, h: 0 })).toEqual({ scale: 1, pos: {}, moved: 0 });
  });
});

describe("roomMinWidth", () => {
  it("a phone draws this room wide enough to pan instead of stacking tables", () => {
    const w = roomMinWidth(cells, layout);
    expect(w).toBeGreaterThan(560);
    const size = { w, h: Math.round((w * 10) / 16) };
    const { pos, scale } = fitRoom(cells, layout, size);
    const fittedLayout = Object.fromEntries(
      Object.entries(layout).map(([id, p]) => [id, { ...p, ...pos[id] }]),
    );
    expect(overlaps(cells, fittedLayout, size, scale)).toBe(0);
  });

  it("a small room keeps the usual 560px floor", () => {
    const two = [{ res: { id: "a", capacity_seats: 2 } }, { res: { id: "b", capacity_seats: 2 } }];
    const l = { a: { pos_x: 20, pos_y: 30, shape: "round" }, b: { pos_x: 70, pos_y: 60, shape: "round" } };
    expect(roomMinWidth(two, l)).toBe(560);
  });
});
