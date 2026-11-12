/**
 * The seconds sweep (Manoj, 12 Nov 2026: "this clock is nice it just doesn't
 * show sec — like an analog watch would be really amazing"): a small dot on
 * the live card's ring, one turn a minute, linear.
 *
 *   • sweepPhase: the shown seconds into the minute, plus the time since the
 *     card's 1 s tick moved them (never a full second), so the dot is at 12
 *     exactly when the H:MM minute rolls.
 *   • On the REAL page (mocked portalApi and haptics, fake Date and timers,
 *     as StaffPortalPage.clockBeat.test.jsx): ONE element on the ring, brass;
 *     its phase is set once per mount as a negative animation-delay; a tick
 *     never touches it; the minute's roll, a new answer (a pause, its end)
 *     and a return to the app re-sync it (a new mount). Sage on a pause.
 *   • Only clocked in, at rest and where motion is welcome: absent under
 *     reduced motion (or with no matchMedia), during the clock-in beat (it
 *     starts after it) and during a clock-out's leave.
 *   • The CSS: one element, transform only, about the ring's centre.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepPhase, SWEEP_SEC } from "../components/staff/clockBeat";

const HERE = dirname(fileURLToPath(import.meta.url));
const C = JSON.parse(readFileSync(join(HERE, "fixtures", "liveBreaksContract.json"), "utf8"));
const STEP = Object.fromEntries(C.steps.map((s) => [s.name, s]));
const fx = (name) => structuredClone(STEP[name].body);
const CSS = readFileSync(join(HERE, "..", "components", "staff", "vagtplan.css"), "utf8");

const TOK = "toksweep";
const ok = (data) => Promise.resolve({ data });
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const WED = "2026-11-11";
const WED_SHIFT = { id: "w1", date: WED, start_time: "10:00", end_time: "16:00", status: "published", net_hours: 5.5, break_minutes: 30, role_on_shift: "Tjener" };
const DAY = STEP.clock_before.at.slice(0, 10);
const DAY_SHIFT = { id: "c1", date: DAY, start_time: "09:00", end_time: "17:00", status: "published", net_hours: 7.5, break_minutes: 30, role_on_shift: "Tjener" };
const OUT = { clocked_in: false, geofence_on: false, locked: false };
const H216 = 2 * 3600 + 16 * 60;   // 2:16 on the clock
const CLOCKED = { clocked_in: true, since: "09:58", elapsed_sec: H216, geofence_on: false, locked: false, breaks_live: false };

let shifts;
let clockImpl;
let postImpl;
const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: "Freja Nielsen", role: "server", restaurant_name: "Café Solsikke", restaurant_address: "Nørrebrogade 52" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) return ok({ shifts });
  if (url === `/portal/${TOK}/clock`) return clockImpl();
  if (url.startsWith(`/portal/${TOK}/hours`)) return ok({ period_start: WED, period_end: WED, total_hours: 0, entries: [] });
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  return ok([]);
});
const post = vi.fn((...a) => postImpl(...a));

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
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
async function flush(n = 4) {
  for (let i = 0; i < n; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }
}
async function advance(ms) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function settle(d, value) {
  await act(async () => {
    d.resolve(value);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  await flush(2);
}
async function click(el) {
  await act(async () => { fireEvent.click(el); });
}
function holdPost() {
  const d = deferred();
  postImpl = () => d.promise;
  return d;
}
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
  await flush(8);
  expect(screen.getByTestId("portal-hero")).toBeInTheDocument();
}

const hero = () => screen.getByTestId("portal-hero");
const home = () => hero().parentElement;
const sweep = () => screen.queryByTestId("portal-live-sweep");
/** The phase the dot was mounted at (seconds into the minute). */
const phaseOf = (el) => -parseFloat(el.style.animationDelay);
const at = (y, mo, d, h, m = 0, s = 0) => vi.setSystemTime(new Date(y, mo - 1, d, h, m, s));
const clockAt = (h, m, s) => at(Number(DAY.slice(0, 4)), Number(DAY.slice(5, 7)), Number(DAY.slice(8, 10)), h, m, s);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  at(2026, 11, 11, 12, 14);
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  shifts = [WED_SHIFT];
  clockImpl = () => ok(OUT);
  postImpl = () => ok({});
  motionPref({ reduce: false });
});

afterEach(() => {
  vi.useRealTimers();
  delete window.matchMedia;
  delete document.visibilityState;
});

