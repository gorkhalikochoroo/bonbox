/**
 * Round 15 review fixes.
 *
 * 1. The bon's MOMS left after the "Fra kvittering" box was emptied was sent as
 *    "auto": the kasserapport called it "beregnet af BonBox", and the server's
 *    stale-auto rule swapped a fitting 2.906 for 3.406. It goes as the bon's —
 *    "manual" with source_meta "zbon" — so what is shown is what is stored.
 * 2. A draft autosaved right after a date change carried the old day's
 *    MOMS-free total in its MOMS (2.426 saved, 3.426 on the review).
 * 3. Moving the date onto a day with POS sales wrote the sync's figures over a
 *    Z-bon's lines; the kasserapport then called every line a correction.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const TILL1 = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 }, raw_text: "TILL 1", ocr_available: true,
};
// An unread MOMS-free line: the categories are 14.530, the bon's total 17.030,
// and its MOMS 2.906 — 25 % of the taxable 14.530, not of 17.030.
const MOMSFREE_BON = {
  revenue: { food: 14530 }, revenue_total: 17030, moms_total: 2906,
  payments: { card: 17030 }, raw_text: "MOMSFRI", ocr_available: true,
};
const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };
const SALES_DAY = {
  has_data: true,
  day_cutoff_hour: 6,
  sales: { total: 1850, count: 7, by_payment_method: { card: 1250, cash: 600 }, by_item: { Burger: 1850 } },
  expenses: { total: 0, count: 0, by_category: {} },
  gavekort: { redeemed: 0, tender: 0 },
  suggested_prefill: { revenue_total: 1850, payment_breakdown: { card: 1250, cash: 600 }, cash_expected: 600 },
  category_split: { source: "history", confidence: "high", sample_size: 12, categories: { food: 1100, drinks: 750 } },
};

let scans = [];
let prefillByDate = {};
let reportByDate = {};
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  scans = [];
  prefillByDate = {};
  reportByDate = {};
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url, cfg) => {
    const d = cfg?.params?.date;
    if (url === "/daily-close/prefill") return Promise.resolve({ data: prefillByDate[d] || EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: reportByDate[d] || { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() });
    return Promise.resolve({ data: { id: 1, status: "confirmed" } });
  });
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const shoot = (container) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
  });
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
const momsLine = (container) => {
  const span = [...container.querySelectorAll("span")].find((s) => /^MOMS 25%/.test(s.textContent));
  return span?.parentElement?.textContent || "";
};
const lockedPayload = async () => {
  fireEvent.click(screen.getByText("confirmAndLock"));
  await waitFor(() =>
    expect(post.mock.calls.some(([url, body]) => url === "/daily-close" && body?.status === "confirmed")).toBe(true),
  );
  return post.mock.calls.find(([url, body]) => url === "/daily-close" && body?.status === "confirmed")[1];
};
const drafts = (iso) => post.mock.calls
  .filter(([u, b]) => u === "/daily-close" && b?.status === "draft" && (!iso || b.date === iso))
  .map(([, b]) => b);
const callsFor = (url, iso) => get.mock.calls.filter(([u, c]) => u === url && c?.params?.date === iso).length;

describe("the bon's MOMS left in an emptied box is sent as the bon's (review fix 1)", () => {
  it("a full read: 3.406 shown, sent manual with source_meta zbon", async () => {
    scans = [TILL1];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    const box = await screen.findByPlaceholderText("momsAmountPlaceholder");
    fireEvent.change(box, { target: { value: "" } });

    expect(momsLine(container)).toContain("3.406,00");
    expect(container.textContent).toContain("momsFromZReport");
    const payload = await lockedPayload();
    expect(payload).toMatchObject({ moms_total: 3406, moms_mode: "manual" });
    expect(payload.source_meta.kind).toBe("zbon");
  });

  it("an unread MOMS-free line: the bon's 2.906 is shown and sent as the bon's, never as auto", async () => {
    scans = [MOMSFREE_BON];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    const box = await screen.findByPlaceholderText("momsAmountPlaceholder");
    expect(box.value).toBe("2.906");
    fireEvent.change(box, { target: { value: "" } });

    expect(momsLine(container)).toContain("2.906,00");
    expect(container.textContent).toContain("momsFromZReport");
    expect(container.textContent).toContain("14.124,00");
    const payload = await lockedPayload();
    // The server keeps a manual figure as is (test_daily_close_r15_review_fixes).
    expect(payload).toMatchObject({ moms_total: 2906, moms_mode: "manual", revenue_total_override: 17030 });
    expect(payload.source_meta.kind).toBe("zbon");
  });

  it("Auto tapped over a fitting bon: same figure, same source", async () => {
    scans = [TILL1];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    const auto = screen.getByText("autoLabel");
    fireEvent.click(auto.closest("button") || auto);
    expect(momsLine(container)).toContain("3.406,00");
    expect(container.textContent).toContain("momsFromZReport");
    const payload = await lockedPayload();
    expect(payload).toMatchObject({ moms_total: 3406, moms_mode: "manual" });
  });

  it("no bon MOMS: a worked-out figure is still sent as auto", async () => {
    const { container } = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "17.130" } });
    await toReview();
    const payload = await lockedPayload();
    expect(payload).toMatchObject({ moms_total: 3426, moms_mode: "auto" });
  });
});

describe("a draft saved after a date change carries the new day's MOMS (review fix 2)", () => {
  it("25 Sep (5.000 MOMS-free) → 1 Jun: the 1 Jun draft's MOMS is the review's 3.426", async () => {
    reportByDate["2026-09-25"] = { totals: { total_revenue: 5000, taxable_sales: 0 } };
    const { container } = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    pickDate(container, "2026-09-25");
    await waitFor(() => expect(callsFor("/property-report", "2026-09-25")).toBe(1));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "17.130" } });
    // 25 Sep's own draft: 17.130 − 5.000 MOMS-free → 2.426.
    await waitFor(() => expect(drafts("2026-09-25")).toHaveLength(1), { timeout: 3500 });
    expect(drafts("2026-09-25")[0]).toMatchObject({ moms_total: 2426, exempt_sales_total: 5000 });

    pickDate(container, "2026-06-01");
    await waitFor(() => expect(drafts("2026-06-01").length).toBeGreaterThanOrEqual(1), { timeout: 3500 });
    for (const d of drafts("2026-06-01")) {
      expect(d.moms_total).toBe(3426);
      expect(d.exempt_sales_total).toBeNull();
    }
    await toReview();
    expect(momsLine(container)).toContain("3.426,00");
  }, 12000);
});

describe("a new date's sales sync never writes over a Z-bon's lines (review fix 3)", () => {
  it("Z-bon applied, date moved to a sales day: the bon's lines and payments are what is locked", async () => {
    scans = [TILL1];
    prefillByDate["2026-09-25"] = SALES_DAY;
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("9.000"));

    pickDate(container, "2026-09-25");
    await waitFor(() => expect(callsFor("/daily-close/prefill", "2026-09-25")).toBe(1));
    await waitFor(() => expect(screen.queryByText("loadingRecords")).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector("#dc-rev-food").value).toBe("9.000");
    expect(container.querySelector("#dc-rev-drinks").value).toBe("6.000");
    expect(container.querySelector("#dc-rev-takeaway").value).toBe("2.030");

    await toReview();
    const payload = await lockedPayload();
    expect(payload.date).toBe("2026-09-25");
    expect(payload.revenue_breakdown).toEqual({ food: 9000, drinks: 6000, takeaway: 2030 });
    expect(payload.payment_breakdown).toEqual({ card: 12000, cash: 4030, mobilepay: 1000 });
    expect(payload.source_meta.corrected).toEqual([]);
  });

  it("a figure typed while the sync is on its way stays", async () => {
    let release;
    const { container } = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    get.mockImplementation((url, cfg) => {
      if (url === "/daily-close/prefill" && cfg?.params?.date === "2026-09-25") {
        return new Promise((res) => { release = () => res({ data: SALES_DAY }); });
      }
      if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
      if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
      return Promise.resolve({ data: [] });
    });
    pickDate(container, "2026-09-25");
    await waitFor(() => expect(callsFor("/daily-close/prefill", "2026-09-25")).toBe(1));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "2.000" } });
    release();
    await waitFor(() => expect(screen.getByText(/^syncedFromSale/)).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector("#dc-rev-food").value).toBe("2.000");
    expect(container.querySelector("#dc-rev-drinks").value).toBe("");
  });

  it("an untouched form still takes the sales day's sync", async () => {
    prefillByDate["2026-09-25"] = SALES_DAY;
    const { container } = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    pickDate(container, "2026-09-25");
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("1.100"));
    expect(container.querySelector("#dc-rev-drinks").value).toBe("750");
  });
});
