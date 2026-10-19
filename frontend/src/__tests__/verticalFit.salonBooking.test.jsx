/**
 * Vertical fit (12 Oct 2026) — a salon's booking speaks appointments.
 *
 * Measured on the harness: the salon's settings were the restaurant rule set
 * (Bordtid by party size, Maks. antal gæster, Kombinér borde, guests choosing
 * a table), the website kit offered a "Book bord" button, the public page's
 * tab read "Book bord · …" and — on a closed Monday — said "Ingen ledige tider
 * de næste 14 dage" while Tuesday–Saturday were bookable. A solo stylist could
 * not add herself as a behandler from the Behandlere tab.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), user: null }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a), patch: vi.fn(), delete: vi.fn() },
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
// Stable references, as the real provider gives: the page's resource effect
// depends on hasFeature, and a new function per render re-runs it forever.
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { da } = await import("../i18n/da");

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const SETTINGS = {
  reservations_enabled: true, reservation_slug: "saks", public_url: "https://www.bonbox.dk/saks",
  business_name: "Frisør Saks", hours_declared: true,
  settings: {
    turn_time_tiers: [{ up_to: 2, minutes: 90 }], default_duration_min: 90, max_party_size: 10,
    group_request_threshold: 8, lead_time_min: 60, max_advance_days: 60, combine_enabled: true,
    guest_can_pick_table: false, booking_hours: { tue: "09:00-17:00" },
  },
};

let resources = [];
function routes(extra = {}) {
  h.get.mockImplementation((url) => {
    if (url in extra) return typeof extra[url] === "function" ? extra[url]() : Promise.resolve({ data: extra[url] });
    if (url === "/reservations/settings") return Promise.resolve({ data: SETTINGS });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources } });
    if (url === "/staff/members") return Promise.resolve({ data: [] });
    if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
    if (url.startsWith("/reservations")) return Promise.resolve({ data: {} });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset();
  resources = [];
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

const renderOwner = (path, type = "salon") => {
  h.user = { id: "u1", business_type: type, business_name: "Frisør Saks", role: "owner" };
  return render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
};

describe("booking settings follow the booking mode", () => {
  it("a salon sees appointment rules — no table time, party size, covers, combining or table picking", async () => {
    routes();
    renderOwner("/reservations?tab=settings");
    await screen.findByText(da.rsvpAcceptToggleProvider);
    expect(da.rsvpAcceptToggleProvider).toBe("Tag imod online tidsbestilling");
    for (const k of ["rsvpTableTimes", "rsvpMaxParty", "rsvpGroupThreshold", "rsvpPacing", "rsvpCombineSetting", "rsvpGuestPickSetting"]) {
      expect(screen.queryByText(da[k])).toBeNull();
    }
    expect(screen.getByText(da.rsvpLeadTimeProvider)).toBeInTheDocument();
    expect(screen.getByText(da.rsvpMaxAdvanceProvider)).toBeInTheDocument();
    // The website kit (Push 6: WebsiteBookingKit) says "Book tid" — in its
    // title, the button heading, the copied HTML and the hand-off mail.
    expect(screen.getByText(da.rsvpWebTitleProvider)).toBeInTheDocument();
    expect(screen.getByText(da.rsvpWebButtonHeading.replace("{label}", "Book tid"))).toBeInTheDocument();
    const code = [...document.querySelectorAll("pre")].map((p) => p.textContent).join("\n");
    expect(code).toContain(">Book tid</a>");
    expect(code).not.toContain("Book bord");
    const mail = decodeURIComponent(document.querySelector('a[href^="mailto:"]').getAttribute("href"));
    expect(mail).toContain('title="Book tid — Frisør Saks"');
    expect(mail).toContain(">Book tid</a>");
    expect(mail).not.toContain("Book bord");
  });

  it("a café keeps the table rules and the 'Book bord' button", async () => {
    routes();
    renderOwner("/reservations?tab=settings", "cafe");
    await screen.findByText(da.rsvpAcceptToggle);
    expect(screen.getByText(da.rsvpTableTimes)).toBeInTheDocument();
    expect(screen.getByText(da.rsvpCombineSetting)).toBeInTheDocument();
    const code = [...document.querySelectorAll("pre")].map((p) => p.textContent).join("\n");
    expect(code).toContain(">Book bord</a>");
  });
});

describe("Behandlere — 'Det er mig'", () => {
  it("a salon with no self-chair can add herself; the row follows the opening hours", async () => {
    routes();
    h.post.mockResolvedValue({ data: { id: "r1", kind: "provider", label: "Frisør Saks", follows_opening_hours: true, is_active: true } });
    renderOwner("/reservations?tab=floor");
    const cta = await screen.findByRole("button", { name: da.rsvpSelfChairCta });
    expect(da.rsvpSelfChairCta).toBe("Det er mig");
    await act(async () => { fireEvent.click(cta); });
    await settle();
    expect(h.post).toHaveBeenCalledWith("/reservations/resources", expect.objectContaining({
      kind: "provider", follows_opening_hours: true, label: "Frisør Saks", capacity_seats: 1,
    }));
    expect(screen.queryByTestId("self-chair-card")).toBeNull();
    expect(screen.getByText(da.rsvpProviderFollowsHours)).toBeInTheDocument();
  });

  it("is not offered when the list could not be read (never a second chair)", async () => {
    routes({ "/reservations/resources": () => Promise.reject(new Error("Network Error")) });
    renderOwner("/reservations?tab=floor");
    await settle();
    expect(screen.queryByTestId("self-chair-card")).toBeNull();
  });

  it("is not offered once she is a behandler", async () => {
    resources = [{ id: "r1", kind: "provider", label: "Frisør Saks", follows_opening_hours: true, is_active: true }];
    routes();
    renderOwner("/reservations?tab=floor");
    await screen.findByText(da.rsvpProviderFollowsHours);
    expect(screen.queryByTestId("self-chair-card")).toBeNull();
  });
});

describe("Aftaler — a live page with no bookable time says so", () => {
  const station = { id: "r2", kind: "provider", label: "Mia", staff_id: "s1", is_active: true };

  it("warns when the public page has no free time in 14 days", async () => {
    resources = [station];
    routes({ "/public/reservations/saks/availability-summary": { next_open_day: null, days: [{ date: "x", has_slots: false }] } });
    renderOwner("/reservations");
    await screen.findByTestId("salon-no-bookable-times");
    expect(h.get).toHaveBeenCalledWith("/public/reservations/saks/availability-summary", expect.objectContaining({
      params: expect.objectContaining({ party: 1, days: 14 }),
    }));
    expect(screen.getByText(da.rsvpProviderNoTimesTitle)).toBeInTheDocument();
  });

  it("says nothing when online booking is paused (the cap is not a missing shift)", async () => {
    // Booking push p1: at the monthly cap every day is "not_accepting" and
    // next_open_day is null — "no bookable time" would send the owner hunting
    // for unpublished shifts that are fine.
    resources = [station];
    routes({ "/public/reservations/saks/availability-summary": {
      next_open_day: null, closed_reason: "not_accepting",
      days: [{ date: "x", has_slots: false, reason: "not_accepting" }],
    } });
    renderOwner("/reservations");
    await screen.findByText(da.rsvpCoversProvider);
    await settle();
    expect(h.get).toHaveBeenCalledWith("/public/reservations/saks/availability-summary", expect.anything());
    expect(screen.queryByTestId("salon-no-bookable-times")).toBeNull();
  });

  it("says nothing when the page is bookable, and the book speaks appointments", async () => {
    resources = [station];
    routes({ "/public/reservations/saks/availability-summary": { next_open_day: "2026-10-13", days: [] } });
    renderOwner("/reservations");
    await screen.findByText(da.rsvpCoversProvider);
    await settle();
    expect(screen.queryByTestId("salon-no-bookable-times")).toBeNull();
    expect(screen.getByText(da.rsvpSeatedNowProvider)).toBeInTheDocument();
    expect(screen.queryByText(da.rsvpSeatedHelper)).toBeNull();
  });
});

describe("the public page of a salon", () => {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);

  const renderPublic = () => render(
    <MemoryRouter initialEntries={["/r/saks"]}>
      <Routes><Route path="/r/:slug" element={<ReservationPublicPage />} /></Routes>
    </MemoryRouter>,
  );

  it("jumps off a closed day instead of claiming 14 days without a time, and its tab says 'Book tid'", async () => {
    h.get.mockImplementation((url, cfg) => {
      if (url === "/public/reservations/saks") {
        return Promise.resolve({ data: { business_name: "Frisør Saks", business_type: "salon", providers: [{ id: "r1", name: "Frisør Saks" }], max_party_size: 10, max_advance_days: 60, lead_time_min: 60, language: "da" } });
      }
      if (url === "/public/reservations/saks/behandlinger") {
        return Promise.resolve({ data: { behandlinger: [{ id: "b1", name: "Dameklip", duration_min: 45, price_kr: 450 }] } });
      }
      if (url === "/public/reservations/saks/availability-summary") {
        return Promise.resolve({ data: { next_open_day: iso(tomorrow), days: [
          { date: iso(today), has_slots: false, reason: "closed_or_full" },
          { date: iso(tomorrow), has_slots: true, reason: null },
        ] } });
      }
      if (url === "/public/reservations/saks/provider-availability") {
        const slots = cfg?.params?.day === iso(tomorrow)
          ? [{ start: `${iso(tomorrow)}T10:00:00`, resource_id: "r1", staff_id: null, duration_min: 45 }]
          : [];
        return Promise.resolve({ data: { slots } });
      }
      return Promise.resolve({ data: {} });
    });
    renderPublic();
    await waitFor(() => expect(document.title).toBe("Book tid · Frisør Saks"));
    await settle(12);
    expect(h.get).toHaveBeenCalledWith("/public/reservations/saks/availability-summary", {
      params: expect.objectContaining({ party: 1 }),
    });
    expect(screen.queryByText(da.rsvpFullOrClosedWeek)).toBeNull();
    await screen.findByText("10:00");
  });
});
