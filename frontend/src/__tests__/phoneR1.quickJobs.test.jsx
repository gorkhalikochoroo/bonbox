/**
 * Phone R1 (PHONE-OWNER-PLAN v3 §4, decision 3, approved 12 Nov 2026) — the
 * "+" sheet's jobs: one row of chips on top, "Drop-in · Ny reservation",
 * above the sale form, which stays first and selected (a sale costs no
 * extra tap).
 *
 *   • Drop-in only where I dag would offer it (canWalkIn: a book, a food
 *     venue, seats > 0) — hidden when that is false, and while it is not
 *     known (never a chip into a seat sheet with no tables).
 *   • Ny reservation where the reservations pillar is on.
 *   • Each chip closes the sheet and opens Reservationer's own sheet through
 *     its deep link (?walkin=1 / ?new=1).
 *   • The words: "Drop-in" (not Walk-in) and "Ny reservation" (not Ny
 *     booking), also on I dag — the same keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const apiGet = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => apiGet(...a), post: vi.fn().mockResolvedValue({ data: {} }) },
}));
let mockUser = { id: "u-1", business_type: "restaurant", currency: "DKK", role: "owner" };
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: mockUser }) }));
let hidden = new Set();
vi.mock("../hooks/usePillars", () => ({ usePillars: () => ({ hiddenPillars: hidden }) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => false, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: vi.fn() }));
vi.mock("../hooks/useLanguage", async () => {
  const { da } = await import("../i18n/da");
  return { useLanguage: () => ({ t: (k, fb) => da[k] ?? (typeof fb === "string" ? fb : k), lang: "da" }) };
});

const { default: QuickAdd } = await import("../components/QuickAdd");
const { noteBookFacts, __resetQuickJobsForTests, quickJobs, canWalkInWith } = await import("../components/today/quickJobs");
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

/* The current place, read from the DOM (never a closure variable — the
   React Compiler lint rules refuse a component that writes outside itself). */
function Where() {
  const loc = useLocation();
  return <span data-testid="where" data-path={loc.pathname} data-search={loc.search} data-key={loc.key} hidden />;
}
const whereEl = () => document.querySelector('[data-testid="where"]');
const where = {
  get pathname() { return whereEl().getAttribute("data-path"); },
  get search() { return whereEl().getAttribute("data-search"); },
  get key() { return whereEl().getAttribute("data-key"); },
};

