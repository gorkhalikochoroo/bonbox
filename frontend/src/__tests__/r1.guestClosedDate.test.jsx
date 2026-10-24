/**
 * R1 B4 (24 Oct 2026) — a date the owner closed for online booking, on the
 * guest page. The strip reads it as closed ("lukket", struck through), the
 * reason line shows the OWNER's note verbatim ("Lukket juleaften"), a pause
 * without a note asks for a call, and while a pause covers today a line says
 * when online booking opens again.
 */
import { dayStateOf, chipWord, markOfReason, reasonSentence, WORDS } from "../utils/dayState";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { da } = await import("../i18n/da");

const TODAY = "2026-10-23"; // a Friday
const plus = (n) => {
  const d = new Date(2026, 9, 23 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const PAGE = {
  business_name: "Bistro Nørrebro", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Nørrebrogade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false, providers: [],
  allergen_set: [], logo_url: null, closures: [], paused_until: null,
};
function summary(dayOverrides = {}) {
  const days = Array.from({ length: 14 }, (_, i) => ({ date: plus(i), has_slots: true, reason: null, ...(dayOverrides[i] || {}) }));
  const first = days.find((d) => d.has_slots);
  return { from: TODAY, party_size: 2, next_open_day: first ? first.date : null, days };
}
let summaryCalls = 0;
function routes({ page = PAGE, sum = () => summary(), availability } = {}) {
  summaryCalls = 0;
  h.get.mockImplementation((url, cfg) => {
    if (url === "/public/reservations/x") return Promise.resolve({ data: page });
    if (url === "/public/reservations/x/availability-summary") { summaryCalls += 1; return Promise.resolve({ data: sum(cfg?.params || {}) }); }
    if (url === "/public/reservations/x/availability") {
      return Promise.resolve({ data: availability ? availability(cfg?.params || {}) : { slots: ["19:00", "19:30"], slot_remaining: {} } });
    }
    if (url === "/public/reservations/x/floor") return Promise.resolve({ data: { tables: [] } });
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
// Step 1 → 19:00 → Fortsæt → name + e-mail.
async function toDetails() {
  await act(async () => { fireEvent.click(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "19:00")); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fortsæt/ })); });
  await settle(4);
  await act(async () => { fireEvent.change(document.getElementById("rsvp-name"), { target: { value: "Sita Sharma" } }); });
  await act(async () => { fireEvent.change(document.getElementById("rsvp-email"), { target: { value: "sita@example.com" } }); });
}
const submit = async () => {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpConfirm) })); });
  await settle(6);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 23, 12, 0));
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const tDa = (k, fb, vars) => {
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

describe("dayState: closed_date", () => {
  it("reads as closed: the chip word and the strike", () => {
    expect(dayStateOf("closed_date")).toBe("closed");
    expect(chipWord("closed_date", tDa)).toBe("lukket");
    expect(markOfReason("closed_date")).toBe("strike");
  });

  it("the reason line is the owner's note, else closed, else paused", () => {
    expect(reasonSentence("closed_date", tDa, { closure: { note: "Lukket juleaften", kind: "closed" } }))
      .toBe("Lukket juleaften");
    expect(reasonSentence("closed_date", tDa, { closure: { note: null, kind: "closed" } }))
      .toBe(da.rsvpReasonClosed);
    expect(reasonSentence("closed_date", tDa, { closure: { note: null, kind: "pause" } }))
      .toBe(da.rsvpReasonPaused);
    expect(reasonSentence("closed_date", tDa, {})).toBe(da.rsvpReasonClosed);
  });

  it("the new WORDS are the en.js values", async () => {
    const { en } = await import("../i18n/en");
    expect(WORDS.rsvpReasonPaused).toBe(en.rsvpReasonPaused);
    expect(WORDS.rsvpPausedReopens).toBe(en.rsvpPausedReopens);
  });
});

describe("the guest page on a closed date", () => {
  it("the strip shows the day closed and the line shows the note", async () => {
    routes({
      sum: () => summary({ 1: { has_slots: false, reason: "closed_date", note: "Lukket juleaften", kind: "closed" } }),
      availability: (p) => (p.day === plus(1)
        ? { slots: [], slot_remaining: {}, reason: "closed_date", closure: { note: "Lukket juleaften", kind: "closed" } }
        : { slots: ["19:00", "19:30"], slot_remaining: {} }),
    });
    renderAt(`/r/x?d=${plus(1)}`);
    await settle();
    // The page moved on to an open day (auto-advance); the strip marks the
    // closed one and says why, in the owner's words.
    const chip = document.querySelector(`[data-date="${plus(1)}"]`) ||
      [...document.querySelectorAll('[role="radio"]')].find((r) => r.disabled && /lukket/.test(r.textContent));
    expect(chip).toBeTruthy();
    expect(chip.disabled).toBe(true);
    expect(chip.textContent).toContain("lukket");
    const notes = screen.getByTestId("rsvp-closure-notes");
    expect(notes.textContent).toContain("Lukket juleaften");
  });

  it("a guest on the closed day itself reads the note as the reason", async () => {
    // Every day in the window closed (a long pause): the selected day is a
    // closed one, and its line is the owner's note.
    const allClosed = Object.fromEntries(Array.from({ length: 14 }, (_, i) =>
      [i, { has_slots: false, reason: "closed_date", note: "Ferielukket", kind: "closed" }]));
    routes({
      sum: () => summary(allClosed),
      availability: () => ({ slots: [], slot_remaining: {}, reason: "closed_date", closure: { note: "Ferielukket", kind: "closed" } }),
    });
    renderAt();
    await settle();
    expect(document.body.textContent).toContain("Ferielukket");
    expect(document.body.textContent).not.toContain(da.rsvpNoSlotsDay);
  });

  it("a pause covering today says when online booking opens again", async () => {
    routes({ page: { ...PAGE, paused_until: plus(1) } });
    renderAt();
    await settle();
    const line = screen.getByTestId("rsvp-paused-reopens");
    expect(line.textContent).toContain("Online-booking åbner igen");
    expect(line.textContent).toContain("søndag 25. oktober");
  });

  it("no pause, no line", async () => {
    routes();
    renderAt();
    await settle();
    expect(document.querySelector('[data-testid="rsvp-paused-reopens"]')).toBeNull();
  });
});
