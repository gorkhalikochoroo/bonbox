/**
 * R10 — the door iPad stays on, walked on screen.
 *
 * The paired door device (/stand/<token>) at 19:00 on a busy evening:
 *   • a refresh that fails keeps the night on screen and says, quietly,
 *     "Offline · showing the book from 19.00" — never an empty night;
 *   • two polls that cannot reach BonBox, or the browser going offline, say
 *     the same; a poll that proves the book current clears it;
 *   • a restart with the wifi down: words and "Try again", the page keeps
 *     asking by itself, and nothing says "no reservations" or "0 guests";
 *   • a removed device: one calm screen, no guests, never "not_found" — and a
 *     stray 404 never takes the book away;
 *   • the book tells the 20-second check its day and revision, and reloads
 *     when the check says the day moved;
 *   • "Disconnect this screen" instead of the owner's "Log ud";
 *   • the live poll: the day on screen, a quiet reload (no toast, no sound),
 *     a backoff while BonBox is away, one question per wake;
 *   • /stand reopens the remembered book after a restart.
 *
 * Run: cd frontend && npx vitest run src/__tests__/r10.doorStaysOn.test.jsx
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const h = vi.hoisted(() => ({
  user: null,
  confirm: vi.fn(async () => true),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: h.user, logout: vi.fn(async () => {}), loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (_k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      return String(typeof fb === "string" ? fb : _k).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));
    },
    lang: "en",
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, isReady: true }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));
vi.mock("../hooks/useToast", () => ({ useToast: () => h.toast }));
vi.mock("../utils/sound", () => ({
  getSoundStatus: () => ({ ok: true }),
  subscribeSound: () => () => {},
  testSound: vi.fn(),
  playChime: vi.fn(),
  playUrgent: vi.fn(),
  playCancel: vi.fn(),
  unlockSound: vi.fn(),
  prepareSoundWhenIdle: vi.fn(() => () => {}),
}));

import api from "../services/api";
import * as sound from "../utils/sound";
import ReservationsPage from "../pages/ReservationsPage";
import StandPairPage from "../pages/StandPairPage";
import { LiveAlertsProvider } from "../hooks/useLiveAlerts";
import { RESERVATIONS_CHANGED_EVENT } from "../lib/liveAlertKinds";
import {
  BOOK_FRESH_EVENT,
  BOOK_UNREACHABLE_EVENT,
  unwatchBook,
  watchBook,
  watchedBook,
} from "../lib/bookLive";
import { rememberedStandToken, setStandToken } from "../services/standAuth";

const DAY = "2026-10-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const DEVICE = "/stand/tok-door-1";

const table = (id, seats, x, y) => ({ id, label: id, capacity_seats: seats, kind: "table", is_active: true, zone: "Sal", pos_x: x, pos_y: y });
const RESOURCES = [table("21", 2, 10, 20), table("23", 4, 40, 20), table("41", 2, 80, 80)];
const row = (id, name, tableId, status, from, to, party) => ({
  id, guest_name: name, resource_id: tableId, status, starts_at: at(from), ends_at: at(to),
  party_size: party, source: "manual", allergen_tags: [], seated_at: null, completed_at: null,
});
const BOOK = [
  row("a", "Birk Lauridsen", "21", "seated", "18:00", "19:30", 2),
  row("h", "Juhl Kristensen", null, "confirmed", "19:45", "21:45", 4),
];
const RULES = {
  settings: { turn_time_tiers: [{ up_to: 2, minutes: 90 }, { up_to: 8, minutes: 120 }], default_duration_min: 90 },
  hours_declared: false,
};
const netErr = () => Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
const http = (status, error) => ({ response: { status, data: { detail: error ? { error } : "x" } } });

// `over`: { url: () => Promise } answers chosen urls differently.
function mockApi(over = {}) {
  api.get.mockImplementation((url) => {
    if (over[url]) return over[url]();
    if (url === "/reservations/book") {
      return Promise.resolve({
        data: { date: DAY, reservations: BOOK, summary: { total: BOOK.length, covers: 6, by_status: {} }, rev: "rev-1" },
      });
    }
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 8 } });
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: RULES });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url === "/reservations/changes") return Promise.resolve({ data: { server_time: "2026-10-12T17:00:00", changes: [] } });
    if (url === "/reservations/month-load") return Promise.resolve({ data: { days: [] } });
    return Promise.resolve({ data: {} });
  });
  api.post.mockImplementation(() => Promise.resolve({ data: { ok: true } }));
}

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname}</span>;
}

const renderAt = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/stand/:standToken" element={<ReservationsPage />} />
        <Route path="/reservations/stand" element={<ReservationsPage />} />
        <Route path="/stand" element={<div><span>PAIR PAGE</span><Where /></div>} />
        <Route path="/login" element={<span>OWNER LOGIN</span>} />
      </Routes>
    </MemoryRouter>,
  );

const guestOnScreen = () => screen.queryAllByText(/Birk/).length > 0;
const offlineLine = () => document.querySelector("[data-book-offline]");
const fire = (name, detail) => act(() => { window.dispatchEvent(new CustomEvent(name, { detail })); });

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});

describe("the paired door device's book", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at("19:00")));
    vi.clearAllMocks();
    h.user = null; // a paired device has no session
    h.confirm = vi.fn(async () => true);
    try { localStorage.clear(); } catch { /* no storage */ }
    mockApi();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a failed refresh keeps the night on screen with a quiet Offline line — never an empty night", async () => {
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    expect(offlineLine()).toBeNull();

    mockApi({ "/reservations/book": () => Promise.reject(netErr()) });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(offlineLine()).not.toBeNull());
    expect(offlineLine().textContent).toBe("Offline · showing the book from 19.00");
    // The night is still there, and nothing claims it is empty or broken.
    expect(guestOnScreen()).toBe(true);
    expect(screen.queryByText(/No reservations for/)).toBeNull();
    expect(document.querySelector(".bg-red-50")).toBeNull();
    expect(document.querySelector("[data-book-unavailable]")).toBeNull();

    // BonBox answers again: the line goes.
    mockApi();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(offlineLine()).toBeNull());
    expect(guestOnScreen()).toBe(true);
  });

  it("a tap on Refresh is answered at once — the icon turns, the rows stay (no skeleton flash)", async () => {
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    let arrive;
    mockApi({ "/reservations/book": () => new Promise((res) => { arrive = res; }) });
    const btn = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("aria-busy")).toBe("true"));
    expect(btn.querySelector("svg").getAttribute("class")).toContain("animate-spin");
    expect(guestOnScreen()).toBe(true);
    await act(async () => {
      arrive({ data: { date: DAY, reservations: BOOK, summary: { total: 2, covers: 6, by_status: {} }, rev: "rev-2" } });
    });
    await waitFor(() => expect(btn.getAttribute("aria-busy")).toBeNull());
    expect(watchedBook()).toEqual({ day: DAY, rev: "rev-2" });
  });

  it("two polls that cannot reach BonBox say Offline; one blip does not; a matching revision clears it", async () => {
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    fire(BOOK_UNREACHABLE_EVENT, { failures: 1 });
    expect(offlineLine()).toBeNull();
    fire(BOOK_UNREACHABLE_EVENT, { failures: 2 });
    expect(offlineLine()).not.toBeNull();
    fire(BOOK_FRESH_EVENT, { day: DAY });
    expect(offlineLine()).toBeNull();
    // …and a poll that answers after a gap clears it too (an older server
    // sends no revision to match).
    fire(BOOK_UNREACHABLE_EVENT, { failures: 3 });
    expect(offlineLine()).not.toBeNull();
    fire(BOOK_UNREACHABLE_EVENT, { failures: 0 });
    expect(offlineLine()).toBeNull();
    expect(guestOnScreen()).toBe(true);
  });

  it("the browser going offline says so at once, over the book that stays", async () => {
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(offlineLine()).not.toBeNull();
    expect(guestOnScreen()).toBe(true);
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(offlineLine()).toBeNull();
  });

  it("a restart with the wifi down: words, Try again, no empty night and no confident zeros", async () => {
    mockApi({ "/reservations/book": () => Promise.reject(netErr()) });
    renderAt(DEVICE);
    const card = await waitFor(() => {
      const el = document.querySelector("[data-book-unavailable]");
      expect(el).not.toBeNull();
      return el;
    });
    expect(card.textContent).toContain("Couldn't load the book");
    expect(card.textContent).toContain("Couldn't reach BonBox — check the connection and try again.");
    expect(card.textContent).toContain("Trying again by itself");
    expect(screen.queryByText(/No reservations for/)).toBeNull();
    // The cockpit has no count to give: "—", never "0".
    const covers = screen.getAllByText("Covers")[0].closest("div,button");
    expect(covers.textContent).toContain("—");
    expect(covers.textContent).not.toMatch(/\d/);
    expect(document.querySelector(".bg-red-50")).toBeNull();
    // Never the owner login.
    expect(screen.queryByText("OWNER LOGIN")).toBeNull();

    mockApi();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    expect(document.querySelector("[data-book-unavailable]")).toBeNull();
  });

  it("a removed device: one calm screen, no guests, never 'not_found' — then a new code", async () => {
    setStandToken("tok-door-1"); // remembered from an earlier evening
    mockApi({
      "/reservations/book": () => Promise.reject(http(404, "not_found")),
      "/reservations/changes": () => Promise.reject(http(404, "not_found")),
    });
    renderAt(DEVICE);
    const gone = await waitFor(() => {
      const el = document.querySelector("[data-stand-gone]");
      expect(el).not.toBeNull();
      return el;
    });
    expect(gone.textContent).toContain("This screen isn't connected any more");
    expect(gone.textContent).toContain("Reservations → Settings");
    expect(document.body.textContent).not.toContain("not_found");
    expect(guestOnScreen()).toBe(false);
    expect(screen.queryByText("New booking")).toBeNull();
    expect(watchedBook()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Enter a new code" }));
    await waitFor(() => expect(screen.getByText("PAIR PAGE")).toBeTruthy());
    expect(rememberedStandToken()).toBeNull();
  });

  it("a stray 404 never takes the book away: the link is asked once more first", async () => {
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    // The book read 404s once, but the cheap probe answers: the link is alive.
    mockApi({ "/reservations/book": () => Promise.reject(http(404, "not_found")) });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(offlineLine()).not.toBeNull());
    expect(document.querySelector("[data-stand-gone]")).toBeNull();
    expect(guestOnScreen()).toBe(true);
    expect(api.get.mock.calls.map((c) => c[0])).toContain("/reservations/changes");
  });

  it("tells the 20-second check its day and revision, reloads on the check's word, and remembers the pairing", async () => {
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    expect(watchedBook()).toEqual({ day: DAY, rev: "rev-1" });
    expect(rememberedStandToken()).toBe("tok-door-1");

    const books = () => api.get.mock.calls.filter((c) => c[0] === "/reservations/book").length;
    const before = books();
    fire(RESERVATIONS_CHANGED_EVENT, { from: "live" });
    await waitFor(() => expect(books()).toBe(before + 1));
  });

  it("the page's own 'I changed something' reloads once — and not at all when its own reload landed", async () => {
    vi.useRealTimers();
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    // Settled: the tables and the door rules are in.
    await waitFor(() => expect(document.querySelector('[data-walkin="2"]')?.textContent).toContain("Free now"));
    const books = () => api.get.mock.calls.filter((c) => c[0] === "/reservations/book").length;
    const before = books();
    // No detail: the page's own event. With no reload of its own after it,
    // the book still reloads (the old contract) — once, after a moment.
    act(() => { window.dispatchEvent(new Event(RESERVATIONS_CHANGED_EVENT)); });
    expect(books()).toBe(before);
    await waitFor(() => expect(books()).toBe(before + 1), { timeout: 3000 });

    // The page's own event followed by its own reload (every action does
    // this): one request, not two.
    const mid = books();
    act(() => { window.dispatchEvent(new Event(RESERVATIONS_CHANGED_EVENT)); });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(books()).toBe(mid + 1));
    await act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
    expect(books()).toBe(mid + 1);
  });

  it("words, never the server's code, when a one-tap seat fails", async () => {
    renderAt(DEVICE);
    await waitFor(() => expect(document.querySelector('[data-walkin="2"]')?.textContent).toContain("Free now"));
    api.post.mockImplementation(() => Promise.reject(http(500, "boom_code")));
    fireEvent.click(document.querySelector('[data-walkin="2"]'));
    await waitFor(() => expect(screen.getByText("Couldn't seat the guests.")).toBeTruthy());
    expect(document.body.textContent).not.toContain("boom_code");
  });

  it("the device's menu says 'Disconnect this screen' — never the owner's Log ud", async () => {
    setStandToken("tok-door-1");
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Mere" }));
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("Disconnect this screen");
    expect(menu.textContent).not.toContain("Log ud");

    fireEvent.click(screen.getByRole("menuitem", { name: /Disconnect this screen/ }));
    await waitFor(() => expect(screen.getByText("PAIR PAGE")).toBeTruthy());
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ destructive: true, confirmLabel: "Disconnect" });
    expect(api.post).toHaveBeenCalledWith("/reservations/unpair", {});
    expect(rememberedStandToken()).toBeNull();
    expect(screen.queryByText("OWNER LOGIN")).toBeNull();
  });

  it("cancelled at the question: nothing is disconnected", async () => {
    h.confirm = vi.fn(async () => false);
    setStandToken("tok-door-1");
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Mere" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Disconnect this screen/ }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalledWith("/reservations/unpair", {});
    expect(rememberedStandToken()).toBe("tok-door-1");
  });

  it("BonBox unreachable on disconnect: the screen still lets go, and says the owner can remove it", async () => {
    setStandToken("tok-door-1");
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    api.post.mockImplementation(() => Promise.reject(netErr()));
    fireEvent.click(screen.getByRole("button", { name: "Mere" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Disconnect this screen/ }));
    await waitFor(() => expect(screen.getByText("PAIR PAGE")).toBeTruthy());
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ severity: "notice" }));
    expect(rememberedStandToken()).toBeNull();
  });

  it("a link that is already gone is no failure; a server without the route is", async () => {
    setStandToken("tok-door-1");
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    api.post.mockImplementation(() => Promise.reject(http(404, "not_found")));
    fireEvent.click(screen.getByRole("button", { name: "Mere" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Disconnect this screen/ }));
    await waitFor(() => expect(screen.getByText("PAIR PAGE")).toBeTruthy());
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("an older server without the unpair route: the screen lets go and says the owner can remove it", async () => {
    setStandToken("tok-door-1");
    renderAt(DEVICE);
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    // FastAPI's own 404 for a missing route carries no {error: "not_found"}.
    api.post.mockImplementation(() => Promise.reject({ response: { status: 404, data: { detail: "Not Found" } } }));
    fireEvent.click(screen.getByRole("button", { name: "Mere" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Disconnect this screen/ }));
    await waitFor(() => expect(screen.getByText("PAIR PAGE")).toBeTruthy());
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ severity: "notice" }));
    expect(rememberedStandToken()).toBeNull();
  });

  it("the owner's own pop-out keeps its Log ud", async () => {
    h.user = { id: "u1", business_type: "restaurant", business_name: "Havnen", role: "owner" };
    renderAt("/reservations/stand");
    await waitFor(() => expect(guestOnScreen()).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Mere" }));
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain("Log ud");
    expect(menu.textContent).not.toContain("Disconnect this screen");
  });
});

