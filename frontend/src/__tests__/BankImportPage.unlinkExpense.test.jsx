/**
 * Bank reconcile: a linked bank line is named, counted once, and can be
 * undone (Push 8).
 *
 * The server now stores an expense "link" and leaves the bank line out of
 * every money total while it stands; the row comes back with
 * linked_target_id / linked_target_label instead of suggestions. The page
 * names the expense it paid and offers "Fortryd kobling", which posts the
 * same confirm-matches endpoint with action "unlink" and reloads the list.
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
  summary: { total_rows: 1, income_count: 0, expense_count: 1, income_total: 0, expense_total: 1250 },
  transactions: [
    { date: "2026-10-08", description: "HORKRAM A/S", amount: -1250, type: "expense",
      ref_hash: "h1", suggested_category: "Varekøb", confidence: 1 },
  ],
};
const LINKED = {
  import_id: "danske_bank",
  counts: { high: 0, medium: 0, low: 0, none: 1 },
  transactions: [
    { txn_id: "bank-1", txn_type: "expense", date: "2026-10-08", amount: 1250,
      description: "HORKRAM A/S", already_matched: true, suggestions: [],
      linked_target_id: "exp-9", linked_target_label: "Hørkram (bon)" },
  ],
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => Promise.resolve({
    data: String(url).includes("/suggestions") ? LINKED : [],
  }));
  post.mockImplementation((url) => {
    if (String(url).startsWith("/bank-import/preview")) return Promise.resolve({ data: PREVIEW });
    if (String(url).startsWith("/bank-import/confirm")) return Promise.resolve({ data: { imported: 1, skipped: 0, errors: [] } });
    return Promise.resolve({ data: { confirmed: 1, skipped: 0, errors: [] } });
  });
});

async function openReconcile() {
  const { container } = render(<MemoryRouter><BankImportPage /></MemoryRouter>);
  const input = container.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [new File(["a;b"], "konto.csv", { type: "text/csv" })] } });
  const preview = await screen.findByRole("button", { name: "bankUploadAndPreview" });
  await waitFor(() => expect(preview).not.toBeDisabled());
  fireEvent.click(preview);
  const importBtn = await screen.findByRole("button", { name: /^bankPreviewImportBtn/ });
  await waitFor(() => expect(importBtn).not.toBeDisabled());
  fireEvent.click(importBtn);
  fireEvent.click(await screen.findByRole("button", { name: "bankDoneMatchInvoices" }));
}

describe("bank reconcile — a linked bank line", () => {
  it("names the expense it paid and offers the undo, not suggestions", async () => {
    await openReconcile();
    const row = await screen.findByTestId("bank-recon-linked");
    expect(row.textContent).toContain("bankReconLinkedTo:Hørkram (bon)");
    expect(screen.queryByText("bankReconNoMatch")).toBeNull();
  });

  it("an expense with no description is named by the word, never a blank", async () => {
    get.mockImplementation((url) => Promise.resolve({
      data: String(url).includes("/suggestions")
        ? { ...LINKED, transactions: [{ ...LINKED.transactions[0], linked_target_label: null }] }
        : [],
    }));
    await openReconcile();
    const row = await screen.findByTestId("bank-recon-linked");
    expect(row.textContent).toContain("bankReconLinkedTo:bankReconRowExpense");
  });

  it("the undo posts action unlink for that pair and reloads the list", async () => {
    await openReconcile();
    fireEvent.click(await screen.findByRole("button", { name: "bankReconUnlink" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      "/bank-import/danske_bank/confirm-matches",
      { matches: [{ txn_id: "bank-1", target_type: "expense", target_id: "exp-9", action: "unlink" }] },
    ));
    await waitFor(() => expect(get.mock.calls.filter(([u]) => String(u).includes("/suggestions")).length).toBe(2));
  });

  it("copy in both languages", () => {
    expect(da.bankReconLinkedTo).toMatch(/Koblet til \{label\}/);
    expect(da.bankReconUnlink).toBe("Fortryd kobling");
    expect(en.bankReconLinkedTo).toMatch(/Linked to \{label\}/);
    expect(en.bankReconUnlinkedToast).toMatch(/count again/);
  });
});
