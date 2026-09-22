/**
 * /inventory may only hide a bottle while /bar exists to hold it.
 *
 * THE RULE HAS TWO HALVES AND THEY MUST AGREE. The server decides which rows
 * Home may count and which rows "Low stock (N)" may contain
 * (inventory_reorder.stock_page_visible_clause); this page decides which rows
 * the TABLE lists. If the two ever disagree the count and the list start
 * lying about each other again — which is the defect that produced
 * "Reorder needed (23)" over an empty Stock page.
 *
 * WHY IT IS CONDITIONAL AT ALL. /bar is gated on the `bar_pour` vertical
 * module (navManifest.js). Read out of production, 0 of 72 accounts have that
 * module — or any module — enabled, so for every real owner today /bar is in
 * no sidebar. An unconditional "bottles live on /bar" therefore did not move
 * a running-down bottle to another page; it removed it from every page the
 * owner can open. Hiding a genuine stock-out is the one failure the reorder
 * rule is written to prevent, so the condition is pinned here rather than
 * left as a comment.
 *
 * Server-side contract for the same rule:
 * backend/tests/test_dashboard_inventory_reorder.py.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/** A pour-tracked bottle and a general-stock row, side by side. */
const GIN = {
  id: "1", name: "Gin", quantity: 100, unit: "ml",
  min_threshold: 700, pour_size: 30, cost_per_unit: 0.3, category: "Bar",
};
const MILK = {
  id: "2", name: "Mælk", quantity: 2, unit: "l",
  min_threshold: 10, cost_per_unit: 9, category: "Køl",
};

let barPourEnabled = false;

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", business_type: "restaurant", plan: "pro" }, loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k, f) => f || k, lang: "en", setLang: () => {}, LANGUAGES: [] }),
}));
vi.mock("../hooks/useEntitlements", () => {
  const ent = { plan: "pro", caps: {}, features: {}, has: () => true, hasFeature: () => true, minPlanForFeature: () => null, loading: false };
  return { useEntitlements: () => ent, default: () => ent };
});
vi.mock("../services/api", () => ({
  default: {
    get: vi.fn((url) => {
      if (url === "/inventory") return Promise.resolve({ data: [GIN, MILK] });
      if (url === "/inventory/alerts") return Promise.resolve({ data: [MILK] });
      if (url === "/modules") {
        return Promise.resolve({
          data: { modules: [{ id: "bar_pour", enabled: barPourEnabled }] },
        });
      }
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

const show = async () => {
  const { default: InventoryPage } = await import("../pages/InventoryPage");
  return render(
    <MemoryRouter>
      <InventoryPage />
    </MemoryRouter>,
  );
};

describe("the Stock page's pour filter follows the sidebar", () => {
  beforeEach(() => {
    barPourEnabled = false;
  });

  it("with no /bar page, a bottle is listed here — there is nowhere else", async () => {
    await show();
    await waitFor(() => expect(screen.getAllByText("Mælk").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Gin").length).toBeGreaterThan(0);
  });

  it("with /bar in the sidebar, the bottle belongs to that page", async () => {
    barPourEnabled = true;
    await show();
    // Wait on the row that is never filtered, so the assertion below is made
    // after the list has rendered rather than before it arrives.
    await waitFor(() => expect(screen.getAllByText("Mælk").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByText("Gin")).toBeNull());
  });
});
