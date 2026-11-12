/**
 * Phone R1 (PHONE-OWNER-PLAN v3, approved 12 Nov 2026) — Reservationer.
 *
 *   1. Haptics at the server's answer, never at the tap (5.6): Sæt til bords
 *      plays `done` once the PATCH answers, a refusal (409) plays `warn`, a
 *      failure `fail`; the Venteliste's one-tap seat the same. Before the
 *      answer: nothing.
 *   2. The deep link the "+" sheet and I dag use (?walkin=1 / ?new=1) opens
 *      its sheet on EVERY tap, not once per page mount: "+ → Drop-in" twice
 *      in a row on Reservationer opens the seat sheet twice (the guard was a
 *      flag set once and never reset — a dead button the second time).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor, within, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";

const feelSpy = vi.hoisted(() => ({ done: vi.fn(), soft: vi.fn(), warn: vi.fn(), fail: vi.fn(), tick: vi.fn(), warm: vi.fn() }));
vi.mock("../components/staff/feel", () => ({ feel: feelSpy, resetFeelForTests: () => {}, OUTCOME_GAP_MS: 1500, WARM_MS: 2000 }));
const oldHaptic = vi.hoisted(() => ({ light: vi.fn(), medium: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("../utils/haptics", () => ({ haptic: oldHaptic }));
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
import WaitlistSection from "../components/reservations/WaitlistSection";

const DAY = "2026-11-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const table = (id, seats) => ({ id, label: id, capacity_seats: seats, kind: "table", is_active: true, zone: null });
const RESOURCES = [table("1", 2), table("2", 2), table("3", 4), table("4", 4), table("5", 6), table("6", 6)];
const row = (id, name, tableId, status, from, to, party, extra = {}) => ({
  id, guest_name: name, resource_id: tableId, status, starts_at: at(from), ends_at: at(to),
  party_size: party, source: "manual", allergen_tags: [], seated_at: null, completed_at: null, ...extra,
});
const BOOK = [
  row("pet", "Petersen", "4", "confirmed", "18:00", "20:00", 2),
  row("han", "Hansen", "6", "confirmed", "18:30", "20:30", 5),
];
const RULES = {
  settings: { turn_time_tiers: [{ up_to: 2, minutes: 90 }, { up_to: 8, minutes: 120 }], default_duration_min: 90 },
  hours_declared: false,
};

function mockApi() {
  api.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: RULES });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { date: DAY, reservations: BOOK, summary: { total: BOOK.length, covers: 0, by_status: {} } } });
    }
    if (url === "/reservations/resources") {
      return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 24 } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
  api.patch.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const noHapticYet = () => {
  for (const f of Object.values(feelSpy)) expect(f).not.toHaveBeenCalled();
  for (const f of Object.values(oldHaptic)) expect(f).not.toHaveBeenCalled();
};

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
afterEach(() => { cleanup(); vi.useRealTimers(); });

const lateRow = () => [...document.querySelectorAll('[data-status="late"]')].find((n) => n.textContent.includes("Petersen"));

describe("haptics play at the server's answer, never at the tap (5.6)", () => {
  it("Sæt til bords: nothing at the tap; `done` once the PATCH answers", async () => {
    const answer = deferred();
    api.patch.mockImplementation(() => answer.promise);
    render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
    await waitFor(() => expect(lateRow()).toBeTruthy());
    fireEvent.click(within(lateRow()).getByRole("button", { name: "Seat" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1]).toMatchObject({ status: "seated" });
    noHapticYet();
    await act(async () => { answer.resolve({ data: { id: "pet", status: "seated", resource_id: "4" } }); });
    await waitFor(() => expect(feelSpy.done).toHaveBeenCalledTimes(1));
    expect(feelSpy.warn).not.toHaveBeenCalled();
    expect(feelSpy.fail).not.toHaveBeenCalled();
    // The old tap-time buzz is gone for good.
    for (const f of Object.values(oldHaptic)) expect(f).not.toHaveBeenCalled();
  });

  it("refused (409): `warn` at the answer, never `done`", async () => {
    const answer = deferred();
    api.patch.mockImplementation(() => answer.promise);
    render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
    await waitFor(() => expect(lateRow()).toBeTruthy());
    fireEvent.click(within(lateRow()).getByRole("button", { name: "Seat" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    noHapticYet();
    await act(async () => { answer.reject({ response: { status: 409, data: { detail: { error: "slot_unavailable" } } } }); });
    await waitFor(() => expect(feelSpy.warn).toHaveBeenCalledTimes(1));
    expect(feelSpy.done).not.toHaveBeenCalled();
    expect(feelSpy.fail).not.toHaveBeenCalled();
  });

  it("no answer (network): `fail`", async () => {
    const answer = deferred();
    api.patch.mockImplementation(() => answer.promise);
    render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
    await waitFor(() => expect(lateRow()).toBeTruthy());
    fireEvent.click(within(lateRow()).getByRole("button", { name: "Seat" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    noHapticYet();
    await act(async () => { answer.reject(new Error("Network Error")); });
    await waitFor(() => expect(feelSpy.fail).toHaveBeenCalledTimes(1));
    expect(feelSpy.done).not.toHaveBeenCalled();
  });

  it("the Venteliste's one-tap seat: nothing at the tap; `done` at the answer, `warn` on a 409", async () => {
    const entry = { id: "a", guest_name: "Norgaard", guest_phone: "20 55 66 77", party_size: 2, waitlist_date: DAY, status: "waiting", source: "manual", notify_count: 0, created_at: null, held: false };
    const fit = { tableId: "t2", tableIds: ["t2"], label: "2", seats: 2 };
    api.get.mockResolvedValue({ data: { waitlist: [entry], day: DAY, active_count: 1 } });
    const answer = deferred();
    api.post.mockImplementation(() => answer.promise);
    render(<WaitlistSection day={DAY} fitFor={() => fit} />);
    const seat = await waitFor(() => {
      const b = document.querySelector('[data-wl-seat="primary"]');
      expect(b).not.toBeNull();
      return b;
    });
    fireEvent.click(seat);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/reservations/waitlist/a/seat", { resource_ids: ["t2"] }));
    noHapticYet();
    await act(async () => { answer.resolve({ data: { reservation: { id: "r1", resource_id: "t2" } } }); });
    await waitFor(() => expect(feelSpy.done).toHaveBeenCalledTimes(1));

    cleanup();
    vi.clearAllMocks();
    api.get.mockResolvedValue({ data: { waitlist: [entry], day: DAY, active_count: 1 } });
    api.post.mockRejectedValue({ response: { status: 409, data: { detail: { error: "table_occupied", occupant: { table: "2", name: "Holm" } } } } });
    render(<WaitlistSection day={DAY} fitFor={() => fit} />);
    const again = await waitFor(() => {
      const b = document.querySelector('[data-wl-seat="primary"]');
      expect(b).not.toBeNull();
      return b;
    });
    fireEvent.click(again);
    await waitFor(() => expect(feelSpy.warn).toHaveBeenCalledTimes(1));
    expect(feelSpy.done).not.toHaveBeenCalled();
  });
});

/** A stand-in for the "+" sheet's chip: navigates, as QuickAdd does. */
function Plus({ to }) {
  const navigate = useNavigate();
  return <button type="button" data-test-plus="" onClick={() => navigate(to)}>plus</button>;
}
const seatSheet = () => document.getElementById("rsvp-seat-title");
const newSheet = () => document.getElementById("rsvp-new-title");
const esc = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });

