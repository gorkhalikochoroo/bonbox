/**
 * "Udgiv denne uge?" promised every owner "Medarbejdere med ændrede vagter får
 * en e-mail (og en push, …)". Three facts decide what is actually true, and
 * the sheet now says only that:
 *
 *   1. Held mail. An owner whose own e-mail is unconfirmed, or whose
 *      "Har du selv oprettet denne konto?" question is open, sends staff no
 *      e-mail (backend services/staff_mail_guard -> held_sender_reason). A held
 *      mail is DROPPED, never sent later — so the sheet must not read as "the
 *      e-mails go once you confirm". Read from a fresh /auth/me at open.
 *   2. The push. It only goes when the owner's plan has
 *      `schedule_publish_push` (notification_service skips it otherwise; on
 *      Free staff cannot even subscribe). Read from a fresh
 *      /billing/entitlements at open, else the app's copy, else not promised.
 *   3. Anyone to mail. The server only reports a hold "when someone could have
 *      been mailed" (publish_week: mail_held). With nobody's e-mail on file no
 *      e-mail goes either way, and "Bekræft nu" would fix nothing.
 *
 * Real Danish (and English / Turkish) catalogue; api mocked per URL (same
 * harness as StaffSchedulePage.staffMailHeld).
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
// The app's copy of the plan (the useEntitlements hook).
const PUSH_FEATURES = { schedule_publish_push: true };
const FREE_FEATURES = { schedule_publish_push: false };
let entHook;
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => entHook,
}));
vi.mock("../hooks/useDeviceShare", () => ({
  useDeviceShare: () => ({ ready: true, enabled: false, hasPin: false, locked: false }),
}));

const api = (await import("../services/api")).default;
const { default: StaffSchedulePage } = await import("../pages/StaffSchedulePage");
const { LanguageProvider } = await import("../hooks/useLanguage");

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = iso(new Date());

// Bo holds this week's only draft, so Bo is who the publish would tell.
const ANNA = { id: "a", name: "Anna", role: "server", active: true, contract_type: "full", base_rate: 180, email: "anna@cafe.dk" };
const BO_MAIL = { id: "b", name: "Bo", role: "bar", active: true, contract_type: "part", base_rate: 160, email: "bo@cafe.dk" };
const BO_PHONE = { ...BO_MAIL, email: null, phone: "+4512345678" };
const BO_NOTHING = { ...BO_MAIL, email: null, phone: null };
const SHIFTS = [
  { id: "s1", staff_id: "a", date: TODAY, start_time: "17:00", end_time: "23:30", break_minutes: 45, status: "published" },
  { id: "s2", staff_id: "b", date: TODAY, start_time: "10:00", end_time: "16:00", break_minutes: 0, status: "draft" },
];

let staffRows;
// What GET /billing/entitlements answers at open: a payload, or FAIL.
const FAIL = Symbol("fail");
let entFresh;

function routeGet(url) {
  const u = String(url);
  if (u.includes("/billing/entitlements")) {
    return entFresh === FAIL ? Promise.reject({ response: { status: 503 } }) : Promise.resolve({ data: entFresh });
  }
  if (u.includes("/staff/members")) return Promise.resolve({ data: staffRows });
  if (u.includes("/staff/schedules/week-cost")) return Promise.reject({ response: { status: 404 } });
  if (u.includes("/staff/schedules/week-load")) return Promise.resolve({ data: { staff: [] } });
  if (u.includes("/staff/schedules/forecast")) return Promise.reject({ response: { status: 402 } });
  if (u.endsWith("/staff/schedules")) return Promise.resolve({ data: SHIFTS });
  if (u.includes("/staff/availability")) return Promise.resolve({ data: { availability: [] } });
  if (u.includes("/staff/absences")) return Promise.resolve({ data: [] });
  if (u.includes("/staff/chat/unread")) return Promise.resolve({ data: { unread: 0 } });
  return Promise.resolve({ data: [] });
}

const DA = {
  today: "Medarbejdere med ændrede vagter får en e-mail (og en push, hvis de har åbnet deres portal).",
  todayNoPush: "Medarbejdere med ændrede vagter får en e-mail.",
  heldUnverified:
    "Medarbejdere med ændrede vagter får besked i appen (og en push, hvis de har åbnet deres portal). BonBox sender ingen e-mails til personalet, før din egen e-mail er bekræftet.",
  heldUnverifiedNoPush:
    "Medarbejdere med ændrede vagter får besked i appen. BonBox sender ingen e-mails til personalet, før din egen e-mail er bekræftet.",
  heldClaim:
    "Medarbejdere med ændrede vagter får besked i appen (og en push, hvis de har åbnet deres portal). BonBox sender ingen e-mails til personalet, før du har svaret på spørgsmålet, vi har mailet dig: Har du selv oprettet denne konto?",
  heldClaimNoPush:
    "Medarbejdere med ændrede vagter får besked i appen. BonBox sender ingen e-mails til personalet, før du har svaret på spørgsmålet, vi har mailet dig: Har du selv oprettet denne konto?",
  noEmail:
    "Medarbejdere med ændrede vagter får besked i appen (og en push, hvis de har åbnet deres portal). Ingen af dem har en e-mail registreret, så der sendes ingen e-mails.",
  noEmailNoPush:
    "Medarbejdere med ændrede vagter får besked i appen. Ingen af dem har en e-mail registreret, så der sendes ingen e-mails.",
  nobody:
    "Ingen af disse medarbejdere har e-mail eller telefon registreret — kun dem, der har åbnet deres portal, får en push. Del deres portallinks, når du har udgivet.",
  nobodyNoPush:
    "Ingen af disse medarbejdere har e-mail eller telefon registreret — de ser kun ændringen i deres portal. Del deres portallinks, når du har udgivet.",
};

const ME = {
  confirmed: { ...OWNER, email_verified: true, claim_question_open: false },
  unverified: { ...OWNER, email_verified: false, claim_question_open: false },
  claim: { ...OWNER, email_verified: true, claim_question_open: true },
};
const PLAN = {
  push: { user_id: 1, plan: "starter", features: PUSH_FEATURES },
  free: { user_id: 1, plan: "free", features: FREE_FEATURES },
};

beforeEach(() => {
  authUser = OWNER;
  staffRows = [ANNA, BO_MAIL];
  entFresh = PLAN.free;
  entHook = { isAtCap: () => false, cap: () => 25, isReady: true, plan: "free", data: { features: FREE_FEATURES } };
  refreshUser.mockReset();
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(routeGet);
  api.post.mockImplementation(() => Promise.resolve({ data: {} }));
  localStorage.setItem("lang", "da");
});

const TIME = { da: "17.00–23.30", en: /17:00/, tr: /17[.:]00/ };
const PUBLISH_TITLE = { da: "Udgiv ugen", en: "Publish week" };
const SHEET_NAME = { da: "Udgiv denne uge?", en: "Publish this week?", tr: "Bu hafta yayınlansın mı?" };

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
  await screen.findAllByText(TIME[lang], {}, { timeout: 8000 });
  const publishBtn = PUBLISH_TITLE[lang]
    ? screen.getByTitle(PUBLISH_TITLE[lang])
    : screen.getByTitle((title, el) => el?.tagName === "BUTTON" && /yayınla/i.test(title || ""));
  await act(async () => {
    fireEvent.click(publishBtn);
  });
  return screen.findByRole("dialog", { name: SHEET_NAME[lang] });
}

const noteIn = (sheet) => within(sheet).getByTestId("publish-notify-note");

// Every state: plan with/without push × held or not × staff with/without e-mail.
const MATRIX = [
  // [plan, me, Bo, expected sentence, the one tap]
  ["push", "confirmed", BO_MAIL, DA.today, null],
  ["free", "confirmed", BO_MAIL, DA.todayNoPush, null],
  ["push", "unverified", BO_MAIL, DA.heldUnverified, "verify"],
  ["free", "unverified", BO_MAIL, DA.heldUnverifiedNoPush, "verify"],
  ["push", "claim", BO_MAIL, DA.heldClaim, "claim"],
  ["free", "claim", BO_MAIL, DA.heldClaimNoPush, "claim"],
  ["push", "confirmed", BO_PHONE, DA.noEmail, null],
  ["free", "confirmed", BO_PHONE, DA.noEmailNoPush, null],
  ["push", "unverified", BO_PHONE, DA.noEmail, null],
  ["free", "unverified", BO_PHONE, DA.noEmailNoPush, null],
  ["push", "claim", BO_PHONE, DA.noEmail, null],
  ["free", "claim", BO_PHONE, DA.noEmailNoPush, null],
];

describe("Udgiv denne uge? — every state says only what the publish will do", () => {
  it.each(MATRIX)(
    "plan=%s, owner=%s, Bo=%o → the true sentence",
    async (plan, me, bo, expected, tap) => {
      entFresh = PLAN[plan];
      staffRows = [ANNA, bo];
      const note = noteIn(await openSheet(ME[me]));
      const verify = within(note).queryByRole("link", { name: "Bekræft nu" });
      const resend = within(note).queryByRole("button", { name: "Send spørgsmålet igen" });
      if (tap === null) {
        // Nothing to release: the sentence stands alone.
        expect(note.textContent).toBe(expected);
        expect(verify).toBeNull();
        expect(resend).toBeNull();
      } else {
        expect(note.textContent.startsWith(`${expected} `)).toBe(true);
        if (tap === "verify") {
          expect(verify.getAttribute("href")).toBe("/verify-email?now=1");
          expect(resend).toBeNull();
        } else {
          expect(resend).toBeInTheDocument();
          expect(verify).toBeNull();
        }
      }
      // Never "the e-mails go out later": a held mail is dropped, not queued.
      expect(note.textContent).not.toMatch(/sendes først|går først/);
      // A push is only named on a plan that sends one.
      if (plan === "free") expect(note.textContent).not.toMatch(/push/i);
      else expect(note.textContent).toContain("push");
      // No e-mail on file → no e-mail promised.
      if (bo === BO_PHONE) expect(note.textContent).not.toContain("får en e-mail");
    },
    15000,
  );

  it("asks the server for both the sender status and the plan when the sheet opens", async () => {
    const note = noteIn(await openSheet(ME.confirmed));
    expect(note.textContent).toBe(DA.todayNoPush);
    expect(refreshUser).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls.filter(([u]) => String(u).includes("/billing/entitlements"))).toHaveLength(1);
  }, 15000);
});

describe("where the push answer comes from", () => {
  it("a trial that ran out while the page was open: the server's Free wins over the app's copy", async () => {
    entHook = { ...entHook, plan: "trial", data: { features: PUSH_FEATURES } };
    entFresh = PLAN.free;
    const note = noteIn(await openSheet(ME.confirmed));
    expect(note.textContent).toBe(DA.todayNoPush);
  }, 15000);

  it("a failed plan read falls back to the app's copy (push plan)", async () => {
    entHook = { ...entHook, plan: "starter", data: { features: PUSH_FEATURES } };
    entFresh = FAIL;
    const note = noteIn(await openSheet(ME.confirmed));
    expect(note.textContent).toBe(DA.today);
  }, 15000);

  it("a failed plan read with no copy yet promises no push", async () => {
    entHook = { ...entHook, isReady: false, data: null };
    entFresh = FAIL;
    const note = noteIn(await openSheet(ME.unverified));
    expect(note.textContent.startsWith(`${DA.heldUnverifiedNoPush} `)).toBe(true);
  }, 15000);

  it("a payload stamped for another account is not used", async () => {
    entFresh = { user_id: 999, plan: "pro", features: PUSH_FEATURES };
    const note = noteIn(await openSheet(ME.confirmed));
    expect(note.textContent).toBe(DA.todayNoPush);
  }, 15000);

  it("an older server (no user_id stamp) is still read", async () => {
    entFresh = { plan: "pro", features: PUSH_FEATURES };
    const note = noteIn(await openSheet(ME.confirmed));
    expect(note.textContent).toBe(DA.today);
  }, 15000);
});

describe("nobody can be reached at all (no e-mail, no phone)", () => {
  it("Free: no push promised in the amber box, and no notify note", async () => {
    staffRows = [ANNA, BO_NOTHING];
    const sheet = await openSheet(ME.unverified);
    expect(within(sheet).getByText(DA.nobodyNoPush)).toBeInTheDocument();
    expect(within(sheet).queryByText(/får en push/)).toBeNull();
    expect(within(sheet).queryByTestId("publish-notify-note")).toBeNull();
    expect(within(sheet).queryByRole("link", { name: "Bekræft nu" })).toBeNull();
  }, 15000);

  it("a plan with push keeps today's amber sentence", async () => {
    staffRows = [ANNA, BO_NOTHING];
    entFresh = PLAN.push;
    const sheet = await openSheet(ME.confirmed);
    expect(within(sheet).getByText(DA.nobody)).toBeInTheDocument();
  }, 15000);
});

describe("the held rule follows the server's answer at open", () => {
  it("the server's answer at open wins over a stale session copy", async () => {
    // The session copy says confirmed; /auth/me now says the question is open.
    authUser = ME.confirmed;
    entFresh = PLAN.push;
    const note = noteIn(await openSheet(ME.claim));
    expect(note.textContent.startsWith(`${DA.heldClaim} `)).toBe(true);
  }, 15000);

  it("a failed refresh falls back to the session copy (held stays held)", async () => {
    authUser = ME.unverified;
    const note = noteIn(await openSheet(null));
    expect(note.textContent.startsWith(`${DA.heldUnverifiedNoPush} `)).toBe(true);
    expect(within(note).getByRole("link", { name: "Bekræft nu" })).toBeInTheDocument();
  }, 15000);

  it("an older server (neither field) reads as before", async () => {
    entFresh = PLAN.push;
    const note = noteIn(await openSheet({ ...OWNER }));
    expect(note.textContent).toBe(DA.today);
  }, 15000);
});

describe("English and Turkish", () => {
  it("English, unconfirmed, push plan: held wording + Confirm now", async () => {
    entFresh = PLAN.push;
    const note = noteIn(await openSheet(ME.unverified, { lang: "en" }));
    expect(note.textContent).toBe(
      "Staff whose shifts changed are told in the app (and by push if they've opened their portal). BonBox sends your staff no e-mails until your own e-mail is confirmed. Confirm now",
    );
    expect(within(note).getByRole("link", { name: "Confirm now" })).toBeInTheDocument();
  }, 15000);

  it("English, claim question open, Free: names the question, no push, no Confirm now", async () => {
    const note = noteIn(await openSheet(ME.claim, { lang: "en" }));
    expect(
      note.textContent.startsWith(
        "Staff whose shifts changed are told in the app. BonBox sends your staff no e-mails until you've answered the question we e-mailed you: did you create this account yourself? ",
      ),
    ).toBe(true);
    expect(within(note).getByRole("button", { name: "Send the question again" })).toBeInTheDocument();
    expect(within(note).queryByRole("link", { name: "Confirm now" })).toBeNull();
  }, 15000);

  it("English, Free, confirmed: an e-mail, no push", async () => {
    const note = noteIn(await openSheet(ME.confirmed, { lang: "en" }));
    expect(note.textContent).toBe("Staff whose shifts changed get an email.");
  }, 15000);

  it("English, no e-mail on file, Free", async () => {
    staffRows = [ANNA, BO_PHONE];
    const note = noteIn(await openSheet(ME.unverified, { lang: "en" }));
    expect(note.textContent).toBe(
      "Staff whose shifts changed are told in the app. None of them has an e-mail on file, so no e-mails are sent.",
    );
  }, 15000);

  it("Turkish, unconfirmed, Free: Turkish sentence and a Turkish tap", async () => {
    const note = noteIn(await openSheet(ME.unverified, { lang: "tr" }));
    expect(note.textContent).toBe(
      "Vardiyası değişen çalışanlar uygulamada bilgilendirilir. Kendi e-postan onaylanana kadar BonBox çalışanlarına e-posta göndermez. Şimdi onayla",
    );
    expect(within(note).getByRole("link", { name: "Şimdi onayla" })).toBeInTheDocument();
  }, 15000);

  it("Turkish, claim question open: the resend tap is Turkish too", async () => {
    const note = noteIn(await openSheet(ME.claim, { lang: "tr" }));
    expect(within(note).getByRole("button", { name: "Soruyu tekrar gönder" })).toBeInTheDocument();
  }, 15000);
});
