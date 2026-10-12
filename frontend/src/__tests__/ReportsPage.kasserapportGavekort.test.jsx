/**
 * Gavekort review 12 Oct 2026 — blocker 1 on the screen.
 *
 * The kasserapport printed "MOMS 200 / Subtotal −200" for a day whose only
 * sale was a 1.000 kr gavekort: the MOMS line was the filing's moms af salg,
 * which holds the card sale (not revenue). The till lines now carry only the
 * MOMS inside revenue; the gavekort is its own block, and the day's MOMS adds
 * up to the angivelse.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(() => Promise.resolve({ data: {} })), put: vi.fn(), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", currency: "DKK", business_type: "restaurant", plan: "pro" }, refreshUser: vi.fn() }),
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

const ReportsPage = (await import("../pages/ReportsPage")).default;

const KR = {
  date: "2026-11-03", business_name: "Restaurant Nord", currency: "kr.",
  transaction_count: 0, from_close: false,
  subtotal: 0, vat_rate: 25, vat_name: "MOMS", vat_amount: 0, total: 0,
  payment_breakdown: {}, expenses_total: 0, cash_in: 0, cash_out: 0, net_cash: 0,
  gavekort: { sold: 1000, sold_vat: 200, redeemed: 0, redeemed_vat: 0, net_vat: 200, any: true },
  moms_reconciliation: { kassesalg: 0, fakturaer: 0, gavekort_solgt: 200, gavekort_brugt: 0, moms_af_salg: 200 },
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: [{ status: "confirmed", date: "2026-11-03" }] });
    if (url === "/reports/daily-kasserapport") return Promise.resolve({ data: KR });
    return Promise.resolve({ data: {} });
  });
});

describe("kasserapport — gavekort apart from revenue", () => {
  it("shows a gavekort block whose day MOMS ties to the filing; no negative subtotal", async () => {
    window.history.pushState({}, "", "/reports");
    render(<MemoryRouter><ReportsPage /></MemoryRouter>);
    const block = await screen.findByTestId("kr-gavekort");
    expect(within(block).getByText("krGkTitle")).toBeInTheDocument();
    expect(within(block).getByText("krGkSold")).toBeInTheDocument();
    expect(within(block).getByText("krGkSoldVat:MOMS")).toBeInTheDocument();
    expect(within(block).getByText("krMomsForDay:MOMS")).toBeInTheDocument();
    expect(block.textContent).toMatch(/200,00/);
    expect(document.body.textContent).not.toMatch(/-\s?200,00|−\s?200,00/);
  });

  it("copy in both languages", () => {
    for (const k of ["krGkTitle", "krGkSold", "krGkSoldVat", "krGkRedeemedVat", "krMomsForDay"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
  });
});
