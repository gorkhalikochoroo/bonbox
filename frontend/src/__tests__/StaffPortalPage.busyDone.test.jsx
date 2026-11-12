/**
 * Premium feel 1.7, busy → done buttons (PREMIUM-FEEL-SPEC.md), on the REAL
 * page against a mocked portalApi and a spied components/staff/feel. Date and
 * the timers are fake and advanced inside act().
 *
 *   • The button stays the same object: no "…", no dim, the same name; it is
 *     disabled and aria-busy while the answer is out, and turns a ring only
 *     after 300 ms.
 *   • On a yes the check lands with the action's one haptic and holds 900 ms
 *     while the button stays disabled (a second tap sends nothing). A reload
 *     that would remove or replace the button waits for the hold — only when
 *     motion is allowed; without matchMedia it runs at once, as before.
 *   • On a no the label comes back at once, the reason shows, no check.
 * BusyLabel itself (timings, hold, one grid cell) is pinned in BusyLabel.test.jsx.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokbusy";
const ok = (data) => Promise.resolve({ data });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const spy = vi.hoisted(() => ({
  feel: { done: vi.fn(), warn: vi.fn(), fail: vi.fn(), soft: vi.fn(), tick: vi.fn(), warm: vi.fn() },
}));
vi.mock("../components/staff/feel", () => ({ feel: spy.feel, resetFeelForTests: () => {} }));

// Wednesday 11 Nov 2026, 09:50. The staffer's shift is Friday (no punch on the
// card, so the card asks "Jeg har set det"); the open shift is Saturday.
const FRI = "2026-11-13";
const SAT = "2026-11-14";
const OPEN = { id: "o1", date: SAT, start_time: "16:00", end_time: "22:00", role: "bartender" };
const INCOMING = {
  id: "in", direction: "incoming", status: "proposed", from_staff_name: "Ida H.", to_staff_name: "Freja M.",
  from_shift_date: "2026-11-16", from_shift_time: "10:00–16:00", to_shift_id: "x", to_shift_date: "2026-11-17", to_shift_time: "16:00–22:00",
};

let data;
// A read held open (a slow reload on 4G): { part, d }. Fix round, busy-done-window.
let heldGet = null;
const get = vi.fn((url) => {
  const sub = url.slice(`/portal/${TOK}`.length);
  if (heldGet && sub.startsWith(heldGet.part)) return heldGet.d.promise;
  if (sub === "") return ok({ has_pin: false, staff_name: "Freja M.", role: "waiter", restaurant_name: "Café Solsikke" });
  if (sub.startsWith("/schedule")) return ok({ shifts: data.shifts });
  if (sub.startsWith("/open-shifts")) return ok(data.open);
  if (sub.startsWith("/team-schedule")) return ok([]);
  if (sub === "/clock") return ok({ clocked_in: false, geofence_on: false, locked: false });
  if (sub.startsWith("/hours")) return ok({ period_start: FRI, period_end: FRI, total_hours: 0, entries: [] });
  if (sub.startsWith("/notifications")) return ok({ notifications: [] });
  if (sub === "/chat/unread") return ok({ unread: 0 });
  if (sub.startsWith("/swap-requests")) return ok(data.swaps);
  if (sub.startsWith("/give-aways")) return ok(data.pool);
  return ok([]);
});
let postImpl;
const post = vi.fn((...a) => postImpl(...a));

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(() => ok({})), defaults: { baseURL: "" } },
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
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn(), takePhotoFile: vi.fn(), choosePhotoFiles: vi.fn(), isCameraDenied: vi.fn() }));

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
const busyOf = (btn) => btn.querySelector(":scope > .vp-busy").dataset.state;
const reads = (part) => get.mock.calls.filter(([u]) => u.startsWith(`/portal/${TOK}${part}`)).length;
const posts = (part) => post.mock.calls.filter(([u]) => u.endsWith(part)).length;
const feelCalls = () => Object.fromEntries(Object.entries(spy.feel).map(([k, f]) => [k, f.mock.calls.length]).filter(([, n]) => n));
function holdPost() {
  const d = deferred();
  postImpl = () => d.promise;
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 10, 11, 9, 50, 0));
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  Object.values(spy.feel).forEach((f) => f.mockClear());
  postImpl = () => ok({});
  heldGet = null;
  data = {
    shifts: [{ id: "f1", date: FRI, start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5 }],
    open: [OPEN],
    swaps: [INCOMING],
    pool: [],
  };
});
afterEach(() => {
  vi.useRealTimers();
  delete window.matchMedia;
  document.body.classList.remove("portal-shell");
});

describe("Tag den (an open shift)", () => {
  it("motion: same object while waiting (ring after 300 ms); on a yes the check, done once, the line, still disabled; the reload waits 900 ms", async () => {
    motionPref({ reduce: false });
    await mount();
    const take = () => within(screen.getByTestId("portal-open-shifts")).getByRole("button", { name: "Tag den" });
    expect(busyOf(take())).toBe("idle");
    const d = holdPost();
    const before = reads("/open-shifts");
    await click(take());
    // The name stays "Tag den" (no "…"), no dim class, disabled and aria-busy.
    expect(take().disabled).toBe(true);
    expect(take().getAttribute("aria-busy")).toBe("true");
    expect(take().className).not.toMatch(/disabled:opacity/);
    await advance(299);
    expect(busyOf(take())).toBe("idle");
    await advance(2);
    expect(busyOf(take())).toBe("busy");
    await advance(99);                                   // the POST answered after 400 ms
    data.open = [];                                      // the server no longer offers it
    await settle(d, { data: {} });
    expect(busyOf(take())).toBe("done");
    expect(feelCalls()).toEqual({ done: 1 });
    expect(screen.getByText("Tilføjet til din vagtplan.")).toBeInTheDocument();
    expect(take().disabled).toBe(true);
    expect(take().hasAttribute("aria-busy")).toBe(false);
    // A second tap during the hold sends nothing (it would print "just taken").
    await click(take());
    expect(posts("/open-shifts/o1/claim")).toBe(1);
    // The reload waits for the check.
    expect(reads("/open-shifts")).toBe(before);
    await advance(890);
    expect(reads("/open-shifts")).toBe(before);
    await advance(10);
    await flush(4);
    expect(reads("/open-shifts")).toBe(before + 1);
    // Then the row goes; the line stays for its moment.
    expect(within(screen.getByTestId("portal-open-shifts")).queryByRole("button", { name: "Tag den" })).toBeNull();
    expect(screen.getByText("Tilføjet til din vagtplan.")).toBeInTheDocument();
  });

  it("without matchMedia (no motion): the reload runs at once, exactly as before", async () => {
    delete window.matchMedia;
    await mount();
    const take = within(screen.getByTestId("portal-open-shifts")).getByRole("button", { name: "Tag den" });
    const before = reads("/open-shifts");
    data.open = [];
    await click(take);
    await flush(4);
    expect(posts("/open-shifts/o1/claim")).toBe(1);
    expect(spy.feel.done).toHaveBeenCalledTimes(1);
    expect(reads("/open-shifts")).toBe(before + 1);
  });

  it("refused (just taken): the label at once, the reason, warn — and the reload at once (it drops the taken shift)", async () => {
    motionPref({ reduce: false });
    await mount();
    const take = () => within(screen.getByTestId("portal-open-shifts")).getByRole("button", { name: "Tag den" });
    const d = holdPost();
    const before = reads("/open-shifts");
    await click(take());
    await advance(400);
    expect(busyOf(take())).toBe("busy");
    await refuse(d, Object.assign(new Error("409"), { response: { status: 409, data: { detail: { code: "already_taken" } } } }));
    expect(busyOf(take())).toBe("idle");
    expect(take().disabled).toBe(false);
    expect(screen.getByText("Den vagt blev lige taget.")).toBeInTheDocument();
    expect(feelCalls()).toEqual({ warn: 1 });
    expect(reads("/open-shifts")).toBe(before + 1);
  });
});

// Fix round (busy-done-window): the check used to clear at 900 ms while the
// reload was still out, so the old row showed an ENABLED label again and a
// second tap POSTed a second time ("That shift was just taken", a warn
// haptic for a shift you just got). It now holds until the reload answers.
function holdGet(part) {
  const d = deferred();
  heldGet = { part, d };
  return d;
}
async function release(d, part) {
  heldGet = null;
  await act(async () => {
    d.resolve({ data: part === "/schedule" ? { shifts: data.shifts } : part === "/open-shifts" ? data.open : part === "/give-aways" ? data.pool : data.swaps });
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  await flush(4);
}

describe("busy → done holds until the reload has answered (slow 4G)", () => {
  it("Tag den, motion: at 901 ms, with the reload still out, the check still shows, the pill is disabled, a second tap sends nothing; the row goes when the reload lands", async () => {
    motionPref({ reduce: false });
    await mount();
    const take = () => within(screen.getByTestId("portal-open-shifts")).getByRole("button", { name: "Tag den" });
    await click(take());
    await flush(2);
    expect(busyOf(take())).toBe("done");
    const slow = holdGet("/open-shifts");
    data.open = [];
    await advance(901);
    await flush(2);
    expect(get.mock.calls.some(([u]) => u === `/portal/${TOK}/open-shifts`)).toBe(true);
    expect(busyOf(take())).toBe("done");
    expect(take().disabled).toBe(true);
    await click(take());
    await advance(2000);
    expect(busyOf(take())).toBe("done");
    expect(posts("/open-shifts/o1/claim")).toBe(1);
    expect(spy.feel.warn).not.toHaveBeenCalled();
    await release(slow, "/open-shifts");
    expect(within(screen.getByTestId("portal-open-shifts")).queryByRole("button", { name: "Tag den" })).toBeNull();
    expect(posts("/open-shifts/o1/claim")).toBe(1);
  });

  it("Tag den, no motion: the reload runs at once and the pill stays disabled until it answers", async () => {
    delete window.matchMedia;
    await mount();
    const take = () => within(screen.getByTestId("portal-open-shifts")).getByRole("button", { name: "Tag den" });
    const slow = holdGet("/open-shifts");
    data.open = [];
    await click(take());
    await advance(901);
    expect(take().disabled).toBe(true);
    await click(take());
    expect(posts("/open-shifts/o1/claim")).toBe(1);
    await release(slow, "/open-shifts");
    expect(within(screen.getByTestId("portal-open-shifts")).queryByRole("button", { name: "Tag den" })).toBeNull();
  });

  it("the check lets go when the reload answers, if the row is still there (nothing removed it)", async () => {
    motionPref({ reduce: false });
    await mount();
    const take = () => within(screen.getByTestId("portal-open-shifts")).getByRole("button", { name: "Tag den" });
    await click(take());
    await flush(2);
    const slow = holdGet("/open-shifts");
    await advance(901);
    expect(busyOf(take())).toBe("done");
    await release(slow, "/open-shifts");       // data.open still offers it
    expect(busyOf(take())).toBe("idle");
    expect(take().disabled).toBe(false);
  });

  it("Jeg har set det, motion: the check holds past 900 ms while the schedule reload is out; the dashed card when it lands", async () => {
    motionPref({ reduce: false });
    await mount();
    const seen = () => screen.getByTestId("portal-seen-it");
    postImpl = () => ok({ confirmed_count: 1 });
    data.shifts = data.shifts.map((x) => ({ ...x, confirmed_at: "2026-11-11T09:50:00" }));
    await click(seen());
    await flush(2);
    const slow = holdGet("/schedule");
    await advance(901);
    expect(busyOf(seen())).toBe("done");
    expect(seen().disabled).toBe(true);
    await click(seen());
    expect(posts("/confirm-schedule")).toBe(1);
    await release(slow, "/schedule");
    expect(screen.queryByTestId("portal-seen-it")).toBeNull();
    expect(screen.getByTestId("portal-hero-confirmed")).toBeInTheDocument();
  });

  it("Byt: Accepter, motion: both buttons stay disabled past 900 ms while the re-read is out", async () => {
    motionPref({ reduce: false });
    await mount();
    await click(screen.getByTestId("portal-tab-swaps"));
    await flush(4);
    const row = screen.getAllByTestId("swap-row")[0];
    const accept = () => within(row).getByTestId("swap-accept");
    await click(accept());
    await flush(2);
    expect(busyOf(accept())).toBe("done");
    const slow = holdGet("/swap-requests");
    await advance(901);
    expect(busyOf(accept())).toBe("done");
    expect(accept().disabled).toBe(true);
    expect(within(row).getByTestId("swap-decline").disabled).toBe(true);
    await click(accept());
    expect(posts("/swap-requests/in/respond")).toBe(1);
    await release(slow, "/swap-requests");
    expect(busyOf(accept())).toBe("idle");
  });

  it("Byt: a give-away's Tag den, motion: the check holds while the pool re-read is out", async () => {
    motionPref({ reduce: false });
    data.swaps = [];
    data.pool = [{ id: "ga-1", from_staff_name: "Ida Hansen", from_shift_date: "2026-11-18", from_shift_time: "16:00–22:00", reason: "" }];
    await mount();
    await click(screen.getByTestId("portal-tab-swaps"));
    await flush(4);
    const take = () => within(screen.getByTestId("swap-pool-row")).getByRole("button", { name: "Tag den" });
    await click(take());
    await flush(2);
    const slow = holdGet("/give-aways");
    data.pool = [];
    await advance(901);
    expect(busyOf(take())).toBe("done");
    expect(take().disabled).toBe(true);
    await click(take());
    expect(posts("/give-aways/ga-1/claim")).toBe(1);
    await release(slow, "/give-aways");
    expect(screen.queryByTestId("swap-pool-row")).toBeNull();
  });
});

describe("Jeg har set det", () => {
  it("motion: the check holds 900 ms (still disabled), the count line at once; the dashed card only after the hold", async () => {
    motionPref({ reduce: false });
    await mount();
    const seen = () => screen.getByTestId("portal-seen-it");
    expect(seen().textContent).toBe("Jeg har set det");
    expect(seen().className).not.toMatch(/disabled:opacity/);
    const d = holdPost();
    await click(seen());
    expect(seen().disabled).toBe(true);
    expect(seen().getAttribute("aria-busy")).toBe("true");
    expect(seen().textContent).toBe("Jeg har set det");      // never "…"
    data.shifts = data.shifts.map((s) => ({ ...s, confirmed_at: "2026-11-11T09:50:00" }));
    await settle(d, { data: { confirmed_count: 1 } });
    expect(busyOf(seen())).toBe("done");
    expect(seen().disabled).toBe(true);
    expect(screen.getByText("✓ 1 vagt bekræftet")).toBeInTheDocument();
    expect(spy.feel.soft).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("portal-hero-confirmed")).toBeNull();
    await advance(900);
    await flush(4);
    expect(screen.queryByTestId("portal-seen-it")).toBeNull();
    expect(screen.getByTestId("portal-hero-confirmed")).toBeInTheDocument();
  });
});

describe("Byt: Accepter", () => {
  async function openSwaps() {
    await mount();
    await click(screen.getByTestId("portal-tab-swaps"));
    await flush(4);
    return screen.getAllByTestId("swap-row")[0];
  }

  it("a yes: the check and done once; Accepter and Afvis stay disabled through the hold; the re-read only after it", async () => {
    motionPref({ reduce: false });
    const row = await openSwaps();
    const accept = () => within(row).getByTestId("swap-accept");
    const decline = () => within(row).getByTestId("swap-decline");
    const d = holdPost();
    const before = reads("/swap-requests");
    await click(accept());
    // The tapped one keeps its colour (pine); its sibling keeps the dim.
    expect(accept().style.background).toBe("rgb(14, 59, 46)");
    expect(accept().getAttribute("aria-busy")).toBe("true");
    expect(decline().className).toContain("disabled:opacity-50");
    expect(decline().hasAttribute("aria-busy")).toBe(false);
    await advance(350);
    expect(busyOf(accept())).toBe("busy");
    expect(busyOf(decline())).toBe("idle");
    await settle(d, { data: {} });
    expect(busyOf(accept())).toBe("done");
    expect(feelCalls()).toEqual({ done: 1 });
    expect(accept().disabled).toBe(true);
    expect(decline().disabled).toBe(true);
    expect(reads("/swap-requests")).toBe(before);
    await advance(900);
    await flush(2);
    expect(reads("/swap-requests")).toBe(before + 1);
  });

  it("refused (it would double-book you): the label back at once, the reason, warn; no check", async () => {
    motionPref({ reduce: false });
    const row = await openSwaps();
    const accept = () => within(row).getByTestId("swap-accept");
    const d = holdPost();
    await click(accept());
    await advance(350);
    expect(busyOf(accept())).toBe("busy");
    await refuse(d, Object.assign(new Error("409"), {
      response: { status: 409, data: { detail: { code: "swap_overlap", who: "self", message: "overlap" } } },
    }));
    expect(busyOf(accept())).toBe("idle");
    expect(accept().disabled).toBe(false);
    expect(within(row).getByText("Du har allerede en vagt på det tidspunkt — byttet ville give dig to vagter på samme tid.")).toBeInTheDocument();
    expect(feelCalls()).toEqual({ warn: 1 });
  });

  it("Afvis: the busy look only (no check), and the re-read at once", async () => {
    motionPref({ reduce: false });
    const row = await openSwaps();
    const decline = () => within(row).getByTestId("swap-decline");
    const d = holdPost();
    const before = reads("/swap-requests");
    await click(decline());
    expect(decline().className).not.toMatch(/disabled:opacity/);
    expect(decline().getAttribute("aria-busy")).toBe("true");
    await advance(350);
    expect(busyOf(decline())).toBe("busy");
    await settle(d, { data: {} });
    expect(busyOf(decline())).toBe("idle");
    expect(feelCalls()).toEqual({ soft: 1 });
    expect(reads("/swap-requests")).toBe(before + 1);
  });
});

describe("Byt: a give-away's Tag den", () => {
  it("motion: the check on the claimed row, done once; it leaves the pool only after the hold", async () => {
    motionPref({ reduce: false });
    data.swaps = [];
    data.pool = [{ id: "ga-1", from_staff_name: "Ida Hansen", from_shift_date: "2026-11-18", from_shift_time: "16:00–22:00", reason: "" }];
    await mount();
    await click(screen.getByTestId("portal-tab-swaps"));
    await flush(4);
    const take = () => within(screen.getByTestId("swap-pool-row")).getByRole("button", { name: "Tag den" });
    const before = reads("/give-aways");
    data.pool = [];
    await click(take());
    await flush(2);
    expect(busyOf(take())).toBe("done");
    expect(take().disabled).toBe(true);
    expect(feelCalls()).toEqual({ done: 1 });
    expect(reads("/give-aways")).toBe(before);
    await advance(900);
    await flush(4);
    expect(reads("/give-aways")).toBe(before + 1);
    expect(screen.queryByTestId("swap-pool-row")).toBeNull();
  });
});
