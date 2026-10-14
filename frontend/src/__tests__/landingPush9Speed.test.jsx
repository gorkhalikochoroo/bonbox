/**
 * Push 9 (E) — the logged-out landing paints without waiting for the whole
 * dictionary or for /auth/me.
 *
 *  - The boot dictionary (virtual:bonbox-boot-dict, built from da.js/en.js by
 *    vite.config.js) holds every key the landing and the cookie banner use,
 *    so the first paint is already in the visitor's language.
 *  - LanguageProvider renders on it while the full dictionary downloads and
 *    says so (fullReady: false); App.jsx's FullDictionaryGate lets only the
 *    landing paint then — every other route waits, as before.
 *  - PublicOrDashboard shows the landing while /auth/me is in flight unless
 *    the browser shows a sign of a session (bonbox_csrf cookie / native token).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import BOOT from "virtual:bonbox-boot-dict";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { isBootKey } from "../lib/bootKeys";
import { isLandingPath, landingFirstPaint, mightBeSignedIn } from "../lib/landingBoot";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const FILES = [
  "pages/LandingV2Page.jsx",
  "components/landing/FloorPlan.jsx",
  "components/CookieConsent.jsx",
  ...fs.readdirSync(path.join(SRC, "components/landing/v2")).filter((f) => f.endsWith(".jsx")).map((f) => `components/landing/v2/${f}`),
];

afterEach(() => {
  cleanup();
  document.cookie = "bonbox_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  localStorage.removeItem("token");
});

describe("the boot dictionary", () => {
  it("covers every key the landing and the cookie banner use, in da and en", () => {
    const missing = [];
    for (const f of FILES) {
      const src = read(f);
      for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) {
        const k = m[1];
        if (!(k in en)) continue; // a key no dictionary has is the i18n lint's business
        if (!isBootKey(k) || !BOOT.da[k] || !BOOT.en[k]) missing.push(`${f}: ${k}`);
      }
      // keys composed at runtime: every one of their values must be in it too
      for (const m of src.matchAll(/\bt\(\s*`([^`$]+)\$\{/g)) {
        const prefix = m[1];
        const keys = Object.keys(en).filter((k) => k.startsWith(prefix));
        expect(keys.length, `${f}: ${prefix}*`).toBeGreaterThan(0);
        for (const k of keys) if (!BOOT.da[k] || !BOOT.en[k]) missing.push(`${f}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("is the dictionaries' own text (generated, never a second copy)", () => {
    for (const k of Object.keys(BOOT.da)) expect(BOOT.da[k], k).toBe(da[k]);
    for (const k of Object.keys(BOOT.en)) expect(BOOT.en[k], k).toBe(en[k]);
    expect(Object.keys(BOOT.da).length).toBeGreaterThan(250);
    expect(Object.keys(BOOT.da).length).toBeLessThan(600);
  });
});

describe("the language provider renders the landing on it", () => {
  it("paints Danish at once, before the full dictionary, and says it is not complete", async () => {
    vi.resetModules();
    vi.doMock("../lib/localeStore", () => ({
      loadLocale: () => new Promise(() => {}), // never arrives in this test
      loadedLocales: () => ({}),
      localesFor: (c) => [c],
      hasLocale: () => true,
      primeLocales: () => {},
    }));
    localStorage.setItem("lang", "da");
    const { LanguageProvider, useLanguage } = await import("../hooks/useLanguage");
    function Probe() {
      const { t, fullReady } = useLanguage();
      return (
        <div>
          <span data-testid="cta">{t("landingV2HeroCtaPrimary", "Free trial")}</span>
          <span data-testid="ready">{String(fullReady)}</span>
        </div>
      );
    }
    render(<LanguageProvider><Probe /></LanguageProvider>);
    expect(screen.getByTestId("cta").textContent).toBe("Prøv gratis");
    expect(screen.getByTestId("ready").textContent).toBe("false");
    vi.doUnmock("../lib/localeStore");
    vi.resetModules();
    localStorage.removeItem("lang");
  });
});

describe("App: only the landing paints on boot keys; it does not wait for /auth/me", () => {
  async function loadApp({ fullReady, auth }) {
    vi.resetModules();
    vi.doMock("../hooks/useLanguage", async (orig) => {
      const real = await orig();
      return {
        ...real,
        useLanguage: () => ({ ...real.useLanguage(), fullReady }),
      };
    });
    vi.doMock("../hooks/useAuth", async (orig) => {
      const real = await orig();
      return { ...real, useAuth: () => auth };
    });
    const app = await import("../App.jsx");
    const { LanguageProvider } = await import("../hooks/useLanguage");
    return { ...app, LanguageProvider };
  }

  it("FullDictionaryGate: the landing renders, any other route waits", async () => {
    const { FullDictionaryGate, LanguageProvider } = await loadApp({ fullReady: false, auth: { user: null, loading: false } });
    const at = (p) =>
      render(
        <MemoryRouter initialEntries={[p]}>
          <LanguageProvider>
            <FullDictionaryGate><span data-testid="page">page</span></FullDictionaryGate>
          </LanguageProvider>
        </MemoryRouter>,
      );
    at("/");
    expect(screen.queryByTestId("page")).not.toBeNull();
    cleanup();
    at("/login");
    expect(screen.queryByTestId("page")).toBeNull();
    vi.doUnmock("../hooks/useLanguage");
    vi.doUnmock("../hooks/useAuth");
  });

  it("PublicOrDashboard: landing while /auth/me runs (no session sign); spinner when there is one", async () => {
    const { PublicOrDashboard, LanguageProvider } = await loadApp({ fullReady: true, auth: { user: null, loading: true } });
    const view = () =>
      render(
        <MemoryRouter initialEntries={["/"]}>
          <LanguageProvider><PublicOrDashboard /></LanguageProvider>
        </MemoryRouter>,
      );
    view();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    cleanup();
    document.cookie = "bonbox_csrf=abc; path=/";
    view();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    vi.doUnmock("../hooks/useLanguage");
    vi.doUnmock("../hooks/useAuth");
  });
});

describe("lib/landingBoot", () => {
  it("knows the front door", () => {
    for (const p of ["/", "/v2", "/v2/", ""]) expect(isLandingPath(p), p).toBe(true);
    for (const p of ["/login", "/register", "/dashboard", "/bistro"]) expect(isLandingPath(p), p).toBe(false);
  });

  it("reads a session from the CSRF cookie or the native token — nothing new is stored", () => {
    expect(mightBeSignedIn()).toBe(false);
    document.cookie = "bonbox_csrf=abc; path=/";
    expect(mightBeSignedIn()).toBe(true);
    document.cookie = "bonbox_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    localStorage.setItem("token", "x");
    expect(mightBeSignedIn()).toBe(true);
    localStorage.removeItem("token");
    expect(landingFirstPaint()).toBe(isLandingPath(window.location.pathname));
  });

  it("the index.html preload skips the 185 KB dictionary on the landing without a session", () => {
    const cfg = fs.readFileSync(path.join(SRC, "../vite.config.js"), "utf8");
    expect(cfg).toContain(`if((p==="/"||p==="/v2")&&!/(?:^|;\\\\s*)bonbox_csrf=/.test(document.cookie))`);
    expect(read("hooks/useLanguage.jsx")).toMatch(/if \(!\(bootable && landingFirstPaint\(\)\)\)/);
  });
});
