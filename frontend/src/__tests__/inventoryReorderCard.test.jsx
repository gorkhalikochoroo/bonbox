/**
 * The Home reorder card, and what it does when it cannot check.
 *
 * THE BUG. "Reorder needed (23)" on Home, an empty state on /inventory, same
 * account, same moment — because the card did its own `qty <= min` arithmetic
 * over every row /dashboard/batch returned, including rows /inventory hides
 * and placeholders nothing had ever sold. The rule moved to the backend
 * (services/inventory_reorder.py), which is the only place that can ask the
 * second half of it: does the venue actually sell this?
 *
 * THE PART THAT NEEDS A TEST OF ITS OWN is what happens when the answer is not
 * in the payload — an older backend, a cached response. The tempting fallback
 * is the old arithmetic, and it would silently restore the exact defect. The
 * card shows nothing instead: a missed nudge costs the owner a look at
 * /inventory, a false one costs their belief in every number on the page.
 *
 * Backend contract for the same rule: tests/test_dashboard_inventory_reorder.py.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import InventoryPanel from "../components/dashboard/InventoryPanel";
import { reorderNeededItems } from "../utils/inventoryReorder";

// t() → the fallback text, so assertions read the English the owner sees.
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k, f) => f || k, lang: "en", setLang: () => {}, LANGUAGES: [] }),
}));

const show = (reorder) =>
  render(
    <MemoryRouter>
      {/* `inventoryReorder` — the payload's COMPLETE flagged set. The card may
          not count `inventoryItems`, which is a 50-row display sample; doing
          so is how the same defect returned inverted (silence on Home over a
          Stock page reading "Low stock (6)"). */}
      <InventoryPanel ctx={{ inventoryReorder: reorder, inventoryItems: [] }} />
    </MemoryRouter>,
  );

/** The founder's own fixture, as /dashboard/batch would now serve it. */
const PLACEHOLDER = { id: "1", name: "Vodka", quantity: 0, min_threshold: 200, needs_reorder: false };
const STOCK_OUT = { id: "2", name: "Kaffebønner", quantity: 0, min_threshold: 5, needs_reorder: true };
const HEALTHY = { id: "3", name: "Mælk", quantity: 20, min_threshold: 5, needs_reorder: false };

describe("the Home reorder card counts what the backend flagged", () => {
  it("says nothing when nothing is flagged", () => {
    const { container } = show([PLACEHOLDER, HEALTHY]);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the item and the count when something is", () => {
    show([PLACEHOLDER, STOCK_OUT, HEALTHY]);
    expect(screen.getByText("Reorder needed (1)")).toBeTruthy();
    expect(screen.getByText("Kaffebønner")).toBeTruthy();
    expect(screen.queryByText("Vodka")).toBeNull();
  });

  it("counts the flagged set, not the display sample", () => {
    // The shape production had: the 50-row sample holds none of the low rows
    // (they are older than the newest 50) while the flagged set holds six.
    // A card reading the sample renders nothing here and calls that an answer.
    render(
      <MemoryRouter>
        <InventoryPanel
          ctx={{
            inventoryReorder: [STOCK_OUT],
            inventoryItems: [PLACEHOLDER, HEALTHY],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Reorder needed (1)")).toBeTruthy();
    expect(screen.getByText("Kaffebønner")).toBeTruthy();
  });

  it("renders NOTHING when the flag is absent — it has not learned, it has failed to check", () => {
    // Exactly the shape an older /dashboard/batch returns. Under the old
    // predicate both of these rows are "critical" and the card would announce
    // two. A fallback here is how the bug comes back.
    const { container } = show([
      { id: "1", name: "Vodka", quantity: 0, min_threshold: 200 },
      { id: "2", name: "Takeaway Boxes", quantity: 0, min_threshold: 50 },
    ]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("reorderNeededItems is strict about what counts as a yes", () => {
  it.each([
    ["missing", undefined],
    ["false", false],
    ["null", null],
    ["the string 'true'", "true"],
    ["1", 1],
  ])("%s does not count", (_label, value) => {
    expect(reorderNeededItems([{ name: "x", needs_reorder: value }])).toEqual([]);
  });

  it("survives a payload that is not an array", () => {
    // The card renders before the first fetch resolves.
    expect(reorderNeededItems(undefined)).toEqual([]);
    expect(reorderNeededItems(null)).toEqual([]);
  });
});
