/**
 * Release 2026-11-15 — the kitchen iPad in landscape: the whole "Hvem målte?"
 * row shows above the button WITHOUT scrolling the "Registrér" pane.
 *
 * Measured in headless Chromium on the shipped /kitchen/<token> screen (three
 * staff → two rows of name chips at the pane's 440 px), before the fix:
 * 1180 × 820 the second row ended 95.5 px under the pane's scroll edge (half
 * hidden behind the pinned "Indtast temperatur"), 1194 × 834 81.5 px,
 * 1024 × 768 147.5 px; only 1366 × 1024 fitted. After: all four fit with a
 * 4 px margin, keys 61.6 / 64 / 48.6 / 64 px.
 *
 * Pinned here — the layout rule the fix relies on:
 *   • landscape panel = fit="panes": a size container whose --ek-key-h is
 *     clamp(48px, (100cqh − FIT_RESERVED_PX) / 4, 64px); the keys use it only
 *     where container units work (supports-[height:1cqh]), else 64 px;
 *   • FIT_RESERVED_PX is the sum of the parts it names, and those parts are
 *     the classes on screen (change a gap → this test asks for the constant);
 *   • the formula gives ≥ 56 px keys at 1180 × 820 and never < 48 px;
 *   • the "For varmt" line sits inside the display box in that mode, and
 *     typing across the limit changes nothing above the keys (the R1a rule);
 *   • the header's progress and "Måler" share one fixed-height line;
 *   • portrait, the phone and the owner's panels keep the 64 px keys and the
 *     R1a hint row (h-6, truncate).
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.kitchenFit
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({ today: vi.fn(), staff: vi.fn(), landscape: true }));
vi.mock("../services/api", () => ({
  default: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    defaults: { baseURL: "http://test/api" },
  },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-owner-1", role: "owner", business_type: "cafe" } }) }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
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
const RecordPanelModule = await import("../components/egenkontrol/RecordPanel");
const RecordPanel = RecordPanelModule.default;
const { FIT_KEY_HEIGHT, FIT_RESERVED_PX } = RecordPanelModule;

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
const STAFF = [
  { id: "s-sara", name: "Sara J.", on_shift: true },
  { id: "s-mikkel", name: "Mikkel H.", on_shift: true },
  { id: "s-oscar", name: "Oscar L.", on_shift: true },
];
const t = (k, vars) => {
  let s = da[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const toks = (el) => String(el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
const keysOf = (panel) => within(within(panel).getByTestId("ek-keypad-keys")).getAllByRole("button");
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
const openPanel = async () => {
  await renderKitchen();
  if (h.landscape) return within(screen.getByTestId("ek-kitchen-record-pane")).getByTestId("ek-record-panel");
  fireEvent.click(within(screen.getByTestId("ek-row-c-k1")).getAllByRole("button")[0]);
  return within(screen.getByRole("dialog", { name: da.ekRecord })).getByTestId("ek-record-panel");
};

/** The CSS clamp, evaluated for a panel `panelPx` high (the browser's job). */
function keyPx(panelPx) {
  const m = FIT_KEY_HEIGHT.match(/^clamp\((\d+)px, calc\(\(100cqh - (\d+(?:\.\d+)?)px\) \/ 4\), (\d+)px\)$/);
  expect(m, FIT_KEY_HEIGHT).not.toBeNull();
  const [min, reserved, max] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return Math.min(max, Math.max(min, (panelPx - reserved) / 4));
}
// The landscape panel's height at a viewport height: the screen minus the
// header (121.5 px with the one status line), the panes' 16 px bottom padding
// and the pane's two 1 px borders — as measured in headless Chromium.
const PANEL_AT = (vh) => vh - 121.5 - 16 - 2;

