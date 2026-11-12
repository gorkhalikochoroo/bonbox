/**
 * Egenkontrol R1a — device-pass fixes (the lead's iPad Air 11" portrait run,
 * /kitchen/<token>, 12 Nov):
 *
 *  1. THE KEYPAD NEVER MOVES MID-ENTRY. "7" on Køl 1 (5,0 °C) added "For
 *     varmt" and the two deviation questions; the centred sheet grew and
 *     re-centred, the keys moved ~200 pt under the cook's finger and "7,1"
 *     became "77". jsdom has no layout, so this pins the LAYOUT CONTRACT that
 *     makes a move impossible: (a) nothing above the keys changes when the
 *     value crosses the limit — the "For varmt" line is one reserved,
 *     fixed-height, single line that exists before the first digit; (b) the
 *     questions render AFTER the keys; (c) the kitchen's and the owner's
 *     Sheet is top-anchored on ≥ sm and of fixed height on a phone, so its
 *     top edge never depends on the content's height.
 *  2. THE NEXT STEP IS NEVER HIDDEN. A tap on the not-ready button ("Vælg
 *     hvem der målte") scrolls the panel to the first missing step (action →
 *     food fate → name) and focuses it; "Andet navn" focuses its field and
 *     scrolls it into view, and again once the keyboard has shrunk the view.
 *  4. 'FØRSTE MÅLING I MORGEN KL. 08:00'. Set up at 20:36, the daily 08:00
 *     fridge has no slot today: the header says when the first reading is,
 *     not "Ingen faste målinger i dag" — which stays when it is true.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.devicePass
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const h = vi.hoisted(() => ({
  today: vi.fn(),
  staff: vi.fn(),
  saveEntry: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../services/kitchenApi", () => ({
  default: { today: h.today, staff: h.staff, saveEntry: h.saveEntry, undo: vi.fn(), folder: vi.fn(), unpair: vi.fn() },
  KITCHEN_TOKEN_RE: /^[A-Za-z0-9_-]{8,128}$/,
  forgetKitchenToken: vi.fn(),
  rememberKitchenToken: vi.fn(),
  rememberedKitchenToken: () => null,
  rememberedKitchenVenue: () => null,
}));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a),
    post: (...a) => h.post(...a),
    patch: vi.fn(),
    delete: vi.fn(),
    defaults: { baseURL: "http://test/api" },
  },
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
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { role: "owner", business_type: "cafe" } }) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false })); // portrait iPad → Sheet
vi.mock("../utils/download", () => ({ saveFile: vi.fn() }));

const RecordPanel = (await import("../components/egenkontrol/RecordPanel")).default;
const Sheet = (await import("../components/ui/Sheet")).default;
const KitchenPage = (await import("../pages/KitchenPage")).default;
const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const { firstReadingLine } = await import("../components/egenkontrol/ekLogic");
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const fill = (dict) => (k, vars) => {
  let s = dict[k] ?? k;
  if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return s;
};
const t = fill(da);
const tEn = fill(en);

const FRIDGE = {
  id: "c-k1", name: "Køl 1", note: null, kind: "temp_max", template_key: "fridge", group_key: "temperatures",
  branch_id: null, sort_order: 0, active: true, archived_at: null,
  limit: { limit_c: 5, direction: "max", source: "law", ref: null }, product_limits: null,
  schedule: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], recheck_min: 30,
  action_codes: ["thermostat_adjusted", "moved_goods", "other"], fate_codes: ["moved", "discarded", "assessed_ok", "awaiting_recheck", "other"],
  revision_id: "r1", valid_from: "2026-11-01T07:00:00Z",
  status: "due", slot: { due_at: "2026-11-12T07:00:00Z", due_local: "08:00", business_date: "2026-11-12" }, slot_is_today: true,
  last: null, open_deviation: null,
};
// Set up at 20:36: today's 08:00 had passed, so the server sends tomorrow's
// slot (status_today's `upcoming`) with slot_is_today false and total 0.
const FRIDGE_AFTER_SETUP = {
  ...FRIDGE,
  status: "later",
  slot: { due_at: "2026-11-13T07:00:00Z", due_local: "08:00", late_after: "2026-11-13T08:00:00Z", business_date: "2026-11-13", schedule_type: "daily" },
  slot_is_today: false,
};
const REHEATING = {
  ...FRIDGE, id: "c-rh", name: "Genopvarmning", kind: "temp_min", template_key: "reheating", group_key: "reheating",
  limit: { limit_c: 75, direction: "min", source: "law", ref: null }, schedule: { type: "on_event" },
  status: "on_event", slot: null, slot_is_today: false,
};
const NO_SLOT_TODAY = { total: 0, done: 0, missing: 0, due: 0, open_deviations: 0 };
const TODAY = {
  business_date: "2026-11-12", server_now: "2026-11-12T07:05:00Z", timezone: "Europe/Copenhagen", cutoff_hour: 6, setup_done: true,
  checks: [FRIDGE], summary: { total: 1, done: 0, missing: 0, due: 1, open_deviations: 0 },
  venue_name: "Café Sol", device_label: "Køkken-iPad", branch_name: null,
};
const STAFF = [
  { id: "s-ali", name: "Ali K.", on_shift: true },
  { id: "s-bo", name: "Bo L.", on_shift: false },
];

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const keyIn = (root, k) =>
  fireEvent.click(within(root).getByRole("button", { name: k === "," ? da.ekKeyDecimal : k === "-" ? da.ekKeyMinus : k }));
const toks = (el) => String(el.getAttribute("class") || "").split(/\s+/).filter(Boolean);

/**
 * Everything drawn ABOVE the keys, as tag + classes, in document order. The
 * reserved hint line counts as one box: what is written inside it cannot move
 * anything (fixed height, one line). Nothing else may appear, vanish or change.
 */
