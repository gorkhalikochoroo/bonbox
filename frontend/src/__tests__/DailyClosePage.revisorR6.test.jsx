/**
 * Revisor artifacts, round 6 — never the revisor under the sample company.
 *
 * The demo seeder writes its sample company (Mirabelle ApS) into the profile.
 * While it is still there (`identity_is_demo`), the server sends a revisor
 * nothing (skip / 409 "demo_identity"). The page must say so — and never
 * offer a send the server refuses:
 *   1. closeEmailState reads the identity: no send address, `identity` set.
 *   2. History: a real day under the sample company says why the revisor got
 *      nothing and links to Profile — no "Send til revisor" button.
 *   3. The period panel names it and Send goes nowhere (no confirm, no POST).
 *   4. A real identity keeps its send button (unchanged).
 *   5. "Ryd eksempeldata" asks first and says what goes and what stays.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const confirmMock = vi.fn();
const ownMail = vi.fn();
let closes = [];
let profile = {};
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant", email: "login@x.dk" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmMock }));
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
vi.mock("../utils/shareDailyCloseRange", () => ({
  sendDailyCloseRangeToAccountant: (...a) => ownMail(...a),
}));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;
const DemoActiveBanner = (await import("../components/DemoActiveBanner")).default;
const { closeEmailState } = await import("../utils/closeEmail");

const SAMPLE_CO = { accountant_email: "pia@realrevisor.dk", accountant_name: "Pia Jensen",
  company_name: "Mirabelle ApS", identity_is_demo: true };

const close = (id, date, status = "confirmed", extra = {}) => ({
  id, date, status, revenue_total: 1000, revenue_breakdown: { food: 1000 },
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
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(false);
  ownMail.mockReset();
  ownMail.mockResolvedValue({ ok: true, channel: "mailto" });
  profile = { ...SAMPLE_CO };
  closes = [];
  window.URL.createObjectURL = () => "blob:http://localhost/x";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/business") return Promise.resolve({ data: profile });
    if (url === "/billing/me") return Promise.resolve({ data: { plan: "starter", caps: { daily_close_export_days: 31 } } });
    if (url === "/daily-close/accountant-sends") return Promise.resolve({ data: [] });
    if (url === "/daily-close/range-counts") return Promise.resolve({ data: { n_locked: 1, n_drafts: 0, n_demo: 0 } });
    if (url === "/demo/status") return Promise.resolve({ data: { has_demo: true, has_real: false } });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: {} });
});
afterEach(() => {
  vi.useRealTimers();
});

const openHistory = async () => {
  render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await screen.findByRole("button", { name: /sendToAccountantBtn/ });
};
const card = (id) => document.querySelector(`[data-close-id="${id}"]`);

describe("closeEmailState and the sample company", () => {
  it("offers no send address and says identity", () => {
    const s = closeEmailState({ status: "sent", sentTo: ["login@x.dk"], profile: SAMPLE_CO });
    expect(s).toMatchObject({ kind: "owner_only", acct: "", identity: true, demo: false });
  });
  it("reads the lock's live skip reason too", () => {
    const s = closeEmailState({ status: "sent", sentTo: ["login@x.dk"], skip: "demo_identity",
      profile: { accountant_email: "pia@realrevisor.dk" } });
    expect(s.identity).toBe(true);
    expect(s.acct).toBe("");
  });
  it("a real identity is unchanged", () => {
    const s = closeEmailState({ status: "sent", sentTo: ["login@x.dk"],
      profile: { accountant_email: "pia@realrevisor.dk" } });
    expect(s).toMatchObject({ kind: "owner_only", acct: "pia@realrevisor.dk", identity: false });
  });
  it("a day that DID reach the revisor still says so", () => {
    const s = closeEmailState({ status: "sent", sentTo: ["pia@realrevisor.dk"], profile: SAMPLE_CO });
    expect(s.kind).toBe("revisor");
  });
});

describe("History under the sample company", () => {
  it("says why the revisor got nothing, links to Profile, offers no send", async () => {
    closes = [close("R1", "2026-10-06", "confirmed", {
      notes: "rigtig dag", email_status: "sent", email_sent_to: ["login@x.dk"],
      email_sent_at: "2026-10-06T21:12:00",
    })];
    await openHistory();
    const line = await screen.findByTestId("dc-mail-identity-demo");
    expect(line).toHaveTextContent("identityIsDemoNotice");
    const c = card("R1");
    expect(within(c).getByText(/dcMailOwnerOnly:/)).toBeInTheDocument();
    expect(within(c).getByRole("link", { name: "identityIsDemoCta" })).toHaveAttribute("href", "/profile");
    expect(within(c).queryByRole("button", { name: /dcMailSendToRevisor|dcMailSendAgain/ })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("a demo day keeps its own line, not the identity one", async () => {
    closes = [close("D1", "2026-10-06", "confirmed", {
      notes: "sample · demo", email_status: "sent", email_sent_to: ["login@x.dk"],
    })];
    await openHistory();
    await screen.findByTestId("dc-mail-demo-day");
    expect(screen.queryByTestId("dc-mail-identity-demo")).toBeNull();
  });

  it("with the owner's own company the send button is back", async () => {
    profile = { ...SAMPLE_CO, identity_is_demo: false, company_name: "Testcafé ApS" };
    closes = [close("R1", "2026-10-06", "confirmed", { notes: "rigtig dag", email_status: "sent", email_sent_to: ["login@x.dk"] })];
    await openHistory();
    await waitFor(() => expect(within(card("R1")).getByRole("button", { name: /dcMailSendToRevisor/ })).toBeInTheDocument());
    expect(screen.queryByTestId("dc-mail-identity-demo")).toBeNull();
  });
});

describe("the period panel under the sample company", () => {
  it("names it, and Send neither confirms nor posts nor opens the owner's mail", async () => {
    closes = [close("R1", "2026-10-06", "confirmed", { notes: "rigtig dag", email_status: "sent", email_sent_to: ["login@x.dk"] })];
    await openHistory();
    const notice = await screen.findByTestId("dc-identity-demo");
    expect(notice).toHaveTextContent("identityIsDemoNotice");
    expect(within(notice).getByRole("link")).toHaveAttribute("href", "/profile");
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(screen.getAllByText("identityIsDemoNotice").length).toBeGreaterThan(1));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(ownMail).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([u]) => String(u).includes("send-to-accountant"))).toBe(false);
  });

  it("a real identity's send carries a key and the server's demo_identity answer is worded", async () => {
    profile = { ...SAMPLE_CO, identity_is_demo: false };
    closes = [close("R1", "2026-10-06", "confirmed", { notes: "rigtig dag", email_status: "sent", email_sent_to: ["login@x.dk"] })];
    confirmMock.mockResolvedValue(true);
    post.mockRejectedValue({ response: { status: 409, data: { detail: { code: "demo_identity" } } } });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls.find(([u]) => String(u).includes("send-to-accountant"));
    expect(url).toContain("/daily-close/send-to-accountant");
    expect(body.key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await screen.findByText("identityIsDemoNotice");
  });
});

describe("Ryd eksempeldata asks first", () => {
  it("says what goes and what stays; Annuller clears nothing", async () => {
    render(<DemoActiveBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "demoActiveClear" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const opts = confirmMock.mock.calls[0][0];
    expect(opts.title).toBe("demoClearConfirmTitle");
    expect(opts.message).toBe("demoClearConfirmBody");
    expect(opts.destructive).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("clears only on Ryd", async () => {
    confirmMock.mockResolvedValue(true);
    render(<DemoActiveBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "demoActiveClear" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/demo/clear"));
  });
});
