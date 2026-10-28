/**
 * Booking R13 — the owner's side and the page:
 *   - the kit ("Sæt på din hjemmeside"): "Tilpas automatisk til min
 *     hjemmeside" on by default for a NEW snippet; Farver (Automatisk / Lys /
 *     Mørk) and Knapfarve (Fra din hjemmeside / Din BonBox-farve) written into
 *     the snippet as data- attributes; off = the R4 snippet; the preview on
 *     three sample sites (light, dark, photo), each sent to the real page as
 *     the script would send it;
 *   - the page: on its own it follows the phone's dark mode; in an embed with
 *     a look it keeps the look's theme and its action bar rests on the look's
 *     card; one card look on a computer; the trust check in the CTA's green.
 *   - every new key in real en + da.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), lang: "da" }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
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
  return { useLanguage: () => ({ lang: h.lang, setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");
const WebsiteBookingKit = (await import("../components/reservations/WebsiteBookingKit")).default;
const { MATCH_DEFAULT } = await import("../components/reservations/WebsiteBookingKit");
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const { LOOK_SAMPLES, iframeSnippet, sampleLookQuery } = await import("../utils/bookingEmbed");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const tOf = (dict) => (k, vars) => {
  let s = dict[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const html = () => document.documentElement;

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  h.lang = "da";
  localStorage.clear();
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  html().className = "";
  html().removeAttribute("style");
});

// ── The kit ──────────────────────────────────────────────────────────
const PUBLIC = "https://www.bonbox.dk/cafe-mirabelle";
function renderKit(t = tOf(da)) {
  const view = render(
    <WebsiteBookingKit publicUrl={PUBLIC} venueName="Café Mirabelle" t={t} appOrigin="https://www.bonbox.dk" canFramePreview />,
  );
  fireEvent.click(screen.getByRole("tab", { name: t("rsvpWebTabEmbed") }));
  return view;
}
const code = () => screen.getByTestId("website-embed-code").textContent;
const frame = () => screen.getByTestId("website-preview");
const pick = (group, value) => fireEvent.click(within(screen.getByTestId(group)).getByRole("radio", { name: value }));

describe("the kit: match the website, by default, with the owner's override", () => {
  it("a new snippet opts in: data-bonbox-look=auto, data-bonbox-accent=site, and the detection script", () => {
    expect(MATCH_DEFAULT).toBe(true);
    renderKit();
    expect(screen.getByTestId("website-embed-match").checked).toBe(true);
    expect(screen.getByText(da.rsvpWebMatch)).toBeTruthy();
    expect(code()).toContain('<iframe data-bonbox-booking data-bonbox-look="auto" data-bonbox-accent="site" src=');
    expect(code()).toContain("bonbox:look");
  });

  it("Farver and Knapfarve are written into the snippet", () => {
    renderKit();
    pick("website-look-mode", da.rsvpWebColoursDark);
    expect(code()).toContain('data-bonbox-look="dark" data-bonbox-accent="site"');
    pick("website-look-mode", da.rsvpWebColoursLight);
    pick("website-look-accent", da.rsvpWebButtonColourOwn);
    expect(code()).toContain('data-bonbox-look="light" data-bonbox-accent="own"');
    expect(within(screen.getByTestId("website-look-accent")).getByRole("radio", { name: da.rsvpWebButtonColourOwn })).toHaveAttribute("aria-checked", "true");
  });

  it("switched off: the R4 snippet, byte for byte — no attribute, no detection, the overrides hidden", () => {
    renderKit();
    fireEvent.click(screen.getByTestId("website-embed-match"));
    const r4 = iframeSnippet({ publicUrl: PUBLIC, label: da.rsvpEmbedButtonLabel, venueName: "Café Mirabelle", fallbackLabel: da.rsvpEmbedOpenInNewTab, compact: true });
    expect(code()).toBe(r4);
    expect(code()).not.toMatch(/data-bonbox-look|bonbox:look/);
    expect(screen.queryByTestId("website-embed-look")).toBeNull();
    expect(screen.queryByTestId("website-look-sample")).toBeNull();
    expect(frame().getAttribute("src")).toBe("https://www.bonbox.dk/r/cafe-mirabelle?embed=1&compact=1");
  });

  it("the preview: the real page on three sample sites, each sent as the script would send it", () => {
    renderKit();
    const auto = { mode: "auto", accent: "site" };
    expect(frame().getAttribute("src")).toBe("https://www.bonbox.dk/r/cafe-mirabelle?embed=1&compact=1&" + sampleLookQuery("light", auto));
    expect(screen.getByTestId("website-preview-phone").style.backgroundColor).toBe("rgb(244, 239, 230)"); // the cream site around it
    pick("website-look-sample", da.rsvpWebSampleDark);
    expect(frame().getAttribute("src")).toContain("&look=1&surface=121212&ink=ededed&accent=c9a45c&accent_ink=111111&radius=sharp&font=helvetica");
    pick("website-look-sample", da.rsvpWebSamplePhoto);
    expect(frame().getAttribute("src")).toContain("&look=1&surface=photo&");
    expect(screen.getByTestId("website-preview-phone").style.backgroundImage).toContain("data:image/svg+xml");
    // the owner's override reaches the preview too
    pick("website-look-mode", da.rsvpWebColoursLight);
    pick("website-look-accent", da.rsvpWebButtonColourOwn);
    expect(frame().getAttribute("src")).toContain("&look=1&theme=light&surface=photo&ink=ffffff&radius=soft&font=system");
    expect(frame().getAttribute("src")).not.toContain("accent=");
  });

  it("on the computer: the sample site's own top line (its ink and its button) above the booking", () => {
    renderKit();
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(da.rsvpWebPreviewComputer) }));
    pick("website-look-sample", da.rsvpWebSampleDark);
    const head = screen.getByTestId("website-preview-sample-header");
    expect(head.textContent).toContain(da.rsvpWebSampleSite);
    expect(head.textContent).toContain(da.rsvpWebSampleButton);
    expect(head.style.color).toBe("rgb(237, 237, 237)");
    expect(screen.getByTestId("website-preview-host").style.backgroundColor).toBe("rgb(18, 18, 18)");
    expect(within(screen.getByTestId("website-preview-host")).getByTestId("website-preview").style.borderRadius).toBe("4px");
  });

  it("English owner: real words, no raw keys", () => {
    const view = renderKit(tOf(en));
    expect(screen.getByText(en.rsvpWebMatch)).toBeTruthy();
    expect(screen.getByText(en.rsvpWebButtonColourSite)).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/rsvpWeb[A-Z]/);
  });
});

// ── The page ─────────────────────────────────────────────────────────
const PAGE = {
  business_name: "Bistro Test", business_type: "restaurant", phone: "+45 12 34 56 78", address: "Gade 1",
  city: "København", max_party_size: 10, max_advance_days: 60, lead_time_min: 60, language: "da", guest_can_pick_table: false,
};
function routes() {
  h.get.mockImplementation((url) => {
    if (url === "/public/reservations/x") return Promise.resolve({ data: PAGE });
    if (url === "/public/reservations/x/availability-summary") {
      return Promise.resolve({ data: { from: "2030-01-08", party_size: 2, next_open_day: "2030-01-08", days: [] } });
    }
    if (url === "/public/reservations/x/availability") return Promise.resolve({ data: { slots: ["18:00", "18:30"] } });
    return Promise.resolve({ data: {} });
  });
}
const renderAt = (p) =>
  render(
    <MemoryRouter initialEntries={[p]}>
      <Routes>
        <Route path="/r/:slug" element={<ReservationPublicPage />} />
      </Routes>
    </MemoryRouter>,
  );
const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

describe("the booking page on its own follows the phone's dark mode", () => {
  const realMM = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMM;
  });
  const phone = (dark) => {
    const listeners = [];
    window.matchMedia = vi.fn((q) => ({
      get matches() { return dark.on && q === "(prefers-color-scheme: dark)"; },
      media: q,
      addEventListener: (_t, fn) => listeners.push(fn), removeEventListener: () => {}, addListener() {}, removeListener() {},
    }));
    return listeners;
  };

  it("a dark phone: dark while mounted (the stored 'light' untouched), back on leaving; it follows a switch", async () => {
    const state = { on: true };
    const listeners = phone(state);
    localStorage.setItem("theme", "light");
    routes();
    const view = renderAt("/r/x");
    await settle();
    expect(html().classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("light");
    state.on = false;
    act(() => listeners.forEach((fn) => fn()));
    expect(html().classList.contains("dark")).toBe(false);
    state.on = true;
    act(() => listeners.forEach((fn) => fn()));
    expect(html().classList.contains("dark")).toBe(true);
    view.unmount();
    expect(html().classList.contains("dark")).toBe(false);
  });

  it("a light phone stays light; a stored 'dark' stays dark", async () => {
    phone({ on: false });
    routes();
    renderAt("/r/x");
    await settle();
    expect(html().classList.contains("dark")).toBe(false);
    cleanup();
    localStorage.setItem("theme", "dark");
    renderAt("/r/x");
    await settle();
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("an embed never follows the phone (the owner's site decides, or the look)", async () => {
    phone({ on: true });
    routes();
    renderAt("/r/x?embed=1");
    await settle();
    expect(html().classList.contains("dark")).toBe(false);
  });
});

describe("an embed with the restaurant's look", () => {
  it("keeps the look's dark theme, and its action bar rests on the look's card (not white / gray-950)", async () => {
    html().classList.add("bb-look", "dark");
    routes();
    renderAt("/r/x?embed=1&compact=1&look=1&surface=0b0b0b");
    await settle();
    expect(html().classList.contains("dark")).toBe(true);
    const bar = screen.getByTestId("rsvp-cta-bar");
    expect(bar.className).toContain("bb-look-bar");
    expect(bar.className).not.toContain("bg-white/92!");
    expect(screen.getByTestId("rsvp-root").className).toContain("bb-ground");
    expect(document.querySelector("main").className).toContain("bb-card");
  });

  it("without the look: forced light and the white bar, exactly as before", async () => {
    html().classList.add("dark");
    routes();
    renderAt("/r/x?embed=1&flat=1");
    await settle();
    expect(html().classList.contains("dark")).toBe(false);
    expect(screen.getByTestId("rsvp-cta-bar").className).toContain("bg-white/92! dark:bg-gray-950/90!");
    expect(screen.getByTestId("rsvp-root").className).toContain("bb-ground"); // the flat embed's hook (inert without .bb-look)
  });
});

describe("judge notes on the same surfaces", () => {
  it("one card look on a computer and in the embed: 16 px, a 5 % ring and the soft shadow; the bar follows the corners", async () => {
    routes();
    renderAt("/r/x");
    await settle();
    const main = document.querySelector("main");
    expect(main.className).toContain("sm:rounded-[16px]");
    expect(main.className).toContain("sm:shadow-[0_0_0_1px_rgb(16_24_40/0.05),0_1px_2px_rgb(16_24_40/0.04),0_16px_40px_-20px_rgb(16_24_40/0.18)]");
    expect(main.className).not.toMatch(/sm:shadow-sm|sm:border-gray-200|sm:rounded-xl/);
    expect(screen.getByTestId("rsvp-cta-bar").className).toContain("sm:rounded-b-[16px]");
    const wait = read("components/booking/bookingWait.js");
    expect(wait).toContain("w-full rounded-[16px] bg-white shadow-[0_0_0_1px_rgb(16_24_40/0.05)");
  });

  it("the trust check is the CTA's green (bb-green-dark), not #16A34A", async () => {
    const page = read("pages/ReservationPublicPage.jsx");
    expect(page).not.toMatch(/<Check className="[^"]*text-bb-green"/);
    expect(page.match(/<Check className="[^"]*text-bb-green-dark"/g)).toHaveLength(2);
  });
});

describe("every new key in real en + da", () => {
  const KEYS = [
    "rsvpWebMatch", "rsvpWebMatchHint", "rsvpWebColours", "rsvpWebColoursAuto", "rsvpWebColoursLight", "rsvpWebColoursDark",
    "rsvpWebButtonColour", "rsvpWebButtonColourSite", "rsvpWebButtonColourOwn", "rsvpWebSample", "rsvpWebSampleLight",
    "rsvpWebSampleDark", "rsvpWebSamplePhoto", "rsvpWebSampleHint", "rsvpWebSampleSite", "rsvpWebSampleButton",
  ];
  it.each(KEYS)("%s", (k) => {
    expect(typeof en[k]).toBe("string");
    expect(typeof da[k]).toBe("string");
    expect(en[k].trim().length).toBeGreaterThan(1);
    expect(da[k]).not.toBe(en[k]);
  });
  it("the sample sites are the three the brief names", () => {
    expect(Object.keys(LOOK_SAMPLES)).toEqual(["light", "dark", "photo"]);
  });
});

describe("the guest page carries no inline fallback words (its words come from its own dictionary)", () => {
  it("only the one the skeleton's wiring test pins", () => {
    const page = read("pages/ReservationPublicPage.jsx");
    const left = page.match(/\bt\(\s*"[A-Za-z0-9_.]+",\s*"/g) || [];
    expect(left).toEqual(['t("rsvpLoading", "']);
  });
});
