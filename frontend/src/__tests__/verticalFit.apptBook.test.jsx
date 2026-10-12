/**
 * Vertical fit, review round (12 Oct 2026) — the book of a business that
 * books TIME, not tables.
 *
 * 1. BLOCKER: a café that became a salon in Profile opened Tidsbestilling →
 *    Aftaler and saw ONLY the salon first-run card. The card replaced the
 *    whole book, so the café's bookings and its waitlist were out of sight
 *    (GET /reservations/book still returned them). The card is for a book
 *    with nothing in it; bookings always render — as table bookings when
 *    they hold a table.
 * 7. A shop or a workshop that switches Reservations on books customers for
 *    a time. Decision: it speaks the salon's appointment words (Tidsbestilling
 *    · Aftaler · Kunder · Book tiden · "når en tid bliver ledig") and its
 *    settings drop the table rules — the booking engine is unchanged. Nothing
 *    on these screens says "bord" to a business that has no tables.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { da } = await import("../i18n/da");

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

const SETTINGS = {
  reservations_enabled: true, reservation_slug: "shop", public_url: "https://www.bonbox.dk/r/shop",
  business_name: "Butik Nord", hours_declared: true,
  settings: {
    turn_time_tiers: [{ up_to: 2, minutes: 60 }], default_duration_min: 60, max_party_size: 10,
    group_request_threshold: 8, lead_time_min: 60, max_advance_days: 60, combine_enabled: true,
    guest_can_pick_table: false, booking_hours: { mon: "00:00-23:59", tue: "00:00-23:59", wed: "00:00-23:59", thu: "00:00-23:59", fri: "00:00-23:59", sat: "00:00-23:59", sun: "00:00-23:59" },
  },
};

// Today's book: one booking due in an hour, one guest already in.
function bookRows({ table = null } = {}) {
  const now = new Date();
  const soon = new Date(now.getTime() + 60 * 60000);
  const earlier = new Date(now.getTime() - 20 * 60000);
  return [
    { id: "b1", guest_name: "Hansen", party_size: 2, status: "confirmed", resource_id: table, combined_resource_ids: null,
      starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 60 * 60000)), source: "manual" },
    { id: "b2", guest_name: "Jensen", party_size: 1, status: "seated", resource_id: null, combined_resource_ids: null,
      starts_at: localIso(earlier), ends_at: localIso(new Date(earlier.getTime() + 60 * 60000)), source: "manual" },
  ];
}
const WAITING = { id: "w1", guest_name: "Nielsen", guest_phone: "+4520000000", party_size: 1, status: "waiting", waitlist_date: "x" };

let resources = [];
let bookHasEntries = true;
let rows = [];
let waitlist = [];
function routes() {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: SETTINGS });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources, fixtures: [], book_has_entries: bookHasEntries } });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { reservations: rows, summary: { total: rows.length, covers: 3, by_status: { confirmed: 1, seated: 1 } } } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist, active_count: waitlist.length } });
    if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
    if (url === "/staff/members") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  resources = []; bookHasEntries = true; rows = []; waitlist = [];
  routes();
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

const renderOwner = (path, type) => {
  h.user = { id: "u1", business_type: type, business_name: "Butik Nord", role: "owner" };
  return render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
};
// "bord", "borde", "bordet", "til bords", "Bordtid" … — any of them (not the
// CSS "border" in the website kit's copy-paste code).
const BORD = /\bbord(?!er)|til bords/i;
const pageText = () => document.body.textContent || "";
const ariaText = () => [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
  .map((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")].filter(Boolean).join(" "))
  .join(" | ");

describe("1 · a café that became a salon keeps its book", () => {
  it("bookings and the waitlist render; the first-run card does not replace them", async () => {
    // The café's tables are still there; no behandler yet.
    resources = [{ id: "t4", kind: "table", label: "Bord 4", capacity_seats: 4, is_active: true }];
    rows = bookRows({ table: "t4" });
    waitlist = [WAITING];
    renderOwner("/reservations", "salon");
    await settle(14);
    expect(screen.queryByText(da.rsvpSalonFirstRunTitle)).toBeNull();
    expect(screen.getAllByText("Hansen").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Jensen").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nielsen").length).toBeGreaterThan(0);
    // The booking that holds a table renders as a table booking.
    expect(screen.getAllByText("Bord 4").length).toBeGreaterThan(0);
    // …and the owner is pointed at the step that opens online booking.
    const nudge = screen.getByTestId("salon-setup-nudge");
    expect(within(nudge).getByText(da.rsvpProviderSetupTitle)).toBeInTheDocument();
    expect(within(nudge).getByRole("link", { name: new RegExp(da.rsvpProviderNoTimesCta) }).getAttribute("href"))
      .toBe("/reservations?tab=floor");
  });

  it("an empty book — nothing ever, nothing waiting — still gets the first-run card", async () => {
    bookHasEntries = false;
    renderOwner("/reservations", "salon");
    await settle(14);
    expect(screen.getByText(da.rsvpSalonFirstRunTitle)).toBeInTheDocument();
    expect(screen.queryByTestId("salon-setup-nudge")).toBeNull();
  });

  it("a book the server says holds bookings (another day) is shown, not replaced", async () => {
    bookHasEntries = true; // last week's bookings — today is empty
    renderOwner("/reservations", "salon");
    await settle(14);
    expect(screen.queryByText(da.rsvpSalonFirstRunTitle)).toBeNull();
    expect(screen.getByTestId("salon-setup-nudge")).toBeInTheDocument();
  });

  it("an old API without the field shows the book (unknown never hides it)", async () => {
    bookHasEntries = undefined;
    renderOwner("/reservations", "salon");
    await settle(14);
    expect(screen.queryByText(da.rsvpSalonFirstRunTitle)).toBeNull();
  });
});

describe("7 · shops and workshops speak appointments", () => {
  it.each(["clothing", "workshop"])("%s: the book says Aftaler / Kunder / Tjek ind — never 'bord'", async (type) => {
    rows = bookRows();
    waitlist = [WAITING];
    renderOwner("/reservations", type);
    await settle(14);
    expect(screen.getAllByText("Hansen").length).toBeGreaterThan(0);
    expect(screen.getByText(da.rsvpOwnerTitleProvider)).toBeInTheDocument();
    expect(screen.getAllByText(da.rsvpTabBookProvider).length).toBeGreaterThan(0);
    expect(screen.getByText(da.rsvpCoversProvider)).toBeInTheDocument();
    // Not the salon's chair words either.
    expect(screen.queryByText(da.rsvpSeatedNowProvider)).toBeNull();
    expect(screen.getByText(da.rsvpSeatedNowAppt)).toBeInTheDocument();
    expect(pageText()).not.toMatch(BORD);
    expect(ariaText()).not.toMatch(BORD);
    // The booking's drawer too.
    await act(async () => { fireEvent.click(screen.getAllByText("Hansen")[0]); });
    await settle(4);
    expect(pageText()).not.toMatch(BORD);
    expect(ariaText()).not.toMatch(BORD);
  });

  it("a salon's book has no 'bord' either", async () => {
    resources = [{ id: "r2", kind: "provider", label: "Mia", staff_id: "s1", is_active: true }];
    rows = bookRows();
    waitlist = [WAITING];
    renderOwner("/reservations", "salon");
    await settle(14);
    expect(screen.getAllByText("Hansen").length).toBeGreaterThan(0);
    expect(pageText()).not.toMatch(BORD);
    expect(ariaText()).not.toMatch(BORD);
  });

  it("a shop's settings drop the table rules and speak to customers", async () => {
    renderOwner("/reservations?tab=settings", "clothing");
    await screen.findByText(da.rsvpAcceptToggleProvider);
    await settle(6);
    for (const k of ["rsvpTableTimes", "rsvpMaxParty", "rsvpGroupThreshold", "rsvpPacing", "rsvpCombineSetting", "rsvpGuestPickSetting"]) {
      expect(screen.queryByText(da[k])).toBeNull();
    }
    expect(screen.getByText(da.rsvpLeadTimeProvider)).toBeInTheDocument();
    expect(pageText()).not.toMatch(BORD);
    expect(ariaText()).not.toMatch(BORD);
  });

  it("a café keeps the table words (unchanged)", async () => {
    resources = [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }];
    rows = bookRows({ table: "t1" });
    renderOwner("/reservations", "cafe");
    await settle(14);
    expect(screen.getByText(da.rsvpOwnerTitle)).toBeInTheDocument();
    expect(screen.getAllByText(da.rsvpSeatAction).length).toBeGreaterThan(0);
  });

  it("a shop's public page says Book tid, not Book bord", async () => {
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/shop") {
        return Promise.resolve({ data: { business_name: "Butik Nord", business_type: "clothing", max_party_size: 10, max_advance_days: 60, lead_time_min: 60, language: "da" } });
      }
      if (url === "/public/reservations/shop/availability-summary") return Promise.resolve({ data: { next_open_day: null, days: [] } });
      return Promise.resolve({ data: { slots: [] } });
    });
    render(
      <MemoryRouter initialEntries={["/r/shop"]}>
        <Routes><Route path="/r/:slug" element={<ReservationPublicPage />} /></Routes>
      </MemoryRouter>,
    );
    await settle(14);
    expect(document.title).toBe("Book tid · Butik Nord");
    expect(pageText()).not.toMatch(BORD);
    expect(ariaText()).not.toMatch(BORD);
  });
});
