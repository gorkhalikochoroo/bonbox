/**
 * A table's label is sized by the box it is actually drawn in.
 *
 * THE BUG. The label class was gated on `sizePx` — the legacy square footprint
 * from seat count — while the node is drawn at `tableDims(shape, seats)`. For
 * most shapes those agree. For a high-top they do not:
 *
 *     hightop 4-top   sizePx 84  (>= 80, so text-sm)   drawn 59x59 circle
 *     hightop 6-top   sizePx 104 (>= 80, so text-sm)   drawn 73x73 circle
 *
 * The label carries `truncate max-w-full`, so 14px type in a 59px circle did
 * not overflow — it silently dropped characters. "Bord 12" rendered "Bord…",
 * on the one string a host navigates the room by.
 *
 * WIDTH, NOT HEIGHT. Nothing in the node is overflow-hidden, so a
 * height-constrained shape (bar is 30px tall) spills harmlessly and loses no
 * information. Gating on height as well would have demoted every bar table —
 * 182px to 244px wide, the most legible labels in the room — to fix a
 * clipping problem that does not exist.
 *
 * WHAT THIS PINS: the gate follows the drawn width, so narrow shapes step down
 * (keeping their characters) and wide-but-short shapes keep the larger type.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

import FloorPlan from "../components/FloorPlan";
import { tableDims } from "../config/tableArchetypes";

vi.mock("../services/api", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

// jsdom has no ResizeObserver; the plan measures its container with one.
// The label class depends on seat count and shape, not on measured size, so a
// no-op observer is faithful here.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const t = (_k, fallback) => fallback ?? "";

function cell(id, { seats, shape, label }) {
  return {
    res: {
      id,
      label,
      capacity_seats: seats,
      shape,
      pos_x: 50,
      pos_y: 50,
      kind: "table",
    },
    status: "free",
    bookings: [],
  };
}

function labelClassFor(seats, shape, label = "Bord 12") {
  const { container } = render(
    <FloorPlan cells={[cell(`${shape}-${seats}`, { seats, shape, label })]} nowMs={0} t={t} />,
  );
  const node = [...container.querySelectorAll("span")].find(
    (el) => el.textContent === label && el.className.includes("truncate"),
  );
  return node ? node.className : null;
}

describe("floor plan label is sized by the drawn box", () => {
  it("a high-top steps DOWN so its label keeps its characters", () => {
    // 59px circle — the case that was truncating.
    expect(tableDims("hightop", 4).w).toBeLessThan(80);
    const cls = labelClassFor(4, "hightop");
    expect(cls, "label span not found — test needs updating").not.toBeNull();
    expect(cls).toContain("text-xs");
    expect(cls).not.toContain("text-sm");
  });

  it("a wide-but-short bar keeps the LARGER label", () => {
    // 182x30 — height-constrained, width-rich. Gating on height would have
    // demoted this; nothing clips it, so it must stay text-sm.
    const dims = tableDims("bar", 4);
    expect(dims.w).toBeGreaterThanOrEqual(80);
    expect(dims.h).toBeLessThan(44);
    const cls = labelClassFor(4, "bar");
    expect(cls).toContain("text-sm");
  });

  it("a wide rect steps UP — it had room all along", () => {
    expect(tableDims("rect", 2).w).toBeGreaterThanOrEqual(80);
    const cls = labelClassFor(2, "rect");
    expect(cls).toContain("text-sm");
  });

  it("a small round table still steps down", () => {
    expect(tableDims("round", 2).w).toBeLessThan(80);
    const cls = labelClassFor(2, "round");
    expect(cls).toContain("text-xs");
  });
});