describe('the deep link opens its sheet on every tap: "+ → Drop-in" twice works', () => {
  it("?walkin=1 twice in a row on Reservationer opens the seat sheet twice", async () => {
    render(
      <MemoryRouter initialEntries={["/reservations?walkin=1"]}>
        <ReservationsPage />
        <Plus to="/reservations?walkin=1" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(seatSheet()).not.toBeNull());
    await esc();
    await waitFor(() => expect(seatSheet()).toBeNull());
    // The second tap — already on Reservationer, same page mount.
    fireEvent.click(document.querySelector("[data-test-plus]"));
    await waitFor(() => expect(seatSheet()).not.toBeNull());
    await esc();
    await waitFor(() => expect(seatSheet()).toBeNull());
    // And a third, for good measure.
    fireEvent.click(document.querySelector("[data-test-plus]"));
    await waitFor(() => expect(seatSheet()).not.toBeNull());
  });

  it("?new=1 twice in a row opens Ny reservation twice", async () => {
    render(
      <MemoryRouter initialEntries={["/reservations?new=1"]}>
        <ReservationsPage />
        <Plus to="/reservations?new=1" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(newSheet()).not.toBeNull());
    await esc();
    await waitFor(() => expect(newSheet()).toBeNull());
    fireEvent.click(document.querySelector("[data-test-plus]"));
    await waitFor(() => expect(newSheet()).not.toBeNull());
  });

  it("the flag leaves the address once read: a re-render on the same page opens nothing more", async () => {
    render(
      <MemoryRouter initialEntries={["/reservations?walkin=1"]}>
        <ReservationsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(seatSheet()).not.toBeNull());
    await esc();
    await waitFor(() => expect(seatSheet()).toBeNull());
    // The book answering again (a poll, a write) re-renders; no sheet comes back.
    await act(async () => { window.dispatchEvent(new Event("bonbox-reservations-changed")); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(seatSheet()).toBeNull();
  });
});
