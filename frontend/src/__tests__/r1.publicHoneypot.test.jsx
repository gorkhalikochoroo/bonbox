/**
 * R1 D3 (24 Oct 2026) — the booking page's guest-invisible spam guards.
 *
 * The page sends what the server's booking screen reads
 * (backend services/booking_screen.py):
 *   • form_ms — how long the page was open before Book was pressed. A fill
 *     under two seconds (or a client that does not say) is HELD for the
 *     venue's OK, never refused;
 *   • website — a trap field no person fills: off-screen, out of the tab
 *     order, hidden from screen readers, no autofill. A bot fills it and its
 *     booking is quietly dropped. The page always sends it empty.
 */
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

describe("the honeypot and the fill time", () => {
  it("the payload carries website: \"\" and a numeric form_ms", async () => {
    routes();
    h.post.mockResolvedValue({ data: { id: "bk1", status: "confirmed", booking_token: "tok" } });
    renderAt();
    await settle();
    await toDetails();
    await submit();
    expect(h.post).toHaveBeenCalledTimes(1);
    const [url, body] = h.post.mock.calls[0];
    expect(url).toBe("/public/reservations/x");
    expect(body.website).toBe("");
    expect(typeof body.form_ms).toBe("number");
    expect(Number.isInteger(body.form_ms)).toBe(true);
    expect(body.form_ms).toBeGreaterThanOrEqual(0);
  });

  it("the trap is hidden from people, keyboards, screen readers and autofill", async () => {
    routes();
    renderAt();
    await settle();
    await toDetails();
    const trap = document.getElementById("rsvp-website");
    expect(trap).not.toBeNull();
    expect(trap.getAttribute("name")).toBe("website");
    expect(trap.tabIndex).toBe(-1);
    expect(trap.getAttribute("autocomplete")).toBe("off");
    const wrap = trap.closest('[aria-hidden="true"]');
    expect(wrap).not.toBeNull();
    expect(wrap.className).toMatch(/-left-\[10000px\]/);
    expect(wrap.className).toMatch(/overflow-hidden/);
    expect(trap.value).toBe("");
  });
});
