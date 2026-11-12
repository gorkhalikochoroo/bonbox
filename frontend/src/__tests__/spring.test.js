/**
 * The throw-matched settle (premium feel P4, components/staff/spring.js):
 * keyframes from a small spring simulation (the kit's --spring-soft, k 365,
 * ζ .72), played by WAAPI. It lands exactly, overshoots about 3.8 %, never
 * runs longer than 1.2 s, and a release that is still moving keeps going
 * before it turns.
 */
import { describe, expect, it } from "vitest";
import { KEY_HZ, springKeyframes, STEP_S, SUBSTEPS } from "../components/staff/spring";

const ys = (r) => r.keyframes.map((k) => Number(k.transform.match(/^translateY\((-?[\d.e+-]+)px\)$/)[1]));

describe("springKeyframes", () => {
  it("from 100 to 0 at rest ends exactly at 0, offsets run 0 → 1", () => {
    const r = springKeyframes(100, 0);
    expect(r.keyframes[0]).toEqual({ transform: "translateY(100px)", offset: 0 });
    expect(r.keyframes.at(-1)).toEqual({ transform: "translateY(0px)", offset: 1 });
    const offs = r.keyframes.map((k) => k.offset);
    expect(offs).toEqual([...offs].sort((a, b) => a - b));
  });

  it("the lowest point is between −4.5 and −3 px (≈3.8 % overshoot, --spring-soft's)", () => {
    const low = Math.min(...ys(springKeyframes(100, 0)));
    expect(low).toBeGreaterThan(-4.5);
    expect(low).toBeLessThan(-3);
  });

  it("lasts 1200 ms or less, also from far away and thrown hard", () => {
    expect(springKeyframes(100, 0).duration).toBeLessThanOrEqual(1200);
    expect(springKeyframes(900, 0, 5).duration).toBeLessThanOrEqual(1200);
    expect(springKeyframes(-64, 0, -3).duration).toBeLessThanOrEqual(1200);
  });

  it("with v0 = 1 px/ms (toward larger values) the first frames move further before turning", () => {
    const still = ys(springKeyframes(100, 0, 0));
    const moving = ys(springKeyframes(100, 0, 1));
    expect(still[1]).toBeLessThan(100);
    expect(moving[1]).toBeGreaterThan(100);
    expect(Math.max(...moving)).toBeGreaterThan(100);
    expect(moving.at(-1)).toBe(0);
  });

  it("settles on `to`, not on 0, and maps through the given function", () => {
    const r = springKeyframes(40, 10, 0, { map: (y) => `translateX(${y}px)` });
    expect(r.keyframes[0].transform).toBe("translateX(40px)");
    expect(r.keyframes.at(-1).transform).toBe("translateX(10px)");
  });

  it("integrates in 1/480 s steps, eight per 60 Hz frame as before (a whole-frame step damped the overshoot to 1 %)", () => {
    // Phone R1 (120 Hz): a keyframe every 1/240 s, two steps each; the step itself is unchanged.
    expect(STEP_S).toBe(1 / 480);
    expect(KEY_HZ).toBe(240);
    expect(SUBSTEPS).toBe(2);
    expect(SUBSTEPS * STEP_S * KEY_HZ).toBeCloseTo(1, 12);
    expect((1 / 60) / STEP_S).toBeCloseTo(8, 12);
  });
});

/**
 * Phone R1, 120 Hz: the settle is timed in ms, never in frames. WAAPI plays
 * the keyframes over `duration` ms on the compositor's clock and draws, on
 * each frame of the screen, the straight line between the two keyframes
 * around that moment. So the outcome is the same at every refresh rate only
 * if the keyframes are close enough together for that line to stay on the
 * spring. Here each frame of a 60, 90, 120 and 144 Hz screen is checked
 * against the spring itself (the same physics, read at every 1/480 s step).
 */
describe("springKeyframes at 60, 90, 120 and 144 Hz", () => {
  const RATES = [60, 90, 120, 144];
  // Realistic releases: from rest, a slow pull let go, a push past the top, a short flick that sprang back.
  const RELEASES = [[100, 0, 0], [240, 0, 0.5], [80, 0, 0], [-64, 0, -3], [16, 0, 2], [40, 10, 0]];

  /** The spring itself: the same semi-implicit Euler, every step kept, linear in between. */
  function spring(from, to, v0) {
    const k = 365;
    const w = Math.sqrt(k);
    let x = from - to;
    let v = v0 * 1000;
    const pts = [x];
    for (let i = 0; i < 1.3 / STEP_S; i += 1) {
      v += (-k * x - 2 * 0.72 * w * v) * STEP_S; x += v * STEP_S;
      pts.push(x);
    }
    return (ms) => {
      const s = ms / 1000 / STEP_S;
      const i = Math.floor(s);
      return to + pts[i] + (pts[i + 1] - pts[i]) * (s - i);
    };
  }
  /** What the screen shows at `ms`: WAAPI's straight line between the keyframes around it. */
  function drawn(r, ms) {
    const y = ys(r);
    const n = y.length - 1;
    const p = Math.min(1, ms / r.duration) * n;
    const i = Math.min(n - 1, Math.floor(p));
    return y[i] + (y[i + 1] - y[i]) * (p - i);
  }
  const frameTimes = (hz, until) => {
    const out = [];
    for (let f = 0; (f * 1000) / hz <= until; f += 1) out.push((f * 1000) / hz);
    return out;
  };
  /** The worst gap between the screen and the spring, up to the last keyframe gap (where it snaps onto `to`). */
  function worst(r, from, to, v0, hz) {
    const truth = spring(from, to, v0);
    return Math.max(...frameTimes(hz, r.duration - 1000 / KEY_HZ).map((t) => Math.abs(drawn(r, t) - truth(t))));
  }

  it("every frame at every rate is within 0.2 px of the spring", () => {
    for (const [from, to, v0] of RELEASES) {
      const r = springKeyframes(from, to, v0);
      for (const hz of RATES) expect(worst(r, from, to, v0, hz)).toBeLessThan(0.2);
    }
  });

  it("the same settle at every rate: it lands on `to` at the same ms, whatever the frame length", () => {
    for (const [from, to, v0] of RELEASES) {
      const r = springKeyframes(from, to, v0);
      for (const hz of RATES) {
        const last = frameTimes(hz, r.duration).at(-1);
        expect(drawn(r, r.duration)).toBe(to);
        expect(r.duration - last).toBeLessThan(1000 / hz);   // the last frame drawn is the frame before the end
      }
      // Whole keyframe gaps of 1000 / KEY_HZ ms: the time is the clock's, not a frame count.
      expect(r.duration * KEY_HZ / 1000).toBeCloseTo(r.keyframes.length - 1, 9);
    }
  });

  it("keyframes one per 60 Hz frame (as before) leave a 120 Hz screen about 3 px off the spring", () => {
    // Every 4th keyframe is exactly the old list (same physics step), so this is what a 60 Hz list drew.
    const [from, to, v0] = [-64, 0, -3];
    const r = springKeyframes(from, to, v0);
    const every4 = r.keyframes.filter((_, i) => i % 4 === 0);
    const old = { duration: ((every4.length - 1) * 1000) / 60, keyframes: every4 };
    expect(worst(old, from, to, v0, 60)).toBeLessThan(0.2);   // it was right at 60 Hz
    expect(worst(old, from, to, v0, 120)).toBeGreaterThan(2); // and off the curve at 120
    expect(worst(r, from, to, v0, 120)).toBeLessThan(0.2);
  });
});
