/**
 * Release gate R-a (9 Oct) — Team and Faktura sends.
 *
 * Item 1: while "Har du selv oprettet denne konto?" is open the server
 * refuses with 403 {code: "email_unverified", reason: "claim_question_open"}.
 * The address IS confirmed — so no "Bekræft først din e-mail" and no "Bekræft
 * nu" (it led to /verify-email, which bounced to /dashboard). The refusal
 * names the mailed question and offers "Send spørgsmålet igen".
 *
 * Item 7: a refused team invite (or resend) is said next to the button that
 * was tapped — not ~1,200 px above it at the top of the page.
 *
 * Item 4: a failed faktura send is one POST per tap (no interceptor replay —
 * five mails from one tap), then the PDF + own-mail fallback with a message
 * that says why.
 */
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), toast: vi.fn(), saveFile: vi.fn(),
  user: { id: 1, currency: "DKK", business_type: "cafe", email_verified: true, claim_question_open: true },
}));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../utils/download", () => ({ saveFile: (...a) => h.saveFile(...a) }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user, refreshUser: vi.fn() }) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true, plan: "pro" }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      return v ? `${k}:${Object.values(v).join("|")}` : k;
    },
    lang: "da", setLang: () => {}, LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: vi.fn(), useEventLog: () => ({}) }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useUndoToast", () => ({ useUndoToast: () => ({ showUndo: vi.fn(), undoToastUI: null }) }));
vi.mock("../components/RevisorSection", () => ({ default: () => null }));

const TeamPage = (await import("../pages/TeamPage")).default;
const FakturaPage = (await import("../pages/FakturaPage")).default;

const CLAIM_403 = { response: { status: 403, data: { detail: {
  code: "email_unverified", reason: "claim_question_open",
  message: "Your e-mail address is confirmed, but …", message_da: "Din e-mailadresse er bekræftet, men …",
} } } };
const UNVERIFIED_403 = { response: { status: 403, data: { detail: { code: "email_unverified", message: "x", message_da: "y" } } } };

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  h.user = { id: 1, currency: "DKK", business_type: "cafe", email_verified: true, claim_question_open: true };
});

// ─── Team ───────────────────────────────────────────────────────────────

const PENDING = { id: "p1", email: "ali@cafe.dk", role: "cashier", expired: false, days_remaining: 5 };

function teamGets() {
  h.get.mockImplementation((url) => {
    if (url === "/team/members") return Promise.resolve({ data: [{ id: "o", email: "ejer@cafe.dk", role: "owner" }] });
    if (url === "/team/permissions") return Promise.resolve({ data: { is_owner: true, role: "owner" } });
    if (url === "/billing/me") return Promise.resolve({ data: { caps: { team_users: 10 } } });
    if (url === "/team/pending-invites") return Promise.resolve({ data: [PENDING] });
    return Promise.resolve({ data: null });
  });
}

async function openInviteAndSend() {
  render(<MemoryRouter><TeamPage /></MemoryRouter>);
  fireEvent.click((await screen.findAllByText("teamInviteCta"))[0]);
  fireEvent.change(screen.getByPlaceholderText("teamFieldEmail"), { target: { value: "new@cafe.dk" } });
  const send = screen.getByRole("button", { name: "teamInviteSend" });
  await act(async () => { fireEvent.click(send); });
  return send;
}

