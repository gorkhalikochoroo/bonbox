/**
 * The venue map's request width and its page-session memory (Android 14 walk,
 * 11 Nov 2026, and its review, 12 Nov). On the Android 14 emulator the card
 * asked for 352 px from the viewport and then the measured 336; each answer
 * evicted the other size, so the card went blank (an empty pine box) on every
 * other remount. The eviction now keeps every size of the current version.
 *
 * The emulator's 336 was not a phone's: it reports pointer: fine, so index.css
 * gives the shell an 8 px scrollbar there. On a touch phone the map is
 * min(viewport, 512) − 68 wide (16 px page gutters + 18 px card padding, each
 * side), or − 60 at 360 px and below (12 px gutters). The estimate follows the
 * touch phone; VenueMapImage requests only the width it measured
 * (StaffPortalPage.homeV3 pins one request on both layouts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapRequestWidth, mapChrome, mapCacheKey, getCachedMap, setCachedMap, clearVenueMapCache } from "../utils/venueMapImage";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realW = window.innerWidth;
const setVW = (w) => Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: w });

beforeEach(() => {
  clearVenueMapCache();
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => setVW(realW));

describe("mapRequestWidth", () => {
  // Edited 12 Nov 2026 (review of 4724866a): this pinned the emulator's
  // pointer: fine layout (vw − 76) as if it were a phone's. It now pins a
  // touch phone's: 16 px gutters (12 at 360 px and below) + 18 px card padding.
  const touchPhone = (vw) => Math.min(vw, 512) - (vw <= 360 ? 60 : 68);

  it("on a touch phone the estimate from the viewport equals what the card then measures", () => {
    for (const vw of [320, 360, 375, 390, 393, 402, 412, 430, 480, 512, 768]) {
      setVW(vw);
      expect([vw, mapRequestWidth(0)]).toEqual([vw, mapRequestWidth(touchPhone(vw))]);
    }
  });

  it("412 → 352, 390 → 336, 360 → 304, 320 → 272 (the server's 16 px grid, rounded up)", () => {
    setVW(412);
    expect(mapRequestWidth(0)).toBe(352);
    setVW(390);
    expect(mapRequestWidth(0)).toBe(336);
    setVW(360);
    expect(mapRequestWidth(0)).toBe(304);
    setVW(320);
    expect(mapRequestWidth(0)).toBe(272);
  });

  it("the side chrome: 68, or 60 at 360 px and below (px-3 min-[361px]:px-4)", () => {
    // The page's gutters the estimate assumes.
    const page = fs.readFileSync(path.join(SRC, "pages/StaffPortalPage.jsx"), "utf8");
    expect(page).toMatch(/data-testid="portal-content" className=\{`max-w-lg mx-auto px-3 min-\[361px\]:px-4 /);
    expect(mapChrome(361)).toBe(68);
    expect(mapChrome(360)).toBe(60);
    expect(mapChrome(320)).toBe(60);
    expect(mapChrome(1024)).toBe(68);
  });

  it("a measured width always wins over the estimate", () => {
    setVW(412);
    expect(mapRequestWidth(336)).toBe(336);
    expect(mapRequestWidth(1000)).toBe(448);
    expect(mapRequestWidth(100)).toBe(256);
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
