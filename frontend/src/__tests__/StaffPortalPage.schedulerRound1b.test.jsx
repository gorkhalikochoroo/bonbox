/**
 * BonBox Scheduler — round 1, the "see it / trust it" fixes, on the REAL page.
 *
 *   • Week paging (C2): the week view was a two-state this/next toggle while
 *     the server sends 8 weeks; "+11 mere" was inert text. Now › pages up to
 *     the last week with a published shift, "I dag" is one tap back, and every
 *     later shift row jumps to its week.
 *   • Alerts (C7/C12): the detail is formatted from ref_date/ref_start/ref_end
 *     in the app language ("ons. 25. nov. · 11:00–20:00"), and a tap opens
 *     the week the alert is about. Old rows without ref data keep their text.
 *   • Fravær (C4): an owner-declined request reads "Afvist", not the
 *     "Annulleret" of the staffer's own withdrawal.
 *   • Role (C2): no per-shift role → the staffer's own role ("Køkken"), not
 *     the generic "Personale".
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokr1b";
const ok = (data) => Promise.resolve({ data });
const iso = (d) => d.toLocaleDateString("sv-SE");
const monday = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
})();
/** A date `w` weeks after this week's Monday, plus `day` days. */
const wk = (w, day = 2) => {
  const d = new Date(monday);
  d.setDate(d.getDate() + 7 * w + day);
  return iso(d);
};
const isoWeek = (s) => {
  const d = new Date(s + "T12:00:00");
  const th = new Date(d);
  th.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(th.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((th - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
};
const shift = (date, start = "16:00", end = "22:00", extra = {}) => ({
  id: `s-${date}-${start}`, date, start_time: start, end_time: end, status: "published",
  net_hours: 6, break_minutes: 0, ...extra,
});

let shifts = [];
let notifications = [];
let absence = [];

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: "Ali R.", restaurant_name: "Testcafé", role: "kitchen" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) return ok({ shifts });
  if (url.includes("/notifications")) return ok({ notifications });
  if (url.endsWith("/absence")) return ok({ absence });
  if (url.includes("/availability")) return ok({ availability: [] });
  if (url.includes("/hours")) return ok({ period_start: wk(0, 0), period_end: wk(0, 6), total_hours: 0, entries: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  return ok([]);
});

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(() => ok({})), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: vi.fn() }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

async function mount(lang = "da") {
  localStorage.setItem("lang", lang);
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
        <Routes>
          <Route path="/portal/:token" element={<StaffPortalPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );
  await waitFor(() => expect(screen.getByTitle(lang === "da" ? "Rediger profil" : "Edit profile")).toBeInTheDocument());
}
const weekLabel = () => screen.getByTestId("portal-week-label").textContent;
const nextBtn = () => screen.getByRole("button", { name: "Næste uge" });
const prevBtn = () => screen.getByRole("button", { name: "Forrige uge" });

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  shifts = [];
  notifications = [];
  absence = [];
});