describe("Team invite refused while the question is open", () => {
  it("says the true reason next to the button, with Send spørgsmålet igen — no Bekræft nu", async () => {
    teamGets();
    h.post.mockImplementation((url) => {
      if (url === "/team/invite") return Promise.reject(CLAIM_403);
      if (url === "/auth/claim-decision/remail") return Promise.resolve({ data: { ok: true, sent_to: "ejer@cafe.dk" } });
      return Promise.resolve({ data: {} });
    });
    const send = await openInviteAndSend();
    const issue = await screen.findByTestId("team-invite-issue");
    expect(issue).toHaveTextContent("claimOpenSendHeld");
    expect(issue).not.toHaveTextContent("sendNeedsVerifiedEmail");
    expect(within(issue).queryByRole("link", { name: "verifyEmailNowCta" })).toBeNull();
    expect(screen.queryByRole("link", { name: "verifyEmailNowCta" })).toBeNull();
    // Right under the button that was tapped (same form), not the page top.
    expect(send.parentElement.contains(issue)).toBe(true);
    // One tap asks for the question mail again; the answer is said there.
    await act(async () => { fireEvent.click(within(issue).getByTestId("claim-resend-question")); });
    expect(h.post).toHaveBeenCalledWith("/auth/claim-decision/remail", {}, { _noRetry: true });
    expect(await within(issue).findByRole("status")).toHaveTextContent("claimResent:ejer@cafe.dk");
  });

  it("the server's cooldown answer is said in the owner's language", async () => {
    teamGets();
    h.post.mockImplementation((url) => {
      if (url === "/team/invite") return Promise.reject(CLAIM_403);
      if (url === "/auth/claim-decision/remail") return Promise.reject({ response: { status: 429, data: { detail: {
        code: "claim_remail_cooldown", message: "once a day (en)", message_da: "én gang i døgnet (da)" } } } });
      return Promise.resolve({ data: {} });
    });
    await openInviteAndSend();
    const issue = await screen.findByTestId("team-invite-issue");
    await act(async () => { fireEvent.click(within(issue).getByTestId("claim-resend-question")); });
    expect(await within(issue).findByRole("status")).toHaveTextContent("én gang i døgnet (da)");
  });
});

describe("Team invite refused for an unconfirmed address (item 7)", () => {
  it("says so next to the button, with Bekræft nu there", async () => {
    h.user = { ...h.user, email_verified: false, claim_question_open: false };
    teamGets();
    h.post.mockImplementation((url) => (url === "/team/invite" ? Promise.reject(UNVERIFIED_403) : Promise.resolve({ data: {} })));
    const send = await openInviteAndSend();
    const issue = await screen.findByTestId("team-invite-issue");
    expect(send.parentElement.contains(issue)).toBe(true);
    expect(issue).toHaveTextContent("sendNeedsVerifiedEmail");
    expect(within(issue).getByRole("link", { name: "verifyEmailNowCta" })).toHaveAttribute("href", "/verify-email");
    expect(within(issue).queryByTestId("claim-resend-question")).toBeNull();
  });

  it("a refused resend is said under that pending invite's row", async () => {
    h.user = { ...h.user, email_verified: false, claim_question_open: false };
    teamGets();
    h.post.mockImplementation((url) => (url === "/team/p1/resend-invite" ? Promise.reject(UNVERIFIED_403) : Promise.resolve({ data: {} })));
    render(<MemoryRouter><TeamPage /></MemoryRouter>);
    const resend = await screen.findByRole("button", { name: "teamPendingResend" });
    await act(async () => { fireEvent.click(resend); });
    const issue = await screen.findByTestId("team-resend-issue");
    expect(issue).toHaveTextContent("sendNeedsVerifiedEmail");
    // Same row block as the button.
    expect(resend.closest(".space-y-2").contains(issue)).toBe(true);
  });
});

// ─── Faktura ────────────────────────────────────────────────────────────

const INVOICE = {
  id: "inv-1", status: "draft", customer_id: 3, fakturanummer_formatted: "2026-0007",
  issue_date: "2026-10-08", due_date: "2026-10-22", currency: "DKK", total_gross: 1250,
  customer_lang: "da", is_credit_note: false,
};
const CUSTOMER = { id: 3, name: "Hansen ApS", email: "kunde@hansen.dk", is_company: true };

function fakturaGets() {
  h.get.mockImplementation((url) => {
    const u = String(url);
    if (u === "/invoices") return Promise.resolve({ data: [INVOICE] });
    if (u === "/customers") return Promise.resolve({ data: [CUSTOMER] });
    if (u.endsWith("/pdf")) return Promise.resolve({ data: new Blob(["%PDF"]) });
    return Promise.resolve({ data: null });
  });
  h.saveFile.mockResolvedValue({ ok: true });
}

