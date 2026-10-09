/**
 * Release gate R-a (9 Oct) — Daily close lines and sends.
 *
 *   1. While "Har du selv oprettet denne konto?" is open (the address IS
 *      confirmed), a held day's lock-card / History line names the mailed
 *      question and offers "Send spørgsmålet igen" — no "Bekræft nu", no
 *      Send button; "Send igen" answered 403 with that reason says the same;
 *      the line before Lås says it too.
 *   2. The period send says what will actually happen BEFORE the send for a
 *      held account (nothing to the revisor) instead of a confirm promising
 *      "goes to {email}"; a 403 with the open question says it truly.
 *   8. The lock card names the owner when nobody typed "Lukket af" — never
 *      "Staff".
 *   9. A held day whose owner copy ALSO failed says both after a reload.
 */
import { fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
const post = vi.fn();
const confirmMock = vi.fn();
const ownMail = vi.fn();
const refreshUser = vi.fn();
let closes = [];
let profile = {};
let rangeCounts = null;
let authUser = {};
// The plan read: ready unless a test says the entitlements are still loading.
let entitlementsReady = true;
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authUser, refreshUser: (...a) => refreshUser(...a) }),
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
  useEntitlements: () => ({
    hasFeature: () => entitlementsReady, minPlanForFeature: () => null, isReady: entitlementsReady,
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
  sendDailyCloseRangeToAccountant: (...a) => ownMail(...a),
}));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const close = (id, date, status = "confirmed", extra = {}) => ({
  id, date, status, revenue_total: 1000, revenue_breakdown: { food: 1000 },
  payment_breakdown: { card: 1000 }, payment_total: 1000, moms_total: 200,
  revenue_ex_moms: 800, closed_by: "Lars", email_sent_to: [], ...extra,
});
const HELD_CLAIM = close("H1", "2026-10-06", "confirmed", {
  email_status: "sent", email_sent_to: ["login@x.dk"], email_error: "revisor_claim_question_open",
  email_sent_at: "2026-10-06T21:12:00",
});
const CLAIM_USER = { currency: "DKK", business_type: "restaurant", business_name: "Café Nora",
  email: "login@x.dk", email_verified: true, claim_question_open: true };
const CLAIM_403 = { response: { status: 403, data: { detail: {
  code: "email_unverified", reason: "claim_question_open", message: "en", message_da: "da" } } } };

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
  refreshUser.mockReset();
  refreshUser.mockResolvedValue(undefined);
  rangeCounts = null;
  entitlementsReady = true;
  authUser = { ...CLAIM_USER };
  profile = { accountant_email: "pia@realrevisor.dk", company_name: "Testcafé ApS" };
  closes = [HELD_CLAIM];
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

describe("History while the question is open (item 1)", () => {
  it("names the mailed question, offers Send spørgsmålet igen — no Bekræft nu, no Send", async () => {
    await openHistory();
    const line = await screen.findByTestId("dc-mail-held-claim-open");
    expect(line.textContent).toMatch(/dcMailHeldClaimOpenSentYou:dcMailWhen/);
    expect(within(line).queryByRole("link", { name: "verifyEmailNowCta" })).toBeNull();
    expect(screen.queryByTestId("dc-mail-held-unverified")).toBeNull();
    expect(within(line.parentElement).queryByRole("button", { name: /dcMailSendToRevisor|dcMailSendAgain/ })).toBeNull();
    post.mockResolvedValueOnce({ data: { ok: true, sent_to: "login@x.dk" } });
    await act(async () => { fireEvent.click(within(line).getByTestId("dc-mail-claim-resend")); });
    expect(post).toHaveBeenCalledWith("/auth/claim-decision/remail", {}, { _noRetry: true });
    expect(await within(line).findByRole("status")).toHaveTextContent("claimResent:login@x.dk");
  });

  it("once answered, the ordinary line returns (Send to revisor)", async () => {
    authUser = { ...CLAIM_USER, claim_question_open: false };
    await openHistory();
    expect(await screen.findByText(/dcMailOwnerOnly:/)).toBeInTheDocument();
    expect(screen.queryByTestId("dc-mail-held-claim-open")).toBeNull();
  });

  it("'Send igen' answered 403 with the open question says it truly", async () => {
    authUser = { ...CLAIM_USER, claim_question_open: false };   // a stale session copy
    closes = [close("H2", "2026-10-06", "confirmed", { email_status: "send_failed", email_sent_to: [], email_error: "send_error: x" })];
    post.mockRejectedValueOnce(CLAIM_403);
    await openHistory();
    fireEvent.click((await screen.findAllByRole("button", { name: /dcMailSendAgain/ }))[0]);
    const line = await screen.findByTestId("dc-mail-held-claim-open");
    expect(line).toHaveTextContent("dcMailHeldClaimOpen");
    expect(screen.queryByRole("link", { name: "verifyEmailNowCta" })).toBeNull();
  });
});

describe("History — held AND the owner's copy failed, after a reload (item 9)", () => {
  it("says both, from the persisted marker, with no Send button", async () => {
    authUser = { ...CLAIM_USER, email_verified: false, claim_question_open: false };
    closes = [close("H3", "2026-10-06", "confirmed", {
      email_status: "send_failed", email_sent_to: [],
      email_error: "revisor_email_unverified;email_not_configured",
    })];
    await openHistory();
    const failed = await screen.findByTestId("dc-mail-owner-copy-failed");
    expect(failed).toHaveTextContent("dcMailOwnerCopyFailed:dcMailErrNotConfigured");
    const held = screen.getByTestId("dc-mail-held-unverified");
    expect(held).toHaveTextContent("dcMailHeldUnverified");
    expect(within(held.parentElement.parentElement).queryByRole("button", { name: /dcMailSendToRevisor|dcMailSendAgain/ })).toBeNull();
  });
});

