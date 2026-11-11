/**
 * The throw-matched settle (premium feel P4, components/staff/spring.js):
 * keyframes from a small spring simulation (the kit's --spring-soft, k 365,
 * ζ .72), played by WAAPI. It lands exactly, overshoots about 3.8 %, never
 * runs longer than 1.2 s, and a release that is still moving keeps going
 * before it turns.
 */
import { describe, expect, it } from "vitest";
import { springKeyframes, SUBSTEPS } from "../components/staff/spring";

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

  it("integrates each 60 Hz frame in eight steps (a whole-frame step damped the overshoot to 1 %)", () => {
    expect(SUBSTEPS).toBe(8);
  });
});
