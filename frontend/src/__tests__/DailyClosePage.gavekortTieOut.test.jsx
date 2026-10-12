/**
 * Gavekort on the daily close (12 Oct 2026 findings, P0-3 and P0-5).
 *
 *  P0-5  A restaurant close had NO gavekort payment line. A meal paid by
 *        gavekort left "Payments are X below revenue", and the obvious fix —
 *        lowering revenue — took the meal out of MOMS. The restaurant list
 *        now has "Gavekort", pre-filled with the day's redeemed gavekort.
 *  P0-3  A gavekort SOLD at the counter is in the terminal / drawer but is
 *        not revenue. The close could not see it, so the tie-out said
 *        "Payments are 300 above revenue" and pushed the owner to raise
 *        revenue (MOMS twice). It now reads payments = revenue + sold.
 *  Also: a close-only day (no Sale rows → has_data false) still gets the
 *        gavekort facts — the note never showed for exactly that owner.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
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
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

// A close-only restaurant day: no Sale rows (has_data false), 500 kr of
// gavekort redeemed, 300 kr of gavekort sold over the counter by card.
const GK_DAY = {
  has_data: false,
  day_cutoff_hour: 6,
  sales: { total: 0, count: 0 },
  expenses: { total: 0, count: 0 },
  gavekort: {
    redeemed: 500, tender: 0, redeemed_spv: 0, redeemed_total: 500,
    sold: 300, sold_by_tender: { card: 300 },
  },
};

beforeEach(() => {
  window.scrollTo = () => {};
  window.confirm = () => true;
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => {
    if (url === "/daily-close/prefill") return Promise.resolve({ data: GK_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: { id: 1, status: "confirmed" } });
});

const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};

const toPayments = async (container) => {
  fireEvent.click(screen.getByText("skipEnterManually"));
  await waitFor(() => expect(screen.getByText(/^stepNRevenue:/)).toBeInTheDocument());
  fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1.000" } });
  tapNext();
  await waitFor(() => expect(container.querySelector("#dc-pay-card")).not.toBeNull());
};

describe("daily close — gavekort is a tender, and sold gavekort is not revenue", () => {
  it("the restaurant list has a Gavekort payment line, pre-filled with today's redeemed gavekort", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await toPayments(container);
    await waitFor(() => expect(container.querySelector("#dc-pay-gift_card")?.value).toBe("500"));
  });

  it("the gavekort note shows on a close-only day (prefill has_data false)", async () => {
    render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("skipEnterManually"));
    expect(await screen.findByText(/^dcGkRedeemedToday:/)).toBeInTheDocument();
  });

  it("ties out as payments = revenue + gavekort sold, and says why", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await toPayments(container);
    await waitFor(() => expect(container.querySelector("#dc-pay-gift_card")?.value).toBe("500"));
    // Terminal 800 (500 kr of meals + 300 kr of gavekort sold) + gavekort 500.
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "800" } });
    expect(screen.getByTestId("dc-gk-sold-line")).toBeInTheDocument();
    expect(screen.getByText("dcGkSoldToday")).toBeInTheDocument();
    expect(screen.getByText("balanced")).toBeInTheDocument();
    expect(screen.queryByText(/^dcPayAboveRevenue/)).toBeNull();
  });

  it("the kasserapport note records the gavekort sold, in Danish, with honest MOMS words", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await toPayments(container);
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "800" } });
    for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
    fireEvent.click(await screen.findByText("confirmAndLock"));
    await waitFor(() =>
      expect(post.mock.calls.some(([u, b]) => u === "/daily-close" && b?.status === "confirmed")).toBe(true),
    );
    const body = post.mock.calls.find(([u, b]) => u === "/daily-close" && b?.status === "confirmed")[1];
    expect(body.payment_breakdown.gift_card).toBe(500);
    expect(body.notes).toMatch(/Gavekort solgt: 300,00 kr\. \(med i betalingerne, ikke i omsætningen/);
  });
});

describe("the copy (real dictionaries)", () => {
  it("is real Danish and English", () => {
    for (const k of ["dcGkSoldToday", "dcGkSoldTodayHint", "dcGkTenderLine", "dcPayGiftCard"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
    expect(da.dcGkSoldToday).toMatch(/ikke omsætning/);
    expect(en.dcGkSoldToday).toMatch(/not revenue/);
  });
});
