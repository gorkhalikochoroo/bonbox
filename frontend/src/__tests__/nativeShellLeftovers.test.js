/**
 * Native app shells (Android walk, 11 Nov 2026): an old build's service
 * worker and its "bonbox-*" Cache Storage go once per start — inside a
 * native shell only. Browsers keep theirs (push, the installed app).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropNativeShellLeftovers } from "../utils/nativeShellLeftovers";

const fakes = () => {
  const regs = [{ unregister: vi.fn(() => Promise.resolve(true)) }, { unregister: vi.fn(() => Promise.resolve(true)) }];
  const nav = { serviceWorker: { getRegistrations: vi.fn(() => Promise.resolve(regs)) } };
  const store = {
    keys: vi.fn(() => Promise.resolve(["bonbox-v10", "bonbox-api-v2", "other"])),
    delete: vi.fn(() => Promise.resolve(true)),
  };
  return { regs, nav, store };
};

afterEach(() => { delete window.Capacitor; });

describe("dropNativeShellLeftovers", () => {
  it("a browser: touches nothing", async () => {
    const { nav, store } = fakes();
    expect(await dropNativeShellLeftovers({ isNative: false, nav, store })).toBe(0);
    expect(nav.serviceWorker.getRegistrations).not.toHaveBeenCalled();
    expect(store.keys).not.toHaveBeenCalled();
  });

  it("the native shell: every registration is unregistered, only bonbox-* caches are deleted", async () => {
    const { regs, nav, store } = fakes();
    expect(await dropNativeShellLeftovers({ isNative: true, nav, store })).toBe(2);
    for (const r of regs) expect(r.unregister).toHaveBeenCalledTimes(1);
    expect(store.delete.mock.calls.map(([k]) => k).sort()).toEqual(["bonbox-api-v2", "bonbox-v10"]);
  });

  it("failures never throw (the start must go on)", async () => {
    const nav = { serviceWorker: { getRegistrations: vi.fn(() => Promise.reject(new Error("SecurityError"))) } };
    const store = { keys: vi.fn(() => { throw new Error("no caches"); }), delete: vi.fn() };
    await expect(dropNativeShellLeftovers({ isNative: true, nav, store })).resolves.toBe(2);
    // No serviceWorker / caches at all (iOS WKWebView): nothing to do.
    await expect(dropNativeShellLeftovers({ isNative: true, nav: {}, store: undefined })).resolves.toBe(0);
  });

  it("reads the shell from window.Capacitor (the entry never imports @capacitor/core)", async () => {
    const { nav, store } = fakes();
    expect(await dropNativeShellLeftovers({ nav, store })).toBe(0);           // jsdom: a browser
    window.Capacitor = { isNativePlatform: () => true };
    expect(await dropNativeShellLeftovers({ nav, store })).toBe(2);
    expect(store.delete).toHaveBeenCalled();
  });

  it("source: main.jsx calls it once, and it imports no Capacitor module", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const main = fs.readFileSync(path.join(SRC, "main.jsx"), "utf8");
    expect(main.match(/^dropNativeShellLeftovers\(\)$/gm)).toHaveLength(1);
    const mod = fs.readFileSync(path.join(SRC, "utils/nativeShellLeftovers.js"), "utf8");
    expect(mod).not.toMatch(/^import /m);
  });
});
