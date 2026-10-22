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
 *
 * Landing v6 (port step 7, 22 Oct 2026): the front door is pages/LandingV6Page
 * (components/landing/v6), a lazy chunk behind its own Suspense; the boot
 * prefixes are landingV6 + cookie (landingV2 / landingPlan left with the old,
 * unrouted page); a logged-out visitor's index.html preloads the landing chunk
 * (vite.config.js preloadLanding).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { render, screen, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import BOOT from "virtual:bonbox-boot-dict";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { isBootKey } from "../lib/bootKeys";
import { isLandingPath, landingFirstPaint, mightBeSignedIn } from "../lib/landingBoot";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
// What the front door renders: the v6 page and its components, and the cookie banner (port step 7: re-pointed
// from the old landing's v2 dir, which is no longer routed).
const FILES = [
  "pages/LandingV6Page.jsx",
  "components/CookieConsent.jsx",
  ...fs.readdirSync(path.join(SRC, "components/landing/v6")).filter((f) => /\.jsx?$/.test(f)).map((f) => `components/landing/v6/${f}`),
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
    // the v6 page's ~130 keys + the banner's ~20 (port step 7; it was ~300 with the old landing's)
    expect(Object.keys(BOOT.da).length).toBeGreaterThan(120);
    expect(Object.keys(BOOT.da).length).toBeLessThan(400);
  });

  it("holds the whole v6 page and nothing of the old, unrouted landing", () => {
    const v6 = Object.keys(da).filter((k) => k.startsWith("landingV6."));
    expect(v6.length).toBeGreaterThan(100);
    for (const k of v6) expect(BOOT.da[k] && BOOT.en[k], k).toBeTruthy();
    const old = Object.keys(BOOT.da).filter((k) => k.startsWith("landingV2") || k.startsWith("landingPlan"));
    expect(old).toEqual([]);
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
          <span data-testid="cta">{t("landingV6.cta")}</span>
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

  it("FullDictionaryGate: the landing renders, any other route waits behind the spinner", async () => {
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
    // ...behind the spinner, never a blank white page (push 9 review: a fast
    // tap on "Prøv gratis" on a slow phone showed #root empty for ~2 s).
    expect(screen.getByTestId("page-loader")).toBeTruthy();
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
    const { container } = view();
    // the v6 landing (a lazy chunk with no fallback of its own)
    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    expect(container.querySelector('.lp6[data-page="landing"]')).not.toBeNull();
    expect(screen.queryByTestId("page-loader")).toBeNull();
    cleanup();
    document.cookie = "bonbox_csrf=abc; path=/";
    view();
    expect(screen.getByTestId("page-loader")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    vi.doUnmock("../hooks/useLanguage");
    vi.doUnmock("../hooks/useAuth");
  });

  it("PublicOrDashboard keeps the one landing when /auth/me answers 'no session': the page and its engine mount once", async () => {
    const auth = { user: null, loading: true };
    const { PublicOrDashboard, LanguageProvider } = await loadApp({ fullReady: true, auth });
    const ui = () => (
      <MemoryRouter initialEntries={["/"]}>
        <LanguageProvider><PublicOrDashboard /></LanguageProvider>
      </MemoryRouter>
    );
    const { container, rerender } = render(ui());
    await screen.findByRole("heading", { level: 1 });
    const root = container.querySelector(".lp6");
    expect(root).not.toBeNull();
    auth.loading = false; // /auth/me answered: no user
    await act(async () => rerender(ui()));
    expect(container.querySelector(".lp6")).toBe(root); // the same node: React kept the instance
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

describe("vite.config.js preloadLanding: the landing chunk downloads with the page (port step 7, PORT_PLAN 1.9)", () => {
  const BUNDLE = {
    "assets/LandingV6Page-abc.js": {
      type: "chunk",
      fileName: "assets/LandingV6Page-abc.js",
      facadeModuleId: "/repo/frontend/src/pages/LandingV6Page.jsx",
      imports: ["assets/index-1.js", "assets/shared-2.js"],
      viteMetadata: { importedCss: new Set(["assets/LandingV6Page-abc.css"]) },
    },
    "assets/index-1.js": { type: "chunk", fileName: "assets/index-1.js", facadeModuleId: "/repo/frontend/index.html", imports: [] },
  };
  const HTML =
    '<html><head><meta charset="UTF-8" /><script>/*dictionary*/</script>\n' +
    '<link rel="modulepreload" crossorigin href="/assets/index-1.js"></head><body></body></html>';

  async function plugin() {
    const { default: config } = await import("../../vite.config.js");
    const p = config.plugins.flat().find((x) => x && x.name === "bonbox-preload-landing");
    expect(p, "preloadLanding is registered").toBeTruthy();
    expect(p.apply).toBe("build");
    return p.transformIndexHtml.handler;
  }
  // Runs the inserted script with stand-ins for the globals it reads; returns the links it added.
  function run(script, { path: at = "/", cookie = "", token = null, native = false, storage = true } = {}) {
    const links = [];
    const doc = { cookie, head: { appendChild: (l) => links.push(l) }, createElement: () => ({}) };
    const store = { getItem: (k) => { if (!storage) throw new Error("blocked"); return k === "token" ? token : null; } };
    new Function("window", "location", "localStorage", "document", script)(
      native ? { Capacitor: {} } : {}, { pathname: at, protocol: "https:" }, store, doc,
    );
    return links;
  }

  it("writes one inline script right after <meta charset>, behind the dictionary preload", async () => {
    const out = await (await plugin())(HTML, { bundle: BUNDLE });
    const m = out.match(/<meta charset="UTF-8" \/><script>\/\*dictionary\*\/<\/script><script>([\s\S]*?)<\/script>/);
    expect(m, out).not.toBeNull();
    expect(m[1]).toContain('var j=["/assets/LandingV6Page-abc.js","/assets/shared-2.js"]'); // not the entry again
    expect(m[1]).toContain('c=["/assets/LandingV6Page-abc.css"]');
  });

  it("preloads on / and /v2 for a visitor with no session sign; never for a session, the native app or another page", async () => {
    const out = await (await plugin())(HTML, { bundle: BUNDLE });
    const script = out.match(/<\/script><script>([\s\S]*?)<\/script>/)[1];
    for (const at of ["/", "/v2", "/v2/"]) {
      const links = run(script, { path: at });
      expect(links.map((l) => `${l.rel} ${l.as || ""} ${l.href}`.replace("  ", " ")), at).toEqual([
        "modulepreload /assets/LandingV6Page-abc.js",
        "modulepreload /assets/shared-2.js",
        "preload style /assets/LandingV6Page-abc.css",
      ]);
      for (const l of links) expect(l.crossOrigin).toBe(""); // = Vite's own preload links, so the style preload is used
    }
    expect(run(script, { path: "/", storage: false })).toHaveLength(3); // storage blocked: still a prospect
    expect(run(script, { path: "/", cookie: "a=1; bonbox_csrf=abc" })).toEqual([]);
    expect(run(script, { path: "/", token: "t" })).toEqual([]);
    expect(run(script, { path: "/", native: true })).toEqual([]);
    for (const at of ["/login", "/register", "/dashboard", "/bistro"]) expect(run(script, { path: at }), at).toEqual([]);
  });

  it("leaves the page alone when the build has no landing chunk (the Vagtplan app)", async () => {
    expect(await (await plugin())(HTML, { bundle: {} })).toBe(HTML);
  });

  it("App.jsx: the landing is lazy behind its own fallback-free Suspense, started early, folded out of the Vagtplan build", () => {
    const app = read("App.jsx");
    expect(app).not.toMatch(/import LandingV2Page/);
    expect(app).toMatch(/const loadLanding = \(\) => import\("\.\/pages\/LandingV6Page"\);/);
    expect(app).toMatch(/const LandingV6Page = import\.meta\.env\.VITE_APP_MODE === "scheduler"\s*\?/);
    expect(app).toMatch(/if \(import\.meta\.env\.VITE_APP_MODE !== "scheduler" && landingFirstPaint\(\)\) loadLanding\(\)/);
    expect(app).toMatch(/<Suspense fallback=\{null\}>\s*<LandingV6Page \/>\s*<\/Suspense>/);
    expect(app).toMatch(/<Route path="\/v2" element=\{<LandingRoute \/>\} \/>/);
    expect(app.match(/(?:: |return |element=\{)<LandingRoute \/>/g)).toHaveLength(3); // both PublicOrDashboard branches + /v2
  });
});
