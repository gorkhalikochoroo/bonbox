/**
 * ReceiptCapture's `trigger` (rev-2, 16 Oct). Expense mode opens on mount —
 * right for the Expenses page, which mounts it on demand. On Home it is part
 * of the header, and under a kept copy (K) it mounted already in expense
 * mode, so the camera sheet opened by itself on every return to Home.
 * `trigger` = a button, closed until tapped. Strings asserted by key (t echoes).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", business_type: "cafe" } }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da" }),
}));

const ReceiptCapture = (await import("../components/ReceiptCapture")).default;
const sheet = () => document.querySelector('[role="dialog"]');
const fileInput = () => document.querySelector('input[type="file"]');

describe("ReceiptCapture — expense mode with and without a trigger", () => {
  it("with `trigger`: closed on mount, a button opens it", () => {
    render(<MemoryRouter><ReceiptCapture mode="expense" trigger onSaved={() => {}} /></MemoryRouter>);
    expect(sheet()).toBeNull();
    expect(fileInput()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /scanExpenseReceipt/ }));
    expect(sheet()).not.toBeNull();
    expect(fileInput()).not.toBeNull();
  });

  it("without it (the Expenses page): opens on mount, as before, with no extra button", () => {
    render(<MemoryRouter><ReceiptCapture mode="expense" onClose={() => {}} onSaved={() => {}} /></MemoryRouter>);
    expect(sheet()).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^scanExpenseReceipt$/ })).toBeNull();
  });

  it("sale mode: its own button, closed on mount (unchanged)", () => {
    render(<MemoryRouter><ReceiptCapture onSaleCreated={() => {}} /></MemoryRouter>);
    expect(sheet()).toBeNull();
    expect(screen.getByRole("button", { name: /snapReceipt/ })).toBeTruthy();
  });
});
