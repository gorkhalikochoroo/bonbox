/**
 * QuickAdd — one tap must post one sale, however many times it is tapped.
 *
 * The defect: submitSale had NO in-flight lock, and it clears the amount
 * field only AFTER the await. The button was gated on the amount alone
 * (`disabled={!(saleAmountNum > 0)}`), which stays true for the whole of a
 * slow save. So a second tap while the first POST was still open ran the
 * whole handler again and logged the SAME sale twice.
 *
 * A second tap is not a rare accident on this surface — it is the normal
 * human response to a button that looks like it did nothing, and QuickAdd
 * is used standing up, mid-service, on a phone, on café wifi. Sales is the
 * most-used surface in the product.
 *
 * Why it mattered more than a stray duplicate row: a double-logged sale
 * inflates the day's omsætning, which the kasserapport reconciles against
 * the drawer and which the MOMS figure is computed from. The owner finds it
 * at revisor time, if at all, and has no way to tell which of the two rows
 * was real.
 *
 * These pin the three halves of the fix:
 *   • the handler itself refuses a re-entrant call (the invariant)
 *   • the button is disabled while in flight (the affordance)
 *   • a FAILED save releases the lock (a jammed form is its own outage)
 * and the same for the expense tab, which shares the lock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";

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

let mockUser = { id: "u-1", business_type: "cafe", currency: "DKK" };
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));

vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => false, isReady: true }),
}));

vi.mock("../hooks/useEventLog", () => ({ trackEvent: vi.fn() }));

const { default: QuickAdd } = await import("../components/QuickAdd");

/** A promise we hold open, so a save can be observed mid-flight. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openSheet() {
  render(
    <MemoryRouter>
      <LanguageProvider>
        <QuickAdd />
      </LanguageProvider>
    </MemoryRouter>,
  );
  fireEvent.click(document.querySelector("[data-quickadd-toggle]"));
  await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/expenses/categories"));
}

const saleSubmit = () => screen.getByRole("button", { name: /Log Today's Sale|Saving…/ });
const salePosts = () => apiPost.mock.calls.filter(([url]) => url === "/sales");
const expensePosts = () => apiPost.mock.calls.filter(([url]) => url === "/expenses");

/**
 * Two taps with no chance for React to re-render in between — the worst
 * case the lock has to survive. `disabled` cannot help here, because it is
 * only ever true in a frame that has not been painted yet; the guard inside
 * the handler is the thing being tested.
 */
async function doubleTap(el) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function typeSale(amount) {
  await openSheet();
  fireEvent.change(screen.getByPlaceholderText("Or type amount..."), {
    target: { value: amount },
  });
}

beforeEach(() => {
  localStorage.clear();
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockResolvedValue({ data: CATEGORIES });
  apiPost.mockResolvedValue({ data: {} });
  mockUser = { id: "u-1", business_type: "cafe", currency: "DKK" };
});

describe("QuickAdd sale tab — double submit", () => {
  it("posts one sale for two taps on a save that is still in flight", async () => {
    const inFlight = deferred();
    apiPost.mockReturnValue(inFlight.promise);

    await typeSale("347,50");
    await doubleTap(saleSubmit());

    // The second tap must not have reached the API. Before the fix this was
    // 2, and the café's day showed 695,00 kr. for one 347,50 kr. sale.
    expect(salePosts()).toHaveLength(1);
    expect(salePosts()[0][1].amount).toBe(347.5);

    await act(async () => {
      inFlight.resolve({ data: {} });
    });
    expect(salePosts()).toHaveLength(1);
  });

  it("disables the button while the save is in flight", async () => {
    const inFlight = deferred();
    apiPost.mockReturnValue(inFlight.promise);

    await typeSale("500");
    // One ordinary tap, the way a phone delivers it.
    await act(async () => {
      fireEvent.click(saleSubmit());
    });

    // The amount is still in the field (it is cleared only on success), so
    // the old `disabled={!(saleAmountNum > 0)}` left the button live and
    // tappable for the whole round trip.
    expect(saleSubmit()).toBeDisabled();
    expect(saleSubmit()).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      inFlight.resolve({ data: {} });
    });
  });

  it("says it is saving, so there is no silent tap to repeat", async () => {
    const inFlight = deferred();
    apiPost.mockReturnValue(inFlight.promise);

    await typeSale("500");
    expect(screen.getByRole("button", { name: "Log Today's Sale" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(saleSubmit());
    });
    // The lock makes a second tap harmless; this is what stops the owner
    // wanting to make it in the first place.
    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();

    await act(async () => {
      inFlight.resolve({ data: {} });
    });
  });

  it("releases the lock when the save FAILS, so the owner can retry", async () => {
    const failed = deferred();
    apiPost.mockReturnValueOnce(failed.promise);

    await typeSale("500");
    await act(async () => {
      fireEvent.click(saleSubmit());
    });
    await act(async () => {
      failed.reject({ response: { data: { detail: "Network error" } } });
    });

    // A guard that only ever closes is its own outage: the amount is still
    // typed, the sale is still unrecorded, and the only way out would be to
    // reload the app mid-service.
    expect(saleSubmit()).not.toBeDisabled();
    expect(screen.getByText("Network error")).toBeInTheDocument();

    apiPost.mockResolvedValue({ data: {} });
    await act(async () => {
      fireEvent.click(saleSubmit());
    });
    await waitFor(() => expect(salePosts()).toHaveLength(2));
  });

  it("clears the amount after a successful save, so a later tap is a no-op", async () => {
    await typeSale("500");
    await act(async () => {
      fireEvent.click(saleSubmit());
    });
    await waitFor(() => expect(salePosts()).toHaveLength(1));

    expect(screen.getByPlaceholderText("Or type amount...")).toHaveValue("");
    expect(saleSubmit()).toBeDisabled();
  });
});

describe("QuickAdd expense tab — double submit", () => {
  function methodGroup(label) {
    return screen.getByRole("button", { name: label }).parentElement;
  }
  // "Add Expense" names both the tab and the submit (addExpenseTab /
  // addExpense). DOM order settles it: the tab strip renders above the form.
  const expenseTab = () => screen.getAllByRole("button", { name: "Add Expense" })[0];
  const expenseSubmit = () =>
    screen.getAllByRole("button", { name: /^(Add Expense|Saving…)$/ }).at(-1);

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
    fireEvent.click(within(methodGroup("Cash")).getByRole("button", { name: "Cash" }));
  }

  it("posts one expense for two taps on a save that is still in flight", async () => {
    await fillExpense();

    const inFlight = deferred();
    apiPost.mockReturnValue(inFlight.promise);
    const submit = expenseSubmit();
    await doubleTap(submit);

    expect(expensePosts()).toHaveLength(1);
    expect(expensePosts()[0][1].amount).toBe(400);

    await act(async () => {
      inFlight.resolve({ data: {} });
    });
    expect(expensePosts()).toHaveLength(1);
  });

  it("releases the lock when the expense save FAILS", async () => {
    await fillExpense();

    const failed = deferred();
    apiPost.mockReturnValueOnce(failed.promise);
    const submit = expenseSubmit();
    await act(async () => {
      fireEvent.click(submit);
    });
    await act(async () => {
      failed.reject({ response: { data: { detail: "Network error" } } });
    });

    // Everything the owner typed is still there, and the button works again.
    expect(expenseSubmit()).not.toBeDisabled();
    expect(screen.getByPlaceholderText("Or type amount...")).toHaveValue("400");
  });
});
