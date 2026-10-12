/**
 * The notification sound set Manoj chose on 12 Oct 2026 ("softest").
 *
 * WHY THIS EXISTS. He found the old set "a bit high, irritating": an E5/B5
 * mallet chime, a square-wave 660/880 Hz allergy alarm, an 880 Hz door blip
 * and a 220 Hz square door buzz. He listened to rendered options and picked
 * the softest one. These tests pin what he heard, on every path that makes a
 * sound, so a later "small tweak" cannot quietly bring the harsh set back:
 *
 *   - the WAV recipes sound.js plays through an <audio> element,
 *   - the Web Audio fallback sound.js uses when that element is blocked,
 *   - the door scanner's success / failure notes (DoorScanPage.jsx).
 *
 * The meaning is pinned as well as the pitch: a booking RISES, a cancellation
 * FALLS, and a severe allergy is still three pulses on a different interval,
 * louder than the chime — distinct, but no longer a square wave.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const E4 = 329.63;
const B4 = 493.88;
const DS5 = 622.25;
const WARM = [[1, 1, 1], [2, 0.1, 0.5], [3, 0.03, 0.3]];

/** A fake AudioContext that records every oscillator and its gain schedule. */
function fakeAudioContext(log) {
  return class FakeCtx {
    constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
    resume() {}
    createOscillator() {
      const o = {
        type: "sine", frequency: { value: 0 }, gain: null, startT: null,
        connect(g) { o.gain = g; return g; },
        start(t = 0) { o.startT = t; },
        stop() {},
      };
      log.push(o);
      return o;
    }
    createGain() {
      const events = [];
      const rec = (k) => (v, t, tau) => events.push({ k, v, t, tau });
      return {
        gain: {
          value: 1, events,
          setValueAtTime: rec("set"),
          linearRampToValueAtTime: rec("lin"),
          exponentialRampToValueAtTime: rec("exp"),
          setTargetAtTime: rec("target"),
        },
        connect(d) { return d; },
      };
    }
  };
}

const loudest = (o) => Math.max(...o.gain.gain.events.map((e) => (e.k === "target" ? 0 : e.v)));

afterEach(() => {
  delete window.AudioContext;
  delete window.requestIdleCallback;
  delete window.cancelIdleCallback;
  document.querySelectorAll("audio").forEach((a) => a.remove());
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("alert recipes (WAV path) — the softest set", () => {
  it("booking chime rises E4 → B4; cancel falls B4 → E4 and is quieter", async () => {
    const { ALERT_PARTS } = await import("../utils/sound");
    const [c1, c2] = ALERT_PARTS.chime;
    expect([c1.freq, c2.freq]).toEqual([E4, B4]);
    expect(c2.start).toBeGreaterThan(c1.start);
    const [x1, x2] = ALERT_PARTS.cancel;
    expect([x1.freq, x2.freq]).toEqual([B4, E4]);
    expect(x2.start).toBeGreaterThan(x1.start);
    expect(x1.volume).toBeLessThan(c1.volume);
    expect(x2.volume).toBeLessThan(c2.volume);
    for (const p of [c1, c2, x1, x2]) expect(p.decay).toBe(0.38);
  });

  it("severe allergy = three pulses B4 · D#5 · B4 — a different interval, louder, not square", async () => {
    const { ALERT_PARTS } = await import("../utils/sound");
    const u = ALERT_PARTS.urgent;
    expect(u).toHaveLength(3);
    expect(u.map((p) => p.freq)).toEqual([B4, DS5, B4]);
    expect(u.map((p) => p.start)).toEqual([0, 0.22, 0.44]);
    // A major third, where the chime is a fifth — told apart by ear.
    expect(DS5 / B4).toBeCloseTo(1.26, 2);
    expect(B4 / E4).toBeCloseTo(1.498, 2);
    for (const p of u) {
      expect(p.square).toBeFalsy();
      expect(p.volume).toBeGreaterThan(ALERT_PARTS.chime[0].volume);
    }
  });

  it("every part is a soft WARM mallet note — no square wave anywhere", async () => {
    const { ALERT_PARTS } = await import("../utils/sound");
    const all = [...ALERT_PARTS.chime, ...ALERT_PARTS.cancel, ...ALERT_PARTS.urgent];
    expect(all).toHaveLength(7);
    for (const p of all) {
      expect(p.square).toBeFalsy();
      expect(p.partials).toEqual(WARM);
      expect(p.attack).toBeGreaterThanOrEqual(0.01); // a rise, never a click
      expect(p.volume).toBeLessThanOrEqual(0.26);
    }
  });

  it("the WAV actually built is the soft set: quiet peaks, chime starts at E4", async () => {
    const blobs = [];
    const realCreate = URL.createObjectURL; // jsdom has none; sound.js needs one
    URL.createObjectURL = (blob) => { blobs.push(blob); return "blob:x"; };
    onTestFinished(() => { URL.createObjectURL = realCreate; });
    window.requestIdleCallback = (fn) => { fn(); return 1; };
    window.cancelIdleCallback = () => {};
    const { prepareSoundWhenIdle } = await import("../utils/sound");
    prepareSoundWhenIdle(); // builds chime, cancel, urgent in that order
    expect(blobs).toHaveLength(3);

    const pcm = async (blob) => {
      const buf = typeof blob.arrayBuffer === "function"
        ? await blob.arrayBuffer()
        : await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsArrayBuffer(blob); });
      const v = new DataView(buf);
      const n = (buf.byteLength - 44) / 2;
      return Float32Array.from({ length: n }, (_, i) => v.getInt16(44 + i * 2, true) / 32767);
    };
    const peak = (s) => s.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    const [chime, cancel, urgent] = await Promise.all(blobs.map(pcm));

    // Measured from the renders he chose: chime −11.5 dBFS, cancel −13.6,
    // urgent −9.9. The old square alarm peaked at −4.4 dBFS (0.6).
    expect(peak(chime)).toBeGreaterThan(0.2);
    expect(peak(chime)).toBeLessThan(0.3);
    expect(peak(cancel)).toBeLessThan(peak(chime));
    expect(peak(urgent)).toBeGreaterThan(peak(chime));
    expect(peak(urgent)).toBeLessThan(0.36);

    // Pitch of the first note, by zero crossings over 20–150 ms (before the
    // second note at 160 ms): ≈ E4, not the old E5.
    const a = Math.round(0.02 * 44100), b = Math.round(0.15 * 44100);
    let zc = 0;
    for (let i = a + 1; i < b; i++) if ((chime[i - 1] < 0) !== (chime[i] < 0)) zc++;
    const hz = zc / 2 / (0.13);
    expect(hz).toBeGreaterThan(E4 * 0.95);
    expect(hz).toBeLessThan(E4 * 1.05);
  });
});

