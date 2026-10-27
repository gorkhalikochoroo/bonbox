/**
 * Fix round 27 Oct — P0-1 (walk 27 Oct, release blocker).
 *
 * The door screen's own build (stand.html, R11) asked GET /stand/<t>/resources
 * in an endless loop: 5,127 reads in 25 s from one paired iPad, then 429s that
 * took the lenses and the drop-in away a second after open. Its app
 * (stand/StandApp.jsx) mounts no EntitlementsProvider, and useEntitlements()
 * outside one answered a NEW hasFeature on every render — which re-ran
 * ReservationsPage's /resources effect (it lists hasFeature) on every render
 * that effect caused itself.
 *
 * Mounted here as the door screen's build runs it: __STAND_BUILD__ true, no
 * entitlements provider (the real hook), no session (stand/standSession), the
 * live check running, the clock faked and every answer 40 ms away.
 *   • outside a provider, useEntitlements is one object for the life of the page;
 *   • opened: ONE read of the tables (the book's, handed up to the page), and
 *     none more over ten minutes of live checks and reloads;
 *   • a 429 is never asked again by itself: one more read per book reload at
 *     most, the lenses and the drop-in stay meanwhile, and once the tables
 *     answer the reads stop.
 *
 * Run: cd frontend && TZ=UTC npx vitest run src/__tests__/fix27.doorScreenOneRoomRead.test.jsx
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => {
  const t = (_k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    return String(typeof fb === "string" ? fb : _k).replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m));
  };
  return {
    lang: { t, lang: "en" },
    confirm: vi.fn(async () => true),
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  };
});

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
// The door screen's build swaps the session for its own (scripts/standBuild.mjs
// STAND_SWAPS): no user, nothing to load. useEntitlements is NOT mocked — the
// door screen runs the real hook with no provider above it.
vi.mock("../hooks/useAuth", () => import("../stand/standSession.jsx"));
vi.mock("../hooks/useLanguage", () => ({ useLanguage: () => h.lang }));
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
import ReservationsPage from "../pages/ReservationsPage";
import { useEntitlements } from "../hooks/useEntitlements";
import { LiveAlertsProvider } from "../hooks/useLiveAlerts";
import { RESERVATIONS_CHANGED_EVENT } from "../lib/liveAlertKinds";
import { rememberedStandLayout } from "../services/standAuth";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = "2026-10-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const DEVICE = "/stand/tok-door-1";
const LATENCY = 40;

const table = (id, seats) => ({ id, label: id, capacity_seats: seats, kind: "table", is_active: true, zone: "Sal", pos_x: 10, pos_y: 20 });
const RESOURCES = [table("21", 2), table("23", 4), table("41", 2)];
const BOOK = [{
  id: "a", guest_name: "Birk Lauridsen", resource_id: "21", status: "seated", starts_at: at("18:00"),
  ends_at: at("19:30"), party_size: 2, source: "manual", allergen_tags: [], seated_at: null, completed_at: null,
}];
const RULES = {
  settings: { turn_time_tiers: [{ up_to: 2, minutes: 90 }, { up_to: 8, minutes: 120 }], default_duration_min: 90 },
  hours_declared: false,
};
const ROOM = () => ({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 8 } });
const RATE_LIMITED = () => {
  throw Object.assign(new Error("Request failed with status code 429"), {
    response: { status: 429, data: { detail: "For mange forsøg" } },
  });
};

let roomAnswer = ROOM;
// Every answer arrives 40 ms later, as over a network: a loop shows as reads
// piling up while the clock moves, never as a test that hangs.
function mockApi() {
  api.get.mockImplementation((url) => new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        if (url === "/reservations/resources") return resolve(roomAnswer());
        if (url === "/reservations/book") {
          return resolve({ data: { date: DAY, reservations: BOOK, summary: { total: 1, covers: 2, by_status: {} }, rev: "rev-1" } });
        }
        if (url === "/reservations/booking-rules") return resolve({ data: RULES });
        if (url === "/reservations/waitlist") return resolve({ data: { waitlist: [], active_count: 0 } });
        if (url === "/reservations/changes") {
          return resolve({ data: { server_time: "2026-10-12T17:00:00", changes: [], book_day: DAY, book_rev: "rev-1" } });
        }
        return resolve({ data: {} });
      } catch (e) {
        return reject(e);
      }
    }, LATENCY);
  }));
  api.post.mockImplementation(() => Promise.resolve({ data: { ok: true } }));
}

const reads = (url) => api.get.mock.calls.filter((c) => c[0] === url).length;
const tableReads = () => reads("/reservations/resources");
const bookReads = () => reads("/reservations/book");
const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const settle = () => advance(LATENCY * 4);
const liveReload = async () => {
  act(() => { window.dispatchEvent(new CustomEvent(RESERVATIONS_CHANGED_EVENT, { detail: { from: "live" } })); });
  await settle();
};
const dropIn = () => screen.queryByRole("button", { name: "Seat a drop-in" });
const lenses = () => screen.queryByText("Timeline");

const mount = () =>
  render(
    <MemoryRouter initialEntries={[DEVICE]}>
      <LiveAlertsProvider>
        <Routes>
          <Route path="/stand/:standToken" element={<ReservationsPage />} />
        </Routes>
      </LiveAlertsProvider>
    </MemoryRouter>,
  );

beforeAll(() => {
  vi.stubGlobal("__STAND_BUILD__", true);
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(at("19:00")));
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.clearAllMocks();
  try { localStorage.clear(); } catch { /* no storage */ }
  roomAnswer = ROOM;
  mockApi();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useEntitlements outside a provider (the door screen's build mounts none)", () => {
  it("is one object for the life of the page — the same hasFeature on every render", () => {
    expect(fs.readFileSync(path.join(SRC, "stand/StandApp.jsx"), "utf8")).not.toContain("EntitlementsProvider");
    const { result, rerender } = renderHook(() => useEntitlements());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.hasFeature).toBe(first.hasFeature);
    // Still the settled, fail-closed Free shape.
    expect(first.isReady).toBe(true);
    expect(first.hasFeature("reservations")).toBe(false);
  });
});

