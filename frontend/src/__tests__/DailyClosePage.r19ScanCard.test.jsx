/**
 * Round 19 — the scan card's last two confusing items.
 *
 *  1. The payments shortfall line (dcScanPayShort) sits BELOW the payment
 *     boxes: the keystroke that unbalances (or balances) the column moves
 *     nothing above the box being typed in.
 *  2. Two Z-bons summed, the day's total corrected by hand: the record names
 *     each bon's read total beside the till list (read_totals), so the
 *     revisor's line can say "Z-bon 1: 17.030 · Z-bon 2: 4.000 · rettet af
 *     ejeren til 21.500" — never "4.470" for a bon that read 4.000.
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const TILL1 = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 }, raw_text: "TILL 1", ocr_available: true,
};
const BON_5000 = { revenue: { food: 3500, drinks: 1500 }, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 }, raw_text: "T2", ocr_available: true };
const TOTAL_ONLY_17030 = { revenue: {}, revenue_total: 17030, payments: {}, raw_text: "T1", ocr_available: true };
const BON_4000 = { revenue: { food: 3000 }, revenue_total: 4000, payments: { card: 4000 }, raw_text: "T2", ocr_available: true };

let scans = [];
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  scans = [];
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: [] });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close").map(([, b]) => b);
const question = () => screen.queryByTestId("dc-terminal-question");
const cardInput = (container) => [...container.querySelectorAll('input[type="file"]')].at(-1);
const shoot = (container, name) => fireEvent.change(cardInput(container), { target: { files: [new File([name], name, { type: "image/jpeg" })] } });
const keyIn = (el, value) => {
  fireEvent.change(el, { target: { value: "" } });
  for (let i = 1; i <= value.length; i++) fireEvent.change(el, { target: { value: value.slice(0, i) } });
};
const tap = (re) => {
  const b = [...document.querySelectorAll("button")].find((x) => re.test(x.textContent.trim()));
  if (!b) throw new Error(`no button ${re}`);
  fireEvent.click(b);
};
const summedCard = async (container, a, b) => {
  scans = [a, b];
  shoot(container, "a.jpg");
  await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
  shoot(container, "b.jpg");
  await waitFor(() => expect(question()).not.toBeNull());
  tap(/^scanSecondTotalSum/);
  await waitFor(() => expect(question()).toBeNull());
};

describe("1. the payments shortfall line never moves the box being typed in", () => {
  /** The blocks (div/p) above the focused box on the card — their count and order. */
  const above = (container, input) => {
    const card = container.querySelector('[data-testid="dc-scan-result-date"]').parentElement;
    return [...card.querySelectorAll("div,p")]
      // eslint-disable-next-line no-bitwise
      .filter((el) => !el.contains(input) && (el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING))
      .map((el) => `${el.tagName}${el.dataset.testid ? `#${el.dataset.testid}` : ""}`)
      .join(",");
  };

  it("MobilePay retyped over a balanced column: unbalanced on the first key, balanced again on the last — nothing above moves", async () => {
    const { container } = renderPage();
    await summedCard(container, TILL1, BON_5000);
    const mp = container.querySelector("#scan-pay-mobilepay");
    expect(mp.value).toBe("1.000");
    expect(screen.queryByTestId("dc-scan-pay-short")).toBeNull();
    act(() => { mp.focus(); });
    const before = above(container, mp);
    const seen = [];
    const shortSeen = [];
    fireEvent.change(mp, { target: { value: "" } });
    for (const v of ["1", "10", "100", "1000"]) {
      fireEvent.change(mp, { target: { value: v } });
      seen.push(above(container, mp));
      shortSeen.push(Boolean(screen.queryByTestId("dc-scan-pay-short")));
    }
    // The line came (the column stopped adding up) and went (it adds up again)…
    expect(shortSeen).toEqual([true, true, true, false]);
    // …and the blocks above the box were the same on every keystroke.
    seen.forEach((s) => expect(s).toBe(before));
  });

  it("the line is below every payment box, and still follows each key there", async () => {
    const { container } = renderPage();
    await summedCard(container, TILL1, BON_5000);
    const mp = container.querySelector("#scan-pay-mobilepay");
    keyIn(mp, "2");
    const line = screen.getByTestId("dc-scan-pay-short");
    expect(line.textContent).toContain("dcScanPayShort");
    container.querySelectorAll('input[id^="scan-pay-"]').forEach((box) => {
      // eslint-disable-next-line no-bitwise
      expect(box.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(line.textContent).toContain("21.032");
    // Live below the boxes: the next figure is in it at once.
    keyIn(mp, "20");
    expect(screen.getByTestId("dc-scan-pay-short").textContent).toContain("21.050");
  });
});

describe("2. a summed total corrected by hand: each bon's read total and the correction, apart", () => {
  it("17.030 + 4.000, 21.500 typed: the lock files read_totals [17.030, 4.000] beside the list that adds up", async () => {
    const { container } = renderPage();
    await summedCard(container, TOTAL_ONLY_17030, BON_4000);
    keyIn(container.querySelector("#scan-total"), "21500");
    // The screen keeps naming what each bon read.
    expect(container.textContent).toContain("17.030 kr.");
    expect(container.textContent).toContain("4.000 kr.");
    expect(container.textContent).not.toContain("4.470");
    tap(/^useTheseValuesJumpReview$/);
    await screen.findByText("confirmAndLock");
    tap(/confirmAndLock/);
    await waitFor(() => expect(closePosts().some((b) => b?.status === "confirmed")).toBe(true));
    const lock = closePosts().find((b) => b?.status === "confirmed");
    expect(lock.revenue_total_override).toBe(21500);
    expect(lock.source_meta).toMatchObject({ kind: "zbon", scans: 2, read_totals: [17030, 4000] });
    // The list still adds up to what is saved (the server drops one that does not).
    expect(lock.source_meta.terminal_totals.reduce((a, v) => a + v, 0)).toBe(21500);
  });

  it("summed and not corrected: no read_totals — the list is what the bons read", async () => {
    const { container } = renderPage();
    await summedCard(container, TOTAL_ONLY_17030, BON_4000);
    tap(/^useTheseValuesJumpReview$/);
    await screen.findByText("confirmAndLock");
    tap(/confirmAndLock/);
    await waitFor(() => expect(closePosts().some((b) => b?.status === "confirmed")).toBe(true));
    const lock = closePosts().find((b) => b?.status === "confirmed");
    expect(lock.source_meta.terminal_totals).toEqual([17030, 4000]);
    expect(lock.source_meta.read_totals).toBeUndefined();
  });
});
