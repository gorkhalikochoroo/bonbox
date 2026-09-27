/**
 * An arriving table's countdown fits the table instead of trailing off.
 *
 * THE BUG. The detail line on an upcoming table is "om {n} min" in Danish —
 * ~49px of 10px Inter, two of its letters wide m's. A full-size 2-top has 56px
 * for it, but a room drawn smaller to fit the screen (fitRoom scales tables to
 * ~0.85) leaves ~46px, and it rendered "om 13 …": the one number the host acts
 * on, cut off. English ("in 13m") happened to fit, so it only showed in Danish.
 *
 * WHAT THIS PINS: a narrow table gets the short form ("13 min"); a table with
 * room keeps the full "om 13 min". Uses the real Danish dictionary so a copy
 * change that makes the short form long again fails here.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

import FloorPlan from "../components/FloorPlan";
import { da } from "../i18n/da.js";

vi.mock("../services/api", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const t = (key, fallback, vars) => {
  let s = da[key] ?? fallback ?? "";
  for (const [k, v] of Object.entries(vars || {})) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

function arriving(id, seats, shape, scale = 1) {
  return {
    res: { id, label: "Bord 4", capacity_seats: seats, shape, pos_x: 50, pos_y: 50, kind: "table",
           size_scale: scale },
    status: "upcoming",
    booking: { id: `b-${id}`, name: "Gæst", time: "15.20", eta: 13, freesAt: null, freesInMin: null,
               reservation: { id: `b-${id}`, status: "confirmed" } },
    bookings: [],
  };
}

function detailLine(seats, shape, scale) {
  const { container } = render(
    <FloorPlan cells={[arriving(shape + seats + scale, seats, shape, scale)]} nowMs={0} t={t} />,
  );
  return [...container.querySelectorAll("span")]
    .map((el) => el.textContent)
    .find((txt) => /\b13\b/.test(txt));
}

describe("an arriving table's countdown fits", () => {
  it("a 2-top drawn smaller shows the short form, not a cut-off one", () => {
    expect(detailLine(2, "square", 0.85)).toBe("13 min");
  });

  it("a full-size 2-top keeps the full sentence — it fits", () => {
    expect(detailLine(2, "square", 1)).toBe("om 13 min");
  });

  it("a big table keeps the full sentence", () => {
    expect(detailLine(6, "square", 0.85)).toBe("om 13 min");
  });
});
