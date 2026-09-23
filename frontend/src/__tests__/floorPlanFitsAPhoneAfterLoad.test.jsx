/**
 * The floor plan on a phone: stays readable, and says so.
 *
 * TWO DEFECTS ARE PINNED HERE, and they pull in opposite directions.
 *
 * 1. THE MEASUREMENT NEVER RAN. FloorPlan measured its scroller with `useRef`
 *    read inside `useEffect(…, [])`. That node renders after an early return —
 *    the component shows an empty state while the parent's /resources fetch is
 *    in flight — so on a late-arriving load the effect read a null ref, bailed
 *    before attaching its ResizeObserver, and with `[]` deps never ran again.
 *    Whatever the measurement drove was stuck at its initial value for the life
 *    of the page. A callback ref cannot have this bug.
 *
 * 2. WHAT THE MEASUREMENT USED TO DRIVE WAS THE WRONG IDEA. It scaled the whole
 *    canvas down to fit. Making that actually run was worse than leaving it
 *    broken: at 390px the scale is 0.639, and everything inside is absolute px
 *    — table labels at 7.7px, a 2-top's tap target at 40.9px (under the 44pt
 *    minimum), a bar counter 19.2px tall. A host mid-service must READ and TAP
 *    a table. So the room stays 1:1 and PANS, and the measurement now drives
 *    the affordance instead.
 *
 * WHY THE TEST IS SHAPED LIKE THIS. Rendering with tables already present
 * passes against the broken code — with the node there on first render the old
 * effect worked fine. The bug lives entirely in the ORDER, so the test has to
 * mount empty and let the tables arrive, or it asserts nothing. jsdom has no
 * layout, so the scroller's widths are stubbed to a real phone's numbers.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import FloorPlan from "../components/FloorPlan";

const PHONE_W = 358;   // a 390px phone minus the page's 16px gutters
const CANVAS_W = 560;  // the canvas's min-width — the room's natural size

/** Pretend the scroller is a phone: 358px of window onto a 560px room. */
function stubLayout({ client, scroll }) {
  const isScroller = (el) => (el.className || "").includes("overflow-x-auto");
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function () { return isScroller(this) ? client : 0; },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function () { return isScroller(this) ? scroll : 0; },
  );
}

beforeAll(() => {
  // `globalThis`, not `global` — the repo's no-undef guard treats bare
  // `global` as an undefined reference, and it is right to: it is Node-only.
  globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});
afterEach(() => vi.restoreAllMocks());

const t = (_k, fb) => (typeof fb === "string" ? fb : _k);

const cell = (id, label, seats) => ({
  res: { id, label, capacity_seats: seats, kind: "table",
         pos_x: 50, pos_y: 50, shape: "round", is_active: true },
  booking: null,
});

const canvasEl = (c) => c.querySelector('[class*="min-w-"]');

describe("the floor plan on a phone", () => {
  it("measures AFTER a late load — mounts empty, tables arrive, hint appears", () => {
    stubLayout({ client: PHONE_W, scroll: CANVAS_W });

    // 1. Mount with nothing — what happens while /resources is in flight.
    const { container, rerender } = render(
      <FloorPlan cells={[]} nowMs={Date.now()} t={t} />,
    );
    expect(canvasEl(container)).toBeNull();

    // 2. The fetch lands. The old mount-only effect could never survive this.
    rerender(
      <FloorPlan cells={[cell("a", "Bord 1", 2), cell("b", "Bord 2", 4)]}
                 nowMs={Date.now()} t={t} />,
    );

    // The measurement ran: it knows the room overflows and says so.
    expect(screen.getByText(/Swipe to see the rest of the room/i)).toBeTruthy();
  });

  it("keeps the room 1:1 rather than scaling it down to fit", () => {
    // The regression that matters for a host mid-service. A scaled canvas puts
    // every label and tap target below usable size; panning does not.
    stubLayout({ client: PHONE_W, scroll: CANVAS_W });
    const { container } = render(
      <FloorPlan cells={[cell("a", "Bord 1", 2)]} nowMs={Date.now()} t={t} />,
    );
    const canvas = canvasEl(container);
    expect(canvas.getAttribute("style") || "").not.toMatch(/transform:\s*scale\(/);
    // …and it stays scrollable, which is what makes 1:1 viable at all.
    expect(canvas.parentElement.className).toContain("overflow-x-auto");
  });

  it("says nothing when the whole room already fits", () => {
    stubLayout({ client: 900, scroll: 900 });
    render(<FloorPlan cells={[cell("a", "Bord 1", 2)]} nowMs={Date.now()} t={t} />);
    expect(screen.queryByText(/Swipe to see the rest/i)).toBeNull();
  });

  it("shows the empty state rather than an empty room when there are no tables", () => {
    stubLayout({ client: PHONE_W, scroll: PHONE_W });
    render(<FloorPlan cells={[]} nowMs={Date.now()} t={t} />);
    expect(screen.getByText(/No tables yet/i)).toBeTruthy();
  });
});
