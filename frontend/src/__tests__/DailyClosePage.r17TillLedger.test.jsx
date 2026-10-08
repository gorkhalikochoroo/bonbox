/**
 * Round 17 — the page reads one till ledger (utils/closeTills).
 *
 * The blocking r16 finding, end to end: a close typed by hand (14.000) plus a
 * 3.000 bon, summed and applied, then "Start forfra" and the same bon again.
 * The boxes still held the sum, the next photo took them as the owner's own
 * till, and the same 3.000 was counted twice: 20.000 / MOMS 4.000 / Kort
 * 16.000 locked behind "Omsætning og betalinger stemmer". Now Start forfra
 * leaves exactly the owner's till — in the ledger and in the boxes — so the
 * retake is asked about against 14.000 and sums to 17.000.
 *
 * Plus: the reopened-draft variant (payments were not reverted), the same
 * photo picked twice, and a card correction on a summed day reaching the
 * revisor's record. Strings are asserted by key (t echoes key + values).
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
const BON_3000 = {
  revenue: { food: 2000, drinks: 1000 }, revenue_total: 3000, moms_total: 600,
  payments: { card: 3000 }, raw_text: "BON 3000", ocr_available: true,
};
const BON_4000 = { revenue: {}, revenue_total: 4000, moms_total: 800, payments: { card: 4000 }, raw_text: "BON 4000", ocr_available: true };
const TILL1 = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 }, raw_text: "TILL 1", ocr_available: true,
};
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
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || BON_3000 });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});
afterEach(() => { window.confirm = realConfirm; });

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close").map(([, body]) => body);
const question = () => screen.queryByTestId("dc-terminal-question");
const cardInput = (container) => [...container.querySelectorAll('input[type="file"]')].at(-1);
const photo = (name = "kasse.jpg") => new File(["x"], name, { type: "image/jpeg" });
const shoot = (container, file = photo()) => fireEvent.change(cardInput(container), { target: { files: [file] } });
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
};
const tapBack = () => {
  const btn = screen.getAllByRole("button").find((b) => /^←\s*back$/.test(b.textContent.trim()));
  if (btn) fireEvent.click(btn);
  return Boolean(btn);
};
const toStep = async (container, selector) => {
  for (let i = 0; i < 8 && !container.querySelector(selector); i++) tapNext();
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
};
const backToStepOne = async () => {
  for (let i = 0; i < 8 && tapBack(); i++) { /* back to Trin 1 */ }
  await waitFor(() => expect(screen.getByText("← scanZReportBack")).toBeInTheDocument());
};
const toScanCard = async () => {
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(screen.getByText("scanZReportTitle")).toBeInTheDocument());
};
// Back to the card that holds the photos (not the empty scan card).
const backToCard = async () => {
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(screen.getByText("startOver")).toBeInTheDocument());
};
const sum = async () => {
  await waitFor(() => expect(question()).not.toBeNull());
  fireEvent.click(screen.getByText(/scanSecondTotalSum/));
  await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
};
const lockedPayload = async () => {
  for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
  fireEvent.click(await screen.findByText("confirmAndLock"));
  await waitFor(() => expect(closePosts().some((b) => b?.status === "confirmed")).toBe(true));
  return closePosts().find((b) => b?.status === "confirmed");
};
const box = (container, id) => container.querySelector(id).value;

/** Mad 9.000 + Drikkevarer 5.000, Kontant 4.000 + Kort 10.000 — typed by hand. */
const typedClose14000 = async () => {
  const view = renderPage();
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  fireEvent.change(view.container.querySelector("#dc-rev-food"), { target: { value: "9.000" } });
  fireEvent.change(view.container.querySelector("#dc-rev-drinks"), { target: { value: "5.000" } });
  await toStep(view.container, "#dc-pay-card");
  fireEvent.change(view.container.querySelector("#dc-pay-cash"), { target: { value: "4.000" } });
  fireEvent.change(view.container.querySelector("#dc-pay-card"), { target: { value: "10.000" } });
  await backToStepOne();
  return view;
};

