/**
 * Push 8 — the Plan view joins a party's tables with a band only where they
 * stand together (QA click-through, 12 Oct 2026: a party at Bord 6 and Bord
 * 7, on opposite walls, drew a band through the middle of the room that read
 * as one long table). Tables across the room carry the same small shared
 * letter instead — named in full in the title and to a screen reader.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import FloorPlan from "../components/FloorPlan";
import { deriveFloorState } from "../utils/floorState";
import { comboLinks } from "../utils/hostStand";

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

const DAY = "2026-10-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const NOW = new Date(at("19:00")).getTime();
const t = (_k, fb, vars) => String(fb).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));
const table = (id, label, seats, x, y) => ({ id, label, capacity_seats: seats, kind: "table", is_active: true, zone: "Sal", pos_x: x, pos_y: y });
const party = (id, ids, status = "seated") => ({
  id, guest_name: "Drop-in", resource_id: ids[0], combined_resource_ids: ids, status,
  starts_at: at("18:30"), ends_at: at("20:30"), party_size: 6, source: "walk_in", allergen_tags: [],
  seated_at: new Date(at("18:30")).toISOString(),
});

// The QA room: Bord 6 on the right wall, Bord 7 bottom-left; 4 + 5 side by side.
const ROOM = [
  table("t4", "Bord 4", 4, 11, 50), table("t5", "Bord 5", 4, 24, 50),
  table("t6", "Bord 6", 4, 88, 50), table("t7", "Bord 7", 4, 11, 83),
  table("t8", "Bord 8", 6, 50, 83),
];
const drawn = (book) => {
  const cells = deriveFloorState(book, ROOM, NOW);
  return render(<FloorPlan cells={cells} nowMs={NOW} t={t} />).container;
};

describe("comboLinks: near is next to each other, not across the room", () => {
  const pos = {
    a: { x: 10, y: 50, hw: 48, hh: 48 }, b: { x: 20, y: 50, hw: 48, hh: 48 },
    c: { x: 88, y: 50, hw: 48, hh: 48 }, d: { x: 11, y: 83, hw: 48, hh: 48 },
  };
  it("two tables side by side are near — one band, linked", () => {
    const [g] = comboLinks([{ id: "x", status: "seated", combined_resource_ids: ["a", "b"] }], pos, 1.6, { room: { w: 880, h: 550 } });
    expect(g.edges.map((e) => e[2])).toEqual([true]);
    expect(g.linked).toBe(true);
  });
  it("opposite walls are not — no band, not linked", () => {
    const [g] = comboLinks([{ id: "y", status: "seated", combined_resource_ids: ["c", "d"] }], pos, 1.6, { room: { w: 880, h: 550 } });
    expect(g.edges.map((e) => e[2])).toEqual([false]);
    expect(g.linked).toBe(false);
    expect(g.ids.sort()).toEqual(["c", "d"]);
  });
  it("a three-table party with one far table: the near pair links, the party is not linked", () => {
    const [g] = comboLinks([{ id: "z", status: "seated", combined_resource_ids: ["a", "b", "c"] }], pos, 1.6, { room: { w: 880, h: 550 } });
    const near = g.edges.filter((e) => e[2]).map(([p, q]) => [p.id, q.id].sort().join("-"));
    expect(near).toEqual(["a-b"]);
    expect(g.linked).toBe(false);
  });
  it("the same positions drawn on a wider screen stand further apart (px, not %)", () => {
    const wide = comboLinks([{ id: "w", status: "seated", combined_resource_ids: ["a", "b"] }], pos, 1.6, { room: { w: 1600, h: 1000 } })[0];
    expect(wide.edges[0][2]).toBe(false); // 160 px apart centre to centre at 1600 wide
  });
});

describe("the Plan view", () => {
  it("Bord 6 + Bord 7 across the room: no band, the same letter on both, named in full", () => {
    const c = drawn([party("p67", ["t6", "t7"])]);
    expect(c.querySelector("[data-combo-links]")).toBeNull();
    const badges = [...c.querySelectorAll("[data-combo-badge]")];
    expect(badges).toHaveLength(2);
    expect(badges.map((b) => b.dataset.comboBadge)).toEqual(["A", "A"]);
    expect(badges.map((b) => b.getAttribute("title")).sort()).toEqual(["Shared with Bord 6", "Shared with Bord 7"]);
    const six = [...c.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").startsWith("Bord 6"));
    expect(six.getAttribute("aria-label")).toContain("Shared with Bord 7");
  });

  it("Bord 4 + Bord 5 side by side: the band, and no letter", () => {
    const c = drawn([party("p45", ["t4", "t5"])]);
    const svg = c.querySelector("[data-combo-links]");
    expect(svg).not.toBeNull();
    expect([...svg.querySelectorAll("[data-combo-edge]")].map((l) => l.getAttribute("data-combo-edge").split(":").sort().join("-"))).toEqual(["t4-t5"]);
    expect(c.querySelector("[data-combo-badge]")).toBeNull();
  });

  it("on a two-top the letter takes the people icon's room (the seat line stays inside the table)", () => {
    const small = [table("s1", "Bord 1", 2, 20, 20), table("s2", "Bord 2", 2, 80, 80)];
    const cells = deriveFloorState([party("p12", ["s1", "s2"])], small, NOW);
    const c = render(<FloorPlan cells={cells} nowMs={NOW} t={t} />).container;
    const btn = [...c.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").startsWith("Bord 1"));
    expect(btn.querySelector("[data-combo-badge]")).not.toBeNull();
    expect(btn.querySelector(".lucide-users")).toBeNull();
    // A four-top keeps its icon beside the letter.
    const big = drawn([party("p67", ["t6", "t7"])]);
    const six = [...big.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").startsWith("Bord 6"));
    expect(six.querySelector(".lucide-users")).not.toBeNull();
  });

  it("two parties apart get two letters, in the order the floor names them", () => {
    const c = drawn([party("p78", ["t8", "t7"]), party("p56", ["t6", "t5"])]);
    const letterOf = (label) => {
      const btn = [...c.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").startsWith(label));
      return btn.querySelector("[data-combo-badge]")?.dataset.comboBadge;
    };
    // Bord 5 + 6 is named first ("Bord 5" < "Bord 7").
    expect(letterOf("Bord 5")).toBe("A");
    expect(letterOf("Bord 6")).toBe("A");
    expect(letterOf("Bord 7")).toBe("B");
    expect(letterOf("Bord 8")).toBe("B");
  });
});
