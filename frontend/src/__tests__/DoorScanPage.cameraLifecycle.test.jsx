/**
 * DoorScanPage — the camera itself: does the preview get the stream, and does
 * the camera go OFF whenever the host leaves the scanner, even while it is
 * still starting?
 *
 * The bug (found 21 Oct while checking old PR #234): the <video> preview only
 * exists while `scanning` is true, but startScanner attached the stream
 * before that — to a video element that was not there yet. The preview stayed
 * black, readyState never reached HAVE_ENOUGH_DATA and the jsQR loop returned
 * on every frame: no ticket and no gavekort could be scanned, with no error.
 * The other DoorScan tests stayed green because they stub readyState to 4 on
 * every <video>, attached or not.
 *
 * And getUserMedia can wait seconds on the permission prompt while "Tilbage",
 * "Skift arrangement" and "Start scanner" are all still tappable. A start
 * that finished after the host had moved on kept the camera on, or opened a
 * ticket scanner with NO event chosen (it would check in tickets for any of
 * the owner's events).
 *
 * So here, unlike the other DoorScan files:
 *  - readyState is NOT stubbed to 4. A <video> reports HAVE_ENOUGH_DATA (4)
 *    only while a live camera stream is attached as its srcObject, like a
 *    browser; otherwise HAVE_NOTHING (0).
 *  - getUserMedia does not answer by itself. Each call waits until the test
 *    answers it, so a slow camera start / a pending permission prompt is
 *    modelled exactly.
 *  - every stream's track records whether it was stopped, so "camera off" is
 *    a fact the test reads, not a mock call.
 * Strings resolve from the real da dictionary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

vi.mock("../hooks/useLanguage", async () => {
  const { da } = await import("../i18n/da.js");
  const t = (key, fallbackOrVars, maybeVars) => {
    const vars =
      maybeVars ||
      (fallbackOrVars && typeof fallbackOrVars === "object" ? fallbackOrVars : null);
    let s = da[key];
    if (s === undefined) s = `MISSING_DA:${key}`;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
  return { useLanguage: () => ({ t, lang: "da", setLang: () => {}, LANGUAGES: [] }) };
});

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 7, business_type: "event_organizer" } }),
}));

vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({ usageKnownDormant: new Set() }),
}));

vi.mock("../utils/haptics", () => ({
  haptic: { light: vi.fn(), medium: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// jsQR returns whatever the test queues — one read per queued QR text. It is
// only ever called once a frame is readable (readyState 4), i.e. once a live
// stream is really attached to the preview.
const qrQueue = vi.hoisted(() => []);
vi.mock("jsqr", () => ({
  default: vi.fn(() => (qrQueue.length ? { data: qrQueue.shift() } : null)),
}));

import api from "../services/api";
import { da } from "../i18n/da.js";
import DoorScanPage from "../pages/DoorScanPage";

// ── Fixtures ─────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10); // same rule as the page
const EVENT_A = { id: "aaaaaaaa-0000-4000-8000-00000000000a", name: "Fredagsbar A", event_date: today, venue: "Salen" };
const EVENT_B = { id: "bbbbbbbb-0000-4000-8000-00000000000b", name: "Lørdagsfest B", event_date: today, venue: "Salen" };
const TICKET_A = "aaaaaaaa-0000-4000-8000-0000000000f1";
const TICKET_B = "bbbbbbbb-0000-4000-8000-0000000000f1";
const b64url = (o) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const QR_A = `eyJhbGciOiJIUzI1NiJ9.${b64url({ tid: TICKET_A, eid: EVENT_A.id })}.sig`;
const QR_B = `eyJhbGciOiJIUzI1NiJ9.${b64url({ tid: TICKET_B, eid: EVENT_B.id })}.sig`;
const QR_GK = "BB1.G.test-gavekort-token";

// ── Camera model ─────────────────────────────────────────────────────
let streams = []; // every stream the camera handed out, in order
let gum = []; // getUserMedia calls still waiting for an answer: { resolve, reject }
let rafCalls = 0;
function makeStream(label) {
  const track = { readyState: "live", stop() { this.readyState = "ended"; } };
  const stream = { label, track, getTracks: () => [track] };
  streams.push(stream);
  return stream;
}
const liveStreams = () => streams.filter((s) => s.track.readyState === "live").map((s) => s.label);
const attached = new WeakMap(); // <video> → the stream set as its srcObject

const restore = [];
function stubProp(target, key, descriptor) {
  const prev = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => {
    if (prev) Object.defineProperty(target, key, prev);
    else delete target[key];
  });
}

class FakeAudioContext {
  constructor() { this.currentTime = 0; this.destination = {}; }
  createOscillator() {
    return { type: "sine", frequency: { value: 0, setValueAtTime() {} }, connect: (n) => n, start() {}, stop() {} };
  }
  createGain() {
    return {
      gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} },
      connect: () => ({}),
    };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  qrQueue.length = 0;
  streams = [];
  gum = [];
  rafCalls = 0;

  api.get.mockImplementation((url) => {
    if (url === "/events") return Promise.resolve({ data: [EVENT_A, EVENT_B] });
    if (String(url).endsWith("/summary")) return Promise.resolve({ data: { scanned_count: 0, capacity_total: 100 } });
    return Promise.resolve({ data: {} });
  });
  api.post.mockImplementation((url) => {
    if (url === "/gavekort/scan-resolve") {
      return Promise.resolve({ data: { id: "g1", code: "GK-1", balance_minor: 25000, status: "active" } });
    }
    const tid = String(url).split("/")[2];
    return Promise.resolve({
      data: { ticket_id: tid, booking_id: "c0000000-0000-4000-8000-000000000001", tier_label: "Voksen",
        customer_name: "Sita Sharma", status: "ok", scanned_at: "2026-10-21T18:00:00" },
    });
  });

  stubProp(navigator, "mediaDevices", {
    value: {
      enumerateDevices: () => Promise.resolve([{ kind: "videoinput" }]),
      // A slow camera: nothing happens until the test answers this call.
      getUserMedia: () => new Promise((resolve, reject) => gum.push({ resolve, reject })),
    },
  });
  stubProp(window, "AudioContext", { value: FakeAudioContext, writable: true });
  stubProp(HTMLMediaElement.prototype, "srcObject", {
    get() { return attached.get(this) ?? null; },
    set(v) { if (v) attached.set(this, v); else attached.delete(this); },
  });
  stubProp(HTMLMediaElement.prototype, "play", { value: () => Promise.resolve(), writable: true });
  // Browser-like: frames exist only while a LIVE stream is attached.
  stubProp(HTMLMediaElement.prototype, "readyState", {
    get() {
      const s = attached.get(this);
      return s && s.track.readyState === "live" ? 4 : 0;
    },
  });
  stubProp(HTMLVideoElement.prototype, "videoWidth", { get: () => 8 });
  stubProp(HTMLVideoElement.prototype, "videoHeight", { get: () => 8 });
  stubProp(HTMLCanvasElement.prototype, "getContext", {
    value: () => ({
      drawImage() {},
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    }),
    writable: true,
  });
  const realRaf = globalThis.requestAnimationFrame.bind(globalThis);
  stubProp(globalThis, "requestAnimationFrame", {
    value: (cb) => { rafCalls += 1; return realRaf(cb); },
    writable: true,
  });
});

afterEach(() => {
  while (restore.length) restore.pop()();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

// ── Drivers ──────────────────────────────────────────────────────────
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
const videoEl = () => document.querySelector("video");
const postUrls = () => api.post.mock.calls.map((c) => c[0]);

function mount() {
  return render(
    <MemoryRouter>
      <DoorScanPage />
    </MemoryRouter>,
  );
}

// The camera answers call #i (0-based) with a new live stream.
async function cameraAnswers(i, label) {
  const stream = makeStream(label);
  await act(async () => { gum[i].resolve(stream); });
  return stream;
}

// Hold a QR in front of the camera for a while. Reads happen only if a live
// stream is attached (readyState 4) and a scan loop is running.
async function holdQr(qr, ms = 500) {
  qrQueue.push(qr);
  await sleep(ms);
}

describe("DoorScanPage camera — a slow camera start, readyState only once really attached", () => {
  it("gavekort link (/scan?mode=gavekort) → Start → camera answers late → preview gets the stream and a gavekort QR is read", async () => {
    window.history.replaceState({}, "", "/scan?mode=gavekort");
    mount();
    fireEvent.click(await screen.findByText(da.scanStart));
    expect(gum).toHaveLength(1);
    expect(videoEl()).toBeNull(); // nothing to show until the camera answers

    const stream = await cameraAnswers(0, "gavekort");
    await screen.findByText(da.scanGavekortWaiting);
    expect(videoEl().srcObject).toBe(stream);
    expect(videoEl().readyState).toBe(4);

    qrQueue.push(QR_GK);
    await waitFor(() => expect(postUrls()).toEqual(["/gavekort/scan-resolve"]), { timeout: 1500 });
    expect(api.post.mock.calls[0][1]).toEqual({ token: QR_GK });
    expect(await screen.findByRole("dialog")).toBeTruthy(); // the redeem sheet is up
  });

  it("gavekort tile on the landing → camera answers late → a gavekort QR is read", async () => {
    mount();
    fireEvent.click(await screen.findByText(da.gkScanEyebrow)); // "Indløs gavekort" tile
    const stream = await cameraAnswers(0, "gavekort-tile");
    await screen.findByText(da.scanGavekortWaiting);
    expect(videoEl().srcObject).toBe(stream);

    qrQueue.push(QR_GK);
    await waitFor(() => expect(postUrls()).toEqual(["/gavekort/scan-resolve"]), { timeout: 1500 });
  });

  it("ticket: pick an event → Start → camera answers late → preview gets the stream and the ticket is checked in", async () => {
    mount();
    fireEvent.click(await screen.findByText(EVENT_A.name));
    fireEvent.click(await screen.findByText(da.scanStart));
    const stream = await cameraAnswers(0, "ticket");
    await screen.findByText(da.scanWaitingFirst);
    expect(videoEl().srcObject).toBe(stream);

    qrQueue.push(QR_A);
    await waitFor(() => expect(postUrls()).toEqual([`/tickets/${TICKET_A}/scan`]), { timeout: 1500 });
  });

  it.each([
    ["the gavekort link", () => { window.history.replaceState({}, "", "/scan?mode=gavekort"); }, async () => {
      fireEvent.click(await screen.findByText(da.scanStart));
    }],
    ["the gavekort tile", () => {}, async () => {
      fireEvent.click(await screen.findByText(da.gkScanEyebrow));
    }],
  ])("'Tilbage' while the camera is starting (from %s) → no scanner, camera off, a ticket QR is not checked in", async (_label, before, start) => {
    before();
    mount();
    await start();
    expect(gum).toHaveLength(1);
    fireEvent.click(await screen.findByText(da.scanBack));

    await cameraAnswers(0, "late-after-tilbage");
    await sleep(100);
    await holdQr(QR_B);

    expect(liveStreams()).toEqual([]); // camera light off
    expect(videoEl()).toBeNull(); // no scanner open
    expect(screen.queryByText(da.scanWaitingFirst)).toBeNull(); // no ticket scanner without an event
    expect(postUrls()).toEqual([]); // nothing checked in
  });

  it("'Skift arrangement' while the camera is starting → pick another event → no scanner the host never started, camera off", async () => {
    mount();
    fireEvent.click(await screen.findByText(EVENT_A.name));
    fireEvent.click(await screen.findByText(da.scanStart));
    fireEvent.click(await screen.findByText(da.scanChangeEvent));
    fireEvent.click(await screen.findByText(EVENT_B.name));

    await cameraAnswers(0, "late-after-skift");
    await sleep(100);
    await holdQr(QR_B);

    expect(liveStreams()).toEqual([]);
    expect(videoEl()).toBeNull();
    expect(screen.getByText(da.scanStart)).toBeTruthy(); // still the idle Start screen for B
    expect(postUrls()).toEqual([]);
  });

  it("leaving the page while the camera is starting → the camera that answers afterwards is switched off", async () => {
    const { unmount } = mount();
    fireEvent.click(await screen.findByText(EVENT_A.name));
    fireEvent.click(await screen.findByText(da.scanStart));
    unmount();

    await cameraAnswers(0, "late-after-leave");
    await sleep(50);
    expect(liveStreams()).toEqual([]);
    // …and no orphan frame loop was started for a page that is gone.
    const afterAnswer = rafCalls;
    await sleep(200);
    expect(rafCalls - afterAnswer).toBe(0);
  });

  it.each([["first call answers first", [0, 1]], ["second call answers first", [1, 0]]])(
    "double-tap Start (%s), then Stop → camera off and no scan loop left running",
    async (_label, order) => {
      const { unmount } = mount();
      fireEvent.click(await screen.findByText(EVENT_A.name));
      const startBtn = await screen.findByText(da.scanStart);
      fireEvent.click(startBtn);
      fireEvent.click(startBtn);
      expect(gum).toHaveLength(2);

      for (const i of order) await cameraAnswers(i, `start#${i + 1}`);
      await screen.findByText(da.scanWaitingFirst);
      // One camera on, the one in the preview — the other start was dropped.
      expect(liveStreams()).toHaveLength(1);
      expect(videoEl().srcObject?.track.readyState).toBe("live");

      // The scanner works on the camera that survived. (This read can't tell
      // one frame loop from two: jsQR answers once and the debounce would
      // hide a repeat. The rAF count after Stop below is what catches a
      // second loop; it assumes nothing else on this page uses rAF.)
      qrQueue.push(QR_A);
      await waitFor(() => expect(postUrls()).toEqual([`/tickets/${TICKET_A}/scan`]), { timeout: 1500 });

      fireEvent.click(screen.getAllByText(da.scanStop)[0]);
      await sleep(50);
      expect(liveStreams()).toEqual([]);
      expect(videoEl()).toBeNull();

      const afterStop = rafCalls;
      await sleep(300);
      expect(rafCalls - afterStop).toBe(0); // no frame loop still running

      unmount();
      const afterLeave = rafCalls;
      await sleep(200);
      expect(rafCalls - afterLeave).toBe(0);
      expect(liveStreams()).toEqual([]);
    },
  );

  // A cancelled start that FAILS late must stay silent too. Otherwise its
  // error lands on the next idle screen: "camera access denied" after the
  // host tapped Tilbage, or "camera busy" after a scan that worked.
  const cameraFails = (i, name) =>
    act(async () => { gum[i].reject(Object.assign(new Error(name), { name })); });

  it("'Tilbage' while the camera is starting, then the permission is refused late → no stale 'access denied' banner on the next screen", async () => {
    mount();
    fireEvent.click(await screen.findByText(da.gkScanEyebrow));
    fireEvent.click(await screen.findByText(da.scanBack));
    await cameraFails(0, "NotAllowedError");
    await sleep(50);

    fireEvent.click(await screen.findByText(EVENT_A.name));
    await screen.findByText(da.scanStart);
    expect(screen.queryByText(da.scanCameraDeniedTitle)).toBeNull();
    expect(screen.queryByText(da.scanCameraErrorTitle)).toBeNull();
  });

  it("double-tap Start: the second start answers, the dropped one fails late → after Stop no stale 'camera busy' banner", async () => {
    mount();
    fireEvent.click(await screen.findByText(EVENT_A.name));
    const startBtn = await screen.findByText(da.scanStart);
    fireEvent.click(startBtn);
    fireEvent.click(startBtn);
    await cameraAnswers(1, "current");
    await cameraFails(0, "NotReadableError");
    await screen.findByText(da.scanWaitingFirst);

    fireEvent.click(screen.getAllByText(da.scanStop)[0]);
    await sleep(50);
    await screen.findByText(da.scanStart); // back on the idle screen for event A
    expect(screen.queryByText(da.scanCameraErrorTitle)).toBeNull();
    expect(liveStreams()).toEqual([]);
  });
});
