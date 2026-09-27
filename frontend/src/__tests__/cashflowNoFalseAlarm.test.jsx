/**
 * Pengestrøm may not alarm over a balance nobody entered.
 *
 * THE DEFECT. With no Kassebog and no typed bank balance the page showed
 * "NUVÆRENDE SALDO 0 kr.", "LAVESTE PUNKT -70.006 kr.", "RISIKODAGE 30 af 30"
 * and a red "Cash shortfall predicted … You'll be 70,006 short" — in English,
 * with English number formatting — directly under its own band saying
 * "Indtast din banksaldo". Three reviewers independently called it the page
 * that would lose an owner's trust fastest.
 *
 * Held here: an unknown balance asks one question and shows no forecast
 * numbers; a real alert is worded in the app language from its numbers; a
 * failed load says so.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

let get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), put: vi.fn(() => Promise.resolve({ data: { ok: true } })) },
}));

const CashFlowPage = (await import("../pages/CashFlowPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

const base = {
  projection: [], alerts: [], safety_threshold: 7000, lowest_point: null, danger_days: null,
  receivables: [], total_receivable: 0, recurring_expenses: [], daily_expense_avg: 1000,
  foresight: { available: true, verdict: "INSUFFICIENT_DATA", balance_source: "none", moms: { expected: 10000 } },
};

const renderAt = (lang = "en") => {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <CashFlowPage />
      </MemoryRouter>
    </LanguageProvider>,
  );
};

describe("Pengestrøm without a known balance", () => {
  beforeEach(() => {
    get = vi.fn();
    localStorage.clear();
  });

  it("asks for the balance and shows no forecast numbers or alarm", async () => {
    get.mockResolvedValue({ data: { ...base, current_balance: null, forecast_ready: false, has_data: true } });
    renderAt("en");
    expect(await screen.findByText("What's in the account today?")).toBeTruthy();
    expect(screen.queryByText(/Lowest point/i)).toBeNull();
    expect(screen.queryByText(/shortfall|run short/i)).toBeNull();
    // The old tiles are gone entirely — no "0 kr." standing in for "unknown".
    expect(screen.queryByText(/Current balance/i)).toBeNull();
  });

  it("words a real shortfall from its numbers, in Danish", async () => {
    get.mockResolvedValue({
      data: {
        ...base,
        current_balance: 20000, forecast_ready: true, has_data: true,
        lowest_point: { date: "2026-10-26", balance: -70006 }, danger_days: 12,
        projection: [{ date: "2026-09-27", day: "Sunday", balance: 20000, revenue: 0, expenses: 0, recurring: [] }],
        foresight: { ...base.foresight, balance_source: "manual" },
        alerts: [{
          type: "shortfall", severity: "critical",
          title: "Cash shortfall predicted on 2026-10-26", detail: "You'll be 70,006 short.",
          params: { date: "2026-10-26", amount: -70006, short: 70006, names: [], total: 0 },
        }],
      },
    });
    renderAt("da");
    const title = await screen.findByText(/Kassen kan gå i minus omkring/);
    expect(title).toBeTruthy();
    // Danish money format, not the server's English "70,006".
    expect(screen.getByText(/Prognosen når ned på .*70\.006/)).toBeTruthy();
    expect(screen.queryByText(/You'll be 70,006 short/)).toBeNull();
  });

  it("a failed load says so instead of drawing placeholders", async () => {
    get.mockResolvedValue({ data: { ...base, current_balance: null, _error: "Could not load", _recoverable: true } });
    renderAt("en");
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText("What's in the account today?")).toBeNull();
    expect(await screen.findByRole("button", { name: /try again|prøv igen/i })).toBeTruthy();
  });
});
