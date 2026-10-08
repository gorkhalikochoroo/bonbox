/**
 * Round 17 — the copy on the two-till steps says what the figures are
 * (verified in close_r16.json):
 *  1. "Er det en terminal mere?" shows øre exactly like the form: 14.000,50
 *     and 18.000,50 — never a rounded "14.001" / "18.001".
 *  2. The review's save line never calls typed figures "fra bon": a typed
 *     till plus a bon reads "indtastet … + Z-bon …".
 *  3. The scan card of a typed till plus a bon does not say "Vi fandt 2 af 3
 *     kategorier fra denne bon" nor mark a category "mangler"; it lists every
 *     category the owner's till brought (Catering) and the bon's unsplit part.
 *  4. "Stod kun på den ene bon: MOMS" is not shown while the MOMS shown is
 *     worked out for the whole day — that is said instead, on card and review.
 * Strings are asserted by key (t echoes key + values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const BON_4000 = { revenue: {}, revenue_total: 4000, moms_total: 800, payments: { card: 4000 }, raw_text: "BON", ocr_available: true };
const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };

let closes = [];
let scans = [];
const realConfirm = window.confirm;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  scans = [];
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || BON_4000 });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});
afterEach(() => { window.confirm = realConfirm; });

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const question = () => screen.queryByTestId("dc-terminal-question");
const cardInput = (container) => [...container.querySelectorAll('input[type="file"]')].at(-1);
const shoot = (container) =>
  fireEvent.change(cardInput(container), { target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] } });
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
};
const toReview = async () => {
  for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
  await screen.findByText("confirmAndLock");
};
const toScanCard = async () => {
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(screen.getByText("scanZReportTitle")).toBeInTheDocument());
};
const typedClose = async (food) => {
  const view = renderPage();
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  fireEvent.change(view.container.querySelector("#dc-rev-food"), { target: { value: food } });
  return view;
};
const sum = async () => {
  await waitFor(() => expect(question()).not.toBeNull());
  fireEvent.click(screen.getByText(/scanSecondTotalSum/));
  await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
};

describe("the till question shows øre like the form (C4/C12)", () => {
  it("14.000,50 on screen + a 4.000 bon: 14.000,50 / 18.000,50 — never 14.001 / 18.001", async () => {
    const { container } = await typedClose("14.000,50");
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:4.000,00 kr.|14.000,50 kr.");
    expect(screen.getByText(/scanSecondTotalSum/).textContent).toContain("18.000,50 kr.");
    expect(screen.getByText(/scanSecondTotalReplace/).textContent).toContain("4.000,00 kr.");
    expect(question().textContent).not.toMatch(/14\.001|18\.001/);
  });
});

describe("the review never calls typed figures \"fra bon\" (C5)", () => {
  it("typed 14.000,50 + a 4.000 bon: \"indtastet 14.000,50 + Z-bon 4.000,00\"", async () => {
    const { container } = await typedClose("14.000,50");
    await toScanCard();
    shoot(container);
    await sum();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    expect(container.textContent).toContain("dcSavesTypedPlusBon:14.000,50 kr.|4.000,00 kr.|14.000,50 kr.");
    expect(container.textContent).not.toContain("fromReceiptBreakdownSums");
  });

  it("a reopened draft with no new photo is no bon either", async () => {
    closes = [{
      id: "d1", date: today, status: "draft", revenue_total: 17030,
      revenue_breakdown: { food: 10000 }, payment_breakdown: { card: 17030 },
      moms_mode: "auto", moms_total: 3406, closed_by: "Test", notes: "Test",
    }];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("10.000"));
    await toReview();
    expect(container.textContent).toContain("dcSavesSplitSums:10.000,00 kr.");
    expect(container.textContent).not.toContain("fromReceiptBreakdownSums");
  });
});

describe("the scan card of the owner's till + a bon (C4, desktop)", () => {
  it("no \"found on this bon\", no \"mangler\"; Catering and the bon's unsplit part are on the card", async () => {
    closes = [{
      id: "d1", date: today, status: "draft", revenue_total: 17412.5,
      revenue_breakdown: { food: 12345.5, drinks: 4567, catering: 500 }, payment_breakdown: { card: 17412.5 },
      moms_mode: "auto", moms_total: 3482.5, closed_by: "Test", notes: "Test",
    }];
    scans = [{ revenue: {}, revenue_total: 4000, moms_total: 800, payments: { card: 4000 }, raw_text: "BON", ocr_available: true }];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("12.345,50"));
    await toScanCard();
    shoot(container);
    await sum();
    expect(container.textContent).not.toMatch(/scanGapDetectedSome|scanGapNoBreakdown|scanGapTotalIs/);
    expect(screen.queryByText("scanBadgeMissing")).toBeNull();
    // Catering is on the card, and the lines add up to the saved 21.412,50.
    expect([...container.querySelectorAll("input")].some((i) => i.value === "500")).toBe(true);
    expect(container.querySelector("#scan-total").value).toBe("21.412,50");
    const unsplit = screen.getByText("dcUnsplitRevenue").parentElement;
    expect(unsplit.textContent).toContain("4.000,00");
  });
});

describe("MOMS on one till only (C4)", () => {
  it("is not named as \"stood on one bon\" while the MOMS shown is worked out — that is said instead", async () => {
    const { container } = await typedClose("14.000");
    await toScanCard();
    shoot(container);
    await sum();
    // Worked out for the whole 18.000: 3.600 — and said so on the card.
    expect(container.textContent).toContain("3.600 kr.");
    expect(screen.getByTestId("dc-moms-one-till")).toBeInTheDocument();
    const oneSided = screen.queryByText(/^scanMergedIncompleteNamed:/);
    expect(oneSided?.textContent || "").not.toMatch(/MOMS/);
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    expect(screen.getByTestId("dc-review-moms-one-till")).toBeInTheDocument();
    for (const el of screen.queryAllByText(/^scanMergedIncompleteNamed:/)) expect(el.textContent).not.toMatch(/MOMS/);
  });
});
