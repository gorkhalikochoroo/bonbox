/**
 * R1 fix round (24 Oct 2026) — a HELD online booking in the owner's book, as
 * the server now describes it.
 *
 * Since the fix round a held booking waits on NO table (it holds nothing) and
 * the book row says why and what it was for: `held: {reason, quiet, wanted,
 * pinned}`; every row says whether the guest had an e-mail from us
 * (`guest_mailed`). The book:
 *   • labels only rows the server held — not a group request, not a small
 *     request at a venue that approves everything itself;
 *   • the drawer gives the reason in plain words and "Booket til: Bord 3";
 *   • declining a held booking whose guest never had a mail says so and
 *     sends notify_guest:false ("Afvis uden besked") — no relay to a typed
 *     address (review: clean-up mailed every spam address);
 *   • approving one whose table went meanwhile says what to do, not a raw
 *     "slot_unavailable";
 *   • a stylist away on Ferie is flagged on the row (provider_absent).
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

describe("isHeldForCheck with the server's word", () => {
  const row = (over) => ({ status: "requested", source: "public", party_size: 2, guest_mailed: false, ...over });
  it.each([
    ["held by the server", row({ held: { reason: "fast_fill" } }), true],
    ["a small request the server did NOT hold (threshold 1)", row({ party_size: 1 }), false],
    ["a group request", row({ party_size: 12, guest_mailed: true }), false],
    ["a held row that was confirmed since", row({ status: "confirmed", held: { reason: "venue_hour" } }), false],
  ])("%s", (_n, r, expected) => {
    expect(isHeldForCheck(r, 1)).toBe(expected);
  });

  it("names every reason in plain words, en and da", () => {
    for (const reason of ["fast_fill", "link_in_name", "honeypot", "contact_active", "requests_full",
      "venue_hour", "venue_day", "sitting_full", "plan_day"]) {
      const said = heldWhy({ held: { reason } }, tDa);
      expect(said).not.toMatch(/^rsvp/);
      expect(Object.values(da)).toContain(said);
    }
    expect(heldWhy({ held: { reason: "something_new" } }, tDa)).toBe(da.rsvpHeldWhy);
    for (const k of ["rsvpHeldWhyFast", "rsvpHeldWhyLink", "rsvpHeldWhyTrap", "rsvpHeldWhyContact",
      "rsvpHeldWhyRequests", "rsvpHeldWhyBusy", "rsvpHeldWanted", "rsvpHeldDeclineBodySilent",
      "rsvpHeldDeclineBodyMail", "rsvpHeldDeclineSilentAction", "rsvpHeldApproveNoTable",
      "rsvpHeldApproveNoTime", "rsvpHeldApproveStylistTaken", "rsvpProviderAbsent",
      "rsvpAcceptOnPaused", "rsvpAcceptOnPausedToday"]) {
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
    }
    expect(heldWanted({ held: { wanted: ["Bord 1", "Bord 2"] } })).toBe("Bord 1 + Bord 2");
    expect(heldWanted({})).toBe("");
  });
});

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const soon = new Date(Date.now() + 3 * 3600000);
const later = new Date(Date.now() + 4 * 3600000);

function routes() {
  const rows = [
    { id: "held", guest_name: "Hurtig Hansen", party_size: 2, status: "requested", source: "public",
      resource_id: null, combined_resource_ids: null, allergen_tags: [], guest_mailed: false,
      held: { reason: "fast_fill", quiet: true, wanted: ["Bord 3"], pinned: false },
      starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 90 * 60000)) },
    { id: "group", guest_name: "Selskab Kragh", party_size: 12, status: "requested", source: "public",
      resource_id: null, combined_resource_ids: null, allergen_tags: [], guest_mailed: true,
      starts_at: localIso(later), ends_at: localIso(new Date(later.getTime() + 120 * 60000)) },
    { id: "away", guest_name: "Lene Kunde", party_size: 2, status: "confirmed", source: "public",
      resource_id: "t1", combined_resource_ids: null, allergen_tags: [], guest_mailed: true,
      provider_absent: true,
      starts_at: localIso(later), ends_at: localIso(new Date(later.getTime() + 90 * 60000)) },
  ];
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: { reservations_enabled: true, reservation_slug: "havnen", hours_declared: true,
        settings: { group_request_threshold: 8 }, closures: [], public_name: "Havnen" } });
    }
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: { settings: { turn_time_tiers: [] }, hours_declared: true, open_hours: {} } });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: rows, summary: { total: 3, by_status: { requested: 2, confirmed: 1 } } } });
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
  await act(async () => { fireEvent.click(screen.getAllByText("Hurtig Hansen")[0]); });
  await settle(4);
  return screen.getByTestId("rsvp-held-drawer").closest('[role="dialog"]') || document.body;
};

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.confirm.mockReset(); h.confirm.mockResolvedValue(true); h.toast.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("the book, with the server's held description", () => {
  it("labels the held row only, and the drawer says why and what it was for", async () => {
    routes();
    await openHeld();
    for (const l of screen.getAllByTestId("rsvp-held-label")) {
      const holder = l.closest("tr, [data-status], li, div[role='row']") || l.parentElement;
      expect(holder.textContent).toContain("Hurtig Hansen");
    }
    const why = screen.getByTestId("rsvp-held-drawer");
    expect(why.textContent).toContain(da.rsvpHeldWhyFast);
    expect(screen.getByTestId("rsvp-held-wanted").textContent).toBe("Booket til: Bord 3");
  });

  it("declining a held booking nobody mailed says so and mails nobody", async () => {
    routes();
    h.patch.mockResolvedValue({ data: { id: "held", status: "cancelled" } });
    const scope = await openHeld();
    const decline = [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === da.rsvpDeclineAction);
    expect(decline).toBeTruthy();
    await act(async () => { fireEvent.click(decline); });
    await settle(4);
    expect(h.confirm).toHaveBeenCalled();
    const opts = h.confirm.mock.calls[h.confirm.mock.calls.length - 1][0];
    expect(opts.message).toBe(tDa("rsvpHeldDeclineBodySilent", "", { name: "Hurtig Hansen" }));
    expect(opts.confirmLabel).toBe(da.rsvpHeldDeclineSilentAction);
    const call = h.patch.mock.calls.find(([u]) => u === "/reservations/reservations/held/status");
    expect(call).toBeTruthy();
    expect(call[1]).toMatchObject({ status: "cancelled", notify_guest: false });
  });

  it("approving one whose table went meanwhile says what to do", async () => {
    routes();
    h.patch.mockRejectedValue({ response: { status: 409, data: { detail: { error: "slot_unavailable", held: true } } } });
    const scope = await openHeld();
    const approve = [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === da.rsvpConfirmAction);
    expect(approve).toBeTruthy();
    await act(async () => { fireEvent.click(approve); });
    await settle(6);
    const said = h.toast.mock.calls.map(([o]) => (typeof o === "string" ? o : o?.message));
    expect(said.some((m) => m && m.startsWith(da.rsvpHeldApproveNoTable.split(" kl.")[0]))).toBe(true);
    expect(document.body.textContent).not.toContain("slot_unavailable");
  });

  it("flags a booking whose stylist is away that day", async () => {
    routes();
    render(
      <MemoryRouter initialEntries={["/reservations"]}>
        <ReservationsPage />
      </MemoryRouter>,
    );
    await settle();
    const flags = screen.getAllByTestId("rsvp-provider-absent");
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0].textContent).toContain(da.rsvpProviderAbsent);
    const holder = flags[0].closest("tr, [data-status], li, div[role='row']") || flags[0].parentElement;
    expect(holder.textContent).toContain("Lene Kunde");
  });
});
