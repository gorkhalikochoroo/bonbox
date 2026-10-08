/**
 * Round 16, must-fix 2 and 3 (the removal audit's items 1(a) and 1(b)).
 *
 * 2. Figures typed for day A stayed when the date moved to day B (B's sync
 *    no longer replaces typed figures), and the autosave filed A's figures as
 *    B's draft within 2 s. Neither is picked silently now: the figures stay,
 *    nothing is saved, and one amber line asks — "Brug dem for {B}" (saved
 *    for B) or "Hent {B}s salg" (B's POS figures replace them), the second
 *    only when B has sync figures. A Z-bon's figures keep their own guard.
 *
 * 3. The computed split's hint ("Beregnet ud fra dine seneste N
 *    kasserapporter") and "Nulstil til beregnet fordeling" vanished on every
 *    day whose sync was kept out of the boxes. They follow the day's answer.
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
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  scans = [];
  prefillByDate = {};
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url, cfg) => {
    const d = cfg?.params?.date;
    if (url === "/daily-close/prefill") return Promise.resolve({ data: prefillByDate[d] || EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() });
    return Promise.resolve({ data: { id: 1, status: "draft" } });
  });
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const pickDate = (container, iso) =>
  fireEvent.change(container.querySelector("#close-date"), { target: { value: iso } });
const drafts = (date) => post.mock.calls
  .filter(([url, body]) => url === "/daily-close" && body?.status === "draft" && body?.date === date)
  .map(([, body]) => body);
const choice = () => screen.queryByTestId("dc-date-move");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const callsFor = (url, date) => get.mock.calls.filter(([u, cfg]) => u === url && cfg?.params?.date === date).length;
const settled = async (date) => {
  await waitFor(() => expect(callsFor("/daily-close/prefill", date)).toBe(1));
  await waitFor(() => expect(screen.queryByText("loadingRecords")).not.toBeInTheDocument());
  await tick(30);
};
const dayName = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long" });

/** 25 Sep, typed by hand: Mad 17.130, Kort 17.130 — saved as 25 Sep's draft. */
const typedOn25Sep = async () => {
  const view = renderPage();
  fireEvent.click(screen.getByText("skipEnterManually"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  pickDate(view.container, "2026-09-25");
  await settled("2026-09-25");
  expect(choice()).toBeNull();
  fireEvent.change(view.container.querySelector("#dc-rev-food"), { target: { value: "17.130" } });
  await waitFor(() => expect(drafts("2026-09-25")).toHaveLength(1), { timeout: 3500 });
  return view;
};

describe("daily close — figures typed for one day, date moved to another (must-fix 2)", () => {
  it("keeps them, saves nothing, and asks — both choices when the new day has sales", async () => {
    prefillByDate["2026-09-26"] = SALES_DAY;
    const { container } = await typedOn25Sep();

    pickDate(container, "2026-09-26");
    await settled("2026-09-26");
    // The typed figure stays (a date correction is legitimate)…
    expect(container.querySelector("#dc-rev-food").value).toBe("17.130");
    // …and one line asks which day it belongs to.
    expect(choice()).not.toBeNull();
    expect(choice().textContent).toContain(
      `dcDateMoveTyped:${dayName("2026-09-25")}|${dayName("2026-09-26")}|${dayName("2026-09-26")}'s`,
    );
    expect(choice().textContent).toContain("dcDateMoveKeep");
    expect(choice().textContent).toContain("dcDateMoveFetch");
    for (const b of choice().querySelectorAll("button")) expect(b.className).toMatch(/min-h-10/);
    // Nothing is filed for 26 Sep while it is open.
    await tick(2300);
    expect(drafts("2026-09-26")).toHaveLength(0);
  }, 12000);

  it("\"Brug dem for 26. september\" saves the typed figures for the new day", async () => {
    prefillByDate["2026-09-26"] = SALES_DAY;
    const { container } = await typedOn25Sep();
    pickDate(container, "2026-09-26");
    await settled("2026-09-26");
    fireEvent.click(screen.getByText(/^dcDateMoveKeep/));
    expect(choice()).toBeNull();
    await waitFor(() => expect(drafts("2026-09-26")).toHaveLength(1), { timeout: 3500 });
    expect(drafts("2026-09-26")[0]).toMatchObject({ date: "2026-09-26", revenue_breakdown: { food: 17130 } });
  }, 12000);

  it("\"Hent 26. septembers salg\" replaces them with the new day's POS figures", async () => {
    prefillByDate["2026-09-26"] = SALES_DAY;
    const { container } = await typedOn25Sep();
    pickDate(container, "2026-09-26");
    await settled("2026-09-26");
    fireEvent.click(screen.getByText(/^dcDateMoveFetch/));
    expect(choice()).toBeNull();
    expect(container.querySelector("#dc-rev-food").value).toBe("1.100");
    expect(container.querySelector("#dc-rev-drinks").value).toBe("750");
    await waitFor(() => expect(drafts("2026-09-26")).toHaveLength(1), { timeout: 3500 });
    expect(drafts("2026-09-26")[0]).toMatchObject({
      revenue_breakdown: { food: 1100, drinks: 750 },
      payment_breakdown: { card: 1250, cash: 600 },
    });
  }, 12000);

  it("no sales on the new day: only \"Brug dem\", and moving back to the typed day closes the question", async () => {
    const { container } = await typedOn25Sep();
    pickDate(container, "2026-06-01");
    await settled("2026-06-01");
    expect(choice().textContent).toContain(`dcDateMoveTypedNoSync:${dayName("2026-09-25")}|${dayName("2026-06-01")}`);
    expect(choice().textContent).not.toContain("dcDateMoveFetch");
    // Moved on again before answering: still 25 Sep's figures.
    pickDate(container, "2026-06-02");
    await settled("2026-06-02");
    expect(choice().textContent).toContain(`dcDateMoveTypedNoSync:${dayName("2026-09-25")}|${dayName("2026-06-02")}`);
    // Back on 25 Sep: they belong here, nothing to ask.
    pickDate(container, "2026-09-25");
    await waitFor(() => expect(choice()).toBeNull());
    expect(drafts("2026-06-01")).toHaveLength(0);
    expect(drafts("2026-06-02")).toHaveLength(0);
  }, 12000);

  it("a Z-bon's figures keep their own guard: no question", async () => {
    scans = [TILL1];
    prefillByDate["2026-09-25"] = SALES_DAY;
    const { container } = renderPage();
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
    });
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("9.000"));
    pickDate(container, "2026-09-25");
    await settled("2026-09-25");
    expect(choice()).toBeNull();
    expect(container.querySelector("#dc-rev-food").value).toBe("9.000");
  });
});

