/**
 * Gavekort review 12 Oct 2026 on the MOMS page: the new questions render in
 * the owner's language from their own keys — a card sale BonBox can't check
 * (e), a bank line that may be a gavekort order (b, c), free cards (h) — and
 * the "counted twice" alert now ASKS (d).
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
  upcoming_deadlines: [],
  current_month: { ...VAT }, ytd: { ...VAT },
  alerts: [
    { type: "gavekort_sold_check", severity: "info", params: { count: 1, total: "500 kr." }, title: "a", detail: "a" },
    { type: "gavekort_bank_check", severity: "warning", params: { count: 1, total: "495 kr." }, title: "b", detail: "b" },
    { type: "gavekort_free", severity: "info", params: { count: 1, issued: "300 kr.", redeemed: "0 kr." }, title: "c", detail: "c" },
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

describe("MOMS page — the gavekort questions", () => {
  it("render from their own keys", async () => {
    render(<MemoryRouter><TaxAutopilotPage /></MemoryRouter>);
    expect(await screen.findByText(/^taxAlertGkSoldCheckTitle:/)).toBeInTheDocument();
    expect(screen.getByText(/^taxAlertGkBankTitle:/)).toBeInTheDocument();
    expect(screen.getByText(/^taxAlertGkFreeTitle:/)).toBeInTheDocument();
  });

  it("ask in both languages — the double-count alert is a question now", () => {
    for (const k of ["taxAlertGkSoldCheckTitle", "taxAlertGkSoldCheckDetail", "taxAlertGkBankTitle",
      "taxAlertGkBankDetail", "taxAlertGkFreeTitle", "taxAlertGkFreeDetail"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
    expect(da.taxAlertGkDoubleTitle).toMatch(/\?$/);
    expect(en.taxAlertGkDoubleTitle).toMatch(/\?$/);
    expect(da.taxAlertGkDoubleDetail).toMatch(/Gør det\?/);
  });
});
