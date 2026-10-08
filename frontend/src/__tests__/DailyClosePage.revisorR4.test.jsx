/**
 * Revisor artifacts, round 4 — demo data never mails a third party, demo days
 * stay out of the revisor's period.
 *
 * 1. A saved revisor that is the demo seeder's sample (accountant_is_demo) is
 *    never named as "your revisor", never pre-filled and never sent to: the
 *    panel says "Revisoren er eksempeldata — gem din egen …", and Send opens
 *    the owner's own mail with no recipient.
 * 2. Sample days are counted apart (range-counts n_demo): the confirm says how
 *    many are not sent, and a demo-only range cannot be sent.
 * 3. The send confirms are `irreversible` (focus on Annuller).
 * 4. One "Send" per History card: the share sheet is "Del".
 * 5. A re-lock with nothing changed reads "uændret", with Send igen kept.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeEmailState, revisorAddress } from "../utils/closeEmail";

const get = vi.fn();
const post = vi.fn();
const confirmMock = vi.fn();
const ownMail = vi.fn();
let closes = [];
let profile = {};
let rangeCounts = null;
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
  rangeCounts = null;
  profile = { accountant_email: "anna@revisor.dk", company_name: "Mirabelle ApS" };
  closes = [close("O1", "2026-10-06", "confirmed", { email_status: "sent", email_sent_to: ["login@x.dk"] })];
  window.URL.createObjectURL = () => "blob:http://localhost/x";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/business") return Promise.resolve({ data: profile });
    if (url === "/billing/me") return Promise.resolve({ data: { plan: "starter", caps: { daily_close_export_days: 31 } } });
    if (url === "/daily-close/accountant-sends") return Promise.resolve({ data: [] });
    if (url === "/daily-close/range-counts") return Promise.resolve({ data: rangeCounts || {} });
    if (String(url).startsWith("/daily-close/export.") || String(url).endsWith("/pdf")) {
      return Promise.resolve({ data: new Blob(["x"]), headers: {} });
    }
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: { ok: true, sent_to: "anna@revisor.dk" } });
});
afterEach(() => {
  vi.useRealTimers();
});

const openHistory = async () => {
  render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await screen.findByRole("button", { name: /sendToAccountantBtn/ });
};

describe("closeEmailState with a demo revisor and an unchanged re-lock", () => {
  const demo = { accountant_email: "anna@revisor.dk", accountant_is_demo: true };
  it("the sample revisor is not a saved revisor", () => {
    expect(revisorAddress(demo)).toBe("");
    expect(revisorAddress({ accountant_email: " anna@revisor.dk " })).toBe("anna@revisor.dk");
    const st = closeEmailState({ status: "sent", sentTo: ["login@x.dk"], profile: demo });
    expect(st).toMatchObject({ kind: "owner_only", acct: "", demo: true });
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], skip: "demo_recipient", profile: {} }).demo).toBe(true);
    // An old send that DID reach the address is still said honestly.
    expect(closeEmailState({ status: "sent", sentTo: ["anna@revisor.dk"], profile: demo }).kind).toBe("revisor");
  });
  it("an unchanged re-lock is 'unchanged', from the live skip or the persisted marker", () => {
    const p = { accountant_email: "anna@revisor.dk" };
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], skip: "unchanged", profile: p }).kind).toBe("unchanged");
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], error: "revisor_unchanged", profile: p }).kind).toBe("unchanged");
  });
});

describe("a demo-seeded revisor in History", () => {
  it("is said to be sample data, and Send never mails or pre-fills it", async () => {
    // What the server really returns for a seeded profile: the sample
    // revisor AND the sample company.
    profile = { ...profile, accountant_is_demo: true, identity_is_demo: true };
    await openHistory();
    expect(await screen.findByTestId("dc-revisor-demo")).toHaveTextContent("dcRevisorIsDemo");
    // Never "Send goes to anna@revisor.dk".
    expect(screen.queryByText(/dcSendToLine:anna@revisor\.dk/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(ownMail).toHaveBeenCalled());
    expect(ownMail.mock.calls[0][0].accountantEmail).toBe("");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([u]) => String(u).startsWith("/daily-close/send-to-accountant"))).toBe(false);
    // The row says so too, with the way to fix it.
    expect(await screen.findByText(/dcMailOwnerOnlyDemoRevisor/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dcRevisorIsDemoCta" })).toHaveAttribute("href", "/profile");
  });
});

describe("sample days in the period", () => {
  it("the confirm names the sample days left out, and is irreversible", async () => {
    rangeCounts = { from: "2026-09-30", to: "2026-10-07", n_locked: 1, n_drafts: 0, n_demo: 4,
      locked: [{ id: "O1", date: "2026-10-06" }] };
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    expect(await screen.findByTestId("dc-range-demo")).toHaveTextContent("dcRangeDemoMany:4");
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    const opts = confirmMock.mock.calls[0][0];
    expect(opts.irreversible).toBe(true);
    expect(opts.message).toContain("dcSendDemoLeftMany:4");
    expect(post).not.toHaveBeenCalled();
  });

  it("a demo-only period cannot be sent", async () => {
    closes = [close("D1", "2026-10-06", "confirmed", { notes: "sample · demo", email_status: null })];
    rangeCounts = { from: "2026-09-30", to: "2026-10-07", n_locked: 0, n_drafts: 0, n_demo: 1, locked: [] };
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    expect(await screen.findByTestId("dc-range-demo")).toHaveTextContent("dcRangeDemoOne");
    expect(screen.getByRole("button", { name: /sendToAccountantBtn/ })).toBeDisabled();
  });
});

describe("History card", () => {
  it("has one Send — the share sheet is 'Del'", async () => {
    await openHistory();
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: "dcShareClose" }).length).toBeGreaterThan(0);
  });

  it("an unchanged re-lock says so and keeps Send igen", async () => {
    closes = [close("O1", "2026-10-06", "confirmed", {
      email_status: "sent", email_sent_to: ["login@x.dk"], email_error: "revisor_unchanged",
      email_sent_at: "2026-10-06T21:12:00",
    })];
    await openHistory();
    const line = await screen.findByText(/dcMailUnchanged/);
    const row = line.closest("span").parentElement;
    expect(within(row).getByRole("button", { name: /dcMailSendAgain/ })).toBeInTheDocument();
  });

  it("'Send igen' over an earlier send asks with focus on Annuller", async () => {
    closes = [close("O1", "2026-10-06", "confirmed", {
      email_status: "sent", email_sent_to: ["login@x.dk"], email_error: "revisor_unchanged",
    })];
    post.mockRejectedValueOnce({ response: { status: 409, data: { detail: { code: "already_sent", sent_at: "2026-10-06T21:12:00" } } } });
    await openHistory();
    fireEvent.click(await screen.findByRole("button", { name: /dcMailSendAgain/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0].irreversible).toBe(true);
  });
});