function aboveTheKeys(panel) {
  const keys = within(panel).getByTestId("ek-keypad-keys");
  const hint = within(panel).getByTestId("ek-keypad-hint");
  return Array.from(panel.querySelectorAll("*"))
    .filter((el) => !el.contains(keys))
    .filter((el) => el.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING)
    .filter((el) => el === hint || !hint.contains(el))
    .map((el) => `${el.tagName}.${toks(el).join(".")}`);
}
const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function rect(top, height) {
  return { top, height, bottom: top + height, left: 0, right: 400, width: 400, x: 0, y: top, toJSON() {} };
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.today.mockResolvedValue(TODAY);
  h.staff.mockResolvedValue({ staff: STAFF });
  __resetEgenkontrolStatus();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  try { delete window.visualViewport; } catch { /* jsdom */ }
});

// ─── 1. The keypad never moves ──────────────────────────────────────────

describe("1 — the keypad does not move when the value crosses the limit", () => {
  it("'7' then ',1' on a 5 °C fridge: nothing above the keys changes; the questions come below them", () => {
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    const hint = within(panel).getByTestId("ek-keypad-hint");
    // The "For varmt" line is there BEFORE the first digit: empty, one fixed line.
    expect(hint).toBeEmptyDOMElement();
    expect(toks(hint)).toEqual(expect.arrayContaining(["h-6", "truncate"]));
    expect(toks(hint).some((c) => /^min-h-/.test(c))).toBe(false);
    expect(within(panel).queryByTestId("ek-action-row")).toBeNull();
    const before = aboveTheKeys(panel);

    keyIn(panel, "7");
    // The limit was crossed: the line speaks and the questions are on screen…
    expect(within(panel).getByTestId("ek-keypad-hint")).toBe(hint);
    expect(hint).toHaveTextContent(da.ekTooWarm);
    expect(within(panel).getByTestId("ek-action-row")).toBeInTheDocument();
    expect(within(panel).getByTestId("ek-fate-row")).toBeInTheDocument();
    // …and nothing above the keys appeared, vanished or changed.
    expect(aboveTheKeys(panel)).toEqual(before);
    const keys = within(panel).getByTestId("ek-keypad-keys");
    for (const id of ["ek-action-row", "ek-fate-row", "ek-name-picker"]) {
      expect(follows(keys, within(panel).getByTestId(id)), id).toBe(true);
    }

    keyIn(panel, ",");
    keyIn(panel, "1");
    expect(within(panel).getByTestId("ek-keypad-display")).toHaveTextContent("7,1");
    expect(aboveTheKeys(panel)).toEqual(before);
  });

  it("in limit → out of limit → out of range → empty: the same boxes above the keys every time", () => {
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    const before = aboveTheKeys(panel);
    keyIn(panel, "3");
    expect(within(panel).getByTestId("ek-keypad-hint")).toHaveTextContent(da.ekInLimit);
    expect(aboveTheKeys(panel)).toEqual(before);
    keyIn(panel, "3"); // 33 °C on a fridge: out of limit
    expect(within(panel).getByTestId("ek-keypad-hint")).toHaveTextContent(da.ekTooWarm);
    expect(aboveTheKeys(panel)).toEqual(before);
    keyIn(panel, "3"); // 333 °C: out of the keypad's range
    expect(within(panel).getByTestId("ek-keypad-hint")).toHaveTextContent(da.ekOutOfRange);
    expect(aboveTheKeys(panel)).toEqual(before);
    for (let i = 0; i < 3; i++) fireEvent.click(within(panel).getByRole("button", { name: da.ekKeyBackspace }));
    expect(within(panel).getByTestId("ek-keypad-hint")).toBeEmptyDOMElement();
    expect(aboveTheKeys(panel)).toEqual(before);
  });

  it("the kitchen's Sheet (portrait iPad) is top-anchored and fixed-height on a phone; typing '7' changes neither", async () => {
    render(
      <MemoryRouter initialEntries={["/kitchen/kt_ABCdef123456"]}>
        <Routes>
          <Route path="/kitchen/:kitchenToken" element={<KitchenPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();
    fireEvent.click(within(screen.getByTestId("ek-row-c-k1")).getAllByRole("button")[0]);
    const dialog = screen.getByRole("dialog", { name: da.ekRecord });
    const box = dialog.querySelector("[data-sheet-panel]");
    const panel = within(dialog).getByTestId("ek-record-panel");
    // ≥ sm (the iPad): anchored to the top, never vertically centred.
    expect(toks(dialog)).toEqual(expect.arrayContaining(["sm:items-start", "sm:justify-center"]));
    expect(toks(dialog)).not.toContain("sm:items-center");
    // < sm (a phone): a bottom sheet of FIXED height, so it cannot grow upward.
    expect(toks(box)).toEqual(expect.arrayContaining(["h-[92dvh]", "max-h-[92dvh]", "sm:h-auto"]));
    // The panel fills that height (the button stays at the bottom edge).
    expect(toks(panel)).toEqual(expect.arrayContaining(["grow", "min-h-0"]));
    const before = [dialog.className, box.className, aboveTheKeys(panel)];

    keyIn(panel, "7");
    expect(within(panel).getByTestId("ek-action-row")).toBeInTheDocument();
    expect([dialog.className, box.className, aboveTheKeys(panel)]).toEqual(before);
  });

  it("the owner's Målinger Sheet is the same top-anchored sheet", async () => {
    const routes = {
      "/egenkontrol/today": { ...TODAY, checks: [FRIDGE] },
      "/egenkontrol/checks": { checks: [FRIDGE], archived: [] },
      "/egenkontrol/templates": { cutoff_hour: 6, timezone: "Europe/Copenhagen", templates: [] },
      "/egenkontrol/staff": { staff: STAFF },
      "/egenkontrol/devices": { devices: [] },
    };
    h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
    render(<MemoryRouter initialEntries={["/egenkontrol"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    fireEvent.click(within(screen.getByTestId("ek-row-c-k1")).getAllByRole("button")[0]);
    const dialog = screen.getByRole("dialog", { name: da.ekRecord });
    expect(toks(dialog)).toContain("sm:items-start");
    expect(toks(dialog)).not.toContain("sm:items-center");
    expect(toks(dialog.querySelector("[data-sheet-panel]"))).toContain("h-[92dvh]");
  });

  it("ui/Sheet: 'top' is opt-in — the default centred card and the right drawer are unchanged", () => {
    const { unmount } = render(<Sheet onClose={() => {}} ariaLabel="c">x</Sheet>);
    let d = screen.getByRole("dialog", { name: "c" });
    expect(toks(d)).toEqual(expect.arrayContaining(["items-end", "sm:items-center", "sm:justify-center"]));
    expect(toks(d.querySelector("[data-sheet-panel]"))).not.toContain("h-[92dvh]");
    unmount();
    render(<Sheet onClose={() => {}} ariaLabel="r" desktop="right">x</Sheet>);
    d = screen.getByRole("dialog", { name: "r" });
    expect(toks(d)).toEqual(expect.arrayContaining(["sm:items-stretch", "sm:justify-end"]));
  });
});

// ─── 2. The next step scrolls into view and is focused ──────────────────

/** Lay the panel out: a 400 px tall scroll area at y=100; the steps far below it. */
function layOut(panel, positions) {
  const scroller = panel.querySelector("[data-ek-scroll]");
  scroller.scrollTo = vi.fn();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this === scroller) return rect(100, 400);
    for (const [sel, r] of positions) if (this.matches(sel)) return r;
    return rect(0, 0);
  });
  return scroller;
}

describe("2 — a tap on the not-ready button goes to the first missing step", () => {
  it("'Vælg hvem der målte': scrolls the panel to 'Hvem målte?', focuses the first name, saves nothing", async () => {
    const onSave = vi.fn();
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={null} onSave={onSave} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    keyIn(panel, "3");
    const cta = within(panel).getByTestId("ek-save");
    expect(cta).toHaveTextContent(da.ekCtaChooseName);
    expect(cta).toHaveAttribute("aria-disabled", "true");
    expect(cta).not.toBeDisabled(); // tappable: never a dead end

    const scroller = layOut(panel, [['[data-ek-step="name"]', rect(900, 150)]]);
    await act(async () => { fireEvent.click(cta); });
    // Centred in the 400 px view: 900 − 100 − (400 − 150) / 2 = 675.
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 675 }));
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: /Ali K\./ }));
    expect(within(panel).getByTestId("ek-name-picker").querySelector("legend").className).toMatch(/text-red-700/);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("out of limit, in order: action → food fate → name", async () => {
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    keyIn(panel, "7");
    const cta = () => within(panel).getByTestId("ek-save");
    const scroller = layOut(panel, [
      ['[data-ek-step="action"]', rect(700, 120)],
      ['[data-ek-step="fate"]', rect(840, 120)],
      ['[data-ek-step="name"]', rect(1100, 150)],
    ]);

    expect(cta()).toHaveTextContent(da.ekCtaChooseAction);
    await act(async () => { fireEvent.click(cta()); });
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: da.ekActThermostatAdjusted }));
    expect(scroller.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 460 })); // 700 − 100 − 140
    fireEvent.click(within(panel).getByRole("button", { name: da.ekActThermostatAdjusted }));

    expect(cta()).toHaveTextContent(da.ekCtaChooseFate);
    await act(async () => { fireEvent.click(cta()); });
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: da.ekFateMoved }));
    expect(scroller.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 600 })); // 840 − 100 − 140
    fireEvent.click(within(panel).getByRole("button", { name: da.ekFateMoved }));

    expect(cta()).toHaveTextContent(da.ekCtaChooseName);
    await act(async () => { fireEvent.click(cta()); });
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: /Ali K\./ }));
  });

  it("'Andet' chosen with nothing typed: the tap focuses that empty field", async () => {
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    keyIn(panel, "7");
    const actionRow = within(panel).getByTestId("ek-action-row");
    fireEvent.click(within(actionRow).getByRole("button", { name: da.ekActOther }));
    layOut(panel, [['[data-ek-step="action"]', rect(700, 200)]]);
    await act(async () => { fireEvent.click(within(panel).getByTestId("ek-save")); });
    expect(document.activeElement).toBe(within(actionRow).getByPlaceholderText(da.ekOtherActionPlaceholder));
  });

  it("while saving the button is truly disabled (no double send), and a ready button saves", async () => {
    let finish;
    const onSave = vi.fn(() => new Promise((r) => { finish = r; }));
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={{ kind: "staff", id: "s-ali", label: "Ali K." }} onSave={onSave} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    keyIn(panel, "3");
    const cta = within(panel).getByTestId("ek-save");
    expect(cta).not.toHaveAttribute("aria-disabled");
    await act(async () => { fireEvent.click(cta); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(cta).toBeDisabled();
    expect(cta).not.toHaveAttribute("aria-disabled");
    await act(async () => { fireEvent.click(cta); });
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, entry: { id: "e1" } }); });
  });
});

