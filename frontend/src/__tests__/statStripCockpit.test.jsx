/**
 * The Reservations cockpit strip: compact, but nothing that signals can hide.
 *
 * StatStrip replaced six StatCards (a ~95-133px band of boxes over the floor
 * plan) with one ~64px card. What must survive the change:
 *   - a quiet secondary cell hides ONLY on a phone (`hidden sm:block`), never
 *     with a display utility that changes its layout from sm: up — the exact
 *     `hidden sm:flex` defect that turned three of the old tiles into rows;
 *   - a cell with something to say always renders;
 *   - clickable cells are real buttons (keyboard + screen reader), static ones
 *     are not;
 *   - the helper carries its full text as a title, because a slim cell
 *     truncates it.
 */
import { describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import StatStrip from "../components/ui/StatStrip";

const cellOf = (label) => screen.getByText(label).closest("button, div.min-w-0");

describe("StatStrip", () => {
  it("hides a quiet cell below sm: only, and returns it as a block", () => {
    render(
      <StatStrip
        items={[
          { key: "a", label: "Awaiting", value: 0, hideOnPhone: true },
          { key: "b", label: "Covers", value: 38 },
        ]}
      />,
    );
    const quiet = cellOf("Awaiting").className.split(/\s+/);
    expect(quiet).toContain("hidden");
    expect(quiet).toContain("sm:block");
    expect(quiet.some((c) => /(^|:)(flex|inline-flex|grid|inline)$/.test(c))).toBe(false);

    const loud = cellOf("Covers").className.split(/\s+/);
    expect(loud).not.toContain("hidden");
  });

  it("a clickable cell is a real button that fires; a static one is not a button", () => {
    const onClick = vi.fn();
    render(
      <StatStrip
        items={[
          { key: "s", label: "Seated now", value: 3, onClick, selected: true },
          { key: "c", label: "Covers", value: 38 },
        ]}
      />,
    );
    const btn = screen.getByRole("button", { name: /Seated now/ });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Covers/ })).toBeNull();
  });

  it("keeps the full helper text on hover when the cell truncates it", () => {
    render(
      <StatStrip
        items={[{ key: "n", label: "Next arrival", value: "12.00", helper: "Bord 7 · 2 · Sofie Holm" }]}
      />,
    );
    const helper = screen.getByText("Bord 7 · 2 · Sofie Holm");
    expect(helper.getAttribute("title")).toBe("Bord 7 · 2 · Sofie Holm");
    expect(helper.className).toContain("truncate");
  });

  it("colours only the value, by accent", () => {
    render(<StatStrip items={[{ key: "w", label: "On waitlist", value: 2, accent: "warn" }]} />);
    expect(screen.getByText("2").className).toContain("text-amber-600");
    expect(screen.getByText("On waitlist").className).not.toContain("amber");
  });
});

describe("StatStrip on a phone — no blank box in a short last row", () => {
  const spanOf = (label) =>
    cellOf(label).className.split(/\s+/).find((c) => /^col-span-\d$/.test(c));
  const six = (quiet) => [
    { key: "c", label: "Covers", value: 38 },
    { key: "s", label: "Seated now", value: 3 },
    { key: "n", label: "Next arrival", value: "12.00" },
    { key: "a", label: "Awaiting", value: 1, hideOnPhone: quiet.includes("a") },
    { key: "o", label: "Occupancy", value: "64%", hideOnPhone: quiet.includes("o") },
    { key: "w", label: "On waitlist", value: 1, hideOnPhone: quiet.includes("w") },
  ];

  it("four stats are two by two, not three and a lone fourth", () => {
    render(<StatStrip items={six(["o", "w"])} />);
    expect(["Covers", "Seated now", "Next arrival", "Awaiting"].map(spanOf)).toEqual([
      "col-span-3", "col-span-3", "col-span-3", "col-span-3",
    ]);
  });

  it("a single stat left after full rows takes the whole last row", () => {
    const seven = [...six([]), { key: "x", label: "Extra", value: 1 }];
    render(<StatStrip items={seven} />);
    expect(spanOf("Covers")).toBe("col-span-2");
    expect(spanOf("Extra")).toBe("col-span-6");
  });

  it("two left over share it", () => {
    render(<StatStrip items={six(["o"])} />);
    expect(spanOf("Awaiting")).toBe("col-span-3");
    expect(spanOf("On waitlist")).toBe("col-span-3");
  });

  it("full rows stay three across", () => {
    render(<StatStrip items={six(["a", "o", "w"])} />);
    expect(["Covers", "Seated now", "Next arrival"].map(spanOf)).toEqual(["col-span-2", "col-span-2", "col-span-2"]);
  });
});

// Fix round 27 Oct (judge, frame 14): on a tablet (sm to lg) every cell shows
// three across, and the door iPad's five read 3 + 2 beside a blank sixth box.
// The short row shares the width there too; from lg it is one row of six.
describe("StatStrip on a tablet — no blank sixth cell", () => {
  const tabletSpanOf = (label) =>
    cellOf(label).className.split(/\s+/).find((c) => /^sm:col-span-\d$/.test(c));
  const five = [
    { key: "c", label: "Covers", value: 22 },
    { key: "s", label: "Seated now", value: 0 },
    { key: "n", label: "Next arrival", value: "19.00" },
    { key: "a", label: "Awaiting", value: 2, hideOnPhone: true },
    { key: "w", label: "On waitlist", value: 1, hideOnPhone: true },
  ];

  it("five: three across, then two sharing the row (the quiet cells show on a tablet)", () => {
    const { container } = render(<StatStrip items={five} />);
    expect(["Covers", "Seated now", "Next arrival"].map(tabletSpanOf)).toEqual(["sm:col-span-2", "sm:col-span-2", "sm:col-span-2"]);
    expect(["Awaiting", "On waitlist"].map(tabletSpanOf)).toEqual(["sm:col-span-3", "sm:col-span-3"]);
    const grid = container.firstChild;
    expect(grid.className).toContain("grid-cols-6");
    expect(grid.className).not.toContain("sm:grid-cols-3");
    for (const l of ["Covers", "Awaiting"]) expect(cellOf(l).className).toContain("lg:col-span-1");
  });

  it("four: two by two; seven: a lone last cell takes the row", () => {
    render(<StatStrip items={five.slice(0, 4)} />);
    expect(["Covers", "Seated now", "Next arrival", "Awaiting"].map(tabletSpanOf)).toEqual([
      "sm:col-span-3", "sm:col-span-3", "sm:col-span-3", "sm:col-span-3",
    ]);
    cleanup();
    render(<StatStrip items={[...five, { key: "x", label: "Extra", value: 1 }, { key: "y", label: "More", value: 2 }]} />);
    expect(tabletSpanOf("More")).toBe("sm:col-span-6");
  });

  it("the phone's spans are untouched (quiet cells hidden there)", () => {
    render(<StatStrip items={five} />);
    const phone = (l) => cellOf(l).className.split(/\s+/).find((c) => /^col-span-\d$/.test(c));
    expect(["Covers", "Seated now", "Next arrival"].map(phone)).toEqual(["col-span-2", "col-span-2", "col-span-2"]);
  });
});
