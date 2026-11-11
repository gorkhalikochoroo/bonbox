/**
 * The venue map's request width and its page-session memory (Android 14 walk,
 * 11 Nov 2026). At 412 px — a common Android phone width — the card asked for
 * 352 px from the viewport (old side chrome 68) and then the measured 336
 * (the real chrome is 76: 20 px page gutters + 18 px card padding). Each
 * answer evicted the other size, so the card went blank (an empty pine box)
 * on every other remount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapRequestWidth, mapCacheKey, getCachedMap, setCachedMap, clearVenueMapCache } from "../utils/venueMapImage";

const realW = window.innerWidth;
const setVW = (w) => Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });

beforeEach(() => {
  clearVenueMapCache();
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => setVW(realW));

describe("mapRequestWidth", () => {
  it("the estimate from the viewport equals what the card then measures (one request, not two)", () => {
    for (const vw of [320, 360, 375, 390, 393, 402, 412, 430, 480, 512, 768]) {
      setVW(vw);
      const measured = Math.min(vw, 512) - 76;
      expect([vw, mapRequestWidth(0)]).toEqual([vw, mapRequestWidth(measured)]);
    }
  });

  it("412 → 336, 390 → 320 (the server's 16 px grid, rounded up)", () => {
    setVW(412);
    expect(mapRequestWidth(0)).toBe(336);
    setVW(390);
    expect(mapRequestWidth(0)).toBe(320);
  });
});

describe("setCachedMap", () => {
  const k = (w, v, scope = "staff:tok") => mapCacheKey(scope, w, 3, v, "pine");

  it("two sizes of the same map both stay", () => {
    setCachedMap(k(352, "v1"), { url: "blob:352" });
    setCachedMap(k(336, "v1"), { url: "blob:336" });
    expect(getCachedMap(k(352, "v1"))).toEqual({ url: "blob:352" });
    expect(getCachedMap(k(336, "v1"))).toEqual({ url: "blob:336" });
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("a moved pin (another version) replaces every size of the old one, and frees it", () => {
    setCachedMap(k(352, "v1"), { url: "blob:352" });
    setCachedMap(k(336, "v1"), { url: "blob:336" });
    setCachedMap(k(336, "v2"), { url: "blob:new" });
    expect(getCachedMap(k(352, "v1"))).toBeUndefined();
    expect(getCachedMap(k(336, "v1"))).toBeUndefined();
    expect(getCachedMap(k(336, "v2"))).toEqual({ url: "blob:new" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:352");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:336");
  });

  it("another staffer's (or the owner's) map is never touched", () => {
    setCachedMap(k(336, "v1", "staff:a"), { url: "blob:a" });
    setCachedMap(k(336, "v2", "staff:b"), { url: "blob:b" });
    expect(getCachedMap(k(336, "v1", "staff:a"))).toEqual({ url: "blob:a" });
  });

  it("replacing the same key frees the old image", () => {
    setCachedMap(k(336, "v1"), { url: "blob:old" });
    setCachedMap(k(336, "v1"), { url: "blob:new" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:old");
    expect(getCachedMap(k(336, "v1"))).toEqual({ url: "blob:new" });
  });
});
