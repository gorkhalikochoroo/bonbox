/**
 * Gavekort vs MOMS P0-1 on the MOMS page.
 *
 * SPV (enkeltformål) gavekort sold in the period are now counted in the MOMS
 * figure (MOMS at sale). That must be SAID next to the figure — a number
 * that moves silently is the defect class this product keeps paying for.
 * The new reconciliation outcomes (counted twice / voided SPV) render in the
 * owner's language from their own keys, not the server's English.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", email_verified: true }, refreshUser: vi.fn() }),
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

const TaxAutopilotPage = (await import("../pages/TaxAutopilotPage")).default;

const VAT = { sales_total: 0, output_vat: 0, input_vat: 0, vat_payable: 0, expenses_total: 0, taxable_sales: 0 };
const OVERVIEW = {
  tax_name: "MOMS", authority: "SKAT", rate: 0.25, rate_pct: 25, frequency: "quarterly",
  available_frequencies: [], prices_include_moms: true, currency: "DKK",
  upcoming_deadlines: [{
    deadline: "2027-03-01", period_label: "Q4 2026", period_start: "2026-10-01", period_end: "2026-12-31",
    days_until: 140, status: "upcoming", estimated_amount: 80, output_vat: 80, input_vat: 0,
    sales_total: 400, expenses_total: 0, gavekort_spv_sold: 400, gavekort_spv_output_vat: 80,
  }],
  current_month: { ...VAT }, ytd: { ...VAT },
  alerts: [
    { type: "gavekort_double_check", severity: "warning", params: { count: 1, total: "500 kr." },
      title: "Gavekort may be counted twice", detail: "x" },
    { type: "gavekort_spv_voided", severity: "info", params: { count: 1, total: "300 kr.", moms: "60 kr." },
      title: "Voided gavekort — MOMS stays in", detail: "y" },
  ],
  daily_close_reconciliation: { current_month: {}, ytd: {} },
  payroll_deadlines: [],
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((url) => {
    if (url === "/tax/overview") return Promise.resolve({ data: OVERVIEW });
    if (url === "/tax/voucher-audit") return Promise.resolve({ data: null });
    return Promise.resolve({ data: {} });
  });
});

describe("MOMS page — gavekort", () => {
  it("says the SPV gavekort sold are inside the MOMS figure", async () => {
    render(<MemoryRouter><TaxAutopilotPage /></MemoryRouter>);
    const line = await screen.findByTestId("tax-gk-spv-line");
    expect(line.textContent).toMatch(/^taxGkSpvIncluded:400 kr\.\|80 kr\.$/);
  });

  it("renders the new alerts from their own keys", async () => {
    render(<MemoryRouter><TaxAutopilotPage /></MemoryRouter>);
    expect(await screen.findByText(/^taxAlertGkDoubleTitle:/)).toBeInTheDocument();
    expect(screen.getByText(/^taxAlertGkVoidedTitle:/)).toBeInTheDocument();
  });

  it("copy in both languages", () => {
    for (const k of ["taxGkSpvIncluded", "taxAlertGkDoubleTitle", "taxAlertGkDoubleDetail",
                     "taxAlertGkVoidedTitle", "taxAlertGkVoidedDetail"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
  });
});
