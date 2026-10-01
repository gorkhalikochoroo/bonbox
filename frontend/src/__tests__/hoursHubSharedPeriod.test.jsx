/**
 * The Hours hub's tabs share the period on screen.
 *
 * Timer and Løn each kept their own period: an owner who approved September
 * in Timer and tapped Løn landed on October — and the lønseddel, the CSV and
 * "Send til revisor" all use the window on screen. The window now travels in
 * the URL (?from=&to=, utils/viewedPeriod.js); no params = the current period.
 */
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readViewedPeriod, writeViewedPeriod } from "../utils/viewedPeriod";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, role: "owner", currency: "DKK" }, loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k, fb) => (typeof fb === "string" ? fb : k), lang: "da", setLang: () => {}, LANGUAGES: [] }),
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));

const StaffHoursPage = (await import("../pages/StaffHoursPage")).default;
const StaffPayrollPage = (await import("../pages/StaffPayrollPage")).default;

const CURRENT = { start_date: "2026-10-01", end_date: "2026-10-31", period_type: "monthly_1st", custom_start_day: null };

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((url) => {
    if (url === "/staff/pay-period/current") return Promise.resolve({ data: CURRENT });
    if (url === "/staff/hours/overview") return Promise.resolve({ data: { has_any_hours: false, hours: {}, period: {}, cost: {}, labor: {}, flags: {} } });
    if (url === "/staff/payroll/estimate") return Promise.resolve({ data: { staff_count: 0, totals: { gross: 0, am_bidrag: 0, a_skat: 0, net_pay: 0, atp: 0, feriepenge: 0, employer_total_cost: 0, hours: 0 }, skat_remit: { total: 0, am_bidrag: 0, a_skat: 0 }, per_staff: [], estimate_note: "" } });
    if (url === "/weather/sick-calls/stats") return Promise.resolve({ data: { this_month: 0, last_month: 0, weather_related: 0 } });
    return Promise.resolve({ data: [] });
  });
});

let seen = "";
function Probe() {
  seen = useLocation().search;
  return null;
}
const mount = (Page, search) =>
  render(
    <MemoryRouter initialEntries={[`/staff/hours${search}`]}>
      <Page />
      <Probe />
    </MemoryRouter>,
  );
const summaryCalls = () =>
  get.mock.calls.filter(([url]) => url === "/staff/hours/summary").map(([, cfg]) => cfg?.params?.from);

describe("the window travels in the URL", () => {
  it("reads a real window and refuses nonsense", () => {
    const q = (s) => new URLSearchParams(s);
    expect(readViewedPeriod(q("from=2026-09-01&to=2026-09-30"))).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(readViewedPeriod(q(""))).toBeNull();
    expect(readViewedPeriod(q("from=2026-09-30&to=2026-09-01"))).toBeNull();
    expect(readViewedPeriod(q("from=2026-02-31&to=2026-03-02"))).toBeNull();
    expect(readViewedPeriod(q("from=2020-01-01&to=2026-01-01"))).toBeNull();
    expect(readViewedPeriod(q("from=sep&to=okt"))).toBeNull();
  });

  it("writes the window, and takes it out again for the current period", () => {
    const set = vi.fn();
    const cur = { from: "2026-10-01", to: "2026-10-31" };
    writeViewedPeriod(new URLSearchParams("tab=payroll"), set, { from: "2026-09-01", to: "2026-09-30" }, cur);
    expect(String(set.mock.calls[0][0])).toBe("tab=payroll&from=2026-09-01&to=2026-09-30");
    expect(set.mock.calls[0][1]).toEqual({ replace: true });
    set.mockClear();
    writeViewedPeriod(new URLSearchParams("tab=payroll&from=2026-09-01&to=2026-09-30"), set, cur, cur);
    expect(String(set.mock.calls[0][0])).toBe("tab=payroll");
  });
});

describe("Timer and Løn open on the period the owner brought", () => {
  it("Timer opens on September, not on the current month", async () => {
    mount(StaffHoursPage, "?tab=hours&from=2026-09-01&to=2026-09-30");
    await waitFor(() => expect(summaryCalls()).toContain("2026-09-01"));
    expect(summaryCalls()).not.toContain("2026-10-01");
    expect(seen).toContain("from=2026-09-01");
  });

  it("Løn opens on September too", async () => {
    mount(StaffPayrollPage, "?tab=payroll&from=2026-09-01&to=2026-09-30");
    await waitFor(() => expect(summaryCalls()).toContain("2026-09-01"));
    expect(summaryCalls()).not.toContain("2026-10-01");
  });

  it("with nothing carried, both show the current period and keep the URL clean", async () => {
    mount(StaffHoursPage, "?tab=hours");
    await waitFor(() => expect(summaryCalls()).toContain("2026-10-01"));
    expect(seen).not.toContain("from=");
  });
});
