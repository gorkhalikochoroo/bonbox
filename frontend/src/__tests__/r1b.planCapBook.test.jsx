/**
 * R1b (27 Oct 2026) — the owner's book at the plan's monthly cap.
 *
 *   • The settings say the month's bookings are at the cap and the cap takes
 *     requests: the book shows the amber banner ("Månedens 20 bookinger er
 *     brugt … Din bookingside er stadig åben …") with the upgrade nudge.
 *   • A booking held because of the cap (held.reason "plan_cap"): the drawer
 *     names the cap and carries the nudge.
 *   • Below the cap, or a server that says nothing about it: no banner.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "free", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useToast", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useToast: () => h.toast };
});

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");

const tDa = (k, vars) => {
  let s = da[k] ?? k;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const soon = new Date(Date.now() + 3 * 3600000);

function routes({ cap = 20, used = 20, mode = "requests", held = { reason: "plan_cap", quiet: false, bot: false, wanted: ["Bord 1"], pinned: false, limit: 20 } } = {}) {
  const rows = [
    { id: "held", guest_name: "Rikke Rigtig", party_size: 2, status: "requested", source: "public",
      resource_id: null, combined_resource_ids: null, allergen_tags: [], guest_mailed: true,
      held, starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 90 * 60000)) },
  ];
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      const data = { reservations_enabled: true, reservation_slug: "havnen", hours_declared: true,
        settings: { group_request_threshold: 8 }, closures: [], public_name: "Havnen" };
      if (cap !== null) Object.assign(data, { reservations_cap: cap, reservations_used_this_month: used, month_cap_mode: mode });
      return Promise.resolve({ data });
    }
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: { settings: { turn_time_tiers: [] }, hours_declared: true, open_hours: {} } });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: rows, summary: { total: 1, by_status: { requested: 1 } } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
}

const renderBook = async () => {
  render(
    <MemoryRouter initialEntries={["/reservations"]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
  await settle();
};

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.confirm.mockReset(); h.confirm.mockResolvedValue(true); h.toast.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("the book at the plan's monthly cap", () => {
  it("shows the banner: the page stays open, requests to confirm, and the nudge", async () => {
    routes();
    await renderBook();
    const b = screen.getByTestId("plan-cap-banner");
    expect(b.textContent).toContain(tDa("rsvpPlanCapTitle", { n: 20 }));
    expect(b.textContent).toContain(da.rsvpPlanCapRequestsBody);
    expect(b.querySelector('a[href="/subscription"]')).toBeTruthy();
  });

  it("a cap that closes the page says that instead", async () => {
    routes({ mode: "closed" });
    await renderBook();
    expect(screen.getByTestId("plan-cap-banner").textContent).toContain(da.rsvpPlanCapClosedBody);
  });

  it("no banner below the cap, or from a server that says nothing about it", async () => {
    routes({ used: 12 });
    await renderBook();
    expect(screen.queryByTestId("plan-cap-banner")).toBeNull();
    cleanup();
    routes({ cap: null });           // an older server: no cap fields at all
    await renderBook();
    expect(screen.queryByTestId("plan-cap-banner")).toBeNull();
  });

  it("the drawer of a booking held at the cap names the cap and carries the nudge", async () => {
    routes();
    await renderBook();
    await act(async () => { fireEvent.click(screen.getAllByText("Rikke Rigtig")[0]); });
    await settle(4);
    const drawer = screen.getByTestId("rsvp-held-drawer");
    expect(drawer.textContent).toContain(tDa("rsvpHeldWhyPlanCap", { n: 20 }));
    const nudge = screen.getByTestId("plan-cap-held-nudge");
    expect(nudge.querySelector('a[href="/subscription"]').textContent).toContain(da.rsvpPlanCapNudge);
  });

  it("a booking held for another reason gets no nudge", async () => {
    routes({ used: 3, held: { reason: "venue_day", quiet: false, bot: false, wanted: [], pinned: false } });
    await renderBook();
    await act(async () => { fireEvent.click(screen.getAllByText("Rikke Rigtig")[0]); });
    await settle(4);
    expect(screen.getByTestId("rsvp-held-drawer").textContent).toContain(da.rsvpHeldWhyDay);
    expect(screen.queryByTestId("plan-cap-held-nudge")).toBeNull();
  });
});
