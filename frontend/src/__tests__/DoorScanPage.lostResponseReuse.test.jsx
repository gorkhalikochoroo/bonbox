/**
 * DoorScanPage — what the host SEES, HEARS and FEELS for each scan outcome.
 *
 * The bug (11 Oct): POST /api/tickets/{id}/scan is idempotent and answers a
 * re-scan with HTTP 200 {status:"already", scanned_at}. The page treated
 * every 200 as a welcome, so a reused / shared ticket got "Velkommen", the
 * success chime and the success haptic — and bumped the scanned count. The
 * only "Allerede scannet" branch hung off HTTP 409, which this endpoint
 * sends for booking_not_confirmed — so an unpaid booking was mislabelled
 * as a repeat scan.
 *
 * These tests drive the REAL camera loop (getUserMedia → rAF tick → canvas
 * → jsQR → submitScan) with only the hardware stubbed, and listen to a fake
 * AudioContext so "no success chime" is a measured fact, not a mock call.
 * Strings resolve from the real da dictionary, so every key is proven to
 * exist in Danish, not just in an inline fallback.
 *
 * Follow-up (same day, adversarial review): the same-QR debounce slides (a
 * guest holding the phone up is posted ONCE, not every 3 s), and an
 * "already" for a ticket THIS device just let in — its own "ok", or a POST
 * whose answer was lost — is a neutral "Allerede tjekket ind her", not the
 * reuse alarm. A 403 says "no access", not "wrong event".
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
      gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: () => ({}),
    };
  }
}
const SUCCESS_TONE = { freq: 880, type: "sine" };
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

// ── Review finding (fix-ticket-rescan, after 6bd20b66) ─────────────────
// The "lost response" shortcut turns ANY "already" that follows a network
// error on this device (within 60 s) into the neutral "Allerede tjekket ind
// her" card and counts the guest — without checking that the server's stamp
// could be this device's. A ticket another door let in earlier (or during
// the outage) is a real reuse and must stay the amber alarm. The page has
// the stamp (data.scanned_at) and knows when its own POST was in flight, so
// it can tell. Both tests pass against the pre-round page (559f8c68).
const at = (iso) => Date.parse(iso);

describe("DoorScanPage — a lost response must not hide another door's scan", () => {
  it("network error, then 'already' stamped 12 min BEFORE this device's POST → amber alarm, not counted", async () => {
    clock = at("2026-10-11T19:00:00Z");
    api.post
      .mockRejectedValueOnce(networkError())
      // Another door let this ticket in at 18:48 UTC, long before our POST.
      .mockResolvedValueOnce({ data: { ...okBody, status: "already", scanned_at: "2026-10-11T18:48:00.123456" } });
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    await scanOnce(2);
    await waitFor(() => expect(["info", "warning"]).toContain(newestCard()?.dataset.scanKind));
    expect(newestCard().dataset.scanKind).toBe("warning");
    expect(newestCard().textContent).toContain("Allerede scannet kl. 20.48");
    expect(haptic.warning).toHaveBeenCalledTimes(1);
    // Heard, not just seen: the two-note warning, never the welcome chime.
    expect(tones.filter(isWarningTone)).toHaveLength(2);
    expect(tones.some(isSuccessTone)).toBe(false);
    expect(screen.getByText("0 / 100 scannet · 100 tilbage")).toBeInTheDocument();
  });

  it("network error, then 'already' stamped AFTER the failure (another door during the outage) → amber alarm", async () => {
    clock = at("2026-10-11T19:00:00Z");
    api.post
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ data: { ...okBody, status: "already", scanned_at: "2026-10-11T19:00:30.000000" } });
    await openScanner();
    await scanOnce(1); // POST + failure at ~19:00:05 UTC
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    clock = at("2026-10-11T19:00:45Z");
    await scanOnce(2);
    await waitFor(() => expect(["info", "warning"]).toContain(newestCard()?.dataset.scanKind));
    expect(newestCard().dataset.scanKind).toBe("warning");
    expect(haptic.warning).toHaveBeenCalledTimes(1);
    expect(tones.filter(isWarningTone)).toHaveLength(2);
    expect(screen.getByText("0 / 100 scannet · 100 tilbage")).toBeInTheDocument();
  });
});
