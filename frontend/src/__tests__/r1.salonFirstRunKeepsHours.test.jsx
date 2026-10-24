/**
 * R1 A1 + A4 (24 Oct 2026) — the salon first-run card ("Åbn for booking").
 *
 * The card used to show a suggested week (Tue–Fri 09–17, Sat 09–14) and post
 * it on the tap, over the hours the owner had already saved under
 * Indstillinger → Åbningstider. Now it shows the SAVED hours ("Dine gemte
 * åbningstider…"), and the tap keeps them (replace_hours: false) unless the
 * owner edited a day on the card (replace_hours: true).
 *
 * A salon with no service cannot take a booking (a customer picks a
 * behandling first): the card says so in amber, with a way to add one.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return { ...real, useAuth: () => ({ user: { business_type: "salon", business_name: "Klip" }, logout: vi.fn(), refreshUser: vi.fn() }) };
});
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const SAVED = { mon: "closed", tue: "16:00-22:00", wed: "16:00-22:00", thu: "16:00-22:00", fri: "16:00-22:00", sat: "16:00-22:00", sun: "16:00-22:00" };

function routes({ bookingHours = SAVED, behandlinger = [{ id: "b1", name: "Klip", duration_min: 30, active: true }] } = {}) {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: {
        reservations_enabled: false, reservation_slug: null, hours_declared: !!bookingHours,
        settings: { booking_hours: bookingHours || undefined, group_request_threshold: 99 },
        closures: [], public_name: "Klip",
      } });
    }
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: { settings: { turn_time_tiers: [] }, hours_declared: true, open_hours: {} } });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [], fixtures: [], book_has_entries: false } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: [], summary: { total: 0, by_status: {} } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url === "/reservations/behandlinger") return Promise.resolve({ data: { behandlinger } });
    return Promise.resolve({ data: {} });
  });
  h.post.mockResolvedValue({ data: {} });
}

const renderBook = () =>
  render(
    <MemoryRouter initialEntries={["/reservations"]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
const openTap = () => screen.getByRole("button", { name: new RegExp(da.rsvpSalonOpenForBooking) });
const quickSetupBody = () => {
  const call = h.post.mock.calls.find(([url]) => url === "/reservations/salon/quick-setup");
  return call ? call[1] : null;
};

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("salon first-run card keeps saved hours", () => {
  it("shows the saved week under 'Dine gemte åbningstider' and an untouched tap keeps it", async () => {
    routes();
    renderBook();
    await settle();
    expect(document.body.textContent).toContain(da.rsvpSalonHoursSaved);
    expect(document.body.textContent).not.toContain(da.rsvpSalonHoursSuggestion);
    const opens = [...document.querySelectorAll('input[type="time"]')].map((i) => i.value);
    expect(opens).toContain("16:00");
    expect(opens).not.toContain("09:00");
    await act(async () => { fireEvent.click(openTap()); });
    await settle(4);
    const body = quickSetupBody();
    expect(body).toBeTruthy();
    expect(body.replace_hours).toBe(false);
    expect(body.booking_hours).toEqual(SAVED);
  });

  it("editing a day on the card sends replace_hours: true", async () => {
    routes();
    renderBook();
    await settle();
    const firstOpen = document.querySelector('input[type="time"]');
    await act(async () => { fireEvent.change(firstOpen, { target: { value: "15:00" } }); });
    await act(async () => { fireEvent.click(openTap()); });
    await settle(4);
    expect(quickSetupBody().replace_hours).toBe(true);
  });

  it("with nothing saved the card shows the suggestion", async () => {
    routes({ bookingHours: null });
    renderBook();
    await settle();
    expect(document.body.textContent).toContain(da.rsvpSalonHoursSuggestion);
    await act(async () => { fireEvent.click(openTap()); });
    await settle(4);
    expect(quickSetupBody().replace_hours).toBe(false);
  });

  it("no service: an amber warning with a way to add one", async () => {
    routes({ behandlinger: [] });
    renderBook();
    await settle();
    const warn = document.querySelector('[data-testid="salon-no-service-warn"]');
    expect(warn).not.toBeNull();
    expect(warn.textContent).toContain(da.rsvpSalonNoServiceWarn);
    const cta = document.querySelector('[data-testid="salon-add-service-cta"]');
    expect(cta.getAttribute("href")).toBe("/reservations?tab=behandlinger");
    expect(cta.textContent).toContain(da.rsvpSalonAddServiceCta);
  });

  it("with a service the warning is gone", async () => {
    routes();
    renderBook();
    await settle();
    expect(document.querySelector('[data-testid="salon-no-service-warn"]')).toBeNull();
  });
});
