/**
 * R1 C (24 Oct 2026) — the booking page's name, in Reservationer →
 * Indstillinger. Guests see it at the top of the page, in their confirmation
 * and on the website button; it is Profile → Virksomhedsnavn
 * (users.business_name), so one PATCH /auth/profile changes both.
 *
 * Two taps and one field: Ret → type → Gem. The row is there before the
 * page is live — "Din bookingside" only shows once it is.
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
  return { ...real, useAuth: () => ({ user: { business_type: "restaurant", business_name: "Trattoria Testa" }, logout: vi.fn(), refreshUser: vi.fn() }) };
});
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const BookingNameRow = (await import("../components/reservations/BookingNameRow")).default;
const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const t = (k, fb, vars) => {
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("BookingNameRow", () => {
  it("shows the public name, or the empty text", () => {
    const { rerender } = render(<BookingNameRow t={t} publicName="Trattoria Testa Aarhus" tradingName="Trattoria Testa Aarhus" />);
    expect(screen.getByTestId("rsvp-booking-name-value").textContent).toBe("Trattoria Testa Aarhus");
    rerender(<BookingNameRow t={t} publicName={null} tradingName="" />);
    expect(screen.getByTestId("rsvp-booking-name-empty").textContent).toBe(da.rsvpBookingNameEmpty);
  });

  it("Ret → type → Gem sends PATCH /auth/profile and refetches", async () => {
    h.patch.mockResolvedValue({ data: {} });
    const onSaved = vi.fn();
    render(<BookingNameRow t={t} publicName="Trattoria Testa" tradingName="Trattoria Testa" onSaved={onSaved} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpBookingNameEdit })); });  // tap 1
    const input = document.getElementById("rsvp-booking-name-input");
    expect(document.activeElement).toBe(input);
    await act(async () => { fireEvent.change(input, { target: { value: "  Trattoria Testa Aarhus " } }); });     // the field
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });                 // tap 2
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch).toHaveBeenCalledWith("/auth/profile", { business_name: "Trattoria Testa Aarhus" });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(da.rsvpBookingNameSaved);
  });

  it("Gem is disabled for a blank or an unchanged value; Esc cancels", async () => {
    render(<BookingNameRow t={t} publicName="Trattoria Testa" tradingName="Trattoria Testa" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpBookingNameEdit })); });
    const save = screen.getByRole("button", { name: da.save });
    expect(save.disabled).toBe(true);                         // unchanged
    const input = document.getElementById("rsvp-booking-name-input");
    await act(async () => { fireEvent.change(input, { target: { value: "   " } }); });
    expect(save.disabled).toBe(true);                         // blank
    await act(async () => { fireEvent.click(save); });
    expect(h.patch).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(input, { key: "Escape" }); });
    expect(document.getElementById("rsvp-booking-name-input")).toBeNull();
  });

  it("is in Indstillinger before the page is live", async () => {
    h.get.mockImplementation((url) => {
      if (url === "/reservations/settings") {
        return Promise.resolve({ data: {
          reservations_enabled: false, reservation_slug: null, public_url: null,
          business_name: "Trattoria Testa Aarhus", public_name: "Trattoria Testa Aarhus",
          hours_declared: true, settings: { group_request_threshold: 8 }, closures: [], open_hours: {},
        } });
      }
      if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: false } });
      return Promise.resolve({ data: {} });
    });
    render(
      <MemoryRouter initialEntries={["/reservations?tab=settings"]}>
        <ReservationsPage />
      </MemoryRouter>,
    );
    await settle();
    expect(screen.getByTestId("rsvp-booking-name-value").textContent).toBe("Trattoria Testa Aarhus");
    expect(document.querySelector('[data-testid="rsvp-share-card"]')).toBeNull();   // not live
  });
});
