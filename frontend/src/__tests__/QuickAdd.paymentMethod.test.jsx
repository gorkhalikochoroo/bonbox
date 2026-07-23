/**
 * QuickAdd — the expense tab must ask how it was paid.
 *
 * The bug: the sale tab had a payment-method picker, the expense tab had
 * none. The POST to /api/expenses therefore omitted payment_method and the
 * server's `= "card"` default filled one in — so a cash purchase quick-added
 * from the FAB booked as card. sync_cash_out_for_expense only fires on
 * "cash", so the money left the drawer in real life and never in the books,
 * and kassebeholdning drifted up by the amount of every one.
 *
 * These pin the request body, which is where the bug actually lived:
 *   • no method is pre-selected (a value nobody chose is the whole problem)
 *   • the submit stays disabled until the owner taps one
 *   • the chosen method is what gets sent
 *   • the personal tabs, which hardcoded "cash" with no UI, send a method
 *     only when one was picked — never a fabricated one
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import { LanguageProvider } from "../hooks/useLanguage";

const CATEGORIES = [{ id: "cat-1", name: "Vareforbrug", color: "#333" }];

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock("../services/api", () => ({
  default: {
    get: (...a) => apiGet(...a),
    post: (...a) => apiPost(...a),
  },
}));

let mockUser = { id: "u-1", business_type: "cafe" };
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));

vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => false, isReady: true }),
}));

vi.mock("../hooks/useEventLog", () => ({ trackEvent: vi.fn() }));

// Imported after the mocks so the component picks them up.
const { default: QuickAdd } = await import("../components/QuickAdd");

async function openSheet() {
  render(
    <MemoryRouter>
      <LanguageProvider>
        <QuickAdd />
      </LanguageProvider>
    </MemoryRouter>,
  );
  fireEvent.click(document.querySelector("[data-quickadd-toggle]"));
  // Categories arrive async; every tab needs them.
  await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/expenses/categories"));
}

/** The chip group that holds a payment method, found by one of its members. */
function methodGroup(label) {
  return screen.getByRole("button", { name: label }).parentElement;
}

/**
 * "Add Expense" names both the tab and the submit (addExpenseTab /
 * addExpense). DOM order settles it: the tab strip renders above the form.
 */
function expenseTab() {
  return screen.getAllByRole("button", { name: "Add Expense" })[0];
}
function expenseSubmit() {
  const all = screen.getAllByRole("button", { name: "Add Expense" });
  return all[all.length - 1];
}

function expenseBody() {
  const call = apiPost.mock.calls.find(([url]) => url === "/expenses");
  return call?.[1];
}

beforeEach(() => {
  localStorage.clear();
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockResolvedValue({ data: CATEGORIES });
  apiPost.mockResolvedValue({ data: {} });
  mockUser = { id: "u-1", business_type: "cafe" };
});

describe("QuickAdd expense tab — payment method", () => {
  async function fillExpense() {
    await openSheet();
    fireEvent.click(expenseTab());
    fireEvent.click(await screen.findByRole("button", { name: "Vareforbrug" }));
    fireEvent.change(screen.getByPlaceholderText("Or type amount..."), {
      target: { value: "400" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("What was it for? (e.g. Tomatoes)"),
      { target: { value: "Frugt hos Netto" } },
    );
  }

  it("pre-selects no method — the picker starts as a question", async () => {
    await fillExpense();
    const group = methodGroup("Cash");
    for (const chip of within(group).getAllByRole("button")) {
      expect(chip).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("keeps the submit disabled until a method is chosen", async () => {
    await fillExpense();
    expect(expenseSubmit()).toBeDisabled();

    fireEvent.click(within(methodGroup("Cash")).getByRole("button", { name: "Cash" }));
    expect(expenseSubmit()).not.toBeDisabled();
  });

  it("sends the method the owner tapped", async () => {
    await fillExpense();
    fireEvent.click(within(methodGroup("Cash")).getByRole("button", { name: "Cash" }));
    fireEvent.click(expenseSubmit());

    await waitFor(() => expect(expenseBody()).toBeTruthy());
    expect(expenseBody().payment_method).toBe("cash");
  });

  it("never posts an expense with no method at all", async () => {
    await fillExpense();
    // The submit handler must refuse on its own, not only via `disabled` —
    // the disabled attribute is a UI affordance, the guard is the invariant.
    fireEvent.click(expenseSubmit());
    expect(expenseBody()).toBeUndefined();
  });
});

describe("QuickAdd personal tabs — payment method", () => {
  async function openPersonal() {
    mockUser = { id: "u-2", business_type: "personal" };
    await openSheet();
    fireEvent.click(screen.getByRole("button", { name: "Expense" }));
    fireEvent.click(await screen.findByRole("button", { name: "Vareforbrug" }));
    fireEvent.change(screen.getByPlaceholderText("Amount spent"), {
      target: { value: "120" },
    });
  }

  it("omits payment_method when the owner picked none", async () => {
    await openPersonal();
    fireEvent.click(screen.getByRole("button", { name: "Log Expense" }));

    await waitFor(() => expect(expenseBody()).toBeTruthy());
    expect(expenseBody()).not.toHaveProperty("payment_method");
    expect(expenseBody().is_personal).toBe(true);
  });

  it("sends the method when one is picked", async () => {
    await openPersonal();
    fireEvent.click(within(methodGroup("Cash")).getByRole("button", { name: "Cash" }));
    fireEvent.click(screen.getByRole("button", { name: "Log Expense" }));

    await waitFor(() => expect(expenseBody()).toBeTruthy());
    expect(expenseBody().payment_method).toBe("cash");
  });

  it("maps the bank-transfer chip to the stored value", async () => {
    await openPersonal();
    fireEvent.click(within(methodGroup("Cash")).getByRole("button", { name: "Bank transfer" }));
    fireEvent.click(screen.getByRole("button", { name: "Log Expense" }));

    await waitFor(() => expect(expenseBody()).toBeTruthy());
    expect(expenseBody().payment_method).toBe("bank_transfer");
  });
});
