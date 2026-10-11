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
 *
 * Second review (after 6bd20b66): "neutral" now needs the SERVER'S stamp as
 * proof — the exact stamp of this device's own "ok" (< 30 s old), or a stamp
 * from the time a lost POST was in flight. A pass-back (own "ok", then the
 * same ticket 45 s later) is the amber alarm. The debounce is per QR (two
 * tickets alternating in frame post once each), one POST per ticket is in
 * flight at a time, a 403 is "no access" only for code read_only (anything
 * else is an expired page), and a 5xx retries while held like a network error.
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
const TICKET_ID_2 = "6f1c2a7e-0000-4000-8000-00000000t002";
const QR_2 = `eyJhbGciOiJIUzI1NiJ9.${b64url({ tid: TICKET_ID_2, eid: EVENT_ID })}.sig`;

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

// Keep the QR in view: one camera read every `stepMs` for `durationMs`.
// Each read is waited for, so every one of them reached the debounce.
async function holdQr(durationMs, stepMs = 500) {
  for (let held = 0; held < durationMs; held += stepMs) {
    clock += stepMs;
    qrQueue.push(QR);
    await waitFor(() => expect(qrQueue.length).toBe(0));
  }
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

  it("same ticket again after this device's 30 s window → amber 'already' warning, NO success chime, count unchanged", async () => {
    api.post
      .mockResolvedValueOnce({ data: okBody })
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    await openScanner();

    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));
    const tonesAfterFirst = tones.length;

    // Minutes later the ticket is back: not the guest re-presenting at the
    // door this device just let them through, so it IS the reuse alarm.
    clock += 2 * 60_000;
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

  it("holding the same QR in view for 10 s posts ONCE (the debounce slides)", async () => {
    api.post.mockResolvedValue({ data: okBody });
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));

    // A fixed 3 s window would re-post at 3 s, 6 s and 9 s.
    await holdQr(10_000);

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(cards()).toHaveLength(1);
    expect(haptic.warning).not.toHaveBeenCalled();
    expect(tones.some(isWarningTone)).toBe(false);
  });

  it("QR out of view for 3 s+ and back → posts again; out for less → still dropped", async () => {
    api.post
      .mockResolvedValueOnce({ data: okBody })
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    await openScanner();
    await scanOnce(1);
    await holdQr(2_000);

    // Away 2 s (no reads), then back: inside the window → dropped.
    clock += 2_000;
    qrQueue.push(QR);
    await waitFor(() => expect(qrQueue.length).toBe(0));
    expect(api.post).toHaveBeenCalledTimes(1);

    // Away 3.1 s, then back → submitted again.
    clock += 3_100;
    qrQueue.push(QR);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  });

  it("this device's own 'ok', then 'already' for the same ticket → neutral card, no warning tone", async () => {
    api.post
      .mockResolvedValueOnce({ data: okBody })
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    await openScanner();

    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));
    const tonesAfterFirst = tones.length;

    await scanOnce(2); // 5 s later, inside the 30 s window, same stamp
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("info"));

    const card = newestCard();
    // The check-in time is on the card (naive UTC 18:48 → 20.48 in Copenhagen).
    expect(card.textContent).toContain("Tjekket ind her kl. 20.48");
    expect(card.textContent).toContain("Sita Sharma");
    expect(card.textContent).not.toContain("Allerede scannet");
    expect(card.className).not.toMatch(/amber/);
    // No tone at all for the repeat — certainly not the warning or the chime.
    expect(tones.slice(tonesAfterFirst)).toHaveLength(0);
    expect(haptic.warning).not.toHaveBeenCalled();
    expect(haptic.error).not.toHaveBeenCalled();
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(haptic.light).toHaveBeenCalledTimes(1);
    // Counted once.
    expect(screen.getByText("1 / 100 scannet · 99 tilbage")).toBeInTheDocument();
  });

  it("network error, then 'already' stamped while that POST was in flight → neutral card (the lost scan went through)", async () => {
    api.post
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    // The lost POST goes out at 18:48:00 UTC; the server stamped 18:48:00.123.
    clock = Date.parse("2026-10-11T18:47:55Z");
    await openScanner();

    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));
    expect(newestCard().textContent).toContain(da.scanNetworkError);
    const tonesAfterError = tones.length;

    // The card says "scan again" and the guest keeps holding the phone up:
    // the retry fires by itself once the 3 s window passes.
    await holdQr(4_000);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("info"));

    const card = newestCard();
    expect(card.textContent).toContain("Tjekket ind her kl. 20.48");
    expect(card.textContent).not.toContain("Allerede scannet");
    expect(tones.slice(tonesAfterError).some(isWarningTone)).toBe(false);
    expect(tones.slice(tonesAfterError)).toHaveLength(0);
    expect(haptic.warning).not.toHaveBeenCalled();
    // The lost "ok" never reached the counter — this guest is counted now.
    expect(screen.getByText("1 / 100 scannet · 99 tilbage")).toBeInTheDocument();
  });

  it("network error, then 'already' more than 60 s later → amber alarm", async () => {
    api.post
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    // The stamp DOES fall inside the lost POST's flight time — only the
    // marker's 60 s lifetime turns this into the alarm.
    clock = Date.parse("2026-10-11T18:47:55Z");
    await openScanner();

    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    clock += 61_000;
    await scanOnce(2);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));
    expect(haptic.warning).toHaveBeenCalledTimes(1);
  });

  it("a ticket someone else let in (no 'ok' on this device) → amber alarm, warning tone", async () => {
    api.post.mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    await openScanner();

    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));

    const card = newestCard();
    expect(card.textContent).toContain("Allerede scannet kl. 20.48");
    expect(card.textContent).toContain("Sita Sharma");
    expect(card.textContent).not.toContain(da.scanCheckedInHere);
    expect(tones.filter(isWarningTone)).toHaveLength(2);
    expect(tones.some(isSuccessTone)).toBe(false);
    expect(haptic.warning).toHaveBeenCalledTimes(1);
    expect(haptic.light).not.toHaveBeenCalled();
    expect(screen.getByText("0 / 100 scannet · 100 tilbage")).toBeInTheDocument();
  });

  it("403 read_only (accountant / team-member login) → 'no access' message, never 'Forkert arrangement'", async () => {
    // The exact body main.py's accountant_write_guard sends.
    api.post.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 403"), {
        isAxiosError: true,
        response: {
          status: 403,
          data: { detail: { code: "read_only", message: "Accountants can view but not modify." } },
        },
      }),
    );
    await openScanner();
    await scanOnce(1);

    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));
    const card = newestCard();
    expect(card.textContent).toContain("Ingen adgang til scanning");
    expect(card.textContent).not.toContain(da.scanWrongEvent);
    expect(card.textContent).not.toContain(da.scanSessionExpired);
    expect(haptic.error).toHaveBeenCalledTimes(1);
  });

  it("any other 403 (CSRF 'Session expired') → 'reload the page', not 'no access'", async () => {
    // The exact body main.py's csrf_protect sends on a token mismatch.
    api.post.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 403"), {
        isAxiosError: true,
        response: {
          status: 403,
          data: {
            detail: "CSRF token mismatched",
            _error: "Session expired — please refresh the page",
            _recoverable: true,
          },
        },
      }),
    );
    await openScanner();
    await scanOnce(1);

    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));
    const card = newestCard();
    expect(card.textContent).toContain("Siden er udløbet — genindlæs siden");
    expect(card.textContent).not.toContain(da.scanNoAccess);
    expect(card.textContent).not.toContain("CSRF");
  });

  it("a QR for another event is still stopped on the device as 'Forkert arrangement'", async () => {
    const otherEventQr = `eyJhbGciOiJIUzI1NiJ9.${b64url({ tid: TICKET_ID, eid: "other-event" })}.sig`;
    await openScanner();
    clock += 5_000;
    qrQueue.push(otherEventQr);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    expect(newestCard().textContent).toContain(da.scanWrongEvent);
    expect(newestCard().textContent).toContain(da.scanWrongEventBody);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("every new door-scan string has a real English and Danish entry", () => {
    for (const key of [
      "scanNotConfirmed",
      "scanNotConfirmedPending",
      "scanNetworkError",
      "scanAlreadyScannedBody",
      "scanAlreadyScannedAt",
      "scanCheckedInHere",
      "scanCheckedInHereAt",
      "scanCheckedInHereBody",
      "scanNoAccess",
      "scanSessionExpired",
    ]) {
      expect(typeof en[key]).toBe("string");
      expect(typeof da[key]).toBe("string");
      expect(en[key]).not.toBe(da[key]);
    }
    expect(en.scanNotConfirmed).toBe("Ticket not confirmed");
    expect(da.scanNotConfirmed).toBe("Billetten er ikke bekræftet");
    expect(da.scanCheckedInHere).toBe("Allerede tjekket ind her");
    expect(en.scanCheckedInHere).toBe("Already checked in on this device");
    expect(da.scanCheckedInHereAt).toBe("Tjekket ind her kl. {time}");
    expect(en.scanCheckedInHereAt).toBe("Checked in on this device at {time}");
    expect(da.scanNoAccess).toBe("Ingen adgang til scanning");
    expect(en.scanNoAccess).toBe("No access to scanning");
    expect(da.scanSessionExpired).toBe("Siden er udløbet — genindlæs siden");
    expect(en.scanSessionExpired).toBe("Page expired — reload the page");
  });
});

