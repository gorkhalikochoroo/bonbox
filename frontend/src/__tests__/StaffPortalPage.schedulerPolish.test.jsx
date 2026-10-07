/**
 * BonBox Scheduler — round 1 polish, on the real page.
 *
 *   • Hours in ONE format per language, the owner app's ("8,5 t"), not
 *     "8 t 30 min" on Vagtplan beside "8,5 timer" on Timer.
 *   • Timer's by-week chart: "Uge 40" in Danish, and a week with no shifts
 *     keeps its (empty) column instead of vanishing.
 *   • A failed hours fetch offers "Prøv igen".
 *   • "0 gæster booket" is not shown.
 *   • The PIN gate names a way out for a forgotten PIN.
 *   • One Danish weekday style ("tor.", never "tors." / "tir").
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokpol";
const ok = (data) => Promise.resolve({ data });
const iso = (d) => d.toLocaleDateString("sv-SE");
const tomorrow = iso(new Date(Date.now() + 86400000));

let info = { has_pin: false, staff_name: "Ali R.", restaurant_name: "Testcafé", role: "kitchen" };
let shifts = [];
let covers = { shifts: [] };
let hoursImpl = () => ok({});

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) return ok(info);
  if (url.startsWith(`/portal/${TOK}/schedule`)) return ok({ shifts });
  if (url.startsWith(`/portal/${TOK}/hours`)) return hoursImpl(url);
  if (url.endsWith("/covers")) return ok(covers);
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  if (url.endsWith(`/portal/${TOK}/clock`)) return ok(clockSt);
  return ok([]);
});
let clockSt = { clocked_in: false, geofence_on: false };
const post = vi.fn((url) => {
  if (url.endsWith("/clock-in")) return ok({ clocked_in: true, geofence_on: true, since: "16:58", elapsed_sec: 0 });
  return ok({});
});

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: new Proxy({}, { get: () => () => {} }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");

function mount(lang = "da") {
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
}
const navTo = (label) => fireEvent.click(within(document.querySelector("nav")).getByText(label).closest("button"));

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  clockSt = { clocked_in: false, geofence_on: false };
  info = { has_pin: false, staff_name: "Ali R.", restaurant_name: "Testcafé", role: "kitchen" };
  shifts = [{ id: "s1", date: tomorrow, start_time: "11:00", end_time: "20:00", status: "published", net_hours: 8.5, break_minutes: 30 }];
  covers = { shifts: [{ shift_id: "s1", covers: 0 }] };
  hoursImpl = () => ok({
    period_start: "2026-10-01", period_end: "2026-10-31", total_hours: 20, hours_source: "logged",
    entries: [
      { date: "2026-10-01", start_time: "10:00", end_time: "17:30", total_hours: 7.5 },
      { date: "2026-10-08", start_time: "10:00", end_time: "17:30", total_hours: 7.5 },
      // nothing in week 42
      { date: "2026-10-22", start_time: "12:00", end_time: "17:00", total_hours: 5 },
    ],
  });
});

describe("Vagtplan hours read like the owner app", () => {
  it("'8,5 t' — never '8 t 30 min' — and the break is on the row", async () => {
    mount("da");
    await waitFor(() => expect(document.body.textContent).toContain("11:00–20:00"));
    const meta = screen.getByTestId("portal-hero-meta").textContent;
    expect(meta).toContain("9 t vagt");
    expect(meta).toContain("30 min pause");
    expect(meta).toContain("8,5 t effektiv");
    expect(document.body.textContent).not.toContain("8 t 30 min");
    expect(screen.getByTestId("portal-week-row-meta").textContent).toContain("30 min pause");
  });

  it("hides '0 gæster booket'", async () => {
    mount("da");
    await waitFor(() => expect(document.body.textContent).toContain("11:00–20:00"));
    expect(screen.queryByTestId("portal-hero-covers")).toBeNull();
    expect(document.body.textContent).not.toContain("0 gæster booket");
  });
});

describe("Timer", () => {
  it("labels weeks 'Uge NN' in Danish and keeps the empty week", async () => {
    mount("da");
    await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
    navTo("Timer");
    const bars = await screen.findAllByTestId("portal-week-bar");
    const labels = bars.map((b) => b.lastChild.textContent);
    expect(labels).toEqual(["Uge 40", "Uge 41", "Uge 42", "Uge 43", "Uge 44"]);
    expect(document.body.textContent).not.toMatch(/\bW4\d\b/);
    // Rows in the one format.
    expect(document.body.textContent).toContain("7,5 t");
    expect(document.body.textContent).not.toContain("7,5 timer");
  });

  it("English keeps 'W40' and '7.5 h'", async () => {
    mount("en");
    await waitFor(() => expect(screen.getByTitle("Edit profile")).toBeInTheDocument());
    navTo("Hours");
    const bars = await screen.findAllByTestId("portal-week-bar");
    expect(bars[0].lastChild.textContent).toBe("W40");
    expect(document.body.textContent).toContain("7.5 h");
  });

  it("a failed fetch offers 'Prøv igen', which fetches again", async () => {
    hoursImpl = () => Promise.reject(Object.assign(new Error("x"), { response: { status: 500, data: {} } }));
    mount("da");
    await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
    navTo("Timer");
    const retry = await screen.findByTestId("portal-hours-retry");
    const before = get.mock.calls.filter(([u]) => u.startsWith(`/portal/${TOK}/hours`)).length;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(get.mock.calls.filter(([u]) => u.startsWith(`/portal/${TOK}/hours`)).length).toBeGreaterThan(before),
    );
  });
});

describe("PIN gate", () => {
  it("tells a staffer who forgot the PIN who can help", async () => {
    info = { has_pin: true, pin_ok: false, staff_name: "Ali R.", restaurant_name: "Testcafé" };
    mount("da");
    expect(await screen.findByText("Glemt PIN? Bed din leder om et nyt link.")).toBeInTheDocument();
  });
});

describe("One Danish weekday style", () => {
  it("the week strip and rows use 'tor.'-style abbreviations, never ICU's 'tirs.'/'tors.'", async () => {
    mount("da");
    await waitFor(() => expect(document.body.textContent).toContain("11:00–20:00"));
    const text = document.body.textContent;
    expect(text).toContain("tir.");
    expect(text).toContain("tor.");
    expect(text).not.toMatch(/tirs\.|tors\.|\bden \d/);
  });
});

describe("Clock-in without location", () => {
  it("says the punch went in unverified instead of a plain success", async () => {
    clockSt = { clocked_in: false, geofence_on: true };
    // The shift starts now, so no "no shift right now" confirm is asked.
    const now = new Date();
    const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    shifts = [{ id: "s2", date: iso(now), start_time: hhmm(now), end_time: hhmm(new Date(now.getTime() + 3 * 3600000)), status: "published", net_hours: 3, break_minutes: 0 }];
    // jsdom has no navigator.geolocation → the fix resolves null, exactly
    // like a staffer who denied location.
    mount("da");
    const btn = await screen.findByRole("button", { name: /Stempl ind/ });
    await waitFor(() => expect(get.mock.calls.some(([u]) => u.endsWith(`/portal/${TOK}/clock`))).toBe(true));
    fireEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(await screen.findByText(/Stemplet ind uden din lokation/)).toBeInTheDocument();
  });
});
