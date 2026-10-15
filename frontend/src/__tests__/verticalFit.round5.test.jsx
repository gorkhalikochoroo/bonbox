/**
 * Push 8 review (round 5) — what QA still found on a shop's and a workshop's
 * surfaces after round 4:
 *
 *   • MAJOR: round 4 took "Forespørgsel fra" off a shop's settings as a dead
 *     control. It is not dead at 1: the server's is_group_request still turns
 *     every one-person online booking into a request, and the owner could no
 *     longer see or undo it. The shop gets a switch for exactly that —
 *     "Godkend online-aftaler selv" — and its public page says "Alle aftaler
 *     sendes som en forespørgsel …", not "Selskaber på 1 … I ønsker".
 *   • An older allergy note on a shop's booking: changing its text silently
 *     erased it, kept "Alvorlig" and showed "vært-skærmen". It can now only be
 *     removed — note and severity together.
 *   • The drawer's place picker said "Plads 1 · 1 pladser".
 *   • English: Insights "Seat utilization · of seat-hours" and the Spaces tab
 *     "Seats" / "seats" on a shop or a workshop.
 *
 * Control cases: a restaurant and a café keep every word and control.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), user: null, lang: "da",
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

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
const attrText = () => [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
  .map((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")].filter(Boolean).join(" "))
  .join(" | ")
  .replace(/Plads \d+|Space \d+/g, "");

beforeEach(() => {
  // Midday, pinned: the book files a booking under the 06:00 business day, so
  // a run between 00:00 and 06:00 must not depend on which day "now" is. Only
  // Date is faked; the timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 14, 12, 0, 0));
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  h.lang = "da";
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
afterEach(() => { cleanup(); vi.useRealTimers(); });

// ── The owner's settings and book ─────────────────────────────────────────

const settingsWith = (threshold) => ({
  reservations_enabled: true, reservation_slug: "v", public_url: "https://www.bonbox.dk/r/v",
  business_name: "Cykelværkstedet Amager", hours_declared: true,
  settings: {
    turn_time_tiers: [{ up_to: 2, minutes: 60 }], default_duration_min: 60, max_party_size: 10,
    group_request_threshold: threshold, lead_time_min: 60, max_advance_days: 60, combine_enabled: true,
    guest_can_pick_table: false,
    booking_hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, "00:00-23:59"])),
  },
});
const place = (id, label, seats = 2) => ({ id, kind: "table", label, capacity_seats: seats, is_active: true, zone: null, pos_x: 20, pos_y: 20, combinable: true });
function bookRows() {
  const now = new Date();
  return [
    { id: "b1", guest_name: "Peter Hansen", party_size: 1, status: "confirmed", resource_id: "p2", combined_resource_ids: null,
      starts_at: localIso(new Date(now.getTime() + 60 * 60000)), ends_at: localIso(new Date(now.getTime() + 120 * 60000)), source: "manual",
      allergy_note: null, allergy_severity: null },
  ];
}
let resources = [];
let rows = [];
let settings = settingsWith(8);
function ownerRoutes() {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: settings });
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: settings });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources, fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { reservations: rows, summary: { total: rows.length, covers: 1, by_status: {} } } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
    if (url === "/stand/links") return Promise.resolve({ data: { devices: [] } });
    if (url === "/staff/members") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
  h.put.mockImplementation((url, body) => Promise.resolve({
    data: { ...settings, settings: { ...settings.settings, ...(body?.settings || {}) } },
  }));
  h.patch.mockImplementation((url, body) => Promise.resolve({ data: { ...rows[0], ...body } }));
}
const renderOwner = (path, type) => {
  h.user = { id: "u1", business_type: type, business_name: "Cykelværkstedet Amager", role: "owner" };
  ownerRoutes();
  return render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
};

beforeEach(() => {
  resources = [place("p1", "Plads 1", 1), place("p2", "Plads 2", 1)];
  rows = bookRows();
  settings = settingsWith(8);
});

const approveSwitch = () => document.querySelector("[data-approve-online] input[type=checkbox]");
const savedSettings = () => h.put.mock.calls.filter(([u]) => u === "/reservations/settings").map(([, b]) => b.settings);

describe("MAJOR · a shop keeps a way to approve its online bookings", () => {
  it.each(["workshop", "clothing"])("%s with a stored 1: the switch is on, says so in its own words, and turns it off", async (type) => {
    settings = settingsWith(1);
    renderOwner("/reservations?tab=settings", type);
    await screen.findByText(da.rsvpTableTimesAppt);
    const box = approveSwitch();
    expect(box, "the request switch").not.toBeNull();
    expect(box.checked).toBe(true);
    const label = box.closest("label").textContent;
    expect(label).toContain(da.rsvpApproveOnlineAppt);
    expect(label).toContain(da.rsvpApproveOnlineHintAppt);
    expect(label).not.toMatch(/gæst|selskab|bord|reservation/i);
    // The number field stays gone: on a one-person page only on/off exists.
    expect(pageText()).not.toContain(da.rsvpGroupThresholdAppt);
    await act(async () => { fireEvent.click(box); });
    expect(approveSwitch().checked).toBe(false);
    await act(async () => { fireEvent.submit(approveSwitch().closest("form")); });
    await settle(4);
    expect(savedSettings().at(-1).group_request_threshold).toBe(8);
    // Saved off, the switch stays on the page for the visit.
    expect(approveSwitch()).not.toBeNull();
    expect(approveSwitch().checked).toBe(false);
  });

  it("a shop with places and the default 8: the switch is off, and on sends 1", async () => {
    renderOwner("/reservations?tab=settings", "clothing");
    await screen.findByText(da.rsvpTableTimesAppt);
    expect(approveSwitch().checked).toBe(false);
    await act(async () => { fireEvent.click(approveSwitch()); });
    await act(async () => { fireEvent.submit(approveSwitch().closest("form")); });
    await settle(4);
    expect(savedSettings().at(-1).group_request_threshold).toBe(1);
  });

  it("a stored 6 comes back as 6 when the switch is turned on and off again", async () => {
    settings = settingsWith(6);
    renderOwner("/reservations?tab=settings", "workshop");
    await screen.findByText(da.rsvpTableTimesAppt);
    await act(async () => { fireEvent.click(approveSwitch()); });
    await act(async () => { fireEvent.click(approveSwitch()); });
    await act(async () => { fireEvent.submit(approveSwitch().closest("form")); });
    await settle(4);
    expect(savedSettings().at(-1).group_request_threshold).toBe(6);
  });

  it("a workshop without places: no switch at 8 (never had the number), the switch at a stored 1", async () => {
    resources = [];
    renderOwner("/reservations?tab=settings", "workshop");
    await settle(16);
    expect(approveSwitch()).toBeNull();
    cleanup();
    settings = settingsWith(1);
    renderOwner("/reservations?tab=settings", "workshop");
    await settle(16);
    expect(approveSwitch()).not.toBeNull();
    expect(approveSwitch().checked).toBe(true);
  });

  it("a café keeps its number field and gets no switch (unchanged)", async () => {
    resources = [place("t1", "Bord 1", 4)];
    renderOwner("/reservations?tab=settings", "cafe");
    await screen.findByText(da.rsvpMaxParty);
    expect(pageText()).toContain(da.rsvpGroupThreshold);
    expect(approveSwitch()).toBeNull();
  });
});

describe("MAJOR · the public page of a shop that approves every booking", () => {
  function publicRoutes(type) {
    const today = new Date();
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/v") {
        return Promise.resolve({ data: {
          business_name: "Butik Nørrebro", business_type: type, max_party_size: 10, group_request_threshold: 1,
          max_advance_days: 60, lead_time_min: 0, language: "da", allergen_set: [],
        } });
      }
      if (url === "/public/reservations/v/availability-summary") {
        return Promise.resolve({ data: { next_open_day: isoDay(today), days: [{ date: isoDay(today), has_slots: true, reason: null }] } });
      }
      if (url === "/public/reservations/v/availability") {
        return Promise.resolve({ data: { slots: ["13:15", "13:30"], slot_remaining: {}, group_request: true } });
      }
      return Promise.resolve({ data: {} });
    });
  }
  const renderPublic = () => render(
    <MemoryRouter initialEntries={["/r/v"]}>
      <Routes><Route path="/r/:slug" element={<ReservationPublicPage />} /></Routes>
    </MemoryRouter>,
  );

  it.each(["clothing", "workshop"])("%s: 'Alle aftaler sendes som en forespørgsel', not 'Selskaber på 1 … I ønsker'", async (type) => {
    publicRoutes(type);
    renderPublic();
    await settle(16);
    expect(pageText()).toContain(da.rsvpGroupWishedTimeHintAppt);
    expect(pageText()).not.toMatch(/selskab|I ønsker/i);
    expect(pageText()).toContain(da.rsvpPickWishedTime);
  });

  it("a restaurant keeps 'Selskaber på {n}' (unchanged)", async () => {
    publicRoutes("restaurant");
    renderPublic();
    await settle(16);
    expect(pageText()).toMatch(/Selskaber på \d+ sendes som en forespørgsel/);
  });
});

describe("an older allergy note on a shop's booking can only be removed — all of it", () => {
  const openEdit = async (type) => {
    renderOwner("/reservations", type);
    await settle(16);
    const row = [...document.querySelectorAll('[role="button"][data-status], tr')].find((el) => el.textContent.includes("Peter Hansen"));
    await act(async () => { fireEvent.click(row); });
    await settle(4);
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: da.rsvpEditAction })); });
    await settle(4);
    return screen.getByRole("dialog", { name: type === "restaurant" ? da.rsvpEditTitle : da.rsvpEditTitleAppt });
  };
  const legacy = () => { rows = [{ ...bookRows()[0], allergy_note: "nødder", allergy_severity: "severe" }]; };
  const patched = () => h.patch.mock.calls.filter(([u]) => u === "/reservations/reservations/b1").map(([, b]) => b);

  it("workshop: shown read-only with 'Alvorlig', no field to type in, no 'vært-skærmen'", async () => {
    legacy();
    const sheet = await openEdit("workshop");
    expect(sheet.querySelector("#eb-allergy")).toBeNull();
    const old = sheet.querySelector("[data-old-allergy]");
    expect(old.textContent).toContain(da.rsvpEditOldAllergyAppt);
    expect(old.textContent).toContain(`nødder · ${da.rsvpSevSevere}`);
    expect(sheet.textContent).not.toMatch(/vært-skærm/i);
    // Saving something else leaves the allergy alone.
    fireEvent.change(within(sheet).getByDisplayValue("Peter Hansen"), { target: { value: "Peter H. Hansen" } });
    await act(async () => { fireEvent.submit(sheet.querySelector("form")); });
    await settle(4);
    expect(patched().at(-1)).not.toHaveProperty("allergy_note");
    expect(patched().at(-1)).not.toHaveProperty("allergy_severity");
  });

  it("workshop: 'Fjern' then save clears the note and its severity together; 'Fortryd' takes it back", async () => {
    legacy();
    const sheet = await openEdit("workshop");
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: da.rsvpEditOldAllergyRemoveAppt })); });
    expect(sheet.textContent).toContain(da.rsvpEditOldAllergyRemovedAppt);
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: da.rsvpEditOldAllergyUndoAppt })); });
    expect(sheet.textContent).toContain("nødder");
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: da.rsvpEditOldAllergyRemoveAppt })); });
    await act(async () => { fireEvent.submit(sheet.querySelector("form")); });
    await settle(4);
    const body = patched().at(-1);
    expect(body.allergy_note).toBe("");
    expect(body.allergy_severity).toBe("");
  });

  it("a restaurant keeps its editable allergy field (unchanged)", async () => {
    resources = [place("p2", "Bord 2", 4)];
    legacy();
    const sheet = await openEdit("restaurant");
    expect(sheet.querySelector("#eb-allergy").value).toBe("nødder");
    expect(sheet.querySelector("[data-old-allergy]")).toBeNull();
  });
});

describe("one place is one place in the drawer's picker", () => {
  // Expectation changed (Push 8 review, round 6): a shop's place holds
  // people, as its Spaces tab says — "Plads 3 · 2 pladser" read as a place of
  // two places, and English said "1 seat". One is still one: never "1 pladser".
  it("workshop: 'Plads 1 · 1 pers.', never '1 pladser' or '1 plads'", async () => {
    renderOwner("/reservations", "workshop");
    await settle(16);
    const row = [...document.querySelectorAll('[role="button"][data-status], tr')].find((el) => el.textContent.includes("Peter Hansen"));
    await act(async () => { fireEvent.click(row); });
    await settle(4);
    const options = [...document.querySelectorAll("#rsvp-drawer-table option")].map((o) => o.textContent);
    expect(options).toContain("Plads 1 · 1 pers.");
    expect(options.join(" | ")).not.toMatch(/\b\d+ pladser?\b/);
  });

  it("a four-top still reads 'pladser'", async () => {
    resources = [place("p1", "Bord 1", 4), place("p2", "Bord 2", 2)];
    renderOwner("/reservations", "restaurant");
    await settle(16);
    const row = [...document.querySelectorAll('[role="button"][data-status], tr')].find((el) => el.textContent.includes("Peter Hansen"));
    await act(async () => { fireEvent.click(row); });
    await settle(4);
    const options = [...document.querySelectorAll("#rsvp-drawer-table option")].map((o) => o.textContent);
    expect(options).toContain("Bord 1 · 4 pladser");
  });
});

// ── Push 8 review, round 6 ────────────────────────────────────────────────

const openDrawerOf = async (type, name = "Peter Hansen") => {
  renderOwner("/reservations", type);
  await settle(16);
  const row = [...document.querySelectorAll('[role="button"][data-status], tr')].find((el) => el.textContent.includes(name));
  await act(async () => { fireEvent.click(row); });
  await settle(4);
};

describe("a shop's place picker counts people, as its Spaces tab does (review 6)", () => {
  beforeEach(() => { resources = [place("p1", "Plads 1", 1), place("p2", "Plads 2", 2), place("p3", "Plads 3", 2)]; });

  it.each(["workshop", "clothing"])("%s, Danish drawer: 'Plads 3 · 2 pers.', no place counted in places", async (type) => {
    await openDrawerOf(type);
    const options = [...document.querySelectorAll("#rsvp-drawer-table option")].map((o) => o.textContent);
    expect(options).toContain("Plads 1 · 1 pers.");
    expect(options).toContain("Plads 3 · 2 pers.");
    expect(options.join(" | ")).not.toMatch(/\b\d+ pladser?\b/);
  });

  it("workshop, English drawer and check-in sheet: '1 person', '2 people' — never 'seat'", async () => {
    h.lang = "en";
    await openDrawerOf("workshop");
    const options = [...document.querySelectorAll("#rsvp-drawer-table option")].map((o) => o.textContent);
    expect(options).toContain("Plads 1 · 1 person");
    expect(options.some((o) => o.startsWith("Plads 3 · 2 people"))).toBe(true);
    expect(options.join(" | ")).not.toMatch(/\bseats?\b/i);
    cleanup();

    h.lang = "en";
    renderOwner("/reservations/stand", "workshop");
    await settle(16);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: en.rsvpSeatWalkInAppt })[0]); });
    await settle(4);
    const dialog = screen.getByRole("dialog", { name: en.rsvpSeatNowTitleAppt });
    const opts = within(dialog).getAllByRole("option").map((o) => o.textContent);
    expect(opts.some((o) => o.startsWith("Plads 1 · 1 person"))).toBe(true);
    expect(opts.some((o) => o.startsWith("Plads 3 · 2 people"))).toBe(true);
    expect(dialog.textContent).not.toMatch(/\bseats?\b/i);
  });

  it("a restaurant's tables keep their seats (unchanged)", async () => {
    resources = [place("p1", "Bord 1", 1), place("p2", "Bord 2", 4)];
    await openDrawerOf("restaurant");
    const options = [...document.querySelectorAll("#rsvp-drawer-table option")].map((o) => o.textContent);
    expect(options).toContain("Bord 1 · 1 plads");
    expect(options.some((o) => o.startsWith("Bord 2 · 4 pladser"))).toBe(true);
  });

  it("the new unit has real Danish and English", () => {
    expect(da.rsvpPersonUnitAppt).toBe("pers.");
    expect(en.rsvpPersonUnitAppt).toBe("person");
  });
});

describe("an older allergy stored only as tags on a shop's booking can be removed (review 6)", () => {
  const patched = () => h.patch.mock.calls.filter(([u]) => u === "/reservations/reservations/b1").map(([, b]) => b);
  const openEdit = async (type) => {
    await openDrawerOf(type);
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: da.rsvpEditAction })); });
    await settle(4);
    return screen.getByRole("dialog", { name: type === "restaurant" ? da.rsvpEditTitle : da.rsvpEditTitleAppt });
  };
  const tagsOnly = () => { rows = [{ ...bookRows()[0], allergen_tags: ["nuts"], allergy_note: null, allergy_severity: null }]; };

  it.each(["workshop", "clothing"])("%s: 'Trænødder' shows in the sheet, and 'Fjern' then save clears the tags too", async (type) => {
    tagsOnly();
    const sheet = await openEdit(type);
    const old = sheet.querySelector("[data-old-allergy]");
    expect(old, "the old-allergy block").not.toBeNull();
    expect(old.textContent).toContain(da.allergen_nuts);
    expect(sheet.querySelector("#eb-allergy")).toBeNull();
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: da.rsvpEditOldAllergyRemoveAppt })); });
    await act(async () => { fireEvent.submit(sheet.querySelector("form")); });
    await settle(4);
    const body = patched().at(-1);
    expect(body.allergen_tags).toEqual([]);
    expect(body.allergy_note).toBe("");
    expect(body.allergy_severity).toBe("");
  });

  it("workshop: saving something else leaves the tags alone", async () => {
    tagsOnly();
    const sheet = await openEdit("workshop");
    fireEvent.change(within(sheet).getByDisplayValue("Peter Hansen"), { target: { value: "Peter H. Hansen" } });
    await act(async () => { fireEvent.submit(sheet.querySelector("form")); });
    await settle(4);
    const body = patched().at(-1);
    expect(body).not.toHaveProperty("allergen_tags");
    expect(body).not.toHaveProperty("allergy_note");
  });

  it("tags, note and severity together read as one line", async () => {
    rows = [{ ...bookRows()[0], allergen_tags: ["nuts"], allergy_note: "også mandler", allergy_severity: "severe" }];
    const sheet = await openEdit("workshop");
    expect(sheet.querySelector("[data-old-allergy]").textContent)
      .toContain(`${da.allergen_nuts} · også mandler · ${da.rsvpSevSevere}`);
  });

  it("a restaurant's booking with tags keeps its editable field (unchanged)", async () => {
    resources = [place("p2", "Bord 2", 4)];
    tagsOnly();
    const sheet = await openEdit("restaurant");
    expect(sheet.querySelector("[data-old-allergy]")).toBeNull();
    expect(sheet.querySelector("#eb-allergy")).not.toBeNull();
  });
});

describe("Indsigt: one booked is one, one table is one (review 6)", () => {
  const PARTY_FIT = {
    confidence: "confident",
    party_histogram: [{ bin: "1-2", count: 4 }, { bin: "3-4", count: 1 }, { bin: "5-6", count: 1 }],
    capacity_histogram: [{ bin: "1-2", count: 1 }, { bin: "3-4", count: 3 }, { bin: "5-6", count: 0 }],
  };
  const renderFit = (type, lang) => {
    h.lang = lang;
    h.user = { id: "u1", business_type: type, business_name: "Restaurant Vandkunsten", role: "owner" };
    h.get.mockImplementation((url) => {
      if (url === "/reservations/insights") {
        return Promise.resolve({ data: {
          utilization: { confidence: "insufficient" }, heatmap: { confidence: "insufficient" },
          no_show_rate: { confidence: "insufficient" }, source_mix: { confidence: "insufficient" },
          party_size_fit: PARTY_FIT, recovered: { confidence: "insufficient" }, forecast: { days: [] }, forecast_locked: false,
        } });
      }
      if (url === "/reservations/monthly") return Promise.resolve({ data: { months: [] } });
      return Promise.resolve({ data: {} });
    });
    const dict = lang === "en" ? en : da;
    const t = (k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      let s = dict[k] ?? (typeof fb === "string" ? fb : k);
      if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
      return s;
    };
    return render(<MemoryRouter><InsightsSection t={t} /></MemoryRouter>);
  };

  it("restaurant, Danish: '1 booket · 3 borde', '4 bookede · 1 bord' — never '1 bookede'", async () => {
    renderFit("restaurant", "da");
    await settle(16);
    const text = document.body.textContent;
    expect(text).toContain("4 bookede · 1 bord");
    expect(text).toContain("1 booket · 3 borde");
    expect(text).toContain("1 booket · 0 borde");
    // Cells run together in textContent ("1 bordeReservationer"): no \b at the end.
    expect(text).not.toMatch(/(^|\D)1 (bookede|borde)/);
  });

  it("restaurant, English: '1 booked · 1 table'", async () => {
    renderFit("restaurant", "en");
    await settle(16);
    const text = document.body.textContent;
    expect(text).toContain("4 booked · 1 table");
    expect(text).toContain("1 booked · 3 tables");
    expect(text).not.toMatch(/(^|\D)1 tables/);
  });

  it("workshop, Danish: places — '4 bookede · 1 plads', '1 booket · 3 pladser'", async () => {
    renderFit("workshop", "da");
    await settle(16);
    const text = document.body.textContent;
    expect(text).toContain("4 bookede · 1 plads");
    expect(text).toContain("1 booket · 3 pladser");
    expect(text).not.toMatch(/(^|\D)1 pladser|\d+ bord/);
  });

  it("the new keys have real Danish and English", () => {
    for (const k of ["rsvpInsBookedOne", "rsvpInsBooked", "rsvpInsTablesOne", "rsvpInsTables", "rsvpInsSpacesOne", "rsvpInsSpaces"]) {
      expect(da[k], k).toMatch(/^\{n\} \S/);
      expect(en[k], k).toMatch(/^\{n\} \S/);
    }
  });
});

describe("English shop words: spaces and people, not seats", () => {
  it("workshop Spaces tab: no 'seat' in the text, a placeholder or a label", async () => {
    h.lang = "en";
    renderOwner("/reservations?tab=floor", "workshop");
    await settle(16);
    expect(document.body.textContent).toContain(en.rsvpAddTableAppt);
    expect(document.body.textContent).not.toMatch(/\bseats?\b|\bpax\b/i);
    expect(attrText()).not.toMatch(/\bseats?\b/i);
    expect(document.querySelector(`input[placeholder="${en.rsvpTableSeatsPhAppt}"]`)).not.toBeNull();
  });

  it("a café's Tables tab keeps 'Seats' (unchanged)", async () => {
    h.lang = "en";
    resources = [place("t1", "Table 1", 4)];
    renderOwner("/reservations?tab=floor", "cafe");
    await settle(16);
    expect(document.querySelector(`input[placeholder="${en.rsvpTableSeatsPh}"]`)).not.toBeNull();
  });

  const INSIGHTS = {
    utilization: { confidence: "confident", seat_hour_pct: 42, booked_covers: 31 },
    heatmap: { confidence: "insufficient" }, no_show_rate: { confidence: "insufficient" },
    source_mix: { confidence: "insufficient" }, party_size_fit: { confidence: "insufficient" },
    recovered: { confidence: "insufficient" }, forecast: { days: [] }, forecast_locked: false,
  };
  const renderInsights = (type) => {
    h.lang = "en";
    h.user = { id: "u1", business_type: type, business_name: "Cykelværkstedet Amager", role: "owner" };
    h.get.mockImplementation((url) => {
      if (url === "/reservations/insights") return Promise.resolve({ data: INSIGHTS });
      if (url === "/reservations/monthly") return Promise.resolve({ data: { months: [] } });
      return Promise.resolve({ data: {} });
    });
    const t = (k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      let s = en[k] ?? (typeof fb === "string" ? fb : k);
      if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
      return s;
    };
    return render(<MemoryRouter><InsightsSection t={t} /></MemoryRouter>);
  };

  it.each(["workshop", "clothing"])("%s Insights: 'Space utilization · of space-hours'", async (type) => {
    renderInsights(type);
    await settle(16);
    expect(document.body.textContent).toContain(en.rsvpInsKpiUtilAppt);
    expect(document.body.textContent).toContain(en.rsvpInsKpiUtilHelpAppt);
    expect(document.body.textContent).not.toMatch(/\bseat/i);
  });

  it("a restaurant's Insights keep 'Seat utilization' (unchanged)", async () => {
    renderInsights("restaurant");
    await settle(16);
    expect(document.body.textContent).toContain(en.rsvpInsKpiUtil);
  });
});

describe("the round-5 words have real Danish and English, with no restaurant word", () => {
  const KEYS = [
    "rsvpApproveOnlineAppt", "rsvpApproveOnlineHintAppt", "rsvpGroupWishedTimeHintAppt",
    "rsvpInsKpiUtilAppt", "rsvpInsKpiUtilHelpAppt", "rsvpTableSeatsPhAppt", "rsvpPeopleUnitAppt",
    "rsvpTableSeatsAriaAppt", "rsvpEditOldAllergyAppt", "rsvpEditOldAllergyHintAppt",
    "rsvpEditOldAllergyRemoveAppt", "rsvpEditOldAllergyRemovedAppt", "rsvpEditOldAllergyUndoAppt",
  ];
  it("every one of them", () => {
    for (const k of KEYS) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
      expect(da[k].replace(/\{\w+\}/g, ""), k).not.toMatch(/gæst|bord|selskab|køkken|reservation|couvert|vært/i);
      expect(en[k].replace(/\{\w+\}/g, ""), k).not.toMatch(/guest|table|party|kitchen|reservation|\bcovers?\b|host|seat/i);
    }
  });
});
