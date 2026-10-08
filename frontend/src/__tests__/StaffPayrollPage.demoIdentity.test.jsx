/**
 * Løn under the demo's sample company: a real revisor is saved, but the
 * business is still "Mirabelle ApS" (identity_is_demo). The server answers
 * 409 demo_identity — so the page says why on the spot, links to Profile,
 * and the Send button is disabled (never a confirm in front of a refusal).
 * Round 6 of the revisor artifacts.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
    lang: "da", setLang: () => {}, LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
const confirmMock = vi.fn(async () => false);
vi.mock("../hooks/useConfirm", async (orig) => ({
  ...(await orig()),
  useConfirm: () => confirmMock,
}));

const StaffPayrollPage = (await import("../pages/StaffPayrollPage")).default;

const YEAR = new Date().getFullYear();
const CURRENT = { start_date: `${YEAR}-09-01`, end_date: `${YEAR}-09-30`, period_type: "monthly_1st", custom_start_day: null };
const MEMBERS = [
  { id: "a", name: "Ali", role: "bar", contract_type: "hourly" },
  { id: "b", name: "Sara", role: "kitchen", contract_type: "part" },
];
const SUMMARY = [
  { staff_id: "a", total_hours: 37.5, total_earned: 5625.5, tips_received: 0, overtime_hours: 0, entries_count: 30, approved_count: 28, needs_answer_count: 2 },
  { staff_id: "b", total_hours: 20, total_earned: 3000, tips_received: 0, overtime_hours: 0, entries_count: 11, approved_count: 10, needs_answer_count: 1 },
];
const ESTIMATE = {
  staff_count: 2,
  totals: { gross: 44317.67, am_bidrag: 1, a_skat: 1, net_pay: 1, atp: 189.33, feriepenge: 5539.7, employer_total_cost: 50046.7, hours: 57.5 },
  skat_remit: { total: 2, am_bidrag: 1, a_skat: 1 },
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
    "/business": () => Promise.resolve({ data: { accountant_email: " Anna@Revisor.dk ", accountant_name: "Anna Hansen" } }),
    ...overrides,
  };
  get.mockImplementation((url) => (responses[url] || (() => Promise.resolve({ data: [] })))());
};

let where = "";
function Where() {
  const loc = useLocation();
  where = `${loc.pathname}${loc.search}`;
  return null;
}
const mount = () => render(
  <MemoryRouter initialEntries={["/staff/hours?tab=payroll"]}>
    <Routes><Route path="*" element={<><StaffPayrollPage /><Where /></>} /></Routes>
  </MemoryRouter>,
);
const sendBtn = () => screen.getByRole("button", { name: /Send to accountant/ });
// The hours (and so their approval state) have arrived.
const ready = async () => {
  await screen.findByTestId("pay-approval");
  await waitFor(() => expect(sendBtn().disabled).toBe(false));
};

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  get.mockReset(); post.mockReset();
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => false);
  respond();
});

describe("payroll under the sample company", () => {
  it("says why, links to Profile, and Send is disabled", async () => {
    respond({
      "/business": () => Promise.resolve({ data: {
        accountant_email: "pia@realrevisor.dk", accountant_name: "Pia Jensen",
        company_name: "Mirabelle ApS", identity_is_demo: true,
      } }),
    });
    mount();
    const note = await screen.findByTestId("pay-identity-demo");
    expect(note.textContent).toContain("Your business is still set up as the sample company (Mirabelle ApS).");
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/profile");
    await screen.findByTestId("pay-approval");
    expect(sendBtn().disabled).toBe(true);
    fireEvent.click(sendBtn());
    expect(confirmMock).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("with the owner's own company, the recipient line and the button are back", async () => {
    respond({
      "/business": () => Promise.resolve({ data: {
        accountant_email: "pia@realrevisor.dk", accountant_name: "Pia Jensen",
        company_name: "Testcafé ApS", identity_is_demo: false,
      } }),
    });
    mount();
    await ready();
    expect(screen.queryByTestId("pay-identity-demo")).toBeNull();
    expect(screen.getByTestId("pay-send-recipient").textContent).toContain("Pia Jensen · pia@realrevisor.dk");
  });
});
