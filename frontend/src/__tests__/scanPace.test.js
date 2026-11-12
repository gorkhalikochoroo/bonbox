/**
 * The door scanner's pace (lib/scanPace.js, phone R1 120 Hz): jsQR reads a
 * camera frame at most every 30 ms by the frame clock, never every Nth frame.
 * It was every 2nd requestAnimationFrame: 30 reads a second at 60 Hz, 60 on a
 * 120 Hz phone. Now about 30 at 60, 90, 120 and 144 Hz — and at 60 Hz exactly
 * the frames the old count read (2, 4, 6 …).
 */
import { describe, expect, it } from "vitest";
import { SCAN_GAP_MS, scanPacer } from "../lib/scanPace";

const RATES = [60, 90, 120, 144];

/** Frame numbers read in one second of a `hz` screen (frame 0 = the first ready frame). */
function readFrames(hz, jitter = () => 0) {
  const p = scanPacer();
  const read = [];
  for (let f = 0; f <= hz; f += 1) if (p.due((f * 1000) / hz + jitter(f))) read.push(f);
  return read;
}

describe("scanPacer", () => {
  it("30 ms by the clock", () => {
    expect(SCAN_GAP_MS).toBe(30);
  });

  it("about 30 reads a second at 60, 90, 120 and 144 Hz (the old every-2nd-frame: 30, 45, 60, 72)", () => {
    const counts = RATES.map((hz) => readFrames(hz).length);
    expect(counts).toEqual([30, 30, 30, 28]);
    const old = RATES.map((hz) => Math.floor(hz / 2));
    expect(old).toEqual([30, 45, 60, 72]);
  });

  it("every gap between two reads is at least 30 ms and under 30 ms + one frame", () => {
    for (const hz of RATES) {
      const t = readFrames(hz).map((f) => (f * 1000) / hz);
      for (let i = 1; i < t.length; i += 1) {
        expect(t[i] - t[i - 1]).toBeGreaterThanOrEqual(SCAN_GAP_MS);
        expect(t[i] - t[i - 1]).toBeLessThan(SCAN_GAP_MS + 1000 / hz);
      }
    }
  });

  it("a 60 Hz phone reads exactly the frames the old count read, also with ±1 ms of frame jitter", () => {
    const even = Array.from({ length: 30 }, (_, i) => 2 * (i + 1));
    expect(readFrames(60)).toEqual(even);
    expect(readFrames(60, (f) => (f % 2 ? 1 : -1))).toEqual(even);
    expect(readFrames(60, (f) => (f % 3 ? -1 : 1))).toEqual(even);
  });

  it("reset() starts the clock again; a clock that went back never stalls the reads", () => {
    const p = scanPacer();
    expect(p.due(0)).toBe(false);
    expect(p.due(40)).toBe(true);
    p.reset();
    expect(p.due(50)).toBe(false);
    expect(p.due(80)).toBe(true);
    expect(p.due(10)).toBe(false);    // went back: the clock starts there
    expect(p.due(40)).toBe(true);
  });
});
