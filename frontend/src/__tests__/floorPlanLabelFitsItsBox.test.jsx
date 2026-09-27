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
 * WHAT THIS PINS: the size follows the drawn width, so narrow shapes step down
 * (keeping their characters) and wide-but-short shapes keep the larger type.
 * (Sep 2026: the size is now CHOSEN to fit — 14/13/12/11/10px by the width the
 * text actually has — instead of a two-step class, so the test reads the
 * rendered font size.)
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

function labelSizeFor(seats, shape, label = "Bord 12") {
  const { container } = render(
    <FloorPlan cells={[cell(`${shape}-${seats}`, { seats, shape, label })]} nowMs={0} t={t} />,
  );
  const node = [...container.querySelectorAll("span")].find(
    (el) => el.textContent === label && el.className.includes("truncate"),
  );
  return node ? parseFloat(node.style.fontSize) : null;
}

describe("floor plan label is sized by the drawn box", () => {
  it("a high-top steps DOWN so its label keeps its characters", () => {
    // 59px circle — the case that was truncating.
    expect(tableDims("hightop", 4).w).toBeLessThan(80);
    const px = labelSizeFor(4, "hightop");
    expect(px, "label span not found — test needs updating").not.toBeNull();
    expect(px).toBeLessThan(13);
  });

  it("a wide-but-short bar keeps the LARGER label", () => {
    // 182x30 — height-constrained, width-rich. Gating on height would have
    // demoted this; nothing clips it, so it must stay text-sm.
    const dims = tableDims("bar", 4);
    expect(dims.w).toBeGreaterThanOrEqual(80);
    expect(dims.h).toBeLessThan(44);
    expect(labelSizeFor(4, "bar")).toBe(14);
  });

  it("a wide rect steps UP — it had room all along", () => {
    expect(tableDims("rect", 2).w).toBeGreaterThanOrEqual(80);
    expect(labelSizeFor(2, "rect")).toBe(14);
  });

  it("a small round table still steps down", () => {
    expect(tableDims("round", 2).w).toBeLessThan(80);
    expect(labelSizeFor(2, "round")).toBeLessThan(14);
  });
});
