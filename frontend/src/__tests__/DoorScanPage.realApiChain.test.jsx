/**
 * DoorScanPage — review of 541436ca through the REAL services/api.js chain.
 *
 * Every other door-scan test mocks services/api, so the retry interceptor in
 * api.js never runs and the "8 s per scan" promise is only checked against a
 * mock. Here the page talks to the real axios instance; only the transport
 * (the adapter) is replaced.
 *
 *  1. PASSES — the 8 s timeout reaches the transport on the scan POST only,
 *     and a timeout is not replayed by api.js (no double-submit).
 *  2. FAILS at 541436ca — a 503 on the scan POST is replayed by api.js 4
 *     times (2 + 4 + 8 + 12 s back-off). For ~26 s the host gets NO card, no
 *     tone, and every re-scan of that ticket is silently dropped by the
 *     in-flight guard, although the page documents the guard as holding "at
 *     most SCAN_POST_TIMEOUT_MS". Expected: a card within the 8 s budget.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AxiosError } from "axios";

vi.hoisted(() => {
  globalThis.process.env.TZ = "Europe/Copenhagen";
});

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
const qrQueue = vi.hoisted(() => []);
vi.mock("jsqr", () => ({
  default: vi.fn(() => (qrQueue.length ? { data: qrQueue.shift() } : null)),
}));

import api from "../services/api";
import { da } from "../i18n/da.js";
import DoorScanPage from "../pages/DoorScanPage";

const EVENT_ID = "6f1c2a7e-0000-4000-8000-00000000e001";
const TICKET_ID = "6f1c2a7e-0000-4000-8000-00000000t001";
const EVENT = {
  id: EVENT_ID,
  name: "Nepali Movie Night",
  event_date: new Date().toISOString().slice(0, 10),
  venue: "Bremen Teater",
};
const b64url = (obj) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const QR = `eyJhbGciOiJIUzI1NiJ9.${b64url({ tid: TICKET_ID, eid: EVENT_ID })}.sig`;

// ── Transport stub: every request the real api.js sends lands here ──────
let scanCalls = [];
let scanHandler = null;
const ok = (config, data) => ({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
function adapter(config) {
  const url = String(config.url || "");
  if ((config.method || "get").toLowerCase() === "get") {
    if (url === "/events") return Promise.resolve(ok(config, [EVENT]));
    if (url.endsWith("/summary")) {
      return Promise.resolve(ok(config, { scanned_count: 0, capacity_total: 100 }));
    }
    return Promise.resolve(ok(config, {}));
  }
  if (url.endsWith("/scan")) {
    scanCalls.push({ timeout: config.timeout, retry: config._retryCount || 0 });
    return scanHandler(config);
  }
  return Promise.resolve(ok(config, {}));
}

class FakeAudioContext {
  constructor() { this.currentTime = 0; this.destination = {}; }
  createOscillator() {
    return { type: "sine", frequency: { value: 0 }, connect: (n) => n, start() {}, stop() {} };
  }
  createGain() {
    return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({}) };
  }
}

let clock = 1_000_000;
const restore = [];
let prevAdapter;
function stubProp(target, key, descriptor) {
  const prev = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => {
    if (prev) Object.defineProperty(target, key, prev);
    else delete target[key];
  });
}

beforeEach(() => {
  qrQueue.length = 0;
  scanCalls = [];
  scanHandler = null;
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  prevAdapter = api.defaults.adapter;
  api.defaults.adapter = adapter;
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
  api.defaults.adapter = prevAdapter;
  while (restore.length) restore.pop()();
  vi.restoreAllMocks();
});

async function openScanner() {
  render(
    <MemoryRouter>
      <DoorScanPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText(EVENT.name));
  fireEvent.click(await screen.findByText(da.scanStart));
  await screen.findByText(da.scanWaitingFirst);
}
const cards = () => Array.from(document.querySelectorAll("[data-scan-kind]"));

describe("DoorScanPage scan POST through the real api.js interceptors", () => {
  it("the 8 s timeout reaches the transport, and a timed-out POST is NOT replayed", async () => {
    scanHandler = (config) =>
      Promise.reject(new AxiosError(`timeout of ${config.timeout}ms exceeded`, "ECONNABORTED", config, {}));
    await openScanner();
    clock += 5_000;
    qrQueue.push(QR);
    await waitFor(() => expect(cards()[0]?.dataset.scanKind).toBe("error"));
    expect(cards()[0].textContent).toContain(da.scanNetworkError);
    expect(scanCalls).toEqual([{ timeout: 8000, retry: 0 }]);
    // Give api.js a chance to (wrongly) replay it.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(scanCalls).toHaveLength(1);
  }, 15_000);

  it("a 503 on the scan POST shows a card within the ~8 s scan budget (not after api.js's ~26 s of silent retries)", async () => {
    scanHandler = (config) =>
      Promise.reject(
        new AxiosError("Service Unavailable", "ERR_BAD_RESPONSE", config, {}, {
          status: 503, statusText: "Service Unavailable", data: {}, headers: {}, config,
        }),
      );
    await openScanner();
    clock += 5_000;
    qrQueue.push(QR);
    await waitFor(() => expect(scanCalls.length).toBeGreaterThanOrEqual(1));
    // The page promises the ticket is answered (or released) within
    // SCAN_POST_TIMEOUT_MS. Allow a little slack beyond 8 s.
    await waitFor(() => expect(cards().length).toBeGreaterThan(0), { timeout: 9_000 });
    expect(cards()[0].dataset.scanKind).toBe("error");
  }, 20_000);
});
