/**
 * "Send til revisor" never promises what the plan does not do. A Free owner
 * with a saved revisor used to be asked "… sendes til {revisor}. Du får en
 * kopi." — and then BonBox sent nothing (402 → download + own mail). Free now
 * goes straight to the own-mail path, with no BonBox-send confirm, and the
 * line under the button says so. Starter keeps the who/what/which-days confirm.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
const post = vi.fn();
let entitled = true;
const ownMail = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
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
  useEntitlements: () => ({
    hasFeature: (k) => (k === "direct_accountant_email" ? entitled : true),
    minPlanForFeature: () => null,
    isReady: true,
  }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));
vi.mock("../utils/shareDailyCloseRange", () => ({
  sendDailyCloseRangeToAccountant: (...a) => { ownMail(...a); return Promise.resolve({ ok: true, channel: "mailto" }); },
}));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const yesterday = (() => {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
const realConfirm = window.confirm;

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  ownMail.mockReset();
  window.URL.createObjectURL = () => "blob:http://localhost/x";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") {
      return Promise.resolve({ data: [{
        id: "L1", date: yesterday, status: "confirmed", revenue_total: 1000,
        revenue_breakdown: { food: 1000 }, payment_breakdown: { card: 1000 }, payment_total: 1000,
        moms_total: 200, revenue_ex_moms: 800, closed_by: "Lars",
      }] });
    }
    if (url === "/business") return Promise.resolve({ data: { accountant_email: "anna@revisor.dk", company_name: "Mirabelle ApS" } });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: { ok: true, sent_to: "anna@revisor.dk" } });
});
afterEach(() => { window.confirm = realConfirm; });

const openHistorySend = async () => {
  render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  const btn = await screen.findByRole("button", { name: /sendToAccountantBtn/ });
  await waitFor(() => expect(btn).not.toBeDisabled());
  return btn;
};

describe("Send til revisor on Free", () => {
  it("skips the BonBox-send confirm and opens the owner's own mail", async () => {
    entitled = false;
    window.confirm = vi.fn(() => true);
    const btn = await openHistorySend();
    expect(await screen.findByText(/^dcSendToLineOwnMail:/)).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(ownMail).toHaveBeenCalled());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([u]) => String(u).includes("send-to-accountant"))).toBe(false);
    expect(ownMail.mock.calls[0][0].accountantEmail).toBe("anna@revisor.dk");
  });

  it("Starter still asks who/what before BonBox mails a third party", async () => {
    entitled = true;
    window.confirm = vi.fn(() => false);
    const btn = await openHistorySend();
    expect(screen.queryByText(/^dcSendToLineOwnMail:/)).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(String(window.confirm.mock.calls[0][0])).toContain("dcSendConfirmBody");
    expect(ownMail).not.toHaveBeenCalled();
  });
});
