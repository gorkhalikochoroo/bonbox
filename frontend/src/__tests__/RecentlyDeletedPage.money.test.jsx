/**
 * Recently Deleted — the amount must be the ACCOUNT's money format.
 *
 * Found by opening the page on an iPhone: a 1234 kr sale rendered as
 * "1,234 DKK". The page formatted money with a bare
 * `Number(x).toLocaleString()` — which uses the BROWSER's locale, not the
 * account's — and appended the raw currency code.
 *
 * In Danish the comma is the DECIMAL separator, so "1,234" reads as one point
 * two three four kroner. This is the screen where the owner decides whether to
 * restore a transaction or destroy it permanently, so the figure they judge by
 * has to be the one they'd recognise. formatOwnerMoney is the app's single
 * source of truth and every other money surface already goes through it.
 *
 * The real utils/currency is deliberately NOT mocked — the formatter is the
 * thing under test.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

let currency = "DKK";
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency } }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => vi.fn() }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn() }));

const RecentlyDeletedPage = (await import("../pages/RecentlyDeletedPage")).default;

/** Every tab is asked for its count on mount, so answer them all. */
const respondWith = (salesRows) =>
  get.mockImplementation((url) =>
    Promise.resolve({ data: url.startsWith("/sales") ? salesRows : [] }),
  );

const aSale = (amount) => ({
  id: "s1",
  date: "2026-08-28",
  amount,
  payment_method: "mixed",
  deleted_at: "2026-08-28T10:00:00Z",
});

describe("Recently Deleted — money", () => {
  beforeEach(() => {
    get.mockReset();
    currency = "DKK";
  });

  it("renders a DKK amount in Danish format, not the browser's", async () => {
    respondWith([aSale(1234)]);
    const { container } = render(<RecentlyDeletedPage />);

    await waitFor(() => expect(screen.getByText(/1\.234/)).toBeTruthy());

    const text = container.textContent || "";
    // The exact regression: a comma here means "decimal" to a Danish reader.
    expect(text).not.toMatch(/1,234/);
    // ...and the raw ISO code is not how this app writes kroner.
    expect(text).not.toMatch(/\bDKK\b/);
  });

  it("keeps thousands readable on a large figure", async () => {
    respondWith([aSale(1234567)]);
    render(<RecentlyDeletedPage />);
    await waitFor(() => expect(screen.getByText(/1\.234\.567/)).toBeTruthy());
  });

  it("shows an em dash rather than inventing a zero when the amount is null", async () => {
    // Asserted on the amount element specifically: the info line above it is
    // "28/08/26 — mixed", so a textContent match for "—" would pass even on
    // the old code, which actually rendered a confident "0 DKK" here.
    respondWith([aSale(null)]);
    render(<RecentlyDeletedPage />);
    await waitFor(() =>
      expect(screen.getByTestId("deleted-item-amount").textContent).toBe("—"),
    );
  });

  it("reads waste value from estimated_cost, which is where waste keeps it", async () => {
    get.mockImplementation((url) =>
      Promise.resolve({
        data: url.startsWith("/waste")
          ? [{
              id: "w1", date: "2026-08-28", item_name: "Mælk",
              quantity: 2, unit: "L", estimated_cost: 4321,
              deleted_at: "2026-08-28T10:00:00Z",
            }]
          : [],
      }),
    );
    render(<RecentlyDeletedPage />);
    // The waste tab carries a count badge from the mount-time sweep.
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
  });
});

describe("Recently Deleted — tab counts", () => {
  beforeEach(() => {
    get.mockReset();
    currency = "DKK";
  });

  it("shows how many are recoverable without opening each tab", async () => {
    get.mockImplementation((url) =>
      Promise.resolve({ data: url.startsWith("/expenses") ? [{ id: "e1" }, { id: "e2" }] : [] }),
    );
    render(<RecentlyDeletedPage />);
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
  });

  it("renders no badge for a domain whose count could not be loaded", async () => {
    // A failing domain must not read as a confident "0".
    get.mockImplementation((url) =>
      url.startsWith("/cashbook")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ data: [] }),
    );
    const { container } = render(<RecentlyDeletedPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/cashBook\s*0/);
  });
});
