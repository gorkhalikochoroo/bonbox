/**
 * Fix round 27 Oct — the walk's small findings (walk 27 Oct, P3 and G11),
 * one block per fix.
 *
 *   P3-1  A refusal on the details step (429 "For mange forsøg…", a generic
 *         error, a 409) is brought up clear of the fixed main-button bar on a
 *         phone: at 390×844 it drew at 770 px under the bar at 767, and the
 *         guest saw nothing change.
 *   P3-2  On the door iPad (portrait), a toast ("The booking for … is
 *         cancelled") covered the freed-table card's title: the card now tells
 *         the toast stack its top edge, and toasts rise above it.
 *   P3-4  An old link opened cold asked 9 times instead of 3 (the venue on the
 *         old link, then everything again on the new one). The answer is
 *         reused, the address moves to the current link, and every question
 *         after it is asked once, with the current link.
 *   G11   The hours row and the phone link draw 32 px (the meta row's height)
 *         but give the finger 44 px; a time never sits alone on its last row
 *         when the tiles carry a note ("Sidste bord": 4 + 1 at 390, 5 + 1 at
 *         1440) — the columns shrink, never grow (the note needs the width).
 *
 * Run: cd frontend && TZ=UTC npx vitest run src/__tests__/fix27.walkPolish.test.jsx
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    patch: (...a) => h.patch(...a), delete: vi.fn(),
    get defaults() { return { baseURL: "https://api.bonbox.dk/api" }; },
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
function summary() {
  const days = Array.from({ length: 14 }, (_, i) => ({ date: plus(i), has_slots: true, reason: null }));
  return { from: TODAY, party_size: 2, next_open_day: days[0].date, days };
}
function routes() {
  h.get.mockImplementation((url) => {
    if (url === "/public/reservations/x") return Promise.resolve({ data: PAGE });
    if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: summary() });
    if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: ["19:00", "19:30"], slot_remaining: {} } });
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
const reject = (status, error) =>
  h.post.mockRejectedValue({ response: { status, data: error ? { detail: { error } } : {} } });

// jsdom lays nothing out: the phone's numbers at 390×844, from the walk.
const box = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} });
function phoneLayout(alertTop) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect() {
    if (this.getAttribute?.("data-testid") === "rsvp-cta-bar") return box(767, 77);
    if (this.getAttribute?.("role") === "alert") return box(alertTop, 80);
    return box(0, 0);
  });
}

let innerH;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 23, 12, 0));
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  window.scrollBy = vi.fn();
  innerH = window.innerHeight;
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 844 });
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: innerH });
});

describe("P3-1: a refusal on the details step is seen, never left under the bar", () => {
  for (const [what, status, error, words] of [
    ["429 too many tries", 429, null, () => da.rsvpErrTooManyTries],
    ["a generic error", 500, null, null],
    ["409 requests_full", 409, "requests_full", () => da.rsvpErrRequestsFull],
  ]) {
    it(`${what}: scrolled up clear of the fixed bar`, async () => {
      routes();
      reject(status, error);
      renderAt();
      await settle();
      await toDetails();
      phoneLayout(770);                        // the walk: 770 px, the bar's top at 767
      await submit();
      const alert = screen.getByRole("alert");
      if (words) expect(alert.textContent).toContain(words());
      expect(document.getElementById("rsvp-name").value).toBe("Sita Sharma");
      // Its bottom (850) to 8 px above the bar (759): 91 px.
      expect(window.scrollBy).toHaveBeenCalledWith(expect.objectContaining({ top: 91 }));
    });
  }

  it("a refusal already in view is left where it is", async () => {
    routes();
    reject(429);
    renderAt();
    await settle();
    await toDetails();
    phoneLayout(500);
    await submit();
    expect(screen.getByRole("alert").textContent).toContain(da.rsvpErrTooManyTries);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });
});

describe("P3-2: a toast never covers the freed-table card's title", () => {
  it("the card tells the toast stack its top edge; the stack rises above it; it goes with the card", async () => {
    const { default: FreedTableNudge } = await import("../components/reservations/FreedTableNudge");
    const { ToastProvider, useToast } = await import("../hooks/useToast");
    // iPad portrait, 820×1180: the card floats 20 px off the foot, 125 px tall.
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 1180 });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect() {
      return this.hasAttribute?.("data-freed-nudge") ? box(1035, 125) : box(0, 0);
    });
    const match = { id: "w1", guest_name: "Venter Vibe", party_size: 2 };
    let say = null;
    function Door({ matches }) {
      const toast = useToast();
      say = toast;
      return <FreedTableNudge matches={matches} t={(_k, fb) => fb} onShow={() => {}} onDismiss={() => {}} />;
    }
    const lift = () => document.documentElement.style.getPropertyValue("--bb-toast-lift");
    const { rerender } = render(<ToastProvider><Door matches={[match]} /></ToastProvider>);
    // Its top edge is 1180 − 1035 = 145 px up; the toasts sit 8 px above that.
    expect(lift()).toBe("153px");
    act(() => { say("The booking for NoShow Test is cancelled."); });
    expect(document.querySelector("[data-toast-stack]")).not.toBeNull();
    const toastSrc = fs.readFileSync(path.join(SRC, "hooks/useToast.jsx"), "utf8");
    expect(toastSrc).toContain('bottom: "max(calc(4.5rem + env(safe-area-inset-bottom, 0px)), var(--bb-toast-lift, 0px))"');
    // Dismissed (or nobody fits any more): the toasts go back down.
    rerender(<ToastProvider><Door matches={[]} /></ToastProvider>);
    expect(lift()).toBe("");
  });
});

describe("P3-4: an old link opened cold asks once, with the current link", () => {
  let where = null;
  function Where() {
    where = useLocation();
    return null;
  }
  const renderGuest = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:slug" element={<><ReservationPublicPage /><Where /></>} />
        <Route path="/:slug" element={<><ReservationPublicPage /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
  const OLD_PAGE = { ...PAGE, canonical_slug: "havnen" };
  const asked = () => h.get.mock.calls.map(([u]) => u);
  let resetBoot;
  beforeEach(async () => {
    where = null;
    ({ resetBootForTests: resetBoot } = await import("../lib/bookingBoot"));
    resetBoot();
    delete window.__bbBooking;
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/gammel") return Promise.resolve({ data: OLD_PAGE });
      if (url === "/public/reservations/havnen") return Promise.resolve({ data: PAGE });
      if (/\/availability-summary$/.test(url)) return Promise.resolve({ data: summary() });
      if (/\/availability$/.test(url)) return Promise.resolve({ data: { slots: ["19:00", "19:30"], slot_remaining: {} } });
      return Promise.resolve({ data: {} });
    });
  });
  afterEach(() => { delete window.__bbBooking; });

  it("three questions: the venue on the old link, then the strip and the times on the current one", async () => {
    renderGuest("/gammel?party=2#tider");
    await settle();
    expect(where.pathname).toBe("/havnen");
    expect(where.search).toBe("?party=2");
    expect(where.hash).toBe("#tider");
    expect(screen.getAllByText(/Bistro Nørrebro/).length).toBeGreaterThan(0);
    expect(asked()).toEqual([
      "/public/reservations/gammel",
      "/public/reservations/havnen/availability-summary",
      "/public/reservations/havnen/availability",
    ]);
    // The booking itself goes to the current link too.
    h.post.mockResolvedValue({ data: { id: "b1", status: "confirmed", booking_token: "tok" } });
    await toDetails();
    await submit();
    expect(h.post.mock.calls[0][0]).toBe("/public/reservations/havnen");
  });

  it("index.html already asked on the old link: nothing is asked again, and the address moves", async () => {
    const BASE = "https://api.bonbox.dk/api";
    const answer = (data) => ({ promise: Promise.resolve({ ok: true, status: 200, data }), done: { ok: true, status: 200, data } });
    window.__bbBooking = {
      slug: "gammel", embed: false,
      page: { base: BASE, url: `${BASE}/public/reservations/gammel`, ...answer(OLD_PAGE) },
      summary: { base: BASE, from: TODAY, days: 14, party: 2, ...answer(summary()) },
      avail: { base: BASE, day: TODAY, party: 2, ...answer({ slots: ["19:00", "19:30"], slot_remaining: {} }) },
    };
    renderGuest("/gammel");
    await settle();
    expect(where.pathname).toBe("/havnen");
    expect(screen.getAllByText(/Bistro Nørrebro/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("radio").some((r) => r.textContent.trim() === "19:00")).toBe(true);
    expect(asked()).toEqual([]);
  });

  it("another venue's address is asked about as before", async () => {
    const { unmount } = renderGuest("/havnen");
    await settle();
    expect(asked()).toContain("/public/reservations/havnen");
    unmount();
    h.get.mockClear();
    renderGuest("/gammel");
    await settle();
    expect(asked()[0]).toBe("/public/reservations/gammel");
  });
});

describe("G11: 44 px to the finger, and no time alone on its row", () => {
  const D = (windows, by = "opening") => ({ windows, by });
  const WEEK = {
    mon: D([["17:00", "22:00"]]), tue: D([["17:00", "22:00"]]), wed: D([["17:00", "22:00"]]), thu: D([["17:00", "22:00"]]),
    fri: D([["17:00", "23:00"]]), sat: D([["17:00", "23:00"]]), sun: D([]),
  };
  // after:-inset-y-1.5 on a 32 px box: 6 px above and below → 44 px.
  const hit44 = (el) => {
    expect(el.className).toMatch(/(^| )relative( |$)/);
    expect(el.className).toContain("after:absolute");
    expect(el.className).toContain("after:inset-x-0");
    expect(el.className).toContain("after:content-['']");
    expect(el.className).toContain("min-h-8!");
    expect(el.className).toContain("after:-inset-y-1.5");
  };

  it("the hours row and the phone link on a phone: 32 px drawn, a 44 px hit box", async () => {
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/x") return Promise.resolve({ data: { ...PAGE, hours: { days: WEEK } } });
      if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: summary() });
      if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: ["19:00"], slot_remaining: {} } });
      return Promise.resolve({ data: {} });
    });
    renderAt();
    await settle();
    hit44(screen.getByRole("button", { expanded: false, name: new RegExp(da.rsvpVenueHoursTodayLabel) }));
    const tel = [...document.querySelectorAll('a[href^="tel:"]')].find((a) => a.className.includes("min-h-8!"));
    expect(tel).toBeTruthy();
    hit44(tel);
  });

  it("the venue column's phone link: 22 px of text, 44 px to the finger", () => {
    const src = fs.readFileSync(path.join(SRC, "pages/ReservationPublicPage.jsx"), "utf8");
    expect(src).toContain(`className="relative after:absolute after:inset-x-0 after:-inset-y-[11px] after:content-[''] min-h-0! hover:underline"`);
  });

  it("noted times: 5 read 3 + 2 on a phone, 6 read 4 + 2 from 450 px; never more columns than without notes", async () => {
    const { timeGridCols } = await import("../components/booking/bookingTiles");
    const cols = (c, prefix) => Number(new RegExp(`(?:^| )${prefix.replace(/[[\]]/g, "\\$&")}grid-cols-(\\d)`).exec(c)[1]);
    expect(cols(timeGridCols(5, { notes: true }), "")).toBe(3);
    expect(cols(timeGridCols(6, { notes: true }), "min-[450px]:")).toBe(4);
    for (let n = 2; n <= 60; n += 1) {
      const c = timeGridCols(n, { notes: true });
      const phone = cols(c, "");
      const wide = cols(c, "min-[450px]:");
      expect(phone).toBeLessThanOrEqual(4);
      expect(wide).toBeLessThanOrEqual(5);
      // Alone on the last row only where both widths leave one over.
      if (n % 12 !== 1) expect(n <= phone || n % phone !== 1, `phone n=${n} cols=${phone}`).toBe(true);
      if (n % 20 !== 1) expect(n <= wide || n % wide !== 1, `wide n=${n} cols=${wide}`).toBe(true);
    }
  });
});