describe("sweepPhase: the shown seconds into the minute, plus the time since the tick", () => {
  it("whole seconds: 12 o'clock at every minute's roll", () => {
    expect(SWEEP_SEC).toBe(60);
    expect(sweepPhase(0)).toBe(0);
    expect(sweepPhase(23)).toBe(23);
    expect(sweepPhase(59)).toBe(59);
    expect(sweepPhase(60)).toBe(0);
    expect(sweepPhase(H216)).toBe(0);           // 2:16:00
    expect(sweepPhase(H216 + 23)).toBe(23);     // 2:16:23
    expect(sweepPhase(12.9)).toBe(12);          // the card shows whole seconds
  });

  it("the time since the tick moves it on, never a whole second (a late or sleeping tick)", () => {
    expect(sweepPhase(59, 400)).toBeCloseTo(59.4, 9);
    expect(sweepPhase(7, 0)).toBe(7);
    expect(sweepPhase(10, 5000)).toBeCloseTo(10.999, 9);
    expect(sweepPhase(10, -50)).toBe(10);
  });

  it("on a pause it is the pause's own seconds (the caller passes them); garbage is 12 o'clock", () => {
    expect(sweepPhase(fx("break_start").break_elapsed_sec)).toBe(0);
    expect(sweepPhase(fx("break_end").elapsed_sec)).toBe(12605 % 60);
    expect(sweepPhase(null)).toBe(0);
    expect(sweepPhase(undefined, 300)).toBeCloseTo(0.3, 9);
    expect(sweepPhase(Number.NaN)).toBe(0);
    expect(sweepPhase(-5)).toBe(55);
  });
});

describe("On the page: one dot on the ring, in phase with the digits", () => {
  it("clocked in at load: one brass element on the ring at the shown seconds; a tick leaves it alone; the minute's roll re-syncs it at 12", async () => {
    clockImpl = () => ok({ ...CLOCKED, elapsed_sec: H216 + 50 });
    await mount();
    const dot = sweep();
    expect(dot).not.toBeNull();
    expect(screen.getAllByTestId("portal-live-sweep")).toHaveLength(1);
    expect(dot.className).toBe("vp-lc-sweep");
    expect(dot.children).toHaveLength(0);                       // one element
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.parentElement).toBe(screen.getByTestId("portal-live-ring"));
    expect(dot.style.background).toBe("rgb(200, 164, 100)");   // BRASS
    expect(phaseOf(dot)).toBeCloseTo(50, 9);
    // The ring box carries the size and the pine edge the CSS reads.
    expect(screen.getByTestId("portal-live-ring").style.getPropertyValue("--vp-ring")).not.toBe("");
    expect(screen.getByTestId("portal-live-ring").style.getPropertyValue("--vp-pine").toLowerCase()).toBe("#0e3b2e");

    await advance(1000);
    expect(sweep()).toBe(dot);                                  // a tick: not a re-render of its phase
    expect(phaseOf(sweep())).toBeCloseTo(50, 9);
    await advance(8000);                                        // 2:16:59
    expect(sweep()).toBe(dot);
    await advance(1000);                                        // 2:17:00, the minute rolls
    expect(sweep()).not.toBe(dot);
    expect(phaseOf(sweep())).toBeCloseTo(0, 9);                 // at 12, with the roll
    await advance(700);
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:17");
  });

  it("a pause re-anchors it: sage, at the pause's seconds plus the time since the tick; its end: brass, the shift's seconds", async () => {
    clockAt(12, 0, 0);
    shifts = [DAY_SHIFT];
    clockImpl = () => ok(fx("clock_live"));                     // 3:00:00
    await mount();
    const dot = sweep();
    expect(phaseOf(dot)).toBeCloseTo(0, 9);
    await advance(400);                                         // between two ticks
    expect(sweep()).toBe(dot);

    let d = holdPost();
    await click(screen.getByTestId("portal-break-btn"));
    await settle(d, { data: { ...fx("break_start"), break_elapsed_sec: 7 } });
    const sage = sweep();
    expect(sage).not.toBe(dot);
    expect(sage.style.background).toBe("rgb(169, 184, 174)");  // SAGE
    expect(phaseOf(sage)).toBeCloseTo(7.4, 9);
    await advance(600);                                         // the tick: 0:07 → 0:08, the dot at 8.0
    expect(sweep()).toBe(sage);

    await advance(250);
    d = holdPost();
    await click(screen.getByTestId("portal-break-btn"));
    await settle(d, { data: fx("break_end") });                // 3:30:05
    const brass = sweep();
    expect(brass).not.toBe(sage);
    expect(brass.style.background).toBe("rgb(200, 164, 100)");
    expect(phaseOf(brass)).toBeCloseTo(5.25, 9);
  });

  it("a return to the app re-syncs it to the shown seconds", async () => {
    clockImpl = () => ok({ ...CLOCKED, elapsed_sec: H216 + 10 });
    await mount();
    const dot = sweep();
    await advance(2300);                                        // two ticks: 2:16:12, 0.3 s on
    expect(sweep()).toBe(dot);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(sweep()).not.toBe(dot);
    expect(phaseOf(sweep())).toBeCloseTo(12.3, 9);
  });

  it("reduced motion: no dot at all", async () => {
    motionPref({ reduce: true });
    clockImpl = () => ok(CLOCKED);
    await mount();
    expect(hero().dataset.state).toBe("live");
    expect(sweep()).toBeNull();
    await advance(2000);
    expect(sweep()).toBeNull();
  });

  it("no matchMedia: no dot", async () => {
    delete window.matchMedia;
    clockImpl = () => ok(CLOCKED);
    await mount();
    expect(hero().dataset.state).toBe("live");
    expect(sweep()).toBeNull();
  });

  it("clock-in: no dot while the beat plays; it starts when the beat is done, in phase with the digits", async () => {
    await mount();
    expect(sweep()).toBeNull();                                 // not clocked in: no ring, no dot
    const d = holdPost();
    await click(within(hero()).getByRole("button", { name: /Stempl ind/ }));
    await settle(d, { data: fx("clock_in") });                 // elapsed 0
    expect(home().dataset.beatPhase).toBe("leave");
    expect(sweep()).toBeNull();
    await advance(180);
    expect(home().dataset.beatPhase).toBe("enter");
    expect(hero().dataset.state).toBe("live");
    expect(sweep()).toBeNull();                                 // the lap draws; no seconds yet
    await advance(480);
    expect(home().dataset.beatPhase).toBe("enter");
    expect(sweep()).toBeNull();
    await advance(580);                                         // the beat is done
    expect(home().hasAttribute("data-beat-phase")).toBe(false);
    const dot = sweep();
    expect(dot).not.toBeNull();
    // The tick began with the card (at the enter, 1.06 s ago): one tick at
    // 1.00 s, so 0:01 shows and the dot is 0.06 s past it.
    expect(phaseOf(dot)).toBeCloseTo(1.06, 9);
  });

  it("clock-out: the dot goes with the leave", async () => {
    shifts = [WED_SHIFT];
    clockImpl = () => ok(CLOCKED);
    await mount();
    expect(sweep()).not.toBeNull();
    const d = holdPost();
    await click(screen.getByTestId("portal-clock-out"));
    clockImpl = () => ok(OUT);
    await settle(d, { data: { ...fx("clock_out"), worked_hours: 2.25 } });
    expect(home().dataset.beatPhase).toBe("leave");
    expect(hero().dataset.state).toBe("live");                  // the card leaves as it stood
    expect(sweep()).toBeNull();                                 // without its dot
    await advance(240);
    expect(hero().dataset.state).toBe("next");
    expect(sweep()).toBeNull();
  });
});

