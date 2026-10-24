/**
 * R1 D7 (24 Oct 2026) — a HELD online booking in the owner's book.
 *
 * The booking screen (backend services/booking_screen.py) keeps an odd
 * online booking as a request for the owner's OK instead of confirming it:
 * unusually many in a short time, a form filled in very fast, a link in the
 * name, the same guest holding several. In the book it reads "Tjek før du
 * bekræfter" in amber, and the drawer says why. A GROUP request (a party at or
 * above the venue's request threshold, asking on purpose) does not.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isHeldForCheck } from "../utils/bookingHeld";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    patch: (...a) => h.patch(...a), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: { business_type: "restaurant", business_name: "Havnen" }, logout: vi.fn(), refreshUser: vi.fn() }) };
});
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");

describe("isHeldForCheck", () => {
  const row = (over) => ({ status: "requested", source: "public", party_size: 2, ...over });
  it.each([
    ["a public request below the threshold", row(), 8, true],
    ["a group request at the threshold", row({ party_size: 8 }), 8, false],
    ["a group request above it", row({ party_size: 12 }), 8, false],
    ["a confirmed booking", row({ status: "confirmed" }), 8, false],
    ["a manual request", row({ source: "manual" }), 8, false],
    ["a walk-in", row({ source: "walk_in", status: "seated" }), 8, false],
    ["unknown threshold reads as 8", row({ party_size: 7 }), undefined, true],
    ["unknown threshold, a party of 8", row({ party_size: 8 }), undefined, false],
    ["a salon (threshold 99): every public request", row({ party_size: 1 }), 99, true],
    ["no group requests at all (0): every public request", row({ party_size: 30 }), 0, true],
    ["no row", null, 8, false],
  ])("%s", (_name, r, threshold, expected) => {
    expect(isHeldForCheck(r, threshold)).toBe(expected);
  });
});

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

function routes() {
  const soon = new Date(Date.now() + 3 * 3600000);
  const later = new Date(Date.now() + 4 * 3600000);
  const rows = [
    { id: "held", guest_name: "Hurtig Hansen", party_size: 2, status: "requested", source: "public",
      resource_id: "t1", combined_resource_ids: null, allergen_tags: [],
      starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 90 * 60000)) },
    { id: "group", guest_name: "Selskab Kragh", party_size: 12, status: "requested", source: "public",
      resource_id: null, combined_resource_ids: null, allergen_tags: [],
      starts_at: localIso(later), ends_at: localIso(new Date(later.getTime() + 120 * 60000)) },
  ];
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: { reservations_enabled: true, reservation_slug: "havnen", hours_declared: true,
        settings: { group_request_threshold: 8 }, closures: [], public_name: "Havnen" } });
    }
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: { settings: { turn_time_tiers: [] }, hours_declared: true, open_hours: {} } });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: rows, summary: { total: 2, by_status: { requested: 2 } } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("the book", () => {
  it("labels the held row, not the group request, and the drawer says why", async () => {
    routes();
    render(
      <MemoryRouter initialEntries={["/reservations"]}>
        <ReservationsPage />
      </MemoryRouter>,
    );
    await settle();
    const labels = screen.getAllByTestId("rsvp-held-label");
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l.textContent).toContain(da.rsvpHeldLabel);
      // Each label sits with the held guest, never with the group.
      const holder = l.closest("tr, [data-status], li, div[role='row']") || l.parentElement;
      expect(holder.textContent).toContain("Hurtig Hansen");
      expect(holder.textContent).not.toContain("Selskab Kragh");
    }
    await act(async () => { fireEvent.click(screen.getAllByText("Hurtig Hansen")[0]); });
    await settle(4);
    const why = screen.getByTestId("rsvp-held-drawer");
    expect(why.textContent).toContain(da.rsvpHeldLabel);
    expect(why.textContent).toContain(da.rsvpHeldWhy);
  });
});

describe("a link to a day alone", () => {
  it("/reservations?date=<iso> opens that day's book (the closed-date bookings link)", async () => {
    routes();
    render(
      <MemoryRouter initialEntries={["/reservations?date=2026-12-24"]}>
        <ReservationsPage />
      </MemoryRouter>,
    );
    await settle();
    const days = h.get.mock.calls.filter(([u]) => u === "/reservations/book").map(([, cfg]) => cfg?.params?.day);
    expect(days).toContain("2026-12-24");
    expect(days[days.length - 1]).toBe("2026-12-24");
  });
});