describe("2 — 'Andet navn' focuses its field and scrolls it into view", () => {
  it("in the same tap: the field is focused (letters go there) and the panel scrolls to it", () => {
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    const scroller = layOut(panel, [["#ek-other-name", rect(1000, 56)]]);
    fireEvent.click(within(panel).getByRole("button", { name: da.ekOtherName }));
    const input = within(panel).getByPlaceholderText(da.ekOtherNamePlaceholder);
    expect(document.activeElement).toBe(input);
    // 1000 − 100 − (400 − 56) / 2 = 728
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 728 }));
    fireEvent.change(input, { target: { value: "Sofie" } });
    keyIn(panel, "3");
    expect(within(panel).getByTestId("ek-save")).toHaveTextContent("Gem 3,0 °C");
  });

  it("once the keyboard has shrunk the view, the focused field is put back in view", () => {
    vi.useFakeTimers();
    const listeners = new Set();
    window.visualViewport = {
      height: 1180, offsetTop: 0,
      addEventListener: (type, fn) => { if (type === "resize") listeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === "resize") listeners.delete(fn); },
    };
    render(<RecordPanel check={FRIDGE} staff={STAFF} heldWho={null} onSave={vi.fn()} t={t} lang="da" />);
    const panel = screen.getByTestId("ek-record-panel");
    let inputTop = 300; // fully visible when it opens: no scroll needed yet
    const scroller = panel.querySelector("[data-ek-scroll]");
    scroller.scrollTo = vi.fn();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this === scroller) return rect(100, 400);
      if (this.id === "ek-other-name") return rect(inputTop, 56);
      return rect(0, 0);
    });
    fireEvent.click(within(panel).getByRole("button", { name: da.ekOtherName }));
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    // The keyboard comes up; the Sheet shrinks; the field is now below the view.
    inputTop = 700;
    act(() => { for (const fn of [...listeners]) fn(); });
    act(() => { vi.advanceTimersByTime(100); });
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 428 })); // 700 − 100 − 172
    // The listener is gone after the keyboard's moment.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(listeners.size).toBe(0);
  });
});

