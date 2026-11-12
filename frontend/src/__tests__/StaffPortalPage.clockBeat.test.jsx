/**
 * The clock beat on the REAL page (CLOCK-MOTION-SPEC.md 2.8, approved 11 Nov
 * 2026, "yea do it"), against a mocked portalApi and haptics, as
 * StaffPortalPage.dockMotion.test.jsx does. Motion is allowed
 * (motionPref({ reduce: false })) unless a test says otherwise. Date, the
 * timeouts and the intervals are fake and advanced inside act(), one advance
 * per phase (an effect commits at the end of the advance that reached it);
 * the DOM is read with getBy after each advance, never findBy.
 *
 *   • Clock-in plays once, only after the server's yes: the old card fades
 *     (leave), the live card is drawn on the SAME hero node (enter), the hero
 *     takes no taps until its buttons are in, and at rest the card is exactly
 *     today's (background, shadow string). The haptic is today's, at the
 *     answer.
 *   • Never on load, a poll, resume, a tab switch, a refusal or a 409; a poll
 *     that raced the punch makes no beat (and keeps its haptic); a poll asked
 *     before the punch's answer is dropped.
 *   • The lap only for a fresh punch on a planned shift.
 *   • Clock-out fades the live card as it stood (frozen chip, digits, dimmed
 *     buttons, "Næste vagt"), then the next card with "Registreret".
 *   • A pause melts the arc: a ghost in the old colour, 680 ms.
 *   • Reduced motion (or no matchMedia): nothing extra at all.
 *   • Every testid and label kept; the knob's cx / cy unchanged.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const C = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "liveBreaksContract.json"), "utf8"),
);
const STEP = Object.fromEntries(C.steps.map((s) => [s.name, s]));
const fx = (name) => structuredClone(STEP[name].body);

const TOK = "tokbeat";
const ok = (data) => Promise.resolve({ data });
const failure = (status, detail) => {
  const e = new Error(status ? `Request failed with status code ${status}` : "Network Error");
  if (status) e.response = { status, data: { detail } };
  return e;
};
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Wednesday 11 Nov 2026 (the canvasHome case); the pause cases use the
// contract's own day (30 Jun 2026) so its real answers fit.
const WED = "2026-11-11";
const THU = "2026-11-12";
const WED_SHIFT = { id: "w1", date: WED, start_time: "10:00", end_time: "16:00", status: "published", net_hours: 5.5, break_minutes: 30, role_on_shift: "Tjener" };
const THU_SHIFT = { id: "t1", date: THU, start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5, break_minutes: 30, role_on_shift: "Tjener" };
const DAY = STEP.clock_before.at.slice(0, 10);
const DAY_SHIFT = { id: "c1", date: DAY, start_time: "09:00", end_time: "17:00", status: "published", net_hours: 7.5, break_minutes: 30, role_on_shift: "Tjener" };
const OUT = { clocked_in: false, geofence_on: false, locked: false };
const CLOCKED = { clocked_in: true, since: "09:58", elapsed_sec: 2 * 3600 + 16 * 60, geofence_on: false, locked: false, breaks_live: false };

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
const { haptic } = await import("../utils/haptics");

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

// Let the mocked answers (already-resolved promises) land, without moving time.
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
async function refuse(d, err) {
  await act(async () => {
    d.reject(err);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  await flush(2);
}
async function click(el) {
  await act(async () => { fireEvent.click(el); });
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
const anyBeat = () => document.querySelector("[data-beat-phase], [data-clock-beat], [data-beat-lap]");
const clockIn = () => within(hero()).getByRole("button", { name: /Stempl ind/ });
const at = (y, mo, d, h, m = 0, s = 0) => vi.setSystemTime(new Date(y, mo - 1, d, h, m, s));
// A punch the test answers by hand: the POST is held until settle()/refuse().
function holdPost() {
  const d = deferred();
  postImpl = () => d.promise;
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  at(2026, 11, 11, 9, 50);
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  for (const k of ["success", "warning", "error", "light"]) haptic[k].mockClear();
  shifts = [WED_SHIFT];
  clockImpl = () => ok(OUT);
  postImpl = () => ok({});
  motionPref({ reduce: false });
});

afterEach(() => {
  vi.useRealTimers();
  delete window.matchMedia;
  delete document.hidden;
});

describe("1 · Clock-in plays once, after the server's yes", () => {
  it("leave → enter on the same hero node → armed → rest exactly as today", async () => {
    await mount();
    const node = hero();
    const restShadow = node.style.boxShadow;
    expect(restShadow).toContain("24px 48px -28px");
    expect(restShadow).toContain("inset 0 1px 0");
    const d = holdPost();
    await click(clockIn());
    // Nothing optimistic while the server thinks.
    expect(anyBeat()).toBeNull();
    expect(hero().dataset.state).toBe("next");
    expect(clockIn().disabled).toBe(true);

    await settle(d, { data: fx("clock_in") });
    expect(home().dataset.beatPhase).toBe("leave");
    expect(home().dataset.clockBeat).toBe("in");
    expect(hero().hasAttribute("inert")).toBe(true);
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(hero().dataset.state).toBe("next");          // the old card leaves
    expect(clockIn().disabled).toBe(true);              // and never brightens while it fades

    await advance(180);
    expect(home().dataset.beatPhase).toBe("enter");
    expect(home().hasAttribute("data-beat-lap")).toBe(true);
    expect(hero().dataset.state).toBe("live");
    expect(hero()).toBe(node);                          // ONE node: heroSettle never replays
    const surface = hero().querySelector(":scope > .vp-hero-surface");
    expect(surface).not.toBeNull();
    expect([...surface.children].map((c) => c.className)).toEqual(["vp-hs-top", "vp-hs-mid", "vp-hs-bot"]);
    expect(surface.getAttribute("aria-hidden")).toBe("true");
    expect(hero().style.background).toBe("transparent");
    expect(hero().hasAttribute("inert")).toBe(true);

    await advance(480);
    expect(hero().hasAttribute("inert")).toBe(false);
    expect(home().dataset.beatPhase).toBe("enter");

    await advance(580);
    expect(anyBeat()).toBeNull();
    expect(hero().querySelector(".vp-hero-surface")).toBeNull();
    expect(hero().style.background).toBe("rgb(14, 59, 46)");
    expect(hero().style.boxShadow).toBe(restShadow);
    expect(hero().style.isolation).toBe("");
    expect(haptic.success).toHaveBeenCalledTimes(1);
  });
});

describe("2-6 · Never on load, a poll, a race, resume or a tab switch", () => {
  it("2 · already clocked in at load: no beat, no haptic", async () => {
    at(2026, 11, 11, 12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    expect(hero().dataset.state).toBe("live");
    expect(anyBeat()).toBeNull();
    await advance(2000);
    expect(anyBeat()).toBeNull();
    expect(haptic.success).not.toHaveBeenCalled();
  });

  it("3 · a poll finds a punch made elsewhere: a plain swap, no beat, no haptic", async () => {
    await mount();
    expect(hero().dataset.state).toBe("next");
    clockImpl = () => ok({ ...fx("clock_in"), since: "09:50" });
    await advance(30000);
    await flush();
    expect(hero().dataset.state).toBe("live");
    expect(anyBeat()).toBeNull();
    expect(haptic.success).not.toHaveBeenCalled();
  });

  it("4 · a poll that raced the punch: plain swap, no beat; the punch's answer keeps its haptic", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    clockImpl = () => ok({ ...fx("clock_in"), since: "09:50" });
    await advance(30000);
    await flush();
    expect(hero().dataset.state).toBe("live");
    expect(anyBeat()).toBeNull();
    await settle(d, { data: { ...fx("clock_in"), since: "09:50" } });
    expect(anyBeat()).toBeNull();
    expect(hero().dataset.state).toBe("live");
    expect(haptic.success).toHaveBeenCalledTimes(1);
  });

  it("5 · a poll asked before the punch's answer, answered after it, is dropped", async () => {
    await mount();
    const poll = deferred();
    clockImpl = () => poll.promise;
    await advance(30000);                    // the 30 s poll asks … and waits
    const d = holdPost();
    await click(clockIn());
    await settle(d, { data: fx("clock_in") });
    expect(home().dataset.beatPhase).toBe("leave");
    await settle(poll, { data: OUT });       // its older "out" lands now
    expect(home().dataset.beatPhase).toBe("leave");
    await advance(180);
    expect(hero().dataset.state).toBe("live");
    expect(home().dataset.beatPhase).toBe("enter");
    await advance(480);
    await advance(580);
    expect(anyBeat()).toBeNull();
    expect(hero().dataset.state).toBe("live");
  });

  it("6a · resume (visibilitychange → visible) makes no beat", async () => {
    await mount();
    clockImpl = () => ok({ ...fx("clock_in"), since: "09:50" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(anyBeat()).toBeNull();
    await advance(2000);
    expect(anyBeat()).toBeNull();
    expect(haptic.success).not.toHaveBeenCalled();
  });

  it("6b · after a finished beat, Timer → Vagtplan plays nothing", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    await settle(d, { data: fx("clock_in") });
    clockImpl = () => ok(fx("clock_in"));
    await advance(180);
    await advance(480);
    await advance(580);
    expect(anyBeat()).toBeNull();
    await click(screen.getByTestId("portal-tab-hours"));
    await flush();
    await click(screen.getByTestId("portal-tab-schedule"));
    await flush();
    expect(hero().dataset.state).toBe("live");
    expect(anyBeat()).toBeNull();
    await advance(2000);
    expect(anyBeat()).toBeNull();
  });

  it("6c · switching away mid-beat and back: no beat, the server's state", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    await settle(d, { data: fx("clock_in") });
    clockImpl = () => ok(fx("clock_in"));
    expect(home().dataset.beatPhase).toBe("leave");
    await click(screen.getByTestId("portal-tab-hours"));
    await flush();
    await click(screen.getByTestId("portal-tab-schedule"));
    await flush();
    expect(anyBeat()).toBeNull();
    expect(hero().dataset.state).toBe("live");
    await advance(2000);
    expect(anyBeat()).toBeNull();
  });

  it("6d · hidden mid-leave: idle at once, the server's state shows", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    await settle(d, { data: fx("clock_in") });
    expect(home().dataset.beatPhase).toBe("leave");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(anyBeat()).toBeNull();
    expect(hero().dataset.state).toBe("live");
    expect(hero().hasAttribute("inert")).toBe(false);
    delete document.hidden;
    await advance(2000);
    expect(anyBeat()).toBeNull();
  });
});

describe("7 · Refusals play nothing", () => {
  it("too_far 403: no beat, today's warning haptic once, the amber block", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    await refuse(d, failure(403, { error: "too_far", distance_m: 420, radius_m: 150 }));
    expect(anyBeat()).toBeNull();
    expect(haptic.warning).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(within(hero()).getByText("Gå derhen, og prøv igen når du er på stedet.")).toBeInTheDocument();
    await advance(1000);
    expect(anyBeat()).toBeNull();
  });

  it("too_early: no beat", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    await refuse(d, failure(403, { error: "too_early", opens_at: "09:45" }));
    expect(anyBeat()).toBeNull();
    expect(within(hero()).getByText("Stempling åbner kl. 09:45")).toBeInTheDocument();
  });

  it("no network: no beat, the red line", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    await refuse(d, failure(0));
    expect(anyBeat()).toBeNull();
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(within(hero()).getByRole("alert")).toBeInTheDocument();
  });

  it("409 on Stempl ud: no beat; the card swaps to next only when load() answers", async () => {
    at(2026, 11, 11, 12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    const reread = deferred();
    clockImpl = () => reread.promise;
    const d = holdPost();
    await click(screen.getByTestId("portal-clock-out"));
    await refuse(d, failure(409, { error: "not_clocked_in" }));
    expect(anyBeat()).toBeNull();
    expect(hero().dataset.state).toBe("live");
    await settle(reread, { data: OUT });
    expect(hero().dataset.state).toBe("next");
    expect(anyBeat()).toBeNull();
    expect(haptic.error).toHaveBeenCalledTimes(1);
  });
});

describe("8-9 · The lap only when it is true", () => {
  it("8 · a stale screen's idempotent clock-in (elapsed 5400): the beat, no lap", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    await settle(d, { data: { ...fx("clock_in"), since: "08:20", elapsed_sec: 5400 } });
    expect(home().dataset.beatPhase).toBe("leave");
    await advance(180);
    expect(home().dataset.beatPhase).toBe("enter");
    expect(home().hasAttribute("data-beat-lap")).toBe(false);
  });

  it("9 · a clock-in with no planned shift (⋯ → Stempl ind → confirm): the beat, no lap, no arc", async () => {
    at(2026, 11, 11, 12, 14);
    shifts = [THU_SHIFT];
    await mount();
    await click(screen.getByTestId("portal-shift-menu-btn"));
    await click(screen.getByTestId("portal-menu-clock-in"));
    await flush();
    const dialog = document.querySelector("[data-bb-confirm]");
    expect(dialog).not.toBeNull();
    const d = holdPost();
    await click(within(dialog).getByRole("button", { name: "Stempl ind" }));
    await flush();
    await settle(d, { data: { ...fx("clock_in"), since: "12:14" } });
    expect(home().dataset.beatPhase).toBe("leave");
    await advance(180);
    expect(home().dataset.beatPhase).toBe("enter");
    expect(home().hasAttribute("data-beat-lap")).toBe(false);
    expect(screen.queryByTestId("portal-live-arc")).toBeNull();
    expect(screen.getByTestId("portal-live-ring").textContent).toContain("Ingen planlagt vagt");
  });
});

describe("10-11 · Clock-out leaves the card as it stood; Næste vagt comes and goes", () => {
  it("10 · the live card fades out frozen, then the next card with Registreret", async () => {
    at(2026, 11, 11, 12, 14);
    shifts = [WED_SHIFT, THU_SHIFT];
    clockImpl = () => ok(CLOCKED);
    await mount();
    expect(screen.getByTestId("portal-after-live")).toBeInTheDocument();
    const d = holdPost();
    await click(screen.getByTestId("portal-clock-out"));
    clockImpl = () => ok(OUT);
    await settle(d, { data: { ...fx("clock_out"), worked_hours: 2.25 } });
    expect(home().dataset.beatPhase).toBe("leave");
    expect(home().dataset.clockBeat).toBe("out");
    expect(hero().dataset.state).toBe("live");
    expect(screen.getByTestId("portal-live-chip").textContent).toBe("Stemplet ind kl. 09:58");
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:16");
    expect(screen.getByTestId("portal-clock-out").disabled).toBe(true);
    expect(screen.getByTestId("portal-after-live")).toBeInTheDocument();
    expect(screen.queryByText(/Registreret/)).toBeNull();
    expect(hero().hasAttribute("inert")).toBe(true);
    expect(haptic.success).toHaveBeenCalledTimes(1);

    await advance(240);
    expect(hero().dataset.state).toBe("next");
    expect(within(hero()).getByText("Registreret · 2,25 t")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-after-live")).toBeNull();
    expect(hero().hasAttribute("inert")).toBe(true);
    await advance(440);
    expect(hero().hasAttribute("inert")).toBe(false);
    await advance(40);
    expect(anyBeat()).toBeNull();
  });

  it("10b · the 1 s tick lives in the card: the minute rolls on between answers, and the leave freezes what the card showed", async () => {
    // Release A perf: the tick moved from useClock (all of Vagtplan) into the
    // live card. The frozen leave must still be the ticked value, not the
    // last answer's.
    at(2026, 11, 11, 12, 14);
    shifts = [WED_SHIFT, THU_SHIFT];
    clockImpl = () => ok({ ...CLOCKED, elapsed_sec: 2 * 3600 + 16 * 60 + 50 });
    await mount();
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:16");
    await advance(10000);   // ten ticks: 2:16:50 → 2:17:00
    await advance(700);     // the minute's roll (ROLL_MS 600) settles
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:17");
    const d = holdPost();
    await click(screen.getByTestId("portal-clock-out"));
    clockImpl = () => ok(OUT);
    await settle(d, { data: { ...fx("clock_out"), worked_hours: 2.25 } });
    expect(home().dataset.beatPhase).toBe("leave");
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:17");
    await advance(200);
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:17");
  });

  it("11 · clock-in: Næste vagt arrives with the swap, as a vp-after-live block", async () => {
    shifts = [WED_SHIFT, THU_SHIFT];
    await mount();
    const d = holdPost();
    await click(clockIn());
    await settle(d, { data: fx("clock_in") });
    expect(home().dataset.beatPhase).toBe("leave");
    expect(screen.queryByTestId("portal-after-live")).toBeNull();
    await advance(180);
    const after = screen.getByTestId("portal-after-live");
    expect(after.className).toBe("vp-after-live");
    expect(after.parentElement).toBe(home());
  });
});

describe("12 · A pause melts the arc", () => {
  const clockAt = (h, m, s) => at(Number(DAY.slice(0, 4)), Number(DAY.slice(5, 7)), Number(DAY.slice(8, 10)), h, m, s);
  const arc = () => screen.getByTestId("portal-live-arc");
  const ghost = () => document.querySelector(".vp-arc-ghost");

  it("Start pause: sage arc, a brass ghost fading 680 ms; Slut pause: a sage ghost over brass", async () => {
    clockAt(12, 0, 20);
    shifts = [DAY_SHIFT];
    clockImpl = () => ok(fx("clock_live"));
    await mount();
    expect(ghost()).toBeNull();
    let d = holdPost();
    await click(screen.getByTestId("portal-break-btn"));
    await settle(d, { data: fx("break_start") });
    expect(arc().getAttribute("stroke")).toBe("#A9B8AE");
    expect(arc().getAttribute("data-paused")).toBe("true");
    expect(ghost().getAttribute("stroke")).toBe("#C8A464");
    expect(ghost().getAttribute("stroke-dasharray")).toBe(arc().getAttribute("stroke-dasharray"));
    expect(ghost().getAttribute("aria-hidden")).toBe("true");
    // The ghost sits on the arc, under the knob.
    expect(ghost().previousElementSibling).toBe(arc());
    expect(ghost().nextElementSibling.getAttribute("class")).toBe("vp-lc-knob");
    expect(anyBeat()).toBeNull();                       // the hero never moves for a pause
    expect(haptic.success).toHaveBeenCalledTimes(1);
    await advance(679);
    expect(ghost()).not.toBeNull();
    await advance(1);
    expect(ghost()).toBeNull();

    d = holdPost();
    await click(screen.getByTestId("portal-break-btn"));
    await settle(d, { data: fx("break_end") });
    expect(arc().getAttribute("stroke")).toBe("#C8A464");
    expect(ghost().getAttribute("stroke")).toBe("#A9B8AE");
    await advance(680);
    expect(ghost()).toBeNull();
  });

  it("a poll that finds a pause: no ghost; a pause 409: no ghost", async () => {
    clockAt(12, 0, 20);
    shifts = [DAY_SHIFT];
    clockImpl = () => ok(fx("clock_live"));
    await mount();
    clockImpl = () => ok(fx("clock_on_break"));
    await advance(30000);
    await flush();
    expect(arc().getAttribute("stroke")).toBe("#A9B8AE");
    expect(ghost()).toBeNull();

    const d = holdPost();
    clockImpl = () => ok(fx("clock_after_break"));
    await click(screen.getByTestId("portal-break-btn"));
    await refuse(d, Object.assign(new Error("409"), { response: { status: 409, data: fx("break_end_again") } }));
    await flush();
    expect(arc().getAttribute("stroke")).toBe("#C8A464");
    expect(ghost()).toBeNull();
    expect(haptic.success).not.toHaveBeenCalled();
  });

  it("a pause started inside the clock-in's enter (after arm): the ghost plays, the hero stays in its enter", async () => {
    clockAt(9, 0, 0);
    shifts = [DAY_SHIFT];
    clockImpl = () => ok(fx("clock_before"));
    await mount();
    let d = holdPost();
    await click(clockIn());
    await settle(d, { data: fx("clock_in") });
    await advance(180);
    await advance(480);
    expect(hero().hasAttribute("inert")).toBe(false);
    const surface = hero().querySelector(".vp-hero-surface");
    d = holdPost();
    await click(screen.getByTestId("portal-break-btn"));
    await settle(d, { data: fx("break_start") });
    expect(ghost()).not.toBeNull();
    expect(home().dataset.beatPhase).toBe("enter");
    expect(hero().querySelector(".vp-hero-surface")).toBe(surface);   // no second surface move
    // The clock-in still rests on its own timer: 1060 ms after the swap,
    // i.e. 580 ms after the arm the pause was tapped at.
    await advance(579);
    expect(home().dataset.beatPhase).toBe("enter");
    await advance(1);
    expect(anyBeat()).toBeNull();
    expect(ghost()).not.toBeNull();                     // the pause's own window: 680 ms
    await advance(100);
    expect(ghost()).toBeNull();
  });
});

describe("13 · Reduced motion (or no matchMedia): nothing extra", () => {
  for (const [name, setup] of [
    ["prefers-reduced-motion", () => motionPref({ reduce: true })],
    ["no matchMedia", () => { delete window.matchMedia; }],
  ]) {
    it(`${name}: clock in / out swap at once; no beat, no surface, no inert; the haptic once`, async () => {
      setup();
      await mount();
      let d = holdPost();
      await click(clockIn());
      await settle(d, { data: fx("clock_in") });
      expect(hero().dataset.state).toBe("live");
      expect(anyBeat()).toBeNull();
      expect(hero().querySelector(".vp-hero-surface")).toBeNull();
      expect(hero().hasAttribute("inert")).toBe(false);
      expect(haptic.success).toHaveBeenCalledTimes(1);

      d = holdPost();
      await click(screen.getByTestId("portal-clock-out"));
      await settle(d, { data: { ...fx("clock_out"), worked_hours: 0, discarded: true } });
      expect(hero().dataset.state).toBe("next");
      expect(anyBeat()).toBeNull();
      expect(haptic.warning).toHaveBeenCalledTimes(1);
    });

    it(`${name}: a pause leaves no ghost`, async () => {
      setup();
      at(Number(DAY.slice(0, 4)), Number(DAY.slice(5, 7)), Number(DAY.slice(8, 10)), 12, 0, 20);
      shifts = [DAY_SHIFT];
      clockImpl = () => ok(fx("clock_live"));
      await mount();
      const d = holdPost();
      await click(screen.getByTestId("portal-break-btn"));
      await settle(d, { data: fx("break_start") });
      expect(screen.getByTestId("portal-live-arc").getAttribute("stroke")).toBe("#A9B8AE");
      expect(document.querySelector(".vp-arc-ghost")).toBeNull();
      expect(anyBeat()).toBeNull();
    });
  }
});

describe("14-15 · Testids, labels and the knob kept", () => {
  it("14 · during the enter every testid is there, the ring's label is today's, the arc is p·C", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    // A stale screen (the punch is 90 min old): the arc has length.
    await settle(d, { data: { ...fx("clock_in"), since: "08:30", elapsed_sec: 5400 } });
    await advance(180);
    expect(home().dataset.beatPhase).toBe("enter");
    for (const id of ["portal-hero", "portal-live-shift", "portal-live-chip", "portal-live-ring", "portal-live-elapsed", "portal-live-sub", "portal-live-pause", "portal-clock-out"]) {
      expect(screen.getByTestId(id), id).toBeInTheDocument();
    }
    const dot = screen.getByTestId("portal-live-dot");
    expect(dot.className).toContain("vp-breathe");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    const label = screen.getByTestId("portal-live-ring").getAttribute("aria-label");
    expect(label).toMatch(/^På vagt i 1 t 30 min\. .+ tilbage\.$/);
    // 90 min of the planned 6 h: 25 % of 552.9.
    expect(screen.getByTestId("portal-live-arc").getAttribute("stroke-dasharray")).toBe("138.2 552.9");
    expect(screen.getByTestId("portal-live-elapsed").className).toBe("tabular-nums vp-lc-digits");
    // The same label at rest.
    await advance(480);
    await advance(580);
    expect(anyBeat()).toBeNull();
    expect(screen.getByTestId("portal-live-ring").getAttribute("aria-label")).toBe(label);
  });

  it("15 · the knob at rest keeps its cx / cy (2 t 16 min of 6 t → 46° past 3 o'clock)", async () => {
    at(2026, 11, 11, 12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    const knob = screen.getByTestId("portal-live-ring").querySelector("circle.vp-lc-knob");
    expect(knob.getAttribute("cx")).toBe("161.1");
    expect(knob.getAttribute("cy")).toBe("163.3");
    const track = screen.getByTestId("portal-live-ring").querySelector("circle.vp-lc-track");
    expect(track.getAttribute("transform")).toBe("rotate(-90 100 100)");
    expect(anyBeat()).toBeNull();
  });
});