describe("Vagtplan — weeks page up to the last published shift", () => {
  it("steps forward week by week, stops at the last shift's week, and 'I dag' comes back", async () => {
    shifts = [shift(wk(0)), shift(wk(1)), shift(wk(3), "11:00", "19:00")];
    await mount("da");
    await waitFor(() => expect(weekLabel()).toBe("Denne uge"));
    await waitFor(() => expect(nextBtn()).not.toBeDisabled());
    expect(prevBtn()).toBeDisabled();

    fireEvent.click(nextBtn());
    expect(weekLabel()).toBe("Næste uge");
    fireEvent.click(nextBtn());
    expect(weekLabel()).toBe(`Uge ${isoWeek(wk(2))}`);
    expect(document.body.textContent).toContain("Ingen vagter i ugen");
    fireEvent.click(nextBtn());
    // Three weeks out: the shift's TIMES are on screen, not just a count.
    expect(weekLabel()).toBe(`Uge ${isoWeek(wk(3))}`);
    expect(document.body.textContent).toContain("11:00–19:00");
    // Last week with a published shift → › is done.
    expect(nextBtn()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Tilbage til denne uge" }));
    expect(weekLabel()).toBe("Denne uge");
  });

  it("every later shift row (and '+N mere') jumps to its week", async () => {
    shifts = [shift(wk(1)), ...[2, 3, 4, 5, 6].map((w) => shift(wk(w), "12:00", "18:00"))];
    await mount("da");
    await waitFor(() => expect(nextBtn()).not.toBeDisabled());
    fireEvent.click(nextBtn());                     // next week shows the "Kommende" list
    const later = await screen.findByTestId("portal-later-shifts");
    expect(later.textContent).toContain("+1 mere");
    const rows = within(later).getAllByRole("button");
    fireEvent.click(rows[1]);                       // the 2nd later shift: week +3
    expect(weekLabel()).toBe(`Uge ${isoWeek(wk(3))}`);
  });

  it("chevrons have a 44px hit box around the 28px visual", async () => {
    shifts = [shift(wk(0)), shift(wk(1))];
    await mount("da");
    expect(nextBtn().style.width).toBe("44px");
    expect(nextBtn().style.height).toBe("44px");
  });
});

describe("Alerts — the detail is data, in the reader's language, and opens its week", () => {
  it("formats ref_date + times in Danish and opens that week on tap", async () => {
    const target = wk(3, 2);
    shifts = [shift(wk(0)), shift(target, "11:00", "20:00")];
    notifications = [
      { id: "n1", event_type: "shift_deleted", channel: "in_app", created_at: "2026-09-30T13:53:00",
        subject: `Shift cancelled - ${target} 11:00-20:00`, ref_date: target, ref_start: "11:00", ref_end: "20:00" },
      { id: "n2", event_type: "schedule_published", channel: "in_app", created_at: "2026-09-30T13:50:00",
        subject: `Schedule updated - ${wk(3, 0)}`, ref_date: wk(3, 0) },
      // An old row the server could not read keeps its stored text.
      { id: "n3", event_type: "staff_link_shared", channel: "email", created_at: "2026-09-01T10:00:00",
        subject: "Portal link sent" },
    ];
    await mount("da");
    // The header bell (aria-label navAlerts = "Nyt").
    await waitFor(() => expect(document.body.textContent).toContain("16:00–22:00"));
    fireEvent.click(screen.getByRole("button", { name: "Nyt" }));
    const dateLabel = new Date(target + "T00:00:00").toLocaleDateString("da-DK", { weekday: "short", day: "numeric", month: "short" });
    const row = (await screen.findByText(`${dateLabel} · 11:00–20:00`)).closest("button");
    expect(document.body.textContent).toContain(`Uge ${isoWeek(wk(3))} · `);
    // The English display string never reaches a Danish screen.
    expect(document.body.textContent).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/);

    fireEvent.click(row);
    await waitFor(() => expect(weekLabel()).toBe(`Uge ${isoWeek(wk(3))}`));
    expect(document.body.textContent).toContain("11:00–20:00");
  });
});

describe("Fravær — a declined request says Afvist", () => {
  it("declined → Afvist; the staffer's own withdrawal → Annulleret", async () => {
    absence = [
      { id: "a1", kind: "ferie", date: wk(2, 0), status: "declined", reason: null },
      { id: "a2", kind: "ferie", date: wk(4, 0), status: "cancelled", reason: null },
    ];
    await mount("da");
    fireEvent.click(within(document.querySelector("nav")).getByText("Kan ikke").closest("button"));
    // Exact text = the status chips (the help line also mentions "Afvist").
    expect(await screen.findByText("Afvist", { exact: true })).toBeInTheDocument();
    expect(await screen.findByText("Annulleret", { exact: true })).toBeInTheDocument();
  });
});

describe("Hero role — the staffer's own role when the shift has none", () => {
  it("shows Køkken, not Personale", async () => {
    shifts = [shift(wk(0, 6), "11:00", "20:00", { role_on_shift: null })];
    // Make sure the shift is upcoming whatever weekday the suite runs on.
    shifts[0].date = iso(new Date(Date.now() + 86400000));
    await mount("da");
    await waitFor(() => expect(document.body.textContent).toContain("11:00–20:00"));
    expect(document.body.textContent).toContain("Køkken");
    expect(document.body.textContent).not.toContain("Personale");
  });
});
