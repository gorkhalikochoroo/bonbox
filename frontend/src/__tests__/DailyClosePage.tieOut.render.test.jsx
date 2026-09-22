/**
 * The tie-out, WALKED — the review card as the owner actually reaches it.
 *
 * THE DEFECT: `revenueTotal - paymentTotal` was rendered on the payments step
 * and nowhere else. The path the product promotes after a Z-report scan —
 * "Brug disse værdier — spring til gennemgang" — calls `applyScanValues(true)`,
 * which does `setStep(totalSteps)` and drops the owner on the review card
 * without passing the payments step at all. So the one line that says "your
 * day does not add up" was skipped by the exact flow BonBox pushes people
 * into, and the review card showed revenue and payments as two unrelated
 * totals in two unrelated cards. A kasserapport could be locked, signed,
 * PDF'd and auto-emailed to the revisor with nobody ever told it did not
 * reconcile.
 *
 * The sibling source guard (dailyCloseTieOut.test.js) pins WHERE the block
 * sits relative to Bekræft & lås. This one pins that it is actually reachable
 * and says the right thing: it walks the five-step wizard with real money in
 * the boxes and reads the review card.
 *
 * Strings are asserted by KEY (the t() mock echoes the key and its vars), so
 * this pins behaviour and the money, never the wording.
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
  useBranch: () => ({ branchId: null, branchType: "restaurant", branches: [] }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const renderPage = () =>
  render(
    <MemoryRouter>
      <DailyClosePage />
    </MemoryRouter>,
  );

const routeGet = () => {
  get.mockImplementation((url) => {
    if (url === "/daily-close/prefill") return Promise.resolve({ data: { has_data: false } });
    if (url === "/daily-close") return Promise.resolve({ data: [] });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    if (url === "/daily-close/insights") return Promise.resolve({ data: { has_data: false } });
    if (url === "/daily-close/branch-summary") return Promise.resolve({ data: { branches: [], grand_total: {} } });
    return Promise.resolve({ data: {} });
  });
};

const enterManually = async () => {
  fireEvent.click(screen.getByText("skipEnterManually"));
  await waitFor(() => expect(screen.getByText(/^stepNRevenue:/)).toBeInTheDocument());
};

const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};

const moneyBoxes = (c) => Array.from(c.querySelectorAll('input[inputmode="decimal"]'));

/** Fill the first money box of the current step, then advance. */
const fillAndNext = async (container, value) => {
  const boxes = moneyBoxes(container);
  if (value != null) fireEvent.change(boxes[0], { target: { value } });
  tapNext();
};

/** Walk revenue → payments → … → review, with the given amounts. */
const walkToReview = async (container, { revenue, payment }) => {
  await enterManually();
  await fillAndNext(container, revenue);
  await waitFor(() => expect(screen.getByText(/^stepNPayments:/)).toBeInTheDocument());
  await fillAndNext(container, payment);
  // Cash + tips still sit between payments and review for a restaurant.
  for (let i = 0; i < 4; i += 1) {
    if (screen.queryByText(/^stepNReview:/)) break;
    if (!tapNext()) break;
  }
  await waitFor(() => expect(screen.getByText(/^stepNReview:/)).toBeInTheDocument());
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  routeGet();
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the review card states the tie-out", () => {
  it("names the difference when the day does not add up", async () => {
    const { container } = renderPage();
    // 17.030 booked, 15.830 taken — 1.200 kr unaccounted for, the kind of gap
    // that is a missed payment line or a real shortage and must not be locked
    // in silence.
    await walkToReview(container, { revenue: "17030", payment: "15830" });

    const verdict = await screen.findByText(/^dcTieOutOff:/);
    // Signed and grouped da-DK, at the review card's two-decimal ledger
    // precision — "1.200" on an English-locale browser would be one kroner
    // and twenty øre to the Dane reading it.
    expect(verdict.textContent).toContain("1.200,00");
    expect(verdict.textContent).toMatch(/[+]/);
    // And it says the lock is still available, because an owner may be
    // genuinely short and still has to file the day.
    expect(screen.getByText("dcTieOutOffHint")).toBeInTheDocument();
  });

  it("does not disable Bekræft & lås over a discrepancy", async () => {
    const { container } = renderPage();
    await walkToReview(container, { revenue: "17030", payment: "15830" });

    await screen.findByText(/^dcTieOutOff:/);
    const lock = screen.getAllByRole("button").find((b) => /confirmAndLock/.test(b.textContent));
    expect(lock).toBeTruthy();
    expect(lock.disabled).toBe(false);
  });

  it("says so plainly when the day does add up", async () => {
    const { container } = renderPage();
    await walkToReview(container, { revenue: "17030", payment: "17030" });

    expect(await screen.findByText("dcTieOutBalanced")).toBeInTheDocument();
    expect(screen.queryByText(/^dcTieOutOff:/)).toBeNull();
  });

  it("refuses to invent a difference when payments were never entered", async () => {
    const { container } = renderPage();
    // This is the promoted scan path's shape: revenue arrives from the
    // Z-report, the payments step is skipped. revenue − payments is then the
    // WHOLE revenue, and the old chip would have called that a discrepancy of
    // 17.030 kr — a confident figure derived from a column nobody filled in.
    await walkToReview(container, { revenue: "17030", payment: null });

    expect(await screen.findByText("dcTieOutUnknown")).toBeInTheDocument();
    expect(screen.queryByText(/^dcTieOutOff:/)).toBeNull();
    expect(screen.queryByText("dcTieOutBalanced")).toBeNull();
  });
});