describe("The CSS: one element, transform only, about the ring's centre", () => {
  const rule = CSS.match(/\.vp-lc-sweep \{[^}]*\}/)[0];
  it("one turn a minute, linear, on the compositor's spin; no layout property animates", () => {
    expect(rule).toContain("animation: vp-spin 60s linear infinite;");
    expect(CSS).toMatch(/@keyframes vp-spin \{ to \{ transform: rotate\(360deg\); \} \}/);
    expect(rule).toContain("pointer-events: none;");
    expect(rule).not.toMatch(/transition|will-change|filter/);
  });
  it("sits on the track at 12 (r 88 in the 200 box, r 3.5) and turns about the ring's centre", () => {
    // Dot centre (100, 12) of 200: left/top = centre − radius, in ring units.
    expect(rule).toContain("left: calc(var(--vp-ring) * .4825);");
    expect(rule).toContain("top: calc(var(--vp-ring) * .0425);");
    expect(rule).toContain("width: calc(var(--vp-ring) * .035);");
    expect(rule).toContain("height: calc(var(--vp-ring) * .035);");
    // The ring's centre (100, 100) from the dot's corner.
    expect(rule).toContain("transform-origin: calc(var(--vp-ring) * .0175) calc(var(--vp-ring) * .4575);");
    expect(rule).toContain("box-shadow: 0 0 0 calc(var(--vp-ring) * .0075) var(--vp-pine);");
  });
  it("the deliberate exception to 'nothing loops' is written down; under reduce it is not drawn", () => {
    expect(CSS).toContain('A DELIBERATE exception to "nothing loops", at his request');
    const body = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(body).toContain(".vp-lc-sweep { display: none; animation: none; }");
  });
});