describe("daily close — the computed split shows when the boxes are not filled (must-fix 3)", () => {
  it("typed figures, date moved to a sales day: the hint and \"Nulstil\" are there", async () => {
    prefillByDate["2026-09-26"] = SALES_DAY;
    const { container } = await typedOn25Sep();
    expect(screen.queryByText(/^dcSplitComputed/)).toBeNull();
    pickDate(container, "2026-09-26");
    await settled("2026-09-26");
    expect(container.querySelector("#dc-rev-food").value).toBe("17.130");
    expect(screen.getByText("dcSplitComputed:12")).toBeInTheDocument();
    // The reset puts the computed split in the boxes.
    fireEvent.click(screen.getByText("dcResetToComputed"));
    expect(container.querySelector("#dc-rev-food").value).toBe("1.100");
    expect(container.querySelector("#dc-rev-drinks").value).toBe("750");
  }, 12000);

  it("a figure typed while the day's sync is on its way: the hint and \"Nulstil\" still come", async () => {
    let release;
    get.mockImplementation((url, cfg) => {
      if (url === "/daily-close/prefill" && cfg?.params?.date === "2026-09-26") {
        return new Promise((res) => { release = () => res({ data: SALES_DAY }); });
      }
      if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
      if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
      return Promise.resolve({ data: [] });
    });
    const { container } = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    pickDate(container, "2026-09-26");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "500" } });
    release();
    await waitFor(() => expect(screen.getByText("dcSplitComputed:12")).toBeInTheDocument());
    expect(screen.getByText("dcResetToComputed")).toBeInTheDocument();
    // The typed figure stays.
    expect(container.querySelector("#dc-rev-food").value).toBe("500");
  });
});