// ── Second review (after 6bd20b66) ─────────────────────────────────────
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const httpError = (status, data = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });

describe("DoorScanPage — neutral only with the server's stamp as proof", () => {
  it("pass-back: own 'ok', then the same ticket 45 s later → amber alarm, not 'checked in here'", async () => {
    api.post
      .mockResolvedValueOnce({ data: okBody })
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));
    const tonesAfterFirst = tones.length;

    clock += 40_000;
    await scanOnce(2); // 45 s after the "ok": past the 30 s window
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));
    expect(newestCard().textContent).toContain("Allerede scannet kl. 20.48");
    expect(newestCard().textContent).not.toContain("Tjekket ind her");
    expect(tones.slice(tonesAfterFirst).filter(isWarningTone)).toHaveLength(2);
    expect(haptic.warning).toHaveBeenCalledTimes(1);
    expect(haptic.light).not.toHaveBeenCalled();
    expect(screen.getByText("1 / 100 scannet · 99 tilbage")).toBeInTheDocument();
  });

  it("own 'ok', then 'already' inside 30 s but with a DIFFERENT stamp → amber alarm", async () => {
    api.post
      .mockResolvedValueOnce({ data: okBody })
      // Same ticket, someone else's stamp (one second off is not ours).
      .mockResolvedValueOnce({
        data: { ...okBody, status: "already", scanned_at: "2026-10-11T18:48:01.000000" },
      });
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));

    await scanOnce(2); // 5 s later
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));
    expect(haptic.warning).toHaveBeenCalledTimes(1);
  });

  it("own 'ok' with no stamp → 'already' matched against when that 'ok' arrived (±10 s)", async () => {
    clock = Date.parse("2026-10-11T18:47:55Z");
    api.post
      .mockResolvedValueOnce({ data: { ...okBody, scanned_at: undefined } }) // arrives 18:48:00
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } }) // stamp 18:48:00.123 → ours
      .mockResolvedValueOnce({ data: { ...okBody, status: "already", scanned_at: "2026-10-11T18:47:30" } });
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));

    await scanOnce(2);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("info"));

    // A stamp 30 s before this device's "ok" arrived was not this device.
    await scanOnce(3);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("warning"));
  });

  it("network error, then 'already' stamped just inside the slack after the failure → neutral", async () => {
    clock = Date.parse("2026-10-11T19:00:00Z");
    api.post
      .mockRejectedValueOnce(networkError()) // in flight and failed at 19:00:05
      .mockResolvedValueOnce({ data: { ...okBody, status: "already", scanned_at: "2026-10-11T19:00:13" } });
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    await scanOnce(2);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("info"));
    expect(newestCard().textContent).toContain("Tjekket ind her kl. 21.00");
    expect(screen.getByText("1 / 100 scannet · 99 tilbage")).toBeInTheDocument();
  });
});