async function clickSend() {
  render(
    <MemoryRouter initialEntries={["/faktura"]}>
      <Routes><Route path="/faktura" element={<FakturaPage />} /></Routes>
    </MemoryRouter>,
  );
  const sends = await screen.findAllByText("send");
  fireEvent.click(sends[0].closest("button"));
}

const sendEmailCalls = () => h.post.mock.calls.filter(([u]) => String(u).endsWith("/send-email"));
const toasts = () => h.toast.mock.calls.map(([o]) => o);

describe("Faktura Send while the question is open (item 1)", () => {
  it("says why in true words and offers Send spørgsmålet igen — never Bekræft nu", async () => {
    fakturaGets();
    h.post.mockImplementation((url) => {
      if (String(url).endsWith("/send-email")) return Promise.reject(CLAIM_403);
      if (url === "/auth/claim-decision/remail") return Promise.resolve({ data: { ok: true, sent_to: "ejer@cafe.dk" } });
      return Promise.resolve({ data: {} });
    });
    await clickSend();
    await waitFor(() => expect(h.saveFile).toHaveBeenCalled());
    const notice = toasts().find((o) => o.message === "claimOpenInvoiceOwnMail");
    expect(notice).toBeTruthy();
    expect(notice.action.label).toBe("claimResendQuestion");
    expect(toasts().some((o) => o.message === "invoiceMailUnverifiedOwnMail" || o.action?.label === "verifyEmailNowCta")).toBe(false);
    await act(async () => notice.action.onClick());
    expect(h.post).toHaveBeenCalledWith("/auth/claim-decision/remail", {}, { _noRetry: true });
    expect(toasts().some((o) => o.message === "claimResent:ejer@cafe.dk")).toBe(true);
  });
});

describe("a failed faktura send is never retried by itself (item 4)", () => {
  it("one POST with _noRetry, then the PDF + own mail with a message that says why", async () => {
    h.user = { ...h.user, claim_question_open: false };
    fakturaGets();
    h.post.mockImplementation((url) => (String(url).endsWith("/send-email")
      ? Promise.reject({ response: { status: 503, data: { detail: { code: "email_send_failed", reason: "x" } } } })
      : Promise.resolve({ data: {} })));
    await clickSend();
    await waitFor(() => expect(h.saveFile).toHaveBeenCalled());
    expect(sendEmailCalls()).toHaveLength(1);
    expect(sendEmailCalls()[0][2]).toEqual(expect.objectContaining({ _noRetry: true }));
    expect(toasts().some((o) => o.message === "invoiceMailFailedOwnMail")).toBe(true);
  });

  it("no answer at all: says it can't tell whether it went (check your copy)", async () => {
    h.user = { ...h.user, claim_question_open: false };
    fakturaGets();
    h.post.mockImplementation((url) => (String(url).endsWith("/send-email")
      ? Promise.reject({ message: "Network Error" })
      : Promise.resolve({ data: {} })));
    await clickSend();
    await waitFor(() => expect(h.saveFile).toHaveBeenCalled());
    expect(sendEmailCalls()).toHaveLength(1);
    expect(toasts().some((o) => o.message === "invoiceMailUnknownOwnMail")).toBe(true);
  });

  it("if the PDF could not be saved, the reason never claims a saved PDF", async () => {
    h.user = { ...h.user, claim_question_open: false };
    fakturaGets();
    h.saveFile.mockResolvedValue({ ok: false });
    h.post.mockImplementation((url) => (String(url).endsWith("/send-email")
      ? Promise.reject({ response: { status: 503, data: { detail: { code: "email_send_failed" } } } })
      : Promise.resolve({ data: {} })));
    await clickSend();
    await waitFor(() => expect(toasts().some((o) => o.message === "invoicePdfSaveFailed")).toBe(true));
    expect(toasts().some((o) => o.message === "invoiceMailFailed")).toBe(true);
    expect(toasts().some((o) => o.message === "invoiceMailFailedOwnMail")).toBe(false);
  });
});
