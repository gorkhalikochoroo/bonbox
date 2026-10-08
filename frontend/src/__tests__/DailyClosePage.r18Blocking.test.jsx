/**
 * Round 18 — the four blocking findings, each on its own (the seeded
 * sequence test in DailyClosePage.r18Sequences.*.test.jsx walks them in
 * every order).
 *
 *  1. A reopened draft keeps saving after a change goes back to the figures
 *     it was opened with (the stored draft held the change in between).
 *  2. Fortryd / Start forfra on the scan card are filed: back on the form —
 *     or leaving from the empty scan card — the owner's figures are saved.
 *  3. A day whose MOMS-free sales cover the close: the review's MOMS 0,00 is
 *     what is sent (the server keeps it only when its own sales agree).
 *  4. Emptying the card's total on a one-till Z-bon: the next till's bon is
 *     still asked about ("another terminal?").
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
const BON_1500 = { revenue: {}, revenue_total: 1500, payments: { card: 1000, cash: 500 }, raw_text: "B", ocr_available: true };
const BON_4000 = { revenue: { food: 2400, drinks: 1600 }, revenue_total: 4000, moms_total: 800, payments: { card: 4000 }, raw_text: "B", ocr_available: true };
const BON_12000 = { revenue: { food: 7200, drinks: 4800 }, revenue_total: 12000, moms_total: 2400, payments: { card: 12000 }, raw_text: "B", ocr_available: true };
const BON_12000_FOOD = { revenue: { food: 12000 }, revenue_total: 12000, moms_total: 2400, payments: { card: 12000 }, raw_text: "B2", ocr_available: true };

let closes = [];
let scans = [];
let exempt = 0;
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
  exempt = 0;
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: { total_revenue: exempt, taxable_sales: 0 } } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || BON_3000 });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const draftPosts = () => post.mock.calls.filter(([url, b]) => url === "/daily-close" && b?.status === "draft").map(([, b]) => b);
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
/** Leaving the page sends a save that is waiting (pagehide), and only then. */
const leave = () => act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
const reopen = async (row) => {
  closes = [{ id: "d1", date: today, status: "draft", closed_by: "Test", notes: "Gammel note", ...row }];
  const view = renderPage();
  fireEvent.click(await screen.findByText("dcContinueDraft"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  return view;
};

describe("1. a reopened draft saves a change back to the figures it was opened with", () => {
  const DRAFT = {
    revenue_total: 24412.5, revenue_breakdown: { food: 14000, drinks: 10412.5 },
    payment_breakdown: { card: 21000, cash: 3000, mobilepay: 412.5 }, moms_mode: "auto", moms_total: 4882.5,
  };

  it("Kort emptied (saved without it), then 21.000 typed again: saved again, with the card", async () => {
    const { container } = await reopen(DRAFT);
    await toStep(container, "#dc-pay-card");
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "" } });
    await leave();
    expect(draftPosts()).toHaveLength(1);
    expect(draftPosts()[0].payment_breakdown).toEqual({ cash: 3000, mobilepay: 412.5 });
    keyIn(container.querySelector("#dc-pay-card"), "21.000");
    await leave();
    expect(draftPosts()).toHaveLength(2);
    expect(draftPosts()[1].payment_breakdown).toEqual({ card: 21000, cash: 3000, mobilepay: 412.5 });
  });

  it("a typo saved (21.0000 is no amount: the draft goes without the card), then Backspace back to 21.000: the 21.000 is saved", async () => {
    const { container } = await reopen(DRAFT);
    await toStep(container, "#dc-pay-card");
    keyIn(container.querySelector("#dc-pay-card"), "21.0000");
    await leave();
    expect(draftPosts().at(-1).payment_breakdown.card).toBeUndefined();
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "21.000" } });
    await leave();
    expect(draftPosts().at(-1).payment_breakdown.card).toBe(21000);
  });

  it("a note + \"x\" saved, then Backspace: the note as it was is saved", async () => {
    const { container } = await reopen(DRAFT);
    await toStep(container, "#dc-notes");
    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Gammel notex" } });
    await leave();
    expect(draftPosts().at(-1).notes).toBe("Gammel notex");
    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Gammel note" } });
    await leave();
    expect(draftPosts().at(-1).notes).toBe("Gammel note");
  });

  it("untouched, it is still not re-saved on opening", async () => {
    const { container } = await reopen(DRAFT);
    await toStep(container, "#dc-notes");
    await leave();
    expect(draftPosts()).toHaveLength(0);
  });

  it("a total typed on the card of a reopened draft (no box moves) is saved", async () => {
    const { container } = await reopen({
      revenue_total: 17030, revenue_breakdown: { food: 10000 }, payment_breakdown: { card: 12000, cash: 5030 },
      moms_mode: "auto", moms_total: 3406,
    });
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    keyIn(container.querySelector("#scan-total"), "16.500");
    tap(/^useTheseValuesJumpReview$/);
    await screen.findByText("confirmAndLock");
    await leave();
    expect(draftPosts().at(-1)).toMatchObject({ revenue_total_override: 16500, revenue_total_owner_set: true });
  });
});

