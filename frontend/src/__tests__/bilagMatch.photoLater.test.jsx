/**
 * Photo-later matching — "Knyt til eksisterende udgift" (+ the "Mangler
 * bilag" filter).
 *
 * The owner typed the expense; the receipt comes later. Every receipt path
 * must OFFER the typed row instead of booking the purchase twice, and never
 * link on its own:
 *   • Smart Scan on Udgifter: the held photo goes onto the chosen expense
 *     (attach-receipt, link=true) and NO new expense is posted;
 *   • the Godkend-kø: a matched draft is never in "Godkend alle", and
 *     linking posts link-bilag with the draft id;
 *   • ?bilag=missing (from Månedsafslutning) shows only rows without a bilag.
 * Strings are asserted by key (t echoes the key).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a), post: (...a) => post(...a),
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
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const ExpensesPage = (await import("../pages/ExpensesPage")).default;
const GodkendKo = (await import("../components/GodkendKo")).default;
const { holdScanPhoto } = await import("../utils/pendingScanPhoto");

const TYPED = {
  id: "typed1", date: "2026-10-03", amount: 129.95, description: "Netto",
  category_id: "cat1", category_name: "Råvarer", day_diff: 1, amount_diff: 0, same_vendor: true,
};

beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => {
    if (url === "/expenses/categories") return Promise.resolve({ data: [{ id: "cat1", name: "Råvarer" }] });
    if (url === "/expenses/bilag-matches") return Promise.resolve({ data: { candidates: [TYPED], count: 1 } });
    if (url === "/expenses/pending/bilag-matches") return Promise.resolve({ data: { matches: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation(() => Promise.resolve({ data: { ok: true } }));
});

describe("Smart Scan on Udgifter — Knyt til eksisterende udgift", () => {
  it("offers the typed expense and attaches the held photo to it instead of booking a new one", async () => {
    const photo = new File(["jpeg"], "netto.jpg", { type: "image/jpeg" });
    holdScanPhoto(photo, "/expenses");
    render(
      <MemoryRouter initialEntries={[{ pathname: "/expenses", state: {
        source: "smart_scan", verify_hints: [],
        prefill: { vendor: "Netto", amount: 129.95, date: "2026-10-04", vat_amount: 25.99, vat_rate: 0.25 },
      } }]}>
        <Routes><Route path="/expenses" element={<ExpensesPage />} /></Routes>
      </MemoryRouter>,
    );
    const panel = await screen.findByTestId("bilag-match-panel", {}, { timeout: 3000 });
    const call = get.mock.calls.find(([u]) => u === "/expenses/bilag-matches");
    expect(call[1].params).toMatchObject({ amount: 129.95, date: "2026-10-04", vendor: "Netto" });
    fireEvent.click(within(panel).getByText("bilagMatchLinkOne"));
    await waitFor(() => expect(post.mock.calls.some(([u]) => u === "/expenses/typed1/attach-receipt")).toBe(true));
    const [, form] = post.mock.calls.find(([u]) => u === "/expenses/typed1/attach-receipt");
    expect(form.get("file")).toBe(photo);
    expect(form.get("link")).toBe("true");
    expect(form.get("vat_amount")).toBe("25.99");
    // Never a second expense.
    expect(post.mock.calls.some(([u]) => u === "/expenses")).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("bilag-match-panel")).toBeNull());
  });

  it("'no, it's a new expense' hides the offer and the normal save stays", async () => {
    holdScanPhoto(new File(["x"], "x.jpg", { type: "image/jpeg" }), "/expenses");
    render(
      <MemoryRouter initialEntries={[{ pathname: "/expenses", state: {
        source: "smart_scan", verify_hints: [], prefill: { vendor: "Netto", amount: 129.95, date: "2026-10-04" },
      } }]}>
        <Routes><Route path="/expenses" element={<ExpensesPage />} /></Routes>
      </MemoryRouter>,
    );
    const panel = await screen.findByTestId("bilag-match-panel", {}, { timeout: 3000 });
    fireEvent.click(within(panel).getByText("bilagMatchNew"));
    await waitFor(() => expect(screen.queryByTestId("bilag-match-panel")).toBeNull());
  });
});

describe("Mangler bilag filter", () => {
  it("?bilag=missing shows only booked business expenses without a receipt", async () => {
    get.mockImplementation((url) => {
      if (url === "/expenses/categories") return Promise.resolve({ data: [{ id: "cat1", name: "Råvarer" }] });
      if (url === "/expenses") {
        return Promise.resolve({ data: [
          { id: "a", date: "2026-09-08", amount: 300, description: "Hørkram uden bilag", category_id: "cat1" },
          { id: "b", date: "2026-09-09", amount: 50, description: "Netto med bilag", category_id: "cat1", receipt_photo: "x.jpg" },
          { id: "c", date: "2026-09-10", amount: 60, description: "Pant momsfri", category_id: "cat1", is_tax_exempt: true },
        ] });
      }
      return Promise.resolve({ data: [] });
    });
    window.history.pushState({}, "", "/expenses?bilag=missing&from=2026-09-01&to=2026-09-30");
    render(
      <MemoryRouter initialEntries={["/expenses?bilag=missing&from=2026-09-01&to=2026-09-30"]}>
        <Routes><Route path="/expenses" element={<ExpensesPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("bilag-filter-active")).toBeInTheDocument();
    expect((await screen.findAllByText("Hørkram uden bilag")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Netto med bilag")).toBeNull();
    expect(screen.queryByText("Pant momsfri")).toBeNull();
    // The period came from the link: the list was asked for exactly that range.
    const listCall = get.mock.calls.find(([u]) => u === "/expenses");
    expect(listCall[1].params).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    window.history.pushState({}, "", "/");
  });
});

describe("Godkend-kø — a matched draft", () => {
  const DRAFT = {
    id: "d1", date: "2026-10-04", amount: 129.95, description: "NETTO", category_id: "cat1",
    payment_method: "card", receipt_photo: "x.jpg", status: "pending",
  };
  const READY = { ...DRAFT, id: "d2", description: "Rema", amount: 50 };

  it("is never swept by 'Godkend alle' and links with its draft id", async () => {
    get.mockImplementation((url) => {
      if (url === "/expenses/pending") return Promise.resolve({ data: [DRAFT, READY] });
      if (url === "/expenses/pending/bilag-matches") return Promise.resolve({ data: { matches: { d1: [TYPED] } } });
      return Promise.resolve({ data: [] });
    });
    const onApproved = vi.fn();
    render(<GodkendKo getCatName={() => "Råvarer"} currency="DKK" onApproved={onApproved} />);
    const panel = await screen.findByTestId("bilag-match-panel");
    // "Godkend alle" covers the ready draft only.
    const all = screen.getByText((txt) => txt.startsWith("koApproveAll"));
    expect(all.closest("button").textContent).toContain("1");
    expect(screen.getByText("koMatchChip")).toBeInTheDocument();
    fireEvent.click(within(panel).getByText("bilagMatchLinkOne"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/expenses/typed1/link-bilag", { draft_id: "d1" }));
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
  });
});
