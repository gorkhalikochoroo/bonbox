/**
 * Push 7 — online booking for a venue the engine cannot book.
 *
 * QA: Butik → Tidsbestilling → Indstillinger → "Tag imod online
 * tidsbestilling" on → hours 09–18 → Gem, and Settings said "Din offentlige
 * side er live og tager imod bookinger." while /r/<slug> showed every day
 * closed: the availability engine (reservation_service.available_slots)
 * books active tables and active behandler stations only, and a shop or a
 * workshop (booking mode "none": no Floor tab, no behandler) has neither.
 *
 * Settings is now honest for exactly that venue: the online switch is not
 * offered as working, nothing says "live", and while it is still on it says
 * customers can't book yet and keeps the switch to turn it off. Every other
 * venue — and a shop whose resources could not be read — is unchanged. The
 * book and the waitlist are untouched.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), user: null }));
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
  return { ...real, useAuth: () => ({ user: h.user, logout: vi.fn(), refreshUser: vi.fn() }) };
});
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const HOURS = { mon: "09:00-18:00", tue: "09:00-18:00", wed: "09:00-18:00", thu: "09:00-18:00", fri: "09:00-18:00", sat: "closed", sun: "closed" };
let enabled = true;
let resources = [];
let resourcesFail = false;
const settingsBody = () => ({
  reservations_enabled: enabled, reservation_slug: "butik-nord", public_url: "https://www.bonbox.dk/butik-nord",
  business_name: "Butik Nord", hours_declared: true,
  settings: { max_party_size: 8, group_request_threshold: 8, lead_time_min: 60, max_advance_days: 60, default_duration_min: 60,
    turn_time_tiers: [], combine_enabled: true, guest_can_pick_table: false, booking_hours: HOURS },
});

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  enabled = true; resources = []; resourcesFail = false;
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: settingsBody() });
    if (url === "/reservations/resources") {
      return resourcesFail
        ? Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }))
        : Promise.resolve({ data: { resources, fixtures: [], book_has_entries: true } });
    }
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: [], summary: { total: 0, covers: 0, by_status: {} } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
    if (url === "/staff/members") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
  h.put.mockImplementation((url, body) => {
    if (url === "/reservations/settings" && typeof body?.reservations_enabled === "boolean") enabled = body.reservations_enabled;
    return Promise.resolve({ data: settingsBody() });
  });
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
});
afterEach(() => cleanup());

const openSettings = async (type) => {
  h.user = { id: "u1", business_type: type, business_name: "Butik Nord", role: "owner" };
  render(<MemoryRouter initialEntries={["/reservations?tab=settings"]}><ReservationsPage /></MemoryRouter>);
  await screen.findByTestId("website-booking-kit");
  await settle(8);
};
const onlineSwitch = () => screen.queryByRole("switch", { name: /Tag imod online/ });
const kit = () => screen.getByTestId("website-booking-kit");

describe("the words (real Danish and English)", () => {
  it("every new line exists in both dictionaries and never says live", () => {
    for (const k of ["rsvpOnlineNotReadyProvider", "rsvpOnlineNotReady", "rsvpOnlineNotReadyOn", "rsvpWebNotReadyProvider", "rsvpWebNotReady"]) {
      expect(typeof da[k], k).toBe("string");
      expect(typeof en[k], k).toBe("string");
      expect(da[k]).not.toMatch(/live/i);
      expect(en[k]).not.toMatch(/live/i);
    }
    expect(da.rsvpOnlineNotReadyProvider).toBe("Online tidsbestilling er ikke klar til butikker og værksteder endnu — du kan stadig skrive tider ind i bogen her.");
  });
});

describe("a shop with no table and no behandler — switched ON (the QA repro)", () => {
  it("says customers can't book yet, never 'live'; the switch stays, to turn it off", async () => {
    await openSettings("clothing");
    const note = screen.getByTestId("rsvp-online-not-ready");
    expect(note).toHaveAttribute("role", "status");
    expect(within(note).getByText(da.rsvpOnlineNotReadyOn)).toBeInTheDocument();
    expect(within(note).getByText(da.rsvpOnlineNotReadyProvider)).toBeInTheDocument();
    expect(screen.queryByText(da.rsvpAcceptOn)).toBeNull();
    expect(document.body.textContent).not.toMatch(/er live/);
    expect(onlineSwitch()).toHaveAttribute("aria-checked", "true");
    // Not live: no "Din bookingside", and the kit hands out no link.
    expect(screen.queryByTestId("rsvp-share-card")).toBeNull();
    expect(within(kit()).getByText(da.rsvpWebNotReadyProvider)).toBeInTheDocument();
    expect(within(kit()).queryByTestId("website-link")).toBeNull();
    expect(within(kit()).queryByRole("tablist")).toBeNull();
  });

  it("turning it off sends reservations_enabled:false; then no switch, only the note", async () => {
    await openSettings("clothing");
    await act(async () => { fireEvent.click(onlineSwitch()); });
    await settle(4);
    expect(h.put).toHaveBeenCalledWith("/reservations/settings", { reservations_enabled: false });
    expect(onlineSwitch()).toBeNull();
    const note = screen.getByTestId("rsvp-online-not-ready");
    expect(within(note).queryByText(da.rsvpOnlineNotReadyOn)).toBeNull();
    expect(within(note).getByText(da.rsvpOnlineNotReadyProvider)).toBeInTheDocument();
  });
});

describe("a shop or a workshop with nothing to book — switched OFF", () => {
  it.each(["clothing", "workshop"])("%s: the switch is not offered; the note says why; the kit does not point at a switch", async (type) => {
    enabled = false;
    await openSettings(type);
    expect(onlineSwitch()).toBeNull();
    expect(screen.getByText(da.rsvpOnlineNotReadyProvider)).toBeInTheDocument();
    expect(screen.queryByText(da.rsvpAcceptOff)).toBeNull();
    expect(within(kit()).queryByText(da.rsvpWebOffProvider)).toBeNull();
    expect(within(kit()).getByText(da.rsvpWebNotReadyProvider)).toBeInTheDocument();
    // The rest of Settings is still there (hours, the shop's own rules).
    expect(screen.getByText(da.rsvpLeadTimeProvider)).toBeInTheDocument();
  });

  it("a bakery (no table plan, table words) gets the same honesty in its own words", async () => {
    enabled = false;
    await openSettings("bakery");
    expect(onlineSwitch()).toBeNull();
    expect(screen.getByText(da.rsvpOnlineNotReady)).toBeInTheDocument();
    expect(within(kit()).getByText(da.rsvpWebNotReady)).toBeInTheDocument();
  });

  it("an inactive table is nothing the engine books either", async () => {
    resources = [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: false }];
    await openSettings("clothing");
    expect(screen.getByTestId("rsvp-online-not-ready")).toBeInTheDocument();
  });
});

describe("everyone else is unchanged", () => {
  it("a shop with an active table keeps the switch and its live line", async () => {
    resources = [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }];
    await openSettings("clothing");
    expect(screen.queryByTestId("rsvp-online-not-ready")).toBeNull();
    expect(screen.getByText(da.rsvpAcceptOn)).toBeInTheDocument();
    expect(onlineSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("rsvp-share-card")).toBeInTheDocument();
  });

  it("a shop with an active behandler station keeps the switch", async () => {
    resources = [{ id: "p1", kind: "provider", label: "Mette", staff_id: "s1", is_active: true }];
    await openSettings("clothing");
    expect(screen.queryByTestId("rsvp-online-not-ready")).toBeNull();
    expect(onlineSwitch()).toBeInTheDocument();
  });

  it("resources that could not be read are not 'none': the switch as before", async () => {
    resourcesFail = true;
    await openSettings("clothing");
    expect(screen.queryByTestId("rsvp-online-not-ready")).toBeNull();
    expect(onlineSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it.each([["cafe", "rsvpAcceptToggle"], ["salon", "rsvpAcceptToggleProvider"]])(
    "%s with nothing set up yet: its own flows, not this note",
    async (type, toggleKey) => {
      await openSettings(type);
      expect(screen.queryByTestId("rsvp-online-not-ready")).toBeNull();
      expect(screen.getByRole("switch", { name: da[toggleKey] })).toBeInTheDocument();
    },
  );
});

describe("the book and the waitlist keep working for the shop", () => {
  it("the book opens with 'Book en tid' and the waitlist, exactly as before", async () => {
    h.user = { id: "u1", business_type: "clothing", business_name: "Butik Nord", role: "owner" };
    render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
    await settle(14);
    expect(screen.queryByTestId("rsvp-online-not-ready")).toBeNull();
    expect(screen.getAllByRole("button", { name: new RegExp(da.rsvpNewBookingProvider) }).length).toBeGreaterThan(0);
    expect(h.get).toHaveBeenCalledWith("/reservations/waitlist", expect.anything());
  });
});
