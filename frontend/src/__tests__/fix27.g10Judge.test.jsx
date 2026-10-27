/**
 * Fix round 27 Oct — the design judge's items (G10, test/g10-judge.md),
 * frontend only, no new words. One block per item.
 *
 *   1  The scarcity line ("Sidste bord", "2 tilbage"): 11 px quiet grey,
 *      weight 500; white/80 on the picked tile.
 *
 * Run: cd frontend && TZ=UTC npx vitest run src/__tests__/fix27.g10Judge.test.jsx
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
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
  return { from: TODAY, party_size: 2, next_open_day: days.find((d) => d.has_slots)?.date || null, days };
}
function routes({ page = PAGE, sum = () => summary(), availability } = {}) {
  h.get.mockImplementation((url, cfg) => {
    if (url === "/public/reservations/x") return Promise.resolve({ data: page });
    if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: sum(cfg?.params || {}) });
    if (url === "/public/reservations/x/availability") {
      return Promise.resolve({ data: availability ? availability(cfg?.params || {}) : { slots: ["19:00", "19:30"], slot_remaining: {} } });
    }
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
const timeTile = (x) => screen.getAllByRole("radio").find((r) => r.textContent.trim().startsWith(x));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 23, 12, 0));
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("1: the scarcity line is 11 px quiet grey, white/80 on the picked tile", () => {
  it("rest: 11 px, gray-500 (dark gray-400), weight 500 — never green; picked: white/80", async () => {
    routes({ availability: () => ({ slots: ["19:00", "19:30", "20:00"], slot_remaining: { "19:00": 1, "19:30": 2, "20:00": 9 } }) });
    renderAt();
    await settle();
    const note = (x) => timeTile(x).querySelector("span.h-3");
    expect(note("19:00").textContent).toBe(da.rsvpSlotLastTable);
    for (const x of ["19:00", "19:30"]) {
      const cls = note(x).className;
      expect(cls).toContain("text-[11px]");
      expect(cls).toContain("font-medium");
      expect(cls).toContain("text-gray-500");
      expect(cls).toContain("dark:text-gray-400");
      expect(cls).not.toMatch(/green|emerald|text-\[10px\]/);
    }
    await act(async () => { fireEvent.click(timeTile("19:00")); });
    expect(note("19:00").className).toContain("text-white/80");
    expect(note("19:00").className).not.toContain("text-gray-500");
  });
});
