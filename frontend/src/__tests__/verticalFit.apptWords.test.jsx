/**
 * Push 8 review (round 4) — item 8 was still not met (QA, 14 Oct 2026). A
 * shop or a workshop books CUSTOMERS for a TIME; QA found restaurant words on
 * five more surfaces:
 *
 *   • Indsigt: "BOOKEDE GÆSTER · Baseret på bookede gæster", "Hvor
 *     reservationer kommer fra", "Reservationer og gæster pr. måned" with the
 *     columns "Reservationer | Gæster" (en: "Booked guests", "Guests").
 *   • The counter screen's ⋯ menu: "Installér på enheden · Åbner direkte på
 *     vært-skærmen" under the header "Skærm ved disken".
 *   • "Book en tid": "BORD (VALGFRIT — VÆLGES AUTOMATISK)" over "Plads 1 · 1",
 *     and "ALLERGI (VALGFRI) · fx nødder, gluten" — which the server stored.
 *   • The public page after booking: "Aflys reservationen", "Aflys
 *     reservationen? … Behold reservationen", "Reservation aflyst" and the
 *     tab "Reservation aflyst · Cykelværkstedet Amager".
 *
 * And four minor ones: the check-in sheet opened on 2 people and pre-joined
 * two places; a checked-in customer's place read "Pl…" at 360 px; the door
 * iPad (1024 px) cut "3 selska…" in the stand header; and the settings
 * offered two online party-size rules the public page can never apply.
 *
 * Control cases: a restaurant and a café keep every word and control.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), user: null, lang: "da", confirm: null,
}));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    patch: (...a) => h.patch(...a), delete: vi.fn(),
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    const dict = h.lang === "en" ? EN : DA;
    let s = dict[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: h.lang, setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: h.user, logout: vi.fn(), refreshUser: vi.fn() }) };
});
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({ hiddenPillars: new Set(), isReady: true, setPillarHidden: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../hooks/useUndoToast", () => ({ useUndoToast: () => ({ show: vi.fn(), ToastUI: null }) }));
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const InsightsSection = (await import("../components/reservations/InsightsSection")).default;
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pageText = () => (document.body.textContent || "").replace(/Plads \d+/g, "");
const ariaText = () => [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
  .map((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")].filter(Boolean).join(" "))
  .join(" | ")
  .replace(/Plads \d+/g, "");
// The restaurant words QA found on a shop's or a workshop's surfaces.
const DA_RESTAURANT = /gæst|reservation|bord|selskab|couvert|kuvert|køkken|vært-skærm|nødder|frokost/i;
const EN_RESTAURANT = /guest|reservation|table|party|kitchen|\bcovers?\b|host stand|lunch|dinner/i;

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.lang = "da";
  h.confirm = vi.fn().mockResolvedValue(true);
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

// ── Indsigt ───────────────────────────────────────────────────────────────

const INSIGHTS = {
  utilization: { confidence: "confident", seat_hour_pct: 42, booked_covers: 31 },
  heatmap: {
    confidence: "confident",
    weekdays: ["Mon", "Tue"],
    day_parts: ["Morning", "Lunch", "Afternoon", "Dinner", "Late"],
    cells: [
      { weekday_index: 0, day_part: "Lunch", covers: 5, low_confidence: false },
      { weekday_index: 1, day_part: "Dinner", covers: 3, low_confidence: false },
    ],
  },
  no_show_rate: {
    confidence: "confident", rate: 0.2, no_shows: 2, denominator: 10,
    by_lead_time: [{ bucket: "same_day", confidence: "confident", rate: 0.1, no_shows: 1, denominator: 10 }],
  },
  source_mix: {
    confidence: "confident", total: 10,
    sources: [
      { source: "public", count_share: 0.5, covers: 5 },
      { source: "manual", count_share: 0.3, covers: 3 },
      { source: "walk_in", count_share: 0.2, covers: 2 },
    ],
  },
  party_size_fit: {
    confidence: "confident",
    party_histogram: [{ bin: "1-2", count: 8 }, { bin: "3-4", count: 1 }],
    capacity_histogram: [{ bin: "1-2", count: 3 }],
  },
  recovered: { confidence: "confident", recovered_covers: 2, recovered_bookings: 2, kr: null },
  forecast: { days: [{ date: "2026-10-15", weekday: "Wed", predicted_covers: 4, same_weekday_samples: 3 }] },
  forecast_locked: false,
};
const MONTHLY = { months: [{ month: "2026-10", bookings: 12, guests: 12, cancelled: 0, no_shows: 1, online: 4, current: true }] };

function insightsRoutes(payload = INSIGHTS) {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/insights") return Promise.resolve({ data: payload });
    if (url === "/reservations/monthly") return Promise.resolve({ data: MONTHLY });
    return Promise.resolve({ data: {} });
  });
}
const renderInsights = (type, lang = "da") => {
  h.lang = lang;
  h.user = { id: "u1", business_type: type, business_name: "Cykelværkstedet Amager", role: "owner" };
  const dict = lang === "en" ? en : da;
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = dict[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return render(<MemoryRouter><InsightsSection t={t} /></MemoryRouter>);
};

describe("8 · Indsigt counts appointments and customers on a shop and a workshop", () => {
  it.each(["workshop", "clothing"])("%s (da): no guests, reservations, tables or lunch", async (type) => {
    insightsRoutes();
    renderInsights(type);
    await settle(12);
    // Every card is on screen — the words are checked, not skipped.
    for (const k of [
      "rsvpInsKpiCoversAppt", "rsvpInsBookedBasisAppt", "rsvpInsKpiOnlineHelpAppt", "rsvpInsHeatmapSubAppt",
      "rsvpInsPartLunchAppt", "rsvpInsPartyTitleAppt", "rsvpInsPartyDemandAppt", "rsvpInsPartySupplyAppt",
      "rsvpInsSourceTitleAppt", "rsvpInsSourceSubAppt", "rsvpInsNoShowSubAppt", "rsvpInsRecoveredSubAppt",
      "rsvpInsRecoveredGuestsAppt", "rsvpInsRecoveredNoKrAppt", "rsvpInsForecastSubAppt",
      "rsvpMonthlySubAppt", "rsvpMonthlyBookingsAppt", "rsvpMonthlyGuestsAppt",
    ]) {
      expect(pageText(), k).toContain(da[k]);
    }
    expect(pageText()).toContain(da.rsvpInsNoShowOfAppt.replace("{n}", "2").replace("{d}", "10"));
    expect(pageText()).not.toMatch(DA_RESTAURANT);
    expect(ariaText()).not.toMatch(DA_RESTAURANT);
  });

  it("workshop (en): customers and appointments, no guests", async () => {
    insightsRoutes();
    renderInsights("workshop", "en");
    await settle(12);
    expect(pageText()).toContain(en.rsvpInsKpiCoversAppt);
    expect(pageText()).toContain(en.rsvpMonthlySubAppt);
    expect(pageText()).not.toMatch(EN_RESTAURANT);
    expect(ariaText()).not.toMatch(EN_RESTAURANT);
  });

  it("collecting data: 'Efterhånden som der kommer aftaler ind'", async () => {
    insightsRoutes({});
    renderInsights("workshop");
    await settle(12);
    expect(pageText()).toContain(da.rsvpInsCollectingBodyAppt);
    expect(pageText()).not.toMatch(DA_RESTAURANT);
  });

  it("a restaurant keeps guests, reservations and tables (unchanged)", async () => {
    insightsRoutes();
    renderInsights("restaurant");
    await settle(12);
    for (const k of ["rsvpInsKpiCovers", "rsvpInsHeatmapSub", "rsvpInsPartyTitle", "rsvpInsSourceTitle",
      "rsvpInsNoShowSub", "rsvpMonthlySub", "rsvpMonthlyBookings", "rsvpMonthlyGuests", "rsvpInsPartLunch"]) {
      expect(document.body.textContent, k).toContain(da[k]);
    }
    expect(document.body.textContent).not.toMatch(/aftale|kunde/i);
  });
});

// ── The owner's book: menu, Book en tid, check-in, rows, header ───────────

const SETTINGS = {
  reservations_enabled: true, reservation_slug: "v", public_url: "https://www.bonbox.dk/r/v",
  business_name: "Cykelværkstedet Amager", hours_declared: true,
  settings: {
    turn_time_tiers: [{ up_to: 2, minutes: 60 }], default_duration_min: 60, max_party_size: 10,
    group_request_threshold: 8, lead_time_min: 60, max_advance_days: 60, combine_enabled: true,
    guest_can_pick_table: false,
    booking_hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, "00:00-23:59"])),
  },
};
const place = (id, label, seats = 2) => ({ id, kind: "table", label, capacity_seats: seats, is_active: true, zone: null, pos_x: 20, pos_y: 20, combinable: true });
function bookRows() {
  const now = new Date();
  const earlier = new Date(now.getTime() - 20 * 60000);
  return [
    { id: "b1", guest_name: "Peter Hansen", party_size: 1, status: "confirmed", resource_id: "p2", combined_resource_ids: null,
      starts_at: localIso(new Date(now.getTime() + 10 * 60000)), ends_at: localIso(new Date(now.getTime() + 130 * 60000)), source: "manual" },
    { id: "b2", guest_name: "Sofie", party_size: 1, status: "seated", resource_id: "p1", combined_resource_ids: null,
      starts_at: localIso(earlier), ends_at: localIso(new Date(earlier.getTime() + 60 * 60000)), source: "manual",
      seated_at: earlier.toISOString() },
  ];
}
let resources = [];
let rows = [];
function ownerRoutes() {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: SETTINGS });
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: SETTINGS });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources, fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { reservations: rows, summary: { total: rows.length, covers: 2, by_status: {} } } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
    if (url === "/stand/links") return Promise.resolve({ data: { devices: [] } });
    if (url === "/staff/members") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
  h.post.mockImplementation((url, body) => Promise.resolve({ data: { id: "x", status: "confirmed", ...body } }));
}
const renderOwner = (path, type) => {
  h.user = { id: "u1", business_type: type, business_name: "Cykelværkstedet Amager", role: "owner" };
  ownerRoutes();
  return render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
};

beforeEach(() => {
  resources = [place("p1", "Plads 1", 1), place("p2", "Plads 2", 2), place("p3", "Plads 3", 1), place("p4", "Plads 4", 1)];
  rows = bookRows();
});

describe("8 · the counter screen's ⋯ menu", () => {
  const openMenu = async (type) => {
    renderOwner("/reservations/stand", type);
    await settle(16);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpStandMore })); });
    await settle(2);
    return screen.getByRole("menu");
  };

  it("a workshop's install row opens the counter screen, not the host stand", async () => {
    const menu = await openMenu("workshop");
    expect(menu.textContent).toContain(da.rsvpStandInstallHintAppt);
    expect(menu.textContent).not.toMatch(/vært-skærm/i);
  });

  it("a restaurant's says 'vært-skærmen' (unchanged)", async () => {
    const menu = await openMenu("restaurant");
    expect(menu.textContent).toContain(da.rsvpStandInstallHint);
  });
});

describe("8 · 'Book en tid' on a workshop: a place, and no allergy", () => {
  const openForm = async (type) => {
    renderOwner("/reservations", type);
    await settle(16);
    const label = type === "restaurant" ? da.rsvpNewBooking : da.rsvpNewBookingProvider;
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: label })[0]); });
    await settle(4);
    return screen.getByRole("dialog", { name: label });
  };

  it.each(["workshop", "clothing"])("%s: 'Plads (valgfrit …)', no allergy field, and none is sent", async (type) => {
    const dialog = await openForm(type);
    expect(dialog.textContent).toContain(da.rsvpBookingTableOptionalAppt);
    expect(within(dialog).getByLabelText(da.rsvpBookingTableOptionalAppt)).toBeInTheDocument();
    expect(dialog.querySelector("#nb-allergy")).toBeNull();
    const words = dialog.textContent.replace(/Plads \d+/g, "");
    expect(words).not.toMatch(/bord|allergi|nødder|gæst/i);
    // Create: no allergy reaches the server.
    fireEvent.change(within(dialog).getByLabelText(da.rsvpNbGuestNameProvider), { target: { value: "Sofie" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: da.rsvpCreateBookingProvider })); });
    await settle(4);
    const call = h.post.mock.calls.find(([u]) => u === "/reservations/book");
    expect(call, "the booking was posted").toBeTruthy();
    expect(call[1].allergy_note ?? null).toBeNull();
    expect(call[1].allergy_severity ?? null).toBeNull();
  });

  it("a missing name asks for the customer's, not the guest's", async () => {
    const dialog = await openForm("workshop");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: da.rsvpCreateBookingProvider })); });
    await settle(2);
    expect(dialog.textContent).toContain(da.rsvpOwnerGuestNameRequiredAppt);
    expect(dialog.textContent).not.toContain(da.rsvpOwnerGuestNameRequired);
  });

  it("a restaurant keeps 'Bord (valgfrit …)' and its allergy field (unchanged)", async () => {
    resources = [place("t1", "Bord 1", 4)];
    const dialog = await openForm("restaurant");
    expect(dialog.textContent).toContain(da.rsvpBookingTableOptional);
    expect(dialog.querySelector("#nb-allergy")).not.toBeNull();
    expect(dialog.querySelector("#nb-allergy").getAttribute("placeholder")).toBe(da.rsvpNewAllergyPh);
  });
});

describe("check-in sheet on a shop: one customer, one place (review minor)", () => {
  const openSheet = async (type, name) => {
    renderOwner("/reservations/stand", type);
    await settle(16);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name })[0]); });
    await settle(4);
  };

  it("opens on 1 person and pre-picks one free place, never two joined", async () => {
    await openSheet("clothing", da.rsvpSeatWalkInAppt);
    const dialog = screen.getByRole("dialog", { name: da.rsvpSeatNowTitleAppt });
    expect(within(dialog).getByRole("button", { name: da.rsvpPersonOne, pressed: true })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: da.rsvpPersonN.replace("{n}", "2"), pressed: true })).toBeNull();
    const select = within(dialog).getByLabelText(da.rsvpSeatWalkInTableAppt);
    expect(["p3", "p4"]).toContain(select.value);
    expect(dialog.textContent).not.toMatch(/pladser sammen/);
  });

  it("a restaurant's header sheet still opens on 2 guests (unchanged)", async () => {
    resources = [place("t1", "Bord 1", 2), place("t2", "Bord 2", 4)];
    rows = [];
    await openSheet("restaurant", da.rsvpSeatWalkIn);
    const dialog = screen.getByRole("dialog", { name: da.rsvpSeatNowTitle });
    expect(within(dialog).getByRole("button", { name: da.rsvpPartyN.replace("{n}", "2"), pressed: true })).toBeInTheDocument();
  });
});

describe("a checked-in customer keeps the place's name on a phone row (review minor)", () => {
  const rowOf = (name) =>
    [...document.querySelectorAll('[role="button"][data-status]')].find((el) => el.textContent.includes(name));

  it("the shop's checked-in row may wrap, so the status goes under 'Plads 1' — never 'Pl…'", async () => {
    renderOwner("/reservations/stand", "workshop");
    await settle(16);
    const meta = rowOf("Sofie").querySelector("[data-row-meta]");
    expect(meta.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(meta.textContent).toContain("Plads 1");
    expect(meta.textContent).toContain(da.rsvpStatusSeatedAppt);
    // A booked (not yet checked-in) customer keeps the one line.
    expect(rowOf("Peter Hansen").querySelector("[data-row-meta]").className).not.toMatch(/flex-wrap/);
  });

  it("a restaurant's seated row keeps its one line (unchanged)", async () => {
    resources = [place("p1", "Bord 1", 2), place("p2", "Bord 2", 2)];
    renderOwner("/reservations/stand", "restaurant");
    await settle(16);
    expect(rowOf("Sofie").querySelector("[data-row-meta]").className).not.toMatch(/flex-wrap/);
  });
});

describe("the door iPad's stand header keeps its counts whole (review minor)", () => {
  it("from lg the covers do not shrink — the venue name gives way, as on 7a631c0f", async () => {
    renderOwner("/reservations/stand", "restaurant");
    await settle(16);
    const covers = document.querySelector("[data-stand-covers]");
    expect(covers).not.toBeNull();
    expect(covers.className.split(/\s+/)).toContain("lg:shrink-0");
    // 768–1023 keep round 3's truncation (the row ran under the controls there).
    expect(covers.className.split(/\s+/)).toContain("min-w-0");
    expect(document.querySelector("[data-stand-title]").className).toMatch(/(^|\s)min-w-0(\s|$)/);
  });
});

describe("a shop's settings offer no online party-size rule its page cannot apply (review minor)", () => {
  it("workshop: no 'Maks. antal personer (online)', no 'Forespørgsel fra'", async () => {
    renderOwner("/reservations?tab=settings", "workshop");
    await screen.findByText(da.rsvpTableTimesAppt);
    expect(document.body.textContent).not.toContain(da.rsvpMaxPartyAppt);
    expect(document.body.textContent).not.toContain(da.rsvpGroupThresholdAppt);
    expect(document.body.textContent).not.toContain(da.rsvpMaxPartyHintAppt);
  });

  it("a café keeps both (unchanged)", async () => {
    resources = [place("t1", "Bord 1", 4)];
    renderOwner("/reservations?tab=settings", "cafe");
    await screen.findByText(da.rsvpMaxParty);
    expect(document.body.textContent).toContain(da.rsvpGroupThreshold);
  });
});

// ── The public page after booking ─────────────────────────────────────────

function publicRoutes(type) {
  const today = new Date();
  h.get.mockImplementation((url) => {
    if (url === "/public/reservations/v") {
      return Promise.resolve({ data: {
        business_name: "Cykelværkstedet Amager", business_type: type, max_party_size: 10,
        max_advance_days: 60, lead_time_min: 0, language: "da", allergen_set: [],
      } });
    }
    if (url === "/public/reservations/v/availability-summary") {
      return Promise.resolve({ data: { next_open_day: isoDay(today), days: [{ date: isoDay(today), has_slots: true, reason: null }] } });
    }
    if (url === "/public/reservations/v/availability") return Promise.resolve({ data: { slots: ["13:15"], slot_remaining: {} } });
    if (url === "/public/reservations/booking/bk1") {
      const d = new Date(today.getTime() + 2 * 86400000);
      return Promise.resolve({ data: { status: "confirmed", starts_at: `${isoDay(d)}T10:00:00`, party_size: 1, guest_name: "Sofie" } });
    }
    return Promise.resolve({ data: {} });
  });
  h.post.mockImplementation((url) => Promise.resolve({ data: url.endsWith("/cancel") ? { status: "cancelled" } : {} }));
}
const renderPublicLink = () => render(
  <MemoryRouter initialEntries={["/r/v?booking=bk1&token=tok"]}>
    <Routes><Route path="/r/:slug" element={<ReservationPublicPage />} /></Routes>
  </MemoryRouter>,
);

describe("8 · the public page after booking: a time is cancelled, not a reservation", () => {
  it.each(["workshop", "clothing"])("%s: 'Aflys tiden' → 'Aflys tiden? … Behold tiden' → 'Tid aflyst'", async (type) => {
    publicRoutes(type);
    renderPublicLink();
    await settle(16);
    const btn = screen.getByRole("button", { name: da.rsvpCancelOrChangeAppt });
    expect(pageText()).not.toMatch(/reservation/i);
    await act(async () => { fireEvent.click(btn); });
    await settle(6);
    const asked = h.confirm.mock.calls[0][0];
    expect(asked.title).toBe(da.rsvpCancelConfirmTitleAppt);
    expect(asked.cancelLabel).toBe(da.rsvpCancelConfirmNoAppt);
    expect(asked.title + asked.cancelLabel).not.toMatch(/reservation/i);
    expect(h.post.mock.calls.some(([u]) => u === "/public/reservations/booking/bk1/cancel")).toBe(true);
    expect(pageText()).toContain(da.rsvpCancelledTitleAppt);
    expect(pageText()).not.toMatch(/reservation/i);
    expect(document.title).toBe(da.rsvpDocTitleCancelledAppt.replace("{venue}", "Cykelværkstedet Amager"));
  });

  it("a restaurant keeps 'Aflys reservationen' and 'Reservation aflyst' (unchanged)", async () => {
    publicRoutes("restaurant");
    renderPublicLink();
    await settle(16);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpCancelOrChange })); });
    await settle(6);
    expect(h.confirm.mock.calls[0][0].title).toBe(da.rsvpCancelConfirmTitle);
    expect(pageText()).toContain(da.rsvpCancelledTitle);
  });
});

describe("the round-4 words have real Danish and English, with no restaurant word", () => {
  const KEYS = Object.keys(da).filter((k) => /Appt$/.test(k) && (
    /^rsvpIns|^rsvpMonthly/.test(k) || [
      "rsvpStandInstallHintAppt", "rsvpEditTitleAppt", "rsvpOwnerGuestNameRequiredAppt",
      "rsvpBookingTableOptionalAppt", "rsvpTablePickedTakenAppt", "rsvpBookAnywayAppt",
      "rsvpDocTitleCancelledAppt", "rsvpCancelConfirmTitleAppt", "rsvpCancelConfirmNoAppt",
      "rsvpCancelledTitleAppt", "rsvpCancelledByVenueBodyAppt", "rsvpDoneBodyAppt", "rsvpCancelOrChangeAppt",
    ].includes(k)));

  it("every one of them", () => {
    expect(KEYS.length).toBe(44);
    for (const k of KEYS) {
      expect(en[k], k).toBeTruthy();
      // The words, not the placeholders' names ("{tables}").
      expect(da[k].replace(/\{\w+\}/g, ""), k).not.toMatch(/gæst|bord|selskab|køkken|reservation|couvert|vært/i);
      expect(en[k].replace(/\{\w+\}/g, ""), k).not.toMatch(/guest|table|party|kitchen|reservation|\bcovers?\b|host/i);
    }
  });
});
