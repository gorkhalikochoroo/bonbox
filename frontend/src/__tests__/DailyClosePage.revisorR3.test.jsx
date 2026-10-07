/**
 * Revisor artifacts, round 3 — the History export panel.
 *
 * 1. Export window honesty (plan limits unchanged): a "Forrige kvartal" preset;
 *    a range longer than the plan's window is said plainly BEFORE anything is
 *    generated, with the allowed pieces as one-tap buttons — Starter: one per
 *    month; Free: the last 7 days + each day's own kasserapport. Never a dead
 *    end, never only an upgrade wall.
 * 2. The period send counts LOCKED closes only, names the drafts left out and
 *    the owner's copy address, and is refused for a drafts-only period.
 * 3. A period send leaves a lasting record in the panel.
 * 4. History: an old close says "ikke registreret" with a way to send that one
 *    day; the unlock dialog says the revisor already holds the locked version.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
let entitled = true;
let cap = 31;
let closes = [];
let sends = [];
let profile = {};
let rangeCounts = null;
let authUser = {};
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authUser, refreshUser: vi.fn() }),
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
vi.mock("../utils/download", () => ({ saveFile: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/shareDailyCloseRange", () => ({
  sendDailyCloseRangeToAccountant: () => Promise.resolve({ ok: true, channel: "mailto" }),
}));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const close = (id, date, status = "confirmed", extra = {}) => ({
  id, date, status, revenue_total: 1000, revenue_breakdown: { food: 1000 },
  payment_breakdown: { card: 1000 }, payment_total: 1000, moms_total: 200,
  revenue_ex_moms: 800, closed_by: "Lars", email_sent_to: [], ...extra,
});

const realConfirm = window.confirm;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00"));
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  entitled = true;
  cap = 31;
  sends = [];
  rangeCounts = null;
  authUser = { currency: "DKK", business_type: "restaurant", email: "login@x.dk" };
  profile = { accountant_email: "anna@revisor.dk", company_name: "Mirabelle ApS", email: "info@mirabelle.dk" };
  closes = [
    close("S1", "2026-09-10"), close("S2", "2026-09-12"), close("S3", "2026-09-14", "draft"),
    close("O1", "2026-10-06"), close("O2", "2026-10-05", "draft"),
  ];
  window.URL.createObjectURL = () => "blob:http://localhost/x";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/business") return Promise.resolve({ data: profile });
    if (url === "/billing/me") return Promise.resolve({ data: { plan: cap < 31 ? "free" : "starter", caps: { daily_close_export_days: cap } } });
    if (url === "/daily-close/accountant-sends") return Promise.resolve({ data: sends });
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
  window.confirm = realConfirm;
});

const openHistory = async () => {
  render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await screen.findByRole("button", { name: /sendToAccountantBtn/ });
};
const exportCalls = () => get.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/daily-close/export."));

describe("the plan's export window, said before anything is generated", () => {
  it("Starter: Forrige kvartal is offered month by month, one tap each", async () => {
    cap = 31;
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePresetPrevQuarter" }));
    const notice = await screen.findByTestId("dc-over-cap");
    // 1 Jul – 30 Sep: 92 days against a 31-day window, said in plain words.
    expect(notice.textContent).toContain("dcRangeOverCapMonths:92|31|Excel");
    const pieces = within(notice).getAllByRole("button", { name: /^dcPieceMonth:/ });
    expect(pieces).toHaveLength(3);
    // The whole-period buttons cannot produce a 402 dead end.
    const panel = within(document.getElementById("dc-export-panel"));
    for (const name of ["Excel", "PDF", "CSV"]) {
      expect(panel.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: /sendToAccountantBtn/ })).toBeDisabled();
    expect(exportCalls()).toEqual([]);  // nothing generated yet
    fireEvent.click(pieces[1]);
    await waitFor(() => expect(exportCalls()).toEqual(["/daily-close/export.xlsx?from=2026-08-01&to=2026-08-31"]));
  });

  it("Free: a month is offered as the last 7 days plus each day's own kasserapport", async () => {
    cap = 7;
    entitled = false;
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePresetPrevMonth" }));
    const notice = await screen.findByTestId("dc-over-cap");
    expect(notice.textContent).toContain("dcRangeOverCapTail:30|7|Excel");
    const last7 = within(notice).getByRole("button", { name: /^dcPieceLastDays:7\|/ });
    // Each LOCKED day of September has its own one-tap kasserapport (not the draft).
    const days = within(notice).getAllByRole("button", { name: /^dcPieceDay:/ });
    expect(days).toHaveLength(2);
    fireEvent.click(last7);
    await waitFor(() => expect(exportCalls()).toEqual(["/daily-close/export.xlsx?from=2026-09-24&to=2026-09-30"]));
    fireEvent.click(days[0]);
    await waitFor(() => expect(get.mock.calls.some(([u]) => u === "/daily-close/S1/pdf")).toBe(true));
  });

  it("a range inside the window gets no notice and exports as one file", async () => {
    cap = 31;
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePresetPrevMonth" }));
    expect(screen.queryByTestId("dc-over-cap")).toBeNull();
    expect(within(document.getElementById("dc-export-panel")).getByRole("button", { name: "Excel" })).not.toBeDisabled();
  });
});

describe("the period send to the revisor", () => {
  it("counts locked closes only, names the draft left out and the copy address", async () => {
    window.confirm = vi.fn(() => false);
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    const msg = String(window.confirm.mock.calls[0][0]);
    expect(msg).toContain("dcSendConfirmBody");
    expect(msg).toContain("dcSendLockedOne");
    expect(msg).toContain("dcSendDraftLeftOne");
    // The owner's copy goes to the LOGIN — never the unverified Profile e-mail.
    expect(msg).toContain("login@x.dk");
    expect(msg).not.toContain("info@mirabelle.dk");
    expect(post).not.toHaveBeenCalled();
  });

  it("counts the range on the server, not History's 90-row cache", async () => {
    // History holds two locked September days; the quarter really has 88.
    window.confirm = vi.fn(() => false);
    rangeCounts = { from: "2026-07-01", to: "2026-09-30", n_locked: 88, n_drafts: 3,
      locked: [{ id: "S1", date: "2026-09-10" }] };
    cap = 400;
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePresetPrevQuarter" }));
    await waitFor(() => expect(get.mock.calls.some(([u, o]) => u === "/daily-close/range-counts"
      && o?.params?.from === "2026-07-01" && o?.params?.to === "2026-09-30")).toBe(true));
    expect(await screen.findByText(/dcRangeLockedAndDrafts:88\|3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    const msg = String(window.confirm.mock.calls[0][0]);
    expect(msg).toContain("dcSendLockedMany:88");
    expect(msg).toContain("dcSendDraftLeftMany:3");
  });

  it("a drafts-only period cannot be sent, and the panel says why", async () => {
    closes = [close("O2", "2026-10-05", "draft")];
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    expect(screen.getByRole("button", { name: /sendToAccountantBtn/ })).toBeDisabled();
    expect(screen.getByText("dcSendNothingLocked")).toBeInTheDocument();
  });

  it("a period send leaves a lasting record in the panel", async () => {
    sends = [{ sent_at: "2026-10-02T07:14:00", recipient: "anna@revisor.dk", format: "xlsx",
      from: "2026-09-01", to: "2026-09-30", n_closes: 26, n_drafts: 1 }];
    await openHistory();
    const rec = await screen.findByTestId("dc-recent-sends");
    expect(rec.textContent).toContain("dcRecentSendLine:");
    expect(rec.textContent).toContain("Excel|26|anna@revisor.dk");
  });
});

describe("History rows", () => {
  it("an old close says 'ikke registreret' and asks before sending that one day", async () => {
    closes = [close("O1", "2026-10-06", "confirmed", { email_status: null })];
    window.confirm = vi.fn(() => false);
    await openHistory();
    expect(await screen.findByText(/dcMailUnrecorded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dcMailSendToRevisor/ }));
    // It may already have gone: recipient and day named, nothing sent on No.
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    const msg = String(window.confirm.mock.calls[0][0]);
    expect(msg).toContain("dcMailUnrecordedConfirmBody");
    expect(msg).toContain("anna@revisor.dk");
    expect(post).not.toHaveBeenCalled();
    window.confirm = vi.fn(() => true);
    post.mockResolvedValueOnce({ data: { email_status: "sent", email_sent_to: ["anna@revisor.dk"] } });
    fireEvent.click(screen.getByRole("button", { name: /dcMailSendToRevisor/ }));
    await waitFor(() => expect(post.mock.calls.some(([u]) => u === "/daily-close/O1/resend-email")).toBe(true));
  });

  it("a demo close and a Free plan get no 'ikke registreret' and no send", async () => {
    closes = [close("D1", "2026-10-06", "confirmed", { email_status: null, notes: "Travl aften · sample · demo" })];
    await openHistory();
    expect(screen.queryByText(/dcMailUnrecorded/)).toBeNull();
    expect(screen.queryByRole("button", { name: /dcMailSendToRevisor/ })).toBeNull();
  });

  it("Free: an old close says nothing about a send BonBox never makes", async () => {
    entitled = false;
    closes = [close("O1", "2026-10-06", "confirmed", { email_status: null })];
    await openHistory();
    expect(screen.queryByText(/dcMailUnrecorded/)).toBeNull();
  });

  it("the unlock dialog says the revisor already has the locked version", async () => {
    closes = [close("O1", "2026-10-06", "confirmed", {
      email_status: "sent", email_sent_to: ["info@mirabelle.dk", "anna@revisor.dk"],
      email_sent_at: "2026-10-06T21:12:00",
    })];
    await openHistory();
    fireEvent.click(screen.getAllByRole("button", { name: /dcUnlock$/ })[0]);
    const note = await screen.findByTestId("dc-unlock-revisor-note");
    expect(note.textContent).toMatch(/^dcUnlockRevisorHas(Auto)?:anna@revisor\.dk\|/);
  });

  it("the unlock dialog never promises an automatic correction the server will skip", async () => {
    // Revisor auto-send on, but the owner's own "mail on lock" switch is off:
    // the relock mail is skipped (skipped_preference_off), so no "automatically".
    profile = { ...profile, accountant_auto_send_effective: true };
    authUser = { ...authUser, auto_email_on_close: false };
    closes = [close("O1", "2026-10-06", "confirmed", {
      email_status: "sent", email_sent_to: ["anna@revisor.dk"], email_sent_at: "2026-10-06T21:12:00",
    })];
    await openHistory();
    fireEvent.click(screen.getAllByRole("button", { name: /dcUnlock$/ })[0]);
    const note = await screen.findByTestId("dc-unlock-revisor-note");
    expect(note.textContent).toMatch(/^dcUnlockRevisorHas:/);
  });

  it("…and does promise it when every switch is on", async () => {
    profile = { ...profile, accountant_auto_send_effective: true };
    authUser = { ...authUser, auto_email_on_close: true };
    closes = [close("O1", "2026-10-06", "confirmed", {
      email_status: "sent", email_sent_to: ["anna@revisor.dk"], email_sent_at: "2026-10-06T21:12:00",
    })];
    await openHistory();
    fireEvent.click(screen.getAllByRole("button", { name: /dcUnlock$/ })[0]);
    const note = await screen.findByTestId("dc-unlock-revisor-note");
    expect(note.textContent).toMatch(/^dcUnlockRevisorHasAuto:/);
  });
});
