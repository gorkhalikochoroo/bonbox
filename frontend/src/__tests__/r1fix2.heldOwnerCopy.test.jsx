/**
 * Booking fix round 2 (24 Oct 2026) — the owner's words about held bookings.
 *
 *   • A person-like hold (`held.bot === false`: a busy moment, the same guest
 *     again) is no longer declined silently: the guest is e-mailed within the
 *     venue's held-mail budget, and the owner is told if the budget was spent
 *     ("held_mail_budget"). A bot-like hold stays silent.
 *   • The drawer names the server's real limit for a guest's bookings ahead
 *     (it said "3" whatever the limit was).
 *   • The stand's held toast: "1 online-booking til tjek" (not
 *     "1 online-bookinger"), and its line no longer says "bord" on a salon's
 *     stand.
 *   • The absence sheet's hint no longer reads as the formal "Deres".
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldWanted, heldWhy, isHeldForCheck } from "../utils/bookingHeld";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), confirm: vi.fn(), toast: vi.fn() }));
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useToast", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useToast: () => h.toast };
});

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const tDa = (k, fb, vars) => {
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const soon = new Date(Date.now() + 3 * 3600000);
const later = new Date(Date.now() + 4 * 3600000);

function routes(held) {
  const rows = [
    { id: "held", guest_name: "Rikke Rigtig", party_size: 2, status: "requested", source: "public",
      resource_id: null, combined_resource_ids: null, allergen_tags: [], guest_mailed: false,
      held, starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 90 * 60000)) },
  ];
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: { reservations_enabled: true, reservation_slug: "havnen", hours_declared: true,
        settings: { group_request_threshold: 8 }, closures: [], public_name: "Havnen" } });
    }
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: { settings: { turn_time_tiers: [] }, hours_declared: true, open_hours: {} } });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: rows, summary: { total: 1, by_status: { requested: 1 } } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
}

const openHeld = async () => {
  render(
    <MemoryRouter initialEntries={["/reservations"]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
  await settle();
  await act(async () => { fireEvent.click(screen.getAllByText("Rikke Rigtig")[0]); });
  await settle(4);
  return screen.getByTestId("rsvp-held-drawer").closest('[role="dialog"]') || document.body;
};

const decline = async (scope) => {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent.trim() === da.rsvpDeclineAction);
  expect(b).toBeTruthy();
  await act(async () => { fireEvent.click(b); });
  await settle(6);
  return h.confirm.mock.calls[h.confirm.mock.calls.length - 1][0];
};

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.confirm.mockReset(); h.confirm.mockResolvedValue(true); h.toast.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("declining a held booking", () => {
  it("a person-like hold nobody mailed yet: the guest is told if the budget allows", async () => {
    routes({ reason: "venue_hour", quiet: false, bot: false, wanted: ["Bord 1"], pinned: false });
    h.patch.mockResolvedValue({ data: { id: "held", status: "cancelled" } });
    const opts = await decline(await openHeld());
    expect(opts.message).toBe(tDa("rsvpHeldDeclineBodyMaybe", "", { name: "Rikke Rigtig" }));
    expect(opts.confirmLabel).toBe(da.rsvpDeclineAction);
    const call = h.patch.mock.calls.find(([u]) => u === "/reservations/reservations/held/status");
    expect(call[1].status).toBe("cancelled");
    expect("notify_guest" in call[1]).toBe(false);
    expect(h.toast).not.toHaveBeenCalledWith(expect.objectContaining({ message: da.rsvpGuestMailHeldBudget }));
  });

  it("…and when the day's budget was spent, the owner is told to call", async () => {
    routes({ reason: "venue_hour", quiet: false, bot: false, wanted: [], pinned: false });
    h.patch.mockResolvedValue({ data: { id: "held", status: "cancelled",
      guest_email_skipped: { code: "held_mail_budget" } } });
    await decline(await openHeld());
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: da.rsvpGuestMailHeldBudget }));
  });

  it("a bot-like hold stays silent", async () => {
    routes({ reason: "fast_fill", quiet: true, bot: true, wanted: [], pinned: false });
    h.patch.mockResolvedValue({ data: { id: "held", status: "cancelled" } });
    const opts = await decline(await openHeld());
    expect(opts.message).toBe(tDa("rsvpHeldDeclineBodySilent", "", { name: "Rikke Rigtig" }));
    const call = h.patch.mock.calls.find(([u]) => u === "/reservations/reservations/held/status");
    expect(call[1]).toMatchObject({ status: "cancelled", notify_guest: false });
  });
});

describe("the drawer and the stand, in words", () => {
  it("names the server's own limit for a guest's bookings ahead", () => {
    expect(heldWhy({ held: { reason: "contact_active", limit: 2 } }, tDa))
      .toBe(da.rsvpHeldWhyContact.replace("{n}", "2"));
    expect(heldWhy({ held: { reason: "contact_active" } }, tDa))
      .toBe(da.rsvpHeldWhyContact.replace("{n}", "3"));                  // an older server
    expect(heldWhy({ held: { reason: "date_full" } }, tDa)).toBe(da.rsvpHeldWhyBusy);
    expect(da.rsvpHeldWhyContact).toContain("{n}");
    expect(en.rsvpHeldWhyContact).toContain("{n}");
  });

  it("the new and fixed sentences are real en + da", () => {
    for (const k of ["rsvpHeldDeclineBodyMaybe", "rsvpGuestMailHeldBudget", "liveAlertHeldTitleOne",
      "liveAlertHeldSub", "absenceSheetOnlineHint"]) {
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
    }
    expect(da.liveAlertHeldTitleOne).toBe("1 online-booking til tjek");
    expect(da.liveAlertHeldSub).not.toMatch(/bord/i);                    // salons have no tables
    expect(en.liveAlertHeldSub).not.toMatch(/table/i);
    expect(da.absenceSheetOnlineHint).not.toMatch(/^Deres\b/);          // not the formal "your"
  });
});