// ─── 4. 'Første måling i morgen kl. 08:00' ──────────────────────────────

describe("4 — the empty day says when the first reading is", () => {
  it("firstReadingLine: tomorrow / a weekday / a date; null when nothing is coming", () => {
    expect(firstReadingLine([FRIDGE_AFTER_SETUP], "2026-11-12", t, "da")).toBe("Første måling i morgen kl. 08:00");
    expect(firstReadingLine([FRIDGE_AFTER_SETUP], "2026-11-12", tEn, "en")).toBe("First reading tomorrow at 08:00");
    const monday = { ...FRIDGE_AFTER_SETUP, slot: { ...FRIDGE_AFTER_SETUP.slot, due_at: "2026-11-16T06:00:00Z", due_local: "07:00", business_date: "2026-11-16" } };
    expect(firstReadingLine([monday], "2026-11-12", t, "da")).toBe("Første måling mandag kl. 07:00");
    expect(firstReadingLine([monday], "2026-11-12", tEn, "en")).toBe("First reading Monday at 07:00");
    const nextWeek = { ...monday, slot: { ...monday.slot, due_at: "2026-11-19T06:00:00Z", business_date: "2026-11-19" } };
    expect(firstReadingLine([nextWeek], "2026-11-12", t, "da")).toBe("Første måling torsdag 19. november kl. 07:00");
    // The earliest one wins, whatever the order.
    expect(firstReadingLine([monday, FRIDGE_AFTER_SETUP], "2026-11-12", t, "da")).toBe("Første måling i morgen kl. 08:00");
    // Nothing scheduled ahead (on_event only), or a slot that IS today: null.
    expect(firstReadingLine([REHEATING], "2026-11-12", t, "da")).toBeNull();
    expect(firstReadingLine([FRIDGE], "2026-11-12", t, "da")).toBeNull();
    expect(firstReadingLine([], "2026-11-12", t, "da")).toBeNull();
    expect(firstReadingLine([FRIDGE_AFTER_SETUP], null, t, "da")).toBeNull();
  });

  it("kitchen: 'Første måling i morgen kl. 08:00' right after setup at 20:36", async () => {
    h.today.mockResolvedValue({ ...TODAY, server_now: "2026-11-12T19:36:00Z", checks: [FRIDGE_AFTER_SETUP, REHEATING], summary: NO_SLOT_TODAY });
    render(
      <MemoryRouter initialEntries={["/kitchen/kt_ABCdef123456"]}>
        <Routes><Route path="/kitchen/:kitchenToken" element={<KitchenPage />} /></Routes>
      </MemoryRouter>,
    );
    await settle();
    expect(screen.getByTestId("ek-kitchen-progress")).toHaveTextContent("Første måling i morgen kl. 08:00");
    expect(screen.getByTestId("ek-kitchen-progress")).not.toHaveTextContent(da.ekKitchenNoScheduled);
  });

  it("kitchen: only 'når det sker' checks — 'Ingen faste målinger i dag' stays (it is true)", async () => {
    h.today.mockResolvedValue({ ...TODAY, checks: [REHEATING], summary: NO_SLOT_TODAY });
    render(
      <MemoryRouter initialEntries={["/kitchen/kt_ABCdef123456"]}>
        <Routes><Route path="/kitchen/:kitchenToken" element={<KitchenPage />} /></Routes>
      </MemoryRouter>,
    );
    await settle();
    expect(screen.getByTestId("ek-kitchen-progress")).toHaveTextContent(da.ekKitchenNoScheduled);
  });

  it("owner page: the same line over the list", async () => {
    const routes = {
      "/egenkontrol/today": { ...TODAY, checks: [FRIDGE_AFTER_SETUP], summary: NO_SLOT_TODAY },
      "/egenkontrol/checks": { checks: [FRIDGE_AFTER_SETUP], archived: [] },
      "/egenkontrol/templates": { cutoff_hour: 6, timezone: "Europe/Copenhagen", templates: [] },
      "/egenkontrol/staff": { staff: STAFF },
      "/egenkontrol/devices": { devices: [] },
    };
    h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
    render(<MemoryRouter initialEntries={["/egenkontrol"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    expect(screen.getByTestId("ek-owner-progress")).toHaveTextContent("Første måling i morgen kl. 08:00");
  });

  it("both screens use the one helper (no second copy of the rule)", () => {
    for (const f of ["pages/KitchenPage.jsx", "pages/EgenkontrolPage.jsx"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src, f).toMatch(/firstReadingLine\(checks, today\?\.business_date, t, lang\) \|\| t\("ekKitchenNoScheduled"\)/);
    }
  });
});