beforeEach(() => {
  h.landscape = true;
  h.today.mockReset().mockResolvedValue(TODAY);
  h.staff.mockReset().mockResolvedValue({ staff: STAFF });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the rule: keys take what the landscape pane has left, 48 … 64 px", () => {
  it("FIT_KEY_HEIGHT is the clamp over FIT_RESERVED_PX, and the reserve is the sum of its named parts", () => {
    expect(FIT_KEY_HEIGHT).toBe(`clamp(48px, calc((100cqh - ${FIT_RESERVED_PX}px) / 4), 64px)`);
    const parts = {
      head: 92.5, // pt-3 + "REGISTRÉR" + name + limit line + pb-2 + border
      scrollTop: 12, // pt-3
      display: 56 + 8, // h-14 row + mb-2
      keyGaps: 3 * 6, // gap-y-1.5 between the four rows
      beforeNames: 16, // space-y-4
      legend: 22.5 + 8, // "Hvem målte?" + mb-2
      chips: 56 + 8 + 56, // two rows of min-h-14 chips
      margin: 4,
      buttonBar: 8 + 56 + 12 + 1, // pt-2 + the button + 0.75rem + border-t
    };
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(FIT_RESERVED_PX);
  });

  it("≥ 56 px keys on the 11-inch iPad (1180 × 820), full 64 px on 1194 × 834 and 1366 × 1024, never under 48 px", () => {
    expect(keyPx(PANEL_AT(820))).toBeGreaterThanOrEqual(56);
    expect(keyPx(PANEL_AT(834))).toBe(64);
    expect(keyPx(PANEL_AT(1024))).toBe(64);
    expect(keyPx(PANEL_AT(768))).toBeGreaterThanOrEqual(48);
    expect(keyPx(300)).toBe(48);
    // …and with those keys the whole name row fits above the button.
    for (const vh of [820, 834, 768, 1024]) {
      expect(FIT_RESERVED_PX + 4 * keyPx(PANEL_AT(vh)), `vh ${vh}`).toBeLessThanOrEqual(PANEL_AT(vh));
    }
  });
});

describe("kitchen landscape: the panel runs in fit='panes'", () => {
  it("a size container with --ek-key-h; keys use it where container units work; the parts the reserve counts are the classes on screen", async () => {
    const panel = await openPanel();
    expect(panel).toHaveAttribute("data-ek-fit", "panes");
    expect(toks(panel)).toEqual(expect.arrayContaining(["grow", "min-h-0", "[container-type:size]"]));
    expect(panel.style.getPropertyValue("--ek-key-h")).toBe(FIT_KEY_HEIGHT);

    const keys = keysOf(panel);
    expect(keys).toHaveLength(12);
    for (const k of keys) {
      // 64 px where cqh is unknown (old Safari), the clamp where it works.
      expect(toks(k)).toEqual(expect.arrayContaining(["h-16", "supports-[height:1cqh]:h-(--ek-key-h)", "min-w-16"]));
    }
    expect(toks(within(panel).getByTestId("ek-keypad-keys"))).toEqual(expect.arrayContaining(["gap-x-2", "gap-y-1.5"]));
    expect(toks(within(panel).getByRole("button", { name: da.ekKeyBackspace }))).toEqual(expect.arrayContaining(["h-14", "w-16"]));

    // The parts FIT_RESERVED_PX counts.
    expect(toks(panel.firstElementChild)).toEqual(expect.arrayContaining(["pt-3", "pb-2"]));
    const scroller = panel.querySelector("[data-ek-scroll]");
    expect(toks(scroller)).toEqual(expect.arrayContaining(["pt-3", "space-y-4"]));
    const box = within(panel).getByTestId("ek-keypad-hint").parentElement;
    expect(toks(box)).toContain("h-14");
    const bar = panel.lastElementChild;
    expect(toks(bar)).toContain("pt-2");
    expect(bar.style.paddingBottom).toBe("0.75rem");
    expect(within(bar).getByTestId("ek-save")).toBeInTheDocument();
    // Three names + "Andet navn", min-h-14 each (the two rows the reserve counts).
    const chips = within(within(panel).getByTestId("ek-name-picker")).getAllByRole("button");
    expect(chips).toHaveLength(4);
    for (const c of chips) expect(c.className).toMatch(/min-h-14!/);
  });

  it("the 'For varmt' line is inside the display box; '7', ',', '1' on a 5 °C fridge change nothing above the keys", async () => {
    const panel = await openPanel();
    const hint = within(panel).getByTestId("ek-keypad-hint");
    const display = within(panel).getByTestId("ek-keypad-display");
    // Same box: hint left, number right; no separate hint row between display and keys.
    expect(hint.parentElement).toBe(display.parentElement);
    expect(toks(hint)).not.toContain("h-6");
    expect(hint).toBeEmptyDOMElement();
    const before = aboveTheKeys(panel);
    const keyClasses = keysOf(panel).map((k) => k.className);

    fireEvent.click(within(panel).getByRole("button", { name: "7" }));
    expect(within(panel).getByTestId("ek-keypad-hint")).toBe(hint);
    expect(hint).toHaveTextContent(da.ekTooWarm);
    expect(within(panel).getByTestId("ek-action-row")).toBeInTheDocument();
    expect(aboveTheKeys(panel)).toEqual(before);
    fireEvent.click(within(panel).getByRole("button", { name: da.ekKeyDecimal }));
    fireEvent.click(within(panel).getByRole("button", { name: "1" }));
    expect(display).toHaveTextContent("7,1");
    expect(aboveTheKeys(panel)).toEqual(before);
    // The key height comes from the panel (never from what is typed).
    expect(keysOf(panel).map((k) => k.className)).toEqual(keyClasses);
    expect(panel.style.getPropertyValue("--ek-key-h")).toBe(FIT_KEY_HEIGHT);
  });

  it("the header: progress and 'Måler' share ONE line of fixed height (no separate reserved line)", async () => {
    await renderKitchen();
    const status = screen.getByTestId("ek-kitchen-status");
    expect(toks(status)).toEqual(expect.arrayContaining(["h-8", "flex", "items-center"]));
    expect(within(status).getByTestId("ek-kitchen-progress")).toBeInTheDocument();
    expect(status.querySelector(".min-h-6")).toBeNull();
  });
});

