/**
 * Fix round 12 Nov — seating on a table someone else still sits at (#2), and
 * the booking's table picker after "Another table" (#3), on the owner page.
 *
 * #2 Petersen seated at Bord 4 while Kristensen (seated a minute ago) sits
 *    there: the dark button was "Finish Kristensen and seat", and there was
 *    no Cancel. Now a party seated under 45 min ago (or with more than 15
 *    min of their sitting left) puts "Another table" first and "Finish …" as
 *    the quiet choice; Cancel always closes with nothing changed.
 * #3 The picker said nothing beside the booking's own table while another
 *    party sat there, and nothing beside a free table booked inside the
 *    sitting. Now "taken" / "booked 18.49".
 * #4/#5 Rows name tables ("Table 4") and write phones one way.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, within, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const h = vi.hoisted(() => ({ confirm: vi.fn() }));
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
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
const RESOURCES = [table("1", 2), table("3", 4), table("4", 4), table("5", 6)];
const row = (id, name, tableId, status, from, to, party, extra = {}) => ({
  id, guest_name: name, resource_id: tableId, status, starts_at: at(from), ends_at: at(to),
  party_size: party, source: "manual", allergen_tags: [], seated_at: null, completed_at: null, duration_min: 90, ...extra,
});
// 18.20. Petersen was booked on Bord 4 at 17.00 and is late; Møller is
// booked on Bord 3 at 18.49 — after Petersen's booked window, inside a
// sitting that starts now.
const petersen = row("pet", "Petersen", "4", "confirmed", "17:00", "18:30", 2, { guest_phone: "+4511223344" });
const moller = row("mol", "Møller", "3", "confirmed", "18:49", "20:19", 2);
const kristensenRecent = row("kri", "Kristensen", "4", "seated", "18:19", "19:49", 2, { seated_at: z("18:19") });
const kristensenOver = row("kri", "Kristensen", "4", "seated", "16:00", "18:00", 2, { seated_at: z("16:00") });
const RULES = {
  settings: { turn_time_tiers: [{ up_to: 2, minutes: 90 }, { up_to: 8, minutes: 120 }], default_duration_min: 90 },
  hours_declared: false,
};

function mockApi(book) {
  api.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: RULES });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { date: DAY, reservations: book, venue_country: "DK", summary: { total: book.length, covers: 0, by_status: {} } } });
    }
    if (url === "/reservations/resources") {
      return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 16 } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
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
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const renderOwner = () =>
  render(
    <MemoryRouter initialEntries={["/reservations"]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
const seatPetersen = async () => {
  await waitFor(() => expect(document.querySelector('[data-status="late"]')).not.toBeNull());
  const late = [...document.querySelectorAll('[data-status="late"]')].find((n) => n.textContent.includes("Petersen"));
  fireEvent.click(within(late).getByRole("button", { name: "Seat" }));
  await waitFor(() => expect(h.confirm).toHaveBeenCalled());
  return h.confirm.mock.calls[0][0];
};
const statusPatches = () => api.patch.mock.calls.filter(([url]) => /\/status$/.test(url));

describe("'Table 4 is still taken' — the safe answer first (#2)", () => {
  it("Kristensen seated a minute ago: 'Another table' is the dark button, Finish the quiet one, and Cancel is there", async () => {
    mockApi([petersen, kristensenRecent, moller]);
    h.confirm.mockResolvedValue(false);
    renderOwner();
    const opts = await seatPetersen();
    expect(opts.title).toBe("Table 4 is still taken");
    expect(opts.confirmLabel).toBe("Another table");
    expect(opts.extraLabel).toBe("Finish Kristensen and seat");
    expect(opts.cancelLabel).toBe("Cancel");
    // Cancel: nothing changes, nothing opens.
    await Promise.resolve();
    expect(statusPatches()).toHaveLength(0);
    expect(document.getElementById("rsvp-drawer-table")).toBeNull();
  });

  it("the quiet Finish still finishes Kristensen and seats Petersen", async () => {
    mockApi([petersen, kristensenRecent, moller]);
    h.confirm.mockResolvedValue("extra");
    renderOwner();
    await seatPetersen();
    await waitFor(() => expect(statusPatches()).toHaveLength(2));
    expect(statusPatches()[0]).toEqual(["/reservations/reservations/kri/status", { status: "completed" }]);
    expect(statusPatches()[1][0]).toBe("/reservations/reservations/pet/status");
    expect(statusPatches()[1][1].status).toBe("seated");
  });

  it("a party over time keeps the old order — Finish first, Another table quiet — and Cancel", async () => {
    mockApi([petersen, kristensenOver, moller]);
    h.confirm.mockResolvedValue(true);
    renderOwner();
    const opts = await seatPetersen();
    expect(opts.confirmLabel).toBe("Finish Kristensen and seat");
    expect(opts.extraLabel).toBe("Another table");
    expect(opts.cancelLabel).toBe("Cancel");
    await waitFor(() => expect(statusPatches()).toHaveLength(2));
    expect(statusPatches()[0][1]).toEqual({ status: "completed" });
  });

  it("'Another table' opens the booking on its table picker, which tells the truth (#3)", async () => {
    mockApi([petersen, kristensenRecent, moller]);
    h.confirm.mockResolvedValue(true); // the dark button: Another table
    renderOwner();
    await seatPetersen();
    const select = await waitFor(() => {
      const el = document.getElementById("rsvp-drawer-table");
      expect(el).not.toBeNull();
      return el;
    });
    expect(statusPatches()).toHaveLength(0);
    const text = (id) => [...select.querySelectorAll("option")].find((o) => o.value === id).textContent;
    // Its own table: Kristensen sits there — said, still the select's value.
    expect(text("4")).toBe("Table 4 · 4 seats · taken");
    expect(select.querySelector('option[value="4"]').disabled).toBe(false);
    // Free now, Møller at 18.49 inside the sitting: said, still a choice.
    expect(text("3")).toBe("Table 3 · 4 seats · booked 18.49");
    expect(select.querySelector('option[value="3"]').disabled).toBe(false);
    // Nothing on it all evening.
    expect(text("5")).toBe("Table 5 · 6 seats");
  });
});

describe("rows name tables and write phones one way (#4, #5)", () => {
  it("the desktop row says 'Table 4' and '+45 11 22 33 44'", async () => {
    mockApi([petersen, moller]);
    h.confirm.mockResolvedValue(false);
    renderOwner();
    await waitFor(() => expect([...document.querySelectorAll("tr")].some((tr) => tr.textContent.includes("Petersen"))).toBe(true));
    const tr = [...document.querySelectorAll("tr")].find((x) => x.textContent.includes("Petersen"));
    expect(tr.textContent).toContain("Table 4");
    expect(tr.textContent).toContain("+45 11 22 33 44");
    expect(tr.textContent).not.toContain("+4511223344");
  });
});