// ── the live poll ────────────────────────────────────────────────────

function mountPoll(path = DEVICE) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LiveAlertsProvider>
        <Routes><Route path="*" element={<div />} /></Routes>
      </LiveAlertsProvider>
    </MemoryRouter>,
  );
}
const changesCalls = () => api.get.mock.calls.filter((c) => c[0] === "/reservations/changes");
const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("the live poll keeps every open book current", () => {
  let events;
  const listen = (name) => {
    const fn = (e) => events.push({ name, detail: e.detail });
    window.addEventListener(name, fn);
    return () => window.removeEventListener(name, fn);
  };
  let stops = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(at("19:00")));
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.clearAllMocks();
    h.user = null;
    try { localStorage.clear(); } catch { /* no storage */ }
    events = [];
    stops = [RESERVATIONS_CHANGED_EVENT, BOOK_FRESH_EVENT, BOOK_UNREACHABLE_EVENT].map(listen);
    watchBook("test-book", DAY, "rev-1");
  });
  afterEach(() => {
    stops.forEach((s) => s());
    unwatchBook("test-book");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const answer = (extra = {}) =>
    api.get.mockResolvedValue({ data: { server_time: "2026-10-12T17:00:00", changes: [], ...extra } });

  it("names the day on screen, and a different revision reloads it quietly — no toast, no sound", async () => {
    answer({ book_day: DAY, book_rev: "rev-2" });
    mountPoll();
    await advance(0);
    const [url, cfg] = changesCalls()[0];
    expect(url).toBe("/reservations/changes");
    expect(cfg.params).toEqual({ day: DAY });
    expect(events.filter((e) => e.name === RESERVATIONS_CHANGED_EVENT)).toEqual([
      { name: RESERVATIONS_CHANGED_EVENT, detail: { from: "live" } },
    ]);
    expect(sound.playChime).not.toHaveBeenCalled();
    expect(sound.playUrgent).not.toHaveBeenCalled();
    expect(sound.playCancel).not.toHaveBeenCalled();
    expect(screen.queryByText("New booking")).toBeNull();
  });

  it("the same revision proves the book current — and reloads nothing", async () => {
    answer({ book_day: DAY, book_rev: "rev-1" });
    mountPoll();
    await advance(0);
    expect(events.map((e) => e.name)).toEqual([BOOK_FRESH_EVENT]);
    expect(events[0].detail).toEqual({ day: DAY });
  });

  it("asks again within 18 s while a book is open", async () => {
    answer({ book_day: DAY, book_rev: "rev-1" });
    mountPoll();
    await advance(0);
    expect(changesCalls()).toHaveLength(1);
    await advance(17999);
    expect(changesCalls()).toHaveLength(1);
    await advance(1);
    expect(changesCalls()).toHaveLength(2);
    // The second poll carries the anchor the first one primed.
    expect(changesCalls()[1][1].params).toEqual({ since: "2026-10-12T17:00:00", day: DAY });
  });

  it("alerts switched off on this device: the book half still asks, with no anchor to replay", async () => {
    localStorage.setItem("bonbox_alerts_enabled", "0");
    answer({ book_day: DAY, book_rev: "rev-2" });
    mountPoll();
    await advance(0);
    await advance(18000);
    expect(changesCalls().length).toBeGreaterThanOrEqual(2);
    for (const [, cfg] of changesCalls()) expect(cfg.params).toEqual({ day: DAY });
    expect(events.some((e) => e.name === RESERVATIONS_CHANGED_EVENT)).toBe(true);
  });

  it("alerts off and no book open: nothing is asked at all", async () => {
    unwatchBook("test-book");
    localStorage.setItem("bonbox_alerts_enabled", "0");
    answer();
    mountPoll();
    await advance(0);
    await advance(60000);
    expect(changesCalls()).toHaveLength(0);
  });

  it("backs off while BonBox cannot be reached, says so, and says when it is back", async () => {
    api.get.mockRejectedValue(netErr());
    mountPoll();
    await advance(0);
    expect(changesCalls()).toHaveLength(1);
    expect(events.at(-1)).toEqual({ name: BOOK_UNREACHABLE_EVENT, detail: { failures: 1 } });
    await advance(18000); // one blip: the normal wait
    expect(changesCalls()).toHaveLength(2);
    expect(events.at(-1).detail).toEqual({ failures: 2 });
    await advance(18000); // now the wait doubles: not yet
    expect(changesCalls()).toHaveLength(2);
    await advance(18000);
    expect(changesCalls()).toHaveLength(3);
    answer({ book_day: DAY, book_rev: "rev-1" });
    await advance(72000);
    expect(changesCalls()).toHaveLength(4);
    expect(events.some((e) => e.name === BOOK_UNREACHABLE_EVENT && e.detail.failures === 0)).toBe(true);
  });

  it("a burst of wake events is one question", async () => {
    answer({ book_day: DAY, book_rev: "rev-1" });
    mountPoll();
    await advance(0);
    expect(changesCalls()).toHaveLength(1);
    // Within the wake gap: nothing.
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await advance(0);
    expect(changesCalls()).toHaveLength(1);
    // Later, the iPad is unlocked: three events, one question.
    await advance(6000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(0);
    expect(changesCalls()).toHaveLength(2);
  });

  it("the network coming back asks within two seconds", async () => {
    answer({ book_day: DAY, book_rev: "rev-1" });
    mountPoll();
    await advance(0);
    await advance(5000);
    act(() => { window.dispatchEvent(new Event("online")); });
    await advance(2000);
    expect(changesCalls()).toHaveLength(2);
  });

  it("a removed device stops asking every 18 s", async () => {
    api.get.mockRejectedValue(http(404, "not_found"));
    mountPoll();
    await advance(0);
    expect(changesCalls()).toHaveLength(1);
    await advance(60000);
    expect(changesCalls()).toHaveLength(1);
    await advance(60000);
    expect(changesCalls()).toHaveLength(2);
  });

  it("a guest's online booking still alerts, and the book reloads once for it", async () => {
    api.get
      .mockResolvedValueOnce({ data: { server_time: "2026-10-12T17:00:00", changes: [], book_day: DAY, book_rev: "rev-1" } })
      .mockResolvedValue({
        data: {
          server_time: "2026-10-12T17:00:18",
          book_day: DAY,
          book_rev: "rev-2",
          changes: [{ id: "g1", kind: "new", guest_name: "Online", party_size: 2, starts_at: at("20:00"), updated_at: "u1", held: false }],
        },
      });
    mountPoll();
    await advance(0);
    await advance(18000);
    expect(screen.getByText("New booking")).toBeTruthy();
    expect(sound.playChime).toHaveBeenCalledTimes(1);
    // One reload for the poll, though both the revision and the alert said so.
    expect(events.filter((e) => e.name === RESERVATIONS_CHANGED_EVENT)).toHaveLength(1);
  });
});

// ── /stand after a restart ───────────────────────────────────────────

describe("/stand reopens the remembered book", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try { localStorage.clear(); } catch { /* no storage */ }
  });

  const renderPair = (entry) =>
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/stand" element={<StandPairPage />} />
          <Route path="/stand/:standToken" element={<div><span>BOOK</span><Where /></div>} />
        </Routes>
      </MemoryRouter>,
    );

  it("a paired device goes straight to its book — no code box flashed at the host", async () => {
    setStandToken("tok-door-1");
    renderPair("/stand");
    await waitFor(() => expect(screen.getByText("BOOK")).toBeTruthy());
    expect(screen.getByTestId("where").textContent).toBe("/stand/tok-door-1");
    expect(screen.queryByPlaceholderText("ABC123")).toBeNull();
  });

  it("'Enter a new code' and 'Disconnect' land on the code box", () => {
    setStandToken("tok-door-1");
    renderPair({ pathname: "/stand", state: { fresh: true } });
    expect(screen.getByPlaceholderText("ABC123")).toBeTruthy();
    expect(screen.queryByText("BOOK")).toBeNull();
  });

  it("an unpaired device gets the code box, and a code that works is remembered", async () => {
    renderPair("/stand");
    const input = screen.getByPlaceholderText("ABC123");
    api.post.mockResolvedValue({ data: { path: "/stand/NewDeviceToken_123", venue: "Havnen" } });
    fireEvent.change(input, { target: { value: "ABCDEF" } });
    await waitFor(() => expect(screen.getByText("BOOK")).toBeTruthy());
    expect(api.post).toHaveBeenCalledWith("/stand/join", { code: "ABCDEF" });
    expect(rememberedStandToken()).toBe("NewDeviceToken_123");
  });
});
