/**
 * "Udgiv denne uge?" promised every owner "Medarbejdere med ændrede vagter får
 * en e-mail …". Since R-f an owner whose own e-mail is unconfirmed, or whose
 * "Har du selv oprettet denne konto?" question is open, sends staff no e-mail
 * (backend services/staff_mail_guard -> revisor_mail.held_sender_reason). The
 * sheet now says so BEFORE the publish, from a fresh /auth/me read, with the
 * one tap that releases the mail — and keeps today's sentence otherwise.
 *
 * Real Danish (and English) catalogue; api mocked per URL (same harness as
 * StaffSchedulePage.staffMailHeld).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const OWNER = { id: 1, role: "owner", currency: "DKK", business_type: "cafe", plan: "pro" };
let authUser = OWNER;
const refreshUser = vi.fn();
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authUser, loading: false, refreshUser }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ isAtCap: () => false, cap: () => 25, isReady: true, plan: "pro", data: {} }),
}));
vi.mock("../hooks/useDeviceShare", () => ({
  useDeviceShare: () => ({ ready: true, enabled: false, hasPin: false, locked: false }),
}));

const api = (await import("../services/api")).default;
const { default: StaffSchedulePage } = await import("../pages/StaffSchedulePage");
const { LanguageProvider } = await import("../hooks/useLanguage");

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = iso(new Date());

const STAFF = [
  { id: "a", name: "Anna", role: "server", active: true, contract_type: "full", base_rate: 180, email: "anna@cafe.dk" },
  { id: "b", name: "Bo", role: "bar", active: true, contract_type: "part", base_rate: 160, email: "bo@cafe.dk" },
];
const SHIFTS = [
  { id: "s1", staff_id: "a", date: TODAY, start_time: "17:00", end_time: "23:30", break_minutes: 45, status: "published" },
  { id: "s2", staff_id: "b", date: TODAY, start_time: "10:00", end_time: "16:00", break_minutes: 0, status: "draft" },
];

function routeGet(url) {
  const u = String(url);
  if (u.includes("/staff/members")) return Promise.resolve({ data: STAFF });
  if (u.includes("/staff/schedules/week-cost")) return Promise.reject({ response: { status: 404 } });
  if (u.includes("/staff/schedules/week-load")) return Promise.resolve({ data: { staff: [] } });
  if (u.includes("/staff/schedules/forecast")) return Promise.reject({ response: { status: 402 } });
  if (u.endsWith("/staff/schedules")) return Promise.resolve({ data: SHIFTS });
  if (u.includes("/staff/availability")) return Promise.resolve({ data: { availability: [] } });
  if (u.includes("/staff/absences")) return Promise.resolve({ data: [] });
  if (u.includes("/staff/chat/unread")) return Promise.resolve({ data: { unread: 0 } });
  return Promise.resolve({ data: [] });
}

const DA_TODAY = "Medarbejdere med ændrede vagter får en e-mail (og en push, hvis de har åbnet deres portal).";
const DA_HELD_UNVERIFIED =
  "Dit personale får besked i appen (og en push, hvis de har åbnet deres portal). E-mails sendes først, når din egen e-mail er bekræftet.";
const DA_HELD_CLAIM =
  "Dit personale får besked i appen (og en push, hvis de har åbnet deres portal). E-mails sendes først, når du har svaret på spørgsmålet, vi har mailet dig: Har du selv oprettet denne konto?";

beforeEach(() => {
  authUser = OWNER;
  refreshUser.mockReset();
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(routeGet);
  api.post.mockImplementation(() => Promise.resolve({ data: {} }));
  localStorage.setItem("lang", "da");
});

/** Open "Udgiv denne uge?" with /auth/me answering `me` (null = the refresh failed). */
async function openSheet(me, { lang = "da" } = {}) {
  localStorage.setItem("lang", lang);
  refreshUser.mockResolvedValue(me);
  await act(async () => {
    render(
      <MemoryRouter>
        <LanguageProvider>
          <StaffSchedulePage />
        </LanguageProvider>
      </MemoryRouter>,
    );
  });
  await screen.findAllByText(lang === "da" ? "17.00–23.30" : /17:00/, {}, { timeout: 8000 });
  await act(async () => {
    fireEvent.click(screen.getByTitle(lang === "da" ? "Udgiv ugen" : "Publish week"));
  });
  const sheet = await screen.findByRole("dialog", { name: lang === "da" ? "Udgiv denne uge?" : "Publish this week?" });
  return within(sheet).getByTestId("publish-notify-note");
}