function openSheet() {
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes><Route path="*" element={<><QuickAdd /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
  fireEvent.click(document.querySelector("[data-quickadd-toggle]"));
}
const chips = () => [...document.querySelectorAll("[data-quick-job]")].map((b) => b.getAttribute("data-quick-job"));

beforeEach(() => {
  __resetQuickJobsForTests();
  apiGet.mockReset();
  apiGet.mockImplementation((url) => Promise.resolve({ data: url === "/expenses/categories" ? [] : {} }));
  mockUser = { id: "u-1", business_type: "restaurant", currency: "DKK", role: "owner" };
  hidden = new Set();
  try { localStorage.clear(); } catch { /* stubbed */ }
});
afterEach(() => cleanup());

describe('the "+" sheet: Drop-in · Ny reservation on top', () => {
  it("a restaurant with seats: both chips, Drop-in first, in Danish", async () => {
    noteBookFacts("u-1", { has_book: true, seats: 24 });
    openSheet();
    await waitFor(() => expect(chips()).toEqual(["walkin", "new"]));
    const row = document.querySelector("[data-quick-jobs]");
    expect(row.textContent).toBe("Drop-in" + "Ny reservation");
    expect(row.getAttribute("aria-label")).toBe(da.tdQuickActions);
    // Known from I dag: no read of its own.
    expect(apiGet.mock.calls.some(([u]) => u === "/today")).toBe(false);
  });

  it("a sale still takes 0 extra taps: the sale form is first and selected, the chips above it", async () => {
    noteBookFacts("u-1", { has_book: true, seats: 24 });
    openSheet();
    await waitFor(() => expect(chips().length).toBe(2));
    const saleTab = screen.getByRole("button", { name: da.logSaleTab });
    expect(saleTab.className).toMatch(/bg-white/);   // the selected segment
    // The quick amounts and the amount field are on screen without a tap.
    expect(screen.getByText(da.quickAmount)).toBeTruthy();
    expect(screen.getByPlaceholderText(da.orTypeAmount)).toBeTruthy();
    // The jobs row comes before the sale form in the sheet.
    const row = document.querySelector("[data-quick-jobs]");
    expect(row.compareDocumentPosition(saleTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Drop-in is hidden when canWalkIn is false: no seats, not a food venue, or not known yet", async () => {
    noteBookFacts("u-1", { has_book: true, seats: 0 });
    openSheet();
    await waitFor(() => expect(chips()).toEqual(["new"]));
    cleanup();

    __resetQuickJobsForTests();
    mockUser = { id: "u-2", business_type: "salon", currency: "DKK", role: "owner" };
    noteBookFacts("u-2", { has_book: true, seats: 6 });
    openSheet();
    await waitFor(() => expect(chips()).toEqual(["new"]));
  });

  it.each(["manager", "cashier", "viewer", "accountant"])(
    "seat %s: no jobs row at all (every write is refused server-side: a chip would be a dead end), and no /today read",
    async (role) => {
      noteBookFacts("u-3", { has_book: true, seats: 24 });
      mockUser = { id: "u-3", business_type: "restaurant", currency: "DKK", role };
      openSheet();
      // The sheet itself still opens, with its sale form.
      await waitFor(() => expect(screen.getByRole("button", { name: da.logSaleTab })).toBeTruthy());
      expect(document.querySelector("[data-quick-jobs]")).toBeNull();
      expect(chips()).toEqual([]);
      expect(apiGet.mock.calls.some(([u]) => u === "/today")).toBe(false);
    },
  );

  it("the owner's seat with no role on the account reads as the owner (chips shown)", async () => {
    noteBookFacts("u-1", { has_book: true, seats: 24 });
    mockUser = { id: "u-1", business_type: "restaurant", currency: "DKK" };
    openSheet();
    await waitFor(() => expect(chips()).toEqual(["walkin", "new"]));
  });

  it("a salon's chip says what its own sheet says: Book en tid (rsvpNewBookingProvider), not Ny reservation", async () => {
    mockUser = { id: "u-2", business_type: "salon", currency: "DKK", role: "owner" };
    noteBookFacts("u-2", { has_book: true, seats: 0 });
    openSheet();
    await waitFor(() => expect(chips()).toEqual(["new"]));
    expect(document.querySelector('[data-quick-job="new"]').textContent).toBe(da.rsvpNewBookingProvider);
    expect(da.rsvpNewBookingProvider).toBe("Book en tid");
  });

  it("opened before I dag ever answered: one /today read, and Drop-in once it says the venue seats drop-ins", async () => {
    let answer;
    apiGet.mockImplementation((url) => {
      if (url === "/today") return new Promise((r) => { answer = r; });
      return Promise.resolve({ data: [] });
    });
    openSheet();
    await waitFor(() => expect(chips()).toEqual(["new"]));
    expect(apiGet.mock.calls.filter(([u]) => u === "/today")).toHaveLength(1);
    await act(async () => { answer({ data: { reservations: { has_book: true, seats: 30 } } }); });
    await waitFor(() => expect(chips()).toEqual(["walkin", "new"]));
  });

  it("the reservations pillar off: no jobs row at all; personal mode: none either", async () => {
    hidden = new Set(["reservations"]);
    noteBookFacts("u-1", { has_book: true, seats: 24 });
    openSheet();
    await waitFor(() => expect(screen.getByRole("button", { name: da.logSaleTab })).toBeTruthy());
    expect(document.querySelector("[data-quick-jobs]")).toBeNull();
    cleanup();

    hidden = new Set();
    mockUser = { id: "u-1", business_type: "personal", currency: "DKK", role: "owner" };
    openSheet();
    await waitFor(() => expect(document.querySelector("[role='dialog']")).not.toBeNull());
    expect(document.querySelector("[data-quick-jobs]")).toBeNull();
  });

  it("each chip closes the sheet and opens Reservationer's own sheet by its deep link", async () => {
    noteBookFacts("u-1", { has_book: true, seats: 24 });
    openSheet();
    await waitFor(() => expect(chips().length).toBe(2));
    fireEvent.click(document.querySelector('[data-quick-job="walkin"]'));
    expect(where.pathname + where.search).toBe("/reservations?walkin=1");
    await waitFor(() => expect(document.querySelector("[data-quick-jobs]")).toBeNull());

    fireEvent.click(document.querySelector("[data-quickadd-toggle]"));
    await waitFor(() => expect(chips().length).toBe(2));
    fireEvent.click(document.querySelector('[data-quick-job="new"]'));
    expect(where.pathname + where.search).toBe("/reservations?new=1");
    // Two taps, two navigations: each one its own key (the page opens its
    // sheet once per navigation — phoneR1.reservations).
    fireEvent.click(document.querySelector("[data-quickadd-toggle]"));
    await waitFor(() => expect(chips().length).toBe(2));
    const before = where.key;
    fireEvent.click(document.querySelector('[data-quick-job="new"]'));
    expect(where.key).not.toBe(before);
  });
});

describe("one model, two ways in (quickJobs.js)", () => {
  it("is I dag's canWalkIn: a book, a food venue, seats > 0", () => {
    expect(canWalkInWith({ showRsv: true, isFood: true, seats: 4 })).toBe(true);
    expect(canWalkInWith({ showRsv: true, isFood: true, seats: 0 })).toBe(false);
    expect(canWalkInWith({ showRsv: false, isFood: true, seats: 4 })).toBe(false);
    expect(canWalkInWith({ showRsv: true, isFood: false, seats: 4 })).toBe(false);
    expect(quickJobs({ businessType: "bar", hiddenPillars: new Set(), facts: { hasBook: true, seats: 10 } })).toEqual({ newBooking: true, walkIn: true });
    expect(quickJobs({ businessType: "cafe", hiddenPillars: new Set(["reservations"]), facts: { hasBook: true, seats: 10 } })).toEqual({ newBooking: false, walkIn: false });
  });

  it("I dag uses the same rule and the same targets, and no longer installs its own press", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = fs.readFileSync(path.join(SRC, "components/today/TodayDashboard.jsx"), "utf8");
    expect(src).toContain("canWalkInWith({ showRsv, isFood, seats: rsv?.seats })");
    expect(src).toContain("const newBookingTo = NEW_BOOKING_TO;");
    expect(src).toContain("const walkInTo = WALK_IN_TO;");
    expect(src).toContain("noteBookFacts(user?.id, data.reservations)");
    // The same word as the "+" chip and the sheet it opens: Ny reservation,
    // or Book en tid where the business books a time (Reservationer's rule).
    expect(src).toContain('const newBookingWord = t(speaksAppointments(user?.business_type) ? "rsvpNewBookingProvider" : "tdNewBooking");');
    expect(src).not.toContain('{t("tdNewBooking")}');
    expect(src.match(/\/>\{newBookingWord\}<\/Link>/g)).toHaveLength(3);
  });
});

describe("one chip for both ways in (fix round, 13 Nov)", () => {
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "");
  const readSrc = async (rel) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    return fs.readFileSync(path.join(SRC, rel), "utf8");
  };

  it('the "+" chip IS I dag\'s phone chip: 40 px, 12 px round, DM Sans 13 px/600, the warm hairline', async () => {
    const shell = strip(await readSrc("components/owner/ownerShell.css"));
    const job = shell.match(/\.ow-job \{([^}]*)\}/)[1];
    expect(job).toMatch(/height: 40px;/);
    expect(job).toMatch(/border-radius: 12px;/);
    expect(job).toMatch(/font: 600 13px\/1\.2 "DM Sans", "Inter"/);
    expect(job).toMatch(/border: 1px solid var\(--td-line\);/);
    expect(shell).toMatch(/\.ow-jobs > \.ow-job \{ min-height: 40px; \}/);
    // I dag's chip really draws 40 too: index.css's 44 px touch floor on <a>
    // used to win over its height.
    const today = strip(await readSrc("components/today/today.css"));
    const quick = today.match(/\.td-quick \.td-btn \{([^}]*)\}/)[1];
    expect(quick).toMatch(/height: 40px;/);
    expect(quick).toMatch(/min-height: 40px;/);
    expect(quick).toMatch(/border-radius: 12px;/);
    expect(quick).toMatch(/font-size: 13px;/);
  });

  it('one order everywhere: Drop-in, then Ny reservation — on I dag as in the "+" sheet and on Reservationer', async () => {
    const dash = await readSrc("components/today/TodayDashboard.jsx");
    const row = dash.slice(dash.indexOf('<div className="td-quick"'), dash.indexOf("</div>", dash.indexOf('<div className="td-quick"')));
    expect(row.indexOf("to={walkInTo}")).toBeGreaterThan(-1);
    expect(row.indexOf("to={walkInTo}")).toBeLessThan(row.indexOf("to={newBookingTo}"));
    expect(row.indexOf("to={newBookingTo}")).toBeLessThan(row.indexOf("to={closeTo}"));
    // Same icon per job on I dag: UserPlus for Drop-in, CalendarPlus for Ny reservation.
    expect(row).toMatch(/to=\{walkInTo\} className="td-btn"><UserPlus /);
    expect(row).toMatch(/to=\{newBookingTo\} className="td-btn"><CalendarPlus /);
    // The "+" sheet: rendered order.
    noteBookFacts("u-1", { has_book: true, seats: 20 });
    openSheet();
    await waitFor(() => expect(chips()).toEqual(["walkin", "new"]));
  });
});

