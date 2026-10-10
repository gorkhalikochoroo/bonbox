/**
 * Push 1 — a date move's save never carries the old day's MOMS-free total.
 *
 * r15ReviewFixes ("25 Sep (5.000 MOMS-free) → 1 Jun") failed about 1 run in
 * 30 under load: the 1 Jun draft went out with moms_total 2.426 and
 * exempt_sales_total 5.000 — 25 Sep's MOMS-free sales subtracted from 1 Jun.
 *
 * Why: the move sends the new day's save at once (a 0 ms timer set by the
 * autosave effect of the render that changed the date). The MOMS-free total
 * was reset to 0 by an effect, so that render still held 25 Sep's 5.000; the
 * reset's own render came in a later task. When the timer fired first — a
 * busy machine, a slow phone — the save was built from the stale render.
 *
 * Here the timer is made to fire before React's next task (as it does under
 * load) by running that one 0 ms autosave callback as a microtask. The
 * scenario is otherwise r15's.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeBodies } from "../test/closeMoveCalls";

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

let reportByDate = {};
const realSetTimeout = globalThis.setTimeout;
// While set: the next 0 ms autosave callback ("run") runs as a microtask —
// before React's next scheduler task, as a timer due on a busy machine does.
let squeeze = false;
let squeezed = 0;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = () => true;
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  reportByDate = {};
  squeeze = false;
  squeezed = 0;
  get.mockImplementation((url, cfg) => {
    const d = cfg?.params?.date;
    if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: reportByDate[d] || { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation(() => Promise.resolve({ data: { id: 1, status: "confirmed" } }));
  vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) => {
    if (squeeze && ms === 0 && typeof fn === "function" && fn.name === "run") {
      squeeze = false;
      squeezed += 1;
      queueMicrotask(() => fn(...args));
      return realSetTimeout(() => {}, 0);
    }
    return realSetTimeout(fn, ms, ...args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const pickDate = (container, iso) =>
  fireEvent.change(container.querySelector("#close-date"), { target: { value: iso } });
const drafts = (iso) => closeBodies(post.mock.calls)
  .filter((b) => b?.status === "draft" && (!iso || b.date === iso));
const callsFor = (url, iso) => get.mock.calls.filter(([u, c]) => u === url && c?.params?.date === iso).length;

describe("a date move's save carries the new day's MOMS-free total, never the old day's", () => {
  it("25 Sep (5.000 MOMS-free) → 1 Jun, the move's save sent before the reset renders: MOMS 3.426, no MOMS-free", async () => {
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

    squeeze = true;
    pickDate(container, "2026-06-01");
    await waitFor(() => expect(drafts("2026-06-01").length).toBeGreaterThanOrEqual(1), { timeout: 3500 });
    // The move's save itself went through the squeeze (else this proves nothing).
    expect(squeezed).toBe(1);
    for (const d of drafts("2026-06-01")) {
      expect(d.moms_total).toBe(3426);
      expect(d.exempt_sales_total).toBeNull();
    }
  }, 12000);

  it("the new day's own MOMS-free answer still counts once it lands", async () => {
    reportByDate["2026-09-25"] = { totals: { total_revenue: 5000, taxable_sales: 0 } };
    reportByDate["2026-06-01"] = { totals: { total_revenue: 1000, taxable_sales: 0 } };
    const { container } = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    pickDate(container, "2026-09-25");
    await waitFor(() => expect(callsFor("/property-report", "2026-09-25")).toBe(1));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "17.130" } });
    await waitFor(() => expect(drafts("2026-09-25")).toHaveLength(1), { timeout: 3500 });

    squeeze = true;
    pickDate(container, "2026-06-01");
    await waitFor(() => expect(drafts("2026-06-01").length).toBeGreaterThanOrEqual(1), { timeout: 3500 });
    expect(squeezed).toBe(1);
    // Never 25 Sep's 5.000; once 1 Jun's 1.000 is known, it is what is saved:
    // 17.130 − 1.000 → 3.226.
    for (const d of drafts("2026-06-01")) expect(d.exempt_sales_total).not.toBe(5000);
    await waitFor(() => expect(drafts("2026-06-01").at(-1)).toMatchObject({ moms_total: 3226, exempt_sales_total: 1000 }), { timeout: 3500 });
  }, 12000);
});
