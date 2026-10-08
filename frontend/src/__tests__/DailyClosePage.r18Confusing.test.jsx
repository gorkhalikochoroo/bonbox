/**
 * Round 18 — the confusing findings, each on its own.
 *
 *  1. No cash difference without an expected figure (the record stores none).
 *  2. A retake of a bon already summed in: "Det er det samme billede — brug
 *     det ikke" throws the photo away, the day stays as it was; Fortryd.
 *  3. The confidence pill is per till: a fully read bon summed with a typed
 *     close is "Høj", never "Lav — 2/10".
 *  4. The card's total retyped unchanged is no correction.
 *  5. A reopened draft's card shows the MOMS the review shows.
 *  6. Nothing above the box being typed in on a summed card moves while
 *     typing.
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };
const BON_3000 = { revenue: { food: 2000, drinks: 1000 }, revenue_total: 3000, moms_total: 600, payments: { card: 3000 }, raw_text: "B", ocr_available: true };
const TILL1 = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 }, raw_text: "TILL 1", ocr_available: true,
};
const BON_15030 = { revenue: { food: 10000, drinks: 5030 }, revenue_total: 15030, moms_total: 3006, payments: { card: 15030 }, raw_text: "T1", ocr_available: true };
const BON_5000 = { revenue: { food: 3500, drinks: 1500 }, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 }, raw_text: "T2", ocr_available: true };

let closes = [];
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
  closes = [];
  scans = [];
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || BON_3000 });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close").map(([, b]) => b);
const question = () => screen.queryByTestId("dc-terminal-question");
const cardInput = (container) => [...container.querySelectorAll('input[type="file"]')].at(-1);
const shoot = (container, name = "kasse.jpg") => fireEvent.change(cardInput(container), { target: { files: [new File([name], name, { type: "image/jpeg" })] } });
const keyIn = (el, value) => {
  fireEvent.change(el, { target: { value: "" } });
  for (let i = 1; i <= value.length; i++) fireEvent.change(el, { target: { value: value.slice(0, i) } });
};
const tap = (re) => {
  const b = [...document.querySelectorAll("button")].find((x) => re.test(x.textContent.trim()));
  if (!b) throw new Error(`no button ${re}`);
  fireEvent.click(b);
};
const toStep = async (container, selector) => {
  for (let i = 0; i < 8 && !container.querySelector(selector); i++) tap(/^next\s*→$/);
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
};
const backToStepOne = async (container) => {
  for (let i = 0; i < 8 && !container.querySelector("#dc-rev-food"); i++) tap(/^←\s*back$/);
  await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
};
const lockedPayload = async (container) => {
  await toStep(container, "#dc-notes");
  tap(/confirmAndLock/);
  await waitFor(() => expect(closePosts().some((b) => b?.status === "confirmed")).toBe(true));
  return closePosts().find((b) => b?.status === "confirmed");
};
const typedClose = async (rev, pay) => {
  const view = renderPage();
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  Object.entries(rev).forEach(([k, v]) => keyIn(view.container.querySelector(`#dc-rev-${k}`), v));
  await toStep(view.container, "#dc-pay-card");
  Object.entries(pay).forEach(([k, v]) => keyIn(view.container.querySelector(`#dc-pay-${k}`), v));
  await backToStepOne(view.container);
  return view;
};
const toScanCard = async () => {
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(screen.getByText(/scanZReportTitle|startOver/)).toBeInTheDocument());
};

describe("1. the cash count with nothing to compare it with", () => {
  it("Kort only, 4.500 counted (1.000 float): no difference on the step or the review, and it says why", async () => {
    const { container } = await typedClose({ food: "12.000" }, { card: "12.000" });
    await toStep(container, "#cash-counted");
    keyIn(container.querySelector("#cash-counted"), "4.500");
    expect(screen.getByTestId("dc-cash-no-baseline")).toBeInTheDocument();
    expect(container.textContent).not.toContain("dcCashOverBy");
    expect(container.textContent).not.toContain("offByMoreThanAmount");
    expect(screen.queryByText("noCashStep2")).toBeNull();
    await toStep(container, "#dc-notes");
    expect(container.textContent).toContain("dcCashNoBaseline");
    expect(container.textContent).not.toContain("dcCashOverBy");
    const lock = await lockedPayload(container);
    expect(lock.cash_counted).toBe(3500);
    expect(lock.payment_breakdown.cash).toBeUndefined();
  });

  it("with a cash line typed, the difference is shown as before", async () => {
    const { container } = await typedClose({ food: "12.000" }, { card: "9.000", cash: "3.000" });
    await toStep(container, "#cash-counted");
    keyIn(container.querySelector("#cash-counted"), "4.500");
    expect(screen.queryByTestId("dc-cash-no-baseline")).toBeNull();
    expect(container.textContent).toContain("dcCashOverBy:500 kr.");
  });
});

describe("2. a retake of a bon already summed in: \"brug det ikke\"", () => {
  it("throws the photo away and keeps 17.000,50; Fortryd brings the question back", async () => {
    const { container } = await typedClose({ food: "14.000,50" }, { card: "14.000,50" });
    scans = [BON_3000, BON_3000];
    await toScanCard();
    shoot(container, "bon.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    await waitFor(() => expect(container.querySelector("#scan-total").value).toBe("17.000,50"));
    shoot(container, "bon-igen.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("dcScanSamePhotoDiscard");
    expect(screen.getByText("receiptPhotosLabel")).toBeInTheDocument();
    tap(/^dcScanSamePhotoDiscard$/);
    expect(question()).toBeNull();
    expect(container.querySelector("#scan-total").value).toBe("17.000,50");
    expect(screen.getByTestId("dc-scan-dropped")).toBeInTheDocument();
    // The thrown-away photo's thumbnail goes with it.
    expect(screen.getByText("receiptPhotoLabel")).toBeInTheDocument();
    tap(/^scanMergedUndo$/);
    await waitFor(() => expect(question()).not.toBeNull());
    expect(screen.getByText("receiptPhotosLabel")).toBeInTheDocument();
    tap(/^dcScanSamePhotoDiscard$/);
    tap(/^continueStepByStep$/);
    const lock = await lockedPayload(container);
    expect(lock.revenue_total_override).toBe(17000.5);
    expect(lock.source_meta).toMatchObject({ kind: "zbon", terminal_totals: [14000.5, 3000] });
  });
});

describe("3. the confidence pill is per till", () => {
  it("a fully read bon summed with a typed close: \"Bon 1: Høj — 5/10\", never \"Lav — 2/10\"", async () => {
    const { container } = await typedClose({ food: "8.000", drinks: "4.000" }, { card: "10.000", cash: "2.000" });
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    const pills = screen.getByTestId("dc-scan-confidence");
    expect(pills.textContent).toContain("dcScanBonN:1");
    expect(pills.textContent).toContain("scanConfidenceLevel:confidenceLevelHigh|5|10");
    expect(pills.textContent).not.toContain("confidenceLevelLow");
  });

  it("two bons: one pill each", async () => {
    scans = [BON_15030, BON_5000];
    const { container } = renderPage();
    shoot(container, "a.jpg");
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    expect(screen.getByTestId("dc-scan-confidence").textContent).not.toContain("dcScanBonN");
    shoot(container, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    const text = screen.getByTestId("dc-scan-confidence").textContent;
    expect(text).toContain("dcScanBonN:1");
    expect(text).toContain("dcScanBonN:2");
  });
});

describe("4. the card's total retyped unchanged is no correction", () => {
  it("17.030 retyped, then Mad 10.000: saves 18.030, owner_set false, only Mad corrected", async () => {
    scans = [TILL1];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    keyIn(container.querySelector("#scan-total"), "17.030");
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    keyIn(container.querySelector("#dc-rev-food"), "10.000");
    const lock = await lockedPayload(container);
    expect(lock.revenue_total_override).toBe(18030);
    expect(lock.revenue_total_owner_set).toBe(false);
    expect(lock.source_meta.corrected).toEqual(["rev:food"]);
  });

  it("17.030 retyped and nothing else: the bon's MOMS stays the bon's", async () => {
    scans = [TILL1];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    keyIn(container.querySelector("#scan-total"), "17.030");
    tap(/^useTheseValuesJumpReview$/);
    const lock = await lockedPayload(container);
    expect(lock).toMatchObject({ moms_total: 3406, moms_mode: "manual", revenue_total_owner_set: false });
    expect(lock.source_meta.corrected).toEqual([]);
  });
});

describe("5. a reopened draft's card shows the review's MOMS", () => {
  it("13.264,50 / MOMS 2.652,90, Takeaway 17.030 typed: the card says 4.452,90, as the review does", async () => {
    closes = [{
      id: "d1", date: today, status: "draft", closed_by: "Test", notes: "Test",
      revenue_total: 13264.5, revenue_breakdown: { food: 4000, drinks: 1234.5 }, payment_breakdown: { card: 13264.5 },
      moms_mode: "manual", moms_total: 2652.9,
    }];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    keyIn(container.querySelector("#dc-rev-takeaway"), "17.030");
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    expect(container.textContent).toContain("4.452,90 kr.");
    expect(container.textContent).not.toContain("2.652,90 kr.");
    tap(/^useTheseValuesJumpReview$/);
    await screen.findByText("confirmAndLock");
    expect(screen.getByTestId("dc-review-moms").textContent).toContain("4.452,90");
  });
});

describe("6. nothing above the box being typed in moves while typing (summed card)", () => {
  /** The blocks (div/p) above the focused box on the card — their count and order. */
  const above = (container, input) => {
    const card = container.querySelector('[data-testid="dc-scan-result-date"]').parentElement;
    return [...card.querySelectorAll("div,p")]
      // eslint-disable-next-line no-bitwise
      .filter((el) => !el.contains(input) && (el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING))
      .map((el) => el.tagName)
      .join(",");
  };
  const typeWatching = (container, input, value) => {
    act(() => { input.focus(); });
    const before = above(container, input);
    const seen = [];
    fireEvent.change(input, { target: { value: "" } });
    seen.push(above(container, input));
    for (let i = 1; i <= value.length; i++) {
      fireEvent.change(input, { target: { value: value.slice(0, i) } });
      seen.push(above(container, input));
    }
    return { before, seen };
  };

  it("Mad emptied and 13600 typed, then the total 20130,50: no block mounts or goes above the box", async () => {
    scans = [BON_15030, BON_5000];
    const { container } = renderPage();
    shoot(container, "a.jpg");
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    shoot(container, "b.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    await waitFor(() => expect(container.querySelector("#scan-total").value).toBe("20.030"));

    const mad = typeWatching(container, container.querySelector("#scan-rev-food"), "13600");
    mad.seen.forEach((s) => expect(s).toBe(mad.before));
    act(() => { container.querySelector("#scan-rev-food").blur(); });

    const total = typeWatching(container, container.querySelector("#scan-total"), "20130,50");
    total.seen.forEach((s) => expect(s).toBe(total.before));
    // Leaving the box shows the final state, once.
    act(() => { container.querySelector("#scan-total").blur(); });
    expect(container.textContent).toContain("dcUnsplitRevenue");
  });
});