describe("the words (decision 3): real Danish and English, one key each", () => {
  it("Drop-in and Ny reservation, in both dictionaries", () => {
    expect(da.tdWalkIn).toBe("Drop-in");
    expect(da.tdNewBooking).toBe("Ny reservation");
    expect(en.tdWalkIn).toBe("Drop-in");
    expect(en.tdNewBooking).toBe("New reservation");
    // The live Reservationer page's own word for these guests.
    expect(da.rsvpSeatWalkInShort).toBe(da.tdWalkIn);
    // I dag's Bookinger card says Drop-in too (it opens the same sheet).
    expect(da.tdSeatWalkIn).toBe("Placér drop-in");
    expect(en.tdSeatWalkIn).toBe("Seat a drop-in");
    // English: the chip and the sheet it opens say the same thing.
    expect(en.rsvpNewBooking).toBe(en.tdNewBooking);
    expect(da.rsvpNewBooking).toBe(da.tdNewBooking);
  });

  it('no I dag (td*) word says "walk-in" any more, in either language', () => {
    for (const [name, dict] of [["da", da], ["en", en]]) {
      const left = Object.entries(dict).filter(([k, v]) => k.startsWith("td") && typeof v === "string" && /walk-?in/i.test(v));
      expect(left, name).toEqual([]);
    }
  });
  it('Reservationer\'s phone chip keeps "Kræver dig": "Kræver handling" does not fit at 360 px', () => {
    // Measured on the running page (phone R1, headless Chromium, DM Sans
    // 12 px in TonightStrip's three-column phone strip): "Kræver handling"
    // needs ~90 px and is cut with "…" at 360 px (it fits at 390 and 412).
    // The plan's rule: the new word only if it fits at 360 with no "…".
    expect(da.rsvpTnNeedsShort).toBe("Kræver dig");
    expect(da.rsvpTnNeeds).toBe("Kræver handling");   // the long label, unchanged
  });

  it("every key the dock and the jobs row read is a real word in da and en", () => {
    for (const k of ["tdWalkIn", "tdNewBooking", "tdSeatWalkIn", "rsvpNewBookingProvider", "tdQuickActions", "bottomNav", "navTodayHome", "navToday", "reservations", "more"]) {
      for (const [name, dict] of [["da", da], ["en", en]]) {
        expect(typeof dict[k], `${name}.${k}`).toBe("string");
        expect(dict[k].trim().length, `${name}.${k}`).toBeGreaterThan(0);
        expect(dict[k], `${name}.${k}`).not.toBe(k);
      }
    }
  });
});
