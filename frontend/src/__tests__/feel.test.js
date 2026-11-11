/**
 * Vagtplan's haptic words (premium feel P2 / 1.4, components/staff/feel.js),
 * and Manoj's call G on the shared helper (utils/haptics.js), 11 Nov 2026.
 *
 *   • iOS app: done / warn / fail = success / warning / error; soft = impact
 *     light; tick = selection, and it warms itself (the plugin plays
 *     selectionChanged only between selectionStart and selectionEnd).
 *   • Android app: only outcomes (call E). warn plays ERROR's two short taps:
 *     Capacitor 8.0.2's Android WARNING is one 210 ms full-strength buzz.
 *   • The web link: nothing.
 *   • done / warn / fail / soft share a 1.5 s throttle; tick does not.
 *   • Nothing ever throws out of a haptic (sync throw or rejected promise).
 *   • Call G: utils/haptics.js `warning` plays ERROR on Android, WARNING on
 *     the iPhone (the clock's approved lines call it; they are not touched).
 *
 * The plugin and the platform module are mocked at their boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plat = vi.hoisted(() => ({ isNative: true, isIOS: true, isAndroid: false, isWeb: false }));
vi.mock("../utils/platform", () => ({ platform: plat, isNativeApp: () => plat.isNative }));

const hx = vi.hoisted(() => ({ calls: [], impl: null }));
vi.mock("@capacitor/haptics", () => {
  const rec = (name) => (arg) => {
    hx.calls.push(arg === undefined ? [name] : [name, arg]);
    return hx.impl ? hx.impl(name) : Promise.resolve();
  };
  return {
    Haptics: {
      notification: rec("notification"),
      impact: rec("impact"),
      selectionStart: rec("selectionStart"),
      selectionChanged: rec("selectionChanged"),
      selectionEnd: rec("selectionEnd"),
    },
    ImpactStyle: { Light: "LIGHT", Medium: "MEDIUM", Heavy: "HEAVY" },
    NotificationType: { Success: "SUCCESS", Warning: "WARNING", Error: "ERROR" },
  };
});

const { feel, resetFeelForTests, OUTCOME_GAP_MS, WARM_MS } = await import("../components/staff/feel");
const { haptic } = await import("../utils/haptics");

const asIOSApp = () => Object.assign(plat, { isNative: true, isIOS: true, isAndroid: false, isWeb: false });
const asAndroidApp = () => Object.assign(plat, { isNative: true, isIOS: false, isAndroid: true, isWeb: false });
const asWeb = () => Object.assign(plat, { isNative: false, isIOS: false, isAndroid: false, isWeb: true });
const names = () => hx.calls.map((c) => c[0]);
const later = (ms) => vi.advanceTimersByTime(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 11, 12, 0, 0));
  resetFeelForTests();
  hx.calls.length = 0;
  hx.impl = null;
  asIOSApp();
});
afterEach(() => {
  resetFeelForTests();
  vi.useRealTimers();
});

describe("the numbers", () => {
  it("1.5 s between outcomes; a warm generator lives 2 s", () => {
    expect(OUTCOME_GAP_MS).toBe(1500);
    expect(WARM_MS).toBe(2000);
  });
});

describe("iOS app", () => {
  it("each word calls the right plugin method", () => {
    feel.done(); later(2000);
    feel.warn(); later(2000);
    feel.fail(); later(2000);
    feel.soft();
    expect(hx.calls).toEqual([
      ["notification", { type: "SUCCESS" }],
      ["notification", { type: "WARNING" }],
      ["notification", { type: "ERROR" }],
      ["impact", { style: "LIGHT" }],
    ]);
  });

  it("tick with nothing warm: selectionStart, then selectionChanged, in that order", () => {
    feel.tick();
    expect(names()).toEqual(["selectionStart", "selectionChanged"]);
  });

  it("a second tick within 2 s plays only selectionChanged; selectionEnd 2 s after the last one", () => {
    feel.tick();
    later(1200);
    feel.tick();
    expect(names()).toEqual(["selectionStart", "selectionChanged", "selectionChanged"]);
    later(1999);
    expect(names()).not.toContain("selectionEnd");
    later(1);
    expect(names().at(-1)).toBe("selectionEnd");
    // Cold again: the next tick warms first.
    hx.calls.length = 0;
    feel.tick();
    expect(names()).toEqual(["selectionStart", "selectionChanged"]);
  });

  it("warm (pointerdown on a switch) starts the generator, so the tick on change has no lag", () => {
    feel.warm();
    expect(names()).toEqual(["selectionStart"]);
    later(300);
    feel.tick();
    expect(names()).toEqual(["selectionStart", "selectionChanged"]);
  });
});

describe("Android app (calls E and G)", () => {
  beforeEach(() => asAndroidApp());

  it("done = SUCCESS; warn and fail = ERROR's two short taps (never the 210 ms WARNING buzz)", () => {
    feel.done(); later(2000);
    feel.warn(); later(2000);
    feel.fail();
    expect(hx.calls).toEqual([
      ["notification", { type: "SUCCESS" }],
      ["notification", { type: "ERROR" }],
      ["notification", { type: "ERROR" }],
    ]);
  });

  it("soft, tick and warm call nothing (Android's light and selection are motor pulses)", () => {
    feel.soft();
    feel.tick();
    feel.warm();
    later(5000);
    expect(hx.calls).toEqual([]);
  });
});

describe("the web link", () => {
  it("nothing at all", () => {
    asWeb();
    feel.done(); later(2000);
    feel.warn(); later(2000);
    feel.fail(); later(2000);
    feel.soft(); feel.tick(); feel.warm();
    later(5000);
    expect(hx.calls).toEqual([]);
  });
});

describe("throttle", () => {
  it("done then warn 1 s later: one call; 1.6 s later: two", () => {
    feel.done();
    later(1000);
    feel.warn();
    expect(hx.calls).toHaveLength(1);
    resetFeelForTests();
    hx.calls.length = 0;
    feel.done();
    later(1600);
    feel.warn();
    expect(hx.calls.map((c) => c[1].type)).toEqual(["SUCCESS", "WARNING"]);
  });

  it("tick is not throttled: two ticks, two selection changes", () => {
    feel.tick();
    feel.tick();
    expect(names().filter((n) => n === "selectionChanged")).toHaveLength(2);
  });
});

describe("never throws", () => {
  it("a plugin that throws synchronously", () => {
    hx.impl = () => { throw new Error("plugin missing"); };
    expect(() => feel.done()).not.toThrow();
    later(2000);
    expect(() => feel.tick()).not.toThrow();
    later(3000);   // the warm-down's selectionEnd throws too
  });

  it("a promise that rejects never escapes (no unhandled rejection)", async () => {
    hx.impl = () => Promise.reject(new Error("not implemented on this device"));
    feel.fail();
    later(2000);
    feel.soft();
    feel.tick();
    later(3000);
    await Promise.resolve();
    await Promise.resolve();
    expect(names()).toContain("notification");
  });
});

describe("call G: the shared helper's warning (utils/haptics.js)", () => {
  it("Android: ERROR's two short taps", () => {
    asAndroidApp();
    haptic.warning();
    expect(hx.calls).toEqual([["notification", { type: "ERROR" }]]);
  });

  it("iPhone: WARNING, as before", () => {
    asIOSApp();
    haptic.warning();
    expect(hx.calls).toEqual([["notification", { type: "WARNING" }]]);
  });

  it("web: nothing; the helper's other words are unchanged", () => {
    asWeb();
    haptic.warning();
    expect(hx.calls).toEqual([]);
    asAndroidApp();
    haptic.success();
    haptic.error();
    expect(hx.calls).toEqual([["notification", { type: "SUCCESS" }], ["notification", { type: "ERROR" }]]);
  });
});
