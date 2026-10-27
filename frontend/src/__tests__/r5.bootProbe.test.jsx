/**
 * Booking R5 — the page takes over what index.html already asked for
 * (lib/bookingBoot.js), and only that.
 *
 *  • only the very request the page would send: same API, same venue, same
 *    day / party (from / days / party for the summary) — and only once;
 *  • a 2xx is the answer; a 4xx is the answer too (a 410 is that venue's
 *    truth), thrown like axios; no network, a 5xx, a 408/429 or the 15 s
 *    give-up → the page asks itself (the api client, with its retries);
 *  • the page data can be read synchronously when it has already landed, so
 *    the first render can be the page itself.
 *  • ReservationPublicPage: with the answers in, the first render is the
 *    venue (no skeleton) and the page sends neither the page nor the times
 *    request; a different guess and the page asks as before.
 *
 * The clock is pinned (Date only) to Tuesday 8 January 2030, 09:00.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), base: "https://api.bonbox.dk/api" }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    get defaults() { return { baseURL: h.base }; },
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

const { bootOr, markBootPageUsed, peekBootPage, resetBootForTests } = await import("../lib/bookingBoot");
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;

const BASE = "https://api.bonbox.dk/api";
const answer = (r) => ({ promise: Promise.resolve(r), done: r });
function park({ slug = "cafe", page, avail, summary, base = BASE } = {}) {
  const b = { slug, embed: false };
  if (page) b.page = { base, url: `${base}/public/reservations/${slug}`, ...page };
  if (avail) b.avail = { base, day: "2030-01-08", party: 2, ...avail };
  if (summary) b.summary = { base, from: "2030-01-08", days: 14, party: 2, ...summary };
  window.__bbBooking = b;
  return b;
}

beforeEach(() => {
  resetBootForTests();
  h.get.mockReset();
  h.base = BASE;
  delete window.__bbBooking;
});
afterEach(() => {
  cleanup();
  delete window.__bbBooking;
  vi.useRealTimers();
});

describe("bootOr — exactly the request, once", () => {
  const fallback = () => Promise.resolve({ data: "asked myself" });

  it("the same venue: index.html's answer, and only the first time", async () => {
    park({ page: answer({ ok: true, status: 200, data: { business_name: "Café" } }) });
    await expect(bootOr("page", { slug: "cafe" }, fallback)).resolves.toEqual({ data: { business_name: "Café" } });
    await expect(bootOr("page", { slug: "cafe" }, fallback)).resolves.toEqual({ data: "asked myself" });
  });

  it.each([
    ["another venue", { slug: "other" }],
  ])("%s: asks itself", async (_, want) => {
    park({ page: answer({ ok: true, status: 200, data: {} }) });
    await expect(bootOr("page", want, fallback)).resolves.toEqual({ data: "asked myself" });
  });

  it("another API (a build pointed elsewhere): asks itself", async () => {
    park({ page: answer({ ok: true, status: 200, data: {} }), base: "https://elsewhere.example/api" });
    await expect(bootOr("page", { slug: "cafe" }, fallback)).resolves.toEqual({ data: "asked myself" });
  });

  it("the times: only for the same day and party", async () => {
    park({ avail: answer({ ok: true, status: 200, data: { slots: ["18:00"] } }) });
    await expect(bootOr("avail", { slug: "cafe", day: "2030-01-09", party: 2 }, fallback)).resolves.toEqual({ data: "asked myself" });
    await expect(bootOr("avail", { slug: "cafe", day: "2030-01-08", party: 4 }, fallback)).resolves.toEqual({ data: "asked myself" });
    await expect(bootOr("avail", { slug: "cafe", day: "2030-01-08", party: 2 }, fallback)).resolves.toEqual({ data: { slots: ["18:00"] } });
  });

  it("the summary: only for the same window and party", async () => {
    park({ summary: answer({ ok: true, status: 200, data: { days: [] } }) });
    await expect(bootOr("summary", { slug: "cafe", from: "2030-01-08", days: 7, party: 2 }, fallback)).resolves.toEqual({ data: "asked myself" });
    await expect(bootOr("summary", { slug: "cafe", from: "2030-01-08", days: 14, party: 2 }, fallback)).resolves.toEqual({ data: { days: [] } });
  });

  it("a 4xx is the answer, thrown like axios (the page's own 410 handling runs)", async () => {
    park({ page: answer({ ok: false, status: 410, data: { detail: "gone" } }) });
    await expect(bootOr("page", { slug: "cafe" }, fallback)).rejects.toMatchObject({ response: { status: 410, data: { detail: "gone" } } });
  });

  it.each([
    ["no network", { ok: false, status: 0, data: null }],
    ["a 5xx", { ok: false, status: 503, data: null }],
    ["a 429", { ok: false, status: 429, data: null }],
    ["a 408", { ok: false, status: 408, data: null }],
  ])("%s: the page asks itself (with the api client's retries)", async (_, r) => {
    park({ page: answer(r) });
    await expect(bootOr("page", { slug: "cafe" }, fallback)).resolves.toEqual({ data: "asked myself" });
  });

  it("nothing parked (any other page, a local preview): asks itself", async () => {
    await expect(bootOr("page", { slug: "cafe" }, fallback)).resolves.toEqual({ data: "asked myself" });
  });
});

describe("peekBootPage — a synchronous read of an answer already here", () => {
  it("the data when it has landed for this venue; null while on its way, for another venue, or after use", () => {
    park({ page: { promise: new Promise(() => {}), done: null } });
    expect(peekBootPage("cafe")).toBeNull();
    park({ page: answer({ ok: true, status: 200, data: { business_name: "Café" } }) });
    expect(peekBootPage("other")).toBeNull();
    expect(peekBootPage("cafe")).toEqual({ business_name: "Café" });
    markBootPageUsed();
    expect(peekBootPage("cafe")).toBeNull();
  });

  it("never an error answer", () => {
    park({ page: answer({ ok: false, status: 410, data: { detail: "gone" } }) });
    expect(peekBootPage("cafe")).toBeNull();
  });
});

// ── the page itself ───────────────────────────────────────────────────
const PAGE = {
  business_name: "Bistro Boot", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Gade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false,
};
const plus = (n) => {
  const d = new Date(2030, 0, 8 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const SUMMARY = { from: "2030-01-08", party_size: 2, next_open_day: "2030-01-08", days: Array.from({ length: 14 }, (_, i) => ({ date: plus(i), has_slots: true, reason: null })) };
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const renderPage = (p = "/r/cafe") =>
  render(
    <MemoryRouter initialEntries={[p]}>
      <Routes>
        <Route path="/r/:slug" element={<ReservationPublicPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("ReservationPublicPage takes the parked answers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 0, 8, 9, 0));
    localStorage.clear();
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    window.scrollTo = () => {};
    if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    h.get.mockImplementation(() => Promise.resolve({ data: {} }));
  });

  it("with the page already here, the FIRST render is the venue — no skeleton — and the page is not asked for again", () => {
    park({
      page: answer({ ok: true, status: 200, data: PAGE }),
      avail: answer({ ok: true, status: 200, data: { slots: ["18:00", "18:30"] } }),
      summary: answer({ ok: true, status: 200, data: SUMMARY }),
    });
    renderPage();
    expect(screen.queryByTestId("rsvp-wait")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Bistro Boot");
    // today is already the picked day on that first render (seeded with the page)
    const today = screen.getAllByRole("radio").find((r) => r.getAttribute("aria-checked") === "true" && /8/.test(r.textContent));
    expect(today).toBeTruthy();
    expect(h.get).not.toHaveBeenCalledWith("/public/reservations/cafe");
  });

  it("the times and the 14 days come from the parked answers (no request of its own)", async () => {
    park({
      page: answer({ ok: true, status: 200, data: PAGE }),
      avail: answer({ ok: true, status: 200, data: { slots: ["18:00", "18:30"] } }),
      summary: answer({ ok: true, status: 200, data: SUMMARY }),
    });
    renderPage();
    await settle();
    expect(screen.getAllByRole("radio").some((r) => r.textContent.trim() === "18:30")).toBe(true);
    const urls = h.get.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain("/public/reservations/cafe/availability");
    expect(urls).not.toContain("/public/reservations/cafe/availability-summary");
  });

  it("a guess that is not the page's (a ?party=4 link): the page asks for its own times", async () => {
    park({
      page: answer({ ok: true, status: 200, data: PAGE }),
      avail: answer({ ok: true, status: 200, data: { slots: ["18:00"] } }),
      summary: answer({ ok: true, status: 200, data: SUMMARY }),
    });
    h.get.mockImplementation((url) =>
      Promise.resolve({ data: url.endsWith("/availability") ? { slots: ["20:00"] } : url.endsWith("-summary") ? SUMMARY : {} }),
    );
    renderPage("/r/cafe?party=4");
    await settle();
    expect(h.get).toHaveBeenCalledWith("/public/reservations/cafe/availability", { params: { day: "2030-01-08", party: 4 } });
  });

  it("the page still on its way: the wait, then the venue, from the same parked request", async () => {
    let land;
    park({ page: { promise: new Promise((r) => { land = r; }), done: null } });
    h.get.mockImplementation((url) => Promise.resolve({ data: url.endsWith("-summary") ? SUMMARY : { slots: ["18:00"] } }));
    renderPage();
    expect(screen.getByTestId("rsvp-wait")).toBeTruthy();
    await act(async () => land({ ok: true, status: 200, data: PAGE }));
    await settle();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Bistro Boot");
    expect(h.get).not.toHaveBeenCalledWith("/public/reservations/cafe");
  });
});

describe("the 2D table picker, now loaded on demand, still appears", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 0, 8, 9, 0));
    localStorage.clear();
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    window.scrollTo = () => {};
    if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  });

  it("a venue that lets guests pick: pick a time, the floor's free tables show", async () => {
    const TABLES = [
      { id: "t1", label: "Bord 1", capacity_seats: 2, zone: null, shape: "round", pos_x: 10, pos_y: 10, status: "free" },
      { id: "t2", label: "Bord 2", capacity_seats: 4, zone: null, shape: "rect", pos_x: 40, pos_y: 10, status: "taken" },
    ];
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/cafe") return Promise.resolve({ data: { ...PAGE, guest_can_pick_table: true } });
      if (url.endsWith("-summary")) return Promise.resolve({ data: SUMMARY });
      if (url.endsWith("/availability")) return Promise.resolve({ data: { slots: ["18:00", "18:30"] } });
      if (url.endsWith("/floor")) return Promise.resolve({ data: { tables: TABLES } });
      return Promise.resolve({ data: {} });
    });
    renderPage();
    await settle();
    await act(async () => {
      screen.getAllByRole("radio").find((r) => r.textContent.trim() === "18:00").click();
    });
    await settle(20);
    const free = await screen.findByRole("button", { name: /Bord 1/ });
    expect(free).toBeTruthy();
  });
});
