/**
 * Round 15, must-fix 1: changing the date kept the PREVIOUS day's prefill.
 *
 * Picking 26 Sep (one expense of 4.250) and then 1 Aug (nothing) left the
 * sync card on "1 udgift · Udgifter 4.250 kr." and put a pink "Dagens
 * udgifter −4.250,00" on the 1 Aug review. The same missing reset kept the old
 * day's register cash, POS figures and the card/category figures the sync had
 * typed into the boxes — and an older answer could land after a newer one.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };
const EXPENSE_DAY = {
  has_data: true,
  day_cutoff_hour: 6,
  sales: { total: 0, count: 0, by_payment_method: {}, by_item: {} },
  expenses: { total: 4250, count: 1, by_category: { "Råvarer · demo": 4250 } },
  gavekort: { redeemed: 0, tender: 0 },
  suggested_prefill: { revenue_total: 0, payment_breakdown: {}, cash_expected: 0 },
};
const SALES_DAY = {
  has_data: true,
  day_cutoff_hour: 6,
  sales: { total: 1850, count: 7, by_payment_method: { card: 1250, cash: 600 }, by_item: { Burger: 1850 } },
  expenses: { total: 0, count: 0, by_category: {} },
  gavekort: { redeemed: 0, tender: 0 },
  suggested_prefill: { revenue_total: 1850, payment_breakdown: { card: 1250, cash: 600 }, cash_expected: 600 },
  category_split: { source: "history", confidence: "high", sample_size: 12, categories: { food: 1100, drinks: 750 } },
};

/** prefill answers by date; a value may be a function returning a promise. */
let prefillByDate = {};
beforeEach(() => {
  window.scrollTo = () => {};
  // Round 23: a date move with figures is asked first — answered "Flyt tallene".
  window.confirm = () => true;
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  prefillByDate = {};
  get.mockImplementation((url, cfg) => {
    if (url === "/daily-close/prefill") {
      const d = cfg?.params?.date;
      const v = prefillByDate[d];
      if (typeof v === "function") return v();
      return Promise.resolve({ data: v || EMPTY_DAY });
    }
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: { id: 1, status: "confirmed" } });
});
afterEach(() => {
  vi.useRealTimers();
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const enterManually = async () => {
  fireEvent.click(screen.getByText("skipEnterManually"));
  await waitFor(() => expect(screen.getByText(/^stepNRevenue:/)).toBeInTheDocument());
};
const pickDate = (container, iso) =>
  fireEvent.change(container.querySelector("#close-date"), { target: { value: iso } });
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};
const toReview = async () => {
  for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
  await screen.findByText("confirmAndLock");
};
const prefillCallsFor = (iso) =>
  get.mock.calls.filter(([u, c]) => u === "/daily-close/prefill" && c?.params?.date === iso).length;

describe("daily close — a new date never shows the old day's prefill", () => {
  it("26 Sep (an expense of 4.250) → 1 Jun (nothing): no sync card, no Dagens udgifter", async () => {
    prefillByDate["2026-09-26"] = EXPENSE_DAY;
    const { container } = renderPage();
    await enterManually();
    pickDate(container, "2026-09-26");
    await waitFor(() => expect(screen.getByText(/^syncedFromSaleMany/)).toBeInTheDocument());
    expect(container.textContent).toContain("4.250");

    pickDate(container, "2026-06-01");
    // Gone at once — not only once the new day has answered.
    expect(screen.queryByText(/^syncedFromSaleMany/)).not.toBeInTheDocument();
    await waitFor(() => expect(prefillCallsFor("2026-06-01")).toBe(1));
    await waitFor(() => expect(screen.queryByText("loadingRecords")).not.toBeInTheDocument());
    expect(screen.queryByText(/^syncedFromSale/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("4.250");

    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "8.750" } });
    await toReview();
    expect(screen.queryByText("todaysExpenses")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("4.250");
    expect(container.textContent).not.toContain("dcSalesMinusExpenses");
  });

  it("a sales day's synced card / cash / split leave with the day; what the owner typed stays", async () => {
    prefillByDate["2026-09-25"] = SALES_DAY;
    const { container } = renderPage();
    await enterManually();
    pickDate(container, "2026-09-25");
    await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("1.100"));
    expect(container.querySelector("#dc-rev-drinks").value).toBe("750");
    expect(screen.getByText("dcResetToComputed")).toBeInTheDocument();
    // The owner corrects Drikkevarer and types a MobilePay of their own.
    fireEvent.change(container.querySelector("#dc-rev-drinks"), { target: { value: "800" } });
    tapNext();
    await waitFor(() => expect(container.querySelector("#dc-pay-card")?.value).toBe("1.250"));
    fireEvent.change(container.querySelector("#dc-pay-mobilepay"), { target: { value: "300" } });

    pickDate(container, "2026-06-01");
    // (Round 23: the move is asked first — the date changes once answered.)
    await waitFor(() => expect(container.querySelector("#close-date").value).toBe("2026-06-01"));
    await waitFor(() => expect(prefillCallsFor("2026-06-01")).toBe(1));
    await waitFor(() => expect(screen.queryByText("loadingRecords")).not.toBeInTheDocument());
    // The sync's untouched figures are gone…
    expect(container.querySelector("#dc-pay-card").value).toBe("");
    expect(container.querySelector("#dc-pay-cash").value).toBe("");
    // …the owner's own stay.
    expect(container.querySelector("#dc-pay-mobilepay").value).toBe("300");
    // No sync card from 25 Sep.
    expect(screen.queryByText(/^syncedFromSale/)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("1.850");

    await toReview();
    // The register's 600 is not 1 Jun's baseline.
    expect(screen.queryByText("expectedFromRegister")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("confirmAndLock"));
    await waitFor(() =>
      expect(post.mock.calls.some(([u, b]) => u === "/daily-close" && b?.status === "confirmed")).toBe(true),
    );
    const payload = post.mock.calls.find(([u, b]) => u === "/daily-close" && b?.status === "confirmed")[1];
    expect(payload.date).toBe("2026-06-01");
    expect(payload.revenue_breakdown).toEqual({ drinks: 800 });
    expect(payload.payment_breakdown).toEqual({ mobilepay: 300 });
  });

  it("an older answer landing after a newer one is dropped", async () => {
    // 25 Sep is slow; the owner has moved to 1 Jun before it answers.
    let releaseOld;
    prefillByDate["2026-09-25"] = () => new Promise((res) => { releaseOld = () => res({ data: SALES_DAY }); });
    const { container } = renderPage();
    await enterManually();
    pickDate(container, "2026-09-25");
    await waitFor(() => expect(prefillCallsFor("2026-09-25")).toBe(1));
    pickDate(container, "2026-06-01");
    await waitFor(() => expect(prefillCallsFor("2026-06-01")).toBe(1));
    await waitFor(() => expect(screen.queryByText("loadingRecords")).not.toBeInTheDocument());

    releaseOld();
    // Give the late answer every chance to write.
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector("#close-date").value).toBe("2026-06-01");
    expect(screen.queryByText(/^syncedFromSale/)).not.toBeInTheDocument();
    expect(container.querySelector("#dc-rev-food").value).toBe("");
    expect(screen.queryByText("dcResetToComputed")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("1.850");
    expect(screen.queryByText("loadingRecords")).not.toBeInTheDocument();
    tapNext();
    await waitFor(() => expect(container.querySelector("#dc-pay-card")).not.toBeNull());
    expect(container.querySelector("#dc-pay-card").value).toBe("");
  });

  it("a failed answer for the day the owner left does not flag the day they are on", async () => {
    let failOld;
    prefillByDate["2026-09-25"] = () => new Promise((_, rej) => { failOld = () => rej(new Error("offline")); });
    const { container } = renderPage();
    await enterManually();
    pickDate(container, "2026-09-25");
    await waitFor(() => expect(prefillCallsFor("2026-09-25")).toBe(1));
    pickDate(container, "2026-06-01");
    await waitFor(() => expect(prefillCallsFor("2026-06-01")).toBe(1));
    failOld();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("dcPrefillFailedTitle")).not.toBeInTheDocument();
  });
});
