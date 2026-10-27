/**
 * R11 — right table, right day, walked on screen (rubric B7, B8, B10, B11).
 *
 *   • B7: Bekræft on a group asks the server for tables ("ask"); the answer's
 *     tables are said; no fit → one sheet with what can be done (choose tables
 *     yourself, move to a time that fits and confirm, confirm without a
 *     table, not now); a confirmed booking without a table reads amber.
 *   • B8: allergies on the rows in WORDS — the level, the allergens, the note
 *     — and an octagon for severe; never colour alone.
 *   • B10: a freed table names who on the Venteliste fits, ABOVE the night;
 *     a table freed on another screen is noticed on a quiet reload.
 *   • B11: the door screen keeps its shape while it loads — the drop-in row
 *     is there from the first paint, the Venteliste waits for the book.
 *
 * Run: cd frontend && npx vitest run src/__tests__/r11.rightTable.test.jsx
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const h = vi.hoisted(() => ({
  user: null,
  confirm: vi.fn(async () => true),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: h.user, logout: vi.fn(async () => {}), loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (_k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      return String(typeof fb === "string" ? fb : _k).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));
    },
    lang: "en",
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, isReady: true }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../utils/sound", () => ({
  getSoundStatus: () => ({ ok: true }),
  subscribeSound: () => () => {},
  testSound: vi.fn(),
  playChime: vi.fn(),
  playUrgent: vi.fn(),
  playCancel: vi.fn(),
  unlockSound: vi.fn(),
  prepareSoundWhenIdle: vi.fn(() => () => {}),
}));

import api from "../services/api";
import ReservationsPage from "../pages/ReservationsPage";
import { rememberStandLayout, rememberedStandLayout } from "../services/standAuth";

const DAY = "2026-10-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const OWNER = "/reservations";
const DEVICE = "/stand/tok-door-1";

const table = (id, label, seats) => ({ id, label, capacity_seats: seats, kind: "table", is_active: true, zone: "Sal", combinable: true });
const RESOURCES = [table("t4", "Bord 4", 4), table("t5", "Bord 5", 4), table("t8", "Bord 8", 8), table("t2", "Bord 2", 2)];
const row = (over) => ({
  party_size: 2, source: "manual", allergen_tags: [], seated_at: null, completed_at: null,
  resource_id: null, combined_resource_ids: null, ...over,
});
const GROUP = row({ id: "g1", guest_name: "Selskab Nørgaard", status: "requested", source: "public",
  party_size: 8, starts_at: at("20:30"), ends_at: at("22:30"), guest_phone: "+45 12 34 56 78" });
const HANSEN = row({ id: "c1", guest_name: "Ida Hansen", status: "confirmed", resource_id: "t4",
  party_size: 4, starts_at: at("19:30"), ends_at: at("21:15") });

let BOOK = [GROUP, HANSEN];
let WAITLIST = [];
const RULES = {
  settings: { turn_time_tiers: [{ up_to: 2, minutes: 90 }, { up_to: 8, minutes: 120 }], default_duration_min: 90 },
  hours_declared: false,
};
const bookBody = () => ({ data: { date: DAY, reservations: BOOK, summary: { total: BOOK.length, covers: 12, by_status: {} }, rev: `rev-${Math.random()}` } });

function mockApi(over = {}) {
  api.get.mockImplementation((url, cfg) => {
    if (over[url]) return over[url](cfg);
    if (url === "/reservations/book") return Promise.resolve(bookBody());
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 18 } });
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: RULES });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: WAITLIST, active_count: WAITLIST.length } });
    if (url === "/reservations/changes") return Promise.resolve({ data: { server_time: "2026-10-12T17:00:00", changes: [] } });
    if (url === "/reservations/settings") return Promise.resolve({ data: { reservations_enabled: true, settings: { group_request_threshold: 8 } } });
    if (url === "/reservations/month-load") return Promise.resolve({ data: { days: [] } });
    if (url === "/reservations/waitlist/matches") return Promise.resolve({ data: { matches: [] } });
    return Promise.resolve({ data: {} });
  });
  api.patch.mockImplementation(() => Promise.resolve({ data: {} }));
  api.post.mockImplementation(() => Promise.resolve({ data: { ok: true } }));
}

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/stand/:standToken" element={<ReservationsPage />} />
        <Route path="/reservations" element={<ReservationsPage />} />
      </Routes>
    </MemoryRouter>,
  );

const http = (status, detail) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { detail } } });
const NO_FIT = {
  error: "no_table_fits", party_size: 8, at: "20:30", sitting_min: 120, largest_table: 8,
  total_seats: 18, free_seats: 6, times: ["19:00", "21:45"], hours_declared: true,
};
const statusCalls = () => api.patch.mock.calls.filter(([u]) => /\/status$/.test(u));
const toastMessages = () => h.toast.mock.calls.map(([arg]) => arg?.message || "");
const confirmButton = () => screen.getAllByRole("button", { name: "Confirm" })[0];

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at("18:00")));
  vi.clearAllMocks();
  h.user = { business_type: "restaurant", business_name: "Bistro Nørrebro" };
  h.confirm = vi.fn(async () => true);
  BOOK = [GROUP, HANSEN];
  WAITLIST = [];
  try { localStorage.clear(); } catch { /* no storage */ }
  mockApi();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── B7: a group confirmed onto tables, or told none fit ─────────────────
