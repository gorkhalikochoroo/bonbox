/**
 * Links someone ELSE opens (a staff link, a menu QR, a gavekort) were built
 * from window.location.origin — which inside the native owner app is the
 * shell's capacitor://localhost. Shared from the iOS app, they opened nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../utils/platform");
});

describe("publicUrl", () => {
  it("uses bonbox.dk inside the native app", async () => {
    vi.doMock("../utils/platform", () => ({ isNativeApp: () => true }));
    const { publicUrl } = await import("../utils/publicUrl");
    expect(publicUrl("/s/abc")).toBe("https://www.bonbox.dk/s/abc");
  });

  it("keeps the page's own origin on the web", async () => {
    vi.doMock("../utils/platform", () => ({ isNativeApp: () => false }));
    const { publicUrl } = await import("../utils/publicUrl");
    expect(publicUrl("/s/abc")).toBe(`${window.location.origin}/s/abc`);
  });
});
