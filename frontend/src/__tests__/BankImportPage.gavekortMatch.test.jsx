/**
 * Gavekort vs MOMS P0-4 — an online gavekort order paid into the bank was
 * booked as a taxable Sale on import (MOMS at import AND on the meal / the
 * SPV sale). The server now holds such a line back; the preview says so and
 * lets the owner untick it ("not the gavekort — book as a sale"), and the
 * done screen counts the lines held back.
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
  summary: { total_rows: 2, income_count: 2, expense_count: 0, income_total: 1500, expense_total: 0 },
  transactions: [
    { date: "2026-10-08", description: "Overførsel gavekort Mette", amount: 500, type: "income",
      ref_hash: "h1", suggested_category: "Sales", confidence: 1,
      gavekort_order_match: { order_id: "o1", amount: 500, buyer_name: "Mette", voucher_class: "spv" } },
    { date: "2026-10-08", description: "MobilePay 12345", amount: 1000, type: "income",
      ref_hash: "h2", suggested_category: "Sales", confidence: 1 },
  ],
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
  post.mockImplementation((url) => {
    if (String(url).startsWith("/bank-import/preview")) return Promise.resolve({ data: PREVIEW });
    if (url === "/bank-import/confirm") {
      return Promise.resolve({ data: { imported: 1, skipped: 0, errors: [], gavekort_matched: 1, gavekort_matches: [] } });
    }
    return Promise.resolve({ data: {} });
  });
});

const toPreview = async (container) => {
  const input = container.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [new File(["a;b"], "konto.csv", { type: "text/csv" })] } });
  const btn = await screen.findByRole("button", { name: "bankUploadAndPreview" });
  await waitFor(() => expect(btn).not.toBeDisabled());
  fireEvent.click(btn);
  await screen.findByTestId("bank-gk-match");
};

describe("bank import — a gavekort order's payment is not revenue", () => {
  it("the preview marks the line, and an untick sends not_gavekort", async () => {
    const { container } = render(<MemoryRouter><BankImportPage /></MemoryRouter>);
    await toPreview(container);
    expect(screen.getByText("bankGkMatch")).toBeInTheDocument();
    fireEvent.click(screen.getByText("bankGkNotThis"));
    fireEvent.click(screen.getAllByRole("button").find((b) => /^bankPreviewImportBtn/.test(b.textContent)));
    await waitFor(() => expect(post.mock.calls.some(([u]) => u === "/bank-import/confirm")).toBe(true));
    const body = post.mock.calls.find(([u]) => u === "/bank-import/confirm")[1];
    expect(body.transactions.find((x) => x.ref_hash === "h1").not_gavekort).toBe(true);
    expect(body.transactions.find((x) => x.ref_hash === "h2").not_gavekort).toBeUndefined();
  });

  it("left as matched: no override is sent, and the done screen counts the line held back", async () => {
    const { container } = render(<MemoryRouter><BankImportPage /></MemoryRouter>);
    await toPreview(container);
    fireEvent.click(screen.getAllByRole("button").find((b) => /^bankPreviewImportBtn/.test(b.textContent)));
    expect(await screen.findByTestId("bank-done-gk")).toBeInTheDocument();
    const body = post.mock.calls.find(([u]) => u === "/bank-import/confirm")[1];
    expect(body.transactions.find((x) => x.ref_hash === "h1").not_gavekort).toBeUndefined();
  });

  it("copy in both languages", () => {
    for (const k of ["bankGkMatch", "bankGkNotThis", "bankGkMatchUndo", "bankDoneGavekort"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
  });
});
