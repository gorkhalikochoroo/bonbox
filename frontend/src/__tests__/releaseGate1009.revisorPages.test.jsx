/**
 * Release gate R-a (9 Oct) — the MOMS-angivelse and lønningsliste sends.
 *
 *   1. A 403 whose reason is "claim_question_open" (the address IS
 *      confirmed; the answer to the mailed "Har du selv oprettet denne
 *      konto?" is missing) says that, with "Send spørgsmålet igen" — never
 *      "bekræft din e-mail først" / "Bekræft nu".
 *   2. For an account BonBox holds right now (fresh read), the page says so
 *      BEFORE the send — no confirm promising "Your revisor gets …" / "To: …
 *      You get a copy", and nothing is posted.
 *
 * t() returns the English fallback with vars filled, so these read shipped copy.
 */
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), refreshUser: vi.fn(),
  user: { id: 1, currency: "DKK", role: "owner", email_verified: true, claim_question_open: false },
}));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user, refreshUser: (...a) => h.refreshUser(...a) }) }));
const fill = (s, vars) =>
  vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => (typeof fb === "string" ? fill(fb, vars) : fill(k, fb)),
    lang: "da", setLang: () => {}, LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => "starter", isReady: true }),
}));
const confirmMock = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", async (orig) => ({ ...(await orig()), useConfirm: () => confirmMock }));

const StaffPayrollPage = (await import("../pages/StaffPayrollPage")).default;
const TaxAutopilotPage = (await import("../pages/TaxAutopilotPage")).default;

const CLAIM_TEXT = "Not sent to your revisor — BonBox is waiting for your answer to the question we e-mailed you (did you create this account yourself?)";
const UNVERIFIED_TEXT = "Not sent to your revisor — confirm your e-mail first";
const CLAIM_403 = { response: { status: 403, data: { detail: {
  code: "email_unverified", reason: "claim_question_open",
  message: "Your e-mail address is confirmed, but …", message_da: "Din e-mailadresse er bekræftet, men …",
} } } };

const YEAR = new Date().getFullYear();
const PAYROLL = {
  "/staff/pay-period/current": { start_date: `${YEAR}-09-01`, end_date: `${YEAR}-09-30`, period_type: "monthly_1st", custom_start_day: null },
  "/staff/members": [{ id: "a", name: "Ali", role: "bar", contract_type: "hourly" }],
  "/staff/hours/summary": [{ staff_id: "a", total_hours: 37.5, total_earned: 5625.5, tips_received: 0, overtime_hours: 0, entries_count: 30, approved_count: 30, needs_answer_count: 0 }],
  "/staff/payroll/estimate": {
    staff_count: 1,
    totals: { gross: 5625.5, am_bidrag: 1, a_skat: 1, net_pay: 1, atp: 99, feriepenge: 700, employer_total_cost: 6400, hours: 37.5 },
    skat_remit: { total: 2, am_bidrag: 1, a_skat: 1 }, per_staff: [], estimate_note: "x",
  },
  "/weather/sick-calls": [],
  "/weather/sick-calls/stats": { this_month: 0, last_month: 0, weather_related: 0 },
  "/business": { accountant_email: "pia@realrevisor.dk", accountant_name: "Pia Jensen" },
};
const TAX = {
  "/tax/overview": {
    tax_name: "Moms", authority: "Skattestyrelsen", rate_pct: 25, frequency: "quarterly",
    upcoming_deadlines: [{
      period_start: "2026-07-01", period_end: "2026-09-30", deadline: "2026-12-01",
      days_until: 54, status: "ok", estimated_amount: 1000, output_vat: 2000, input_vat: 1000,
    }],
    current_month: {}, ytd: {}, alerts: [],
  },
  "/tax/voucher-audit": { _error: true },
  "/business": { accountant_email: "pia@realrevisor.dk", accountant_name: "Pia Jensen" },
  "/auth/me": {},
};
const routeGets = (table) => h.get.mockImplementation((url) => Promise.resolve({ data: table[url] ?? [] }));
const sends = (path) => h.post.mock.calls.filter(([u]) => String(u).includes(path));

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  h.get.mockReset(); h.post.mockReset(); h.refreshUser.mockReset();
  h.refreshUser.mockResolvedValue(undefined);
  h.user = { id: 1, currency: "DKK", role: "owner", email_verified: true, claim_question_open: false };
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => true);
});