describe("2. Fortryd / Start forfra on the scan card are filed", () => {
  const typedClose = async () => {
    const view = renderPage();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
    keyIn(view.container.querySelector("#dc-rev-food"), "14.000");
    await toStep(view.container, "#dc-pay-card");
    keyIn(view.container.querySelector("#dc-pay-card"), "14.000");
    await backToStepOne(view.container);
    return view;
  };

  it("\"same terminal\" 3.500 applied and saved, then Start forfra + Spring over: the owner's 14.000 is saved within the debounce", async () => {
    const { container } = await typedClose();
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(screen.getByText("scanZReportTitle")).toBeInTheDocument());
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalReplace/);
    keyIn(container.querySelector("#scan-total"), "3.500");
    tap(/^continueStepByStep$/);
    await leave();
    expect(draftPosts().at(-1)).toMatchObject({ revenue_total_override: 3500, payment_breakdown: { card: 3000 } });
    const n = draftPosts().length;

    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(screen.getByText("startOver")).toBeInTheDocument());
    tap(/^startOver$/);
    await waitFor(() => expect(screen.getByText("skipEnterManually")).toBeInTheDocument());
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("14.000"));
    // No leave(): the 2 s autosave itself must be armed.
    await waitFor(() => expect(draftPosts().length).toBeGreaterThan(n), { timeout: 3500 });
    const last = draftPosts().at(-1);
    expect(last.revenue_breakdown).toEqual({ food: 14000 });
    expect(last.payment_breakdown).toEqual({ card: 14000 });
    expect(last.revenue_total_override).toBeNull();
  }, 15000);

  it("Start forfra, then leaving from the empty scan card: the owner's figures are saved, not the thrown-away sum", async () => {
    const { container } = await typedClose();
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(screen.getByText("scanZReportTitle")).toBeInTheDocument());
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await leave();
    expect(draftPosts().at(-1).revenue_total_override).toBe(17000);
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(screen.getByText("scanMergedUndo")).toBeInTheDocument());
    tap(/^startOver$/);
    await waitFor(() => expect(screen.getByText("skipEnterManually")).toBeInTheDocument());
    await leave();
    const last = draftPosts().at(-1);
    expect(last.revenue_breakdown).toEqual({ food: 14000 });
    expect(last.revenue_total_override).toBeNull();
  });

  it("a figure typed just before \"← Scan Z-bon\" is saved at the tap, not dropped with the timer", async () => {
    const { container } = await typedClose();
    const n = draftPosts().length;
    keyIn(container.querySelector("#dc-rev-drinks"), "2.000");
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(draftPosts().length).toBe(n + 1);
    expect(draftPosts().at(-1).revenue_breakdown).toEqual({ food: 14000, drinks: 2000 });
  });
});

describe("3. MOMS-free sales that cover the close", () => {
  it("2.000 MOMS-free, Mad 750: the review's MOMS 0,00 is the MOMS sent — 0, auto, with the MOMS-free figure", async () => {
    exempt = 2000;
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    keyIn(container.querySelector("#dc-rev-food"), "750");
    await toStep(container, "#dc-notes");
    expect(container.querySelector('[data-testid="dc-review-moms"]').textContent).toContain("0,00");
    await leave();
    expect(draftPosts().at(-1)).toMatchObject({ moms_total: 0, moms_mode: "auto", exempt_sales_total: 2000 });
    tap(/confirmAndLock/);
    await waitFor(() => expect(post.mock.calls.some(([u, b]) => u === "/daily-close" && b?.status === "confirmed")).toBe(true));
    const lock = post.mock.calls.find(([u, b]) => u === "/daily-close" && b?.status === "confirmed")[1];
    expect(lock).toMatchObject({ moms_total: 0, moms_mode: "auto", exempt_sales_total: 2000 });
  });

  it("no MOMS-free sales: an auto MOMS goes as before (the computed figure)", async () => {
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    keyIn(container.querySelector("#dc-rev-food"), "750");
    await leave();
    expect(draftPosts().at(-1)).toMatchObject({ moms_total: 150, moms_mode: "auto" });
  });
});

describe("4. a one-till Z-bon with its total emptied: the next bon is still asked about", () => {
  it("a 1.500 total-only bon, total emptied, then a 4.000 bon: \"another terminal?\" — and the sum keeps both", async () => {
    scans = [BON_1500, BON_4000];
    const { container } = renderPage();
    shoot(container, "bon1.jpg");
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "" } });
    shoot(container, "bon2.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    expect(question()).toBeNull();
    expect(container.querySelector("#scan-total").value).toBe("");
    keyIn(container.querySelector("#scan-total"), "5.500");
    tap(/^continueStepByStep$/);
    await leave();
    expect(draftPosts().at(-1)).toMatchObject({ revenue_total_override: 5500, payment_breakdown: { card: 5000, cash: 500 } });
    expect(draftPosts().at(-1).source_meta).toMatchObject({ kind: "zbon", scans: 2 });
  });

  it("12.000 (Mad 7.200 + Drikke 4.800), total emptied, then another 12.000: asked — never 12.000 shown over 16.800 stored", async () => {
    scans = [BON_12000, BON_12000_FOOD];
    const { container } = renderPage();
    shoot(container, "bon1.jpg");
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "" } });
    shoot(container, "bon2.jpg");
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:12.000 kr.|12.000 kr.");
  });
});