describe("Bekræft on a group", () => {
  it("asks the server for tables and says where they sit", async () => {
    api.patch.mockImplementation((url) => (/\/status$/.test(url)
      ? Promise.resolve({ data: { ...GROUP, status: "confirmed", resource_id: "t4", combined_resource_ids: ["t4", "t5"],
          tables_assigned: { ids: ["t4", "t5"], labels: ["Bord 4", "Bord 5"] } } })
      : Promise.resolve({ data: {} })));
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    await waitFor(() => expect(statusCalls().length).toBe(1));
    const [url, body] = statusCalls()[0];
    expect(url).toBe("/reservations/reservations/g1/status");
    expect(body).toMatchObject({ status: "confirmed", if_no_table: "ask" });
    await waitFor(() => expect(toastMessages()).toContain("Confirmed — Selskab Nørgaard has Bord 4 + Bord 5."));
    expect(screen.queryByTestId("no-table-fits")).toBeNull();
  });

  it("no table fits: one sheet says so and offers what can be done — nothing sent yet", async () => {
    api.patch.mockImplementation((url) => (/\/status$/.test(url) ? Promise.reject(http(409, NO_FIT)) : Promise.resolve({ data: {} })));
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    const sheet = await screen.findByTestId("no-table-fits");
    expect(sheet.textContent).toContain("No table fits 8 guests at 20.30");
    expect(sheet.textContent).toContain("The tables that would fit are taken then.");
    expect(sheet.textContent).toContain("Free at 20.30: 6 seats in all.");
    expect(within(sheet).getByRole("button", { name: /Choose tables yourself/ })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /Move to 19.00 and confirm/ })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /Move to 21.45 and confirm/ })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /Confirm without a table/ })).toBeTruthy();
    expect(within(sheet).getByRole("link", { name: /Call Selskab Nørgaard/ }).getAttribute("href")).toBe("tel:+4512345678");
    expect(sheet.textContent).toContain("Agree the new time with the guest first");
    // Only the one question was sent; the book was read again.
    expect(statusCalls().length).toBe(1);
    expect(toastMessages().some((m) => /Confirmed/.test(m))).toBe(false);
    // Not now closes it, sending nothing.
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByTestId("no-table-fits")).toBeNull());
    expect(statusCalls().length).toBe(1);
  });

  it("a party bigger than any table hears that, not 'taken'", async () => {
    const big = { ...NO_FIT, party_size: 12, largest_table: 8, times: [] };
    api.patch.mockImplementation((url) => (/\/status$/.test(url) ? Promise.reject(http(409, big)) : Promise.resolve({ data: {} })));
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    const sheet = await screen.findByTestId("no-table-fits");
    expect(sheet.textContent).toContain("The largest table seats 8, and no tables can be pushed together for 12.");
    expect(sheet.querySelector("[data-no-fit-times]")).toBeNull();
  });

  it("Confirm without a table says so on purpose and is told it", async () => {
    let n = 0;
    api.patch.mockImplementation((url, body) => {
      if (!/\/status$/.test(url)) return Promise.resolve({ data: {} });
      n += 1;
      if (body.if_no_table === "ask") return Promise.reject(http(409, NO_FIT));
      return Promise.resolve({ data: { ...GROUP, status: "confirmed", no_table_fits: NO_FIT } });
    });
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    const sheet = await screen.findByTestId("no-table-fits");
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: /Confirm without a table/ })); });
    await waitFor(() => expect(n).toBe(2));
    expect(statusCalls()[1][1]).toMatchObject({ status: "confirmed", if_no_table: "confirm" });
    await waitFor(() => expect(toastMessages()).toContain(
      "Selskab Nørgaard is confirmed without a table — give them tables before they arrive."));
  });

  it("Move to 21.45 and confirm: the time moves first, then the tables are picked", async () => {
    // Fix round 27 Oct (K): one request — the server moves the request and
    // picks the tables at the new time together (one mail to the guest), so
    // there is no separate PATCH of the booking any more.
    api.patch.mockImplementation((url, body) => {
      if (/\/status$/.test(url) && statusCalls().length === 1) return Promise.reject(http(409, NO_FIT));
      if (/\/status$/.test(url)) {
        return Promise.resolve({ data: { ...GROUP, status: "confirmed", starts_at: at("21:45"), resource_id: "t8",
          moved_to: at("21:45"), tables_assigned: { ids: ["t8"], labels: ["Bord 8"] } } });
      }
      return Promise.resolve({ data: body });
    });
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    const sheet = await screen.findByTestId("no-table-fits");
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: /Move to 21.45 and confirm/ })); });
    await waitFor(() => expect(statusCalls().length).toBe(2));
    const order = api.patch.mock.calls.map(([u]) => u);
    expect(order).not.toContain("/reservations/reservations/g1");
    expect(statusCalls()[1][1]).toMatchObject({ status: "confirmed", if_no_table: "ask", starts_at: at("21:45") });
    await waitFor(() => expect(toastMessages()).toContain("Moved to 21.45 and confirmed — Selskab Nørgaard has Bord 8."));
  });

  // Fix round 27 Oct (extra 3): the deploy window. An API from before the
  // one-request move ignores starts_at and answers for the time the request
  // had (its `at` is 20:30, not 21:45): the app falls back to the old two
  // steps — move, then confirm — once, and says it moved.
  it("an API that ignores the move: moves first, then confirms — once", async () => {
    api.patch.mockImplementation((url, body) => {
      if (/\/status$/.test(url) && statusCalls().length === 1) return Promise.reject(http(409, NO_FIT)); // the first Bekræft
      if (/\/status$/.test(url) && body.starts_at) return Promise.reject(http(409, NO_FIT)); // old API: at 20:30 still
      if (/\/status$/.test(url)) {
        return Promise.resolve({ data: { ...GROUP, status: "confirmed", starts_at: at("21:45"), resource_id: "t8",
          tables_assigned: { ids: ["t8"], labels: ["Bord 8"] } } });
      }
      return Promise.resolve({ data: { ...GROUP, starts_at: body.starts_at } });
    });
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    const sheet = await screen.findByTestId("no-table-fits");
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: /Move to 21.45 and confirm/ })); });
    await waitFor(() => expect(statusCalls().length).toBe(3));
    const calls = api.patch.mock.calls.map(([u, b]) => [u, b]);
    const moveAt = calls.findIndex(([u]) => u === "/reservations/reservations/g1");
    expect(moveAt).toBeGreaterThan(-1);
    expect(calls[moveAt][1]).toEqual({ starts_at: at("21:45") });
    // The move came after the ignored one-request try, before the plain confirm.
    expect(calls.findIndex(([u, b]) => /\/status$/.test(u) && b.starts_at)).toBeLessThan(moveAt);
    expect(statusCalls()[2][1]).toMatchObject({ status: "confirmed", if_no_table: "ask" });
    expect(statusCalls()[2][1].starts_at).toBeUndefined();
    await waitFor(() => expect(toastMessages()).toContain("Moved to 21.45 and confirmed — Selskab Nørgaard has Bord 8."));
    expect(screen.queryByTestId("no-table-fits")).toBeNull();
  });

  it("a new API that still finds no table at the new time: the sheet again, nothing moved", async () => {
    const atNew = { ...NO_FIT, at: "21:45", times: ["22:00"] };
    api.patch.mockImplementation((url, body) => {
      if (/\/status$/.test(url) && body.starts_at) return Promise.reject(http(409, atNew));
      if (/\/status$/.test(url)) return Promise.reject(http(409, NO_FIT));
      return Promise.resolve({ data: {} });
    });
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    const sheet = await screen.findByTestId("no-table-fits");
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: /Move to 21.45 and confirm/ })); });
    await waitFor(() => expect(statusCalls().length).toBe(2));
    expect(await screen.findByTestId("no-table-fits")).toBeTruthy();
    expect(api.patch.mock.calls.map(([u]) => u)).not.toContain("/reservations/reservations/g1");
  });

  it("Choose tables yourself opens the booking on its tables", async () => {
    api.patch.mockImplementation((url) => (/\/status$/.test(url) ? Promise.reject(http(409, NO_FIT)) : Promise.resolve({ data: {} })));
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    const sheet = await screen.findByTestId("no-table-fits");
    fireEvent.click(within(sheet).getByRole("button", { name: /Choose tables yourself/ }));
    await waitFor(() => expect(screen.queryByTestId("no-table-fits")).toBeNull());
    const drawer = await screen.findByRole("dialog", { name: /Selskab Nørgaard/ });
    expect(within(drawer).getByLabelText("Assign table")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: /Push tables together/ })).toBeTruthy();
  });

  it("a lost race for the picked tables says tap again — never the code", async () => {
    api.patch.mockImplementation((url) => (/\/status$/.test(url) ? Promise.reject(http(409, { error: "slot_unavailable" })) : Promise.resolve({ data: {} })));
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    await act(async () => { fireEvent.click(confirmButton()); });
    await screen.findByText("Those tables were taken a moment ago. Tap Confirm again.");
    expect(screen.queryByText(/slot_unavailable/)).toBeNull();
  });

  it("a salon's request is confirmed as before — no table question", async () => {
    h.user = { business_type: "salon", business_name: "Klip" };
    BOOK = [row({ id: "s1", guest_name: "Maja", status: "requested", source: "public", service_name: "Klip",
      party_size: 1, starts_at: at("14:00"), ends_at: at("14:30") })];
    renderAt(OWNER);
    await screen.findAllByText("Maja");
    await act(async () => { fireEvent.click(confirmButton()); });
    await waitFor(() => expect(statusCalls().length).toBe(1));
    expect(statusCalls()[0][1].if_no_table).toBeUndefined();
  });

  it("a confirmed booking without a table reads amber 'No table' — it needs the host", async () => {
    BOOK = [{ ...GROUP, status: "confirmed" }];
    renderAt(OWNER);
    await screen.findAllByText("Selskab Nørgaard");
    const marks = document.querySelectorAll("[data-no-table]");
    expect(marks.length).toBeGreaterThan(0);
    marks.forEach((m) => {
      expect(m.textContent).toContain("No table");
      expect(m.className).toContain("text-amber-700");
      expect(m.className).not.toContain("text-gray-700");
    });
  });
});

