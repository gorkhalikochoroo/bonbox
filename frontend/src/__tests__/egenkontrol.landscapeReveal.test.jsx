/**
 * Egenkontrol R1b — the R1a review's should-fix: in LANDSCAPE the "Registrér"
 * panel's next missing step could stay hidden.
 *
 * Root cause: the landscape aside was `sticky top-4 max-h-[calc(100dvh-2rem)]`
 * under a ~150 px header, so its bottom (later steps AND the save button)
 * sat below the iPad's edge; reveal.scrollWithin measured "visible" against
 * the scroller's own box, which itself ran off screen, and did nothing.
 *
 * Pinned here:
 *   • landscape = a fixed-height two-pane screen: root data-layout=
 *     "landscape-panes" (h-dvh, overflow-hidden), each pane scrolls on its
 *     own, the aside is NOT sticky and has no calc max-height;
 *   • "7" on a 5 °C fridge, then a tap on the not-ready button while the
 *     scroller's box runs below window.innerHeight and the action row is
 *     below the fold → the panel scrolls and the action chip is focused;
 *   • scrollWithin clamps to the visual viewport, and brings a scroller that
 *     is wholly off screen into view first;
 *   • nothing above the keys changes when the questions appear (the keypad
 *     never moves) — same contract as portrait;
 *   • the OWNER page's wide layout (the other landscape recording surface):
 *     the sticky "Registrér" column is fitted below its own top edge (never
 *     a fixed 100dvh − 2rem under the page header), grows when it sticks,
 *     and is scrolled into view when chosen below the fold.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.landscapeReveal
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({ today: vi.fn(), staff: vi.fn(), landscape: true, get: vi.fn() }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    defaults: { baseURL: "http://test/api" },
  },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-owner-1", role: "owner", business_type: "cafe" } }) }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn() }));
vi.mock("../services/kitchenApi", () => ({
  default: {
    today: h.today, staff: h.staff, saveEntry: vi.fn(), undo: vi.fn(), folder: vi.fn(), unpair: vi.fn(),
    uploadPhoto: vi.fn(), photo: vi.fn(), documentFile: vi.fn(),
  },
  KITCHEN_TOKEN_RE: /^[A-Za-z0-9_-]{8,128}$/,
  forgetKitchenToken: vi.fn(),
  rememberKitchenToken: vi.fn(),
  rememberedKitchenToken: () => null,
  rememberedKitchenVenue: () => null,
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
vi.mock("../hooks/useToast", () => ({ useToast: () => vi.fn() }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => h.landscape }));

const KitchenPage = (await import("../pages/KitchenPage")).default;
const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const { scrollWithin, visibleBand } = await import("../components/egenkontrol/reveal");

const FRIDGE = {
  id: "c-k1", name: "Køl 1", note: null, kind: "temp_max", template_key: "fridge", group_key: "temperatures",
  branch_id: null, sort_order: 0, active: true, archived_at: null,
  limit: { limit_c: 5, direction: "max", source: "law", ref: null }, product_limits: null,
  schedule: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], recheck_min: 30,
  action_codes: ["thermostat_adjusted", "moved_goods", "other"], fate_codes: ["moved", "discarded", "assessed_ok", "awaiting_recheck", "other"],
  status: "due", slot: { due_at: "2026-11-12T07:00:00Z", due_local: "08:00" }, last: null, open_deviation: null,
};
const TODAY = {
  business_date: "2026-11-12", server_now: "2026-11-12T07:05:00Z", timezone: "Europe/Copenhagen", cutoff_hour: 6, setup_done: true,
  checks: [FRIDGE], summary: { total: 1, done: 0, missing: 0, due: 1, open_deviations: 0 },
  venue_name: "Café Sol", device_label: "Køkken-iPad", branch_name: null,
};

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const toks = (el) => String(el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
function rect(top, height) {
  return { top, height, bottom: top + height, left: 0, right: 400, width: 400, x: 0, y: top, toJSON() {} };
}
function aboveTheKeys(panel) {
  const keys = within(panel).getByTestId("ek-keypad-keys");
  const hint = within(panel).getByTestId("ek-keypad-hint");
  return Array.from(panel.querySelectorAll("*"))
    .filter((el) => !el.contains(keys))
    .filter((el) => el.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING)
    .filter((el) => el === hint || !hint.contains(el))
    .map((el) => `${el.tagName}.${toks(el).join(".")}`);
}
const renderKitchen = async () => {
  render(
    <MemoryRouter initialEntries={["/kitchen/kt_ABCdef123456"]}>
      <Routes><Route path="/kitchen/:kitchenToken" element={<KitchenPage />} /></Routes>
    </MemoryRouter>,
  );
  await settle();
};

beforeEach(() => {
  h.landscape = true;
  h.today.mockReset().mockResolvedValue(TODAY);
  h.staff.mockReset().mockResolvedValue({ staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] });
});
afterEach(() => {
  vi.restoreAllMocks();
  try { delete window.visualViewport; } catch { /* jsdom */ }
});