describe("everywhere else the keypad is as it was", () => {
  it("kitchen portrait / phone (fit='sheet'): 64 px keys, the R1a hint row, no container — only a little less air", async () => {
    h.landscape = false;
    const panel = await openPanel();
    expect(panel).toHaveAttribute("data-ek-fit", "sheet");
    expect(toks(panel)).not.toContain("[container-type:size]");
    expect(panel.style.getPropertyValue("--ek-key-h")).toBe("");
    for (const k of keysOf(panel)) {
      expect(toks(k)).toEqual(expect.arrayContaining(["h-16", "min-w-16"]));
      expect(k.className).not.toMatch(/ek-key-h/);
    }
    const hint = within(panel).getByTestId("ek-keypad-hint");
    expect(toks(hint)).toEqual(expect.arrayContaining(["h-6", "truncate"]));
    expect(toks(panel.querySelector("[data-ek-scroll]"))).toEqual(expect.arrayContaining(["pt-3", "space-y-4"]));
    // Portrait header: two lines as before.
    const status = screen.getByTestId("ek-kitchen-status");
    expect(toks(status)).not.toContain("h-8");
    expect(status.querySelector(".min-h-6")).not.toBeNull();
  });

  it("the owner's panel (no fit): unchanged spacing, 64 px keys, the hint row", () => {
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    expect(panel).not.toHaveAttribute("data-ek-fit");
    expect(toks(panel)).not.toContain("[container-type:size]");
    expect(toks(panel.firstElementChild)).toEqual(expect.arrayContaining(["pt-4", "pb-3"]));
    expect(toks(panel.querySelector("[data-ek-scroll]"))).toEqual(expect.arrayContaining(["py-4", "space-y-5"]));
    expect(toks(within(panel).getByTestId("ek-keypad-hint"))).toEqual(expect.arrayContaining(["h-6", "truncate"]));
    expect(toks(within(panel).getByTestId("ek-keypad-keys"))).toContain("gap-2");
    for (const k of keysOf(panel)) expect(k.className).not.toMatch(/ek-key-h/);
    expect(panel.lastElementChild.style.paddingBottom).toBe("max(1rem, env(safe-area-inset-bottom, 0px))");
  });
});