// ── B8: allergies in words, never colour alone ──────────────────────────
describe("allergies on the rows", () => {
  const withAllergies = () => [
    row({ id: "a1", guest_name: "Ida Mortensen", status: "confirmed", resource_id: "t4", party_size: 4,
      starts_at: at("19:00"), ends_at: at("20:45"), allergy_severity: "severe", allergen_tags: ["peanuts"],
      allergy_note: "Min søn kan ikke tåle nødder" }),
    row({ id: "a2", guest_name: "Signe Bonde", status: "confirmed", resource_id: "t5", party_size: 2,
      starts_at: at("19:30"), ends_at: at("21:00"), allergen_tags: ["gluten"] }),
    row({ id: "a3", guest_name: "Bo Holm", status: "confirmed", resource_id: "t2", party_size: 2,
      starts_at: at("20:00"), ends_at: at("21:30"), allergy_severity: "intolerance", allergen_tags: ["milk"] }),
    row({ id: "a4", guest_name: "Eva Lund", status: "confirmed", resource_id: "t8", party_size: 2,
      starts_at: at("20:15"), ends_at: at("21:45"), guest_notes: "Glutenfri tak",
      ai_allergy: { has_ai_suggested_allergy: true, ai_tags: ["gluten"] } }),
  ];

  it("says the level, the allergens and the note — on the stand", async () => {
    BOOK = withAllergies();
    h.user = null;
    renderAt(DEVICE);
    await screen.findAllByText("Ida Mortensen");
    const lines = [...document.querySelectorAll("[data-allergy-line]")];
    const byLevel = (lvl) => lines.filter((l) => l.getAttribute("data-allergy-level") === lvl).map((l) => l.textContent);
    expect(byLevel("severe")[0]).toBe("Severe · peanuts · Min søn kan ikke tåle nødder");
    // Ticked allergens with no note are on the row too (they were not on the phone row).
    expect(byLevel("allergy")[0]).toBe("Allergy · gluten");
    expect(byLevel("intolerance")[0]).toBe("Intolerance · milk");
    expect(byLevel("possible")[0]).toBe("Possible allergy · gluten");
  });

  it("a severe allergy is an octagon wherever a mark is drawn — the shape says it too", async () => {
    BOOK = withAllergies();
    renderAt(OWNER);
    await screen.findAllByText("Ida Mortensen");
    const severeIcons = document.querySelectorAll('[data-allergy-icon="severe"]');
    const otherIcons = document.querySelectorAll('[data-allergy-icon="allergy"]');
    expect(severeIcons.length).toBeGreaterThan(0);
    expect(otherIcons.length).toBeGreaterThan(0);
    // The phone row's mark names it for a screen reader, with the level.
    const named = [...document.querySelectorAll('[data-allergy-icon][role="img"]')].map((n) => n.getAttribute("aria-label"));
    expect(named).toContain("Severe allergy · peanuts · Min søn kan ikke tåle nødder");
  });

  it("a guest's link in the note is shown defanged, and the booking's own text is untouched", async () => {
    const r = row({ id: "l1", guest_name: "Link Guest", status: "confirmed", resource_id: "t4", party_size: 2,
      starts_at: at("19:00"), ends_at: at("20:30"), allergen_tags: ["nuts"], allergy_note: "se evil.com" });
    BOOK = [r];
    renderAt(OWNER);
    await screen.findAllByText("Link Guest");
    const line = document.querySelector("[data-allergy-line]");
    expect(line.textContent).toContain("evil[.]com");
    expect(r.allergy_note).toBe("se evil.com");
  });

  it("a cancelled booking's allergy is no alarm on the phone row", async () => {
    BOOK = [row({ id: "x1", guest_name: "Gone Guest", status: "cancelled", resource_id: null, party_size: 2,
      starts_at: at("19:00"), ends_at: at("20:30"), allergy_severity: "severe", allergen_tags: ["fish"] })];
    renderAt(OWNER);
    await screen.findAllByText(/Show 1 cancelled|Gone Guest/);
    const lines = [...document.querySelectorAll("[data-allergy-line]")];
    lines.forEach((l) => expect(l.className).toContain("text-gray-500"));
  });
});