describe("the period send says what will happen before the send (item 2)", () => {
  const pickPeriod = async () => {
    rangeCounts = { from: "2026-09-30", to: "2026-10-07", n_locked: 1, n_drafts: 0, n_demo: 0,
      locked: [{ id: "H1", date: "2026-10-06" }] };
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "rangePreset7d" }));
  };
  const sendCalls = () => post.mock.calls.filter(([u]) => String(u).startsWith("/daily-close/send-to-accountant"));

  it("question open (fresh read): no 'goes to {email}' confirm, no send — the true reason + Send spørgsmålet igen", async () => {
    refreshUser.mockResolvedValue({ ...CLAIM_USER });
    await pickPeriod();
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    const resend = await screen.findByTestId("dc-send-claim-resend");
    const panel = resend.closest("[role='alert']");
    expect(panel).toHaveTextContent("dcMailHeldClaimOpen");
    expect(within(panel).getByRole("button", { name: "dcSendViaOwnMail" })).toBeInTheDocument();
    expect(within(panel).queryByTestId("dc-send-verify-now")).toBeNull();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
  });

  it("unconfirmed (fresh read): Bekræft nu and own mail, no confirm, no send", async () => {
    refreshUser.mockResolvedValue({ ...CLAIM_USER, email_verified: false, claim_question_open: false });
    await pickPeriod();
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    const link = await screen.findByTestId("dc-send-verify-now");
    expect(link.closest("[role='alert']")).toHaveTextContent("dcMailHeldUnverified");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
  });

  it("while the plan is still loading, no held line ahead of the server's order (review, 9 Oct)", async () => {
    // A Free owner's plan wall comes before "confirm" on the server; with
    // the plan unknown the page must not send the owner to confirm first.
    entitlementsReady = false;
    refreshUser.mockResolvedValue({ ...CLAIM_USER, email_verified: false, claim_question_open: false });
    await pickPeriod();
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(refreshUser).not.toHaveBeenCalled();
    expect(screen.queryByTestId("dc-send-verify-now")).toBeNull();
    expect(screen.queryByTestId("dc-send-claim-resend")).toBeNull();
  });

  it("a 403 with the open question (no fresh read) says it truly", async () => {
    authUser = { ...CLAIM_USER, claim_question_open: false };
    confirmMock.mockResolvedValue(true);
    post.mockRejectedValueOnce(CLAIM_403);
    await pickPeriod();
    fireEvent.click(screen.getByRole("button", { name: /sendToAccountantBtn/ }));
    const resend = await screen.findByTestId("dc-send-claim-resend");
    expect(resend.closest("[role='alert']")).toHaveTextContent("dcMailHeldClaimOpen");
    expect(screen.queryByTestId("dc-send-verify-now")).toBeNull();
  });
});

// The review step carries the recipient line under "Mail the kasserapport when you lock".
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
const openForm = async (entry = "/daily-close") => {
  const out = render(<MemoryRouter initialEntries={[entry]}><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(screen.getByText(/^stepNRevenue:/)).toBeInTheDocument());
  fillAndNext(out.container, "1000");
  await waitFor(() => expect(screen.getByText(/^stepNPayments:/)).toBeInTheDocument());
  fillAndNext(out.container, "1000");
  for (let i = 0; i < 4; i += 1) {
    if (screen.queryByText(/^stepNReview:/)) break;
    if (!tapNext()) break;
  }
  await waitFor(() => expect(screen.getByText(/^stepNReview:/)).toBeInTheDocument());
  return out;
};

describe("before Lås, while the question is open (item 1)", () => {
  it("the recipient line names the open question, not the revisor", async () => {
    closes = [];
    await openForm();
    expect(await screen.findByText(/autoEmailToClaimOpen:login@x\.dk\|pia@realrevisor\.dk/)).toBeInTheDocument();
    expect(screen.queryByText(/autoEmailToBoth/)).toBeNull();
    expect(screen.queryByText(/autoEmailToUnverified/)).toBeNull();
  });
});

describe("the lock card names who locked it (item 8)", () => {
  it("no 'Lukket af' typed: the owner's name, never 'Staff'", async () => {
    vi.useRealTimers();
    closes = [];
    authUser = { ...CLAIM_USER, claim_question_open: false };
    const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
    post.mockImplementation((url, body) => {
      if (url === "/daily-close" && body?.status === "confirmed") {
        return Promise.resolve({ data: {
          id: "c1", status: "confirmed", date: body.date, revenue_total: 1000,
          closed_by: null, closed_at: "2026-10-07T05:20:00",
          close_ritual: { email_status: "sent", sent_to: ["login@x.dk"] },
        } });
      }
      return Promise.resolve({ data: {} });
    });
    confirmMock.mockResolvedValue(true);
    await openForm(`/daily-close?date=${today}`);
    fireEvent.click(await screen.findByText("confirmAndLock"));
    // The card's title: "<key>:<time>|<who>".
    const title = await screen.findByText((_, el) => el?.tagName === "P"
      && /^\S+:\S+\|/.test(el.textContent.trim()) && /\|(Café Nora|staffShort)$/.test(el.textContent.trim()));
    expect(title.textContent.trim()).toMatch(/\|Café Nora$/);
    expect(title.textContent).not.toContain("staffShort");
  });
});
