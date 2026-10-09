/**
 * Mail to the revisor waits for the owner's own confirmed e-mail — the
 * lønningsliste and the MOMS-angivelse sends.
 *
 * Both endpoints answer 403 email_unverified before anything is mailed. The
 * pages say "Ikke sendt til revisoren — bekræft din e-mail først" in the
 * owner's language (never the server's English sentence), with "Bekræft nu"
 * (/verify-email?now=1) — and the payroll page keeps the download beside it.
 *
 * t() returns the English fallback with vars filled, so these read shipped copy.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, currency: "DKK", role: "owner", email_verified: false } }),
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
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => "starter", isReady: true }),
}));
const confirmMock = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", async (orig) => ({
  ...(await orig()),
  useConfirm: () => confirmMock,
}));

const StaffPayrollPage = (await import("../pages/StaffPayrollPage")).default;
const TaxAutopilotPage = (await import("../pages/TaxAutopilotPage")).default;

const HELD = "Not sent to your revisor — confirm your e-mail first";
const REFUSED = {
  response: {
    status: 403,
    data: { detail: {
      code: "email_unverified",
      message: "Not sent to your revisor — confirm your e-mail first (Profile → Unverified). Until then, download the file and send it from your own e-mail.",
      message_da: "Ikke sendt til revisoren — bekræft din e-mail først (Profil → Ikke bekræftet).",
    } },
  },
};

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

const routeGets = (table) => get.mockImplementation((url) => Promise.resolve({ data: table[url] ?? [] }));

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  get.mockReset(); post.mockReset();
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => true);
});

describe("lønningsliste → revisor, unconfirmed owner", () => {
  it("says it plainly, with Bekræft nu and the PDF download beside it", async () => {
    routeGets(PAYROLL);
    post.mockRejectedValueOnce(REFUSED);
    render(
      <MemoryRouter initialEntries={["/staff/hours?tab=payroll"]}>
        <Routes><Route path="*" element={<StaffPayrollPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId("pay-approval");
    const send = screen.getByRole("button", { name: /Send to accountant/ });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    const link = await screen.findByTestId("pay-send-verify-now");
    expect(link).toHaveAttribute("href", "/verify-email?now=1");
    expect(screen.getByText(HELD)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download the PDF/ })).toBeInTheDocument();
    // Never the server's English sentence.
    expect(screen.queryByText(/Profile → Unverified/)).toBeNull();
    expect(post.mock.calls[0][0]).toBe("/staff/payroll/send-to-accountant");
  });
});

describe("MOMS-angivelse → revisor, unconfirmed owner", () => {
  it("says it plainly, with Bekræft nu — not the server's English message", async () => {
    routeGets(TAX);
    post.mockRejectedValueOnce(REFUSED);
    render(<MemoryRouter><TaxAutopilotPage /></MemoryRouter>);
    const send = await screen.findByRole("button", { name: "taxPdfEmailRevisorAria" });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    const link = await screen.findByTestId("filing-send-verify-now");
    expect(link).toHaveAttribute("href", "/verify-email?now=1");
    expect(link.parentElement).toHaveTextContent(HELD);
    expect(screen.queryByText(/Profile → Unverified/)).toBeNull();
    expect(String(post.mock.calls[0][0])).toContain("/tax/filing-pdf/send-to-accountant");
  });
});
