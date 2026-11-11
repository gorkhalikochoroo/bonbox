/**
 * Live pauses — the staff app against the REAL backend contract.
 *
 * Contract sibling of StaffPortalPage.canvasHome.test.jsx (whose pause stubs
 * are hand-written). Every body this file feeds the page — clock states, the
 * pause answers, the error bodies, clock-out, the owner switch — comes from
 * fixtures/liveBreaksContract.json, which backend/tests/
 * test_live_breaks_contract.py WRITES from the real endpoints and re-checks on
 * every run. So when the server renames a field, changes an error code or
 * moves a path, the backend test goes red, the file is regenerated, and this
 * test then fails on the app's side if the page did not follow.
 *
 * Pinned here: the paths the page posts to (no body — server time), Start →
 * Slut pause on the real answers, the discarded-misclick answer, quiet
 * re-reads on the real 409s, the polite 403 breaks_off, a pause still running
 * after the owner switched off, clock-out with recorded pauses, the PIN proof
 * header on the pause paths (the REAL portalApi), and the owner's switch body.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const C = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "liveBreaksContract.json"), "utf8"),
);
const STEP = Object.fromEntries(C.steps.map((s) => [s.name, s]));
const TOK = C.token;
const path = (key) => C.paths[key].replace("{token}", TOK);
const body = (name) => structuredClone(STEP[name].body);

// A step as axios would hand it to the page: 2xx resolves {data}, anything
// else rejects with err.response = {status, data} — the real body.
const reply = (name) => {
  const s = STEP[name];
  if (s.status >= 200 && s.status < 300) return Promise.resolve({ data: body(name) });
  const e = new Error(`Request failed with status code ${s.status}`);
  e.response = { status: s.status, data: body(name) };
  return Promise.reject(e);
};

const DAY = C.steps[0].at.slice(0, 10); // the scenario's date
const [Y, M, D] = DAY.split("-").map(Number);
const at = (h, m = 0, s = 0) => vi.setSystemTime(new Date(Y, M - 1, D, h, m, s));
// The planned shift the clock-in belongs to (09:00 clock-in → 09:00–17:00).
const SHIFT = { id: "c1", date: DAY, start_time: "09:00", end_time: "17:00", status: "published", net_hours: 7.5, break_minutes: 30, role_on_shift: "Tjener" };

let clockImpl;
let postImpl;
const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return Promise.resolve({ data: { has_pin: false, staff_name: "Agnes Holm", role: "server", restaurant_name: "Bon" } });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) return Promise.resolve({ data: { shifts: [SHIFT] } });
  if (url === path("clock")) return clockImpl();
  if (url.startsWith(`/portal/${TOK}/hours`)) return Promise.resolve({ data: { period_start: DAY, period_end: DAY, total_hours: 0, entries: [] } });
  if (url.includes("/notifications")) return Promise.resolve({ data: { notifications: [] } });
  if (url.endsWith("/chat/unread")) return Promise.resolve({ data: { unread: 0 } });
  return Promise.resolve({ data: [] });
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
const { ClockGeofenceSettings } = await import("../pages/StaffSchedulePage");
const api = (await import("../services/api")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

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
  await waitFor(() => expect(get.mock.calls.some(([u]) => u === path("clock"))).toBe(true));
}

const postsTo = (key) => post.mock.calls.filter(([u]) => u === path(key));
const clockReads = () => get.mock.calls.filter(([u]) => u === path("clock")).length;
const breakBtn = () => screen.queryByTestId("portal-break-btn");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  postImpl = () => Promise.resolve({ data: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the shared file is the real producer's", () => {
  it("carries the paths, the PIN header and the steps this test reads", () => {
    expect(C.paths.break_start).toBe("/portal/{token}/clock/break/start");
    expect(C.paths.break_end).toBe("/portal/{token}/clock/break/end");
    expect(C.pin_header).toBe("X-BonBox-Pin");
    for (const n of ["clock_live", "break_start", "clock_on_break", "break_end", "break_end_again",
      "clock_after_break", "misclick_start", "break_end_discarded", "break_start_off", "clock_live_off",
      "clock_on_break_off", "break_end_after_off", "clock_out", "break_start_after_out", "clock_after_out",
      "owner_breaks_off", "owner_breaks_on", "clock_on_forgotten_pause", "owner_clocked_in_on_break",
      "owner_hours_after_out"]) {
      expect(STEP[n], n).toBeTruthy();
    }
  });
});

describe("Start pause / Slut pause on the real answers", () => {
  it("Start pause posts the real path with NO body (server time); the real answer makes it Slut pause", async () => {
    at(12, 0, 20);
    clockImpl = () => reply("clock_live");
    postImpl = (url) => (url === path("break_start") ? reply("break_start") : Promise.resolve({ data: {} }));
    await mount();
    const btn = await screen.findByTestId("portal-break-btn");
    expect(btn.textContent).toBe("Start pause");
    await act(async () => { fireEvent.click(btn); });
    const calls = postsTo("break_start");
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBe(1); // url only: the server stamps the time, nothing else is sent
    await waitFor(() => expect(breakBtn().textContent).toBe("Slut pause"));
    expect(screen.getByTestId("portal-live-chip").textContent).toBe(`På pause siden kl. ${STEP.break_start.body.break_since}`);
    expect(screen.getByTestId("portal-live-ring").textContent).toContain("På pause");
    expect(screen.getByTestId("portal-live-pause").textContent).toBe("Pause30 min · i gang");
  });

  it("Slut pause posts the real path; the real answer (break_ended, 30 min) counts it in the Pause cell", async () => {
    at(12, 30, 5);
    clockImpl = () => reply("clock_on_break");
    postImpl = (url) => (url === path("break_end") ? reply("break_end") : Promise.resolve({ data: {} }));
    await mount();
    const btn = await screen.findByTestId("portal-break-btn");
    expect(btn.textContent).toBe("Slut pause");
    await act(async () => { fireEvent.click(btn); });
    const calls = postsTo("break_end");
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBe(1);
    await waitFor(() => expect(breakBtn().textContent).toBe("Start pause"));
    expect(STEP.break_end.body.break_minutes_so_far).toBe(30);
    expect(screen.getByTestId("portal-live-pause").textContent).toBe("Pause30 min · 30 min holdt");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a pause the server discarded (under a minute: break_discarded) says so — never a silent tap", async () => {
    at(14, 0, 40);
    clockImpl = () => reply("misclick_start");
    postImpl = (url) => (url === path("break_end") ? reply("break_end_discarded") : Promise.resolve({ data: {} }));
    await mount();
    await act(async () => { fireEvent.click(await screen.findByTestId("portal-break-btn")); });
    expect(await screen.findByText("For kort — intet registreret.")).toBeInTheDocument();
    expect(breakBtn().textContent).toBe("Start pause");
  });
});

describe("the real error bodies", () => {
  it("409 not_on_break (another tap or phone ended it first): a quiet re-read, no error", async () => {
    at(12, 31);
    let stale = true;
    clockImpl = () => (stale ? reply("clock_on_break") : reply("clock_after_break"));
    postImpl = (url) => {
      if (url !== path("break_end")) return Promise.resolve({ data: {} });
      stale = false;
      return reply("break_end_again");
    };
    await mount();
    await act(async () => { fireEvent.click(await screen.findByTestId("portal-break-btn")); });
    await waitFor(() => expect(breakBtn().textContent).toBe("Start pause"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Kunne ikke slutte pausen. Prøv igen.")).toBeNull();
  });

  it("403 breaks_off (the owner switched it off meanwhile): says so politely; the re-read takes the button away", async () => {
    at(15, 0, 10);
    let live = true;
    clockImpl = () => (live ? reply("clock_live") : reply("clock_live_off"));
    postImpl = (url) => {
      if (url !== path("break_start")) return Promise.resolve({ data: {} });
      live = false;
      return reply("break_start_off");
    };
    await mount();
    await act(async () => { fireEvent.click(await screen.findByTestId("portal-break-btn")); });
    expect(await screen.findByText("Din leder har slået live-pauser fra.")).toBeInTheDocument();
    await waitFor(() => expect(breakBtn()).toBeNull());
  });

  it("409 not_clocked_in (the punch was closed elsewhere): a quiet re-read leaves the live card", async () => {
    at(17, 1);
    let stale = true;
    clockImpl = () => (stale ? reply("clock_live") : reply("clock_after_out"));
    postImpl = (url) => {
      if (url !== path("break_start")) return Promise.resolve({ data: {} });
      stale = false;
      return reply("break_start_after_out");
    };
    await mount();
    await screen.findByTestId("portal-live-shift");
    const before = clockReads();
    await act(async () => { fireEvent.click(screen.getByTestId("portal-break-btn")); });
    await waitFor(() => expect(clockReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByTestId("portal-live-shift")).toBeNull());
    expect(screen.queryByText("Kunne ikke starte pausen. Prøv igen.")).toBeNull();
  });
});

describe("a pause still running after the owner switched live pauses off", () => {
  it("shows only Slut pause (breaks_live false, on_break true); the real end answer takes the button away", async () => {
    at(16, 10);
    expect(STEP.clock_on_break_off.body.breaks_live).toBe(false);
    clockImpl = () => reply("clock_on_break_off");
    postImpl = (url) => (url === path("break_end") ? reply("break_end_after_off") : Promise.resolve({ data: {} }));
    await mount();
    const btn = await screen.findByTestId("portal-break-btn");
    expect(btn.textContent).toBe("Slut pause");
    expect(screen.queryByText("Start pause")).toBeNull();
    await act(async () => { fireEvent.click(btn); });
    expect(postsTo("break_end")).toHaveLength(1);
    await waitFor(() => expect(breakBtn()).toBeNull());
    expect(screen.queryByText("Start pause")).toBeNull();
  });
});

describe("clock-out with recorded pauses", () => {
  it("reports the server's worked_hours (span minus the recorded pauses)", async () => {
    at(17, 0);
    let out = false;
    clockImpl = () => (out ? reply("clock_after_out") : reply("clock_after_break"));
    postImpl = (url) => {
      if (url !== path("clock_out")) return Promise.resolve({ data: {} });
      out = true;
      return reply("clock_out");
    };
    await mount();
    await act(async () => { fireEvent.click(await screen.findByTestId("portal-clock-out")); });
    expect(postsTo("clock_out")).toHaveLength(1);
    expect(STEP.clock_out.body.break_source).toBe("recorded");
    const hours = String(STEP.clock_out.body.worked_hours).replace(".", ",");
    expect(await screen.findByText(new RegExp(`Registreret · ${hours}`))).toBeInTheDocument();
  });
});

describe("the ring pauses during a pause (canvas review)", () => {
  it("on a pause the big number is the PAUSE's time, the line under it the whole shift, the arc sage", async () => {
    at(12, 7, 30);
    clockImpl = () => reply("clock_on_break");
    await mount();
    const ring = await screen.findByTestId("portal-live-ring");
    expect(STEP.clock_on_break.body.break_elapsed_sec).toBe(430);
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("0:07");
    expect(screen.getByTestId("portal-live-sub").textContent).toMatch(/^3 t 7 min på vagt i alt$/);
    expect(ring.textContent).toContain("På pause");
    const arc = screen.getByTestId("portal-live-arc");
    expect(arc.getAttribute("stroke")).toBe("#A9B8AE");
    expect(arc.getAttribute("data-paused")).toBe("true");
    expect(ring.getAttribute("aria-label")).toContain("På pause i 7 min");
  });

  it("off a pause it is the shift as always: elapsed, time left, brass arc", async () => {
    at(12, 0);
    clockImpl = () => reply("clock_live");
    await mount();
    await screen.findByTestId("portal-live-ring");
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("3:00");
    expect(screen.getByTestId("portal-live-sub").textContent).toBe("5 t tilbage");
    const arc = screen.getByTestId("portal-live-arc");
    expect(arc.getAttribute("stroke")).toBe("#C8A464");
    expect(arc.getAttribute("data-paused")).toBeNull();
  });
});

describe("Stempl ud during a pause asks first", () => {
  it("cancel keeps you clocked in; confirm clocks out (the server ends the pause, uncounted)", async () => {
    at(16, 50);
    let out = false;
    clockImpl = () => (out ? reply("clock_after_out") : reply("clock_on_forgotten_pause"));
    postImpl = (url) => {
      if (url !== path("clock_out")) return Promise.resolve({ data: {} });
      out = true;
      return reply("clock_out");
    };
    await mount();
    await act(async () => { fireEvent.click(await screen.findByTestId("portal-clock-out")); });
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toContain(`Du er på pause siden kl. ${STEP.clock_on_forgotten_pause.body.break_since} — slut pausen og stempl ud?`);
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Annuller" })); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(postsTo("clock_out")).toHaveLength(0);

    await act(async () => { fireEvent.click(screen.getByTestId("portal-clock-out")); });
    const again = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(again).getByRole("button", { name: "Stempl ud" })); });
    await waitFor(() => expect(postsTo("clock_out")).toHaveLength(1));
    // No "Slut pause" first: ending it as the staffer would PAY it as measured.
    expect(postsTo("break_end")).toHaveLength(0);
  });

  it("not on a pause, Stempl ud goes straight through — no question", async () => {
    at(12, 32);
    clockImpl = () => reply("clock_after_break");
    postImpl = (url) => (url === path("clock_out") ? reply("clock_out") : Promise.resolve({ data: {} }));
    await mount();
    await act(async () => { fireEvent.click(await screen.findByTestId("portal-clock-out")); });
    expect(postsTo("clock_out")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the pause is optional (user ask: 'start pause can be optional')", () => {
  const actions = () => [...screen.getByTestId("portal-clock-out").parentElement.children].map((b) => b.dataset.testid);

  it("a planned pause still to take: Start pause leads (brass, first), Stempl ud is the ghost", async () => {
    at(12, 0);
    clockImpl = () => reply("clock_live");
    await mount();
    await screen.findByTestId("portal-break-btn");
    expect(actions()).toEqual(["portal-break-btn", "portal-clock-out"]);
    expect(screen.getByTestId("portal-break-btn").dataset.primary).toBe("true");
    expect(screen.getByTestId("portal-clock-out").dataset.primary).toBeUndefined();
  });

  it("the planned pause is taken: Stempl ud leads; Start pause stays, quietly", async () => {
    at(12, 32);
    clockImpl = () => reply("clock_after_break");
    await mount();
    await screen.findByTestId("portal-break-btn");
    expect(actions()).toEqual(["portal-clock-out", "portal-break-btn"]);
    expect(screen.getByTestId("portal-clock-out").dataset.primary).toBe("true");
    expect(screen.getByTestId("portal-clock-out").style.background).toBe("rgb(200, 164, 100)");
    expect(screen.getByTestId("portal-break-btn").textContent).toBe("Start pause");
    expect(screen.getByTestId("portal-break-btn").dataset.primary).toBeUndefined();
    // The Pause cell is left as it was.
    expect(screen.getByTestId("portal-live-pause").textContent).toBe("Pause30 min · 30 min holdt");
  });

  it("15 minutes or less of the shift left, pause not taken: Stempl ud leads", async () => {
    at(16, 50);
    const near = body("clock_live");
    near.elapsed_sec = 7 * 3600 + 50 * 60; // 16:50 on a 09:00 clock-in
    clockImpl = () => Promise.resolve({ data: near });
    await mount();
    await screen.findByTestId("portal-break-btn");
    expect(actions()).toEqual(["portal-clock-out", "portal-break-btn"]);
    expect(screen.getByTestId("portal-live-pause").textContent).toBe("Pause30 min · mangler");
  });
});

describe("PIN-protected links", () => {
  it("the real portalApi sends the proof under the server's header name on both pause paths", async () => {
    vi.useRealTimers();
    const real = await vi.importActual("../services/portalApi");
    const seen = [];
    const prevAdapter = real.default.defaults.adapter;
    real.default.defaults.adapter = async (config) => {
      seen.push(config);
      return { data: {}, status: 200, statusText: "OK", headers: {}, config };
    };
    try {
      real.storePinProof(TOK, "proof-123");
      await real.default.post(path("break_start"));
      await real.default.post(path("break_end"));
      expect(seen).toHaveLength(2);
      for (const cfg of seen) {
        const h = typeof cfg.headers?.get === "function" ? cfg.headers.get(C.pin_header) : cfg.headers?.[C.pin_header];
        expect(h).toBe("proof-123");
        expect(cfg.data).toBeUndefined();
      }
    } finally {
      real.default.defaults.adapter = prevAdapter;
      localStorage.clear();
    }
  });
});

describe("the owner's switch", () => {
  const Wrap = ({ children }) => <LanguageProvider><MemoryRouter>{children}</MemoryRouter></LanguageProvider>;

  it("sends exactly the body the backend contract was recorded with, and shows the real echo", async () => {
    localStorage.setItem("lang", "da");
    api.get.mockReset();
    api.post.mockReset();
    api.get.mockResolvedValue({ data: body("owner_breaks_off") });
    api.post.mockImplementation(() => Promise.resolve({ data: body("owner_breaks_on") }));
    render(<Wrap><ClockGeofenceSettings /></Wrap>);
    const toggle = await screen.findByTestId("breaks-live-toggle");
    expect(toggle.checked).toBe(false);
    await act(async () => { fireEvent.click(toggle); });
    expect(api.post).toHaveBeenCalledWith(C.paths.owner_clock_settings, STEP.owner_breaks_on.request);
    await waitFor(() => expect(screen.getByTestId("breaks-live-toggle").checked).toBe(true));
  });
});
