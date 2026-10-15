/**
 * ReceiptCapture (expense mode): a scanned receipt that matches a typed
 * expense without a bilag is offered as "Knyt til eksisterende udgift" — the
 * stored photo goes onto that expense (link-bilag), and no second expense is
 * posted. Strings are asserted by key (t echoes the key).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", business_type: "cafe" } }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join("|")}` : k;
    },
    lang: "da",
  }),
}));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const ReceiptCapture = (await import("../components/ReceiptCapture")).default;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  get.mockImplementation((url) => {
    if (url === "/expenses/bilag-matches") {
      return Promise.resolve({ data: { candidates: [{
        id: "typed1", date: "2026-10-03", amount: 129.95, description: "Netto",
        category_name: "Råvarer", day_diff: 1, amount_diff: 0, same_vendor: true,
      }], count: 1 } });
    }
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (url === "/expenses/upload-receipt") {
      return Promise.resolve({ data: {
        filepath: "uploads/receipts/u1_1_abc.jpg", suggested_amount: 129.95,
        suggested_vendor: "Netto", suggested_date: "2026-10-04", suggested_currency: "DKK",
        vat_amount: 25.99, vat_rate: 0.25, all_amounts_found: [], ocr_available: true,
        amount_check: { confident: true },
      } });
    }
    return Promise.resolve({ data: { id: "typed1" } });
  });
});

describe("ReceiptCapture — Knyt til eksisterende udgift", () => {
  it("links the stored photo to the typed expense instead of saving a new one", async () => {
    const onSaved = vi.fn();
    render(
      <MemoryRouter><ReceiptCapture mode="expense" onClose={() => {}} onSaved={onSaved} /></MemoryRouter>,
    );
    // The modal renders in a portal on document.body.
    const input = await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      if (!el) throw new Error("no file input yet");
      return el;
    });
    fireEvent.change(input, { target: { files: [new File(["jpeg"], "netto.jpg", { type: "image/jpeg" })] } });
    const panel = await screen.findByTestId("bilag-match-panel", {}, { timeout: 3000 });
    const call = get.mock.calls.find(([u]) => u === "/expenses/bilag-matches");
    expect(call[1].params).toMatchObject({ amount: 129.95, date: "2026-10-04" });
    fireEvent.click(within(panel).getByText("bilagMatchLinkOne"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/expenses/typed1/link-bilag", {
      receipt_photo: "uploads/receipts/u1_1_abc.jpg", vendor: "Netto", vat_amount: 25.99, vat_rate: 0.25,
    }));
    expect(post.mock.calls.some(([u]) => u === "/expenses")).toBe(false);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
