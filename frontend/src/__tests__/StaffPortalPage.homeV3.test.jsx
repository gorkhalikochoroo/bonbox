/**
 * Vagtplan home v3 (R1, Nov 2026) — pinned on the REAL page against a mocked
 * portalApi.
 *
 *   • Meld syg MOVED, never removed: the Play listing promises it. It is
 *     reachable two ways — the next-shift card's ⋯ menu, and the "Brug for en
 *     ændring?" section at the end of the week list — and BOTH open the same
 *     SickCallButton form that posts /portal/{token}/sick-call.
 *   • The floating tab bar (the Orvexlo dock since Nov 2026): 5 tabs, each
 *     icon + name, aria-current on the active one, one sliding pill.
 *   • The header is one row: no venue line, no always-on Live/Synket word.
 *   • The amber strip speaks only when offline, or when the data is more than
 *     45 s old with no live stream.
 *   • The next-shift card and the PIN card are flat forest (no gradient).
 *   • Rute goes to Apple Maps / geo: / Google per platform; with no street
 *     (or no address) it searches the place's name in its town.
 *   • EN location switcher says "Location", not "Department".
 *   • The ⋯ menu's Meld syg is about THAT shift's day; both sick paths
 *     scroll the whole form (Send included) above the floating bar.
 *   • The card holds its height: the map block is there before the image,
 *     a remount paints the kept image without a second fetch, and the map
 *     URL carries the pin's version (a moved pin is a new URL).
 *   • Stempl ind sits on the card only when the shift is close; further out
 *     it is the ⋯ menu's first row (same confirm).
 *   • Small round controls opt out of the touch-screen 44 px min-height, and
 *     the tab bar fits a 320 px phone (icon-only active tab there).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../i18n/en";
import { da } from "../i18n/da";
import { routeUrl, routePlatform } from "../utils/routeUrl";
import { clearVenueMapCache } from "../utils/venueMapImage";

const TOK = "tokv3";
const ok = (data) => Promise.resolve({ data });
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};
const reject = (status) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: {} };
  return Promise.reject(e);
};

const SHIFT_DAY = inDays(1);
let info;
let scheduleImpl;
const post = vi.fn(() => ok({ id: "sc1", status: "pending" }));
const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) return ok(info);
  if (url.startsWith(`/portal/${TOK}/schedule`)) return scheduleImpl();
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) {
    return ok([{ staff_id: "s-jonas", staff_name: "Jonas B.", date: SHIFT_DAY, start_time: "17:00", end_time: "23:00" }]);
  }
  if (url.startsWith(`/portal/${TOK}/hours`)) {
    return ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 0, entries: [] });
  }
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 2 });
  if (url.startsWith(`/portal/${TOK}/venue-map`)) return mapImpl(url);
  return ok([]);
});
let mapImpl;

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { light: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn(), takePhotoFile: vi.fn(), choosePhotoFiles: vi.fn(), isCameraDenied: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

function renderPage(lang = "da") {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
          <Routes>
            <Route path="/portal/:token" element={<StaffPortalPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </LanguageProvider>,
  );
}

async function mount(lang = "da") {
  renderPage(lang);
  await waitFor(() => expect(screen.getByTitle(lang === "da" ? "Rediger profil" : "Edit profile")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId("portal-hero-meta")).toBeInTheDocument());
}

const sickPosts = () => post.mock.calls.filter(([u]) => u === `/portal/${TOK}/sick-call`);

beforeEach(() => {
  localStorage.clear();
  clearVenueMapCache();
  get.mockClear();
  post.mockClear();
  info = {
    has_pin: false, staff_name: "Freja M.", role: "bartender",
    restaurant_name: "Café Solsikke", restaurant_address: "Solsikkegade 7", restaurant_city: "2200 København N",
  };
  mapImpl = () => Promise.resolve({ status: 200, data: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }) });
  scheduleImpl = () => ok({
    shifts: [
      { id: "sh-1", date: SHIFT_DAY, start_time: "16:00", end_time: "22:30", status: "published", net_hours: 6.5, role_on_shift: "Bar" },
      { id: "sh-2", date: inDays(3), start_time: "10:00", end_time: "15:00", status: "published", net_hours: 5 },
    ],
  });
});

describe("Meld syg — two taps from home, two ways, one form", () => {
  it("is no longer a pill under the confirm strip", async () => {
    await mount("da");
    // The confirm strip says one thing now.
    const seen = screen.getByRole("button", { name: /Jeg har set det/ });
    expect(seen.parentElement.textContent).not.toContain("Meld syg");
  });

  // scrollIntoView is not in jsdom: record who asked to be shown, and how.
  let scrolled;
  const origScroll = Element.prototype.scrollIntoView;
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function scrollIntoView(opts) { scrolled.push({ el: this, opts }); };
  });
  afterEach(() => { Element.prototype.scrollIntoView = origScroll; });

  it("⋯ menu → Meld syg opens the form ON THAT SHIFT'S DAY under the card and posts /sick-call", async () => {
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    // The full map credit lives in the sheet.
    expect(sheet.textContent).toContain("Kort: Klimadatastyrelsen, Skærmkort (CC BY 4.0) · OpenFreeMap · OpenMapTiles · © OpenStreetMap-bidragydere. Farver ændret af BonBox.");
    fireEvent.click(within(sheet).getByTestId("portal-menu-sick"));
    expect(screen.queryByTestId("portal-shift-menu")).toBeNull();

    const form = await screen.findByTestId("portal-sick-from-menu");
    // The menu belongs to tomorrow's shift: the form says tomorrow, not today,
    // so a straight "Send" reports the right day.
    expect(within(form).getByDisplayValue(SHIFT_DAY)).toBeInTheDocument();
    // The whole form is brought into view, its end above the tab bar.
    await waitFor(() => expect(scrolled.some((c) => c.el === form && c.opts?.block === "end")).toBe(true));
    await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Send sygemelding" })); });
    await waitFor(() => expect(sickPosts()).toHaveLength(1));
    expect(sickPosts()[0][1]).toMatchObject({ date: SHIFT_DAY, schedule_id: "sh-1" });
  });

  it("'Brug for en ændring?' → Meld syg opens the same form at the end of the week and posts /sick-call", async () => {
    await mount("da");
    const section = screen.getByTestId("portal-need-change");
    expect(within(section).getByText("Brug for en ændring?")).toBeInTheDocument();
    expect(within(section).getByText("Byt en vagt")).toBeInTheDocument();
    fireEvent.click(within(section).getByText("Meld syg").closest("button"));

    const form = await screen.findByTestId("portal-sick-from-week");
    expect(within(form).getByText("Meld dig syg")).toBeInTheDocument();
    // It scrolls into view too (it used to open below the bar, unscrolled).
    await waitFor(() => expect(scrolled.some((c) => c.el === form && c.opts?.block === "end")).toBe(true));
    await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Send sygemelding" })); });
    await waitFor(() => expect(sickPosts()).toHaveLength(1));
    // Vagtplan 1.6 (ported for 1.7): with no shift today the form starts on
    // the next shift's day (tomorrow here), the day the staffer would miss —
    // not today, a day off (utils/sickCallDefaultDate.js).
    expect(sickPosts()[0][1]).toMatchObject({ date: SHIFT_DAY });
  });

  it("the scroller pads for the sticky header and the floating bar, so scrolled-to things land between them", async () => {
    await mount("da");
    const scroller = screen.getByTestId("portal-header-row").closest(".scrollable");
    // The dock: 52 tall + its 8 px lift over the safe area + 16 of air;
    // header 56 + 12.
    expect(scroller.style.scrollPaddingBottom).toContain("76px");
    expect(scroller.style.scrollPaddingBottom).toContain("safe-area-inset-bottom");
    expect(scroller.style.scrollPaddingTop).toContain("68px");
  });

  it("'Byt en vagt' and the menu's 'Byt eller giv væk' both land on Bytte", async () => {
    await mount("da");
    fireEvent.click(within(screen.getByTestId("portal-need-change")).getByText("Byt en vagt").closest("button"));
    await waitFor(() => expect(document.querySelector("h1").textContent).toBe(da.portalTitleSwaps));

    fireEvent.click(within(document.querySelector("nav")).getByText("Vagtplan").closest("button"));
    fireEvent.click(await screen.findByRole("button", { name: "Flere valg for vagten" }));
    fireEvent.click(within(await screen.findByTestId("portal-shift-menu")).getByTestId("portal-menu-swaps"));
    await waitFor(() => expect(document.querySelector("h1").textContent).toBe(da.portalTitleSwaps));
  });
});

describe("Stempl ind — on the card only when the shift is close", () => {
  it("a shift tomorrow: no punch button on the card; it is the ⋯ menu's first row, with the 'no shift right now' confirm", async () => {
    await mount("da");
    const hero = screen.getByTestId("portal-hero");
    expect(within(hero).queryByRole("button", { name: /Stempl ind/ })).toBeNull();
    // The card's one brass action is "Jeg har set det" then; Rute is the
    // cream-hairline ghost beside it (canvas).
    expect(within(hero).getByRole("button", { name: /Jeg har set det/ }).style.background).toBe("rgb(200, 164, 100)");
    expect(screen.getByTestId("portal-route").style.background).toBe("rgba(243, 239, 228, 0.06)");

    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    const rows = sheet.querySelectorAll("[data-testid^='portal-menu-']");
    expect(rows[0].getAttribute("data-testid")).toBe("portal-menu-clock-in");
    expect(rows[0].textContent).toContain("Stempl ind");
    fireEvent.click(rows[0]);
    expect(screen.queryByTestId("portal-shift-menu")).toBeNull();
    expect(await screen.findByText(da.portalPunchNoShiftTitle)).toBeInTheDocument();
  });

  it("a shift starting now: Stempl ind on the card, and Rute steps back to a ghost", async () => {
    // Midday, so "now + 3 h" never wraps past midnight (only Date is faked).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 12, 12, 0, 0));
    try {
      scheduleImpl = () => ok({
        shifts: [{ id: "now", date: inDays(0), start_time: "12:00", end_time: "15:00", status: "published", net_hours: 3 }],
      });
      await mount("da");
      const hero = screen.getByTestId("portal-hero");
      // Stempl ind IS the brass action now; Rute stays the ghost beside it.
      expect(within(hero).getByRole("button", { name: /Stempl ind/ }).style.background).toBe("rgb(200, 164, 100)");
      expect(within(hero).queryByRole("button", { name: /Jeg har set det/ })).toBeNull();
      expect(screen.getByTestId("portal-route").style.background).toBe("rgba(243, 239, 228, 0.06)");
      fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
      expect(within(await screen.findByTestId("portal-shift-menu")).queryByTestId("portal-menu-clock-in")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Floating tab bar (the dock: five named tabs, one sliding pill)", () => {
  afterEach(() => { delete window.matchMedia; });

  it("five equal columns, every tab named; a label can only ellipsize, never push a tab out", async () => {
    await mount("en");
    const nav = screen.getByTestId("portal-tabbar-v3");
    expect(nav.style.gridTemplateColumns).toMatch(/^repeat\(5, minmax\(0(px)?, 1fr\)\)$/);
    const tabs = within(nav).getAllByRole("button");
    // (digits stripped: Messages carries its unread count)
    expect(tabs.map((b) => b.textContent.replace(/\d+/g, ""))).toEqual(["Schedule", "Time off", "Messages", "Swaps", "Hours"]);
    for (const b of tabs) {
      const label = [...b.querySelectorAll("span")].pop();
      expect(label.style.textOverflow).toBe("ellipsis");
      expect(label.style.whiteSpace).toBe("nowrap");
    }
  });

  it("under 360 px nothing is hidden: the active tab keeps its name (the bar fits 320)", async () => {
    window.matchMedia = (q) => ({ matches: q === "(max-width: 359px)", addEventListener: () => {}, removeEventListener: () => {} });
    await mount("da");
    const active = within(screen.getByTestId("portal-tabbar-v3")).getAllByRole("button")
      .find((b) => b.getAttribute("aria-current") === "page");
    expect(active.textContent).toBe("Vagtplan");
    expect(active.querySelector(".sr-only")).toBeNull();
  });

  it("has 5 tabs in the canvas's words; the active one is marked and the ONE sliding pill sits on it", async () => {
    await mount("da");
    const nav = screen.getByTestId("portal-tabbar-v3");
    const tabs = within(nav).getAllByRole("button");
    expect(tabs).toHaveLength(5);
    expect(tabs.map((b) => b.textContent.replace(/\d+/g, ""))).toEqual(["Vagtplan", "Fravær", "Beskeder", "Byt", "Timer"]);
    const active = tabs.filter((b) => b.getAttribute("aria-current") === "page");
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("Vagtplan");
    // The Orvexlo dock (vagtplan.css): one indicator for the whole bar, at
    // the active column — no per-tab pill.
    expect(nav.className).toContain("vp-dock");
    const pills = nav.querySelectorAll(".vp-dock-ind");
    expect(pills).toHaveLength(1);
    expect(pills[0].style.getPropertyValue("--i")).toBe("0");
    // A count stays on Beskeder.
    expect(within(nav).getByText("Beskeder").closest("button").textContent).toContain("2");
    // The old ivory glass bar (inline 90 % + blur, radius 24) is gone.
    expect(nav.style.background).toBe("");
    expect(nav.style.borderRadius).toBe("");
  });
});

describe("Header — one row", () => {
  it("small round controls are circles on a touch screen (no 44 px min-height stretch)", async () => {
    await mount("da");
    const row = screen.getByTestId("portal-header-row");
    expect(screen.getByTitle("Rediger profil").style.minHeight).toMatch(/^0(px)?$/);
    expect(within(row).getByRole("button", { name: da.navAlerts }).style.minHeight).toMatch(/^0(px)?$/);
    expect(screen.getByRole("button", { name: "Flere valg for vagten" }).style.minHeight).toMatch(/^0(px)?$/);
    const rute = screen.getByTestId("portal-route");
    expect([rute.style.height, rute.style.borderRadius]).toEqual(["48px", "14px"]);
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    expect(within(sheet).getAllByRole("button", { name: "Luk" }).some((b) => /^0(px)?$/.test(b.style.minHeight))).toBe(true);
  });

  it("has no venue line and no always-on Live/Synket word; the venue moved into the card", async () => {
    await mount("da");
    const row = screen.getByTestId("portal-header-row");
    expect(row.textContent).not.toContain("Café Solsikke");
    expect(row.textContent).not.toContain("Synket");
    expect(row.textContent).not.toMatch(/\bLive\b/);
    const place = screen.getByTestId("portal-hero-place");
    expect(place.textContent).toContain("Café Solsikke");
    expect(place.textContent).toContain("Solsikkegade 7, 2200 København N");
  });

  it("hides the location chip for someone who works in one place", async () => {
    scheduleImpl = () => ok({
      shifts: [{ id: "b1", date: SHIFT_DAY, start_time: "16:00", end_time: "22:00", status: "published", net_hours: 6, branch_name: "Vesterbro" }],
    });
    await mount("da");
    expect(screen.queryByRole("button", { name: da.portalDepartment })).toBeNull();
  });
});

describe("Offline / stale strip", () => {
  afterEach(() => vi.useRealTimers());

  it("appears after 45 s without a fresh answer (and no live stream), then clears on the next answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount("da");
    expect(screen.queryByTestId("portal-offline-strip")).toBeNull();

    // The server stops answering: the 20 s poll fails, lastSynced ages.
    scheduleImpl = () => reject(503);
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(screen.queryByTestId("portal-offline-strip")).toBeNull(); // 30 s: not yet
    await act(async () => { vi.advanceTimersByTime(30000); });
    const strip = await screen.findByTestId("portal-offline-strip");
    expect(strip.textContent).toContain("Ikke opdateret – viser sidst hentede");
    // A slim strip: its button does not stretch it to the 44 px touch height.
    expect(within(strip).getByRole("button", { name: "Opdater" }).style.minHeight).toMatch(/^0(px)?$/);

    // It answers again: Opdater refetches and the strip goes.
    scheduleImpl = () => ok({ shifts: [] });
    await act(async () => { fireEvent.click(within(strip).getByRole("button", { name: "Opdater" })); });
    await waitFor(() => expect(screen.queryByTestId("portal-offline-strip")).toBeNull());
  });
});

describe("Flat forest", () => {
  it("the next-shift card is one flat colour — no gradient, no bloom, no sheen", async () => {
    await mount("da");
    const hero = screen.getByTestId("portal-hero");
    // The canvas's pine.
    expect(hero.style.background).toBe("rgb(14, 59, 46)");
    expect(hero.innerHTML).not.toMatch(/gradient|heroSheen|heroLiveDot/);
    // Role is a dot plus its name now, not a left bar.
    expect(screen.getByTestId("portal-hero-meta").textContent).toContain("Bar");
  });

  it("the PIN card is the same flat forest", async () => {
    info = { has_pin: true, pin_ok: false, staff_name: "Freja M.", restaurant_name: "Café Solsikke" };
    renderPage("da");
    const card = await screen.findByTestId("portal-pin-card");
    expect(card.style.background).toBe("rgb(14, 59, 46)");
    expect(card.innerHTML).not.toMatch(/gradient/);
  });
});

describe("Rute — the right map app per platform, only on a tap", () => {
  const venue = { lat: 55.6872, lng: 12.5532, name: "Café Solsikke", address: "Solsikkegade 7, 2200 København N" };

  it("builds Apple / geo: / Google URLs from the confirmed pin", () => {
    expect(routeUrl(venue, "apple")).toBe("https://maps.apple.com/?daddr=55.6872,12.5532&q=Caf%C3%A9%20Solsikke");
    expect(routeUrl(venue, "geo")).toBe("geo:0,0?q=55.6872,12.5532(Caf%C3%A9%20Solsikke)");
    expect(routeUrl(venue, "google")).toBe("https://www.google.com/maps/search/?api=1&query=55.6872,12.5532");
  });

  it("falls back to the address when no pin is confirmed, and to nothing when there is no place", () => {
    const noPin = { ...venue, lat: null, lng: null };
    expect(routeUrl(noPin, "apple")).toBe("https://maps.apple.com/?daddr=Solsikkegade%207%2C%202200%20K%C3%B8benhavn%20N");
    expect(routeUrl(noPin, "geo")).toBe("geo:0,0?q=Solsikkegade%207%2C%202200%20K%C3%B8benhavn%20N");
    expect(routeUrl(noPin, "google")).toBe("https://www.google.com/maps/search/?api=1&query=Solsikkegade%207%2C%202200%20K%C3%B8benhavn%20N");
    expect(routeUrl({ name: "", address: "" }, "google")).toBeNull();
  });

  it("with no street the address names a town: Rute searches the place's name there", () => {
    const townOnly = { name: "Café Solsikke", address: "2200 København N", street: "" };
    expect(routeUrl(townOnly, "google")).toBe("https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20Solsikke%2C%202200%20K%C3%B8benhavn%20N");
    expect(routeUrl(townOnly, "apple")).toBe("https://maps.apple.com/?daddr=Caf%C3%A9%20Solsikke%2C%202200%20K%C3%B8benhavn%20N");
    // A location with no address: the venue + location name in the venue's town.
    const branch = { name: "Café Solsikke Hovedafdeling", address: "", street: "", town: "København N" };
    expect(routeUrl(branch, "google")).toBe("https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20Solsikke%20Hovedafdeling%2C%20K%C3%B8benhavn%20N");
    // A pin still wins over all of it.
    expect(routeUrl({ ...townOnly, lat: 55.6872, lng: 12.5532 }, "google")).toBe("https://www.google.com/maps/search/?api=1&query=55.6872,12.5532");
    // With a street, the address as it is (callers that do not say keep that too).
    expect(routeUrl({ name: "X", address: "Solsikkegade 7, 2200 København N", street: "Solsikkegade 7" }, "google"))
      .toBe(routeUrl({ name: "X", address: "Solsikkegade 7, 2200 København N" }, "google"));
  });

  it("on the card: a venue with only a postcode and town, and a location with no address", async () => {
    info = { ...info, restaurant_address: null, restaurant_city: "København N", venue: { name: "Café Solsikke", address_line: "2200 København N", has_map: false, lat: null, lng: null } };
    await mount("da");
    expect(screen.getByTestId("portal-route").getAttribute("href")).toContain("Solsikke%2C%202200%20K%C3%B8benhavn%20N");
    cleanup();
    scheduleImpl = () => ok({
      shifts: [{ id: "b1", date: SHIFT_DAY, start_time: "16:00", end_time: "22:00", status: "published", net_hours: 6, branch_name: "Hovedafdeling" }],
    });
    await mount("da");
    const href = screen.getByTestId("portal-route").getAttribute("href");
    expect(href).toContain("Solsikke%20Hovedafdeling%2C%20K%C3%B8benhavn%20N");
    expect(href).not.toMatch(/(daddr|query|q)=Hovedafdeling(&|$)/);
  });

  it("detects the platform from the browser when not in the native shell", () => {
    expect(routePlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("apple");
    expect(routePlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("geo");
    expect(routePlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("google");
  });

  it("the card's Rute button carries the venue, labelled for screen readers", async () => {
    await mount("da");
    const rute = screen.getByTestId("portal-route");
    expect(rute.textContent).toContain("Rute");
    expect(rute.getAttribute("aria-label")).toBe("Rute til Café Solsikke");
    expect(rute.getAttribute("href")).toContain("Solsikkegade%207");
    expect(rute.getAttribute("target")).toBe("_blank");
  });
});

describe("Venue map on the card (R2)", () => {
  const VENUE = { name: "Café Solsikke", address_line: "Solsikkegade 7, 2200 København N", has_map: true, lat: 55.6872, lng: 12.5532, map_v: "aaaa1111" };
  // jsdom has no object URLs; the stubs stay for the file (unmount revokes).
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:venue-map");
    URL.revokeObjectURL = vi.fn();
  });
  const mapCalls = () => get.mock.calls.filter(([u]) => u.startsWith(`/portal/${TOK}/venue-map`));

  it("shows the server-drawn map for a confirmed pin, fetched as a blob, and Rute uses the pin", async () => {
    info = { ...info, venue: VENUE };
    await mount("da");
    const map = await screen.findByTestId("portal-venue-map");
    expect(map.querySelector("img").getAttribute("src")).toBe("blob:venue-map");
    expect(map.querySelector("img").getAttribute("alt")).toBe("Kort over Café Solsikke");
    expect(mapCalls()).toHaveLength(1);
    // The card's width on the server's 16 px grid, 96 tall, and the pin's version.
    // The staff card asks for the canvas's dark pine map.
    expect(mapCalls()[0][0]).toMatch(/\?w=\d+&h=96&dpr=[23]&v=aaaa1111&style=pine$/);
    const w = Number(mapCalls()[0][0].match(/w=(\d+)/)[1]);
    expect(w % 16).toBe(0);
    expect(w >= 256 && w <= 448).toBe(true);
    expect(mapCalls()[0][1]).toEqual({ responseType: "blob" });
    // Right-anchored: any extra width is cut from the left, never from the
    // "© OpenStreetMap" corner.
    expect(map.querySelector("img").style.objectPosition).toBe("right center");
    // The confirmed pin, not the address text.
    expect(screen.getByTestId("portal-route").getAttribute("href")).toContain("55.6872,12.5532");
    expect(screen.getByTestId("portal-hero-place").textContent).toContain("Solsikkegade 7, 2200 København N");
  });

  it("no confirmed pin: no request, no map — the address and Rute still work", async () => {
    info = { ...info, venue: { ...VENUE, has_map: false, lat: null, lng: null } };
    await mount("da");
    expect(mapCalls()).toHaveLength(0);
    expect(screen.queryByTestId("portal-venue-map")).toBeNull();
    expect(screen.getByTestId("portal-route").getAttribute("href")).toContain("Solsikkegade%207");
  });

  it("a 204 or a failed request leaves no map — never a broken image", async () => {
    info = { ...info, venue: VENUE };
    mapImpl = () => Promise.resolve({ status: 204, data: new Blob([]) });
    await mount("da");
    await waitFor(() => expect(mapCalls()).toHaveLength(1));
    expect(screen.queryByTestId("portal-venue-map")).toBeNull();
  });

  it("an image that will not decode is removed", async () => {
    info = { ...info, venue: VENUE };
    await mount("da");
    const img = (await screen.findByTestId("portal-venue-map")).querySelector("img");
    fireEvent.error(img);
    await waitFor(() => expect(screen.queryByTestId("portal-venue-map")).toBeNull());
  });

  it("the map's place is held from the first paint: no card growth when the image arrives", async () => {
    info = { ...info, venue: VENUE };
    let deliver;
    mapImpl = () => new Promise((res) => { deliver = res; });
    await mount("da");
    const block = screen.getByTestId("portal-venue-map");
    expect(block.style.height).toBe("96px");
    expect(block.querySelector("img")).toBeNull();
    // The request goes out from the map block's effect; under a loaded suite
    // that can land a tick after the card first paints. Wait for it.
    await waitFor(() => expect(typeof deliver).toBe("function"));
    await act(async () => { deliver({ status: 200, data: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }) }); });
    const img = screen.getByTestId("portal-venue-map").querySelector("img");
    expect(img).not.toBeNull();
    expect(screen.getByTestId("portal-venue-map").style.height).toBe("96px");
    // It fades in over the ground colour once decoded.
    expect(img.style.opacity).toBe("0");
    fireEvent.load(img);
    expect(img.style.opacity).toBe("1");
  });

  it("a tab switch paints the kept image at once — no second request, no growth", async () => {
    info = { ...info, venue: VENUE };
    await mount("da");
    await screen.findByTestId("portal-venue-map");
    await waitFor(() => expect(screen.getByTestId("portal-venue-map").querySelector("img")).not.toBeNull());
    fireEvent.click(screen.getByTestId("portal-tab-hours"));
    expect(screen.queryByTestId("portal-venue-map")).toBeNull();
    fireEvent.click(screen.getByTestId("portal-tab-schedule"));
    const img = screen.getByTestId("portal-venue-map").querySelector("img");
    expect(img).not.toBeNull();
    expect(img.style.opacity).toBe("1");
    expect(mapCalls()).toHaveLength(1);
  });

  // Android 14 walk (11 Nov 2026): at 412 px the viewport estimate and the
  // measured width differed; each answer evicted the other size and the card
  // went blank — an empty pine box — on every other remount.
  // Edited 12 Nov 2026 (review of 4724866a): these cases mocked the
  // emulator's pointer: fine layout (vw − 76: its shell shows an 8 px
  // scrollbar) as if it were a phone's. A touch phone (iPhone, Android) shows
  // no scrollbar: the block is vw − 68, or vw − 60 at 360 px and below (16 /
  // 12 px page gutters + 18 px card padding, each side). The pointer: fine
  // layout keeps its own case below.
  const touchPhone = (vw) => Math.min(vw, 512) - (vw <= 360 ? 60 : 68);
  for (const [vw, asked] of [[412, 352], [390, 336], [360, 304]]) {
    it(`touch phone at ${vw} px: ONE request, and the map on the card after every remount`, async () => {
      const realVW = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: vw });
      // jsdom has no layout: the map block measures what the phone measured.
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get() { return this.getAttribute?.("data-testid") === "portal-venue-map" ? touchPhone(vw) : 0; },
      });
      try {
        info = { ...info, venue: VENUE };
        await mount("da");
        await waitFor(() => expect(screen.getByTestId("portal-venue-map").querySelector("img")).not.toBeNull());
        for (let i = 0; i < 2; i += 1) {
          fireEvent.click(screen.getByTestId("portal-tab-hours"));
          expect(screen.queryByTestId("portal-venue-map")).toBeNull();
          fireEvent.click(screen.getByTestId("portal-tab-schedule"));
          // Painted from memory in the same frame…
          const img = screen.getByTestId("portal-venue-map").querySelector("img");
          expect(img).not.toBeNull();
          expect(img.style.opacity).toBe("1");
          // …and still there once every answer is in and the card re-renders.
          await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
          // (Opening and closing the ⋯ sheet re-renders the card.)
          fireEvent.click(screen.getByTestId("portal-shift-menu-btn"));
          expect(screen.getByTestId("portal-venue-map").querySelector("img")).not.toBeNull();
          fireEvent.keyDown(document, { key: "Escape" });
          await waitFor(() => expect(screen.queryByTestId("portal-shift-menu")).toBeNull());
          expect(screen.getByTestId("portal-venue-map").querySelector("img")).not.toBeNull();
        }
        expect(mapCalls()).toHaveLength(1);
        expect(mapCalls()[0][0]).toContain(`?w=${asked}&`);
      } finally {
        delete HTMLElement.prototype.clientWidth;
        Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: realVW });
      }
    });
  }

  // A screen with a scrollbar beside the page (pointer: fine — a desktop
  // browser at phone width, the Android 14 emulator): the block is vw − 76,
  // 8 px narrower than the estimate. The card asks ONLY for the width it
  // measured (one request, never the estimate's), and the map is on the card
  // after every remount — never an empty pine box.
  it("pointer: fine at 412 px (vw − 76): ONE request, for the measured width; never blank", async () => {
    const realVW = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 412 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() { return this.getAttribute?.("data-testid") === "portal-venue-map" ? 412 - 76 : 0; },
    });
    try {
      info = { ...info, venue: VENUE };
      await mount("da");
      await waitFor(() => expect(screen.getByTestId("portal-venue-map").querySelector("img")).not.toBeNull());
      // Let any second request that would have gone out go out.
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(mapCalls()).toHaveLength(1);
      expect(mapCalls()[0][0]).toContain("?w=336&");
      for (let i = 0; i < 2; i += 1) {
        fireEvent.click(screen.getByTestId("portal-tab-hours"));
        fireEvent.click(screen.getByTestId("portal-tab-schedule"));
        // The kept image is on the card at once (it settles in again once
        // decoded, since the first render guessed the other width)…
        const img = screen.getByTestId("portal-venue-map").querySelector("img");
        expect(img).not.toBeNull();
        expect(img.getAttribute("src")).toBe("blob:venue-map");
        fireEvent.load(img);
        expect(img.style.opacity).toBe("1");
        // …and stays there once every answer is in.
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        expect(screen.getByTestId("portal-venue-map").querySelector("img")).not.toBeNull();
      }
      expect(mapCalls()).toHaveLength(1);
    } finally {
      delete HTMLElement.prototype.clientWidth;
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: realVW });
    }
  });

  it("the map URL changes when the pin moves, so no cache can show the old place", async () => {
    info = { ...info, venue: VENUE };
    await mount("da");
    await waitFor(() => expect(mapCalls()).toHaveLength(1));
    expect(mapCalls()[0][0]).toContain("v=aaaa1111");
    cleanup();
    info = { ...info, venue: { ...VENUE, lat: 55.69, lng: 12.56, map_v: "bbbb2222" } };
    await mount("da");
    await waitFor(() => expect(mapCalls()).toHaveLength(2));
    expect(mapCalls()[1][0]).toContain("v=bbbb2222");
    expect(mapCalls()[1][0]).not.toBe(mapCalls()[0][0]);
    expect(screen.getByTestId("portal-route").getAttribute("href")).toContain("55.69,12.56");
  });

  it("a shift at another location never shows the venue's map", async () => {
    info = { ...info, venue: VENUE };
    scheduleImpl = () => ok({
      shifts: [{ id: "b1", date: SHIFT_DAY, start_time: "16:00", end_time: "22:00", status: "published", net_hours: 6, branch_name: "Vesterbro", branch_address: "Istedgade 1" }],
    });
    await mount("da");
    expect(screen.queryByTestId("portal-venue-map")).toBeNull();
    expect(mapCalls()).toHaveLength(0);
    expect(screen.getByTestId("portal-hero-place").textContent).toContain("Vesterbro");
    expect(screen.getByTestId("portal-route").getAttribute("href")).toContain("Istedgade");
  });
});

describe("Words", () => {
  it("EN location switcher says Location; DA keeps Afdeling", () => {
    expect(en.portalDepartment).toBe("Location");
    expect(da.portalDepartment).toBe("Afdeling");
  });
  it("every new home-v3 key has real en + da", () => {
    for (const k of [
      "portalShiftMenu", "portalRoute", "portalRouteTo", "portalRouteHint", "portalWhosOnRow",
      "portalSwapOrGive", "portalNeedChangeTitle", "portalSickRowHint", "portalSwapAShift",
      "portalMapCredit", "portalOfflineStrip", "portalStaleStrip", "portalOfflineRefresh",
      "portalTabsLabel", "portalCalendarTappedHint",
    ]) {
      expect(typeof en[k] === "string" && en[k].length > 0, `en.${k}`).toBe(true);
      expect(typeof da[k] === "string" && da[k].length > 0, `da.${k}`).toBe(true);
      expect(da[k], `da.${k} is not just the English`).not.toBe(en[k] === "Offline" ? "" : en[k]);
    }
  });
});
