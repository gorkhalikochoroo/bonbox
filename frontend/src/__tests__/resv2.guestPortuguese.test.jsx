/**
 * Reservations v2 — the guest booking page speaks DA · EN · PT (canvas
 * Book.dc.html / Book-EN / Book-PT).
 *
 *   • PT is European Portuguese, from src/i18n/pt.js (one place a string is
 *     written), shipped as its own chunk (virtual:bonbox-guest-words-pt) that
 *     only a guest who picks PT downloads — the DA/EN booking dictionary is
 *     unchanged by a byte.
 *   • Every guest key the page shows has a pt-PT word with the same {vars}.
 *   • The switch: a third segment, "Português", and the page turns to it; DA
 *     brings Danish back.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { loadGuestPortuguese } = await import("../lib/guestPortuguese");
const { pageDictFor } = await import("../lib/pageDict");
const BOOKING = (await import("virtual:bonbox-booking-dict")).default;
const { en } = await import("../i18n/en");
const { da } = await import("../i18n/da");
const { pt } = await import("../i18n/pt");

const TODAY = "2026-10-23";
const plus = (n) => {
  const d = new Date(2026, 9, 23 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const settle = async (n = 14) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const PAGE = {
  business_name: "Bistro Nørrebro", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Nørrebrogade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false, providers: [],
  allergen_set: [], logo_url: null, closures: [], paused_until: null,
};
function routes() {
  const days = Array.from({ length: 14 }, (_, i) => ({ date: plus(i), has_slots: true, reason: null }));
  h.get.mockImplementation((url) => {
    if (url === "/public/reservations/x") return Promise.resolve({ data: PAGE });
    if (url === "/public/reservations/x/availability-summary") {
      return Promise.resolve({ data: { from: TODAY, party_size: 2, next_open_day: days[0].date, days } });
    }
    if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: ["19:00", "19:30"], slot_remaining: {} } });
    return Promise.resolve({ data: {} });
  });
}
const renderPage = () =>
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={["/r/x"]}>
        <Routes>
          <Route path="/r/:slug" element={<ReservationPublicPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 23, 12, 0));
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset();
  localStorage.clear();
  localStorage.setItem("lang", "da");
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("the Portuguese words", () => {
  it("load as their own chunk, only on demand, and register as the page's words", async () => {
    expect(BOOKING.pt).toBeUndefined(); // the DA/EN dictionary carries none of it
    expect(await loadGuestPortuguese()).toBe(true);
    const words = pageDictFor("pt");
    expect(words.rsvpConfirm).toBe("Confirmar reserva");
    expect(words.rsvpContactPhoneLabel).toBe("Telemóvel");
    // Only the page's own keys.
    for (const k of Object.keys(words)) expect(BOOKING.en[k], k).toBeDefined();
    const page = fs.readFileSync(path.join(SRC, "lib/guestPortuguese.js"), "utf8");
    expect(page).toContain('import("virtual:bonbox-guest-words-pt")');
  });

  it("cover every guest word of the flow, with the same {placeholders} as English", () => {
    const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const guestKeys = Object.keys(BOOKING.en).filter(
      (k) => /^rsvp/.test(k) && !/^rsvp(ClosedThatDay|EditClash|EditTooBig|NoTableNoHours|NoTableTooBig|NoTablesYet)$/.test(k),
    );
    const missing = guestKeys.filter((k) => !pt[k]);
    expect(missing).toEqual([]);
    for (const k of Object.keys(en).filter((x) => x.startsWith("allergen_"))) expect(pt[k], k).toBeTruthy();
    for (const k of guestKeys) expect(vars(pt[k]), k).toEqual(vars(en[k]));
  });

  it("are European, not Brazilian, Portuguese where the two differ", () => {
    const all = Object.keys(BOOKING.en).filter((k) => pt[k]).map((k) => pt[k]).join(" ");
    for (const br of ["Carregando", "Contato", "celular", "Celular", "equipe", "Estoque", " você "]) {
      expect(all, br).not.toContain(br);
    }
    expect(pt.loading).toBe("A carregar…");
    expect(pt.contact).toBe("Contacto");
  });
});

describe("DA · EN · PT on the page", () => {
  it("a third segment, Português, turns the page; Dansk turns it back", async () => {
    routes();
    renderPage();
    await settle();
    const group = screen.getAllByRole("group", { name: "Sprog · Language" })[0];
    const segs = [...group.querySelectorAll("button")].map((b) => b.getAttribute("lang"));
    expect(segs).toEqual(["da", "en", "pt"]);
    expect(screen.getAllByText(da.rsvpPartySize).length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Português" })[0]);
    });
    await settle();
    await waitFor(() => expect(screen.getAllByText("Número de pessoas").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("button", { name: "Português" })[0].getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Dansk" })[0]);
    });
    await settle();
    await waitFor(() => expect(screen.getAllByText(da.rsvpPartySize).length).toBeGreaterThan(0));
    expect(screen.queryByText("Número de pessoas")).toBeNull();
  });
});
