/**
 * Push 8 — a salon, a shop or a workshop books CUSTOMERS for a TIME (QA
 * click-through, 12 Oct 2026). Restaurant words were left on their surfaces:
 *
 *   7. The switched-off gate said "Reservationer er slået fra" under a menu
 *      entry called "Tidsbestilling".
 *   8. "Antal gæster" / "2 gæster" on the public page, "Andet antal gæster"
 *      and "2 gæster" in the party ladder, the "GÆST" column, the "Sidder"
 *      status, and "Vært-skærm … reservationer" on the settings device card.
 *      A shop customer books for themselves — usually one person — so the
 *      public page asks no party at all (as the salon's does not).
 *
 * The salon keeps "Sidder" (its customer is in the chair); a café keeps
 * every table word.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), user: null, hidden: new Set() }));
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
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({ hiddenPillars: h.hidden, isReady: true, setPillarHidden: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../hooks/useUndoToast", () => ({ useUndoToast: () => ({ show: vi.fn(), ToastUI: null }) }));
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const PillarGate = (await import("../components/PillarGate")).default;
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

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
function bookRows() {
  const now = new Date();
  const soon = new Date(now.getTime() + 60 * 60000);
  const earlier = new Date(now.getTime() - 20 * 60000);
  return [
    { id: "b1", guest_name: "Hansen", party_size: 2, status: "confirmed", resource_id: null, combined_resource_ids: null,
      starts_at: localIso(soon), ends_at: localIso(new Date(soon.getTime() + 60 * 60000)), source: "manual" },
    { id: "b2", guest_name: "Jensen", party_size: 1, status: "seated", resource_id: null, combined_resource_ids: null,
      starts_at: localIso(earlier), ends_at: localIso(new Date(earlier.getTime() + 60 * 60000)), source: "manual" },
  ];
}
let resources = [];
let rows = [];
function routes() {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: SETTINGS });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources, fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { reservations: rows, summary: { total: rows.length, covers: 3, by_status: { confirmed: 1, seated: 1 } } } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
    if (url === "/stand/links") return Promise.resolve({ data: { devices: [] } });
    if (url === "/staff/members") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.hidden = new Set();
  resources = []; rows = [];
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

const asOwner = (type) => { h.user = { id: "u1", business_type: type, business_name: "Butik Nord", role: "owner" }; };
const renderOwner = (path, type) => {
  asOwner(type);
  return render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
};
// Any form of gæst — "gæst", "gæster", "GÆST" — and the host stand's "Vært-skærm".
const GUEST = /gæst/i;
const pageText = () => document.body.textContent || "";
const ariaText = () => [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
  .map((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")].filter(Boolean).join(" "))
  .join(" | ");
const colHeads = () => [...document.querySelectorAll("th")].map((th) => th.textContent.trim()).filter(Boolean);
const statusOptions = () => [...document.querySelectorAll("select option")].map((o) => o.textContent);

describe("7 · the switched-off gate speaks the menu's word", () => {
  it.each(["clothing", "workshop", "salon"])("%s: 'Tidsbestilling er slået fra'", (type) => {
    asOwner(type);
    h.hidden = new Set(["reservations"]);
    render(<MemoryRouter><PillarGate pillar="reservations"><p>book</p></PillarGate></MemoryRouter>);
    expect(screen.getByRole("heading", { name: da.pillarGateReservationsTitleAppt })).toBeInTheDocument();
    expect(screen.getByText(da.pillarGateReservationsBodyAppt)).toBeInTheDocument();
    expect(pageText()).not.toMatch(/Reservationer/);
    expect(screen.queryByText("book")).toBeNull();
  });

  it("a café keeps 'Reservationer er slået fra'", () => {
    asOwner("cafe");
    h.hidden = new Set(["reservations"]);
    render(<MemoryRouter><PillarGate pillar="reservations"><p>book</p></PillarGate></MemoryRouter>);
    expect(screen.getByRole("heading", { name: da.pillarGateReservationsTitle })).toBeInTheDocument();
  });

  it("only the reservations gate changes", () => {
    asOwner("clothing");
    h.hidden = new Set(["inventory"]);
    render(<MemoryRouter><PillarGate pillar="inventory"><p>stock</p></PillarGate></MemoryRouter>);
    expect(screen.getByRole("heading", { name: da.pillarGateInventoryTitle })).toBeInTheDocument();
  });

  it("the appointment gate promises nothing a shop cannot do (no online booking claim)", () => {
    expect(da.pillarGateReservationsBodyAppt).not.toMatch(/online/i);
    expect(en.pillarGateReservationsBodyAppt).not.toMatch(/online/i);
    expect(da.pillarGateReservationsTitleAppt).toContain(da.navAppointments);
  });
});

describe("8 · a shop's and a workshop's book", () => {
  it.each(["clothing", "workshop"])("%s: Kunde, Tjekket ind — no 'gæst' on the book", async (type) => {
    rows = bookRows();
    renderOwner("/reservations", type);
    await settle(14);
    expect(screen.getAllByText("Hansen").length).toBeGreaterThan(0);
    expect(colHeads()).toContain(da.rsvpColGuestAppt);
    expect(colHeads()).not.toContain(da.rsvpColGuest);
    expect(statusOptions()).toContain("Tjekket ind");
    expect(statusOptions()).not.toContain(da.rsvpStatusSeated);
    // Jensen is checked in — the row says so, nobody "sits".
    expect(screen.getAllByText("Tjekket ind").length).toBeGreaterThan(1);
    expect(pageText()).not.toMatch(GUEST);
    expect(ariaText()).not.toMatch(GUEST);
  });

  it("the New booking ladder counts people: '1 person', '2 personer', 'Andet antal personer'", async () => {
    rows = bookRows();
    renderOwner("/reservations", "clothing");
    await settle(14);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: new RegExp(da.rsvpNewBookingProvider || "Book en tid") })[0]); });
    await settle(4);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "1 person" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "2 personer" })).toBeInTheDocument();
    expect(within(dialog).getByText("Andet antal personer")).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(GUEST);
  });

  it("the settings device card: the appointment book at the counter — no Vært-skærm, no reservationer", async () => {
    renderOwner("/reservations?tab=settings", "workshop");
    await screen.findByText(da.rsvpStandDevicesTitleAppt);
    const card = screen.getByText(da.rsvpStandDevicesTitleAppt).closest("div").parentElement;
    expect(card.textContent).toContain(da.rsvpStandDevicesBodyAppt);
    expect(card.textContent).not.toMatch(/Vært-skærm|reservationer/i);
  });

  it("on an iPad the install line opens the appointment book, not the host screen", async () => {
    window.__BONBOX_IS_IOS = true;
    try {
      renderOwner("/reservations?tab=settings", "clothing");
      await screen.findByText(da.rsvpInstallManualIOSProvider);
      expect(pageText()).not.toMatch(/vært-skærm/i);
    } finally {
      delete window.__BONBOX_IS_IOS;
    }
  });

  it("a salon keeps 'Sidder' — its customer is in the chair", async () => {
    resources = [{ id: "r2", kind: "provider", label: "Mia", staff_id: "s1", is_active: true }];
    rows = bookRows();
    renderOwner("/reservations", "salon");
    await settle(14);
    expect(statusOptions()).toContain(da.rsvpStatusSeated);
  });

  it("a café keeps GÆST, Sidder and the guest ladder (unchanged)", async () => {
    resources = [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }];
    rows = bookRows().map((r) => ({ ...r, resource_id: "t1" }));
    renderOwner("/reservations", "cafe");
    await settle(14);
    expect(colHeads()).toContain(da.rsvpColGuest);
    expect(statusOptions()).toContain(da.rsvpStatusSeated);
    renderOwner("/reservations?tab=settings", "cafe");
    await screen.findByText(da.rsvpStandDevicesTitle);
  });
});

describe("8 · a shop's and a workshop's door screen and pop-out (round 2)", () => {
  // The last restaurant words the QA saw on a shop: "Åbn vært-skærm" on the
  // book, and on the door screen (the owner's pop-out and a paired tablet)
  // "Vært-skærm", "Sidder" and "1 gæst · 2 gæster · 0 gæster".
  const HOST = /vært/i;

  it.each(["clothing", "workshop"])("%s: the book's pop-out opens the appointment book, not the host stand", async (type) => {
    rows = bookRows();
    renderOwner("/reservations", type);
    await settle(14);
    const btn = screen.getByRole("button", { name: da.rsvpOpenStandAppt });
    expect(btn).toHaveAttribute("title", da.rsvpOpenStandAppt);
    expect(ariaText()).not.toMatch(HOST);
    expect(ariaText()).not.toMatch(/reservation/i);
  });

  it.each([
    ["clothing", "/reservations/stand"],
    ["workshop", "/reservations/stand"],
    ["clothing", "/stand/tok-shop-1"],
  ])("%s %s: the counter screen counts customers — no Vært-skærm, no Sidder, no gæst", async (type, path) => {
    rows = bookRows();
    renderOwner(path, type);
    await settle(14);
    expect(pageText()).toContain(`Butik Nord · ${da.rsvpStandModeAppt}`);
    const covers = screen.getByRole("group", { name: da.rsvpStandCoversAriaAppt });
    // Jensen (1) is checked in, Hansen (2) is expected, none finished.
    const seated = covers.querySelector('[data-covers="seated"]');
    expect(seated.textContent).toContain(da.rsvpStatusSeatedAppt);
    expect(seated.textContent).toContain("1 kunde");
    expect(seated.textContent).toContain("1 aftale");
    expect(covers.querySelector('[data-covers="expected"]').textContent).toContain("2 kunder");
    expect(covers.querySelector('[data-covers="finished"]').textContent).toContain("0 kunder");
    expect(pageText()).not.toMatch(GUEST);
    expect(pageText()).not.toMatch(HOST);
    expect(pageText()).not.toMatch(new RegExp(`\\b${da.rsvpStandSeated}\\b`));
    expect(ariaText()).not.toMatch(GUEST);
    expect(ariaText()).not.toMatch(HOST);
  });

  it("a café keeps 'Åbn vært-skærm' and its guests on the door screen (unchanged)", async () => {
    resources = [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }];
    rows = bookRows().map((r) => ({ ...r, resource_id: "t1" }));
    renderOwner("/reservations", "cafe");
    await settle(14);
    expect(screen.getByRole("button", { name: da.rsvpOpenStand })).toBeInTheDocument();
    cleanup();
    renderOwner("/reservations/stand", "cafe");
    await settle(14);
    expect(pageText()).toContain(`Butik Nord · ${da.rsvpStandMode}`);
    const covers = screen.getByRole("group", { name: da.rsvpStandCoversAria });
    expect(covers.querySelector('[data-covers="seated"]').textContent).toContain(da.rsvpStandSeated);
    expect(covers.querySelector('[data-covers="seated"]').textContent).toContain("1 gæst");
  });

  it("the Venteliste form on a shop counts people — its party group is not named 'Gæster'", async () => {
    rows = bookRows();
    renderOwner("/reservations", "clothing");
    await settle(14);
    const wl = document.getElementById("rsvp-venteliste");
    await act(async () => { fireEvent.click(within(wl).getByRole("button", { name: da.rsvpWlAddCta })); });
    await settle(4);
    expect(within(wl).getByRole("group", { name: da.rsvpPartySizeAppt })).toBeInTheDocument();
    expect(within(wl).queryByRole("group", { name: da.rsvpWlPartySize })).toBeNull();
    expect(wl.textContent).not.toMatch(GUEST);
    expect(ariaText()).not.toMatch(GUEST);
  });

  it("one customer is '1 person' in the drawer, never '1 people'", async () => {
    rows = bookRows();
    renderOwner("/reservations", "clothing");
    await settle(14);
    // Jensen is a party of one.
    const row = [...document.querySelectorAll('[role="button"][data-status], tr')].find((el) => el.textContent.includes("Jensen"));
    await act(async () => { fireEvent.click(row); });
    await settle(4);
    const drawer = screen.getByRole("dialog");
    expect(drawer.textContent).toContain(da.rsvpPersonOne);
    expect(drawer.textContent).not.toContain("1 pers.");
    expect(en.rsvpPersonOne).toBe("1 person");
  });

  it("the new words have real Danish and English", () => {
    for (const k of ["rsvpOpenStandAppt", "rsvpStandModeAppt", "rsvpStandCoversAriaAppt", "rsvpStandCustomersOne",
      "rsvpStandCustomers", "rsvpStandApptsOne", "rsvpStandAppts", "rsvpBookDayAppt", "rsvpTabsAriaAppt"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
      expect(da[k], k).not.toMatch(/gæst|vært|reservation/i);
      expect(en[k], k).not.toMatch(/guest|host|reservation/i);
    }
  });
});

describe("8 · a shop's public page asks no party", () => {
  const renderPublic = (type) => {
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/shop") {
        return Promise.resolve({ data: { business_name: "Butik Nord", business_type: type, max_party_size: 10, max_advance_days: 60, lead_time_min: 60, language: "da" } });
      }
      if (url === "/public/reservations/shop/availability-summary") return Promise.resolve({ data: { next_open_day: null, days: [] } });
      return Promise.resolve({ data: { slots: [] } });
    });
    return render(
      <MemoryRouter initialEntries={["/r/shop"]}>
        <Routes><Route path="/r/:slug" element={<ReservationPublicPage />} /></Routes>
      </MemoryRouter>,
    );
  };

  it.each(["clothing", "workshop"])("%s: no 'Antal gæster', no party rail, no 'gæst' — and it asks for one person", async (type) => {
    renderPublic(type);
    await settle(14);
    expect(screen.queryByText(da.rsvpPartySize)).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: da.rsvpPartySize })).toBeNull();
    expect(pageText()).not.toMatch(GUEST);
    expect(ariaText()).not.toMatch(GUEST);
    const asked = h.get.mock.calls.filter((c) => c[0] === "/public/reservations/shop/availability-summary");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => c[1].params.party === 1)).toBe(true);
  });

  it("a restaurant keeps 'Antal gæster' and its party rail (unchanged)", async () => {
    renderPublic("restaurant");
    await settle(14);
    expect(screen.getByRole("radiogroup", { name: da.rsvpPartySize })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "2 gæster" })).toBeInTheDocument();
  });
});
