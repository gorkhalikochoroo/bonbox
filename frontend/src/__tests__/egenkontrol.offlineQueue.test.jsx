/**
 * Egenkontrol R1b — the offline queue survives a reload (plan R1b, moved from
 * R1a; acceptance "Wi-Fi off mid-save, three readings queued, reload, Wi-Fi
 * back: all three are saved once"):
 *   • three failed saves → three items on the device, three distinct
 *     client_ids, the exact first-sent bodies (client_business_date included);
 *   • unmount + mount again (a reload) → restored; NOTHING is sent before
 *     /today has answered; then the three go with the SAME client_ids and
 *     bodies, and the device's queue is empty;
 *   • a restored item the server refuses (422) → "Kræver handling";
 *   • 409 business_day_changed → stale, never sent again (not even online);
 *   • a failed item typed on another business day is sent ONCE (same
 *     body): the server's replay (200) means it was stored → dropped, no
 *     paper; only its 409 business_day_changed makes it stale — then the
 *     kitchen says "Skriv den på papir", the owner gets a "Fra papir" button;
 *   • "Fjern" asks through useConfirm first;
 *   • storage that throws → the R1a in-memory queue + a beforeunload warning;
 *   • the revoked screen lists what was not saved, and "Par igen" clears it.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.offlineQueue
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({
  today: vi.fn(),
  staff: vi.fn(),
  saveEntry: vi.fn(),
  uploadPhoto: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  forget: vi.fn(),
}));

vi.mock("../services/kitchenApi", () => ({
  default: {
    today: h.today, staff: h.staff, saveEntry: h.saveEntry, undo: vi.fn(), folder: vi.fn(), unpair: vi.fn(),
    uploadPhoto: h.uploadPhoto, photo: vi.fn(), documentFile: vi.fn(),
  },
  KITCHEN_TOKEN_RE: /^[A-Za-z0-9_-]{8,128}$/,
  forgetKitchenToken: h.forget,
  rememberKitchenToken: vi.fn(),
  rememberedKitchenToken: () => null,
  rememberedKitchenVenue: () => null,
}));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a),
    post: (...a) => h.post(...a),
    put: vi.fn(),
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
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u-owner-1", role: "owner", business_type: "cafe" } }) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn() }));

const KitchenPage = (await import("../pages/KitchenPage")).default;
const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const { kitchenQueueKey, ownerQueueKey, readQueue } = await import("../components/egenkontrol/usePendingEntries");
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const TOKEN = "kt_ABCdef123456";
const KEY = kitchenQueueKey(TOKEN);
const mk = (id, name) => ({
  id, name, note: null, kind: "temp_max", template_key: "fridge", group_key: "temperatures",
  branch_id: null, sort_order: 0, active: true, archived_at: null,
  limit: { limit_c: 5, direction: "max", source: "law", ref: null }, product_limits: null,
  schedule: { type: "daily", due: "08:00" }, schedule_options: ["daily", "weekly", "on_event"], recheck_min: 30,
  action_codes: ["thermostat_adjusted", "other"], fate_codes: ["moved", "discarded", "other"],
  status: "due", slot: { due_at: "2026-11-12T07:00:00Z", due_local: "08:00" }, last: null, open_deviation: null,
});
const CHECKS = [mk("c-1", "Køl 1"), mk("c-2", "Køl 2"), mk("c-3", "Køl 3")];
const TODAY = {
  business_date: "2026-11-12", server_now: "2026-11-12T07:05:00Z", timezone: "Europe/Copenhagen", cutoff_hour: 6, setup_done: true,
  checks: CHECKS, summary: { total: 3, done: 0, missing: 0, due: 3, open_deviations: 0 },
  venue_name: "Café Sol", device_label: "Køkken-iPad", branch_name: null,
};
const entryFor = (body, i = 0) => ({
  id: `e-${i}`, check_id: body.check_id, client_id: body.client_id, recorded_at: "2026-11-12T07:05:00Z", recorded_local: "08:05",
  recorded_local_date: "2026-11-12", value_c: body.value_c, late: false, deviation_state: null, staff_name: "Ali K.",
  name_source: "picked", via: "kitchen", voided_at: null, undo_until: "2026-11-12T07:07:00Z", slot_due_local: "08:00",
});
const network = () => Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const kitchen = () =>
  render(
    <MemoryRouter initialEntries={[`/kitchen/${TOKEN}`]}>
      <Routes>
        <Route path="/kitchen/:kitchenToken" element={<KitchenPage />} />
      </Routes>
    </MemoryRouter>,
  );

async function recordOn(checkId, digits) {
  fireEvent.click(within(screen.getByTestId(`ek-row-${checkId}`)).getAllByRole("button")[0]);
  const panel = screen.getByTestId("ek-record-panel");
  for (const k of digits) fireEvent.click(within(panel).getByRole("button", { name: k === "," ? da.ekKeyDecimal : k }));
  fireEvent.click(within(panel).getByRole("button", { name: /Ali K\./ }));
  await act(async () => { fireEvent.click(within(panel).getByTestId("ek-save")); });
  await settle();
}

const item = (over = {}) => ({
  v: 1, clientId: "11111111-1111-4111-8111-111111111111", checkId: "c-1", checkName: "Køl 1",
  body: {
    client_id: "11111111-1111-4111-8111-111111111111", check_id: "c-1", value_c: 3.1, staff_id: "s-ali", typed_name: null,
    client_typed_at: "2026-11-12T07:01:00.000Z", client_business_date: "2026-11-12",
  },
  draft: { entry: "3,1", who: { kind: "staff", id: "s-ali", label: "Ali K." } },
  businessDate: "2026-11-12", typedAt: "2026-11-12T07:01:00.000Z", state: "failed", code: null, missing: [], hadPhoto: false,
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.today.mockResolvedValue(TODAY);
  h.staff.mockResolvedValue({ staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] });
  h.confirm.mockResolvedValue(true);
  __resetEgenkontrolStatus();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("three readings typed offline survive a reload and are saved once", () => {
  it("three failed saves → three stored items; reload → nothing sent before /today; then the same three bodies", async () => {
    h.saveEntry.mockRejectedValue(network());
    const first = kitchen();
    await settle();
    await recordOn("c-1", ["3", ",", "1"]);
    await recordOn("c-2", ["2", ",", "5"]);
    await recordOn("c-3", ["4"]);
    expect(h.saveEntry).toHaveBeenCalledTimes(3);
    const sent = h.saveEntry.mock.calls.map((c) => c[1]);
    expect(new Set(sent.map((b) => b.client_id)).size).toBe(3);
    for (const b of sent) expect(b.client_business_date).toBe("2026-11-12");

    const stored = JSON.parse(localStorage.getItem(KEY));
    expect(stored).toHaveLength(3);
    expect(stored.map((x) => x.body)).toEqual(sent);
    expect(stored.every((x) => x.state === "failed" && x.v === 1)).toBe(true);
    // The token itself is never a storage key.
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys).toContain(KEY);
    expect(keys.some((k) => k.includes(TOKEN))).toBe(false);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(KEY).toMatch(/^bonbox_ek_queue_v1:k:[0-9a-f]{8}$/);

    // "Reload": a new page; /today is slow.
    first.unmount();
    let answerToday;
    h.today.mockImplementation(() => new Promise((r) => { answerToday = r; }));
    h.saveEntry.mockReset();
    h.saveEntry.mockImplementation(async (tok, body) => entryFor(body));
    kitchen();
    await settle();
    expect(readQueue(KEY).items).toHaveLength(3);
    expect(h.saveEntry).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(h.saveEntry).not.toHaveBeenCalled(); // still no /today: nothing goes

    await act(async () => { answerToday(TODAY); });
    await settle(12);
    expect(h.saveEntry).toHaveBeenCalledTimes(3);
    expect(h.saveEntry.mock.calls.map((c) => c[1])).toEqual(sent);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByTestId("ek-pending-failed")).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Køl 1 · 3,1 °C · gemt" }));
  });

  it("a restored item the server refuses (422) → 'Kræver handling'", async () => {
    localStorage.setItem(KEY, JSON.stringify([item()]));
    h.saveEntry.mockRejectedValue({ response: { status: 422, data: { detail: { code: "deviation_fields_required", missing: ["action"] } } } });
    kitchen();
    await settle(12);
    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId("ek-row-c-1")).getByTestId("ek-pending-needs-action")).toHaveTextContent(da.ekNeedsAction);
  });

  it("409 business_day_changed → stale, and never sent again (not even when online)", async () => {
    localStorage.setItem(KEY, JSON.stringify([item()]));
    h.saveEntry.mockRejectedValue({ response: { status: 409, data: { detail: { code: "business_day_changed", server_business_date: "2026-11-13" } } } });
    kitchen();
    await settle(12);
    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    const stale = within(screen.getByTestId("ek-row-c-1")).getByTestId("ek-pending-stale");
    expect(stale).toHaveTextContent("Skriv den på papir.");
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(KEY))[0].state).toBe("stale");
  });

  const YESTERDAY = {
    businessDate: "2026-11-11", typedAt: "2026-11-11T07:01:00.000Z",
    body: { ...item().body, client_business_date: "2026-11-11", client_typed_at: "2026-11-11T07:01:00.000Z" },
  };
  const DAY_CHANGED = { response: { status: 409, data: { detail: { code: "business_day_changed", server_business_date: "2026-11-12" } } } };

  it("typed on an earlier business day → asked ONCE with the same body; the server's 409 → stale: 'Ikke sendt · tastet … Skriv den på papir.'", async () => {
    localStorage.setItem(KEY, JSON.stringify([item(YESTERDAY)]));
    h.saveEntry.mockRejectedValue(DAY_CHANGED);
    kitchen();
    await settle(12);
    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    expect(h.saveEntry.mock.calls[0][1]).toEqual(YESTERDAY.body); // the exact body: same client_id, its own day
    const stale = within(screen.getByTestId("ek-row-c-1")).getByTestId("ek-pending-stale");
    expect(stale).toHaveTextContent(/Ikke sendt · tastet .+ kl\. \d\d:\d\d \(iPad'ens ur\)\. Skriv den på papir\./);
    expect(stale).toHaveTextContent("3,1 °C");
    expect(within(stale).queryByTestId("ek-pending-paper")).toBeNull(); // the kitchen has no "Fra papir"
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    expect(h.saveEntry).toHaveBeenCalledTimes(1);                     // stale is never sent again
  });

  it("typed on an earlier business day but already STORED (the response was lost): the replay → dropped, never 'skriv på papir'", async () => {
    localStorage.setItem(KEY, JSON.stringify([item(YESTERDAY)]));
    h.saveEntry.mockImplementation(async (tok, body) => ({ ...entryFor(body, 3), business_date: "2026-11-11", undo_until: null }));
    kitchen();
    await settle(12);
    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("ek-pending-stale")).toBeNull();
    expect(screen.queryByTestId("ek-pending-failed")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Køl 1 · 3,1 °C · gemt" }));
  });

  it("an earlier-day item still unanswered (network) stays 'Ikke gemt endnu' — never 'Ikke sendt' on the device's own say-so", async () => {
    localStorage.setItem(KEY, JSON.stringify([item(YESTERDAY)]));
    h.saveEntry.mockRejectedValue(network());
    kitchen();
    await settle(12);
    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("ek-pending-stale")).toBeNull();
    expect(within(screen.getByTestId("ek-row-c-1")).getByTestId("ek-pending-failed")).toHaveTextContent(da.ekNotSavedYet);
  });

  it("an earlier-day item without client_business_date in its body cannot be asked safely → stale at once, never sent", async () => {
    const { client_business_date: _drop, ...noDay } = item().body;
    localStorage.setItem(KEY, JSON.stringify([item({ businessDate: "2026-11-11", body: noDay })]));
    kitchen();
    await settle(12);
    expect(h.saveEntry).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("ek-row-c-1")).getByTestId("ek-pending-stale")).toBeInTheDocument();
  });

  it("'Fjern' asks first (useConfirm); a no keeps it, a yes drops it from the device", async () => {
    localStorage.setItem(KEY, JSON.stringify([item(YESTERDAY)]));
    h.saveEntry.mockRejectedValue(DAY_CHANGED);
    kitchen();
    await settle(12);
    h.confirm.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(screen.getByTestId("ek-pending-discard")); });
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: da.ekQueueDiscardConfirmTitle, message: da.ekQueueDiscardConfirmBody }));
    expect(screen.getByTestId("ek-pending-stale")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId("ek-pending-discard")); });
    await settle();
    expect(screen.queryByTestId("ek-pending-stale")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("the owner: a stale reading offers 'Fra papir' (and 'Fjern')", async () => {
    const OKEY = ownerQueueKey("u-owner-1");
    localStorage.setItem(OKEY, JSON.stringify([item(YESTERDAY)]));
    h.post.mockRejectedValue(DAY_CHANGED);
    const routes = {
      "/egenkontrol/today": TODAY,
      "/egenkontrol/checks": { checks: CHECKS, archived: [] },
      "/egenkontrol/templates": { cutoff_hour: 6, templates: [] },
      "/egenkontrol/staff": { staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] },
    };
    h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
    render(<MemoryRouter initialEntries={["/egenkontrol"]}><EgenkontrolPage /></MemoryRouter>);
    await settle(12);
    expect(h.post).toHaveBeenCalledTimes(1);                           // asked once, the server said 409
    expect(h.post).toHaveBeenCalledWith("/egenkontrol/entries", YESTERDAY.body);
    const stale = within(screen.getByTestId("ek-row-c-1")).getByTestId("ek-pending-stale");
    expect(stale).toHaveTextContent("Tast den ind som 'Fra papir'.");
    expect(within(stale).getByTestId("ek-pending-paper")).toHaveTextContent(da.ekPaperTitle);
    expect(within(stale).getByTestId("ek-pending-discard")).toBeInTheDocument();
    // "Fra papir" opens the paper sheet, prefilled with the check and the typed day.
    await act(async () => { fireEvent.click(within(stale).getByTestId("ek-pending-paper")); });
    const dialog = screen.getByRole("dialog", { name: da.ekPaperTitle });
    expect(within(dialog).getByTestId("ek-paper-check")).toHaveValue("c-1");
    expect(within(dialog).getByTestId("ek-paper-date")).toHaveValue("2026-11-11");
  });
});

describe("a photo never survives a reload (it is not stored) — and the row says so", () => {
  it("a restored reading that had a photo: saved, then 'Fotoet blev ikke gemt. Tag det igen …' with a camera button", async () => {
    localStorage.setItem(KEY, JSON.stringify([item({ hadPhoto: true })]));
    expect(JSON.parse(localStorage.getItem(KEY))[0]).not.toHaveProperty("photo");
    h.saveEntry.mockImplementation(async (tok, body) => entryFor(body, 7));
    kitchen();
    await settle(12);
    expect(h.saveEntry).toHaveBeenCalledTimes(1);
    expect(h.uploadPhoto).not.toHaveBeenCalled();
    const lost = within(screen.getByTestId("ek-row-c-1")).getByTestId("ek-photo-lost");
    expect(lost).toHaveTextContent(da.ekPhotoLost);
    // Taking it again adds it to the now-saved reading.
    h.uploadPhoto.mockResolvedValue({ id: "p-1" });
    const input = within(lost).getByTestId("ek-photo-lost-take-input");
    await act(async () => { fireEvent.change(input, { target: { files: [new File([new Uint8Array([0xff, 0xd8, 0xff])], "f.jpg", { type: "image/jpeg" })] } }); });
    await settle();
    expect(h.uploadPhoto).toHaveBeenCalledWith(TOKEN, "e-7", expect.any(File));
    expect(within(screen.getByTestId("ek-row-c-1")).queryByTestId("ek-photo-lost")).toBeNull();
  });
});

describe("storage that does not work: the R1a in-memory queue + a warning before a reload", () => {
  it("getItem/setItem throw → the reading stays on the row, beforeunload is armed", async () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const add = vi.spyOn(window, "addEventListener");
    h.saveEntry.mockRejectedValue(network());
    kitchen();
    await settle();
    await recordOn("c-1", ["3"]);
    expect(within(screen.getByTestId("ek-row-c-1")).getByTestId("ek-pending-failed")).toHaveTextContent(da.ekNotSavedYet);
    expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
  });

  it("with storage working, an unsent READING alone does not arm beforeunload (it is kept)", async () => {
    const add = vi.spyOn(window, "addEventListener");
    h.saveEntry.mockRejectedValue(network());
    kitchen();
    await settle();
    await recordOn("c-1", ["3"]);
    expect(add.mock.calls.some(([type]) => type === "beforeunload")).toBe(false);
  });
});

describe("the revoked screen lists what this iPad still held", () => {
  it("check · value · typed time · who, then 'Par igen' asks first (useConfirm) and only a yes clears the queue", async () => {
    localStorage.setItem(KEY, JSON.stringify([item({ state: "needs_action" })]));
    h.today.mockRejectedValue({ response: { status: 404, data: { error: "not_found" } } });
    const realLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign: vi.fn() } });
    try {
      kitchen();
      await settle();
      const card = screen.getByTestId("ek-kitchen-revoked");
      expect(card).toHaveTextContent("1 målinger blev ikke gemt. Skriv dem på papir.");
      const list = within(card).getByTestId("ek-kitchen-unsent-list");
      expect(list).toHaveTextContent(da.ekKitchenUnsentList);
      expect(list).toHaveTextContent("Køl 1");
      expect(list).toHaveTextContent("3,1 °C");
      expect(list).toHaveTextContent("Ali K.");
      expect(list).toHaveTextContent(/\d\d:\d\d/);
      // A no keeps the readings on the iPad.
      h.confirm.mockResolvedValueOnce(false);
      await act(async () => { fireEvent.click(within(card).getByRole("button", { name: da.ekKitchenPairAgain })); });
      expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({
        title: da.ekKitchenPairAgainConfirmTitle,
        message: "1 målinger, der ikke blev gemt, slettes fra iPad'en og kan ikke hentes tilbage.",
        destructive: true,
      }));
      expect(readQueue(KEY).items).toHaveLength(1);
      expect(window.location.assign).not.toHaveBeenCalled();
      // A yes clears them and goes to pairing.
      await act(async () => { fireEvent.click(within(card).getByRole("button", { name: da.ekKitchenPairAgain })); });
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(window.location.assign).toHaveBeenCalledWith("/stand");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: realLocation });
    }
  });

  it("nothing unsent → 'Par igen' goes straight to pairing, no question", async () => {
    h.today.mockRejectedValue({ response: { status: 404, data: { error: "not_found" } } });
    const realLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign: vi.fn() } });
    try {
      kitchen();
      await settle();
      const card = screen.getByTestId("ek-kitchen-revoked");
      await act(async () => { fireEvent.click(within(card).getByRole("button", { name: da.ekKitchenPairAgain })); });
      expect(h.confirm).not.toHaveBeenCalled();
      expect(window.location.assign).toHaveBeenCalledWith("/stand");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: realLocation });
    }
  });
});

describe("an offline reload: /today fails, but the readings still on the device are shown — and go when the network is back", () => {
  it("kitchen: 'N målinger venter …' with the list; 'online' fetches /today at once and sends them", async () => {
    localStorage.setItem(KEY, JSON.stringify([item(), item({ clientId: "22222222-2222-4222-8222-222222222222", checkId: "c-2", checkName: "Køl 2",
      body: { ...item().body, client_id: "22222222-2222-4222-8222-222222222222", check_id: "c-2", value_c: 2.5 } })]));
    h.today.mockRejectedValue(network());
    h.saveEntry.mockImplementation(async (tok, body) => entryFor(body));
    kitchen();
    await settle();
    const waiting = screen.getByTestId("ek-kitchen-waiting");
    expect(waiting).toHaveTextContent("2 målinger venter på denne enhed og sendes, når nettet er tilbage.");
    expect(within(waiting).getByTestId("ek-kitchen-unsent-list")).toHaveTextContent(da.ekQueueWaitingList);
    expect(within(waiting).getByTestId("ek-kitchen-unsent-list")).not.toHaveTextContent(da.ekKitchenUnsentList);
    expect(waiting).toHaveTextContent("Køl 1");
    expect(waiting).toHaveTextContent("Køl 2");
    expect(h.saveEntry).not.toHaveBeenCalled();
    h.today.mockResolvedValue(TODAY);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle(12);
    expect(h.saveEntry).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByTestId("ek-kitchen-waiting")).toBeNull();
  });

  it("owner: the same line under 'kunne ikke hentes'; 'online' refetches /today (no tap) and the queue goes", async () => {
    const OKEY = ownerQueueKey("u-owner-1");
    localStorage.setItem(OKEY, JSON.stringify([item()]));
    let todayUp = false;
    const routes = {
      "/egenkontrol/checks": { checks: CHECKS, archived: [] },
      "/egenkontrol/templates": { cutoff_hour: 6, templates: [] },
      "/egenkontrol/staff": { staff: [{ id: "s-ali", name: "Ali K.", on_shift: true }] },
    };
    h.get.mockImplementation((url) => {
      if (url === "/egenkontrol/today") return todayUp ? Promise.resolve({ data: TODAY }) : Promise.reject(network());
      return url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } });
    });
    h.post.mockImplementation(async (url, body) => ({ data: entryFor(body) }));
    render(<MemoryRouter initialEntries={["/egenkontrol"]}><EgenkontrolPage /></MemoryRouter>);
    await settle(12);
    const waiting = screen.getByTestId("ek-owner-waiting");
    expect(waiting).toHaveTextContent("1 målinger venter på denne enhed og sendes, når nettet er tilbage.");
    expect(waiting).toHaveTextContent("Køl 1");
    expect(h.post).not.toHaveBeenCalled();
    todayUp = true;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle(12);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("/egenkontrol/entries", item().body);
    expect(localStorage.getItem(OKEY)).toBeNull();
    expect(screen.queryByTestId("ek-owner-waiting")).toBeNull();
  });
});
