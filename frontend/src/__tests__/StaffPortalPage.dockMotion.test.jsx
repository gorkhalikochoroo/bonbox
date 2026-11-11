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
 *   • Loading is shimmer, never a spinner or a pulse — Byt, Fravær and the
 *     availability calendar too, with the words kept for a screen reader.
 *   • The indicator rides a clipping track; the active icon draws heavier.
 *   • Hours figures that stand in a column are Sora (tabular digits).
 * (vagtplan.css itself, the fonts and the components are pinned in
 * vagtplanMotionKit.test.jsx.)
 */
import { useEffect } from "react";
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
let hoursEntries = [];
let slowUrl = null;   // a RegExp: the GETs that never answer
const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) return ok(info);
  if (url.startsWith(`/portal/${TOK}/schedule`)) return scheduleImpl();
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) return ok([]);
  if (url.startsWith(`/portal/${TOK}/hours`)) {
    return ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 12.5, entries: hoursEntries });
  }
  // Byt's inbox, Fravær, the availability calendar: still loading.
  if (slowUrl && slowUrl.test(url)) return new Promise(() => {});
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
  hoursEntries = [];
  slowUrl = null;
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

  it("the pill rides a clipping track the dock's shape (the spring's overshoot never shows past the dock)", async () => {
    await mount("da");
    const track = screen.getByTestId("portal-dock-track");
    expect(track.className).toBe("vp-dock-track");
    expect(track.parentElement).toBe(dock());
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect([...track.children]).toEqual([indicator()]);
    expect(indicator().querySelector(".vp-dock-pill")).not.toBeNull();
  });

  it("the active tab's icon draws heavier (2.3) than the rest (1.9)", async () => {
    await mount("da");
    const stroke = (key) => screen.getByTestId(`portal-tab-${key}`).querySelector(".vp-dock-icon svg").getAttribute("stroke-width");
    expect(stroke("schedule")).toBe("2.3");
    expect(stroke("hours")).toBe("1.9");
    fireEvent.click(screen.getByTestId("portal-tab-hours"));
    expect(stroke("hours")).toBe("2.3");
    expect(stroke("schedule")).toBe("1.9");
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
  it("Timer's total is RollingDigits: the same text, plain at rest, even when motion is allowed", async () => {
    motionPref({ reduce: false });
    await mount("da");
    fireEvent.click(screen.getByTestId("portal-tab-hours"));
    const total = await screen.findByTestId("portal-hours-total");
    expect(total.textContent).toBe("12,5");
    const roll = total.querySelector(".vp-roll");
    expect(roll.getAttribute("data-value")).toBe("12,5");
    // At rest ONE text node: a screen reader reads "12,5", not 1 · 2 · , · 5.
    expect(roll.childNodes).toHaveLength(1);
    expect(roll.firstChild.nodeType).toBe(Node.TEXT_NODE);
    // Nothing rolled on arrival: only a CHANGE rolls.
    expect(total.querySelectorAll(".vp-roll-cell")).toHaveLength(0);
  });

  it("the hours list's totals are Sora figures (tabular), right-aligned down the list", async () => {
    hoursEntries = [
      { date: inDays(-2), start_time: "16:00", end_time: "22:30", total_hours: 6.5 },
      { date: inDays(-1), start_time: "10:00", end_time: "21:15", total_hours: 11.25 },
    ];
    await mount("da");
    fireEvent.click(screen.getByTestId("portal-tab-hours"));
    const totals = await screen.findAllByTestId("portal-hours-entry-total");
    expect(totals).toHaveLength(2);
    for (const el of totals) {
      expect(el.className).toContain("vp-figures");
      expect(el.className).toContain("font-semibold");
    }
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

  for (const [what, tab, slow] of [
    ["Byt's inbox", "swaps", /\/swap-requests/],
    ["the availability calendar", "availability", /\/(availability|absence)/],
    ["Fravær's list (the calendar loaded)", "availability", /\/absence/],
  ]) {
    it(`${what}: shimmer rows while it loads, the words kept for a screen reader (role=status)`, async () => {
      slowUrl = slow;
      await mount("da");
      fireEvent.click(screen.getByTestId(`portal-tab-${tab}`));
      const lists = await screen.findAllByTestId("portal-list-loading");
      expect(lists).toHaveLength(1);
      for (const box of lists) {
        expect(box.getAttribute("role")).toBe("status");
        expect(box.querySelector(".sr-only").textContent).toBe("Indlæser…");
        const rows = within(box).getAllByTestId("portal-skeleton");
        expect(rows.length).toBeGreaterThan(1);
        for (const r of rows) {
          expect(r.className).toContain("vp-shimmer");
          expect(r.getAttribute("aria-hidden")).toBe("true");
        }
      }
      // No plain "Indlæser…" line left on screen.
      expect(screen.getAllByText("Indlæser…").every((n) => n.className === "sr-only")).toBe(true);
      expect(document.querySelector(".animate-pulse, .animate-spin")).toBeNull();
    });
  }
});

describe("The type", () => {
  it("the page puts the portal-shell scope on <body> in its LAYOUT phase — before the first paint (fonts + motion tokens)", async () => {
    // A probe rendered BEFORE the page reads <body> in its first passive
    // effect. Every layout effect of a commit runs before any passive effect,
    // and passive effects run in tree order — so the probe sees the class only
    // if the page added it in a layout effect (before paint). A plain
    // useEffect in the page would run AFTER the probe's, and the probe would
    // see no class.
    const seen = [];
    function Probe() {
      useEffect(() => { seen.push(document.body.classList.contains("portal-shell")); }, []);
      return null;
    }
    localStorage.setItem("lang", "da");
    render(
      <LanguageProvider>
        <ConfirmProvider>
          <Probe />
          <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
            <Routes>
              <Route path="/portal/:token" element={<StaffPortalPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </LanguageProvider>,
    );
    expect(seen).toEqual([true]);
    await waitFor(() => expect(screen.getByTestId("portal-hero-meta")).toBeInTheDocument());
    expect(document.body.classList.contains("portal-shell")).toBe(true);
  });

  it("a next shift has no breathing dot — only a running clock does", async () => {
    await mount("da");
    expect(screen.queryByTestId("portal-whos-on-live-dot")).toBeNull();
    expect(screen.queryByTestId("portal-live-dot")).toBeNull();
  });
});
