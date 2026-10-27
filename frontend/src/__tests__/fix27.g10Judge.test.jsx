/**
 * Fix round 27 Oct — the design judge's items (G10, test/g10-judge.md),
 * frontend only, no new words. One block per item.
 *
 *   1  The scarcity line ("Sidste bord", "2 tilbage"): 11 px quiet grey,
 *      weight 500; white/80 on the picked tile.
 *   2  The language switch: a rounded-xl track with rounded-lg segments, 32 px
 *      drawn and 44 px to the finger (an after: box); on a desktop it is the
 *      card's, in its top row beside the steps, and the venue column loses
 *      its pt-8.
 *   4  The embed's ground pads 40 px below the card (pb-10): the card's
 *      shadow reaches 36 px and pb-6 cut it in a straight line. The same
 *      ground on every step and in the wait, so the posted height follows.
 *   5  The salon's two selects and the waitlist's time select: the tile look
 *      (rounded-xl, gray-50, a 6 % edge, pl-4 pr-10, weight 500), no native
 *      chrome, a 16 px Lucide chevron at right-3.
 *
 * Run: cd frontend && TZ=UTC npx vitest run src/__tests__/fix27.g10Judge.test.jsx
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

describe("2: the language switch", () => {
  const realMatch = window.matchMedia;
  afterEach(() => { window.matchMedia = realMatch; });
  const stubWide = () => {
    window.matchMedia = vi.fn((q) => ({
      matches: /min-width:\s*1024px/.test(q), media: q,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
  };
  const segmentsOf = (group) => within(group).getAllByRole("button");

  it("a rounded-xl track, rounded-lg segments at 32 px, 44 px to the finger — no capsule", async () => {
    routes();
    renderAt();
    await settle();
    const group = screen.getByRole("group", { name: "Sprog · Language" });
    expect(group.className).toContain("rounded-xl");
    expect(group.className).not.toContain("rounded-full");
    for (const b of segmentsOf(group)) {
      expect(b.className).toContain("rounded-lg");
      expect(b.className).not.toContain("rounded-full");
      expect(b.className).toContain("h-8");
      expect(b.className).toContain("min-h-0!");
      expect(b.className).toMatch(/(^| )relative( |$)/);
      expect(b.className).toContain("after:absolute");
      expect(b.className).toContain("after:-inset-y-1.5");     // 32 + 2 × 6 = 44
      expect(b.className).toContain("min-w-[40px]");
    }
  });

  it("desktop: in the card's top row beside the steps; the venue column is the venue's alone, without pt-8", async () => {
    stubWide();
    routes();
    renderAt();
    await settle();
    const column = screen.getByTestId("rsvp-venue-column");
    expect(within(column).queryByRole("group", { name: "Sprog · Language" })).toBeNull();
    expect(column.className).not.toMatch(/(^| )pt-8( |$)/);
    const top = within(screen.getByRole("main")).getByTestId("rsvp-card-top");
    expect(within(top).getByRole("group", { name: "Sprog · Language" })).toBeTruthy();
    expect(within(top).getByRole("progressbar")).toBeTruthy();
    expect(screen.getAllByRole("group", { name: "Sprog · Language" })).toHaveLength(1);
    // The wait's desktop look is the page's: its column has no pt-8 either.
    expect(read("components/booking/bookingWait.js")).not.toContain('el("div", "pt-8 space-y-6"');
  });
});

describe("4: the embed never cuts the card's shadow", () => {
  async function toDetails() {
    await act(async () => { fireEvent.click(timeTile("19:00")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Fortsæt/ })); });
    await settle(4);
  }

  it("40 px of ground below the card, the same on step 1, step 2 and in the wait", async () => {
    const { EMBED_GROUND, skeletonHtml } = await import("../components/booking/bookingWait");
    expect(EMBED_GROUND).toContain("min-[450px]:pb-10");
    expect(EMBED_GROUND).not.toContain("pb-6");
    // The wait index.html draws in the frame: the same ground, so the height
    // the frame first posts is the page's.
    expect(skeletonHtml("embedCard")).toContain("min-[450px]:pb-10");
    routes();
    const posted = [];
    const parent = { postMessage: (m) => posted.push(m) };
    const realParent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
    const html = vi.spyOn(document.documentElement, "getBoundingClientRect");
    try {
      // The frame's height is its document's: the root, padding and all.
      html.mockReturnValue({ height: 640, width: 460, top: 0, left: 0, bottom: 640, right: 460 });
      renderAt("/r/x?embed=1");
      await settle();
      const root = screen.getByTestId("rsvp-root");
      expect(root.className).toContain("min-[450px]:pb-10");
      expect(posted.at(-1)).toEqual({ type: "bonbox:height", height: 640 });
      html.mockReturnValue({ height: 912, width: 460, top: 0, left: 0, bottom: 912, right: 460 });
      await toDetails();
      expect(document.getElementById("rsvp-name")).not.toBeNull();
      expect(screen.getByTestId("rsvp-root").className).toContain("min-[450px]:pb-10");
      window.dispatchEvent(new Event("resize"));
      expect(posted.at(-1)).toEqual({ type: "bonbox:height", height: 912 });
    } finally {
      html.mockRestore();
      if (realParent) Object.defineProperty(window, "parent", realParent);
    }
  });
});

describe("5: the selects wear the tile look with a Lucide chevron", () => {
  const tileLook = (sel) => {
    for (const c of ["appearance-none", "rounded-xl", "bg-gray-50", "border-gray-900/[0.06]", "pl-4", "pr-10", "font-medium", "h-12"]) {
      expect(sel.className, c).toContain(c);
    }
    expect(sel.className).not.toMatch(/(^| )(rounded-lg|border-gray-200|bg-white|px-3)( |$)/);
    const chevron = sel.parentElement.querySelector("svg");
    expect(sel.parentElement.className).toContain("relative");
    expect(chevron).not.toBeNull();
    expect(chevron.getAttribute("class")).toContain("lucide-chevron-down");
    expect(chevron.getAttribute("class")).toContain("right-3");
    expect(chevron.getAttribute("class")).toContain("pointer-events-none");
    expect(chevron.getAttribute("width")).toBe("16");
  };

  it("the salon's service and stylist selects", async () => {
    routes({
      page: { ...PAGE, business_type: "salon", providers: [{ id: "r1", name: "Mia" }] },
      availability: () => ({ slots: [] }),
    });
    h.get.mockImplementation(((base) => (url, cfg) => {
      if (url === "/public/reservations/x/behandlinger") {
        return Promise.resolve({ data: { behandlinger: [{ id: 1, name: "Dameklip", duration_min: 45, price_kr: 450 }, { id: 2, name: "Herreklip", duration_min: 30 }] } });
      }
      return base(url, cfg);
    })(h.get.getMockImplementation()));
    renderAt();
    await settle();
    tileLook(document.getElementById("rsvp-behandling"));
    tileLook(document.getElementById("rsvp-behandler"));
  });

  it("the waitlist's time select (source: the lazy full-night chunk)", () => {
    const src = read("components/booking/FullNightOffer.jsx");
    const at = src.indexOf('id="rsvp-wl-time"');
    const block = src.slice(src.lastIndexOf('<div className="relative">', at), src.indexOf("</div>", at));
    for (const c of ["appearance-none", "rounded-xl", "bg-gray-50", "border-gray-900/[0.06]", "pl-4", "pr-10", "font-medium"]) {
      expect(block, c).toContain(c);
    }
    expect(block).toContain("<ChevronDown");
    expect(block).toContain("right-3");
    expect(read("pages/ReservationPublicPage.jsx")).toMatch(/FULL_NIGHT_KIT = \{[^}]*ChevronDown/);
  });
});