describe("landscape is a fixed-height two-pane screen", () => {
  it("root data-layout='landscape-panes', h-dvh; the panes scroll on their own; the aside is not sticky", async () => {
    await renderKitchen();
    const root = screen.getByTestId("ek-kitchen");
    expect(root).toHaveAttribute("data-layout", "landscape-panes");
    expect(toks(root)).toEqual(expect.arrayContaining(["h-dvh", "flex", "flex-col", "overflow-hidden"]));
    const panes = screen.getByTestId("ek-kitchen-panes");
    expect(toks(panes)).toEqual(expect.arrayContaining(["flex-1", "min-h-0", "grid"]));
    expect(toks(screen.getByTestId("ek-kitchen-list-pane"))).toEqual(expect.arrayContaining(["min-h-0", "overflow-y-auto"]));
    const aside = screen.getByTestId("ek-kitchen-record-pane");
    expect(toks(aside)).toEqual(expect.arrayContaining(["min-h-0", "h-full", "flex", "flex-col"]));
    expect(toks(aside)).not.toContain("sticky");
    expect(toks(aside).some((c) => c.startsWith("max-h-[calc"))).toBe(false);
    // The panel fills the aside: its own scroll area + the button at the bottom.
    expect(toks(within(aside).getByTestId("ek-record-panel"))).toEqual(expect.arrayContaining(["grow", "min-h-0"]));
  });

  it("portrait is unchanged (no fixed-height panes)", async () => {
    h.landscape = false;
    await renderKitchen();
    const root = screen.getByTestId("ek-kitchen");
    expect(root).toHaveAttribute("data-layout", "stack");
    expect(toks(root)).toContain("min-h-dvh");
    expect(toks(root)).not.toContain("h-dvh");
  });
});

describe("the CTA tap reveals the next step in landscape", () => {
  it("'7' on a 5 °C fridge; the scroller's box runs below the screen; the tap scrolls to the action row and focuses it", async () => {
    await renderKitchen();
    const aside = screen.getByTestId("ek-kitchen-record-pane");
    const panel = within(aside).getByTestId("ek-record-panel");
    const before = aboveTheKeys(panel);
    fireEvent.click(within(panel).getByRole("button", { name: "7" }));
    expect(within(panel).getByTestId("ek-action-row")).toBeInTheDocument();
    // The keypad never moves: nothing above the keys changed.
    expect(aboveTheKeys(panel)).toEqual(before);

    const scroller = panel.querySelector("[data-ek-scroll]");
    scroller.scrollTo = vi.fn();
    // innerHeight 768 (jsdom). The scroller claims 150 … 1050 — 282 px of it
    // below the screen — and the action row sits at 800 … 920: inside the
    // scroller's own box, but under the fold.
    expect(window.innerHeight).toBe(768);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this === scroller) return rect(150, 900);
      if (this.matches('[data-ek-step="action"]')) return rect(800, 120);
      return rect(0, 0);
    });
    const cta = within(panel).getByTestId("ek-save");
    expect(cta).toHaveAttribute("aria-disabled", "true");
    await act(async () => { fireEvent.click(cta); });
    // Clamped view 150 … 768 (618 high): 800 − 150 − (618 − 120) / 2 = 401.
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 401 }));
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: da.ekActThermostatAdjusted }));
  });
});

