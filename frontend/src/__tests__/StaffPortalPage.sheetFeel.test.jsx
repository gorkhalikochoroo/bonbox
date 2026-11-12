/**
 * Premium feel 1.5 — sheets with weight, on the REAL portal page against a
 * mocked portalApi (the hook itself is pinned in sheetDrag.test.jsx, the CSS
 * in vagtplanMotionKit.test.jsx).
 *
 *   • Every sheet is one shape: a data-vp-overlay root, the scrim BESIDE the
 *     sheet (never its parent, so fading it never fades the sheet), the sheet
 *     on top; no blur behind it (call D); one scrim colour; one grabber.
 *   • A pull down closes a sheet through its own close: the docs sheet (its
 *     section mounted before it opens), the ⋯ sheet, the profile sheet from
 *     its sticky header even when scrolled, the new-group sheet on a phone.
 *     A drag never starts on a control or under scrolled content.
 *   • A reopen right after a throw shows the sheet again (data-dragged-out
 *     cleared). Reduce motion: the pull still closes, at once.
 *   • Android BACK clicks the new child scrim: the top sheet closes, the one
 *     under it stays.
 *   • The wide new-group sheet is a centred dialog: no floor shadow, no drag.
 *   • A pull inside a sheet that lives in the page's scroller (Timer, Beskeder,
 *     Fravær) never also arms the page's pull-to-refresh.
 *
 * jsdom has no TouchEvent and no layout: plain events carry `touches` and a
 * `timeStamp` (as the pull-to-refresh test does); a sheet is given a height;
 * requestAnimationFrame is a queue the test flushes.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVenueMapCache } from "../utils/venueMapImage";
import { findBackTarget } from "../utils/androidBack";

const TOK = "toksheet";
const ok = (data) => Promise.resolve({ data });
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};
const SHIFT_DAY = inDays(1);
let info;
const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) return ok(info);
  if (url.startsWith(`/portal/${TOK}/schedule`)) {
    return ok({ shifts: [{ id: "sh-1", date: SHIFT_DAY, start_time: "16:00", end_time: "22:30", status: "published", net_hours: 6.5 }] });
  }
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) return ok([]);
  if (url.startsWith(`/portal/${TOK}/hours`)) {
    return ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 12.5, entries: [] });
  }
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  if (url.includes("/chat/threads")) return ok({ threads: [] });
  return ok([]);
});

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(() => ok({})), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" } },
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
// Fix round (PLAT-2): the other language is fetched when the profile sheet
// opens, not at boot. A spy stands in for the loader (lib/localePreload is
// pinned in localePreload.test.js).
const preload = vi.hoisted(() => ({ fn: null }));
vi.mock("../lib/localePreload", () => {
  preload.fn = vi.fn(() => () => {});
  return { preloadLocalesWhenIdle: (...a) => preload.fn(...a) };
});

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

async function mount() {
  localStorage.setItem("lang", "da");
  render(
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
  await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId("portal-hero-meta")).toBeInTheDocument());
}

/** A browser that answers the motion query (and, if asked, says the screen is wide). */
function motionPref({ reduce, wide = false }) {
  window.matchMedia = (q) => ({
    matches: q === "(prefers-reduced-motion: reduce)" ? reduce : q === "(min-width: 640px)" ? wide : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}

// requestAnimationFrame as a queue: the hook writes once per frame.
let frames = new Map();
let nextId = 1;
const realRaf = window.requestAnimationFrame;
const realCaf = window.cancelAnimationFrame;
const flush = () => { const f = [...frames.values()]; frames = new Map(); f.forEach((cb) => cb(0)); };

let ts = 1000;
function touch(el, type, y, dt = 16) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.touches = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: 50, clientY: y }];
  ts += dt;
  Object.defineProperty(e, "timeStamp", { value: ts });
  act(() => { el.dispatchEvent(e); });
  return e;
}
/** A slow pull from `el` (inside the sheet) down `dy` px, then the finger lifts. */
function pull(el, dy, { lift = true } = {}) {
  touch(el, "touchstart", 100, 0);
  touch(el, "touchmove", 108);                  // clearly down, 8 px: engaged
  for (let d = 20; d <= dy; d += 20) touch(el, "touchmove", 108 + d, 100);   // 0.2 px/ms: slow
  act(() => { flush(); });
  if (lift) touch(el, "touchend", 0);
}
const tall = (sheet, h = 400) => Object.defineProperty(sheet, "offsetHeight", { configurable: true, value: h });
const overlayOf = (sheet) => sheet.closest("[data-vp-overlay]");

