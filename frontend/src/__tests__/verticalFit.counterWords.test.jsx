/**
 * Push 8 review (14 Oct 2026) — QA item 8 on the counter screen.
 *
 * A workshop (or a clothing shop) that has places in its book ("Plads 1",
 * "Plads 2" — table-kind resources, so the stand grandfathers the drop-in
 * row and the header's seat sheet) still read the restaurant's words there:
 * the drop-in row "Tryk på antal gæster" and "1 gæst: intet bord ledigt nu …",
 * the header "Sæt en drop-in til bords", the seat sheet "Sæt gæster til bords
 * / BORD / Vælg bord / Ingen ledige borde lige nu / ANTAL GÆSTER / Andet antal
 * gæster / Sæt til bords" with chips named "2 gæster", the line after a seat
 * "1 gæst sat ved …", and the desktop list's "BORD" column.
 *
 * A shop and a workshop check a customer in at a place (venueProfiles: the
 * retail and services archetypes' noun is "Plads"), counted as people. A
 * restaurant keeps every one of its words (control at the end).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, configure } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.setConfig({ testTimeout: 30000 });
configure({ asyncUtilTimeout: 5000 });

const lang = vi.hoisted(() => ({ code: "da" }));
const who = vi.hoisted(() => ({ type: "workshop" }));
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: who.type, business_name: "Værksted Syd" }, logout: vi.fn(), loading: false }),
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  return {
    useLanguage: () => ({
      t: (k, fb, vars) => {
        const v = typeof fb === "object" && fb ? fb : vars;
        const dict = lang.code === "da" ? DA : EN;
        let s = dict[k] ?? (typeof fb === "string" ? fb : k);
        if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
        return s;
      },
      lang: lang.code,
    }),
  };
});
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, isReady: true }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("../utils/sound", () => ({
  getSoundStatus: () => "off",
  subscribeSound: () => () => {},
  testSound: vi.fn(),
  playChime: vi.fn(),
  playUrgent: vi.fn(),
  unlockSound: vi.fn(),
  prepareSoundWhenIdle: vi.fn(() => () => {}),
}));

import api from "../services/api";
import ReservationsPage from "../pages/ReservationsPage";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const DAY = "2026-10-14";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const z = (hhmm) => new Date(at(hhmm)).toISOString();
const place = (id, label, seats, extra = {}) => ({ id, label, capacity_seats: seats, kind: "table", is_active: true, zone: null, pos_x: 10, pos_y: 10, ...extra });
const row = (id, name, resourceId, status, from, to, party, extra = {}) => ({
  id, guest_name: name, resource_id: resourceId, status, starts_at: at(from), ends_at: at(to),
  party_size: party, source: "manual", allergen_tags: [], seated_at: null, completed_at: null, ...extra,
});

// 11:00 at the workshop: one customer in at Plads 1, one booked for 11:45.
const PLACES = [place("p1", "Plads 1", 2), place("p2", "Plads 2", 2)];
const BOOK = [
  row("a", "Jensen", "p1", "seated", "10:30", "11:30", 1, { seated_at: z("10:30") }),
  row("b", "Hansen", null, "confirmed", "11:45", "12:45", 1),
];
const RULES = {
  settings: { turn_time_tiers: [{ up_to: 2, minutes: 60 }, { up_to: 8, minutes: 90 }], default_duration_min: 60 },
  hours_declared: false,
};

function mockApi({ book = BOOK, resources = PLACES } = {}) {
  api.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: RULES });
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: RULES });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { date: DAY, reservations: book, summary: { total: book.length, covers: 0, by_status: {} } } });
    }
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources, fixtures: [], venue_seats_total: 4 } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
  api.post.mockImplementation((url, body) => Promise.resolve({
    data: { id: "new-walkin", ...body, combined_resource_ids: null },
  }));
}

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  lang.code = "da";
  who.type = "workshop";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at("11:00")));
  vi.clearAllMocks();
  mockApi();
});
afterEach(() => vi.useRealTimers());

const renderAt = (path = "/reservations/stand") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
const sizeButton = async (n) => {
  await waitFor(() => expect(document.querySelector(`[data-walkin="${n}"]`)).not.toBeNull());
  return document.querySelector(`[data-walkin="${n}"]`);
};

// The restaurant's words: gæst/gæster, bord/borde/bordet (not "border"), til bords.
const RESTAURANT_DA = /gæst|\bbord(?!er\b)|\bborde|til bords/i;
const RESTAURANT_EN = /\bguests?\b|\btables?\b|\bseat(ed|ing)?\b(?! *\d)/i;
const textOf = (el) => el.textContent || "";
const ariaOf = (el) => [el, ...el.querySelectorAll("[aria-label],[title],[placeholder]")]
  .map((n) => [n.getAttribute?.("aria-label"), n.getAttribute?.("title"), n.getAttribute?.("placeholder")].filter(Boolean).join(" "))
  .filter(Boolean)
  .join(" | ");
// Each hit with the words around it, so a failure says where it is.
const restaurantWords = (el, re = RESTAURANT_DA) => {
  const all = `${textOf(el)} || ${ariaOf(el)}`;
  return [...all.matchAll(new RegExp(re.source, "gi"))].map((m) => all.slice(Math.max(0, m.index - 30), m.index + 30));
};

describe.each(["workshop", "clothing"])("8 · %s: the counter screen speaks appointments", (type) => {
  beforeEach(() => { who.type = type; });

  it("the drop-in row: 'Tryk på antal personer', and its buttons are named for people and places", async () => {
    renderAt();
    const one = await sizeButton(1);
    await waitFor(() => expect(one.getAttribute("data-walkin-state")).toBe("free"));
    const rowEl = one.closest('section[aria-labelledby="rsvp-walkin-title"]');
    expect(textOf(rowEl)).toContain(da.rsvpWalkInHintAppt);
    expect(one.getAttribute("aria-label")).toBe("1 person: tjek ind nu ved Plads 2");
    expect((await sizeButton(2)).getAttribute("aria-label")).toBe("2 personer: tjek ind nu ved Plads 2");
    expect(restaurantWords(rowEl)).toEqual([]);
  });

  it("the header's drop-in and the seat sheet: no guests, no tables", async () => {
    renderAt();
    await sizeButton(1);
    const opener = screen.getByRole("button", { name: da.rsvpSeatWalkInAppt });
    expect(da.rsvpSeatWalkInAppt).toBe("Tjek en drop-in ind");
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: da.rsvpSeatNowTitleAppt });
    const sel = within(dialog).getByRole("combobox", { name: da.rsvpSeatWalkInTableAppt });
    await waitFor(() => expect(sel).toHaveValue("p2"));
    expect(textOf(dialog)).toContain(da.rsvpPartySizeAppt);
    expect(within(dialog).getByRole("button", { name: "2 personer" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: da.rsvpSeatActionAppt })).toBeInTheDocument();
    expect(restaurantWords(dialog)).toEqual([]);
    // Nothing fits three: "Vælg plads" and the place words in the box.
    fireEvent.click(within(dialog).getByRole("button", { name: "3 personer" }));
    await waitFor(() => expect(sel).toHaveValue(""));
    expect(within(dialog).getByRole("option", { name: da.rsvpSeatPickTableAppt })).toBeInTheDocument();
    expect(dialog.querySelector("[data-seat-none-free]")).not.toBeNull();
    expect(restaurantWords(dialog)).toEqual([]);
    // A place picked by hand that is too small says so in the counter's words.
    fireEvent.change(sel, { target: { value: "p2" } });
    expect(within(dialog).getByText("Pladsen har plads til 2 — du tjekker 3 ind.")).toBeInTheDocument();
    expect(restaurantWords(dialog)).toEqual([]);
  });

  it("a check-in from the sheet says where, in the counter's words", async () => {
    renderAt();
    await sizeButton(1);
    fireEvent.click(screen.getByRole("button", { name: da.rsvpSeatWalkInAppt }));
    const dialog = await screen.findByRole("dialog", { name: da.rsvpSeatNowTitleAppt });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: da.rsvpSeatWalkInTableAppt })).toHaveValue("p2"));
    fireEvent.click(within(dialog).getByRole("button", { name: "1 person" }));
    fireEvent.click(within(dialog).getByRole("button", { name: da.rsvpSeatActionAppt }));
    const said = await screen.findByText("1 person tjekket ind ved Plads 2");
    const line = said.closest("[data-walkin-done]");
    expect(within(line).getByRole("button", { name: da.rsvpWalkInChangeTableAppt })).toBeInTheDocument();
    expect(restaurantWords(line)).toEqual([]);
  });

  it("a refusal in the sheet speaks of places", async () => {
    api.post.mockImplementation(() => Promise.reject({
      response: { status: 409, data: { detail: { error: "table_occupied", occupant: { table: "Plads 2", name: "Holm" } } } },
    }));
    renderAt();
    await sizeButton(1);
    fireEvent.click(screen.getByRole("button", { name: da.rsvpSeatWalkInAppt }));
    const dialog = await screen.findByRole("dialog", { name: da.rsvpSeatNowTitleAppt });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: da.rsvpSeatWalkInTableAppt })).toHaveValue("p2"));
    fireEvent.click(within(dialog).getByRole("button", { name: da.rsvpSeatActionAppt }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("Plads 2 er stadig optaget — afslut aftalen der først, eller vælg en anden plads.");
  });

  it("the whole counter screen, list and covers: no restaurant word", async () => {
    renderAt();
    const one = await sizeButton(1);
    await waitFor(() => expect(one.getAttribute("data-walkin-state")).toBe("free"));
    await waitFor(() => expect(screen.getAllByText("Hansen").length).toBeGreaterThan(0));
    expect(restaurantWords(document.body)).toEqual([]);
  });

  it("a booking's drawer: assign a place, join places — no table words", async () => {
    renderAt();
    await waitFor(() => expect(screen.getAllByText("Hansen").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("Hansen")[0]);
    const select = await screen.findByRole("combobox", { name: da.rsvpAssignTableAppt });
    const drawer = select.closest('[role="dialog"]') || document.body;
    expect(within(drawer).getByRole("option", { name: da.rsvpChooseTableAppt })).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: da.rsvpCombineTablesAppt }));
    expect(within(drawer).getByText("0 pladser til 1 person")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: da.rsvpCombineSaveAppt })).toBeInTheDocument();
    expect(restaurantWords(drawer)).toEqual([]);
  });

  it("the owner's book: the place column and the header button", async () => {
    renderAt("/reservations");
    await waitFor(() => expect(screen.getAllByText("Hansen").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: da.rsvpSeatWalkInAppt })).toBeInTheDocument();
    const headers = [...document.querySelectorAll("th")].map((th) => th.textContent.trim());
    expect(headers).toContain(da.rsvpColTableAppt);
    expect(headers).not.toContain(da.rsvpColTable);
  });
});

describe("8 · in English too", () => {
  it("the sheet and the row speak of customers and spaces", async () => {
    lang.code = "en";
    renderAt();
    const one = await sizeButton(1);
    await waitFor(() => expect(one.getAttribute("data-walkin-state")).toBe("free"));
    expect(one.getAttribute("aria-label")).toBe("1 person: check in now at Plads 2");
    fireEvent.click(screen.getByRole("button", { name: en.rsvpSeatWalkInAppt }));
    const dialog = await screen.findByRole("dialog", { name: en.rsvpSeatNowTitleAppt });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: en.rsvpSeatWalkInTableAppt })).toHaveValue("p2"));
    expect(restaurantWords(dialog, RESTAURANT_EN)).toEqual([]);
  });

  it("every new key has real Danish and English", () => {
    const keys = [
      "rsvpSeatNowTitleAppt", "rsvpSeatWalkInAppt", "rsvpSeatWalkInTableAppt", "rsvpSeatWalkInNoTablesAppt",
      "rsvpSeatPickTableAppt", "rsvpSeatNoneFreeAppt", "rsvpSeatNoneFitsAppt", "rsvpSeatTableSmallAppt",
      "rsvpSeatJoinedOptionAppt", "rsvpWalkInHintAppt",
      "rsvpWalkInPickAriaAppt", "rsvpWalkInPickAriaOneAppt", "rsvpWalkInSheetAriaAppt",
      "rsvpWalkInSeatAriaAppt", "rsvpWalkInSeatAriaOneAppt", "rsvpWalkInWaitAriaAppt", "rsvpWalkInWaitAriaOneAppt",
      "rsvpWalkInWlAriaAppt", "rsvpWalkInWlAriaOneAppt",
      "rsvpWalkInSeatedAppt", "rsvpWalkInSeatedOneAppt", "rsvpWalkInSeatedElsewhereAppt", "rsvpWalkInSeatedNoTableAppt",
      "rsvpWalkInChangeTableAppt", "rsvpSeatTablesTakenAppt", "rsvpSeatTableTakenAppt", "rsvpTableStillTakenAppt",
      "rsvpTableFallbackAppt", "rsvpSeatErrorAppt", "rsvpColTableAppt", "rsvpNoTableShortAppt", "rsvpOverFullAppt",
      "rsvpAssignTableAppt", "rsvpChooseTableAppt", "rsvpCombineTablesAppt", "rsvpCombineChangeAppt",
      "rsvpCombineSaveAppt", "rsvpCombineSeatsAppt", "rsvpCombineSeatsOneAppt",
    ];
    for (const k of keys) {
      expect(typeof da[k], k).toBe("string");
      expect(typeof en[k], k).toBe("string");
      expect(da[k], k).not.toBe(en[k]);
      // The words, not the placeholders ("{table}" is the place's own name).
      const words = (s) => s.replace(/\{\w+\}/g, "");
      expect(words(da[k]), k).not.toMatch(RESTAURANT_DA);
      expect(words(en[k]), k).not.toMatch(RESTAURANT_EN);
    }
  });
});

describe("8 · a restaurant keeps its words (control)", () => {
  it("the header's drop-in, the sheet and the row", async () => {
    who.type = "restaurant";
    renderAt();
    const one = await sizeButton(1);
    await waitFor(() => expect(one.getAttribute("data-walkin-state")).toBe("free"));
    expect(one.getAttribute("aria-label")).toBe("1 gæst: sæt til bords nu ved Plads 2");
    expect(textOf(one.closest('section[aria-labelledby="rsvp-walkin-title"]'))).toContain(da.rsvpWalkInHint);
    fireEvent.click(screen.getByRole("button", { name: da.rsvpSeatWalkIn }));
    const dialog = await screen.findByRole("dialog", { name: da.rsvpSeatNowTitle });
    expect(within(dialog).getByRole("combobox", { name: da.rsvpSeatWalkInTable })).toBeInTheDocument();
    expect(textOf(dialog)).toContain(da.rsvpPartySize);
    expect(within(dialog).getByRole("button", { name: "2 gæster" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: da.rsvpSeatNowBtn })).toBeInTheDocument();
  });
});
