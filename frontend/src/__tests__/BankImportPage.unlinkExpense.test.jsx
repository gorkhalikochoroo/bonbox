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

// A link the server refuses (Push 8 guards: one payment, one link) comes back
// with a code beside its English message; the page words it in the owner's
// language. Any other message is shown as the server sent it, as before.
describe("bank reconcile — a refused link reads in the owner's language", () => {
  const OPEN = {
    import_id: "danske_bank",
    counts: { high: 1, medium: 0, low: 0, none: 0 },
    transactions: [
      { txn_id: "bank-2", txn_type: "expense", date: "2026-10-09", amount: 1250,
        description: "HORKRAM A/S", already_matched: false,
        suggestions: [{ txn_id: "bank-2", target_type: "expense", target_id: "exp-9",
                        target_label: "Hørkram (bon)", confidence: "high",
                        amount_diff: 0, date_diff_days: 1, reason: "same amount" }] },
    ],
  };

  it("a coded guard is translated; an uncoded message stays as sent", async () => {
    get.mockImplementation((url) => Promise.resolve({
      data: String(url).includes("/suggestions") ? OPEN : [],
    }));
    post.mockImplementation((url) => {
      if (String(url).startsWith("/bank-import/preview")) return Promise.resolve({ data: PREVIEW });
      if (String(url).startsWith("/bank-import/confirm")) return Promise.resolve({ data: { imported: 1, skipped: 0, errors: [] } });
      return Promise.resolve({ data: {
        confirmed: 0, skipped: 0,
        errors: ["expense target exp-9 is already linked to another bank line", "faktura 7: boom"],
        error_codes: ["expense_paid_by_another_bank_line", ""],
      } });
    });
    await openReconcile();
    fireEvent.click(await screen.findByRole("button", { name: /^bankReconConfirmN/ }));
    expect(await screen.findByText("bankReconErrExpensePaidByAnotherBankLine")).toBeTruthy();
    expect(screen.getByText("faktura 7: boom")).toBeTruthy();
    expect(screen.queryByText(/already linked to another bank line/)).toBeNull();
  });

  it("an older server without codes still shows its messages", async () => {
    get.mockImplementation((url) => Promise.resolve({
      data: String(url).includes("/suggestions") ? OPEN : [],
    }));
    post.mockImplementation((url) => {
      if (String(url).startsWith("/bank-import/preview")) return Promise.resolve({ data: PREVIEW });
      if (String(url).startsWith("/bank-import/confirm")) return Promise.resolve({ data: { imported: 1, skipped: 0, errors: [] } });
      return Promise.resolve({ data: { confirmed: 0, skipped: 0, errors: ["expense exp-1 not found"] } });
    });
    await openReconcile();
    fireEvent.click(await screen.findByRole("button", { name: /^bankReconConfirmN/ }));
    expect(await screen.findByText("expense exp-1 not found")).toBeTruthy();
  });

  it("every guard has real Danish and English", () => {
    for (const k of ["bankReconErrNotABankLine", "bankReconErrTargetIsABankLine",
      "bankReconErrBankLineLinkedElsewhere", "bankReconErrExpensePaidByAnotherBankLine"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
      expect(da[k]).not.toBe(en[k]);
    }
    expect(da.bankReconErrExpensePaidByAnotherBankLine).toMatch(/allerede koblet til en anden banklinje/);
    expect(en.bankReconErrBankLineLinkedElsewhere).toMatch(/undo that link first/);
  });
});

// Push 8 gate round 3 (minor): two bank lines suggested the same expense and
// the owner confirmed both. The server linked one and refused the other, but
// the toast counted the matches the page had sent ("1 bekræftet (0 fakturaer
// markeret betalt, 2 udgifter linket)") and the panel said "1 problemer:".
describe("bank reconcile — the result says what the server did", () => {
  const SAME_TARGET = {
    import_id: "danske_bank",
    counts: { high: 2, medium: 0, low: 0, none: 0 },
    transactions: ["bank-3", "bank-4"].map((id, i) => ({
      txn_id: id, txn_type: "expense", date: `2026-10-1${i + 1}`, amount: 312.5,
      description: i ? "Bager H kort" : "BAGER HANSEN", already_matched: false,
      suggestions: [{ txn_id: id, target_type: "expense", target_id: "exp-7",
                      target_label: "Bager Hansen", confidence: "high",
                      amount_diff: 0, date_diff_days: i, reason: "same amount" }],
    })),
  };
  const answer = (data) => (url) => {
    if (String(url).startsWith("/bank-import/preview")) return Promise.resolve({ data: PREVIEW });
    if (String(url).startsWith("/bank-import/confirm")) return Promise.resolve({ data: { imported: 1, skipped: 0, errors: [] } });
    return Promise.resolve({ data });
  };
  const refusedOne = {
    confirmed: 1, skipped: 0,
    errors: ["expense target exp-7 is already linked to another bank line"],
    error_codes: ["expense_paid_by_another_bank_line"],
  };

  beforeEach(() => {
    get.mockImplementation((url) => Promise.resolve({
      data: String(url).includes("/suggestions") ? SAME_TARGET : [],
    }));
  });

  it("one of two links refused: the toast counts the one linked; one problem is singular", async () => {
    post.mockImplementation(answer({ ...refusedOne, invoices_marked_paid: 0, expenses_linked: 1 }));
    await openReconcile();
    fireEvent.click(await screen.findByRole("button", { name: /^bankReconConfirmN/ }));
    expect(await screen.findByText("bankReconConfirmedToast:1|0|1")).toBeTruthy();
    expect(screen.queryByText("bankReconConfirmedToast:1|0|2")).toBeNull();
    expect(screen.getByText("bankReconIssuesOne:1")).toBeTruthy();
    expect(screen.queryByText(/^bankReconIssues:/)).toBeNull();
    expect(screen.getByText("bankReconErrExpensePaidByAnotherBankLine")).toBeTruthy();
  });

  it("two problems keep the plural", async () => {
    post.mockImplementation(answer({
      confirmed: 0, skipped: 0, invoices_marked_paid: 0, expenses_linked: 0,
      errors: ["a", "b"], error_codes: ["", ""],
    }));
    await openReconcile();
    fireEvent.click(await screen.findByRole("button", { name: /^bankReconConfirmN/ }));
    expect(await screen.findByText("bankReconIssues:2")).toBeTruthy();
    expect(screen.getByText("bankReconConfirmedToast:0|0|0")).toBeTruthy();
  });

  it("an older server without the counts claims no more than it confirmed", async () => {
    post.mockImplementation(answer(refusedOne));
    await openReconcile();
    fireEvent.click(await screen.findByRole("button", { name: /^bankReconConfirmN/ }));
    expect(await screen.findByText(/^bankReconConfirmedToast:1\|/)).toBeTruthy();
    expect(screen.queryByText("bankReconConfirmedToast:1|0|2")).toBeNull();
  });

  it("copy: one problem, and counts that read for any number, in both languages", () => {
    expect(da.bankReconIssuesOne).toBe("{n} problem:");
    expect(en.bankReconIssuesOne).toBe("{n} issue:");
    // "1 udgifter linket" was wrong Danish for any count of 1.
    for (const s of [da.bankReconConfirmedToast, en.bankReconConfirmedToast]) {
      expect(s).toMatch(/\{n\}/);
      expect(s).not.toMatch(/\{inv\} \w|\{exp\} \w/);
    }
    expect(da.bankReconConfirmedToast).toMatch(/udgifter linket: \{exp\}/);
    expect(en.bankReconConfirmedToast).toMatch(/expenses linked: \{exp\}/);
  });
});