describe("reveal.scrollWithin measures against what is on screen", () => {
  const mount = (scrollerRect, elRect) => {
    const scroller = document.createElement("div");
    const el = document.createElement("div");
    scroller.appendChild(el);
    document.body.appendChild(scroller);
    scroller.scrollTo = vi.fn();
    scroller.scrollIntoView = vi.fn();
    let sRect = scrollerRect;
    scroller.getBoundingClientRect = () => sRect;
    el.getBoundingClientRect = () => elRect;
    return { scroller, el, move: (r) => { sRect = r; } };
  };

  it("the visual viewport (keyboard up) is the band", () => {
    window.visualViewport = { height: 400, offsetTop: 0, addEventListener() {}, removeEventListener() {} };
    expect(visibleBand()).toEqual({ top: 0, bottom: 400 });
    const { scroller, el } = mount(rect(100, 600), rect(450, 50));
    scrollWithin(scroller, el); // inside 100…700, but under the keyboard (400)
    // Clamped 100 … 400 (300 high): 450 − 100 − (300 − 50) / 2 = 225.
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 225 }));
    scroller.remove();
  });

  it("fully visible → no scroll", () => {
    const { scroller, el } = mount(rect(100, 400), rect(200, 50));
    scrollWithin(scroller, el);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    scroller.remove();
  });

  it("a scroller wholly below the screen is brought into view first", () => {
    const { scroller, el, move } = mount(rect(900, 400), rect(1000, 50));
    scroller.scrollIntoView = vi.fn(() => move(rect(300, 400)));
    scrollWithin(scroller, el);
    expect(scroller.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    scroller.remove();
  });
});

describe("the owner page, wide (≥ 1024 px): the 'Registrér' column is fitted below its own top edge", () => {
  const routes = {
    "/egenkontrol/today": TODAY,
    "/egenkontrol/checks": { checks: [FRIDGE], archived: [] },
    "/egenkontrol/templates": { cutoff_hour: 6, templates: [] },
    "/egenkontrol/staff": { staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] },
  };
  let asideTop;
  const renderOwner = async () => {
    h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.getAttribute?.("data-testid") === "ek-owner-record-pane") return rect(asideTop, 900);
      return rect(0, 0);
    });
    render(<MemoryRouter initialEntries={["/egenkontrol"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
  };
  const choose = async () => {
    await act(async () => { fireEvent.click(within(screen.getByTestId("ek-row-c-k1")).getAllByRole("button")[0]); });
    await settle(2);
  };
  const frame = async () => {
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  };

  it("max-height = the screen's bottom − its own top − 16 px (never 100dvh − 2rem); it grows once it sticks at the top", async () => {
    asideTop = 260;
    await renderOwner();
    await choose();
    const aside = screen.getByTestId("ek-owner-record-pane");
    expect(toks(aside)).toEqual(expect.arrayContaining(["sticky", "top-4", "flex", "flex-col", "overflow-hidden"]));
    expect(toks(aside).some((c) => c.startsWith("max-h-[calc"))).toBe(false);
    expect(window.innerHeight).toBe(768);
    expect(aside.style.maxHeight).toBe(`${768 - 260 - 16}px`);
    // The page is scrolled: the column sticks 16 px from the top and fills the screen.
    asideTop = 16;
    await act(async () => { window.dispatchEvent(new Event("scroll")); });
    await frame();
    expect(aside.style.maxHeight).toBe(`${768 - 16 - 16}px`);
    // The panel inside keeps its own scroll area with the button below it.
    expect(within(aside).getByTestId("ek-record-panel").querySelector("[data-ek-scroll]")).not.toBeNull();
    expect(within(aside).getByTestId("ek-save")).toBeInTheDocument();
  });

  it("chosen while the column starts below the fold → it is scrolled into view", async () => {
    asideTop = 900;
    const into = vi.fn(function () { asideTop = 300; });
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, "scrollIntoView");
    const prev = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = into;
    try {
      await renderOwner();
      await choose();
      expect(into).toHaveBeenCalledWith({ block: "nearest" });
      expect(into.mock.contexts[0]).toBe(screen.getByTestId("ek-owner-record-pane"));
      expect(screen.getByTestId("ek-owner-record-pane").style.maxHeight).toBe(`${768 - 300 - 16}px`);
    } finally {
      if (had) Element.prototype.scrollIntoView = prev;
      else delete Element.prototype.scrollIntoView;
    }
  });
});