// ── B10: a freed table names who waits, above the night ─────────────────
describe("the freed-table nudge", () => {
  const BO = { id: "w1", guest_name: "Bo Mikkelsen", party_size: 4, status: "waiting" };

  it("a cancel here: who fits is named over the page (moving nothing), and one tap shows the Venteliste", async () => {
    WAITLIST = [BO];
    api.patch.mockImplementation((url) => (/\/status$/.test(url)
      ? Promise.resolve({ data: { ...HANSEN, status: "cancelled", waitlist_matches: [BO] } })
      : Promise.resolve({ data: {} })));
    renderAt(OWNER);
    await screen.findAllByText("Ida Hansen");
    await waitFor(() => expect(api.get.mock.calls.some(([u]) => u === "/reservations/waitlist")).toBe(true));
    const drawerOpen = screen.getAllByText("Ida Hansen")[0];
    fireEvent.click(drawerOpen);
    const drawer = await screen.findByRole("dialog", { name: /Ida Hansen/ });
    await act(async () => { fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" })); });
    const nudge = await waitFor(() => {
      const el = document.querySelector("[data-freed-nudge]");
      expect(el).not.toBeNull();
      return el;
    });
    expect(nudge.textContent).toContain("A table may have opened");
    expect(nudge.textContent).toContain("1 on the waitlist fits");
    expect(nudge.textContent).toContain("Bo Mikkelsen");
    // Where the host looks, moving nothing: a card floating over the page
    // (fixed, in <body>), never a block pushed into the night.
    expect(nudge.parentElement).toBe(document.body);
    expect(nudge.className).toContain("fixed");
    expect(document.getElementById("rsvp-venteliste").contains(nudge)).toBe(false);
    // This screen's own cancel brought the matches — no second question.
    expect(api.get.mock.calls.filter(([u]) => u === "/reservations/waitlist/matches").length).toBe(0);
    fireEvent.click(within(nudge).getByRole("button", { name: "See the waitlist" }));
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    fireEvent.click(within(nudge).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(document.querySelector("[data-freed-nudge]")).toBeNull());
  });

  it("a table freed on ANOTHER screen is noticed on the next read, and asked about once", async () => {
    WAITLIST = [BO];
    api.get.mockImplementation((url, cfg) => {
      if (url === "/reservations/waitlist/matches") {
        expect(cfg.params).toEqual({ freed_reservation_id: "c1" });
        return Promise.resolve({ data: { matches: [BO] } });
      }
      if (url === "/reservations/book") return Promise.resolve(bookBody());
      if (url === "/reservations/resources") return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 18 } });
      if (url === "/reservations/booking-rules") return Promise.resolve({ data: RULES });
      if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: WAITLIST, active_count: WAITLIST.length } });
      if (url === "/reservations/settings") return Promise.resolve({ data: { reservations_enabled: true, settings: {} } });
      return Promise.resolve({ data: {} });
    });
    h.user = null;
    renderAt(DEVICE);
    await screen.findAllByText("Ida Hansen");
    await waitFor(() => expect(api.get.mock.calls.some(([u]) => u === "/reservations/waitlist")).toBe(true));
    // The owner cancels Ida Hansen on her phone; the door screen reloads.
    BOOK = [GROUP, { ...HANSEN, status: "cancelled" }];
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    const nudge = await waitFor(() => {
      const el = document.querySelector("[data-freed-nudge]");
      expect(el).not.toBeNull();
      return el;
    });
    expect(nudge.textContent).toContain("Bo Mikkelsen");
    const asks = () => api.get.mock.calls.filter(([u]) => u === "/reservations/waitlist/matches").length;
    expect(asks()).toBe(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    await waitFor(() => expect(api.get.mock.calls.filter(([u]) => u === "/reservations/book").length).toBeGreaterThan(2));
    expect(asks()).toBe(1);
  });

  it("nobody waiting: no question, no nudge", async () => {
    WAITLIST = [];
    h.user = null;
    renderAt(DEVICE);
    await screen.findAllByText("Ida Hansen");
    await waitFor(() => expect(api.get.mock.calls.some(([u]) => u === "/reservations/waitlist")).toBe(true));
    BOOK = [GROUP, { ...HANSEN, status: "cancelled" }];
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    await waitFor(() => expect(api.get.mock.calls.filter(([u]) => u === "/reservations/book").length).toBeGreaterThan(1));
    expect(api.get.mock.calls.filter(([u]) => u === "/reservations/waitlist/matches").length).toBe(0);
    expect(document.querySelector("[data-freed-nudge]")).toBeNull();
  });
});

