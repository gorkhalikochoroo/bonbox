/**
 * Løn: a read that failed is never a zero, and nothing is exported over one.
 *
 * Every fetch on this tab used to catch into something that looked like an
 * answer — and each one was exportable:
 *   • a failed hours summary  → "5 medarbejdere · 0 t · 0,00 kr. i alt"
 *   • a failed estimate        → "registrér medarbejdertimer først"
 *   • a failed roster          → "no staff members found"
 *   • a failed pay period      → a made-up fortnight ending today
 *
 * Plus the doctrine the reviewer checked on the same screen: role codes print
 * as names ("bar" → "Bar"), money keeps its øre, column headers carry no
 * status colour, no emoji, and a weekly lønperiode saved from Timer is shown
 * as weekly rather than as the first option of the select.
 *
 * t() returns the English fallback, so these read shipped copy.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a) },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, currency: "DKK", role: "owner" } }),
}));
const fill = (s, vars) =>
  vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => (typeof fb === "string" ? fill(fb, vars) : fill(k, fb)),
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));

const StaffPayrollPage = (await import("../pages/StaffPayrollPage")).default;

const CURRENT = { start_date: "2026-09-01", end_date: "2026-09-30", period_type: "monthly_1st", custom_start_day: null };
const MEMBERS = [
  { id: "a", name: "Ali", role: "bar", contract_type: "hourly" },
  { id: "b", name: "Sara", role: "kitchen", contract_type: "part" },
];
const SUMMARY = [
  { staff_id: "a", total_hours: 37.5, total_earned: 5625.5, tips_received: 412.25, overtime_hours: 0 },
  { staff_id: "b", total_hours: 20, total_earned: 3000, tips_received: 0, overtime_hours: 0 },
];
const ESTIMATE = {
  staff_count: 2,
  totals: { gross: 12345.5, am_bidrag: 987.64, a_skat: 4089.03, net_pay: 7268.83, atp: 99, feriepenge: 1543.19, employer_total_cost: 13987.69, hours: 57.5 },
  skat_remit: { total: 5076.67, am_bidrag: 987.64, a_skat: 4089.03 },
  per_staff: [],
  estimate_note: "x",
};

let responses;
const respond = (overrides = {}) => {
  responses = {
    "/staff/pay-period/current": () => Promise.resolve({ data: CURRENT }),
    "/staff/members": () => Promise.resolve({ data: MEMBERS }),
    "/staff/hours/summary": () => Promise.resolve({ data: SUMMARY }),
    "/staff/payroll/estimate": () => Promise.resolve({ data: ESTIMATE }),
    "/weather/sick-calls": () => Promise.resolve({ data: [] }),
    "/weather/sick-calls/stats": () => Promise.resolve({ data: { this_month: 0, last_month: 0, weather_related: 0 } }),
    ...overrides,
  };
  get.mockImplementation((url) => (responses[url] || (() => Promise.resolve({ data: [] })))());
};
const fail = () => Promise.reject({ response: { status: 500 } });
const mount = () => render(<MemoryRouter><StaffPayrollPage /></MemoryRouter>);
const exportButtons = () => [
  screen.getByRole("button", { name: /Generate PDF/ }),
  screen.getByRole("button", { name: /Send to accountant/ }),
];
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  get.mockReset();
  post.mockReset();
  respond();
});

describe("a failed read is never a zero", () => {
  it("failed hours: LoadFailed, no '0 t · 0,00 kr.' summary, exports disabled", async () => {
    respond({ "/staff/hours/summary": fail });
    const { container } = mount();
    await waitFor(() => expect(screen.getByText("Couldn't load the hours for this pay period.")).toBeTruthy());
    expect(container.textContent).not.toMatch(/0 t · 0,00 kr\./);
    for (const b of exportButtons()) expect(b.disabled).toBe(true);
    expect(screen.getAllByText(/Exports are paused/).length).toBeGreaterThan(0);
  });

  it("failed roster: LoadFailed, not 'no staff members found', exports disabled", async () => {
    respond({ "/staff/members": fail });
    mount();
    await waitFor(() => expect(screen.getAllByText("Couldn't load your staff.").length).toBeGreaterThan(0));
    expect(screen.queryByText(/No staff members found/)).toBeNull();
    for (const b of exportButtons()) expect(b.disabled).toBe(true);
  });

  it("failed estimate: says so, and the CSV and lønseddel stay visible but disabled", async () => {
    respond({ "/staff/payroll/estimate": fail });
    mount();
    await waitFor(() => expect(screen.getByText("Couldn't load the estimate for this pay period.")).toBeTruthy());
    expect(screen.queryByText(/log staff hours first/)).toBeNull();
    expect(screen.getByRole("button", { name: /Download summary CSV/ }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Lønseddel PDF/ }).disabled).toBe(true);
  });

  it("failed pay period: no invented fortnight, nothing to export", async () => {
    respond({ "/staff/pay-period/current": fail });
    mount();
    await waitFor(() => expect(screen.getByText("Couldn't load your pay period.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Generate PDF/ })).toBeNull();
    expect(get.mock.calls.some(([url]) => url === "/staff/hours/summary")).toBe(false);
  });

  it("when everything loads, the exports are live", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /Download summary CSV/ })).toBeTruthy());
    for (const b of exportButtons()) expect(b.disabled).toBe(false);
    expect(screen.queryByText(/Exports are paused/)).toBeNull();
  });
});

describe("what the screen says, when it can", () => {
  it("money keeps its øre: '12.345,50 kr.', not '12.346 kr.'", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("12.345,50 kr.")).toBeTruthy());
    expect(screen.queryByText("12.346 kr.")).toBeNull();
  });

  it("the picker's 'earned' is wages plus tips, not tips alone", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/2 of 2 staff selected/)).toBeTruthy());
    screen.getByText(/2 of 2 staff selected/).click();
    // 5.625,50 + 412,25 — the picker used to add keys the API never sends.
    await waitFor(() => expect(screen.getByText("6.037,75 kr.")).toBeTruthy());
  });

  it("a role code prints as a name: 'bar' is 'Bar'", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/2 of 2 staff selected/)).toBeTruthy());
    screen.getByText(/2 of 2 staff selected/).click();
    await waitFor(() => expect(screen.getByText("Bar")).toBeTruthy());
    expect(screen.queryByText("bar")).toBeNull();
  });

  it("no emoji, and no status colour on a column header", async () => {
    const { container } = mount();
    await waitFor(() => expect(screen.getByText("12.345,50 kr.")).toBeTruthy());
    screen.getByText(/2 staff ·/).click();
    await waitFor(() => expect(container.querySelector("thead")).toBeTruthy());
    expect(container.textContent).not.toMatch(EMOJI);
    for (const th of container.querySelectorAll("th")) {
      expect(th.className).not.toMatch(/amber|emerald/);
    }
  });

  it("a weekly lønperiode saved from Timer reads as weekly, not as the first option", async () => {
    respond({ "/staff/pay-period/current": () => Promise.resolve({ data: { ...CURRENT, period_type: "weekly" } }) });
    mount();
    const select = await screen.findByLabelText("Pay period");
    expect(select.value).toBe("weekly");
    expect(select.selectedOptions[0].textContent).toBe("Every week (Mon–Sun)");
  });

  it("the eyebrow matches Timer's", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("STAFF")).toBeTruthy());
  });
});
