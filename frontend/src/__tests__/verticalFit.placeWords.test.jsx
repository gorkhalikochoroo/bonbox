/**
 * Push 8 review (round 3) — item 8 was not met on two surfaces (QA, 14 Oct
 * 2026). A shop or a workshop books CUSTOMERS for a TIME at a PLACE:
 *
 *   • Public page, step 2: "Allergier, anledning eller en besked? · Valgfrit
 *     — så køkkenet kan tage hensyn", the 14 EU food allergens, the dinner
 *     occasions (Bryllupsdag / Date / Forretningsmiddag), and
 *     "reservationsbekræftelse" / "til denne reservation" — for a bike
 *     workshop. Health data with no purpose is not collected: the section is
 *     gone, even if an older server still sends the food set.
 *   • Owner: the Plan legend "Sidder", the timeline's "… · Sidder" and "Sæt
 *     {name} til bords", the "Borde" tab and its "Hvor mange borde af hver
 *     størrelse?" / "Tilføj borde", quick setup naming every place "Bord N",
 *     and the settings' "Maks. antal gæster (online)", "Bordtid … 1–2 gæster"
 *     and "Maks. borde pr. selskab".
 *   • A ?party=4 link on an appointment page set a party the customer could
 *     neither see nor change, while the open days were asked for one.
 *
 * Control cases: a restaurant and a café keep every word; the salon keeps its
 * care allergens and "Sidder".
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });

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
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({ hiddenPillars: new Set(), isReady: true, setPillarHidden: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../hooks/useUndoToast", () => ({ useUndoToast: () => ({ show: vi.fn(), ToastUI: null }) }));
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const pad = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const pageText = () => document.body.textContent || "";
const ariaText = () => [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
  .map((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")].filter(Boolean).join(" "))
  .join(" | ");
// The restaurant words QA found on a shop's or a workshop's surfaces.
const RESTAURANT = /gæst|bord|sidder|selskab|køkken|kuvert/i;
// Every aria-label / title / placeholder that says one, minus the places'
// own names (data: "Plads 1").
const ariaHits = (re = RESTAURANT) => [...document.querySelectorAll("[aria-label],[title],[placeholder]")]
  .flatMap((el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder")])
  .filter(Boolean)
  .map((x) => x.replace(/Plads \d+/g, ""))
  .filter((x) => re.test(x));

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
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

// ── The public page ───────────────────────────────────────────────────────

const FOOD = [
  { key: "gluten", en: "Cereals containing gluten" }, { key: "crustaceans", en: "Crustaceans" },
  { key: "nuts", en: "Tree nuts" }, { key: "lupin", en: "Lupin" }, { key: "molluscs", en: "Molluscs" },
];
const CARE = [{ key: "ppd_hair_dye", en: "PPD / hair dye" }, { key: "latex", en: "Latex" }];

function publicRoutes(type, { allergenSet = FOOD, slug = "v" } = {}) {
  const today = new Date();
  h.get.mockImplementation((url) => {
    if (url === `/public/reservations/${slug}`) {
      return Promise.resolve({ data: {
        business_name: "Cykelværkstedet Amager", business_type: type, max_party_size: 10,
        max_advance_days: 60, lead_time_min: 0, language: "da", allergen_set: allergenSet,
      } });
    }
    if (url === `/public/reservations/${slug}/availability-summary`) {
      return Promise.resolve({ data: { next_open_day: isoDay(today), days: [{ date: isoDay(today), has_slots: true, reason: null }] } });
    }
    if (url === `/public/reservations/${slug}/availability`) {
      return Promise.resolve({ data: { slots: ["13:15", "13:30"], slot_remaining: {} } });
    }
    return Promise.resolve({ data: {} });
  });
}
const renderPublic = (path = "/r/v") => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/r/:slug" element={<ReservationPublicPage />} /></Routes>
  </MemoryRouter>,
);
// Step 1 → 2: tap 13:15, then Fortsæt; open the optional disclosure.
async function toStep2AndOpen() {
  await settle(14);
  await act(async () => { fireEvent.click(await screen.findByRole("radio", { name: /13[.:]15/ })); });
  await settle(4);
  const cont = screen.getAllByRole("button", { name: da.rsvpContinue }).find((b) => !b.disabled);
  await act(async () => { fireEvent.click(cont); });
  await settle(6);
  const toggle = [...document.querySelectorAll("button[aria-expanded]")].find((b) =>
    [da.rsvpExtrasTitle, da.rsvpExtrasTitleNote].some((x) => b.textContent.includes(x)));
  expect(toggle, "the optional disclosure").toBeTruthy();
  const closedText = toggle.textContent;
  await act(async () => { fireEvent.click(toggle); });
  await settle(2);
  return { closedText, box: toggle.parentElement };
}

describe("8 · a shop's and a workshop's public page asks no allergies, no occasion", () => {
  it.each(["workshop", "clothing"])("%s: a note only — no allergens, no occasions, no kitchen, no reservation", async (type) => {
    // An older server still sends the food set: the page never shows it here.
    publicRoutes(type, { allergenSet: FOOD });
    renderPublic();
    const { closedText, box } = await toStep2AndOpen();
    expect(closedText).toContain(da.rsvpExtrasTitleNote);
    expect(closedText).toContain(da.rsvpExtrasHintNote);
    expect(closedText).not.toMatch(/allergi|anledning|køkken/i);
    // Open: the note, and nothing else.
    expect(within(box).getByLabelText(da.rsvpXNote)).toBeInTheDocument();
    expect(box.textContent).not.toContain(da.rsvpXAllergies);
    expect(box.textContent).not.toContain(da.rsvpXOccasion);
    for (const k of ["allergen_crustaceans", "allergen_lupin", "allergen_molluscs"]) {
      expect(box.textContent).not.toContain(da[k]);
    }
    for (const k of ["anniversary", "date", "business"]) {
      expect(box.textContent).not.toContain(da[`rsvpOccasion_${k}`]);
    }
    expect(pageText()).not.toMatch(/køkken|reservation/i);
    expect(pageText()).toContain(da.rsvpMarketingHintAppt);
    expect(pageText()).toContain(da.rsvpPrivacyVenueAppt.replace("{venue}", "Cykelværkstedet Amager"));
    expect(ariaText()).not.toMatch(/reservation|køkken|gæst/i);
    expect(screen.getByRole("progressbar", { name: da.rsvpStepAriaAppt })).toBeInTheDocument();
  });

  it("a restaurant keeps its allergies, occasions and kitchen (unchanged)", async () => {
    publicRoutes("restaurant");
    renderPublic();
    const { closedText, box } = await toStep2AndOpen();
    expect(closedText).toContain(da.rsvpExtrasTitle);
    expect(closedText).toContain(da.rsvpExtrasHint);
    expect(box.textContent).toContain(da.rsvpXAllergies);
    expect(box.textContent).toContain(da.allergen_lupin);
    expect(box.textContent).toContain(da.rsvpOccasion_business);
    expect(box.textContent).toContain(da.rsvpAllergyShared.replace("{venue}", "Cykelværkstedet Amager"));
    expect(pageText()).toContain(da.rsvpMarketingHint);
    expect(screen.getByRole("progressbar", { name: da.rsvpStepAria })).toBeInTheDocument();
  });
});

describe("8 · an appointment page books one customer, whatever the link says", () => {
  const partiesAsked = () => h.get.mock.calls
    .filter(([u]) => u === "/public/reservations/v/availability")
    .map(([, cfg]) => cfg?.params?.party);

  it.each(["clothing", "workshop"])("%s: /r/v?party=4 asks the times for one", async (type) => {
    publicRoutes(type);
    renderPublic("/r/v?party=4");
    await settle(16);
    expect(partiesAsked().length).toBeGreaterThan(0);
    expect(partiesAsked().every((p) => p === 1)).toBe(true);
  });

  it("a restaurant's ?party=4 still sets four (unchanged)", async () => {
    publicRoutes("restaurant");
    renderPublic("/r/v?party=4");
    await settle(16);
    expect(partiesAsked()).toContain(4);
  });
});

// ── The owner's book, its places and its settings ─────────────────────────

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
const place = (id, label, seats = 2) => ({ id, kind: "table", label, capacity_seats: seats, is_active: true, zone: null, pos_x: 20, pos_y: 20 });
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
  h.post.mockImplementation((url, body) => Promise.resolve({ data: url.endsWith("/bulk") ? { created: [], created_count: 3, capped: 0 } : { id: "x", ...body } }));
}
const renderOwner = (path, type) => {
  h.user = { id: "u1", business_type: type, business_name: "Cykelværkstedet Amager", role: "owner" };
  ownerRoutes();
  return render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
};

beforeEach(() => {
  resources = [place("p1", "Plads 1", 1), place("p2", "Plads 2", 2)];
  rows = bookRows();
});

describe("8 · a workshop's places tab, quick setup and settings", () => {
  it.each(["workshop", "clothing"])("%s: the tab reads Pladser; quick setup speaks places and names them 'Plads N'", async (type) => {
    renderOwner("/reservations?tab=floor", type);
    await settle(14);
    expect(screen.getByRole("tab", { name: da.rsvpTabFloorAppt })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: da.rsvpTabFloor })).toBeNull();
    expect(pageText()).toContain(da.rsvpBulkHintAppt);
    expect(pageText()).toContain(da.rsvpFloorIntroAppt);
    // The page's own words: the places' names (data) aside, nothing of a table.
    const words = pageText().replace(/Plads \d+/g, "");
    expect(words).not.toMatch(RESTAURANT);
    expect(ariaHits()).toEqual([]);
    // Quick setup: 3 places for one person each, named "Plads N".
    const countInput = screen.getAllByLabelText(da.rsvpBulkCountAria)[0];
    fireEvent.change(countInput, { target: { value: "3" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpBulkSubmitAppt })); });
    await settle(4);
    const bulk = h.post.mock.calls.find(([u]) => u === "/reservations/resources/bulk");
    expect(bulk[1].label_prefix).toBe(da.rsvpBulkPrefixAppt);
    expect(da.rsvpBulkPrefixAppt).toBe("Plads");
    expect(pageText()).toContain(da.rsvpBulkDoneAppt.replace("{n}", "3"));
  });

  it("a café keeps its Borde tab and quick setup sends no prefix (the server's 'Bord')", async () => {
    resources = [place("t1", "Bord 1", 4)];
    renderOwner("/reservations?tab=floor", "cafe");
    await settle(14);
    expect(screen.getByRole("tab", { name: da.rsvpTabFloor })).toBeInTheDocument();
    expect(pageText()).toContain(da.rsvpBulkHint);
    fireEvent.change(screen.getAllByLabelText(da.rsvpBulkCountAria)[0], { target: { value: "2" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpBulkSubmit })); });
    await settle(4);
    const bulk = h.post.mock.calls.find(([u]) => u === "/reservations/resources/bulk");
    expect(bulk[1]).not.toHaveProperty("label_prefix");
  });

  it("a workshop's settings: people and places, no guests, tables or parties", async () => {
    renderOwner("/reservations?tab=settings", "workshop");
    // Round 4: the two ONLINE party-size rules are gone from a shop's
    // settings — its public page always books one person, so "Maks. antal
    // personer (online)" could never apply (verticalFit.apptWords). The
    // anchor moves to the place rules, which stay.
    await screen.findByText(da.rsvpTableTimesAppt);
    expect(pageText()).not.toContain(da.rsvpMaxPartyAppt);
    for (const k of ["rsvpTableTimesAppt", "rsvpMaxComboSizeAppt", "rsvpGuestPickSettingAppt", "rsvpCombineSettingAppt", "rsvpPacingAppt"]) {
      expect(pageText(), k).toContain(da[k]);
    }
    expect(pageText()).toContain("1–2 personer");
    for (const k of ["rsvpMaxParty", "rsvpTableTimes", "rsvpMaxComboSize", "rsvpGuestPickSetting", "rsvpCombineSetting"]) {
      expect(pageText(), k).not.toContain(da[k]);
    }
    expect(pageText()).not.toMatch(/gæster|selskab|Bordtid/);
  });

  it("a café keeps its table rules (unchanged)", async () => {
    resources = [place("t1", "Bord 1", 4)];
    renderOwner("/reservations?tab=settings", "cafe");
    await screen.findByText(da.rsvpMaxParty);
    expect(pageText()).toContain(da.rsvpMaxComboSize);
    expect(pageText()).toContain("1–2 gæster");
  });
});

describe("8 · a workshop's Plan and Tidslinje", () => {
  const openView = async (type, view) => {
    localStorage.setItem("bonbox.rsvp.view", view);
    renderOwner("/reservations/stand", type);
    await settle(16);
    const tab = screen.queryAllByRole("tab", { name: view === "plan" ? da.rsvpViewPlan : da.rsvpViewTimeline })[0];
    if (tab) await act(async () => { fireEvent.click(tab); });
    await settle(8);
  };

  it("Plan: the legend checks customers in — no 'Sidder', no tables", async () => {
    await openView("workshop", "plan");
    expect(pageText()).toContain(da.rsvpStatusSeatedAppt);
    expect(pageText()).not.toMatch(new RegExp(`\\b${da.rsvpTileSeated}\\b`));
    expect(pageText().replace(/Plads \d+/g, "")).not.toMatch(/\bbord|gæst/i);
    expect(screen.getAllByRole("tablist", { name: da.rsvpViewAriaAppt }).length).toBeGreaterThan(0);
  });

  it("Tidslinje: the bar says 'Tjekket ind' and the arrival button 'Tjek Peter Hansen ind'", async () => {
    await openView("workshop", "tidslinje");
    const titles = [...document.querySelectorAll("[title]")].map((el) => el.getAttribute("title"));
    expect(titles.some((x) => x.includes("Sofie") && x.includes(da.rsvpStatusSeatedAppt))).toBe(true);
    expect(titles.join(" | ")).not.toMatch(/Sidder|til bords/);
    expect(screen.getByRole("button", { name: "Tjek Peter Hansen ind" })).toBeInTheDocument();
    expect(ariaText()).not.toMatch(/til bords|gæst/i);
  });

  it("a restaurant keeps 'Sidder' and 'Sæt … til bords' (unchanged)", async () => {
    resources = [place("p1", "Bord 1", 2), place("p2", "Bord 2", 2)];
    await openView("restaurant", "tidslinje");
    const titles = [...document.querySelectorAll("[title]")].map((el) => el.getAttribute("title")).join(" | ");
    expect(titles).toMatch(/Sofie.*Sidder/);
    expect(screen.getByRole("button", { name: "Sæt Peter Hansen til bords" })).toBeInTheDocument();
  });
});

// Expectation changed (Push 8 review, round 6): the number counts people,
// as the Spaces tab says ("2 pers.") — "Plads 2 · 2 pladser" read as a place
// of two places. One is still one, and never "1 pladser".
describe("9 · a one-person place is '1 pers.' in the check-in sheet (review 3, 6)", () => {
  it("the options say '1 pers.' and '2 pers.', never '1 pladser'", async () => {
    renderOwner("/reservations/stand", "workshop");
    await settle(16);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: da.rsvpSeatWalkInAppt })[0]); });
    await settle(4);
    const dialog = screen.getByRole("dialog", { name: da.rsvpSeatNowTitleAppt });
    const opts = within(dialog).getAllByRole("option").map((o) => o.textContent);
    expect(opts.some((o) => o.startsWith("Plads 1 · 1 pers."))).toBe(true);
    expect(opts.some((o) => o.startsWith("Plads 2 · 2 pers."))).toBe(true);
    expect(opts.join(" | ")).not.toContain("1 pladser");
    expect(opts.join(" | ")).not.toMatch(/\b\d+ pladser?\b/);
    expect(en.rsvpSeatOne).toBe("seat");
  });
});

describe("the new words have real Danish and English", () => {
  const KEYS = Object.keys(da).filter((k) => /^rsvp.*Appt$/.test(k) && [
    "rsvpTabFloorAppt", "rsvpBulkHintAppt", "rsvpBulkSubmitAppt", "rsvpMaxPartyAppt", "rsvpTableTimesAppt",
    "rsvpMaxComboSizeAppt", "rsvpTierBandAppt", "rsvpSeatNowAriaAppt", "rsvpMarketingHintAppt",
    "rsvpPrivacyVenueAppt", "rsvpStepAriaAppt", "rsvpViewAriaAppt", "rsvpFloorIntroAppt", "rsvpGuestPickSettingAppt",
  ].includes(k));

  it("every one of them, with no restaurant word", () => {
    expect(KEYS).toHaveLength(14);
    for (const k of KEYS) {
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
      expect(da[k], k).not.toMatch(/gæst|bord|selskab|køkken|reservation/i);
      expect(en[k], k).not.toMatch(/guest|table|party|kitchen|reservation/i);
    }
    for (const k of ["rsvpExtrasTitleNote", "rsvpExtrasHintNote", "rsvpExtrasHintProvider", "rsvpAllergySharedProvider", "rsvpXAllergyDetailProvider"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).not.toMatch(/køkken/i);
      expect(en[k], k).not.toMatch(/kitchen/i);
    }
  });
});
