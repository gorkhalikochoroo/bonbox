/**
 * Booking R5 — the owner's colour on the public booking page (rubric E6).
 *
 *  • the page: a venue with a colour paints the picked chips (party, day,
 *    time, and the step-2 chips) and the main button in it — the root carries
 *    [data-bb-accent] and the guard's custom properties; a venue without one
 *    (or with garbage) keeps BonBox's own look; a ?accent= in the link
 *    changes nothing (the owner chooses in settings);
 *  • the rules (index.css) only ever apply under [data-bb-accent];
 *  • the owner's row (Reservationer → Indstillinger, under the page's name):
 *    one tap picks a colour or Standard, the preview shows the guard's
 *    text colour, an open website preview reloads;
 *  • the gavekort card never writes on gold in white.
 *
 * The clock is pinned (Date only) to Tuesday 8 January 2030, 09:00.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), lang: "da" }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: (...a) => h.patch(...a), delete: vi.fn(),
    defaults: { baseURL: "http://localhost:8000/api" },
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    const dict = h.lang === "en" ? EN : DA;
    let s = dict[k] ?? EN[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return {
    useLanguage: () => ({ lang: h.lang, setLang: () => {}, t }),
    LanguageProvider: ({ children }) => children,
  };
});
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn(async () => ({ ok: true })) }));

const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const BookingAccentRow = (await import("../components/reservations/BookingAccentRow")).default;
const WebsiteBookingKit = (await import("../components/reservations/WebsiteBookingKit")).default;
const GavekortCard = (await import("../components/GavekortCard")).default;
const { TILE_PICKED } = await import("../components/booking/bookingTiles");
const { BOOKING_LOOK_EVENT, contrast } = await import("../utils/accentColor");
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const TODAY = "2030-01-08";
const plus = (n) => {
  const d = new Date(2030, 0, 8 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const PAGE = {
  business_name: "Guldkanten", business_type: "restaurant", phone: "+45 12 34 56 78",
  address: "Gade 1", city: "København", max_party_size: 10, max_advance_days: 60,
  lead_time_min: 60, language: "da", guest_can_pick_table: false,
};
const TIMES = ["17:00", "17:30", "18:00", "18:30", "19:00"];
const summary = () => ({
  from: TODAY, party_size: 2, next_open_day: TODAY,
  days: Array.from({ length: 14 }, (_, i) => ({ date: plus(i), has_slots: true, reason: null })),
});

function routes(page = PAGE) {
  h.get.mockImplementation((url) => {
    if (url === "/public/reservations/x") return Promise.resolve({ data: page });
    if (url === "/public/reservations/x/availability-summary") return Promise.resolve({ data: summary() });
    if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: TIMES } });
    return Promise.resolve({ data: {} });
  });
}
const renderAt = (p = "/r/x") =>
  render(
    <MemoryRouter initialEntries={[p]}>
      <Routes>
        <Route path="/r/:slug" element={<ReservationPublicPage />} />
      </Routes>
    </MemoryRouter>,
  );
const root = () => screen.getByTestId("rsvp-root");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 0, 8, 9, 0));
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
  h.lang = "da";
  localStorage.clear();
  delete window.__bbBooking;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.classList.remove("bb-embed-card");
});

describe("E6 · the booking page wears the venue's colour", () => {
  it("gold: the root carries the colour and the guard's text colour (the ink, never white)", async () => {
    routes({ ...PAGE, accent_color: "#C9A45C" });
    renderAt();
    await settle();
    expect(root()).toHaveAttribute("data-bb-accent", "");
    expect(root().style.getPropertyValue("--bb-accent")).toBe("#C9A45C");
    expect(root().style.getPropertyValue("--bb-accent-fg")).toBe("#111827");
    expect(root().style.getPropertyValue("--bb-accent-edge")).not.toBe("#C9A45C"); // deepened: 3:1 on white
  });

  it("blue keeps white text", async () => {
    routes({ ...PAGE, accent_color: "#2563EB" });
    renderAt();
    await settle();
    expect(root().style.getPropertyValue("--bb-accent-fg")).toBe("#FFFFFF");
  });

  it("the picked party, day and time and the main button carry the hooks the colour rules use", async () => {
    routes({ ...PAGE, accent_color: "#C9A45C" });
    renderAt();
    await settle();
    const picked = [...root().querySelectorAll('[role="radio"][aria-checked="true"]')];
    expect(picked.length).toBeGreaterThanOrEqual(2); // party 2 + today (+ no time yet)
    for (const el of picked) {
      if (el.className.includes("bb-tile")) expect(el.className).toContain("bb-pick");
    }
    // the day's quiet lines (weekday, month) are marked for the colour's softer text
    const day = picked.find((el) => el.textContent.includes("8"));
    expect(day.querySelectorAll(".bb-pick-quiet").length).toBeGreaterThanOrEqual(2);
    // pick a time: its tile is a pick too
    await act(async () => { fireEvent.click(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "18:00")); });
    expect(screen.getAllByRole("radio").find((r) => r.textContent.trim() === "18:00").className).toContain("bb-pick");
    const cta = within(screen.getByTestId("rsvp-cta-bar")).getAllByRole("button").pop();
    expect(cta.className).toContain("bb-accent-main");
  });

  it("no colour: BonBox's own look, exactly as before (no hook on the root, no custom properties)", async () => {
    routes(PAGE);
    renderAt();
    await settle();
    expect(root()).not.toHaveAttribute("data-bb-accent");
    expect(root().style.getPropertyValue("--bb-accent")).toBe("");
    expect(TILE_PICKED).toContain("bg-gray-900");
  });

  it.each(["gold", "#12345", "red;}", null, 7])("a server value that is not a colour (%s) is no colour", async (bad) => {
    routes({ ...PAGE, accent_color: bad });
    renderAt();
    await settle();
    expect(root()).not.toHaveAttribute("data-bb-accent");
  });

  it("a ?accent= in the link changes nothing: the owner chooses in settings", async () => {
    routes(PAGE);
    renderAt("/r/x?embed=1&accent=%23FF0000");
    await settle();
    expect(root()).not.toHaveAttribute("data-bb-accent");
    cleanup();
    routes({ ...PAGE, accent_color: "#2563EB" });
    renderAt("/r/x?accent=%23FF0000");
    await settle();
    expect(root().style.getPropertyValue("--bb-accent")).toBe("#2563EB");
    expect(read("pages/ReservationPublicPage.jsx")).not.toMatch(/searchParams\.get\(["']accent["']\)/);
  });
});

describe("E6 · the rules apply only under [data-bb-accent]", () => {
  const css = read("index.css");
  // The R5 block, comments out (they name colours and classes in prose).
  const block = css.slice(css.lastIndexOf("/*", css.indexOf("BOOKING ACCENT (R5"))).replace(/\/\*[\s\S]*?\*\//g, "");

  it("every rule that paints a pick or the main button is scoped to a page with a colour", () => {
    const selectors = [...block.matchAll(/^([^{}@/\n][^{}]*)\{/gm)].map((m) => m[1].trim());
    const painting = selectors.filter((s) => /bb-pick|bb-accent-main/.test(s));
    expect(painting.length).toBeGreaterThanOrEqual(5);
    for (const sel of painting) {
      for (const part of sel.split(",")) expect(part.trim(), part).toMatch(/^(\.dark )?\[data-bb-accent\] /);
    }
  });

  it("disabled stays grey; hover only for a fine pointer; meaning colours untouched", () => {
    expect(block).toMatch(/\.bb-accent-main:not\(:disabled\)/);
    expect(block).toMatch(/@media \(hover: hover\) and \(pointer: fine\)/);
    expect(block).not.toMatch(/emerald/);
  });

  it("the picked tile class carries the hook, the plain tile does not", async () => {
    const tiles = await import("../components/booking/bookingTiles");
    expect(tiles.TILE_PICKED).toMatch(/(^|\s)bb-pick(\s|$)/);
    expect(tiles.TILE_REST).not.toMatch(/bb-pick/);
    expect(tiles.TILE_CLOSED).not.toMatch(/bb-pick/);
  });
});

// ── The owner's row ────────────────────────────────────────────────────
const PALETTE = {
  emerald: "#10B981", blue: "#2563EB", slate: "#475569", terracotta: "#C2410C",
  charcoal: "#1F2937", burgundy: "#9F1239", gold: "#C9A45C",
};
const makeT = (dict) => (key, vars) => {
  const s = dict[key] ?? key;
  return vars && typeof vars === "object" ? s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m)) : s;
};
const tDa = makeT(da);

function brand(accent = null) {
  h.get.mockImplementation((url) =>
    url === "/business/brand"
      ? Promise.resolve({ data: { accent_color: accent, accent_palette: PALETTE, logo_url: null, logo_position: "left" } })
      : Promise.resolve({ data: {} }),
  );
}

describe("the owner's row (Reservationer → Indstillinger)", () => {
  it("Standard first, then the seven colours (gold first), named in the owner's language", async () => {
    brand(null);
    render(<BookingAccentRow t={tDa} />);
    await settle();
    const radios = within(screen.getByRole("radiogroup", { name: da.rsvpAccentTitle })).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      da.rsvpAccentStandard, "Guld", "Terrakotta", "Bordeaux", "Smaragdgrøn", "Blå", "Skifergrå", "Koksgrå",
    ]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(da.rsvpAccentShared)).toBeInTheDocument();
  });

  it("one tap on Guld saves it, shows it as picked, and tells an open preview", async () => {
    brand(null);
    h.patch.mockResolvedValue({ data: { accent_color: "#C9A45C", accent_palette: PALETTE } });
    const heard = vi.fn();
    window.addEventListener(BOOKING_LOOK_EVENT, heard);
    render(<BookingAccentRow t={tDa} />);
    await settle();
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "Guld" })); });
    await settle();
    expect(h.patch).toHaveBeenCalledWith("/business/brand", { accent_color: "gold" });
    expect(screen.getByRole("radio", { name: "Guld" })).toHaveAttribute("aria-checked", "true");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(screen.getByText(da.rsvpAccentSaved)).toBeInTheDocument();
    // The preview draws a guest's pick and button with the page's own rules — dark text on gold.
    const preview = screen.getByTestId("rsvp-accent-preview");
    expect(preview).toHaveAttribute("data-bb-accent", "");
    expect(preview.style.getPropertyValue("--bb-accent-fg")).toBe("#111827");
    expect(preview.querySelector(".bb-pick")).not.toBeNull();
    expect(preview.querySelector(".bb-accent-main").textContent).toBe(da.rsvpContinue);
    window.removeEventListener(BOOKING_LOOK_EVENT, heard);
  });

  it("Standard takes the colour off (an explicit null)", async () => {
    brand("#C9A45C");
    h.patch.mockResolvedValue({ data: { accent_color: null, accent_palette: PALETTE } });
    render(<BookingAccentRow t={tDa} />);
    await settle();
    expect(screen.getByRole("radio", { name: "Guld" })).toHaveAttribute("aria-checked", "true");
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: da.rsvpAccentStandard })); });
    await settle();
    expect(h.patch).toHaveBeenCalledWith("/business/brand", { accent_color: null });
    expect(screen.getByRole("radio", { name: da.rsvpAccentStandard })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("rsvp-accent-preview")).not.toHaveAttribute("data-bb-accent");
  });

  it("a failed save goes back to what was saved and says so", async () => {
    brand("#2563EB");
    h.patch.mockRejectedValue(new Error("500"));
    render(<BookingAccentRow t={tDa} />);
    await settle();
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "Guld" })); });
    await settle();
    expect(screen.getByRole("radio", { name: "Blå" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(da.rsvpSettingsSaveError)).toBeInTheDocument();
  });

  it("402 (no plan and booking off) explains instead of offering swatches that cannot save", async () => {
    h.get.mockRejectedValue(Object.assign(new Error("402"), { response: { status: 402 } }));
    render(<BookingAccentRow t={tDa} />);
    await settle();
    expect(screen.getByTestId("rsvp-accent-locked").textContent).toBe(da.rsvpAccentLocked);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("a failed read offers a retry", async () => {
    h.get.mockRejectedValueOnce(new Error("network"));
    render(<BookingAccentRow t={tDa} />);
    await settle();
    expect(screen.getByText(da.rsvpAccentLoadError)).toBeInTheDocument();
    brand(null);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpAccentRetry })); });
    await settle();
    expect(screen.getAllByRole("radio")).toHaveLength(8);
  });

  it("phone: one row of eight 40 px squares (min-h-0! releases the touch floor); sm: 36 px", async () => {
    brand(null);
    render(<BookingAccentRow t={tDa} />);
    await settle();
    const group = screen.getByRole("radiogroup");
    expect(group.className).toContain("grid-cols-8");
    for (const r of within(group).getAllByRole("radio")) {
      expect(r.className).toContain("min-h-0!");
      expect(r.className).toContain("sm:w-9");
    }
  });

  it("sits right under the page's name in the booking settings", () => {
    const src = read("pages/ReservationsPage.jsx");
    const name = src.indexOf("<BookingNameRow");
    const row = src.indexOf("<BookingAccentRow");
    const toggle = src.indexOf("On/off toggle (+ the pause");
    expect(name).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(name);
    expect(row).toBeLessThan(toggle);
  });

  it("every word it shows is a real key in Danish and English", () => {
    const keys = [
      "rsvpAccentTitle", "rsvpAccentHint", "rsvpAccentStandard", "rsvpAccentShared", "rsvpAccentSaved",
      "rsvpAccentLocked", "rsvpAccentLoadError", "rsvpAccentRetry",
      ...Object.keys(PALETTE).map((n) => `rsvpAccentName_${n}`),
    ];
    for (const k of keys) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
      expect(da[k]).not.toBe(k);
    }
    // DK terms stay Danish in English too (terminology lock).
    expect(en.rsvpAccentShared).toMatch(/fakturaer/);
    expect(en.rsvpAccentShared).toMatch(/gavekort/);
  });
});

describe("the website preview reloads when the colour changes", () => {
  it("a new frame (same address) after the look event", async () => {
    render(
      <WebsiteBookingKit publicUrl="https://www.bonbox.dk/cafe-mirabelle" venueName="Café Mirabelle" enabled t={tDa} appOrigin="https://www.bonbox.dk" canFramePreview />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Indlejr" }));
    const before = screen.getByTestId("website-preview");
    await act(async () => { window.dispatchEvent(new Event(BOOKING_LOOK_EVENT)); });
    const after = screen.getByTestId("website-preview");
    expect(after).not.toBe(before);
    expect(after.getAttribute("src")).toBe(before.getAttribute("src"));
  });
});

describe("the gavekort card never writes on gold in white", () => {
  const PAPER = "#fbfaf7";
  const INK = "#14120f";
  const mono = (c) => [...c.querySelectorAll("span")].find((s) => s.textContent === "G");
  const eyebrow = (c) => [...c.querySelectorAll("div")].find((d) => d.textContent === "Gavekort");

  it("gold: the monogram's letters are the ink; the eyebrow is gold deepened to AA on paper", () => {
    const { container } = render(<GavekortCard businessName="Guldkanten" accentColor="#C9A45C" amountLabel="500 kr." />);
    const letters = mono(container).parentElement;
    expect(letters.style.color).toBe("rgb(20, 18, 15)");
    const rgb = eyebrow(container).style.color.match(/\d+/g).map(Number);
    const hex = "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join("");
    expect(contrast(hex, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(hex.toUpperCase()).not.toBe("#C9A45C");
  });

  it("blue: unchanged — paper letters, the blue itself as the eyebrow", () => {
    const { container } = render(<GavekortCard businessName="Guldkanten" accentColor="#2563EB" amountLabel="500 kr." />);
    expect(mono(container).parentElement.style.color).toBe("rgb(251, 250, 247)");
    expect(eyebrow(container).style.color).toBe("rgb(37, 99, 235)");
    expect(INK).toBe("#14120f");
  });
});
