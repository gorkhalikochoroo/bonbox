/**
 * Round 18 — the removal audit's U2 restore.
 *
 * Round 17 made the review's total the tills' figure alone. Boxes the sales
 * sync filled while a card is in the day (a total-only Z-bon applied, then
 * the date moved onto a synced day: the empty boxes take the day's sales)
 * are not the tills' lines — and the server saves the larger of the boxes
 * and the tills. The review showed the bon's 4.000 (and its MOMS 800) while
 * 5.000 was saved. Now the review, the MOMS and the payload read that same
 * larger figure.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

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

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const d = new Date(`${today}T12:00:00`);
d.setDate(d.getDate() - 1);
const yesterday = d.toISOString().slice(0, 10);
const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };
const SYNCED = {
  has_data: true,
  day_cutoff_hour: 6,
  sales: { total: 5000, count: 7, by_payment_method: { card: 5000 }, by_item: {} },
  expenses: { total: 0, count: 0, by_category: {} },
  gavekort: { redeemed: 0, tender: 0 },
  suggested_prefill: { revenue_total: 5000, payment_breakdown: { card: 5000 }, cash_expected: 0 },
  category_split: { source: "history", confidence: "high", sample_size: 12, categories: { food: 3000, drinks: 2000 } },
};
// A Z-bon read as a total and a MOMS only — no lines, no payments.
const TOTAL_ONLY = { revenue: {}, revenue_total: 4000, moms_total: 800, payments: {}, raw_text: "TOTAL", ocr_available: true };

beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url, cfg) => {
    if (url === "/daily-close") return Promise.resolve({ data: [] });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: cfg?.params?.date === yesterday ? SYNCED : EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: TOTAL_ONLY });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});

const tap = (re) => {
  const b = [...document.querySelectorAll("button")].find((x) => re.test(x.textContent.trim()));
  if (!b) throw new Error(`no button ${re}`);
  fireEvent.click(b);
};

describe("U2 — boxes the sales sync filled under a card count, as the server counts them", () => {
  it("a total-only 4.000 bon, then the date moved onto a 5.000 synced day: the review, its MOMS and the payload say 5.000", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    fireEvent.change([...container.querySelectorAll('input[type="file"]')].at(-1), { target: { files: [new File(["x"], "z.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(container.querySelector("#close-date")).not.toBeNull());
    fireEvent.change(container.querySelector("#close-date"), { target: { value: yesterday } });
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("3.000"));
    for (let i = 0; i < 6 && !screen.queryByText("confirmAndLock"); i++) tap(/^next\s*→$/);
    await screen.findByText("confirmAndLock");
    expect(screen.getByTestId("dc-review-total").textContent).toContain("5.000,00");
    expect(screen.getByTestId("dc-review-moms").textContent).toContain("1.000,00");
    tap(/confirmAndLock/);
    await waitFor(() => expect(post.mock.calls.some(([u, b]) => u === "/daily-close" && b?.status === "confirmed")).toBe(true));
    const lock = post.mock.calls.find(([u, b]) => u === "/daily-close" && b?.status === "confirmed")[1];
    // The server saves max(breakdown 5.000, override 4.000) = 5.000 with the MOMS sent.
    expect(lock.revenue_breakdown).toEqual({ food: 3000, drinks: 2000 });
    expect(lock.revenue_total_override).toBe(4000);
    expect(lock.revenue_total_owner_set).toBe(false);
    expect(lock).toMatchObject({ moms_total: 1000, moms_mode: "auto" });
  });
});
