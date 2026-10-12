/**
 * DoorScanPage — adversarial review of 29f03761 ("checked in here" only with
 * the server's stamp as proof). Each test is a sequence in which a ticket
 * that was NOT this device's own check-in — or was, but more than 30 s ago
 * (a pass-back) — still got the neutral card and/or was counted twice. All
 * three FAIL at 29f03761.
 *
 * Resolution: the neutral card and every time window behind it were removed.
 * Every "already" is now the amber "Allerede scannet kl. {time}" alarm and
 * only an "ok" moves the count, so each sequence below must end amber and
 * never count a guest twice. Same real-camera-loop harness as
 * DoorScanPage.lostResponseReuse.test.jsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Copenhagen, so a naive-UTC scanned_at that is read as LOCAL time shows the
// wrong hour (UTC+2 in October) instead of passing by coincidence.
vi.hoisted(() => {
  globalThis.process.env.TZ = "Europe/Copenhagen";
});

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
  haptic: {
    light: vi.fn(),
    medium: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

// jsQR returns whatever the test queues — one read per queued QR text.
const qrQueue = vi.hoisted(() => []);
vi.mock("jsqr", () => ({
  default: vi.fn(() => (qrQueue.length ? { data: qrQueue.shift() } : null)),
}));

import api from "../services/api";
import { haptic } from "../utils/haptics";
import { da } from "../i18n/da.js";
import DoorScanPage from "../pages/DoorScanPage";

// ── Fixtures ─────────────────────────────────────────────────────────
const EVENT_ID = "6f1c2a7e-0000-4000-8000-00000000e001";
const TICKET_ID = "6f1c2a7e-0000-4000-8000-00000000t001";
const BOOKING_ID = "b00c1234-5678-4000-8000-000000000001";
const EVENT = {
  id: EVENT_ID,
  name: "Nepali Movie Night",
  event_date: new Date().toISOString().slice(0, 10), // same rule as the page
  venue: "Bremen Teater",
};

const b64url = (obj) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const QR = `eyJhbGciOiJIUzI1NiJ9.${b64url({ tid: TICKET_ID, eid: EVENT_ID })}.sig`;

const okBody = {
  ticket_id: TICKET_ID,
  booking_id: BOOKING_ID,
  event_id: EVENT_ID,
  tier_label: "Voksen",
  customer_name: "Sita Sharma",
  status: "ok",
  scanned_at: "2026-10-11T18:48:00.123456",
};

// ── Hardware stubs ───────────────────────────────────────────────────
// Every tone the page plays, in order: { freq, type }.
let tones = [];
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
  }
  createOscillator() {
    const osc = {
      type: "sine",
      frequency: { value: 0 },
      connect: (node) => node,
      start: () => tones.push({ freq: osc.frequency.value, type: osc.type }),
      stop: () => {},
    };
    return osc;
  }
  createGain() {
    return {
      gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} },
      connect: () => ({}),
    };
  }
}
const SUCCESS_TONE = { freq: 440, type: "sine" }; // the soft welcome note (12 Oct sound set B)
const isSuccessTone = (tone) => tone.freq === SUCCESS_TONE.freq && tone.type === SUCCESS_TONE.type;

let clock = 1_000_000;
const restore = [];
function stubProp(target, key, descriptor) {
  const prev = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => {
    if (prev) Object.defineProperty(target, key, prev);
    else delete target[key];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  qrQueue.length = 0;
  tones = [];
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);

  api.get.mockImplementation((url) => {
    if (url === "/events") return Promise.resolve({ data: [EVENT] });
    if (String(url).endsWith("/summary")) {
      return Promise.resolve({ data: { scanned_count: 0, capacity_total: 100 } });
    }
    return Promise.resolve({ data: {} });
  });

  stubProp(navigator, "mediaDevices", {
    value: {
      enumerateDevices: () => Promise.resolve([{ kind: "videoinput" }]),
      getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }),
    },
  });
  stubProp(window, "AudioContext", { value: FakeAudioContext, writable: true });
  stubProp(HTMLMediaElement.prototype, "play", { value: () => Promise.resolve(), writable: true });
  stubProp(HTMLMediaElement.prototype, "readyState", { get: () => 4 });
  stubProp(HTMLVideoElement.prototype, "videoWidth", { get: () => 8 });
  stubProp(HTMLVideoElement.prototype, "videoHeight", { get: () => 8 });
  stubProp(HTMLCanvasElement.prototype, "getContext", {
    value: () => ({
      drawImage() {},
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    }),
    writable: true,
  });
});

afterEach(() => {
  while (restore.length) restore.pop()();
  vi.restoreAllMocks();
});

// ── Drivers ──────────────────────────────────────────────────────────
async function openScanner() {
  render(
    <MemoryRouter>
      <DoorScanPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText(EVENT.name));
  fireEvent.click(await screen.findByText(da.scanStart));
  await screen.findByText(da.scanWaitingFirst); // camera live, loop running
}

// Hold the QR up to the camera, past the 3 s same-code debounce.
async function scanOnce(expectedPosts) {
  clock += 5_000;
  qrQueue.push(QR);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(expectedPosts));
}

const networkError = () =>
  Object.assign(new Error("Network Error"), {
    isAxiosError: true,
    code: "ERR_NETWORK",
    request: {},
  });

const isWarningTone = (tone) => tone.freq === 523 && tone.type === "triangle";

const cards = () => Array.from(document.querySelectorAll("[data-scan-kind]"));
const newestCard = () => cards()[0];


const at = (iso) => Date.parse(iso);
// The backend serialises scanned_at as NAIVE UTC (no offset).
const naiveUtc = (ms) => new Date(ms).toISOString().slice(0, -1);
const timeoutError = (ms) =>
  Object.assign(new Error(`timeout of ${ms}ms exceeded`), {
    isAxiosError: true,
    code: "ECONNABORTED",
    request: {},
  });

describe("DoorScanPage — adversarial review of 29f03761", () => {
  it("a POST that hangs until the client timeout, then another scanner's check-in 30 s after it was sent → amber, not counted", async () => {
    // Venue wifi: the request neither lands nor fails fast; axios gives up at
    // the page's scan timeout (~8 s) — the mock honours config.timeout like
    // axios does, capped at the instance's 60 s.
    clock = at("2026-10-11T19:00:00Z");
    let sentClock = null;
    let fireTimeout = null;
    api.post
      .mockImplementationOnce((_url, _body, config) => {
        sentClock = clock;
        const limit = Math.min(config?.timeout ?? 60_000, 60_000);
        return new Promise((_resolve, reject) => {
          fireTimeout = () => {
            clock = sentClock + limit;
            reject(timeoutError(limit));
          };
        });
      })
      // A second scanner at the same entrance let the same (shared) ticket in
      // 30 s after this device's POST went out.
      .mockImplementationOnce(() =>
        Promise.resolve({
          data: { ...okBody, status: "already", scanned_at: naiveUtc(sentClock + 30_000) },
        }),
      );
    await openScanner();
    await scanOnce(1);
    fireTimeout();
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    clock = sentClock + 61_000;
    await scanOnce(2);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));
    expect(newestCard().className).toMatch(/amber/);
    expect(newestCard().textContent).toContain("Allerede scannet kl. 21.00");
    expect(haptic.warning).toHaveBeenCalledTimes(1);
    expect(haptic.light).not.toHaveBeenCalled();
    expect(tones.filter(isWarningTone)).toHaveLength(2);
    expect(tones.some(isSuccessTone)).toBe(false);
    expect(screen.getByText("0 / 100 scannet · 100 tilbage")).toBeInTheDocument();
  });

  it("own 'ok', a re-present whose answer is lost 5 s later, then the ticket again 35 s after the 'ok' → amber, counted ONCE", async () => {
    clock = at("2026-10-11T18:47:55Z");
    api.post
      .mockResolvedValueOnce({ data: okBody }) // 18:48:00, stamp 18:48:00.123
      .mockRejectedValueOnce(networkError()) // 18:48:05 re-present; the "already" is lost
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } }); // same stamp
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));
    expect(screen.getByText("1 / 100 scannet · 99 tilbage")).toBeInTheDocument();

    await scanOnce(2);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    clock += 25_000;
    await scanOnce(3); // 18:48:35 — 35 s after the "ok": a pass-back
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));
    expect(newestCard().className).toMatch(/amber/);
    expect(newestCard().textContent).toContain("Allerede scannet kl. 20.48");
    // One ticket, one check-in: never counted twice.
    expect(screen.getByText("1 / 100 scannet · 99 tilbage")).toBeInTheDocument();
    expect(haptic.warning).toHaveBeenCalledTimes(1);
    expect(haptic.light).not.toHaveBeenCalled();
  });

  it("this device's POST lands but its answer is lost; the same ticket 45 s later (pass-back) → amber, like a pass-back after an 'ok'", async () => {
    clock = at("2026-10-11T18:47:55Z");
    api.post
      .mockRejectedValueOnce(networkError()) // 18:48:00 — landed (stamp 18:48:00.123), answer lost
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    clock += 40_000;
    await scanOnce(2); // 18:48:45
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));
    expect(newestCard().className).toMatch(/amber/);
    expect(newestCard().textContent).toContain("Allerede scannet kl. 20.48");
    expect(tones.filter(isWarningTone)).toHaveLength(2);
    expect(tones.some(isSuccessTone)).toBe(false);
    // No "ok" reached this device, so nothing was counted here.
    expect(screen.getByText("0 / 100 scannet · 100 tilbage")).toBeInTheDocument();
  });
});
