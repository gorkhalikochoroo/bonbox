/**
 * The one switch for the phone hours item (booking push p3, owner question
 * Q5 / build plan C2): utils/venueHours PHONE_HOURS_ITEM. Set to false, the
 * phone/tablet card shows no hours toggle and no inline week; the address
 * and phone row stays as before, and the desktop column keeps its list.
 * Mocked to false here (the shipped value is true: bookingVenueIdentity).
 */
import { act, cleanup, render, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../utils/venueHours", async (importOriginal) => ({ ...(await importOriginal()), PHONE_HOURS_ITEM: false }));
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
vi.mock("../utils/framed", () => ({ isFramed: () => false }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;

const TODAY = "2026-10-23"; // a Friday
const plus = (n) => {
  const d = new Date(2026, 9, 23 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const D = (windows) => ({ windows, by: "opening" });
const PAGE = {
  business_name: "Bistro Nørrebro", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Nørrebrogade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false, providers: [],
  allergen_set: [], logo_url: null,
  hours: { days: { mon: D([["17:00", "22:00"]]), tue: D([["17:00", "22:00"]]), wed: D([["17:00", "22:00"]]),
    thu: D([["17:00", "22:00"]]), fri: D([["17:00", "23:00"]]), sat: D([["17:00", "23:00"]]), sun: D([]) } },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 23, 12, 0));
  h.get.mockReset();
  h.get.mockImplementation((url) => {
    if (url === "/public/reservations/x") return Promise.resolve({ data: PAGE });
    if (url === "/public/reservations/x/availability-summary") {
      const days = Array.from({ length: 14 }, (_, i) => ({ date: plus(i), has_slots: true, reason: null }));
      return Promise.resolve({ data: { from: TODAY, party_size: 2, next_open_day: TODAY, days } });
    }
    if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: ["19:00"], slot_remaining: {} } });
    return Promise.resolve({ data: {} });
  });
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.matchMedia;
});

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={["/r/x"]}>
      <Routes><Route path="/r/:slug" element={<ReservationPublicPage />} /></Routes>
    </MemoryRouter>,
  );

describe("PHONE_HOURS_ITEM = false", () => {
  it("(card) no hours toggle and no week; the address and phone row stays", async () => {
    renderAt();
    await settle();
    const header = document.querySelector("header");
    expect(header.querySelector('button[aria-controls="rsvp-venue-hours"]')).toBeNull();
    expect(document.getElementById("rsvp-venue-hours")).toBeNull();
    expect(header.textContent).not.toContain("Åbningstider");
    expect(header.querySelector('a[href^="tel:"]')).not.toBeNull();
    expect(header.textContent).toContain("Nørrebrogade 1");
    expect([...document.querySelectorAll('[role="radio"]')].some((r) => r.textContent.trim() === "19:00")).toBe(true);
  });

  it("(column) the desktop column keeps its week", async () => {
    window.matchMedia = vi.fn((q) => ({
      matches: /min-width:\s*1024px/.test(q), media: q,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    renderAt();
    await settle();
    const col = document.querySelector('[data-testid="rsvp-venue-column"]');
    expect(col).not.toBeNull();
    expect(within(col).getByRole("heading", { level: 2 }).textContent).toBe("Åbningstider");
    expect(col.querySelectorAll("dl > div").length).toBe(3);
  });
});