describe("the door screen's book reads its tables once", () => {
  it("opened: one read, and none more over ten minutes of live checks and reloads", async () => {
    expect(__STAND_BUILD__).toBe(true);
    mount();
    await settle();
    expect(screen.queryAllByText(/Birk/).length).toBeGreaterThan(0);
    expect(tableReads()).toBe(1);
    const booksAtOpen = bookReads();
    for (let i = 0; i < 20; i += 1) await advance(30000);
    await liveReload();
    await liveReload();
    expect(bookReads()).toBeGreaterThan(booksAtOpen + 1);     // the book did reload (control)
    expect(reads("/reservations/changes")).toBeGreaterThan(0); // the live check ran (control)
    expect(tableReads()).toBe(1);
    expect(rememberedStandLayout()).toBe("table");
    expect(dropIn()).not.toBeNull();
  });

  it("a 429 is never asked again by itself: one more read per book reload at most, the lenses stay, and the reads stop once the tables answer", async () => {
    roomAnswer = RATE_LIMITED;
    mount();
    await settle();
    expect(tableReads()).toBe(1);
    const booksAtOpen = bookReads();
    const onePerReload = () => 1 + (bookReads() - booksAtOpen);
    // A minute with no book reload (the first safety reload is at 75 s):
    // not one more read.
    for (let i = 0; i < 6; i += 1) await advance(10000);
    expect(bookReads()).toBe(booksAtOpen);
    expect(tableReads()).toBe(1);
    // "Could not ask" is not "no tables": the lenses and the drop-in stay.
    expect(lenses()).not.toBeNull();
    expect(dropIn()).not.toBeNull();
    // Each book reload — the safety net's, the live check's — asks once more
    // (R10), never more than once.
    for (let i = 0; i < 4; i += 1) await advance(30000);
    await liveReload();
    await liveReload();
    expect(bookReads()).toBeGreaterThanOrEqual(booksAtOpen + 3);
    expect(tableReads()).toBe(onePerReload());
    expect(lenses()).not.toBeNull();
    expect(dropIn()).not.toBeNull();
    // The tables answer on the next reload — and after that nobody asks again.
    roomAnswer = ROOM;
    await liveReload();
    const answered = tableReads();
    expect(answered).toBe(onePerReload());
    for (let i = 0; i < 3; i += 1) await liveReload();
    for (let i = 0; i < 10; i += 1) await advance(30000);
    expect(bookReads()).toBeGreaterThan(booksAtOpen + 6);   // reloads went on (control)
    expect(tableReads()).toBe(answered);
    expect(rememberedStandLayout()).toBe("table");
    expect(lenses()).not.toBeNull();
    expect(dropIn()).not.toBeNull();
  });
});
