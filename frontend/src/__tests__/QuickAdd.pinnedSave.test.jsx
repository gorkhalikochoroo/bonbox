/**
 * The "+" sheet's save button is pinned under the form (13 Nov 2026, founder
 * yes). On a 360×780 phone the job chips + gift-card row pushed "Registrer
 * salg" below the fold. The button now lives in Modal's footer — outside the
 * scrolling body — on every tab, and only the open tab's button is there.
 * Modal without a footer is unchanged (no footer element, safe-area padding
 * stays on the body).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { LanguageProvider } from "../hooks/useLanguage";

const apiGet = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => apiGet(...a),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));
let mockUser = { id: "u-1", business_type: "cafe", currency: "DKK" };
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: mockUser }) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: vi.fn() }));

const { default: QuickAdd } = await import("../components/QuickAdd");
const { default: Modal } = await import("../components/Modal");

beforeEach(() => {
  localStorage.setItem("lang", "en");
  apiGet.mockReset();
  apiGet.mockImplementation((url) =>
    Promise.resolve({ data: url === "/expenses/categories" ? [{ id: "c1", name: "Vareforbrug" }] : [] }),
  );
});

async function openSheet(user = { id: "u-1", business_type: "cafe", currency: "DKK" }) {
  mockUser = user;
  render(
    <MemoryRouter>
      <LanguageProvider>
        <QuickAdd />
      </LanguageProvider>
    </MemoryRouter>,
  );
  fireEvent.click(document.querySelector("[data-quickadd-toggle]"));
  await waitFor(() => expect(document.querySelector("[data-sheet-footer]")).not.toBeNull());
}

const footer = () => document.querySelector("[data-sheet-footer]");
const body = () => document.querySelector("[data-sheet-body]");

describe('"+" sheet — pinned save button', () => {
  it("sale tab: the save button sits in the footer, not in the scrolling body", async () => {
    await openSheet();
    const save = screen.getByRole("button", { name: /Log Today's Sale/ });
    expect(footer().contains(save)).toBe(true);
    expect(body().contains(save)).toBe(false);
    // Only one primary save on screen.
    expect(footer().querySelectorAll("button")).toHaveLength(1);
  });

  it("expense tab: its own save button replaces the sale one in the footer", async () => {
    await openSheet();
    fireEvent.click(screen.getByRole("button", { name: /Add expense/i }));
    await waitFor(() => expect(footer().textContent).not.toMatch(/Log Today's Sale/));
    expect(footer().querySelectorAll("button")).toHaveLength(1);
    expect(body().querySelector("button[aria-busy]")).toBeNull();
  });

  it("personal mode: income save is pinned too", async () => {
    await openSheet({ id: "u-2", business_type: "personal", currency: "DKK" });
    expect(footer().querySelectorAll("button")).toHaveLength(1);
    expect(body().querySelector("button[aria-busy]")).toBeNull();
  });
});

describe("Modal without a footer is unchanged", () => {
  it("renders no footer and keeps the safe-area padding on the body", () => {
    render(
      <LanguageProvider>
        <Modal open onClose={() => {}} title="T">
          <p>x</p>
        </Modal>
      </LanguageProvider>,
    );
    expect(document.querySelector("[data-sheet-footer]")).toBeNull();
    expect(document.querySelector("[data-sheet-body]").style.paddingBottom).toContain("safe-area-inset-bottom");
  });
});
