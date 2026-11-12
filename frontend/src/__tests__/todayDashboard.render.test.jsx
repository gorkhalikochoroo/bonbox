/**
 * The I dag page renders (a green build is not a running page — the TDZ P0
 * lesson): mid-service and before opening, with the honesty rules visible in
 * the DOM — a trend WORD (never a %), no figure without a source, the publish
 * action behind a confirm, and the "before opening" state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), post: (...a) => post(...a) } }));
vi.mock("../lib/swrCache", () => ({ peekGet: () => null }));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "da",
    t: (k, vars) => (vars && typeof vars === "object" ? `${k}(${Object.entries(vars).map(([a, b]) => `${a}=${b}`).join(",")})` : k),
  }),
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1", business_type: "restaurant", currency: "DKK", role: "owner" } }) }));
vi.mock("../hooks/usePillars", () => ({ usePillars: () => ({ hiddenPillars: new Set() }) }));
const confirmMock = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmMock }));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: () => {} }));

import TodayDashboard from "../components/today/TodayDashboard";

function payload(over = {}) {
  return {
    business_day: "2026-11-12",
    weekday: 3,
    now: "14:32",
    now_minutes: 14 * 60 + 32,
    cutoff_hour: 6,
    hours: { open: "11:00", close: "23:00" },
    day_state: "open",
    sales: { today: 9840, today_closed: false, today_sale_count: 31, yesterday: 16200, last_week_same_day: 15100, trend: null, uses_daily_close: true, confirmed_closes_30d: 20 },
    reservations: {
      has_book: true, seats: 28, count: 2, covers: 6, requested: 1, waitlist: 1,
      peak: { time: "19:00", covers: 28, full: true },
      slots: [{ t: "18:00", m: 1080, covers: 4 }, { t: "18:30", m: 1110, covers: 6 }],
      items: [
        { id: "r1", time: "18:00", name: "Larsen", party: 4, tables: ["T4"], status: "confirmed", allergy: true, occasion: "Fødselsdag" },
        { id: "r2", time: "18:30", name: "Petersen", party: 2, tables: ["T3"], status: "requested", allergy: false, occasion: null },
      ],
    },
    staff: {
      uses_clock: false, clocked_in_now: null,
      shifts: [
        { id: "s1", staff_id: "a", name: "Sangita", role: "Køkkenchef", start_time: "09:00", end_time: "17:00", status: "published", confirmed_at: "2026-11-10T10:00:00" },
        { id: "s2", staff_id: "b", name: "Emil", role: "Bartender", start_time: "16:00", end_time: "23:00", status: "published", confirmed_at: null },
      ],
    },
    close: {
      today: { date: "2026-11-12", status: "none", revenue: null, closed_at: null, steps: {} },
      yesterday: { date: "2026-11-11", status: "confirmed", revenue: 16200, closed_at: "23:42", steps: { photo: true, sales: true, payments: true, locked: true } },
      days: [{ date: "2026-11-11", status: "confirmed", revenue: 16200, venue_closed: false }, { date: "2026-11-12", status: "none", revenue: null, venue_closed: false }],
    },
    schedule: { week_start: "2026-11-09", week_number: 46, drafts: 6 },
    labor: { week_start: "2026-11-09", week_number: 46, planned_by_day: [0, 34, 36, 41, 46, 48, 38], logged_by_day: [0, 33.5, 36.5, 14.5, 0, 0, 0], planned_total: 243, logged_total: 84.5, labor_pct_ex_moms: 0.3125, settled_days: 2, target_pct: 0.3, missing_wage: 0 },
    revisor: { has_accountant_email: true, schedule: null },
    badges: { reservations: 1, schedule: 6, daily_close: 0 },
    ...over,
  };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  confirmMock.mockClear();
});

function mount(data) {
  get.mockImplementation((url) => {
    if (url === "/today") return Promise.resolve({ data });
    if (url === "/cashflow/forecast") return Promise.resolve({ data: { foresight: { available: true, deadline: { date: "2027-03-01", days_until: 109, period_label: "2. halvår" }, moms: { realized: 83520, expected: 113834 }, action: { weekly_rate: 7200, weeks: 15, already_covered: false } } } });
    if (url === "/diagnostics/needs-you") return Promise.resolve({ data: [{ code: "unconfirmed_reservations", severity: "info", deep_link: "/reservations", meta: { count: 1 } }] });
    return Promise.resolve({ data: null });
  });
  return render(<MemoryRouter><TodayDashboard initial={data} /></MemoryRouter>);
}

describe("I dag — mid-service", () => {
  it("renders the measured figures, a word-free part-day sales tile and every card", async () => {
    mount(payload());
    expect(screen.getByText("tdGreetAfternoon")).toBeInTheDocument();
    expect(screen.getByText(/^9\.840/)).toBeInTheDocument();
    // a part day: last week's measured figure, never a trend word, never a %
    expect(screen.getByText(/^tdLastWeekdayAmount\(weekday=.*amount=15\.100/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/tdTrend/);
    expect(document.body.textContent).not.toMatch(/\+\s?\d+\s?%/);
    expect(screen.getByText("tdOpenNow")).toBeInTheDocument();
    expect(screen.getByText("Larsen")).toBeInTheDocument();
    expect(screen.getByText("tdAllergy")).toBeInTheDocument();
    expect(screen.getByText("Fødselsdag")).toBeInTheDocument();
    expect(screen.getByText("Sangita")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^~7\.200/)).toBeInTheDocument());
    expect(screen.getByText("tdLaborPct(pct=31)")).toBeInTheDocument();
    // every booking row opens that booking
    const row = screen.getByText("Petersen").closest("a");
    expect(row.getAttribute("href")).toBe("/reservations?booking=r2&date=2026-11-12");
  });

  it("Kræver dig: publish asks first, then calls the real endpoint and refreshes", async () => {
    post.mockResolvedValue({ data: {} });
    const seen = vi.fn();
    window.addEventListener("bonbox-data-changed", seen);
    mount(payload());
    const btn = await screen.findByRole("button", { name: "tdPublishAction" });
    fireEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/staff/schedules/publish", null, { params: { week_start: "2026-11-09", lang: "da" } }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(seen).toHaveBeenCalled());
    window.removeEventListener("bonbox-data-changed", seen);
  });

  it("a locked day with a like-for-like baseline shows the WORD", () => {
    mount(payload({
      sales: { today: 18000, today_closed: true, today_sale_count: 0, yesterday: 16200, last_week_same_day: 15100, trend: "higher", uses_daily_close: true, confirmed_closes_30d: 20 },
      close: { ...payload().close, today: { date: "2026-11-12", status: "confirmed", revenue: 18000, closed_at: "23:10", steps: { photo: true, sales: true, payments: true, locked: true } } },
      day_state: "after_close",
    }));
    expect(screen.getByText(/^tdTrendHigher\(weekday=/)).toBeInTheDocument();
  });
});

describe("I dag — before opening", () => {
  it("says the day has not started, shows yesterday, and draws no now line", () => {
    mount(payload({
      now: "08:15", now_minutes: 8 * 60 + 15, day_state: "before_open",
      sales: { today: 0, today_closed: false, today_sale_count: 0, yesterday: 16200, last_week_same_day: null, trend: null, uses_daily_close: true, confirmed_closes_30d: 20 },
    }));
    expect(screen.getByText("tdGreetMorning")).toBeInTheDocument();
    expect(screen.getByText("tdNotOpenYet")).toBeInTheDocument();
    expect(screen.getByText("tdOpensAt(time=11:00)")).toBeInTheDocument();
    expect(screen.getByText(/^tdYesterdayAmount\(amount=16\.200/)).toBeInTheDocument();
    expect(screen.getByText("tdYesterdayDone")).toBeInTheDocument();
    expect(document.querySelector(".td-now")).toBeNull();
  });
});
