/**
 * SEC-1 / SEC-10 (R-f): BonBox e-mails staff only for a confirmed owner, and
 * at most 100 staff mails a day per owner / 10 per mailbox. When it holds the
 * mail, the Vagtplan page says why in the owner's language, with the one tap
 * that fixes it — "Bekræft nu" for an unconfirmed address, "Send spørgsmålet
 * igen" while "Har du selv oprettet denne konto?" is open — and names who hit
 * the daily limit. It never shows the server's English text, and never says
 * "nobody has an address" when the reason is the sender.
 *
 * Real Danish catalogue; api mocked per URL (same harness as reviewRound).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: 1, role: "owner", currency: "DKK", business_type: "cafe", plan: "pro" },
    loading: false,
  }),
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

let shifts = SHIFTS;

function routeGet(url) {
  const u = String(url);
  if (u.includes("/staff/members")) return Promise.resolve({ data: STAFF });
  if (u.includes("/staff/schedules/week-cost")) return Promise.reject({ response: { status: 404 } });
  if (u.includes("/staff/schedules/week-load")) return Promise.resolve({ data: { staff: [] } });
  if (u.includes("/staff/schedules/forecast")) return Promise.reject({ response: { status: 402 } });
  if (u.endsWith("/staff/schedules")) return Promise.resolve({ data: shifts });
  if (u.includes("/staff/availability")) return Promise.resolve({ data: { availability: [] } });
  if (u.includes("/staff/absences")) return Promise.resolve({ data: [] });
  if (u.includes("/staff/chat/unread")) return Promise.resolve({ data: { unread: 0 } });
  return Promise.resolve({ data: [] });
}

beforeEach(() => {
  shifts = SHIFTS;
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(routeGet);
  api.post.mockImplementation(() => Promise.resolve({ data: {} }));
  localStorage.setItem("lang", "da");
});

async function mountPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <LanguageProvider>
          <StaffSchedulePage />
        </LanguageProvider>
      </MemoryRouter>,
    );
  });
  await screen.findAllByText("17.00–23.30", {}, { timeout: 8000 });
}

async function publishWith(data) {
  api.post.mockImplementation((url) =>
    String(url).includes("/staff/schedules/publish")
      ? Promise.resolve({ data })
      : Promise.resolve({ data: {} }),
  );
  await mountPage();
  fireEvent.click(screen.getByTitle("Udgiv ugen"));
  const sheet = await screen.findByRole("dialog", { name: "Udgiv denne uge?" });
  await act(async () => {
    fireEvent.click(within(sheet).getByRole("button", { name: "Udgiv ugen" }));
  });
  return screen.findByRole("dialog", { name: "Ugen er udgivet" });
}

describe("staff mail held or limited (SEC-1)", () => {
  it("an unconfirmed owner: published, no mails, and Bekræft nu", async () => {
    const sheet = await publishWith({
      published: 1, notify_count: 0, skipped_no_email_names: [], mail_held: "email_unverified",
    });
    const line = within(sheet).getByTestId("publish-mail-held");
    expect(line.textContent).toContain(
      "Ingen mails sendt: BonBox mailer først dit personale, når din egen e-mail er bekræftet.",
    );
    const cta = within(line).getByRole("link", { name: "Bekræft nu" });
    expect(cta.getAttribute("href")).toBe("/verify-email?now=1");
    // Not the "nobody has an address" headline — that is a different fact.
    expect(within(sheet).queryByText(/ingen af de berørte medarbejdere/i)).toBeNull();
  });

  it("an open 'did you create it?' question: names it, offers Send spørgsmålet igen, never Bekræft nu", async () => {
    const sheet = await publishWith({
      published: 1, notify_count: 0, skipped_no_email_names: [], mail_held: "claim_question_open",
    });
    const line = within(sheet).getByTestId("publish-mail-held");
    expect(line.textContent).toContain("Har du selv oprettet denne konto?");
    expect(within(line).getByRole("button", { name: "Send spørgsmålet igen" })).toBeInTheDocument();
    expect(within(line).queryByRole("link", { name: "Bekræft nu" })).toBeNull();
  });

  it("names who was not e-mailed because of the daily limit", async () => {
    const sheet = await publishWith({
      published: 2, notify_count: 1, skipped_no_email_names: [], mail_held: null,
      skipped_mail_limit_names: ["Anna"],
    });
    expect(within(sheet).getByTestId("publish-mail-limited").textContent).toBe(
      "Ikke mailet (dagens mailgrænse er nået): Anna",
    );
    expect(within(sheet).queryByTestId("publish-mail-held")).toBeNull();
  });

  it("an older server (no mail_held field) reads as before", async () => {
    const sheet = await publishWith({ published: 1, notify_count: 1, skipped_no_email_names: [] });
    expect(within(sheet).queryByTestId("publish-mail-held")).toBeNull();
    expect(within(sheet).queryByTestId("publish-mail-limited")).toBeNull();
  });

  it("'Send ugens vagtplan' refused for an unconfirmed owner: Danish reason + Bekræft nu, not the server's English", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    // The hand-off sends published weeks only: nothing left in draft.
    shifts = SHIFTS.map((x) => ({ ...x, status: "published" }));
    api.post.mockImplementation((url) =>
      String(url).includes("/staff/schedules/email")
        ? Promise.reject({
            response: {
              status: 403,
              data: { detail: { code: "email_unverified", message: "Not sent: BonBox e-mails your staff only once…", message_da: "Ikke sendt: …" } },
            },
          })
        : Promise.resolve({ data: {} }),
    );
    await mountPage();
    fireEvent.click(screen.getAllByTitle("Vælg hvordan ugen når dine medarbejdere")[0]);
    const handoff = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(handoff).getByText("Send ugens vagtplan på mail"));
    });
    const notice = await screen.findByTestId("staff-mail-held");
    expect(notice.textContent).toContain("Ingen mails sendt: BonBox mailer først dit personale");
    expect(within(notice).getByRole("link", { name: "Bekræft nu" })).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/staff/schedules/email", expect.any(Object));
    expect(screen.queryByText(/Not sent: BonBox e-mails your staff/)).toBeNull();
    confirmSpy.mockRestore();
  });
});
