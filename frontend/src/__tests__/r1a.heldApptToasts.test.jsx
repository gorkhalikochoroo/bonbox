/**
 * R1a (24 Oct 2026) — a held online booking on a shop's or a workshop's
 * book: the two toasts after the owner acts say "the customer" / "a space",
 * never "the guest" / "a table" (fix-2 verify S10). The drawer and the
 * decline confirm are pinned in verticalFit.apptWords.test.jsx; heldWhy's
 * own switch is pinned here for a salon too.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldWhy } from "../utils/bookingHeld";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), confirm: vi.fn(), toast: vi.fn(), type: "workshop" }));
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
  return { ...real, useAuth: () => ({ user: { business_type: h.type, business_name: "Cykelværkstedet" }, logout: vi.fn(), refreshUser: vi.fn() }) };
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

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const soon = new Date(Date.now() + 3 * 3600000);
const tDa = (k, vars) => {
  let s = da[k];
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

function routes(type) {
  h.type = type;
  const label = type === "restaurant" ? "Bord 1" : "Plads 1";
  const rows = [
    { id: "held", guest_name: "Rikke Rigtig", party_size: 1, status: "requested", source: "public",
      resource_id: null, combined_resource_ids: null, allergen_tags: [], guest_mailed: false,
      held: { reason: "contact_active", quiet: false, bot: false, wanted: [label], pinned: false, limit: 3 },
      starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 60 * 60000)) },
  ];
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: { reservations_enabled: true, reservation_slug: "v", hours_declared: true,
        settings: { group_request_threshold: 8 }, closures: [], public_name: "Cykelværkstedet" } });
    }
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: { settings: { turn_time_tiers: [] }, hours_declared: true, open_hours: {} } });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label, capacity_seats: 2, is_active: true }], fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: rows, summary: { total: 1, by_status: { requested: 1 } } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
}

const openHeld = async () => {
  render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
  await settle();
  await act(async () => { fireEvent.click(screen.getAllByText("Rikke Rigtig")[0]); });
  await settle(4);
  return screen.getByTestId("rsvp-held-drawer").closest('[role="dialog"]') || document.body;
};
const press = async (scope, label) => {
  const b = [...scope.querySelectorAll("button")].find((x) => x.textContent.trim() === label);
  expect(b, label).toBeTruthy();
  await act(async () => { fireEvent.click(b); });
  await settle(6);
};
const toasts = () => h.toast.mock.calls.map(([o]) => (typeof o === "string" ? o : o?.message));

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.confirm.mockReset(); h.confirm.mockResolvedValue(true); h.toast.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("the toasts after the owner acts on a held booking", () => {
  it("workshop: declined while the day's e-mails for held requests are used up — 'Ring til kunden'", async () => {
    routes("workshop");
    h.patch.mockResolvedValue({ data: { id: "held", status: "cancelled", guest_email_skipped: { code: "held_mail_budget" } } });
    await press(await openHeld(), da.rsvpDeclineAction);
    expect(toasts()).toContain(da.rsvpGuestMailHeldBudgetAppt);
    expect(toasts().join(" ")).not.toMatch(/gæst/i);
  });

  it("workshop: approving one whose space went meanwhile — 'ledig plads', not 'bord'", async () => {
    routes("workshop");
    h.patch.mockRejectedValue({ response: { status: 409, data: { detail: { error: "slot_unavailable", held: true } } } });
    await press(await openHeld(), da.rsvpConfirmAction);
    const said = toasts().find((m) => m && m.startsWith(da.rsvpHeldApproveNoTableAppt.split(" kl.")[0]));
    expect(said).toBeTruthy();
    expect(said).not.toMatch(/bord/i);
  });

  it("a restaurant keeps 'Ring til gæsten' and 'ledigt bord' (unchanged)", async () => {
    routes("restaurant");
    h.patch.mockResolvedValue({ data: { id: "held", status: "cancelled", guest_email_skipped: { code: "held_mail_budget" } } });
    await press(await openHeld(), da.rsvpDeclineAction);
    expect(toasts()).toContain(da.rsvpGuestMailHeldBudget);
  });
});

describe("heldWhy names the customer where apptWords is on", () => {
  it("salon / shop / workshop vs restaurant, both languages", () => {
    const tEn = (k, fb, vars) => (en[k] ?? fb).replace(/\{(\w+)\}/g, (m, n) => (vars && vars[n] !== undefined ? String(vars[n]) : m));
    const tD = (k, fb, vars) => tDa(k, vars);
    const r = (reason) => ({ held: { reason, limit: 2 } });
    expect(heldWhy(r("contact_active"), tD, { apptWords: true })).toBe(tDa("rsvpHeldWhyContactAppt", { n: 2 }));
    expect(heldWhy(r("contact_active"), tD)).toBe(tDa("rsvpHeldWhyContact", { n: 2 }));
    expect(heldWhy(r("fast_fill"), tEn, { apptWords: true })).toBe(en.rsvpHeldWhyFastAppt);
    expect(heldWhy(r("requests_full"), tEn, { apptWords: true })).toBe(en.rsvpHeldWhyRequestsAppt);
    // The sentences that never name the person stay one text for all.
    expect(heldWhy(r("link_in_name"), tD, { apptWords: true })).toBe(da.rsvpHeldWhyLink);
    expect(heldWhy(r("venue_hour"), tD, { apptWords: true })).toBe(da.rsvpHeldWhyBusy);
    expect(heldWhy(r("nonsense"), tD, { apptWords: true })).toBe(da.rsvpHeldWhy);
  });
});