const openPayroll = async () => {
  routeGets(PAYROLL);
  render(
    <MemoryRouter initialEntries={["/staff/hours?tab=payroll"]}>
      <Routes><Route path="*" element={<StaffPayrollPage />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByTestId("pay-approval");
  const send = screen.getByRole("button", { name: /Send to accountant/ });
  await waitFor(() => expect(send.disabled).toBe(false));
  return send;
};
const openTax = async () => {
  routeGets(TAX);
  render(<MemoryRouter><TaxAutopilotPage /></MemoryRouter>);
  const send = await screen.findByRole("button", { name: "taxPdfEmailRevisorAria" });
  await waitFor(() => expect(send.disabled).toBe(false));
  return send;
};

describe("lønningsliste → revisor", () => {
  it("403 with the open question: the true reason + Send spørgsmålet igen, no Bekræft nu", async () => {
    h.post.mockImplementation((url) => (url === "/staff/payroll/send-to-accountant" ? Promise.reject(CLAIM_403)
      : Promise.resolve({ data: { ok: true, sent_to: "ejer@cafe.dk" } })));
    const send = await openPayroll();
    fireEvent.click(send);
    const resend = await screen.findByTestId("pay-send-claim-resend");
    expect(screen.getByText(CLAIM_TEXT)).toBeInTheDocument();
    expect(screen.queryByTestId("pay-send-verify-now")).toBeNull();
    expect(screen.getByRole("button", { name: /Download the PDF/ })).toBeInTheDocument();
    await act(async () => { fireEvent.click(resend); });
    expect(h.post).toHaveBeenCalledWith("/auth/claim-decision/remail", {}, { _noRetry: true });
  });

  it("held right now (fresh read): said before the send — no confirm, nothing posted", async () => {
    h.refreshUser.mockResolvedValue({ ...h.user, claim_question_open: true });
    const send = await openPayroll();
    fireEvent.click(send);
    await screen.findByTestId("pay-send-claim-resend");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(sends("/staff/payroll/send-to-accountant")).toHaveLength(0);
  });

  it("unconfirmed right now (fresh read): Bekræft nu, no confirm, nothing posted", async () => {
    h.refreshUser.mockResolvedValue({ ...h.user, email_verified: false });
    const send = await openPayroll();
    fireEvent.click(send);
    await screen.findByTestId("pay-send-verify-now");
    expect(screen.getByText(UNVERIFIED_TEXT)).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(sends("/staff/payroll/send-to-accountant")).toHaveLength(0);
  });
});

describe("MOMS-angivelse → revisor", () => {
  it("403 with the open question: the true reason + Send spørgsmålet igen, no Bekræft nu", async () => {
    h.post.mockImplementation((url) => (String(url).includes("/tax/filing-pdf/send-to-accountant")
      ? Promise.reject(CLAIM_403) : Promise.resolve({ data: {} })));
    const send = await openTax();
    fireEvent.click(send);
    const resend = await screen.findByTestId("filing-send-claim-resend");
    expect(resend.closest("div")).toHaveTextContent(CLAIM_TEXT);
    expect(screen.queryByTestId("filing-send-verify-now")).toBeNull();
  });

  it("held right now (fresh read): said before the send — no confirm, nothing posted", async () => {
    h.refreshUser.mockResolvedValue({ ...h.user, claim_question_open: true });
    const send = await openTax();
    fireEvent.click(send);
    await screen.findByTestId("filing-send-claim-resend");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(sends("/tax/filing-pdf/send-to-accountant")).toHaveLength(0);
  });

  it("a confirmed account with no question still confirms and sends", async () => {
    h.refreshUser.mockResolvedValue({ ...h.user });
    h.post.mockResolvedValue({ data: { ok: true, sent_to: "pia@realrevisor.dk" } });
    const send = await openTax();
    fireEvent.click(send);
    await waitFor(() => expect(sends("/tax/filing-pdf/send-to-accountant")).toHaveLength(1));
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });
});
