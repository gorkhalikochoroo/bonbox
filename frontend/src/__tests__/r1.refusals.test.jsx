/**
 * R1 B4 + D3 (24 Oct 2026) — the booking page's new refusals keep what the
 * guest typed (utils/bookingRefusal.js GUEST_REFUSALS):
 *   • 409 date_closed — the venue closed that day for online booking while
 *     the guest was booking: back to step 1, the date strip asked again,
 *     "Vi tager ikke imod online-bookinger den dag…";
 *   • 409 requests_full — the venue's online group requests for today are
 *     full: the guest stays on the form, with a tap-to-call link;
 *   • 429 — too many tries from one address: the guest stays on the form,
 *     "Vent et minut… Dine oplysninger er gemt".
 * The name and e-mail are still filled in after each one.
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

const reject = (status, error) =>
  h.post.mockRejectedValue({ response: { status, data: error ? { detail: { error } } : {} } });
const nameValue = () => document.getElementById("rsvp-name")?.value;

describe("refusals keep the typed fields", () => {
  it("date_closed: back to step 1, the strip asked again, the fields kept", async () => {
    routes();
    reject(409, "date_closed");
    renderAt();
    await settle();
    await toDetails();
    const before = summaryCalls;
    await submit();
    // Step 1, with the reason where the guest lands.
    expect(document.getElementById("rsvp-name")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(da.rsvpErrDateClosed);
    expect(summaryCalls).toBeGreaterThan(before);
    // Forward again: everything they typed is still there.
    await act(async () => { fireEvent.click(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "19:00")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fortsæt/ })); });
    await settle(4);
    expect(nameValue()).toBe("Sita Sharma");
    expect(document.getElementById("rsvp-email").value).toBe("sita@example.com");
  });

  it("requests_full: stays on the form with a call link", async () => {
    routes();
    reject(409, "requests_full");
    renderAt();
    await settle();
    await toDetails();
    await submit();
    expect(nameValue()).toBe("Sita Sharma");
    expect(document.body.textContent).toContain(da.rsvpErrRequestsFull);
    const call = screen.getByTestId("rsvp-refusal-call");
    expect(call.getAttribute("href")).toMatch(/^tel:/);
  });

  it("429: stays on the form and says wait a minute", async () => {
    routes();
    reject(429);
    renderAt();
    await settle();
    await toDetails();
    await submit();
    expect(nameValue()).toBe("Sita Sharma");
    expect(document.getElementById("rsvp-email").value).toBe("sita@example.com");
    expect(document.body.textContent).toContain(da.rsvpErrTooManyTries);
  });
});
