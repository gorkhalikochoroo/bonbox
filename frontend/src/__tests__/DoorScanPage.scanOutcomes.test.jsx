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
import { en } from "../i18n/en.js";
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

const cards = () => Array.from(document.querySelectorAll("[data-scan-kind]"));
const newestCard = () => cards()[0];

// ── Tests ────────────────────────────────────────────────────────────
describe("DoorScanPage — ticket scan outcomes", () => {
  it("first valid scan → welcome card, success chime, success haptic, count +1", async () => {
    api.post.mockResolvedValueOnce({ data: okBody });
    await openScanner();
    await scanOnce(1);

    expect(api.post).toHaveBeenCalledWith(`/tickets/${TICKET_ID}/scan`, { qr: QR });
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));
    expect(newestCard().textContent).toContain("Sita Sharma");
    expect(tones.some(isSuccessTone)).toBe(true);
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(haptic.warning).not.toHaveBeenCalled();
    expect(screen.getByText("1 / 100 scannet · 99 tilbage")).toBeInTheDocument();
  });

  it("second scan of the same ticket → amber 'already' warning, NO success chime, count unchanged", async () => {
    api.post
      .mockResolvedValueOnce({ data: okBody })
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    await openScanner();

    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));
    const tonesAfterFirst = tones.length;

    await scanOnce(2);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));

    // scanned_at is naive UTC 18:48 → 20.48 on a Copenhagen phone in October.
    const local = new Date(Date.UTC(2026, 9, 11, 18, 48)).toLocaleTimeString("da-DK", {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(local).toBe("20.48"); // the TZ really is non-UTC, so this test can fail
    const card = newestCard();
    expect(card.textContent).toContain("Allerede scannet kl. 20.48");
    expect(card.textContent).not.toContain("18.48");
    expect(card.textContent).toContain("Sita Sharma"); // who to look for at the door
    expect(card.textContent).not.toContain(da.scanSuccess);

    // Sound: no success chime for the re-scan — its own two-note warning.
    const rescanTones = tones.slice(tonesAfterFirst);
    expect(rescanTones.length).toBeGreaterThan(0);
    expect(rescanTones.some(isSuccessTone)).toBe(false);
    expect(rescanTones.length).toBe(2);

    // Haptic: one success (the first scan) and one warning — nothing else.
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(haptic.warning).toHaveBeenCalledTimes(1);
    expect(haptic.error).not.toHaveBeenCalled();

    // The guest was counted once.
    expect(screen.getByText("1 / 100 scannet · 99 tilbage")).toBeInTheDocument();
  });

  it("booking not confirmed (409) → its own message, never 'Allerede scannet'", async () => {
    api.post.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 409"), {
        isAxiosError: true,
        response: {
          status: 409,
          data: {
            detail: {
              error: "booking_not_confirmed",
              message: "Bookingen er ikke bekræftet. Markér betalingen først.",
              current_status: "pending",
            },
          },
        },
      }),
    );
    await openScanner();
    await scanOnce(1);

    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));
    const card = newestCard();
    expect(card.textContent).toContain("Billetten er ikke bekræftet");
    expect(card.textContent).toContain("Betalingen er ikke registreret endnu");
    expect(card.textContent).not.toContain("Allerede scannet");
    expect(tones.some(isSuccessTone)).toBe(false);
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(haptic.warning).not.toHaveBeenCalled();
    expect(screen.getByText("0 / 100 scannet · 100 tilbage")).toBeInTheDocument();
  });

  it("network error → 'scan again' message; the retry then lands as a normal first scan", async () => {
    api.post
      .mockRejectedValueOnce(
        Object.assign(new Error("Network Error"), {
          isAxiosError: true,
          code: "ERR_NETWORK",
          request: {},
        }),
      )
      .mockResolvedValueOnce({ data: okBody });
    await openScanner();

    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));
    expect(newestCard().textContent).toContain("Ingen forbindelse — scan billetten igen");
    expect(newestCard().textContent).not.toContain("HTTP");
    expect(tones.some(isSuccessTone)).toBe(false);
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();

    await scanOnce(2);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));
    expect(haptic.success).toHaveBeenCalledTimes(1);
  });

  it("a 200 with a status the page doesn't know is never a welcome (fails closed)", async () => {
    api.post.mockResolvedValueOnce({ data: { ...okBody, status: undefined } });
    await openScanner();
    await scanOnce(1);

    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));
    expect(newestCard().textContent).toContain(da.scanGenericError);
    expect(tones.some(isSuccessTone)).toBe(false);
    expect(haptic.success).not.toHaveBeenCalled();
    expect(screen.getByText("0 / 100 scannet · 100 tilbage")).toBeInTheDocument();
  });

  it("every new door-scan string has a real English and Danish entry", () => {
    for (const key of [
      "scanNotConfirmed",
      "scanNotConfirmedPending",
      "scanNetworkError",
      "scanAlreadyScannedBody",
      "scanAlreadyScannedAt",
    ]) {
      expect(typeof en[key]).toBe("string");
      expect(typeof da[key]).toBe("string");
      expect(en[key]).not.toBe(da[key]);
    }
    expect(en.scanNotConfirmed).toBe("Ticket not confirmed");
    expect(da.scanNotConfirmed).toBe("Billetten er ikke bekræftet");
  });
});
