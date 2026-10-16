/**
 * Home's speed push (15 Oct), mounted against a fake API.
 *
 *   A  The next MOMS frist comes with /dashboard/batch: Home never asks
 *      /tax/overview (the whole tax calculation) when the batch carries it,
 *      and still shows the countdown. An older backend without the field →
 *      /tax/overview in the background, never holding the page.
 *   B  First load: the cards' own reads (/cashflow/forecast, /daily-close)
 *      are fired once — not again because the batch landed. A later refresh
 *      (bonbox-data-changed, e.g. after "Luk dagen") still re-fetches them.
 *   G  Home asks the batch without weather (weather=0).
 *   I  The page shows as soon as the batch is in; a slow card does not hold
 *      it back.
 *   K  Back on Home: the last answer is drawn at once (no skeleton) and
 *      refreshed quietly; never across accounts; an old copy says so. A
 *      close-based venue's first tile is "Sidste lukning" from the first
 *      frame (never "I dag indtil nu 0 kr." until /daily-close answers), and
 *      no receipt-scan sheet opens by itself (rev-1/rev-2, 16 Oct).
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestStarted, requestSettled } from "../services/apiActivity";
import {
  __resetSwrCacheForTests,
  accountKeyFor,
  setCacheAccount,
  setSharedDevice,
} from "../lib/swrCache";

const get = vi.fn();
const post = vi.fn(() => Promise.resolve({ data: {} }));

// GETs go through lib/swrCache exactly as services/api.js sends them there
// (rememberGet in the generation the request started in — the real client's
// wiring is pinned in swrCacheApiWiring.test.js), so a card's kept answer is
// what the real app would keep.
vi.mock("../services/api", async () => {
  const sc = await import("../lib/swrCache");
  return {
    default: {
      get: (url, config) => {
        const gen = sc.cacheGeneration();
        return Promise.resolve(get(url, config)).then((res) => {
          sc.rememberGet(url, config?.params, res?.data, gen);
          return res;
        });
      },
      post: (...a) => post(...a),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      patch: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
    },
  };
});

let currentUser = { id: 1, role: "owner", email: "ejer@mirabelle.dk", business_name: "Mirabelle", business_type: "cafe", currency: "DKK" };
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: currentUser, refreshUser: vi.fn() }),
}));

vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ plan: "starter", has: () => true, hasFeature: () => true, ready: true, isReady: true, trialDaysRemaining: null }),
}));

vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn() }));

const DashboardPage = (await import("../pages/DashboardPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

const SUMMARY = {
  today_revenue: 4200, week_revenue: 21000, month_revenue: 123456, month_expenses: 50000,
  month_profit: 73456, profit_margin: 59.5, month_moms: 9000, total_sales: 40, has_activity: true,
  uses_daily_close: true,
};

function batch(extra = {}) {
  return {
    summary: SUMMARY,
    monthly: { revenue_trend: [], daily_revenue: [] },
    week_comparison: { this_week_revenue: 21000, same_days_change_pct: 4 },
    moms_date: "2026-12-01",
    moms_countdown_days: 46,
    moms_period_label: "Q3 2026",
    ...extra,
  };
}

let slow = null; // a card request the test holds open

function mockApi({ batchData = batch(), hold = null, closes = [] } = {}) {
  get.mockImplementation((url) => {
    if (url === "/dashboard/batch") return Promise.resolve({ data: batchData });
    if (url === "/tax/overview") {
      return Promise.resolve({ data: { upcoming_deadlines: [{ deadline: "2026-12-01", days_until: 46 }] } });
    }
    if (url === "/business") return Promise.resolve({ data: { day_cutoff_hour: 6 } });
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (hold && url === hold) return new Promise((resolve) => { slow = resolve; });
    if (url === "/cashflow/forecast") return Promise.resolve({ data: { foresight: null } });
    return Promise.resolve({ data: [] });
  });
}

const calls = (url) => get.mock.calls.filter(([u]) => u === url);

const mount = () =>
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <DashboardPage />
      </MemoryRouter>
    </LanguageProvider>,
  );

// The money on screen: the month tile prints 123.456.
const moneyShown = () => screen.queryAllByText((_, el) => /123\.456/.test(el?.textContent || "") && el.children.length === 0).length > 0;

beforeEach(() => {
  get.mockReset();
  post.mockClear();
  slow = null;
  localStorage.clear();
  localStorage.setItem("lang", "da");
  __resetSwrCacheForTests();
  currentUser = { id: 1, role: "owner", email: "ejer@mirabelle.dk", business_name: "Mirabelle", business_type: "cafe", currency: "DKK" };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("A — the MOMS frist rides in the batch", () => {
  it("never asks /tax/overview when the batch carries the date, and still counts down", async () => {
    mockApi();
    mount();
    await waitFor(() => expect(calls("/dashboard/batch")).toHaveLength(1));
    await waitFor(() => expect(moneyShown()).toBe(true));
    await new Promise((r) => setTimeout(r, 400));
    expect(calls("/tax/overview")).toHaveLength(0);
  });

  it("an older backend (no moms_date) → /tax/overview in the background", async () => {
    const b = batch();
    delete b.moms_date;
    delete b.moms_countdown_days;
    mockApi({ batchData: b });
    mount();
    await waitFor(() => expect(calls("/tax/overview")).toHaveLength(1));
  });

  it("G — Home asks the batch without weather", async () => {
    mockApi();
    mount();
    await waitFor(() => expect(calls("/dashboard/batch")).toHaveLength(1));
    expect(calls("/dashboard/batch")[0][1].params.weather).toBe(0);
  });
});

describe("B — no double fetch on first load; refresh after a change kept", () => {
  it("first load asks /cashflow/forecast and /daily-close once each", async () => {
    mockApi();
    mount();
    await waitFor(() => expect(moneyShown()).toBe(true));
    await new Promise((r) => setTimeout(r, 500));
    expect(calls("/cashflow/forecast")).toHaveLength(1);
    expect(calls("/daily-close")).toHaveLength(1);
  });

  it("bonbox-data-changed (e.g. after Luk dagen) re-fetches the batch and the cards' reads", async () => {
    mockApi();
    mount();
    await waitFor(() => expect(moneyShown()).toBe(true));
    await new Promise((r) => setTimeout(r, 300));
    const before = { batch: calls("/dashboard/batch").length, fc: calls("/cashflow/forecast").length, dc: calls("/daily-close").length };
    await act(async () => { window.dispatchEvent(new Event("bonbox-data-changed")); });
    await waitFor(() => expect(calls("/dashboard/batch").length).toBe(before.batch + 1));
    await waitFor(() => expect(calls("/cashflow/forecast").length).toBe(before.fc + 1));
    await waitFor(() => expect(calls("/daily-close").length).toBe(before.dc + 1));
  });
});

describe("I — the money does not wait for slow cards", () => {
  it("shows the page within a beat of the batch while a card's own request is still out", async () => {
    // A card request that does not answer during the test (counted by
    // services/apiActivity exactly as the real API client counts it).
    requestStarted();
    try {
      mockApi();
      const { container } = mount();
      await waitFor(() => expect(calls("/dashboard/batch")).toHaveLength(1));
      // Was: held hidden until every request settled, capped at 1.2 s.
      await waitFor(() => expect(container.querySelector("div[hidden]")).toBeNull(), { timeout: 700 });
      expect(moneyShown()).toBe(true);
    } finally {
      requestSettled();
    }
  });
});

describe("K — back on Home is instant, never across accounts", () => {
  const ownerCache = () => {
    setCacheAccount(accountKeyFor(currentUser));
    setSharedDevice(false);
  };

  it("second visit draws the last figures at once (no skeleton) and refreshes quietly", async () => {
    ownerCache();
    mockApi();
    const first = mount();
    await waitFor(() => expect(moneyShown()).toBe(true));
    first.unmount();

    // Coming back: the server is slow now — the kept copy must not wait for it.
    let answer;
    get.mockImplementation((url) => {
      if (url === "/dashboard/batch") return new Promise((r) => { answer = r; });
      return Promise.resolve({ data: [] });
    });
    const { container } = mount();
    expect(moneyShown()).toBe(true);                                   // same tick as mount
    // No page-level skeleton: the page is not held hidden behind one. (A card
    // whose own answer is not kept may still show its own small placeholder.)
    expect(container.querySelector("div[hidden]")).toBeNull();
    await waitFor(() => expect(calls("/dashboard/batch").length).toBeGreaterThanOrEqual(2)); // revalidating
    await act(async () => { answer({ data: batch({ summary: { ...SUMMARY, month_revenue: 130000 } }) }); });
    await waitFor(() => expect(screen.queryAllByText(/130\.000/).length).toBeGreaterThan(0));
  });

  it("another account never sees the first account's figures", async () => {
    ownerCache();
    mockApi();
    const first = mount();
    await waitFor(() => expect(moneyShown()).toBe(true));
    first.unmount();

    currentUser = { ...currentUser, id: 2, email: "other@cafe.dk" };
    setCacheAccount(accountKeyFor(currentUser)); // AuthProvider does this on every user change
    get.mockImplementation(() => new Promise(() => {})); // nothing answers
    const { container } = mount();
    expect(moneyShown()).toBe(false);
    expect(container.querySelector("div[hidden]")).not.toBeNull();     // page held behind the skeleton
  });

  it("an invited seat gets no kept copy", async () => {
    currentUser = { ...currentUser, role: "cashier" };
    setCacheAccount(accountKeyFor(currentUser));
    setSharedDevice(false);
    mockApi();
    const first = mount();
    await waitFor(() => expect(calls("/dashboard/batch")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    first.unmount();
    get.mockImplementation(() => new Promise(() => {}));
    const { container } = mount();
    expect(container.querySelector("div[hidden]")).not.toBeNull();
  });

  it("a write elsewhere throws the copy away — Home waits for the server again", async () => {
    ownerCache();
    mockApi();
    const first = mount();
    await waitFor(() => expect(moneyShown()).toBe(true));
    first.unmount();
    window.dispatchEvent(new Event("bonbox-data-changed")); // e.g. an expense was saved
    get.mockImplementation(() => new Promise(() => {}));
    const { container } = mount();
    expect(moneyShown()).toBe(false);
    expect(container.querySelector("div[hidden]")).not.toBeNull();
  });

  it("a copy older than a few minutes says when it was fetched, until the refresh lands", async () => {
    ownerCache();
    mockApi();
    const realNow = Date.now;
    const first = mount();
    await waitFor(() => expect(moneyShown()).toBe(true));
    first.unmount();
    const t0 = realNow();
    Date.now = () => t0 + 7 * 60 * 1000; // seven minutes later
    try {
      get.mockImplementation((url) => (url === "/dashboard/batch" ? new Promise(() => {}) : Promise.resolve({ data: [] })));
      mount();
      expect(screen.getByText(/Opdateret for 7 min\. siden/i)).toBeTruthy();
    } finally {
      Date.now = realNow;
    }
  });

  // ── rev-1 / rev-2 (16 Oct) — a close-based venue coming back to Home ──
  // Yesterday's locked kasserapport: the figure the first tile is about.
  const yesterdayIso = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const CLOSES = () => [{ id: "c1", date: yesterdayIso(), status: "confirmed", revenue_total: 20653 }];
  const scanSheet = () => document.querySelector('[role="dialog"][aria-label="Skan udgiftsbon"]');
  const lastCloseTile = () => screen.queryAllByText((_, el) => /20\.653/.test(el?.textContent || "") && el.children.length === 0).length > 0;
  const todaySoFar = () => screen.queryAllByText("I dag indtil nu").length > 0;

  const firstVisit = async (closes = CLOSES()) => {
    ownerCache();
    mockApi({ closes });
    const first = mount();
    await waitFor(() => expect(moneyShown()).toBe(true));
    await waitFor(() => expect(lastCloseTile()).toBe(closes.length > 0));
    first.unmount();
  };

  it("no receipt-scan sheet opens by itself — first visit or back on Home", async () => {
    await firstVisit();
    expect(scanSheet()).toBeNull();
    get.mockImplementation((url) => (url === "/dashboard/batch" ? new Promise(() => {}) : Promise.resolve({ data: [] })));
    mount();
    expect(moneyShown()).toBe(true); // the kept copy is on screen…
    expect(scanSheet()).toBeNull(); // …and no sheet over it
    await new Promise((r) => setTimeout(r, 50));
    expect(scanSheet()).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
    // The scan is one tap away instead: its button opens the sheet.
    await act(async () => { screen.getByRole("button", { name: /Skan udgiftsbon/ }).click(); });
    await waitFor(() => expect(scanSheet()).not.toBeNull());
  });

  it("the first tile is 'Sidste lukning' from the first frame — never 'I dag indtil nu' in between", async () => {
    await firstVisit();
    // Back on Home; the server is slow — nothing has answered yet.
    get.mockImplementation(() => new Promise(() => {}));
    mount();
    expect(lastCloseTile()).toBe(true);
    expect(todaySoFar()).toBe(false);
    expect(screen.getAllByText("Sidste lukning").length).toBeGreaterThan(0);
  });

  it("offline: the kept close list stays when the re-check fails", async () => {
    await firstVisit();
    get.mockImplementation((url) => (
      url === "/dashboard/batch" ? new Promise(() => {}) : Promise.reject(new Error("Network Error"))
    ));
    mount();
    await waitFor(() => expect(calls("/daily-close").length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(lastCloseTile()).toBe(true);
    expect(todaySoFar()).toBe(false);
  });

  it("with no kept close list, the tile waits as 'Sidste lukning —', not today's 4.200 kr.", async () => {
    await firstVisit();
    // The kept close list is gone (say its request never answered on the
    // first visit), the kept batch is not: /daily-close is still out.
    __resetSwrCacheForTests();
    ownerCache();
    const { writeDashboard, cacheGeneration } = await import("../lib/swrCache");
    const { businessTodayIso } = await import("../utils/dateFormat");
    const { cutoffHourFor } = await import("../config/archetypes");
    writeDashboard(businessTodayIso(cutoffHourFor(currentUser.business_type)), batch(), cacheGeneration(),
      undefined, accountKeyFor(currentUser));
    let answerCloses;
    get.mockImplementation((url) => {
      if (url === "/daily-close") return new Promise((r) => { answerCloses = r; });
      if (url === "/dashboard/batch") return new Promise(() => {});
      return Promise.resolve({ data: [] });
    });
    mount();
    expect(moneyShown()).toBe(true);
    expect(todaySoFar()).toBe(false);
    expect(screen.getAllByText("Sidste lukning").length).toBeGreaterThan(0);
    await waitFor(() => expect(typeof answerCloses).toBe("function"));
    await act(async () => { answerCloses({ data: CLOSES() }); });
    await waitFor(() => expect(lastCloseTile()).toBe(true));
  });

  it("an answered list with no confirmed close still shows today (unchanged)", async () => {
    await firstVisit([]);
    get.mockImplementation((url) => (url === "/dashboard/batch" ? new Promise(() => {}) : Promise.resolve({ data: [] })));
    mount();
    await waitFor(() => expect(todaySoFar()).toBe(true));
  });
});
