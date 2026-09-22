/**
 * The close-aware card, MOUNTED — because a green build is not a running app.
 *
 * The sibling source/predicate test (dashboardCloseStatus.test.js) proves the
 * hardcoded `dailyCloseRanToday: false` is gone and that the renderIf answers
 * correctly for each of the three states. Neither of those claims reaches the
 * thing that actually broke for the owner, which is whether Home — on the ICP
 * night, a cafe with its own POS and therefore zero BonBox sales — now shows
 * the close-aware card at all.
 *
 * So this mounts the real DashboardPage against a fake API and reads the DOM.
 * It covers the whole chain in one go: /business answering with the venue's
 * day_cutoff_hour, /daily-close answering for the two-day window, the business
 * day being resolved against that cutoff, the derived flag reaching ctx, and
 * DASHBOARD_CARD_SET's predicate turning it into a rendered card.
 *
 * The second case is the one that used to be impossible to get wrong in the
 * old code because it never ran: with tonight's kasserapport already locked,
 * the card must be GONE. A prompt that survives the thing it was prompting for
 * is how an owner learns to ignore the dashboard.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { businessTodayIso } from "../utils/dateFormat";

const get = vi.fn();
const post = vi.fn(() => Promise.resolve({ data: {} }));

vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "ejer@mirabelle.dk", business_name: "Mirabelle", business_type: "cafe", currency: "DKK" },
    refreshUser: vi.fn(),
  }),
}));

vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ plan: "starter", has: () => true, ready: true, trialDaysRemaining: null }),
}));

vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn() }));

const DashboardPage = (await import("../pages/DashboardPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

/** The cafe's own POS rings the sales, so BonBox sees none of them. */
const ICP_SUMMARY = {
  today_revenue: 0,
  week_revenue: 0,
  month_revenue: 0,
  total_sales: 12,
  has_activity: true,
};

const CUTOFF = 6; // the DK restaurant convention this venue is on

/**
 * @param {Array} closes  rows GET /daily-close returns for the 2-day window
 */
function mockApi(closes) {
  get.mockImplementation((url) => {
    if (url === "/dashboard/batch") {
      return Promise.resolve({ data: { summary: ICP_SUMMARY } });
    }
    if (url === "/business") {
      return Promise.resolve({ data: { day_cutoff_hour: CUTOFF } });
    }
    if (url === "/daily-close") {
      return Promise.resolve({ data: closes });
    }
    if (url === "/output-channels") {
      // No recipient tagged role="closer" — the card has something to ask.
      return Promise.resolve({ data: [] });
    }
    // Every other self-fetching card on this dashboard: answer with an empty
    // LIST rather than `{}` or a rejection. Several of them do `(x || []).some`
    // straight off the payload and throw on an object, which trips
    // SelfHealBoundary and replaces the whole zone tree with "Something
    // glitched here" — an empty dashboard that would make this test pass or
    // fail for a reason that has nothing to do with the close.
    return Promise.resolve({ data: [] });
  });
}

const mount = () =>
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <DashboardPage />
      </MemoryRouter>
    </LanguageProvider>,
  );

describe("Home and tonight's kasserapport", () => {
  beforeEach(() => {
    get.mockReset();
    localStorage.clear();
    localStorage.setItem("lang", "en");
  });

  it("shows the close-aware card when the day is still open and BonBox saw no sales", async () => {
    // The exact case the old predicate excluded twice over: todaySales is 0
    // (own POS) and the flag it checked was a constant.
    mockApi([]);
    mount();
    expect(await screen.findByText(/Who closes for you\?/i)).toBeTruthy();
  });

  it("drops the card once tonight's close is confirmed", async () => {
    mockApi([{ id: 9, date: businessTodayIso(CUTOFF), status: "confirmed", revenue_total: 17030 }]);
    mount();
    // Wait for the dashboard to settle, then assert absence — findBy* would
    // pass trivially here, so the wait has to hang off something that DOES
    // render.
    await waitFor(() => expect(get).toHaveBeenCalledWith("/daily-close", expect.anything()));
    await waitFor(() => {
      expect(screen.queryByText(/Who closes for you\?/i)).toBeNull();
    });
  });

  it("asks for a two-day window, so a 01:30 lock is still found", async () => {
    mockApi([]);
    mount();
    await waitFor(() => expect(get).toHaveBeenCalledWith("/daily-close", expect.anything()));
    const call = get.mock.calls.find(([url]) => url === "/daily-close");
    const { from, to } = call[1].params;
    expect(from < to).toBe(true);
    // Whatever hour the suite runs at, the business day has to be inside it.
    const businessDay = businessTodayIso(CUTOFF);
    expect(businessDay >= from && businessDay <= to).toBe(true);
  });
});
