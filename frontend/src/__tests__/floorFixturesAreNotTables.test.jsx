/**
 * The fixture layer must never behave like a table.
 *
 * A fixture is decoration: a bar counter, a doorway, a window, a wall. The
 * backend guarantees it can never enter the booking path (it is a different
 * table entirely — see backend/app/models/floor_fixture.py). This file guards
 * the OTHER half, which no backend test can see: that on the screen a host is
 * tapping during service, a decorative wall never intercepts a tap meant for a
 * live booking, and never displays anything a host could read as a seat count.
 *
 * It also pins the prop contract that broke the whole floor once already:
 * FloorFixtures takes `t` as a PROP. Calling useLanguage() inside it threw
 * "useLanguage must be used within LanguageProvider" for every consumer
 * rendering FloorPlan outside the provider — including this repo's own
 * floorPlanLabelFitsItsBox test.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import FloorFixtures, { normalizeFixtureKind } from "../components/FloorFixtures";

const bar = {
  id: "f1", kind: "bar_counter", label: null,
  pos_x: 90, pos_y: 40, w_pct: 7, h_pct: 46, rotation_deg: null,
};

describe("floor fixtures are not tables", () => {
  it("renders without a LanguageProvider — `t` is a prop, not a context grab", () => {
    // No provider anywhere in this tree. If this throws, every consumer of
    // FloorPlan outside the provider is broken too.
    expect(() => render(<FloorFixtures fixtures={[bar]} />)).not.toThrow();
  });

  it("does NOT swallow taps during service", () => {
    // Outside Arrange mode the entire layer is pointer-events:none, so a
    // fixture drawn over a busy corner can never eat a host's tap on a table.
    const { container } = render(<FloorFixtures fixtures={[bar]} />);
    const layer = container.firstChild;
    expect(layer.className).toContain("pointer-events-none");
  });

  it("DOES take taps while arranging — otherwise it could not be moved", () => {
    const { container } = render(
      <FloorFixtures fixtures={[bar]} editing onPointerDownDrag={() => {}} onTap={() => {}} />,
    );
    expect(container.firstChild.className).not.toContain("pointer-events-none");
  });

  it("shows no number a host could read as seats", () => {
    const { container } = render(<FloorFixtures fixtures={[bar]} t={(_k, fb) => fb} />);
    // The only text a fixture may carry is its name.
    expect(container.textContent.trim()).toBe("Bar");
    expect(container.textContent).not.toMatch(/\d/);
  });

  it("prefers the owner's own word for their own room", () => {
    const { container } = render(
      <FloorFixtures fixtures={[{ ...bar, label: "Cocktailbaren" }]} t={(_k, fb) => fb} />,
    );
    expect(container.textContent).toContain("Cocktailbaren");
  });

  it("normalises an unknown kind instead of rendering nothing", () => {
    // Clamp-don't-reject, matching the server. A stale client that sends
    // something new must still draw SOMETHING rather than leave a hole.
    expect(normalizeFixtureKind("espresso_machine")).toBe("wall");
    const { container } = render(
      <FloorFixtures fixtures={[{ ...bar, kind: "espresso_machine" }]} t={(_k, fb) => fb} />,
    );
    expect(container.firstChild.children.length).toBe(1);
  });

  it("draws nothing at all for an empty room", () => {
    const { container } = render(<FloorFixtures fixtures={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
