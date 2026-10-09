/**
 * Release gate R-a (9 Oct) — Profile and Team → Revisor.
 *
 *   2. Profile → Revisor: the auto-send text promised the kasserapport "the
 *      moment the day is locked" to an owner whose revisor mail is held. It
 *      now says what happens: only the owner's own copy goes, until the
 *      e-mail is confirmed / the mailed question is answered.
 *   5. "Send a test now" (Daily Brief): the server's ceiling / unconfirmed
 *      refusal is said in the owner's language, not a bare "Couldn't send".
 *   1. Team → Revisor: an invite held while "Har du selv oprettet denne
 *      konto?" is open names the mailed question and offers "Send
 *      spørgsmålet igen" — never "Bekræft nu", never a "Send invitation"
 *      the server would hold again.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), me: {}, grants: [] }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.me, refreshUser: vi.fn() }) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true, plan: "pro" }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => {
      let s = typeof fb === "string" ? fb : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
      return s;
    },
    lang: "da", setLang: () => {}, LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/usePushNotifications", () => ({
  default: () => ({ permission: "default", supported: false, subscribed: false, busy: false,
    subscribe: vi.fn(), unsubscribe: vi.fn(), sendTest: vi.fn() }),
}));
vi.mock("../components/OperatingProfileSection", () => ({ default: () => null }));
vi.mock("../components/SmartStaffingCard", () => ({ default: () => null }));
vi.mock("../components/DeviceShareSettingsCard", () => ({ default: () => null }));
vi.mock("../components/BusinessLookup", () => ({ default: () => null, countryFromCurrency: () => "DK" }));

const ProfilePage = (await import("../pages/ProfilePage")).default;
const RevisorSection = (await import("../components/RevisorSection")).default;

const BASE_ME = { id: "u1", email: "ejer@cafe.dk", business_name: "Café Nora", business_type: "cafe",
  currency: "DKK", role: "owner", email_verified: true, claim_question_open: false };

function profileGets() {
  h.get.mockImplementation((url) => {
    if (url === "/auth/me") return Promise.resolve({ data: h.me });
    if (url === "/business") return Promise.resolve({ data: { accountant_email: "pia@realrevisor.dk", accountant_name: "Pia", accountant_auto_send: true } });
    if (url === "/email/preferences") return Promise.resolve({ data: { daily_digest_enabled: false, expense_alerts_enabled: true, daily_brief_email_enabled: true } });
    if (url === "/accountants/grants") return Promise.resolve({ data: h.grants });
    if (url === "/billing/usage") return Promise.resolve({ data: { meters: [] } });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset();
  h.me = { ...BASE_ME };
  h.grants = [];
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class {
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
  }
});

const renderProfile = async () => {
  profileGets();
  render(<MemoryRouter><ProfilePage /></MemoryRouter>);
  await screen.findByText(/Send the kasserapport to my revisor automatically/);
};

describe("Profile → Revisor auto-send says what will happen (item 2)", () => {
  it("unconfirmed: only the owner's own copy goes", async () => {
    h.me = { ...BASE_ME, email_verified: false };
    await renderProfile();
    expect(await screen.findByTestId("accountant-auto-send-held")).toHaveTextContent(
      "Right now your revisor gets nothing: your e-mail isn't confirmed yet, so only your own copy goes when a day is locked.");
  });
  it("question open: the mailed question is named", async () => {
    h.me = { ...BASE_ME, claim_question_open: true };
    await renderProfile();
    expect(await screen.findByTestId("accountant-auto-send-held")).toHaveTextContent(
      "BonBox is waiting for your answer to the question we e-mailed you, so only your own copy goes");
  });
  it("a sending account reads as before", async () => {
    await renderProfile();
    await waitFor(() => expect(screen.getAllByText(/the moment the day is locked/).length).toBeGreaterThan(0));
    expect(screen.queryByTestId("accountant-auto-send-held")).toBeNull();
  });
});

describe("Daily Brief 'Send a test now' says the server's reason (item 5)", () => {
  it("the ceiling's words, in Danish — not a bare 'Couldn't send'", async () => {
    h.post.mockImplementation((url) => (url === "/dashboard/daily-brief/send-now"
      ? Promise.reject({ response: { status: 429, data: { detail: {
        code: "self_test_mail_cooldown", message: "One test mail every 10 minutes (en)",
        message_da: "BonBox sender én testmail hvert 10. minut. Prøv igen om 7 minutter." } } } })
      : Promise.resolve({ data: {} })));
    await renderProfile();
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "sendTestNow" })); });
    expect(await screen.findByText("BonBox sender én testmail hvert 10. minut. Prøv igen om 7 minutter.")).toBeInTheDocument();
    expect(screen.queryByText("briefSendFailedToast")).toBeNull();
  });
});

describe("Team → Revisor while the question is open (item 1)", () => {
  it("the held invite names the question and offers Send spørgsmålet igen — no Bekræft nu", async () => {
    h.me = { ...BASE_ME, claim_question_open: true };
    profileGets();
    h.post.mockImplementation((url) => (url === "/accountants/invite"
      ? Promise.resolve({ data: { id: "g1", status: "pending", accept_url: "https://bonbox.dk/accept-invite/t",
        // The real wire shape (accountants.invite_accountant): the reason
        // stays "email_unverified", held_reason names the open question.
        email_sent: false, email_not_sent_reason: "email_unverified", held_reason: "claim_question_open",
        mail_held: "email_unverified" } })
      : Promise.resolve({ data: { ok: true, sent_to: "ejer@cafe.dk" } })));
    render(<MemoryRouter><RevisorSection /></MemoryRouter>);
    await act(async () => {});
    fireEvent.change(screen.getByPlaceholderText("anna@revisor.dk"), { target: { value: "anna@revisor.dk" } });
    await act(async () => { fireEvent.click(screen.getByText("Send invite")); });
    const held = await screen.findByTestId("revisor-invite-held");
    expect(held).toHaveTextContent("BonBox is waiting for your answer to the question we e-mailed you");
    expect(screen.queryByRole("link", { name: "Confirm now" })).toBeNull();
    expect(screen.getByTestId("revisor-invite-claim-resend")).toBeInTheDocument();
  });

  it("a held row offers Send spørgsmålet igen, not Send invitation or Bekræft nu", async () => {
    h.me = { ...BASE_ME, claim_question_open: true };
    h.grants = [{ id: "g1", accountant_email: "anna@revisor.dk", accountant_name: "Anna", status: "pending",
      invited_at: "2026-10-08T10:00:00Z", mail_held: "email_unverified" }];
    profileGets();
    render(<MemoryRouter><RevisorSection /></MemoryRouter>);
    expect(await screen.findByTestId("revisor-grant-claim-resend-g1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send invitation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Confirm now" })).toBeNull();
  });
});