describe("Start forfra after an applied sum, then the same bon again (r16 blocking)", () => {
  it("typed close: 17.000 — never 20.000 — with Kort 13.000 and MOMS 3.400", async () => {
    const { container } = await typedClose14000();
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:3.000 kr.|14.000 kr.");
    await sum();
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(box(container, "#dc-rev-food")).toBe("11.000"));
    // The sum is saved as a draft (the owner walks away and comes back).
    await waitFor(() => expect(closePosts().some((b) => b.revenue_total_override === 17000)).toBe(true), { timeout: 3500 });

    // ← Scan Z-bon → Start forfra: the bon goes, the typed till is back —
    // in the boxes too, and the dialog says so.
    await backToCard();
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(window.confirm.mock.calls[0][0]).toBe("dcScanStartOverKeepsOwn:14.000 kr.");
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(box(container, "#dc-rev-food")).toBe("9.000"));
    expect(box(container, "#dc-rev-drinks")).toBe("5.000");

    // The same bon again: asked about against the owner's 14.000.
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:3.000 kr.|14.000 kr.");
    expect(screen.getByText(/scanSecondTotalSum/).textContent).toContain("17.000 kr.");
    await sum();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(17000);
    expect(payload.revenue_breakdown).toEqual({ food: 11000, drinks: 6000 });
    expect(payload.payment_breakdown).toEqual({ cash: 4000, card: 13000 });
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(3400);
    expect(payload.source_meta).toMatchObject({ kind: "zbon", terminal_totals: [14000, 3000], typed_tills: [0], scans: 1 });
  }, 20000);

  it("reopened draft + a total-only bon: Start forfra puts the draft's payments back, the retake sums once", async () => {
    closes = [{
      id: "d1", date: today, status: "draft", revenue_total: 14000,
      revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 12000, cash: 2000 },
      moms_mode: "auto", moms_total: 2800, closed_by: "Test", notes: "Test",
    }];
    scans = [BON_4000, BON_4000];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(box(container, "#dc-rev-food")).toBe("9.000"));
    await toScanCard();
    shoot(container);
    await sum();
    fireEvent.click(screen.getByText("continueStepByStep"));
    await toStep(container, "#dc-pay-card");
    expect(box(container, "#dc-pay-card")).toBe("16.000");
    await backToStepOne();

    await backToCard();
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    fireEvent.click(screen.getByText("skipEnterManually"));
    await toStep(container, "#dc-pay-card");
    // The draft's own Kort, not the summed 16.000.
    expect(box(container, "#dc-pay-card")).toBe("12.000");
    await backToStepOne();

    await toScanCard();
    shoot(container, photo("kasse-igen.jpg"));
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:4.000 kr.|14.000 kr.");
    await sum();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(18000);
    expect(payload.payment_breakdown).toEqual({ card: 16000, cash: 2000 });
  }, 20000);
});

describe("the same photo picked twice", () => {
  it("is not a second till: nothing is asked, nothing added, and the owner is told", async () => {
    scans = [BON_3000, BON_3000];
    const { container } = renderPage();
    const same = photo("IMG_0042.jpg");
    shoot(container, same);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shoot(container, same);
    await waitFor(() => expect(screen.getByText("dcScanSamePhoto")).toBeInTheDocument());
    expect(question()).toBeNull();
    expect(screen.queryByText(/scanMergedTerminals/)).toBeNull();
    expect(container.querySelector("#scan-total").value).toBe("3.000");
  });
});

describe("a correction on a summed card", () => {
  it("reaches the revisor's record as corrected, and the sum follows it", async () => {
    scans = [TILL1, BON_4000];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shoot(container, photo("kasse2.jpg"));
    await sum();
    const food = [...container.querySelectorAll("input")].find((i) => i.value === "9.000");
    fireEvent.change(food, { target: { value: "8.500" } });
    // Lowered below its bon's split: the bons' 21.030 is still the day.
    expect(container.querySelector("#scan-total").value).toBe("21.030");
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_breakdown).toMatchObject({ food: 8500 });
    expect(payload.revenue_total_override).toBe(21030);
    expect(payload.source_meta.corrected).toContain("rev:food");
    expect(payload.source_meta.terminal_totals).toEqual([17030, 4000]);
  }, 15000);
});
