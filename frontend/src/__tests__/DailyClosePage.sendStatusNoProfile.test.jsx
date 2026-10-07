/**
 * The lock-mail status line for an owner with NO BusinessProfile row.
 *
 * GET /business answers null when there is no profile row at all. The status
 * line used to hide whenever the profile was null — meant only for "still
 * loading" — so these owners lost "Ikke sendt / auto-mail fra / ingen adresse"
 * and the "Send igen" button on the lock card and in History. Now the line
 * waits only until GET /business has SETTLED; a settled null is read as {}.
 * A failed read still says nothing (no claim from data BonBox could not read).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
let closes = [];
let businessResponse = () => Promise.resolve({ data: null });
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant", email: "login@x.dk" }, refreshUser: vi.fn() }),
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
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn(async () => ({ ok: true })) }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const close = (id, date, extra = {}) => ({
  id, date, status: "confirmed", revenue_total: 1000, revenue_breakdown: { food: 1000 },
  payment_breakdown: { card: 1000 }, payment_total: 1000, moms_total: 200,
  revenue_ex_moms: 800, closed_by: "Lars", email_sent_to: [], ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00"));
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  businessResponse = () => Promise.resolve({ data: null });  // no profile row
  closes = [];
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/business") return businessResponse();
    if (url === "/billing/me") return Promise.resolve({ data: { plan: "starter", caps: { daily_close_export_days: 31 } } });
    if (url === "/daily-close/accountant-sends") return Promise.resolve({ data: [] });
    if (url === "/daily-close/range-counts") return Promise.resolve({ data: {} });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: { email_status: "sent", email_sent_to: ["login@x.dk"] } });
});
afterEach(() => {
  vi.useRealTimers();
});

const renderPage = () => render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
const openHistory = async () => {
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await screen.findByRole("button", { name: /sendToAccountantBtn/ });
};

describe("no BusinessProfile row: the send status still shows, with its action", () => {
  it("History: a failed lock mail says so and offers Send igen", async () => {
    closes = [close("F1", "2026-10-06", { email_status: "send_failed", email_error: "send_error:500" })];
    await openHistory();
    expect(await screen.findByText(/dcMailOwnerCopyFailed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dcMailSendAgain/ }));
    await vi.waitFor(() => expect(post.mock.calls.some(([u]) => u === "/daily-close/F1/resend-email")).toBe(true));
  });

  it("History: auto-mail off and no address are both said", async () => {
    closes = [
      close("P1", "2026-10-06", { email_status: "skipped_preference_off" }),
      close("N1", "2026-10-05", { email_status: "skipped_no_recipient" }),
    ];
    await openHistory();
    expect(await screen.findByText(/dcMailPrefOff/)).toBeTruthy();
    expect(screen.getByText(/dcMailNoRecipientLine/)).toBeTruthy();
  });

  it("the lock card: today's skipped mail is said on the card", async () => {
    closes = [close("T1", "2026-10-07", { email_status: "skipped_preference_off" })];
    renderPage();
    expect(await screen.findByText(/dcMailPrefOff/)).toBeTruthy();
  });

  it("the lock card: a failed send offers Send igen", async () => {
    closes = [close("T1", "2026-10-07", { email_status: "send_failed", email_error: "send_error:500" })];
    renderPage();
    expect(await screen.findByText(/dcMailOwnerCopyFailed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /dcMailSendAgain/ })).toBeTruthy();
  });

  it("while /business is still loading, nothing is claimed", async () => {
    businessResponse = () => new Promise(() => {});  // never settles
    closes = [close("P1", "2026-10-06", { email_status: "skipped_preference_off" })];
    await openHistory();
    await screen.findAllByText(/dcUnlock$/);
    expect(screen.queryByText(/dcMailPrefOff/)).toBeNull();
  });

  it("a failed /business read claims nothing either", async () => {
    businessResponse = () => Promise.reject(new Error("network"));
    closes = [close("P1", "2026-10-06", { email_status: "skipped_preference_off" })];
    await openHistory();
    await screen.findAllByText(/dcUnlock$/);
    expect(screen.queryByText(/dcMailPrefOff/)).toBeNull();
  });
});