// ── B11: the door screen keeps its shape while it loads ─────────────────
describe("the door screen's first paint", () => {
  it("the drop-in row and the lens switch are there before the tables answer — and stay", async () => {
    h.user = null;
    // Both the page and the book ask for the tables; hold every answer.
    const waiting = [];
    mockApi({ "/reservations/resources": () => new Promise((res) => { waiting.push(res); }) });
    renderAt(DEVICE);
    await screen.findAllByText("Ida Hansen");
    const sizes = () => [...document.querySelectorAll("[data-walkin]")];
    expect(sizes().length).toBe(6);
    sizes().forEach((b) => {
      expect(b.getAttribute("data-walkin-state")).toBe("pending");
      expect(b.disabled).toBe(true);
      expect(b.textContent).toContain("—");
    });
    expect(screen.getAllByRole("tab", { name: "Floor" }).length).toBeGreaterThan(0);
    const rowBefore = document.querySelector("[data-walkin-grid]");
    await act(async () => { waiting.forEach((res) => res({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 18 } })); });
    await waitFor(() => expect(sizes()[0].getAttribute("data-walkin-state")).not.toBe("pending"));
    expect(sizes().length).toBe(6);
    expect(document.querySelector("[data-walkin-grid]")).toBe(rowBefore);
    expect(sizes().some((b) => !b.disabled)).toBe(true);
    // Learned on this device: a table venue.
    expect(rememberedStandLayout()).toBe("table");
  });

  it("a device that learned it serves a salon draws no table chrome while loading", async () => {
    h.user = null;
    rememberStandLayout("provider");
    mockApi({ "/reservations/resources": () => new Promise(() => {}) });
    renderAt(DEVICE);
    await screen.findAllByText("Ida Hansen");
    expect(document.querySelectorAll("[data-walkin]").length).toBe(0);
  });

  it("a salon's tables answer teaches the device", async () => {
    h.user = null;
    mockApi({ "/reservations/resources": () => Promise.resolve({ data: { resources: [
      { id: "p1", label: "Mia", kind: "provider", capacity_seats: 1, is_active: true },
    ], fixtures: [] } }) });
    renderAt(DEVICE);
    await screen.findAllByText("Ida Hansen");
    await waitFor(() => expect(rememberedStandLayout()).toBe("provider"));
  });

  it("the Venteliste waits for the book's first answer, so the list never pushes it", async () => {
    h.user = null;
    let book;
    mockApi({ "/reservations/book": () => new Promise((res) => { book = res; }) });
    renderAt(DEVICE);
    const wl = await waitFor(() => {
      const el = document.getElementById("rsvp-venteliste");
      expect(el).not.toBeNull();
      return el;
    });
    expect(wl.className).toContain("hidden");
    await act(async () => { book(bookBody()); });
    await screen.findAllByText("Ida Hansen");
    expect(document.getElementById("rsvp-venteliste").className).not.toContain("hidden");
  });
});
