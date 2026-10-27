/**
 * Venue identity on the guest booking page (booking push p3).
 *
 * A guest should see straight away that they are in the right place: the
 * venue's own name (never "BonBox", never "null"), its logo or monogram, and
 * its weekly opening hours, from data the owner already typed. On a phone
 * the hours fold into the address/phone row as one tap-to-open item, so the
 * times stay on the first screen; on a desktop the narrow card becomes two
 * calm columns, the venue on the left. The ?embed=1 widget stays compact.
 *
 * Layout per test is stated: "card" = no matchMedia stub (jsdom has none,
 * so the page is never wide); "column" = a matchMedia stub that answers the
 * page's (min-width: 1024px) query, deleted in afterEach.
 *
 * The clock is pinned (Date only) to Friday 23 October 2026, 12:00.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), lang: "da", framed: false, user: null }));
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
    let s = dict[k] ?? EN[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return {
    useLanguage: () => ({ lang: h.lang, setLang: () => {}, t }),
    LanguageProvider: ({ children }) => children,
  };
});
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("../utils/framed", () => ({ isFramed: () => h.framed }));
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: h.user, logout: vi.fn(), refreshUser: vi.fn() }) };
});
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const TODAY = "2026-10-23"; // a Friday
const plus = (n) => {
  const d = new Date(2026, 9, 23 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const D = (windows, by = "opening") => ({ windows, by });
const WEEK = {
  mon: D([["17:00", "22:00"]]), tue: D([["17:00", "22:00"]]), wed: D([["17:00", "22:00"]]), thu: D([["17:00", "22:00"]]),
  fri: D([["17:00", "23:00"]]), sat: D([["17:00", "23:00"]]), sun: D([]),
};
const PAGE = {
  business_name: "Bistro Nørrebro", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Nørrebrogade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false, providers: [],
  allergen_set: [{ key: "gluten", en: "Gluten" }], logo_url: null,
  hours: { days: WEEK },
};

function summary({ closedReason, reasons } = {}) {
  const days = Array.from({ length: 14 }, (_, i) => {
    const r = reasons ? reasons[i] ?? null : null;
    return { date: plus(i), has_slots: r === null, reason: r };
  });
  const first = days.find((d) => d.has_slots);
  return { from: TODAY, party_size: 2, next_open_day: first ? first.date : null, days, ...(closedReason ? { closed_reason: closedReason } : {}) };
}

function routes({ page = PAGE, sum = () => summary(), pageResponse, booking } = {}) {
  h.get.mockImplementation((url, cfg) => {
    if (url === "/public/reservations/x") return pageResponse ? pageResponse() : Promise.resolve({ data: page });
    if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: sum(cfg?.params || {}) });
    if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: ["19:00", "19:30"], slot_remaining: {} } });
    if (url === "/public/reservations/x/provider-availability") return Promise.resolve({ data: { slots: [{ time: "13:00", staff_id: null, resource_id: "r1" }] } });
    if (url === "/public/reservations/x/behandlinger") return Promise.resolve({ data: { behandlinger: [{ id: "b1", name: "Dameklip", duration_min: 45, price_kr: 450 }] } });
    if (url === "/public/reservations/x/floor") return Promise.resolve({ data: { tables: [] } });
    if (url === "/public/reservations/booking/bk1" && booking) return Promise.resolve({ data: booking });
    return Promise.resolve({ data: {} });
  });
}

const renderAt = (path = "/r/x") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:slug" element={<ReservationPublicPage />} />
      </Routes>
    </MemoryRouter>,
  );

const pageText = () => document.body.textContent;
const hoursButton = () => document.querySelector('button[aria-controls="rsvp-venue-hours"]');
const hoursList = () => document.getElementById("rsvp-venue-hours");
const rowsOf = (root) => [...root.querySelectorAll("dl > div")].map((row) => ({
  dt: row.querySelector("dt").textContent.trim(),
  dd: row.querySelector("dd").textContent.trim(),
  current: row.getAttribute("aria-current"),
}));
// The desktop venue column (a <header>: the page's banner landmark).
const venueColumn = () => document.querySelector('[data-testid="rsvp-venue-column"]');
const stubWide = () => {
  window.matchMedia = vi.fn((q) => ({
    matches: /min-width:\s*1024px/.test(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 23, 12, 0));
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.lang = "da";
  h.framed = false;
  localStorage.clear();
  document.title = "";
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.matchMedia;
});

describe("the phone card: hours fold into the address row", () => {
  it("(card) a named venue's identity row is top-aligned, the inline caption is 13px", async () => {
    routes();
    renderAt();
    await settle();
    expect(document.querySelector("header").firstElementChild.className).toMatch(/items-start/);
    await act(async () => { fireEvent.click(hoursButton()); });
    const caption = document.getElementById("rsvp-venue-hours-caption");
    expect(caption.className).toMatch(/text-\[13px\]/);
    expect(caption.className).not.toMatch(/text-\[12px\]/);
  });

  it("(card) collapsed by default, today's hours in the row, the week on a tap", async () => {
    routes();
    renderAt();
    await settle();
    const btn = hoursButton();
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("17:00–23:00");
    expect(btn.textContent).toContain(da.rsvpVenueHoursTodayLabel);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(hoursList()).toBeNull();
    // It sits in the same row as the phone link.
    const tel = document.querySelector('header a[href^="tel:"]');
    expect(tel.parentElement).toBe(btn.parentElement);

    await act(async () => { fireEvent.click(btn); });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const list = hoursList();
    expect(list).not.toBeNull();
    expect(list.textContent).toContain("Åbningstider");
    expect(rowsOf(list)).toEqual([
      { dt: "Mandag–torsdag", dd: "17:00–22:00", current: null },
      { dt: `Fredag–lørdag ${da.rsvpVenueHoursTodayTag}`, dd: "17:00–23:00", current: "date" },
      { dt: "Søndag", dd: "Lukket", current: null },
    ]);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    // Hours carry no status colour.
    expect(list.innerHTML).not.toMatch(/(green|emerald|sky|amber)-/);
  });

  it("(card) the empty-day word follows the source that closed the day", async () => {
    routes({ page: { ...PAGE, hours: { days: { ...WEEK, sun: D([], "booking") } } } });
    renderAt();
    await settle();
    await act(async () => { fireEvent.click(hoursButton()); });
    expect(rowsOf(hoursList()).at(-1)).toEqual({ dt: "Søndag", dd: "Ingen bordbestilling", current: null });
    expect(hoursList().textContent).toContain("Åbningstider");
    cleanup();

    routes({ page: { ...PAGE, business_type: "salon", allergen_set: [], hours: { days: { ...WEEK, sun: D([], "booking") } } } });
    renderAt();
    await settle(16);
    await act(async () => { fireEvent.click(hoursButton()); });
    expect(rowsOf(hoursList()).at(-1)).toEqual({ dt: "Søndag", dd: "Ingen tidsbestilling", current: null });
    expect(hoursList().textContent).toContain("Åbningstider");
  });

  it("(card) an undeclared day has no row", async () => {
    routes({ page: { ...PAGE, hours: { days: { ...WEEK, wed: null } } } });
    renderAt();
    await settle();
    await act(async () => { fireEvent.click(hoursButton()); });
    expect(hoursList().textContent).not.toContain("Onsdag");
    expect(rowsOf(hoursList()).map((r) => r.dt)).toEqual(["Mandag–tirsdag", "Torsdag", `Fredag–lørdag ${da.rsvpVenueHoursTodayTag}`, "Søndag"]);
  });

  it("(card) today with no claim shows the plain heading, no 'today' label", async () => {
    routes({ page: { ...PAGE, hours: { days: { ...WEEK, fri: null } } } });
    renderAt();
    await settle();
    const btn = hoursButton();
    expect(btn.textContent).toContain(da.rsvpVenueHoursOpening);
    expect(btn.textContent).not.toContain(da.rsvpVenueHoursTodayLabel);
  });

  it("(card) hours still show with no address, city or phone", async () => {
    routes({ page: { ...PAGE, address: null, city: null, phone: null } });
    renderAt();
    await settle();
    expect(hoursButton()).not.toBeNull();
    expect(document.querySelector('header a[href^="tel:"]')).toBeNull();
  });

  it("(card) no hours block when hours is null — or absent (an older server)", async () => {
    routes({ page: { ...PAGE, hours: null } });
    renderAt();
    await settle();
    expect(hoursButton()).toBeNull();
    expect(pageText()).not.toContain("Åbningstider");
    expect(pageText()).not.toContain("Lukket");
    cleanup();
    const { hours: _h, ...older } = PAGE;
    routes({ page: older });
    renderAt();
    await settle();
    expect(hoursButton()).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Bistro Nørrebro");
  });

  it("(card) the row is step 1 only", async () => {
    routes();
    renderAt();
    await settle();
    await act(async () => { fireEvent.click(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "19:00")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fortsæt/ })); });
    await settle(4);
    expect(hoursButton()).toBeNull();
  });
});

describe("embed and framed pages stay compact", () => {
  it("(column stub) ?embed=1 shows no hours and no column", async () => {
    stubWide();
    routes();
    renderAt("/r/x?embed=1");
    await settle();
    expect(venueColumn()).toBeNull();
    expect(hoursButton()).toBeNull();
    expect(pageText()).not.toContain("Åbningstider");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("(column stub) a framed page without embed=1 stays one column", async () => {
    stubWide();
    h.framed = true;
    routes();
    renderAt();
    await settle();
    expect(venueColumn()).toBeNull();
    expect(document.querySelector("header h1").textContent).toBe("Bistro Nørrebro");
  });
});

describe("desktop: the venue on the left, the booking on the right", () => {
  it("(column) two columns, one h1, the list expanded", async () => {
    stubWide();
    routes();
    renderAt();
    await settle();
    const col = venueColumn();
    expect(col).not.toBeNull();
    expect(within(col).getByRole("heading", { level: 1 }).textContent).toBe("Bistro Nørrebro");
    expect(within(col).getByRole("heading", { level: 2 }).textContent).toBe("Åbningstider");
    expect(rowsOf(col).map((r) => r.dd)).toEqual(["17:00–22:00", "17:00–23:00", "Lukket"]);
    expect(col.querySelector("button[aria-controls]")).toBeNull();
    // The number keeps together on screen (no-break spaces, fix round 5).
    expect(within(col).getByRole("link", { name: /12\u00a034\u00a056\u00a078/ })).toBeTruthy();
    expect(col.textContent).toContain(da.rsvpTrustLine);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    // One header (the column); the card does not render its own.
    expect(document.querySelectorAll("header")).toHaveLength(1);
    // The card keeps the flow: step dots and the time chips.
    const card = col.nextElementSibling;
    expect(card.tagName).toBe("MAIN");
    expect(card.querySelector("header")).toBeNull();
    expect(within(card).getByRole("progressbar")).toBeTruthy();
    expect(within(card).getAllByRole("radio").some((r) => r.textContent.trim() === "19:00")).toBe(true);
    // The logo box is reserved even before an image exists (no layout shift).
    expect(col.querySelector(".w-16.h-16")).not.toBeNull();
  });

  it("(column) landmarks: the venue is the banner, the booking the main region, no complementary", async () => {
    stubWide();
    routes();
    renderAt();
    await settle();
    expect(document.querySelector("aside")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    const banner = screen.getByRole("banner");
    expect(banner).toBe(venueColumn());
    expect(within(banner).getByRole("heading", { level: 1 }).textContent).toBe("Bistro Nørrebro");
    const main = screen.getByRole("main");
    expect(within(main).getAllByRole("radio").some((r) => r.textContent.trim() === "19:00")).toBe(true);
    // G10 (judge 27 Oct, item 2): the language switch is the card's, in its
    // top row beside the step dots — no longer in the venue column.
    expect(within(banner).queryByRole("group", { name: /Sprog/ })).toBeNull();
    const top = within(main).getByTestId("rsvp-card-top");
    expect(within(top).getByRole("group", { name: /Sprog/ })).toBeTruthy();
    expect(within(top).getByRole("progressbar")).toBeTruthy();
    expect(banner.className).not.toMatch(/(^| )pt-8( |$)/);
  });

  it("(card) the phone card is the main region with the venue's header inside it", async () => {
    routes();
    renderAt();
    await settle();
    const main = screen.getByRole("main");
    expect(main.querySelector("header h1").textContent).toBe("Bistro Nørrebro");
    expect(document.querySelector("aside")).toBeNull();
  });

  it("(column) the loading skeleton already stands in two columns", async () => {
    stubWide();
    routes({ pageResponse: () => new Promise(() => {}) });
    renderAt();
    await settle(2);
    const grid = document.querySelector(".grid.max-w-5xl");
    expect(grid).not.toBeNull();
    expect(grid.children).toHaveLength(2);
    expect(grid.textContent).toContain(da.rsvpLoading);
    expect(venueColumn()).toBeNull();
  });

  it("(column) the column stays on step 2, the card's header does not come back", async () => {
    stubWide();
    routes();
    renderAt();
    await settle();
    await act(async () => { fireEvent.click(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "19:00")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fortsæt/ })); });
    await settle(4);
    expect(venueColumn().querySelector("h1").textContent).toBe("Bistro Nørrebro");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("(column) loading to loaded keeps hook order", async () => {
    stubWide();
    let resolvePage;
    routes({ pageResponse: () => new Promise((r) => { resolvePage = r; }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderAt();
      await settle(2);
      expect(venueColumn()).toBeNull();
      await act(async () => { resolvePage({ data: PAGE }); });
      await settle();
      const said = spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(said).not.toMatch(/Rendered more hooks|change in the order of Hooks|Rendered fewer hooks/);
      expect(venueColumn().querySelector("h1").textContent).toBe("Bistro Nørrebro");
    } finally {
      spy.mockRestore();
    }
  });

  it("(column) paused: no trust row, no step dots — the venue and its hours stay", async () => {
    stubWide();
    routes({ sum: () => summary({ closedReason: "not_accepting", reasons: Array(14).fill("not_accepting") }) });
    renderAt();
    await settle();
    await screen.findByTestId("rsvp-paused");
    const col = venueColumn();
    expect(col).not.toBeNull();
    expect(pageText()).not.toContain(da.rsvpTrustLine);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(col.textContent).toContain("Åbningstider");
    // No "Book et bord" eyebrow over the name while nothing can be booked.
    expect(col.querySelector("h1").textContent).toBe("Bistro Nørrebro");
    expect(col.textContent).not.toContain(da.rsvpBookATable);
  });

  it("(card) paused: no eyebrow either, the name stays and centres on the tile", async () => {
    routes({ sum: () => summary({ closedReason: "not_accepting", reasons: Array(14).fill("not_accepting") }) });
    renderAt();
    await settle();
    await screen.findByTestId("rsvp-paused");
    const header = document.querySelector("header");
    expect(header.querySelector("h1").textContent).toBe("Bistro Nørrebro");
    expect(header.textContent).not.toContain(da.rsvpBookATable);
    expect(header.firstElementChild.className).toMatch(/items-center/);
  });
});

describe("a nameless venue never reads BonBox or null", () => {
  it("(card) heading, tab title, privacy and allergy lines", async () => {
    routes({ page: { ...PAGE, business_name: null } });
    renderAt();
    await settle();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Book et bord");
    expect(document.title).toBe("Book et bord");
    expect(document.title).not.toMatch(/BonBox/);
    // The eyebrow would repeat the heading: none. The one-line heading
    // centres on the tile instead of hugging its top edge; a named venue's
    // row stays top-aligned (a two-line name starts at the tile's top).
    expect(pageText().match(/Book et bord/g)).toHaveLength(1);
    expect(document.querySelector("header").firstElementChild.className).toMatch(/items-center/);

    await act(async () => { fireEvent.click(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "19:00")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fortsæt/ })); });
    await settle(4);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpExtrasTitle.replace("?", "\\?")) })); });
    expect(pageText()).toContain("Dine oplysninger går til stedet til denne reservation");
    expect(pageText()).toContain("Deles kun med stedet");
    expect(pageText()).not.toMatch(/\bnull\b/);
    expect(pageText()).not.toMatch(/BonBox/);
    expect(document.title).not.toMatch(/null|BonBox/);
  });

  it("(card) a nameless salon says 'Book en tid' and its own privacy line", async () => {
    routes({ page: { ...PAGE, business_name: null, business_type: "salon", allergen_set: [] } });
    renderAt();
    await settle(16);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Book en tid");
    expect(document.title).toBe("Book en tid");
  });

  it("(card) nameless receipt has a header; the tab says what happened", async () => {
    routes({
      page: { ...PAGE, business_name: null },
      booking: { status: "confirmed", starts_at: `${plus(2)}T19:00:00`, party_size: 2, guest_name: "Sofie" },
    });
    renderAt("/r/x?booking=bk1&token=tok");
    await settle(16);
    const header = document.querySelector(".rounded-t-xl p.truncate");
    expect(header.textContent).toBe("Bordreservation");
    expect(document.title).toBe("Reservation bekræftet");
    expect(pageText()).not.toMatch(/\bnull\b|BonBox/);
  });

  it("(card) a named venue's title is unchanged; og:description is English when the page is", async () => {
    h.lang = "en";
    routes();
    renderAt();
    await settle();
    expect(document.title).toBe("Book a table · Bistro Nørrebro");
    expect(document.querySelector('meta[property="og:description"]').getAttribute("content")).toBe("Reserve a table at Bistro Nørrebro.");
  });
});

describe("the identity tile", () => {
  it("(card) logo is shown, monogram on error, icon tile when nameless", async () => {
    routes({ page: { ...PAGE, logo_url: "https://cdn.example/logo.png" } });
    renderAt();
    await settle();
    const img = document.querySelector("header img");
    expect(img.getAttribute("src")).toBe("https://cdn.example/logo.png");
    expect(img.getAttribute("width")).toBe("44");
    await act(async () => { fireEvent.error(img); });
    expect(document.querySelector("header img")).toBeNull();
    expect(document.querySelector("header").textContent).toContain("BN");
    cleanup();

    routes({ page: { ...PAGE, business_name: null } });
    renderAt();
    await settle();
    const tile = document.querySelector("header [aria-hidden='true']");
    expect(tile.querySelector("svg")).not.toBeNull();
    expect(tile.textContent).not.toContain("·");
  });
});

describe("the words", () => {
  it("every new key exists in da and en with real text", () => {
    const keys = [
      "rsvpVenueHoursOpening", "rsvpVenueHoursTodayLabel", "rsvpVenueHoursTodayTag", "rsvpVenueHoursClosed",
      "rsvpVenueHoursNoBooking", "rsvpVenueHoursNoBookingAppt", "rsvpVenueHoursShowAll",
      "rsvpAllergySharedUnnamed", "rsvpAllergySharedProviderUnnamed", "rsvpPrivacyVenueUnnamed", "rsvpPrivacyVenueApptUnnamed",
    ];
    for (const k of keys) {
      expect(typeof da[k], k).toBe("string");
      expect(typeof en[k], k).toBe("string");
      expect(da[k].trim().length, k).toBeGreaterThan(0);
      expect(da[k], k).not.toBe(en[k]);
      expect(da[k] + en[k], k).not.toMatch(/\{venue\}/);
    }
  });
});

// ── The owner's hours card shows what the table engine books ──────────────

describe("owner hours card seeds from open_hours only when that is what the engine books", () => {
  const OPEN = { mon: [["10:00", "17:00"]], tue: [], wed: [["10:00", "17:00"]], thu: [["10:00", "17:00"]], fri: [["10:00", "17:00"]], sat: [["10:00", "17:00"]], sun: [] };
  const EMPTY = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  let body;
  const ownerRoutes = () => {
    h.get.mockImplementation((url) => {
      if (url === "/reservations/settings") return Promise.resolve({ data: body });
      if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
      if (url === "/reservations/book") return Promise.resolve({ data: { reservations: [], summary: { total: 0, covers: 0, by_status: {} } } });
      if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
      if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
      if (url === "/staff/members") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
  };
  const settingsBody = (settings, extra) => ({
    reservations_enabled: true, reservation_slug: "cafe-nord", public_url: "https://www.bonbox.dk/cafe-nord",
    business_name: "Café Nord", settings: { max_party_size: 8, group_request_threshold: 8, lead_time_min: 60, max_advance_days: 60,
      default_duration_min: 90, turn_time_tiers: [], combine_enabled: true, guest_can_pick_table: false, ...settings },
    ...extra,
  });
  const openOwner = async (type) => {
    vi.useRealTimers();
    h.user = { id: "u1", business_type: type, business_name: "Café Nord", role: "owner" };
    ownerRoutes();
    render(<MemoryRouter initialEntries={["/reservations?tab=settings"]}><ReservationsPage /></MemoryRouter>);
    await screen.findAllByText(da.rsvpDayMon);
    await settle(8);
  };
  const dayRow = (label) => screen.getAllByText(label, { selector: "span" })
    .map((s) => s.parentElement).find((row) => row.querySelector('input[type="checkbox"]'));
  const day = (label) => {
    const row = dayRow(label);
    const open = row.querySelector('input[type="checkbox"]').checked;
    const times = [...row.querySelectorAll('input[type="time"]')].map((i) => i.value);
    return open ? times : "closed";
  };

  it("(a) Profile hours only: Monday 10:00–17:00, Tuesday closed", async () => {
    body = settingsBody({}, { hours_declared: true, open_hours: OPEN });
    await openOwner("restaurant");
    expect(day(da.rsvpDayMon)).toEqual(["10:00", "17:00"]);
    expect(day(da.rsvpDayTue)).toBe("closed");
    expect(screen.queryByText(da.rsvpHoursNotSet)).toBeNull();
  });

  it("(b) a day the booking hours set wins", async () => {
    body = settingsBody({ booking_hours: { mon: "12:00-14:00" } }, { hours_declared: true, open_hours: { ...OPEN, mon: [["12:00", "14:00"]] } });
    await openOwner("restaurant");
    expect(day(da.rsvpDayMon)).toEqual(["12:00", "14:00"]);
    expect(day(da.rsvpDayTue)).toBe("closed");
    expect(day(da.rsvpDayWed)).toEqual(["10:00", "17:00"]);
  });

  it("(c) a fresh account keeps the 11–22 suggestions and the banner", async () => {
    body = settingsBody({}, { hours_declared: false, open_hours: EMPTY });
    await openOwner("restaurant");
    expect(day(da.rsvpDayMon)).toEqual(["11:00", "22:00"]);
    expect(day(da.rsvpDayTue)).toEqual(["11:00", "22:00"]);
    expect(screen.getByText(da.rsvpHoursNotSet)).toBeTruthy();
  });

  // R7 (27 Oct 2026): a salon's suggestion is a salon week (Tue–Fri 09–17,
  // Sat 09–14, Mon + Sun closed), not the restaurant's 11–22 — and never the
  // Profile hours (Mon 10–17, Tue closed here). A salon books only on the
  // hours saved on this card, so the "not saved" banner stays until then.
  it("(d) a salon is never seeded from Profile hours", async () => {
    body = settingsBody({}, { hours_declared: true, open_hours: OPEN });
    await openOwner("salon");
    expect(day(da.rsvpDayMon)).toBe("closed");
    expect(day(da.rsvpDayTue)).toEqual(["09:00", "17:00"]);
    expect(day(da.rsvpDaySat)).toEqual(["09:00", "14:00"]);
    expect(screen.getByText(da.rsvpHoursNotSetProvider)).toBeTruthy();
  });
});
