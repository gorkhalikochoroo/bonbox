/**
 * Mail to the revisor waits for the owner's own confirmed e-mail (Manoj,
 * 8 Oct) — what Daily close says about it.
 *
 *   • The lock card / History line: a day whose revisor copy was held
 *     (skip "email_unverified", persisted as email_error
 *     "revisor_email_unverified") reads "Ikke sendt til revisoren — bekræft
 *     din e-mail først" with "Bekræft nu" — no Send button that would be
 *     refused. Once the owner is confirmed, the ordinary line returns
 *     ("Sent to you — not to your revisor" + Send to revisor).
 *   • "Send igen" answered 403 email_unverified: the same line, no raw error.
 *   • The period send answered 403: the same sentence, "Bekræft nu", and the
 *     owner's own mail still offered.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeEmailState } from "../utils/closeEmail";

const get = vi.fn();
const post = vi.fn();
const confirmMock = vi.fn();
const ownMail = vi.fn();
let closes = [];
let profile = {};
let rangeCounts = null;
let authUser = {};
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authUser, refreshUser: vi.fn() }),
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
const HELD = close("H1", "2026-10-06", "confirmed", {
  email_status: "sent", email_sent_to: ["login@x.dk"], email_error: "revisor_email_unverified",
  email_sent_at: "2026-10-06T21:12:00",
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
  authUser = { currency: "DKK", business_type: "restaurant", email: "login@x.dk", email_verified: false };
  profile = { accountant_email: "pia@realrevisor.dk", company_name: "Testcafé ApS" };
  closes = [HELD];
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
  post.mockResolvedValue({ data: { ok: true, sent_to: "pia@realrevisor.dk" } });
});
afterEach(() => {
  vi.useRealTimers();
});

const openHistory = async () => {
  render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await screen.findByRole("button", { name: /sendToAccountantBtn/ });
};

describe("closeEmailState — a revisor copy held for an unconfirmed owner", () => {
  const p = { accountant_email: "pia@realrevisor.dk" };
  it("is 'unverified' from the live skip or the persisted marker, while unconfirmed", () => {
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], skip: "email_unverified", profile: p, ownerConfirmed: false }).kind).toBe("unverified");
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], error: "revisor_email_unverified", profile: p, ownerConfirmed: false }).kind).toBe("unverified");
    // A 403 from Send igen on a close whose lock mail was off.
    expect(closeEmailState({ status: "skipped_preference_off", skip: "email_unverified", profile: p, ownerConfirmed: false }).kind).toBe("unverified");
  });
  it("says what happened to the owner's own copy: sent, or failed (review, 9 Oct)", () => {
    const sent = closeEmailState({ status: "sent", sentTo: ["login@x.dk"], skip: "email_unverified", profile: p, ownerConfirmed: false });
    expect(sent.kind).toBe("unverified");
    expect(sent.ownerSent).toBe(true);
    // The owner's own copy failed too: never hidden behind the held line.
    for (const status of ["send_failed", "failed_skipped", "queued_retry"]) {
      expect(closeEmailState({ status, sentTo: [], skip: "email_unverified", error: "send_error: x", profile: p, ownerConfirmed: false }).kind)
        .toBe("unverified_owner_failed");
    }
    // No owner copy was due (the lock mail was off): the held line alone, no "sent to you".
    const off = closeEmailState({ status: "skipped_preference_off", skip: "email_unverified", profile: p, ownerConfirmed: false });
    expect(off.kind).toBe("unverified");
    expect(off.ownerSent).toBe(false);
  });

  it("returns to the ordinary line once the owner is confirmed (and by default)", () => {
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], error: "revisor_email_unverified", profile: p, ownerConfirmed: true }).kind).toBe("owner_only");
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], error: "revisor_email_unverified", profile: p }).kind).toBe("owner_only");
  });
  it("never hides a send that did reach the revisor, an opt-out, or a missing revisor", () => {
    expect(closeEmailState({ status: "sent", sentTo: ["pia@realrevisor.dk"], error: "revisor_email_unverified", profile: p, ownerConfirmed: false }).kind).toBe("revisor");
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], skip: "email_unverified", profile: { ...p, accountant_opted_out: true }, ownerConfirmed: false }).kind).toBe("opted_out");
    expect(closeEmailState({ status: "sent", sentTo: ["login@x.dk"], skip: "email_unverified", profile: {}, ownerConfirmed: false }).kind).toBe("owner_only");
  });
});

describe("History", () => {
  it("an unconfirmed owner's held day says so, with Bekræft nu and no Send button", async () => {
    await openHistory();
    const line = await screen.findByTestId("dc-mail-held-unverified");
    expect(line).toHaveTextContent("dcMailHeldUnverified");
    const link = within(line).getByRole("link", { name: "verifyEmailNowCta" });
    expect(link).toHaveAttribute("href", "/verify-email?now=1");
    expect(within(line.parentElement).queryByRole("button", { name: /dcMailSendToRevisor|dcMailSendAgain/ })).toBeNull();
  });

  it("the held line says the owner's own copy went, and when", async () => {
    await openHistory();
    const line = await screen.findByTestId("dc-mail-held-unverified");
    expect(line.textContent).toMatch(/dcMailHeldUnverifiedSentYou:dcMailWhen/);
    expect(screen.queryByTestId("dc-mail-owner-copy-failed")).toBeNull();
  });

  it("a held day whose own copy failed says both, and offers no Send button", async () => {
    // The lock's own copy failed (email_error holds the send error); Send
    // igen then answers 403 email_unverified — the revisor is held.
    closes = [close("H2", "2026-10-06", "confirmed", {
      email_status: "send_failed", email_sent_to: [], email_error: "send_error: provider down",
    })];
    post.mockRejectedValueOnce({ response: { status: 403, data: { detail: { code: "email_unverified" } } } });
    await openHistory();
    fireEvent.click((await screen.findAllByRole("button", { name: /dcMailSendAgain/ }))[0]);
    const failed = await screen.findByTestId("dc-mail-owner-copy-failed");
    expect(failed).toHaveTextContent("dcMailOwnerCopyFailed:dcMailErrProvider");
    const held = screen.getByTestId("dc-mail-held-unverified");
    expect(held).toHaveTextContent("dcMailHeldUnverified");
    expect(held.textContent).not.toMatch(/dcMailHeldUnverifiedSentYou/);
    expect(within(held).getByRole("link", { name: "verifyEmailNowCta" })).toHaveAttribute("href", "/verify-email?now=1");
    expect(within(held.parentElement.parentElement).queryByRole("button", { name: /dcMailSendToRevisor|dcMailSendAgain/ })).toBeNull();
  });

  it("once confirmed, the same day offers Send to revisor", async () => {
    authUser = { ...authUser, email_verified: true };
    await openHistory();
    expect(await screen.findByText(/dcMailOwnerOnly:/)).toBeInTheDocument();
    expect(screen.queryByTestId("dc-mail-held-unverified")).toBeNull();
    expect(screen.getAllByRole("button", { name: /dcMailSendToRevisor/ }).length).toBeGreaterThan(0);
  });

  it("'Send to revisor' answered 403 email_unverified shows the held line, not a raw error", async () => {
    // A team login (or a stale session) can look confirmed: the server's
    // answer wins.
    authUser = { ...authUser, email_verified: true };
    post.mockRejectedValueOnce({ response: { status: 403, data: { detail: {
      code: "email_unverified", message: "Not sent to your revisor — confirm your e-mail first (Profile → Unverified).",
    } } } });
    await openHistory();
    fireEvent.click((await screen.findAllByRole("button", { name: /dcMailSendToRevisor/ }))[0]);
    const line = await screen.findByTestId("dc-mail-held-unverified");
    expect(within(line).getByRole("link", { name: "verifyEmailNowCta" })).toHaveAttribute("href", "/verify-email?now=1");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(post.mock.calls[0][0]).toBe("/daily-close/H1/resend-email");
  });
});

describe("the period send", () => {
  it("a 403 email_unverified says so, offers Bekræft nu and the owner's own mail", async () => {
    rangeCounts = { from: "2026-09-30", to: "2026-10-07", n_locked: 1, n_drafts: 0, n_demo: 0,
      locked: [{ id: "H1", date: "2026-10-06" }] };
    confirmMock.mockResolvedValue(true);
    post.mockRejectedValueOnce({ response: { status: 403, data: { detail: { code: "email_unverified" } } } });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    const link = await screen.findByTestId("dc-send-verify-now");
    expect(link).toHaveAttribute("href", "/verify-email?now=1");
    const panel = link.closest("[role='alert']");
    expect(panel).toHaveTextContent("dcMailHeldUnverified");
    expect(within(panel).getByRole("button", { name: "dcSendViaOwnMail" })).toBeInTheDocument();
  });
});

// The review step (the manual form walked through, as the tie-out test does)
// carries the recipient line under "Mail the kasserapport when you lock".
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};
const fillAndNext = (container, value) => {
  const boxes = Array.from(container.querySelectorAll('input[inputmode="decimal"]'));
  fireEvent.change(boxes[0], { target: { value } });
  tapNext();
};
const openForm = async () => {
  const { container } = render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(screen.getByText(/^stepNRevenue:/)).toBeInTheDocument());
  fillAndNext(container, "1000");
  await waitFor(() => expect(screen.getByText(/^stepNPayments:/)).toBeInTheDocument());
  fillAndNext(container, "1000");
  for (let i = 0; i < 4; i += 1) {
    if (screen.queryByText(/^stepNReview:/)) break;
    if (!tapNext()) break;
  }
  await waitFor(() => expect(screen.getByText(/^stepNReview:/)).toBeInTheDocument());
};

describe("before Lås", () => {
  it("the recipient line does not promise the revisor while the owner is unconfirmed", async () => {
    closes = [];
    await openForm();
    expect(await screen.findByText(/autoEmailToUnverified:login@x\.dk\|pia@realrevisor\.dk/)).toBeInTheDocument();
    expect(screen.queryByText(/autoEmailToBoth/)).toBeNull();
  });

  it("a confirmed owner still reads 'to you and your revisor'", async () => {
    closes = [];
    authUser = { ...authUser, email_verified: true };
    await openForm();
    expect(await screen.findByText(/autoEmailToBoth:login@x\.dk\|pia@realrevisor\.dk/)).toBeInTheDocument();
    expect(screen.queryByText(/autoEmailToUnverified/)).toBeNull();
  });
});
