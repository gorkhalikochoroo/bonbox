/**
 * The clock tells the truth at once (premium feel 1.2, PREMIUM-FEEL-SPEC.md),
 * on the REAL page against a mocked portalApi. Date, the timeouts and the
 * intervals are fake and advanced inside act(); the DOM is read with getBy
 * after each advance.
 *
 *   a) Memory: back on Vagtplan during a shift (a remount of the home), the
 *      card is the live card from the first frame — seeded from the last
 *      answer, its elapsed caught up by the seconds since. The load and the
 *      poll still run; a seed is never a beat. The memory dies with the
 *      portal.
 *   b) The wait has a look: Stempl ind keeps its size and colour, turns a
 *      ring after 300 ms, and dims only when it truly can't (locked). On the
 *      live card only the tapped button rings; its sibling dims (0.6). During
 *      the clock-out's leave the tapped button holds what it showed.
 *   c) Cold start: the card draws at once; only Stempl ind waits for the
 *      clock's first answer, at most 1.5 s (then it enables: fail-open).
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
const fx = (name) => structuredClone(C.steps.find((s) => s.name === name).body);

const TOK = "toktruth";
const ok = (data) => Promise.resolve({ data });
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

// Wednesday 11 Nov 2026.
const WED = "2026-11-11";
const WED_SHIFT = { id: "w1", date: WED, start_time: "10:00", end_time: "16:00", status: "published", net_hours: 5.5, break_minutes: 30, role_on_shift: "Tjener" };
const OUT = { clocked_in: false, geofence_on: false, locked: false };
const CLOCKED = { clocked_in: true, since: "09:58", elapsed_sec: 2 * 3600 + 16 * 60, geofence_on: false, locked: false, breaks_live: true, on_break: false, break_minutes_so_far: 0 };

let clockImpl;
let postImpl;
// Any link token: the page asks /portal/<token>/…
const get = vi.fn((url) => {
  const m = url.match(/^\/portal\/([^/]+)(\/.*)?$/);
  const sub = m?.[2] || "";
  if (!sub) return ok({ has_pin: false, staff_name: "Freja Nielsen", role: "server", restaurant_name: "Café Solsikke" });
  if (sub.startsWith("/schedule")) return ok({ shifts: [WED_SHIFT] });
  if (sub === "/clock") return clockImpl();
  if (sub.startsWith("/hours")) return ok({ period_start: WED, period_end: WED, total_hours: 0, entries: [] });
  if (sub.includes("/notifications")) return ok({ notifications: [] });
  if (sub.endsWith("/chat/unread")) return ok({ unread: 0 });
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

function renderPortal(token = TOK) {
  localStorage.setItem("lang", "da");
  return render(
    <LanguageProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/portal/${token}`]}>
          <Routes>
            <Route path="/portal/:token" element={<StaffPortalPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </LanguageProvider>,
  );
}
async function mount(token = TOK) {
  const view = renderPortal(token);
  await flush(8);
  expect(screen.getByTestId("portal-hero")).toBeInTheDocument();
  return view;
}

const hero = () => screen.getByTestId("portal-hero");
const clockIn = () => within(hero()).getByRole("button", { name: /Stempl ind/ });
const busyOf = (btn) => btn.querySelector(":scope > .vp-busy").dataset.state;
const anyBeat = () => document.querySelector("[data-beat-phase], [data-clock-beat], [data-beat-lap]");
const clockReads = () => get.mock.calls.filter(([u]) => /^\/portal\/[^/]+\/clock$/.test(u)).length;
const at = (h, m = 0, s = 0) => vi.setSystemTime(new Date(2026, 10, 11, h, m, s));
function holdPost() {
  const d = deferred();
  postImpl = () => d.promise;
  return d;
}
function holdClock() {
  const d = deferred();
  clockImpl = () => d.promise;
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  at(9, 50);
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  for (const k of ["success", "warning", "error", "light"]) haptic[k].mockClear();
  clockImpl = () => ok(OUT);
  postImpl = () => ok({});
  motionPref({ reduce: false });
});

afterEach(() => {
  vi.useRealTimers();
  delete window.matchMedia;
});

describe("a) Memory: back on Vagtplan the card is right at once", () => {
  it("clocked in → Timer → Vagtplan: live in the first render after the switch (the clock still re-reads); no beat, no haptic", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    expect(hero().dataset.state).toBe("live");
    await click(screen.getByTestId("portal-tab-hours"));
    await flush();
    holdClock();
    const reads = clockReads();
    await click(screen.getByTestId("portal-tab-schedule"));
    expect(hero().dataset.state).toBe("live");
    expect(screen.getByTestId("portal-live-chip").textContent).toBe("Stemplet ind kl. 09:58");
    expect(clockReads()).toBe(reads + 1);            // the server stays the truth
    expect(anyBeat()).toBeNull();
    await advance(2000);
    expect(anyBeat()).toBeNull();
    expect(hero().dataset.state).toBe("live");
    expect(haptic.success).not.toHaveBeenCalled();
  });

  it("the seeded elapsed is the stored elapsed plus the seconds since it was stored", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:16");
    await click(screen.getByTestId("portal-tab-hours"));
    await flush();
    at(12, 19);                                      // five minutes on Timer
    holdClock();
    await click(screen.getByTestId("portal-tab-schedule"));
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:21");
  });

  it("a stale seed (clocked out on another phone) swaps plainly when the server answers: no beat", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    await click(screen.getByTestId("portal-tab-hours"));
    await flush();
    const d = holdClock();
    await click(screen.getByTestId("portal-tab-schedule"));
    expect(hero().dataset.state).toBe("live");
    await settle(d, { data: OUT });
    expect(hero().dataset.state).toBe("next");
    expect(anyBeat()).toBeNull();
    expect(haptic.success).not.toHaveBeenCalled();
  });

  it("unmounting the portal clears the memory: a remount (same link or another) gets no seed", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    const view = await mount();
    expect(hero().dataset.state).toBe("live");
    view.unmount();
    holdClock();
    const again = await mount();
    expect(hero().dataset.state).toBe("next");
    again.unmount();
    holdClock();
    await mount("toktruth-other");
    expect(hero().dataset.state).toBe("next");
  });
});

describe("c) Cold start: the card draws at once, only Stempl ind waits", () => {
  // A shift in 30 min, the clock's first GET held.
  async function coldStart() {
    at(9, 30);
    const d = holdClock();
    await mount();
    expect(hero().dataset.state).toBe("next");
    expect(screen.getByTestId("portal-hero-time").textContent).toBe("10:00–16:00");
    expect(screen.queryByTestId("portal-hero-loading")).toBeNull();    // no placeholder: nothing jumps
    const btn = clockIn();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.className).not.toMatch(/disabled:opacity/);
    expect(btn.textContent).toBe("Stempl ind");                         // the label stays in the DOM
    await advance(299);
    expect(busyOf(clockIn())).toBe("idle");
    await advance(2);
    expect(busyOf(clockIn())).toBe("busy");
    return d;
  }

  it("the answer is 'out': Stempl ind enables", async () => {
    const d = await coldStart();
    await settle(d, { data: OUT });
    const btn = clockIn();
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute("aria-busy")).toBe(false);
    expect(busyOf(btn)).toBe("idle");
  });

  it("the answer is 'in': the live card, plainly (no beat)", async () => {
    const d = await coldStart();
    await settle(d, { data: { ...fx("clock_in"), since: "09:28", elapsed_sec: 120 } });
    expect(hero().dataset.state).toBe("live");
    expect(anyBeat()).toBeNull();
    expect(haptic.success).not.toHaveBeenCalled();
  });

  it("no answer: after 1.5 s it enables anyway (fail-open, as before)", async () => {
    await coldStart();                               // now at 301 ms
    await advance(1198);
    expect(clockIn().disabled).toBe(true);
    await advance(1);
    expect(clockIn().disabled).toBe(false);
    expect(busyOf(clockIn())).toBe("idle");
    expect(clockIn().hasAttribute("aria-busy")).toBe(false);
  });

  it("with no shift soon nothing waits: no Stempl ind on the card at all, as before", async () => {
    at(3, 30);
    holdClock();
    await mount();
    expect(within(hero()).queryByRole("button", { name: /Stempl ind/ })).toBeNull();
  });
});

describe("b) The wait has a look", () => {
  it("Stempl ind on a real tap: the label until 300 ms, then the ring; disabled throughout; no busy dim", async () => {
    await mount();
    const d = holdPost();
    await click(clockIn());
    const btn = clockIn();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.className).not.toMatch(/disabled:opacity-50/);
    await advance(299);
    expect(busyOf(clockIn())).toBe("idle");
    await advance(2);
    expect(busyOf(clockIn())).toBe("busy");
    expect(clockIn().disabled).toBe(true);
    await settle(d, { data: fx("clock_in") });
    // The beat's leave: the fading card's button holds what it showed.
    expect(busyOf(clockIn())).toBe("busy");
  });

  it("a locked Stempl ind ('you can't yet') keeps its dim", async () => {
    clockImpl = () => ok({ ...OUT, locked: true, opens_at: "09:45" });
    await mount();
    const btn = clockIn();
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain("disabled:opacity-50");
    expect(btn.hasAttribute("aria-busy")).toBe(false);
  });

  it("live card: Stempl ud tapped (POST held 400 ms) rings; the pause button shows no ring and dims to 0.6; both disabled", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    const out = () => screen.getByTestId("portal-clock-out");
    const pause = () => screen.getByTestId("portal-break-btn");
    // Fix round (reduce-no-press-live-card): at rest and on the tapped one,
    // NO inline opacity (it was an inline "1"). An inline 1 beat the Reduce
    // Motion press dim (.72), so these buttons showed no press at all. Full
    // opacity is still what shows: nothing else sets one.
    expect(out().style.opacity).toBe("");
    expect(pause().style.opacity).toBe("");
    expect(out().className).not.toMatch(/disabled:opacity/);
    expect(pause().className).not.toMatch(/disabled:opacity/);
    holdPost();
    await click(out());
    await advance(400);
    expect(busyOf(out())).toBe("busy");
    expect(out().getAttribute("aria-busy")).toBe("true");
    expect(out().style.opacity).toBe("");
    expect(busyOf(pause())).toBe("idle");
    expect(pause().hasAttribute("aria-busy")).toBe(false);
    expect(pause().style.opacity).toBe("0.6");
    expect(out().disabled).toBe(true);
    expect(pause().disabled).toBe(true);
  });

  // Fix round (reduce-no-press-live-card): the inline opacity 1 used to beat
  // the reduce block's press dim, so the two most-touched buttons gave no
  // feedback at all under Reduce Motion.
  it("Reduce Motion, nothing busy: a touch press marks Stempl ud and Start pause (data-pressed) with no inline opacity, so the CSS dim (.72) shows", async () => {
    motionPref({ reduce: true });
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "staff", "vagtplan.css"), "utf8");
    const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toMatch(/html\[data-modality="touch"\] \.vp-press\[data-pressed\]:not\(:disabled\),[\s\S]*?\{ scale: none; opacity: \.72; \}/);
    for (const id of ["portal-clock-out", "portal-break-btn"]) {
      const btn = screen.getByTestId(id);
      expect(btn.style.opacity).toBe("");
      const e = new Event("pointerdown", { bubbles: true, cancelable: true });
      Object.assign(e, { pointerType: "touch", isPrimary: true, clientX: 5, clientY: 5 });
      act(() => { btn.dispatchEvent(e); });
      expect(btn.hasAttribute("data-pressed")).toBe(true);
      expect(btn.style.opacity).toBe("");
      const up = new Event("pointerup", { bubbles: true });
      Object.assign(up, { pointerType: "touch", isPrimary: true });
      act(() => { btn.dispatchEvent(up); });
    }
  });

  it("live card: the pause tapped rings; Stempl ud dims", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    holdPost();
    await click(screen.getByTestId("portal-break-btn"));
    await advance(400);
    expect(busyOf(screen.getByTestId("portal-break-btn"))).toBe("busy");
    expect(busyOf(screen.getByTestId("portal-clock-out"))).toBe("idle");
    expect(screen.getByTestId("portal-clock-out").style.opacity).toBe("0.6");
  });

  it("clock-out answered at 200 ms: through the 240 ms leave the tapped button never turns to the ring (hold)", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    const d = holdPost();
    await click(screen.getByTestId("portal-clock-out"));
    await advance(200);
    await settle(d, { data: { ...fx("clock_out"), worked_hours: 2.25 } });
    expect(document.querySelector("[data-beat-phase]").dataset.beatPhase).toBe("leave");
    expect(busyOf(screen.getByTestId("portal-clock-out"))).toBe("idle");
    expect(screen.getByTestId("portal-clock-out").disabled).toBe(true);
    // The sibling stays dimmed, as during the request.
    expect(screen.getByTestId("portal-break-btn").style.opacity).toBe("0.6");
    await advance(239);
    expect(hero().dataset.state).toBe("live");
    expect(busyOf(screen.getByTestId("portal-clock-out"))).toBe("idle");
    await advance(1);
    expect(hero().dataset.state).toBe("next");
  });

  it("clock-out answered at 400 ms: the ring it showed stays through the leave", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount();
    const d = holdPost();
    await click(screen.getByTestId("portal-clock-out"));
    await advance(400);
    expect(busyOf(screen.getByTestId("portal-clock-out"))).toBe("busy");
    await settle(d, { data: { ...fx("clock_out"), worked_hours: 2.25 } });
    expect(document.querySelector("[data-beat-phase]").dataset.beatPhase).toBe("leave");
    expect(busyOf(screen.getByTestId("portal-clock-out"))).toBe("busy");
    await advance(239);
    expect(busyOf(screen.getByTestId("portal-clock-out"))).toBe("busy");
  });
});