beforeEach(() => {
  localStorage.clear();
  clearVenueMapCache();
  get.mockClear();
  info = {
    has_pin: false, staff_name: "Freja M.", role: "bartender",
    restaurant_name: "Café Solsikke", restaurant_address: "Solsikkegade 7", restaurant_city: "2200 København N",
  };
  frames = new Map();
  nextId = 1;
  window.requestAnimationFrame = (cb) => { const id = nextId++; frames.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  motionPref({ reduce: false });
});
afterEach(() => {
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCaf;
  delete window.matchMedia;
  document.body.classList.remove("portal-shell");
});

async function openProfile() {
  fireEvent.click(screen.getByTitle("Rediger profil"));
  const head = await screen.findByRole("heading", { name: "Rediger profil" });
  return { head, sheet: head.closest(".vp-sheet") };
}
async function openDocs() {
  await openProfile();
  const entry = await screen.findByText("Kontrakt og dokumenter");
  fireEvent.click(entry.closest("button"));
  return screen.findByRole("dialog", { name: "Kontrakt og dokumenter" });
}
async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
  return screen.findByTestId("portal-shift-menu");
}
const go = (name) => fireEvent.click(within(screen.getByTestId("portal-tabbar-v3")).getByText(name).closest("button"));

describe("One overlay shape: the scrim beside the sheet, no blur, one colour, one grabber", () => {
  const shapeOf = (sheet) => {
    const root = overlayOf(sheet);
    expect(root, "data-vp-overlay root").not.toBeNull();
    expect(getComputedStyle(root).position === "fixed" || root.className.includes("fixed")).toBe(true);
    const scrim = root.querySelector(":scope > .vp-scrim");
    expect(scrim, "a scrim that is a child of the root").not.toBeNull();
    expect(scrim.contains(sheet)).toBe(false);               // beside, never the parent
    expect(root.classList.contains("vp-scrim")).toBe(false);
    expect(scrim.style.background).toBe("rgba(8, 24, 18, 0.52)");
    expect(scrim.style.backdropFilter || "").toBe("");
    expect(scrim.className).not.toMatch(/backdrop-blur/);
    expect(sheet.className).toContain("vp-sheet");
    expect(sheet.className).toContain("relative");
    return { root, scrim };
  };
  const grabberOf = (sheet) => [...sheet.querySelectorAll("span[aria-hidden]")].find((s) => s.style.width === "36px" && s.style.height === "5px");

  it("the ⋯ sheet, the profile sheet, the docs sheet and the photo sheet", async () => {
    await mount();
    const menu = await openMenu();
    shapeOf(menu);
    expect(menu.style.boxShadow).toMatch(/^0px 64px 0px 0px #FFFEFB|^0 64px 0 0 #FFFEFB/i);
    expect(grabberOf(menu)).toBeTruthy();
    fireEvent.click(within(menu).getAllByRole("button", { name: "Luk" })[0]);
    await waitFor(() => expect(screen.queryByTestId("portal-shift-menu")).toBeNull());

    const docs = await openDocs();
    const { scrim } = shapeOf(docs);
    expect(scrim.getAttribute("aria-hidden")).toBe("true");
    expect(docs.style.boxShadow).toMatch(/64px/);
    expect(grabberOf(docs).style.background).toBe("rgb(217, 211, 197)");   // #D9D3C5, not the slate bar

    const profile = screen.getByRole("heading", { name: "Rediger profil" }).closest(".vp-sheet");
    const p = shapeOf(profile);
    expect(p.scrim.tagName).toBe("BUTTON");                  // a button scrim stays a button
    expect(profile.className).not.toContain("shadow-soft-lg");
    expect(profile.style.boxShadow).toMatch(/64px/);
    const head = screen.getByRole("heading", { name: "Rediger profil" }).parentElement;
    expect(head.hasAttribute("data-sheet-handle")).toBe(true);
    expect(grabberOf(head)).toBeTruthy();                     // the grabber is in the sticky header

    fireEvent.click(within(profile).getByRole("button", { name: "Tilføj billede" }));
    const photo = await screen.findByRole("dialog", { name: "Billede" });
    shapeOf(photo);
    expect(photo.style.boxShadow).toMatch(/64px/);
    expect(grabberOf(photo)).toBeTruthy();
    // The photo sheet pulls down too (mounted with the page, enabled by its presence).
    tall(photo);
    pull(within(photo).getAllByText("Billede")[0], 200);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Billede" })).toBeNull());
  });

  it("Timer's period sheet and Beskeder's new-group sheet", async () => {
    await mount();
    go("Timer");
    fireEvent.click(await screen.findByTestId("portal-hours-period"));
    const period = await screen.findByTestId("portal-period-sheet");
    shapeOf(period);
    expect(period.style.boxShadow).toMatch(/64px/);

    go("Beskeder");
    fireEvent.click(await screen.findByTestId("portal-chat-new-group"));
    const group = await screen.findByTestId("portal-new-group");
    shapeOf(group);
    expect(group.hasAttribute("data-sheet-dialog")).toBe(false);   // a phone: a sheet
    expect(group.style.boxShadow).toMatch(/64px/);
  });
});

describe("Pull down to close", () => {
  it("the docs sheet (its section was mounted before it opened): pulled half its height, it closes", async () => {
    await mount();
    const docs = await openDocs();
    tall(docs);
    const title = within(docs).getAllByText("Kontrakt og dokumenter")[0];
    pull(title, 200);
    const root = overlayOf(docs);
    expect(root.hasAttribute("data-dragged-out")).toBe(true);     // the CSS exit does not play twice
    expect(root.hasAttribute("data-closing")).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Kontrakt og dokumenter" })).toBeNull());
    // Only the docs sheet: the profile sheet under it stays.
    expect(screen.getByRole("heading", { name: "Rediger profil" })).toBeInTheDocument();
  });

  it("follows the finger 1:1 and fades the scrim; a pull short of 30 % springs back and stays open", async () => {
    await mount();
    const docs = await openDocs();
    tall(docs);
    const title = within(docs).getAllByText("Kontrakt og dokumenter")[0];
    pull(title, 80, { lift: false });
    expect(docs.style.transform).toBe("translateY(80px)");
    expect(Number(overlayOf(docs).querySelector(":scope > .vp-scrim").style.opacity)).toBeLessThan(1);
    touch(title, "touchend", 0);
    expect(docs.style.transform).toBe("");
    expect(overlayOf(docs).hasAttribute("data-closing")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Kontrakt og dokumenter" })).toBe(docs);
  });

  it("never from a control: a pull that starts on the docs sheet's Luk button moves nothing", async () => {
    await mount();
    const docs = await openDocs();
    tall(docs);
    const close = within(docs).getByRole("button", { name: "Luk" });
    pull(close, 200);
    expect(docs.style.transform).toBe("");
    expect(overlayOf(docs).hasAttribute("data-closing")).toBe(false);
  });

  it("the ⋯ sheet: from the title it closes; from a row it never drags (a row press must not become a drag)", async () => {
    await mount();
    let menu = await openMenu();
    tall(menu);
    pull(within(menu).getByTestId("portal-menu-sick"), 200);
    expect(menu.style.transform).toBe("");
    expect(overlayOf(menu).hasAttribute("data-closing")).toBe(false);

    const title = menu.querySelector(".tabular-nums");
    pull(title, 200);
    expect(overlayOf(menu).hasAttribute("data-dragged-out")).toBe(true);
    // Reopened at once (within the 240 ms exit): the same sheet rises again, nothing left over.
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    menu = screen.getByTestId("portal-shift-menu");
    expect(overlayOf(menu).hasAttribute("data-closing")).toBe(false);
    expect(overlayOf(menu).hasAttribute("data-dragged-out")).toBe(false);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(screen.getByTestId("portal-shift-menu")).toBeInTheDocument();
  });

  it("the profile sheet, scrolled: its content scrolls back first, its sticky header always grabs", async () => {
    await mount();
    const { head, sheet } = await openProfile();
    tall(sheet, 600);
    sheet.scrollTop = 120;
    pull(within(sheet).getByTestId("portal-profile-card").querySelector("div"), 300);
    expect(sheet.style.transform).toBe("");
    expect(overlayOf(sheet).hasAttribute("data-closing")).toBe(false);
    pull(head, 300);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Rediger profil" })).toBeNull());
  });

  it("reduce motion: the pull still closes, at once, and nothing is animated", async () => {
    motionPref({ reduce: true });
    await mount();
    const menu = await openMenu();
    tall(menu);
    menu.animate = vi.fn();
    pull(menu.querySelector(".tabular-nums"), 200);
    expect(screen.queryByTestId("portal-shift-menu")).toBeNull();
    expect(menu.animate).not.toHaveBeenCalled();
  });
});

describe("Android BACK and the new child scrim", () => {
  it("BACK's target is the top sheet's scrim (the docs sheet over the profile sheet); clicking it closes only that one", async () => {
    await mount();
    const docs = await openDocs();
    const target = findBackTarget(document, () => true);
    expect(target).toBe(overlayOf(docs).querySelector(":scope > .vp-scrim"));
    act(() => { target.click(); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Kontrakt og dokumenter" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Rediger profil" })).toBeInTheDocument();
  });
});

describe("The new-group sheet on a wide screen is a centred dialog", () => {
  it("640 px and wider: data-sheet-dialog, no floor shadow, no drag", async () => {
    motionPref({ reduce: false, wide: true });
    await mount();
    go("Beskeder");
    fireEvent.click(await screen.findByTestId("portal-chat-new-group"));
    const group = await screen.findByTestId("portal-new-group");
    expect(group.hasAttribute("data-sheet-dialog")).toBe(true);
    expect(group.style.boxShadow).not.toMatch(/64px/);
    tall(group);
    pull(within(group).getByText("Ny gruppe", { selector: "h3" }), 200);
    expect(group.style.transform).toBe("");
    expect(overlayOf(group).hasAttribute("data-closing")).toBe(false);
  });

  it("a phone: a pull from its title closes it", async () => {
    await mount();
    go("Beskeder");
    fireEvent.click(await screen.findByTestId("portal-chat-new-group"));
    const group = await screen.findByTestId("portal-new-group");
    tall(group);
    pull(within(group).getByText("Ny gruppe", { selector: "h3" }), 200);
    await waitFor(() => expect(screen.queryByTestId("portal-new-group")).toBeNull());
  });
});

describe("A pull inside a sheet never also reloads the page behind it", () => {
  it("Timer's period sheet lives in the page's scroller; pulling it closes it and arms no pull-to-refresh", async () => {
    await mount();
    go("Timer");
    fireEvent.click(await screen.findByTestId("portal-hours-period"));
    const period = await screen.findByTestId("portal-period-sheet");
    const scroller = document.querySelector(".full-height.scrollable");
    expect(scroller.contains(period)).toBe(true);           // why the guard is needed
    tall(period);
    pull(within(period).getByText("Vælg en periode"), 200);
    expect(screen.queryByTestId("portal-pull-status")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("portal-period-sheet")).toBeNull());
    // The page's own pull still arms (unchanged).
    const e = (type, y) => { const ev = new Event(type, { bubbles: true }); if (y !== undefined) ev.touches = [{ clientY: y }]; scroller.dispatchEvent(ev); };
    act(() => { e("touchstart", 0); e("touchmove", 40); });
    expect(screen.getByTestId("portal-pull-status").textContent).toContain("Slip for at opdatere");
    act(() => { e("touchend"); });
  });
});

describe("The other language is fetched when the profile sheet opens, never at boot (fix round, PLAT-2)", () => {
  const wait = (ms) => act(() => new Promise((r) => { setTimeout(r, ms); }));
  it("nothing at boot; opened and closed at once: nothing; opened: DA and EN once its 0.32 s entrance has played", async () => {
    preload.fn.mockClear();
    await mount();
    await wait(400);
    expect(preload.fn).not.toHaveBeenCalled();
    const button = screen.getByTitle("Rediger profil");
    fireEvent.click(button);                           // open
    fireEvent.click(button);                           // and closed again at once
    await wait(400);
    expect(preload.fn).not.toHaveBeenCalled();
    await openProfile();
    expect(preload.fn).not.toHaveBeenCalled();         // not during the entrance
    await waitFor(() => expect(preload.fn).toHaveBeenCalledTimes(1));
    expect(preload.fn).toHaveBeenCalledWith(["da", "en"]);
  });
});
