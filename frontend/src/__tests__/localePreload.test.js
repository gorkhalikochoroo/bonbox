/**
 * Preloading the other language once the page is idle (Android 14 walk,
 * 12 Nov 2026, P7): switching DA in the staff app's profile took 2-3 s to
 * repaint on a slow WebView while the da dictionary's chunk loaded. The
 * portal fetches its two offered languages (DA, EN) when idle after the
 * profile sheet has opened (fix round, PLAT-2; it used to be after the first
 * paint) — only the ones not loaded yet, nothing renders, cancellable.
 *
 * The test setup primes en + da (src/test/setup.js), so a not-yet-loaded
 * language here is a real one from the catalog's loaders (de).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadedLocales } from "../lib/localeStore";
import { preloadLocalesWhenIdle } from "../lib/localePreload";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let idle;
const realRic = window.requestIdleCallback;
const realCic = window.cancelIdleCallback;
beforeEach(() => {
  idle = [];
  window.requestIdleCallback = vi.fn((cb, opts) => { idle.push({ cb, opts }); return idle.length; });
  window.cancelIdleCallback = vi.fn();
});
afterEach(() => {
  window.requestIdleCallback = realRic;
  window.cancelIdleCallback = realCic;
  vi.useRealTimers();
});
const settle = () => vi.waitFor(() => expect(loadedLocales().de).toBeTruthy());

describe("preloadLocalesWhenIdle", () => {
  it("languages already loaded: nothing is scheduled at all", () => {
    expect(loadedLocales().da).toBeTruthy();
    expect(loadedLocales().en).toBeTruthy();
    const cancel = preloadLocalesWhenIdle(["da", "en"]);
    expect(window.requestIdleCallback).not.toHaveBeenCalled();
    expect(typeof cancel).toBe("function");
    cancel();
  });

  it("lib/localeStore keeps its exports (the door screen's stand-in must match them; r11.standBuild)", async () => {
    const store = await import("../lib/localeStore");
    expect(store.preloadLocalesWhenIdle).toBeUndefined();
  });

  it("an unknown code is ignored", () => {
    preloadLocalesWhenIdle(["xx"]);
    expect(window.requestIdleCallback).not.toHaveBeenCalled();
  });

  it("a missing one loads only when the page is idle (with a timeout), into the shared cache", async () => {
    expect(loadedLocales().de).toBeUndefined();
    preloadLocalesWhenIdle(["da", "de"]);
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(idle[0].opts).toEqual({ timeout: 4000 });
    // Not before the idle callback.
    await Promise.resolve();
    expect(loadedLocales().de).toBeUndefined();
    idle[0].cb();
    await settle();
    expect(typeof loadedLocales().de).toBe("object");
  });
});

describe("cancel and fallback (fresh module: nothing of de loaded yet)", () => {
  it("cancelled before idle: nothing loads", async () => {
    vi.resetModules();
    const store = await import("../lib/localeStore");
    const { preloadLocalesWhenIdle: preload } = await import("../lib/localePreload");
    const cancel = preload(["de"]);
    cancel();
    expect(window.cancelIdleCallback).toHaveBeenCalledWith(1);
    idle[0].cb();             // a late callback after cancel does nothing either
    await new Promise((r) => setTimeout(r, 30));
    expect(store.loadedLocales().de).toBeUndefined();
  });

  it("no requestIdleCallback (Safari): a 1.5 s timer instead", async () => {
    vi.resetModules();
    const store = await import("../lib/localeStore");
    const { preloadLocalesWhenIdle: preload } = await import("../lib/localePreload");
    delete window.requestIdleCallback;
    vi.useFakeTimers();
    preload(["de"]);
    vi.advanceTimersByTime(1499);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 30));
    expect(store.loadedLocales().de).toBeUndefined();
    vi.useFakeTimers();
    preload(["de"]);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();
    await vi.waitFor(() => expect(store.loadedLocales().de).toBeTruthy());
  });
});

describe("wired into the staff portal", () => {
  // Fix round (PLAT-2): no longer a mount effect. At boot it cost every web
  // visit ~200 KB nobody asked for, and its evaluation a long task in the
  // first seconds. It now runs when the profile sheet (the only place the
  // language changes) opens, after its 0.32 s entrance; the behaviour on the
  // real page is pinned in StaffPortalPage.sheetFeel.test.jsx.
  it("StaffPortalPage preloads its two offered languages when the profile sheet opens, never at boot", () => {
    const page = fs.readFileSync(path.join(SRC, "pages/StaffPortalPage.jsx"), "utf8");
    expect(page).toContain('import { preloadLocalesWhenIdle } from "../lib/localePreload";');
    expect(page).not.toContain('useEffect(() => preloadLocalesWhenIdle(["da", "en"]), []);');
    expect(page.match(/preloadLocalesWhenIdle\(/g)).toHaveLength(1);
    expect(page).toMatch(/if \(!showEmailEdit\) return undefined;[\s\S]{0,120}preloadLocalesWhenIdle\(\["da", "en"\]\); \}, 320\);[\s\S]{0,80}\}, \[showEmailEdit\]\);/);
    // The toggle it serves offers exactly those two.
    expect(page).toContain('{["da", "en"].map((code) => (');
  });
});
