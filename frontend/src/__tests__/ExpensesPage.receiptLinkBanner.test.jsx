/**
 * Udgifter → "Tag billede af kvittering" → "Knyt til eksisterende udgift"
 * (Push 8 gate, 15 Oct 2026). The modal closed and the page banner said
 * "Udgift tilføjet fra kvittering" although no expense was added — the
 * bilag went onto one the owner had typed. The page now says where it went.
 *
 * ReceiptCapture is stubbed here; its real side of the contract (onSaved is
 * called with { linked: candidate }) is pinned by
 * ReceiptCapture.bilagMatch.test.jsx. Strings are asserted by key.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a), post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(() => Promise.resolve({ data: {} })), patch: vi.fn(), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join("|")}` : k;
    },
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/ReceiptCapture", () => ({
  default: ({ onSaved }) => (
    <div>
      <button type="button" onClick={() => onSaved?.({
        linked: { id: "typed1", description: "Grøntmesteren", date: "2026-10-13", category_name: "Råvarer" },
      })}>stub-link</button>
      <button type="button" onClick={() => onSaved?.()}>stub-save</button>
    </div>
  ),
}));

const ExpensesPage = (await import("../pages/ExpensesPage")).default;
const { formatDateClear } = await import("../utils/dateFormat");

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  get.mockImplementation((url) => {
    if (url === "/expenses/categories") return Promise.resolve({ data: [{ id: "cat1", name: "Råvarer" }] });
    return Promise.resolve({ data: [] });
  });
});

const openReceipt = async () => {
  render(<MemoryRouter initialEntries={["/expenses"]}><ExpensesPage /></MemoryRouter>);
  fireEvent.click(await screen.findByText("expSnapHeroTitle"));
};

describe("Udgifter — the banner after a receipt", () => {
  it("says the bilag was attached when it went onto an existing expense", async () => {
    await openReceipt();
    fireEvent.click(await screen.findByText("stub-link"));
    expect(
      await screen.findByText(`bilagMatchLinked:Grøntmesteren|${formatDateClear("2026-10-13")}`),
    ).toBeInTheDocument();
    expect(screen.queryByText("expenseAddedFromReceipt")).toBeNull();
    await waitFor(() => expect(screen.queryByText("stub-link")).toBeNull());
  });

  it("still says an expense was added when one was", async () => {
    await openReceipt();
    fireEvent.click(await screen.findByText("stub-save"));
    expect(await screen.findByText("expenseAddedFromReceipt")).toBeInTheDocument();
    expect(screen.queryByText(/^bilagMatchLinked/)).toBeNull();
  });
});