describe("Web Audio fallback — same notes, sine only", () => {
  async function fallback(kind) {
    const log = [];
    window.AudioContext = fakeAudioContext(log);
    vi.stubGlobal("Audio", undefined); // no media element → toneFallback
    const { testSound } = await import("../utils/sound");
    await testSound(kind);
    return log;
  }

  it("chime rises E4 → B4 and cancel falls B4 → E4, all sine, soft gains", async () => {
    const chime = await fallback("chime");
    expect(chime.map((o) => o.frequency.value)).toEqual([E4, B4]);
    expect(chime[1].startT).toBeGreaterThan(chime[0].startT);
    vi.resetModules();
    const cancel = await fallback("cancel");
    expect(cancel.map((o) => o.frequency.value)).toEqual([B4, E4]);
    for (const o of [...chime, ...cancel]) {
      expect(o.type).toBe("sine");
      expect(loudest(o)).toBeLessThanOrEqual(0.04);
      // starts from silence: a rise, never a click
      expect(o.gain.gain.events[0]).toMatchObject({ k: "set", v: 0 });
    }
  });

  it("urgent is three sine pulses B4 · D#5 · B4, never square", async () => {
    const urgent = await fallback("urgent");
    expect(urgent.map((o) => o.frequency.value)).toEqual([B4, DS5, B4]);
    for (const o of urgent) {
      expect(o.type).toBe("sine");
      expect(loudest(o)).toBeLessThanOrEqual(0.05);
    }
  });
});

describe("door scanner beeps (DoorScanPage.jsx)", () => {
  // makeAudioFeedback is module-private; run its real source text against a
  // fake AudioContext rather than export it from a component file.
  function doorFeedback(log) {
    const src = readFileSync(resolve(here, "../pages/DoorScanPage.jsx"), "utf8");
    const from = src.indexOf("const DOOR_WARM");
    const fnAt = src.indexOf("function makeAudioFeedback()");
    expect(from).toBeGreaterThan(-1);
    expect(fnAt).toBeGreaterThan(from);
    let depth = 0, end = -1;
    for (let i = src.indexOf("{", fnAt); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    const make = new Function("window", `${src.slice(from, end)}\nreturn makeAudioFeedback;`)(
      { AudioContext: fakeAudioContext(log) },
    );
    const fb = make();
    fb.init();
    return fb;
  }

  it("success is a soft warm 440 Hz note — sine partials, ~0.06, no click", () => {
    const log = [];
    doorFeedback(log).success();
    expect(log.map((o) => o.frequency.value)).toEqual([440, 880, 1320]);
    for (const o of log) {
      expect(o.type).toBe("sine");
      expect(o.gain.gain.events[0]).toMatchObject({ k: "set", v: 0 });
    }
    expect(loudest(log[0])).toBeLessThanOrEqual(0.06);
    expect(loudest(log[0])).toBeGreaterThan(0.05);
    const last = log[0].gain.gain.events.at(-1);
    expect(last).toMatchObject({ k: "lin", v: 0 });
    expect(last.t).toBeCloseTo(0.5, 5);
  });

  it("failure is a low 174.61 Hz SINE (not the old 220 Hz square), 0.25 s, 10 ms rise", () => {
    const log = [];
    doorFeedback(log).failure();
    expect(log).toHaveLength(1);
    const [o] = log;
    expect(o.type).toBe("sine");
    expect(o.frequency.value).toBe(174.61);
    expect(loudest(o)).toBeLessThanOrEqual(0.05);
    const ev = o.gain.gain.events;
    expect(ev[0]).toMatchObject({ k: "set", v: 0 });
    expect(ev[1].k).toBe("lin");
    expect(ev[1].t).toBeCloseTo(0.01, 5);
    expect(ev.at(-1).t).toBeCloseTo(0.25, 5);
  });

  it("the door helper never asks for a square wave", () => {
    const src = readFileSync(resolve(here, "../pages/DoorScanPage.jsx"), "utf8");
    const body = src.slice(src.indexOf("function makeAudioFeedback()"), src.indexOf("// ── JWT payload sniffer"));
    expect(body).not.toMatch(/square/);
  });
});
