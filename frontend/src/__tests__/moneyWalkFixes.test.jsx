/**
 * Stock + Money walk (12 Oct 2026) — the screens that said untrue things.
 *
 *  P0  MOMS forecast: an owner who joined mid-period is told the forecast
 *      only has figures from their first day (dashboard card + Pengestrøm).
 *  P1  Smart skan: "Felter pre-udfyldt" only when something WAS read.
 *  P1  Kassebog: categories in the owner's language, the balance named for
 *      what it is, and a cash purchase says it is not booked as an expense.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

let get = vi.fn();
let post = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a), post: (...a) => post(...a),
    put: vi.fn(() => Promise.resolve({ data: { ok: true } })), patch: vi.fn(), delete: vi.fn(),
  },
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
}));

const { LanguageProvider } = await import("../hooks/useLanguage");
const withLang = (ui, lang = "da") => {
  localStorage.setItem("lang", lang);
  return render(<LanguageProvider><MemoryRouter>{ui}</MemoryRouter></LanguageProvider>);
};

beforeEach(() => {
  get = vi.fn();
  post = vi.fn();
  localStorage.clear();
});

// ─── P0: MOMS forecast "kun tal fra" ─────────────────────────────────
const FS = {
  available: true, verdict: "INSUFFICIENT_DATA", balance_source: "none",
  deadline: { date: "2027-03-01", period_label: "H2 2026", days_until: 140 },
  moms: { expected: 443000, realized: 116924, confidence: "low",
          period_start: "2026-07-01", data_from: "2026-09-11" },
};

describe("MOMS forecast — joined mid-period", () => {
  it("the dashboard card says the figures start on 11 Sep", async () => {
    const Card = (await import("../components/dashboard/ComplianceCountdownCard")).default;
    withLang(<Card foresight={FS} />);
    const note = await screen.findByTestId("fs-data-from");
    expect(note.textContent).toMatch(/^BonBox har kun tal fra .*11.* — MOMS for .*1.*–.*10.* er ikke med$/);
  });

  it("no caveat when the data covers the period", async () => {
    const Card = (await import("../components/dashboard/ComplianceCountdownCard")).default;
    withLang(<Card foresight={{ ...FS, moms: { ...FS.moms, data_from: null } }} />);
    await screen.findAllByText(/MOMS/);
    expect(screen.queryByTestId("fs-data-from")).toBeNull();
  });

  it("Pengestrøm says it too", async () => {
    get.mockResolvedValue({ data: {
      projection: [], alerts: [], safety_threshold: 7000, lowest_point: null, danger_days: null,
      receivables: [], total_receivable: 0, recurring_expenses: [], daily_expense_avg: 1000,
      current_balance: null, forecast_ready: false, has_data: true, foresight: FS,
    } });
    const CashFlowPage = (await import("../pages/CashFlowPage")).default;
    withLang(<CashFlowPage />);
    const note = await screen.findByTestId("cfp-data-from");
    expect(note.textContent).toMatch(/BonBox har kun tal fra 11\. sep\. 26 — MOMS for 1\. jul\. 26–10\. sep\. 26 er ikke med/);
  });
});

// ─── Kassebog ────────────────────────────────────────────────────────
describe("Kassebog tells the truth about what it holds", () => {
  it("shows categories in Danish, names the balance, and flags a cash purchase", async () => {
    get.mockImplementation((url) => {
      if (String(url).includes("balance")) return Promise.resolve({ data: { balance: -350, total_in: 0, total_out: 350 } });
      return Promise.resolve({ data: [
        { id: "c1", date: "2026-10-12", type: "cash_out", amount: 350, category: "Purchase", description: "Fisk på torvet" },
      ] });
    });
    const CashBookPage = (await import("../pages/CashBookPage")).default;
    withLang(<CashBookPage />);
    // The stored "Purchase" reads "Indkøb" in the history (not the English key).
    await waitFor(() => expect(screen.getAllByText("Indkøb").length).toBeGreaterThan(0));
    expect(screen.queryByText("Purchase")).toBeNull();
    expect(screen.getByText(da.cbBalanceLabel)).toBeTruthy();
    expect(screen.getByTestId("cb-scope-note").textContent).toBe(da.cbScopeNote);
    // Udgående → Indkøb: "not booked as an expense".
    fireEvent.click(screen.getByRole("button", { name: da.cashOut }));
    fireEvent.click(screen.getAllByRole("button", { name: "Indkøb" })[0]);
    expect(screen.getByTestId("cb-not-expense").textContent).toBe(da.cbNotAnExpense);
  });
});

// ─── Smart skan → Udgifter ───────────────────────────────────────────
describe("the Smart skan banner and the photo", () => {
  it("the photo hand-off is taken once, only by its own route", async () => {
    const { holdScanPhoto, takeScanPhoto } = await import("../utils/pendingScanPhoto");
    const f = new File(["x"], "kvittering.jpg", { type: "image/jpeg" });
    holdScanPhoto(f, "/expenses");
    expect(takeScanPhoto("/inventory")).toBeNull();      // wrong route: dropped
    holdScanPhoto(f, "/expenses");
    expect(takeScanPhoto("/expenses")).toBe(f);
    expect(takeScanPhoto("/expenses")).toBeNull();       // once
  });

  it("copy exists in both languages", () => {
    for (const k of ["smartScan.notRead", "expScanPhotoKept", "cbBalanceLabel", "cbScopeNote", "cbNotAnExpense", "fsDataFromNote"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
    expect(da["smartScan.notRead"]).toBe("Vi kunne ikke læse billedet — udfyld beløbet");
  });
});
