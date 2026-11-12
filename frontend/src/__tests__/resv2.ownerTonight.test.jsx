/**
 * Reservations v2 — the owner page's evening, as the canvas draws it
 * (Reservations.dc.html): the "I dag" numbers, the live words on the rows
 * (at the table N min · N min late + the no-show word · in N min), and the
 * waitlist line that says which table seats a waiting party now.
 *
 * Every number from the book on screen; before it answers, "—".
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, within, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "restaurant", business_name: "Bistro" }, logout: vi.fn(), loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (_k, fb, vars) =>
      String(typeof fb === "string" ? fb : _k).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)),
    lang: "en",
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, isReady: true }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("../utils/sound", () => ({
  getSoundStatus: () => "off",
  subscribeSound: () => () => {},
  testSound: vi.fn(),
  playChime: vi.fn(),
  playUrgent: vi.fn(),
  unlockSound: vi.fn(),
  prepareSoundWhenIdle: vi.fn(() => () => {}),
}));

import api from "../services/api";
import ReservationsPage from "../pages/ReservationsPage";

const DAY = "2026-11-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const z = (hhmm) => new Date(at(hhmm)).toISOString();
const table = (id, seats) => ({ id, label: id, capacity_seats: seats, kind: "table", is_active: true, zone: null });
const RESOURCES = [table("1", 2), table("2", 2), table("3", 4), table("4", 4), table("5", 6), table("6", 6)];
const row = (id, name, tableId, status, from, to, party, extra = {}) => ({
  id, guest_name: name, resource_id: tableId, status, starts_at: at(from), ends_at: at(to),
  party_size: party, source: "manual", allergen_tags: [], seated_at: null, completed_at: null, ...extra,
});
const BOOK = [
  row("lar", "Larsen", "1", "seated", "17:30", "19:30", 2, { seated_at: z("17:32") }),
  row("hol", "Holm", "2", "seated", "18:00", "20:00", 2, { seated_at: null }),
  row("pet", "Petersen", "4", "confirmed", "18:00", "20:00", 2),
  row("han", "Hansen", "6", "confirmed", "18:30", "20:30", 5),
  row("ny", "Nyborg", "5", "requested", "20:00", "22:00", 4),
];
const WAIT = [
  { id: "kr", guest_name: "Kristensen", guest_phone: "+45 20 20 20 20", party_size: 2, status: "waiting", source: "manual", notify_count: 0, created_at: "2026-11-12T18:08:00", held: false },
];
const RULES = {
  settings: { turn_time_tiers: [{ up_to: 2, minutes: 90 }, { up_to: 8, minutes: 120 }], default_duration_min: 90 },
  hours_declared: false,
};

function mockApi({ book = BOOK, wait = WAIT } = {}) {
  api.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: RULES });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { date: DAY, reservations: book, summary: { total: book.length, covers: 0, by_status: {} } } });
    }
    if (url === "/reservations/resources") {
      return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 24 } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: wait, active_count: wait.length } });
    return Promise.resolve({ data: {} });
  });
  api.patch.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
}

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at("18:20")));
  vi.clearAllMocks();
  mockApi();
});
afterEach(() => vi.useRealTimers());

const renderOwner = () =>
  render(
    <MemoryRouter initialEntries={["/reservations"]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
const cell = (k) => document.querySelector(`[data-tonight="${k}"]`);

describe("I dag — the day's six numbers", () => {
  it("draws — until the book answers, then counts only what is on screen", async () => {
    let answer;
    api.get.mockImplementation((url) => {
      if (url === "/reservations/book") return new Promise((r) => { answer = r; });
      if (url === "/reservations/resources") return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 24 } });
      if (url === "/reservations/settings") return Promise.resolve({ data: RULES });
      if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: WAIT, active_count: 1 } });
      return Promise.resolve({ data: {} });
    });
    renderOwner();
    await waitFor(() => expect(cell("seated")).not.toBeNull());
    expect(cell("covers").textContent).toContain("—");
    expect(cell("seated").textContent).toContain("—");
    answer({ data: { date: DAY, reservations: BOOK, summary: { total: 5, covers: 0, by_status: {} } } });
    await waitFor(() => expect(cell("seated").textContent).toContain("4"));
    // 2 + 2 + 2 + 5 — the request is not a cover until someone says yes
    // (COVER_STATUSES, the server's BOOKED_COVER_STATUSES).
    expect(cell("covers").textContent).toMatch(/11/);
    expect(cell("covers").textContent).toContain("4 bookings");
    expect(cell("seated").textContent).toContain("2 of 6 tables");
  });

  it("needs you: the late party by name, and the request to confirm", async () => {
    renderOwner();
    await waitFor(() => expect(cell("needs").textContent).toContain("Petersen is 20 min late"));
    expect(cell("needs").textContent).toMatch(/^\D*2/); // 1 late + 1 request
    expect(cell("needs").textContent).toContain("1 to confirm");
  });

  it("booked peak is a count over the seats, never a percentage", async () => {
    renderOwner();
    // 18.30–19.30: Larsen 2 + Holm 2 + Petersen 2 + Hansen 5 = 11 of 24.
    await waitFor(() => expect(cell("peak").textContent).toContain("11/24"));
    expect(cell("peak").textContent).toContain("seats at 18.30");
    expect(cell("peak").textContent).not.toContain("%");
  });

  it("the waitlist names who waited longest; an unreadable list is —, never 'no one waiting'", async () => {
    renderOwner();
    await waitFor(() => expect(cell("waitlist").textContent).toContain("Kristensen · 2"));
  });

  it("an unreadable waitlist says nothing about who is waiting", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/reservations/waitlist") return Promise.reject(new Error("offline"));
      if (url === "/reservations/settings") return Promise.resolve({ data: RULES });
      if (url === "/reservations/book") return Promise.resolve({ data: { date: DAY, reservations: BOOK, summary: {} } });
      if (url === "/reservations/resources") return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 24 } });
      return Promise.resolve({ data: {} });
    });
    renderOwner();
    await waitFor(() => expect(cell("seated").textContent).toContain("4"));
    await waitFor(() => expect(cell("waitlist").textContent).toContain("—"));
    expect(cell("waitlist").textContent).not.toContain("No one waiting");
  });

});

describe("the evening list's live words", () => {
  it("at the table N min (from seated_at only), in N min, and late carries its no-show word", async () => {
    renderOwner();
    await waitFor(() => expect(document.querySelector('[data-live="seated"]')).not.toBeNull());
    const seatedWords = [...document.querySelectorAll('[data-live="seated"]')].map((n) => n.textContent);
    // Larsen sat at 17.32 → 48 min. Holm has no seated_at: no minutes at all.
    expect(seatedWords.some((w) => w.includes("48"))).toBe(true);
    expect(seatedWords.every((w) => w.includes("48"))).toBe(true);
    const soon = [...document.querySelectorAll('[data-live="soon"]')].map((n) => n.textContent);
    expect(soon.length).toBeGreaterThan(0);
    expect(soon.every((w) => w === "In 10 min")).toBe(true);
    // The late row's no-show is a WORD on the table's row actions.
    const petRow = [...document.querySelectorAll("tr")].find((tr) => tr.textContent.includes("Petersen"));
    expect(petRow).toBeTruthy();
    expect(within(petRow).getByRole("button", { name: /No-show/ }).textContent).toContain("No-show");
    // Hansen (not late) keeps the quiet icon-only no-show? Not due yet → none.
    const hanRow = [...document.querySelectorAll("tr")].find((tr) => tr.textContent.includes("Hansen"));
    expect(within(hanRow).queryByRole("button", { name: /No-show/ })).toBeNull();
  });

  it("Needs you opens the late party's booking", async () => {
    renderOwner();
    await waitFor(() => expect(cell("needs").textContent).toContain("Petersen"));
    fireEvent.click(cell("needs"));
    await waitFor(() => expect(screen.getAllByRole("dialog").some((d) => d.textContent.includes("Petersen"))).toBe(true));
  });
});

describe("the waitlist's table suggestion", () => {
  it("says the table free now for the whole sitting — the drop-in row's rule", async () => {
    renderOwner();
    await waitFor(() => expect(document.querySelector("[data-wl-fit]")).not.toBeNull());
    // Free now for 90 min: tables 3 and 5 (6 is Hansen's at 18.30); the smallest that fits a 2 is 3.
    expect(document.querySelector("[data-wl-fit]").textContent).toBe("Free now and fits: 3");
  });

  it("says nothing when no table is free for the sitting", async () => {
    const full = [
      ...BOOK,
      row("x3", "Three", "3", "seated", "18:00", "20:00", 4, { seated_at: z("18:00") }),
      row("x5", "Five", "5", "confirmed", "18:40", "20:40", 6),
    ];
    mockApi({ book: full });
    renderOwner();
    await waitFor(() => expect(cell("waitlist").textContent).toContain("Kristensen"));
    expect(document.querySelector("[data-wl-fit]")).toBeNull();
  });
});

describe("the host stand header (canvas Host.dc.html)", () => {
  const renderStand = () =>
    render(
      <MemoryRouter initialEntries={["/reservations/stand"]}>
        <ReservationsPage />
      </MemoryRouter>,
    );

  it("the time, who is waiting — and Find guest focuses the search", async () => {
    renderStand();
    await waitFor(() => expect(document.querySelector("[data-stand-clock]")).not.toBeNull());
    expect(document.querySelector("[data-stand-clock]").textContent).toBe("18.20");
    await waitFor(() => expect(document.querySelector("[data-stand-waiting]")?.textContent).toBe("1Waiting"));
    fireEvent.click(document.querySelector("[data-stand-find]"));
    await waitFor(() => expect(document.activeElement?.id).toBe("fb-search"));
  });

  it("nobody waiting: no count is drawn (never '0 waiting')", async () => {
    mockApi({ wait: [] });
    renderStand();
    await waitFor(() => expect(document.querySelector("[data-stand-clock]")).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-covers="seated"]')).not.toBeNull());
    expect(document.querySelector("[data-stand-waiting]")).toBeNull();
  });

  it("the drop-in row keeps its six sizes, the last one 6+", async () => {
    renderStand();
    await waitFor(() => expect(document.querySelectorAll("[data-walkin]").length).toBe(6));
    const labels = [...document.querySelectorAll("[data-walkin]")].map((b) => b.textContent);
    expect(labels[0]).toMatch(/^1/);
    expect(labels[5]).toMatch(/^6\+/);
  });
});