describe("Udgiv denne uge? — the e-mail promise matches the server's held rule", () => {
  it("a confirmed sender keeps today's sentence, no Bekræft nu", async () => {
    const note = await openSheet({ ...OWNER, email_verified: true, claim_question_open: false });
    expect(note.textContent).toBe(DA_TODAY);
    expect(within(note).queryByRole("link", { name: "Bekræft nu" })).toBeNull();
    expect(within(note).queryByRole("button", { name: "Send spørgsmålet igen" })).toBeNull();
    // Asked of the server at the moment the sheet opens.
    expect(refreshUser).toHaveBeenCalledTimes(1);
  });

  it("an unconfirmed owner: no e-mail promised, held wording + Bekræft nu", async () => {
    const note = await openSheet({ ...OWNER, email_verified: false, claim_question_open: false });
    expect(note.textContent).toContain(DA_HELD_UNVERIFIED);
    expect(note.textContent).not.toContain("får en e-mail");
    const cta = within(note).getByRole("link", { name: "Bekræft nu" });
    expect(cta.getAttribute("href")).toBe("/verify-email?now=1");
    expect(within(note).queryByRole("button", { name: "Send spørgsmålet igen" })).toBeNull();
  });

  it("an open 'did you create it?' question: names it, Send spørgsmålet igen, never Bekræft nu", async () => {
    const note = await openSheet({ ...OWNER, email_verified: true, claim_question_open: true });
    expect(note.textContent).toContain(DA_HELD_CLAIM);
    expect(note.textContent).not.toContain("din egen e-mail er bekræftet");
    expect(within(note).getByRole("button", { name: "Send spørgsmålet igen" })).toBeInTheDocument();
    expect(within(note).queryByRole("link", { name: "Bekræft nu" })).toBeNull();
  });

  it("the server's answer at open wins over a stale session copy", async () => {
    // The session copy says confirmed; /auth/me now says the question is open.
    authUser = { ...OWNER, email_verified: true, claim_question_open: false };
    const note = await openSheet({ ...OWNER, email_verified: true, claim_question_open: true });
    expect(note.textContent).toContain(DA_HELD_CLAIM);
  });

  it("a failed refresh falls back to the session copy (held stays held)", async () => {
    authUser = { ...OWNER, email_verified: false, claim_question_open: false };
    const note = await openSheet(null);
    expect(note.textContent).toContain(DA_HELD_UNVERIFIED);
    expect(within(note).getByRole("link", { name: "Bekræft nu" })).toBeInTheDocument();
  });

  it("an older server (neither field) reads as before", async () => {
    const note = await openSheet({ ...OWNER });
    expect(note.textContent).toBe(DA_TODAY);
  });

  it("English, unconfirmed: held wording + Confirm now", async () => {
    const held = await openSheet({ ...OWNER, email_verified: false, claim_question_open: false }, { lang: "en" });
    expect(held.textContent).toContain(
      "Your staff are told in the app (and by push if they've opened their portal). E-mails go out only once your own e-mail is confirmed.",
    );
    expect(within(held).getByRole("link", { name: "Confirm now" })).toBeInTheDocument();
  });

  it("English, claim question open: names the question, no Confirm now", async () => {
    const held = await openSheet({ ...OWNER, email_verified: true, claim_question_open: true }, { lang: "en" });
    expect(held.textContent).toContain(
      "Your staff are told in the app (and by push if they've opened their portal). E-mails go out only once you've answered the question we e-mailed you: did you create this account yourself?",
    );
    expect(within(held).queryByRole("link", { name: "Confirm now" })).toBeNull();
  });
});