describe("DoorScanPage — debounce, in-flight guard and retries", () => {
  it("two tickets alternating in frame: 20 reads over 3 s → exactly 2 POSTs, one per ticket", async () => {
    api.post.mockImplementation((url) =>
      Promise.resolve({
        data: url.includes(TICKET_ID_2)
          ? { ...okBody, ticket_id: TICKET_ID_2, customer_name: "Ram Thapa" }
          : okBody,
      }),
    );
    await openScanner();
    for (let i = 0; i < 20; i += 1) {
      clock += 150;
      qrQueue.push(i % 2 === 0 ? QR : QR_2);
      await waitFor(() => expect(qrQueue.length).toBe(0));
    }

    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenCalledWith(`/tickets/${TICKET_ID}/scan`, { qr: QR });
    expect(api.post).toHaveBeenCalledWith(`/tickets/${TICKET_ID_2}/scan`, { qr: QR_2 });
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards().every((c) => c.dataset.scanKind === "success")).toBe(true);
    expect(haptic.warning).not.toHaveBeenCalled();
  });

  it("while a ticket's POST is pending, another read of it sends nothing; once answered, it can post again", async () => {
    const first = deferred();
    api.post
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: { ...okBody, status: "already" } });
    await openScanner();
    await scanOnce(1);

    // The QR leaves the frame for 5 s (debounce long expired) and comes back
    // while the first answer is still out → no second POST.
    clock += 5_000;
    qrQueue.push(QR);
    await waitFor(() => expect(qrQueue.length).toBe(0));
    clock += 5_000;
    qrQueue.push(QR);
    await waitFor(() => expect(qrQueue.length).toBe(0));
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(cards()).toHaveLength(0);

    first.resolve({ data: okBody });
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));

    // Answer in → the guard is released.
    await scanOnce(2);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("info"));
  });

  it("a 500 while the QR is still held → the retry fires by itself, like a network error", async () => {
    api.post
      .mockRejectedValueOnce(httpError(500, {}))
      .mockResolvedValueOnce({ data: okBody });
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));
    expect(newestCard().textContent).toContain(da.scanGenericError);

    await holdQr(4_000);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("success"));
  });

  it("a 404 while the QR is still held → NOT re-posted (a final answer; no error tone every 3 s)", async () => {
    api.post.mockRejectedValue(httpError(404, { detail: "Ticket not found" }));
    await openScanner();
    await scanOnce(1);
    await waitFor(() => expect(newestCard()?.dataset.scanKind).toBe("error"));

    await holdQr(10_000);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(cards()).toHaveLength(1);
  });
});
