/**
 * Gavekort review 12 Oct 2026 (c): a bank payment for an online order that is
 * NOT issued yet was held back with no card — money with no MOMS. It is now
 * booked as a sale (the MOMS page asks about it), and the preview says so,
 * so the owner can issue the card first.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", plan: "pro" } }),
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

const BankImportPage = (await import("../pages/BankImportPage")).default;

const PREVIEW = {
  bank: "danske_bank", bank_label: "Danske Bank",
  summary: { total_rows: 1, income_count: 1, expense_count: 0, income_total: 500, expense_total: 0 },
  transactions: [
    { date: "2026-10-08", description: "Gavekort Mette", amount: 500, type: "income",
      ref_hash: "h1", suggested_category: "Sales", confidence: 1,
      gavekort_order_pending: { order_id: "o1", amount: 500, buyer_name: "Mette" } },
  ],
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
  post.mockImplementation((url) => {
    if (String(url).startsWith("/bank-import/preview")) return Promise.resolve({ data: PREVIEW });
    return Promise.resolve({ data: {} });
  });
});

describe("bank import — a payment for an order not issued yet", () => {
  it("is not marked as held back; the preview says to issue the card first", async () => {
    const { container } = render(<MemoryRouter><BankImportPage /></MemoryRouter>);
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(["a;b"], "konto.csv", { type: "text/csv" })] } });
    const btn = await screen.findByRole("button", { name: "bankUploadAndPreview" });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByTestId("bank-gk-pending")).toBeInTheDocument();
    expect(screen.getByText("bankGkPending")).toBeInTheDocument();
    expect(screen.queryByTestId("bank-gk-match")).toBeNull();
  });

  it("copy in both languages", () => {
    expect(da.bankGkPending).toMatch(/Udsted kortet først/);
    expect(en.bankGkPending).toMatch(/Issue the card first/);
  });
});
