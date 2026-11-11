/**
 * Vagtplan — the Orvexlo floating dock and the portal's motion (Nov 2026),
 * pinned on the REAL page against a mocked portalApi.
 *
 *   • ONE indicator for the whole dock; its column is the CSS variable --i,
 *     which follows the active tab (0..4). On Alerts (the header bell, not a
 *     dock tab) it fades out in place (data-hidden) and slides on from there.
 *   • Every tab is its icon AND its name, in Danish and in English; the
 *     active one carries aria-current="page"; a count stays on Beskeder.
 *   • The first paint plays nothing; a real switch rises the new screen in
 *     and pops the active name.
 *   • Sheets: with motion allowed the ⋯ sheet stays mounted with
 *     data-closing for its exit, then goes; under prefers-reduced-motion it
 *     unmounts at once.
 *   • Loading is shimmer, never a spinner or a pulse.
 * (vagtplan.css itself, the fonts and the components are pinned in
 * vagtplanMotionKit.test.jsx.)
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVenueMapCache } from "../utils/venueMapImage";

const TOK = "tokdock";
const ok = (data) => Promise.resolve({ data });
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};
const SHIFT_DAY = inDays(1);
let info;
let scheduleImpl;
let threadsImpl;
const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) return ok(info);
  if (url.startsWith(`/portal/${TOK}/schedule`)) return scheduleImpl();
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) return ok([]);
  if (url.startsWith(`/portal/${TOK}/hours`)) {
    return ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 12.5, entries: [] });
  }
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 3 });
  if (url.includes("/chat/threads")) return threadsImpl();
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

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

async function mount(lang = "da") {
  localStorage.setItem("lang", lang);
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
  await waitFor(() => expect(screen.getByTitle(lang === "da" ? "Rediger profil" : "Edit profile")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId("portal-hero-meta")).toBeInTheDocument());
}

const dock = () => screen.getByTestId("portal-tabbar-v3");
const indicator = () => screen.getByTestId("portal-dock-indicator");
const activeTab = () => within(dock()).getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page");

/** A browser that answers the motion query: reduce = true → reduced motion. */
function motionPref({ reduce }) {
  window.matchMedia = (q) => ({
    matches: q === "(prefers-reduced-motion: reduce)" ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}

beforeEach(() => {
  localStorage.clear();
  clearVenueMapCache();
  get.mockClear();
  info = {
    has_pin: false, staff_name: "Freja M.", role: "bartender",
    restaurant_name: "Café Solsikke", restaurant_address: "Solsikkegade 7", restaurant_city: "2200 København N",
  };
  threadsImpl = () => ok({ threads: [] });
  scheduleImpl = () => ok({
    shifts: [
      { id: "sh-1", date: SHIFT_DAY, start_time: "16:00", end_time: "22:30", status: "published", net_hours: 6.5 },
    ],
  });
});
afterEach(() => {
  delete window.matchMedia;
  document.body.classList.remove("portal-shell");
});

describe("The dock: one indicator, --i follows the active tab", () => {
  it("starts on Vagtplan (--i 0) and slides to each tab's column as it is chosen", async () => {
    await mount("da");
    expect(dock().querySelectorAll(".vp-dock-ind")).toHaveLength(1);
    expect(indicator().style.getPropertyValue("--i")).toBe("0");
    expect(indicator().hasAttribute("data-hidden")).toBe(false);
    const order = ["schedule", "availability", "messages", "swaps", "hours"];
    // Out of order on purpose: the pill goes straight to the column chosen.
    for (const key of ["hours", "availability", "swaps", "messages", "schedule"]) {
      fireEvent.click(screen.getByTestId(`portal-tab-${key}`));
      expect(indicator().style.getPropertyValue("--i")).toBe(String(order.indexOf(key)));
      expect(activeTab()).toEqual([screen.getByTestId(`portal-tab-${key}`)]);
    }
    // The column count the CSS divides by.
    expect(dock().style.getPropertyValue("--n")).toBe("5");
  });

  it("Alerts (the bell) is not a dock tab: the pill fades in place, then slides on from there", async () => {
    await mount("da");
    fireEvent.click(screen.getByTestId("portal-tab-hours"));
    expect(indicator().style.getPropertyValue("--i")).toBe("4");
    fireEvent.click(within(screen.getByTestId("portal-header-row")).getByRole("button", { name: "Nyt" }));
    expect(indicator().hasAttribute("data-hidden")).toBe(true);
    expect(indicator().style.getPropertyValue("--i")).toBe("4");
    expect(activeTab()).toEqual([]);
    fireEvent.click(screen.getByTestId("portal-tab-swaps"));
    expect(indicator().hasAttribute("data-hidden")).toBe(false);
    expect(indicator().style.getPropertyValue("--i")).toBe("3");
  });

  it("a deep link (?tab=hours) opens with the pill already on Timer", async () => {
    window.history.replaceState(null, "", "/?tab=hours");
    try {
      await mount("da").catch(() => {});
      await waitFor(() => expect(indicator().style.getPropertyValue("--i")).toBe("4"));
      expect(activeTab()[0].textContent).toBe("Timer");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("The dock: every tab is its icon and its name", () => {
  for (const [lang, names] of [
    ["da", ["Vagtplan", "Fravær", "Beskeder", "Byt", "Timer"]],
    ["en", ["Schedule", "Time off", "Messages", "Swaps", "Hours"]],
  ]) {
    it(`${lang}: five tabs, each an icon and a visible name; a count on Messages`, async () => {
      await mount(lang);
      const tabs = within(dock()).getAllByRole("button");
      expect(tabs).toHaveLength(5);
      tabs.forEach((b, i) => {
        expect(b.querySelector(".vp-dock-icon svg")).not.toBeNull();
        const label = b.querySelector(".vp-dock-label");
        expect(label.textContent).toBe(names[i]);
        // Names are never screen-reader-only in the dock.
        expect(label.className).not.toContain("sr-only");
      });
      expect(within(dock()).getByLabelText(lang === "da" ? "Ulæste beskeder" : "Unread messages").textContent).toBe("3");
      expect(dock().getAttribute("aria-label")).toBeTruthy();
    });
  }

  it("keeps the keyboard focus ring and the cookie banner's marker", async () => {
    await mount("da");
    for (const b of within(dock()).getAllByRole("button")) {
      expect(b.className).toContain("focus-visible:ring-2");
      expect(b.getAttribute("type")).toBe("button");
    }
    expect(dock().hasAttribute("data-bb-consent-clear")).toBe(true);
  });
});

describe("Screen + name motion only on a real switch", () => {
  it("the first paint plays nothing; a switch rises the new screen and pops the active name", async () => {
    await mount("da");
    expect(screen.getByTestId("portal-content").className).not.toContain("vp-screen-in");
    expect(dock().querySelectorAll(".vp-label-in")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("portal-tab-hours"));
    expect(screen.getByTestId("portal-content").className).toContain("vp-screen-in");
    const popped = dock().querySelectorAll(".vp-label-in");
    expect(popped).toHaveLength(1);
    expect(popped[0].textContent).toBe("Timer");
  });
});

describe("Sheets play their exit — unless motion is reduced", () => {
  it("motion allowed: the ⋯ sheet stays for its exit (data-closing, inert), then goes", async () => {
    motionPref({ reduce: false });
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    expect(sheet.className).toContain("vp-sheet");
    fireEvent.click(within(sheet).getAllByRole("button", { name: "Luk" })[0]);
    const overlay = screen.getByTestId("portal-shift-menu").parentElement;
    expect(overlay.hasAttribute("data-closing")).toBe(true);
    expect(overlay.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("portal-shift-menu")).toBeNull());
  });

  it("reduced motion: the ⋯ sheet unmounts at once", async () => {
    motionPref({ reduce: true });
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    fireEvent.click(within(sheet).getAllByRole("button", { name: "Luk" })[0]);
    expect(screen.queryByTestId("portal-shift-menu")).toBeNull();
  });

  it("reopening during the exit keeps the sheet (no flash, no second sheet)", async () => {
    motionPref({ reduce: false });
    await mount("da");
    const more = screen.getByRole("button", { name: "Flere valg for vagten" });
    fireEvent.click(more);
    const sheet = await screen.findByTestId("portal-shift-menu");
    fireEvent.click(within(sheet).getAllByRole("button", { name: "Luk" })[0]);
    expect(screen.getByTestId("portal-shift-menu").parentElement.hasAttribute("data-closing")).toBe(true);
    fireEvent.click(more);
    expect(screen.getAllByTestId("portal-shift-menu")).toHaveLength(1);
    expect(screen.getByTestId("portal-shift-menu").parentElement.hasAttribute("data-closing")).toBe(false);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(screen.getByTestId("portal-shift-menu")).toBeInTheDocument();
  });
});

describe("Rolling numbers on the page", () => {
  it("Timer's total is RollingDigits: the same text, digits in their own cells when motion is allowed", async () => {
    motionPref({ reduce: false });
    await mount("da");
    fireEvent.click(screen.getByTestId("portal-tab-hours"));
    const total = await screen.findByTestId("portal-hours-total");
    expect(total.textContent).toBe("12,5");
    expect(total.querySelectorAll(".vp-roll-digit")).toHaveLength(3);
    // Nothing rolled on arrival: only a CHANGE rolls.
    expect(total.querySelectorAll(".vp-roll-up, .vp-roll-down")).toHaveLength(0);
  });
});

describe("Loading is shimmer", () => {
  it("the hero placeholder and the thread list shimmer; no pulse, no spinner", async () => {
    scheduleImpl = () => new Promise(() => {});
    threadsImpl = () => new Promise(() => {});
    await mount("da").catch(() => {});
    const hero = await screen.findByTestId("portal-hero-loading");
    expect(hero.querySelectorAll(".vp-shimmer").length).toBeGreaterThan(0);
    expect(hero.className).not.toContain("animate-pulse");
    fireEvent.click(screen.getByTestId("portal-tab-messages"));
    const blocks = await screen.findAllByTestId("portal-skeleton");
    expect(blocks.every((b) => b.className.includes("vp-shimmer"))).toBe(true);
    expect(document.querySelector(".animate-pulse, .animate-spin")).toBeNull();
  });
});

describe("The type", () => {
  it("the page puts the portal-shell scope on <body> before it paints anything else (fonts + motion tokens)", async () => {
    await mount("da");
    expect(document.body.classList.contains("portal-shell")).toBe(true);
  });

  it("a next shift has no breathing dot — only a running clock does", async () => {
    await mount("da");
    expect(screen.queryByTestId("portal-whos-on-live-dot")).toBeNull();
    expect(screen.queryByTestId("portal-live-dot")).toBeNull();
  });
});
