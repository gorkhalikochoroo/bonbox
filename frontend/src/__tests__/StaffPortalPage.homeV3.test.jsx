/**
 * Vagtplan home v3 (R1, Nov 2026) — pinned on the REAL page against a mocked
 * portalApi.
 *
 *   • Meld syg MOVED, never removed: the Play listing promises it. It is
 *     reachable two ways — the next-shift card's ⋯ menu, and the "Brug for en
 *     ændring?" section at the end of the week list — and BOTH open the same
 *     SickCallButton form that posts /portal/{token}/sick-call.
 *   • The floating tab bar: 5 tabs, aria-current on the active one, whose
 *     name is visible; the others are icons with their names for screen
 *     readers.
 *   • The header is one row: no venue line, no always-on Live/Synket word.
 *   • The amber strip speaks only when offline, or when the data is more than
 *     45 s old with no live stream.
 *   • The next-shift card and the PIN card are flat forest (no gradient).
 *   • Rute goes to Apple Maps / geo: / Google per platform.
 *   • EN location switcher says "Location", not "Department".
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../i18n/en";
import { da } from "../i18n/da";
import { routeUrl, routePlatform } from "../utils/routeUrl";

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
  return ok([]);
});

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
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

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
  get.mockClear();
  post.mockClear();
  info = {
    has_pin: false, staff_name: "Freja M.", role: "bartender",
    restaurant_name: "Café Solsikke", restaurant_address: "Solsikkegade 7", restaurant_city: "2200 København N",
  };
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

  it("⋯ menu → Meld syg opens the sick-call form under the card and posts /sick-call", async () => {
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    // The full map credit lives in the sheet.
    expect(sheet.textContent).toContain("Kort: OpenFreeMap · OpenMapTiles · © OpenStreetMap-bidragydere");
    fireEvent.click(within(sheet).getByTestId("portal-menu-sick"));
    expect(screen.queryByTestId("portal-shift-menu")).toBeNull();

    const form = await screen.findByTestId("portal-sick-from-menu");
    // Defaults to today; pick the shift day so the shift id rides along.
    fireEvent.change(within(form).getByDisplayValue(inDays(0)), { target: { value: SHIFT_DAY } });
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
    await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Send sygemelding" })); });
    await waitFor(() => expect(sickPosts()).toHaveLength(1));
    expect(sickPosts()[0][1]).toMatchObject({ date: inDays(0) });
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

describe("Floating tab bar", () => {
  it("has 5 tabs; the active one is marked and named, the rest are icons named for screen readers", async () => {
    await mount("da");
    const nav = screen.getByTestId("portal-tabbar-v3");
    const tabs = within(nav).getAllByRole("button");
    expect(tabs).toHaveLength(5);
    const active = tabs.filter((b) => b.getAttribute("aria-current") === "page");
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain("Vagtplan");
    expect(active[0].querySelector(".sr-only")).toBeNull();
    for (const b of tabs.filter((x) => x !== active[0])) {
      expect(b.querySelector(".sr-only")).not.toBeNull();
    }
    // A red count stays on Beskeder.
    expect(within(nav).getByText("Beskeder").closest("button").textContent).toContain("2");
    // Forest pill, not glass.
    expect(nav.style.background).toBe("rgb(9, 58, 38)");
    expect(nav.style.borderRadius).toBe("31px");
  });
});

describe("Header — one row", () => {
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
    expect(hero.style.background).toBe("rgb(9, 58, 38)");
    expect(hero.innerHTML).not.toMatch(/gradient|heroSheen|heroLiveDot/);
    // Role is a dot plus its name now, not a left bar.
    expect(screen.getByTestId("portal-hero-meta").textContent).toContain("Bar");
  });

  it("the PIN card is the same flat forest", async () => {
    info = { has_pin: true, pin_ok: false, staff_name: "Freja M.", restaurant_name: "Café Solsikke" };
    renderPage("da");
    const card = await screen.findByTestId("portal-pin-card");
    expect(card.style.background).toBe("rgb(9, 58, 38)");
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
