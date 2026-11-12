/**
 * Landing speed, step 1 (10 Nov 2026): the landing is in React's first render.
 *
 *  - App.jsx keeps the early import's result (`landingBoot`); main.jsx mounts
 *    React once it has settled (4 s cap), so the first commit already holds
 *    the page — no empty Suspense commit, no 300 ms hold before it shows.
 *  - Everyone else (a session sign, the native shell, another path, the
 *    Vagtplan build) has no `landingBoot` and mounts at once, as before.
 *  - A failed or late chunk still mounts and retries through lazyRetry; while
 *    it does, the first screen the HTML drew (#lp6-first, step 2) stays on
 *    screen: the landing's Suspense fallback puts that node back.
 *  - The cookie banner opens without its 600 ms beat on the landing for a
 *    prospect (its first commit now comes with the page); elsewhere the beat
 *    stays, so a guest booking page can still mark itself first.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountWhenReady } from "../lib/landingBoot";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  document.cookie = "bonbox_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  localStorage.removeItem("token");
  localStorage.removeItem("lang");
  localStorage.removeItem("bonbox_cookie_consent");
  delete window.Capacitor;
  document.getElementById("lp6-first")?.remove();
  window.history.replaceState({}, "", "/");
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("mountWhenReady (lib/landingBoot)", () => {
  it("no waits (every visit but the prospect's landing): mounts at once, synchronously", () => {
    const start = vi.fn();
    mountWhenReady(start, null, 4000);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("the landing: waits for landingBoot, then mounts once", async () => {
    let done;
    const boot = new Promise((r) => { done = r; });
    const start = vi.fn();
    const timer = vi.fn();
    mountWhenReady(start, [boot], 4000, timer);
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 4000);
    done();
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    timer.mock.calls[0][0](); // the cap firing later changes nothing
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a rejected import still mounts (the route then retries through lazyRetry)", async () => {
    const start = vi.fn();
    mountWhenReady(start, [Promise.reject(new Error("chunk"))], 4000, () => {});
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a chunk that never settles mounts at the cap, once", async () => {
    vi.useFakeTimers();
    const start = vi.fn();
    mountWhenReady(start, [new Promise(() => {})], 4000);
    vi.advanceTimersByTime(3999);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("main.jsx mounts through it with landingBoot, and keeps the HTML's first screen right before the mount", () => {
    const main = read("main.jsx");
    expect(main).toContain("import App, { landingBoot } from './App.jsx'");
    expect(main).toContain("const waits = landingBoot ? [landingBoot] : null");
    expect(main).toContain("mountWhenReady(start, waits, cap)");
    const start = main.slice(main.indexOf("const start = () => {"));
    expect(start.indexOf("holdFirstScreen()")).toBeGreaterThan(0);
    expect(start.indexOf("holdFirstScreen()")).toBeLessThan(start.indexOf("createRoot("));
    expect(main.match(/createRoot\(/g)).toHaveLength(1);
  });
});

describe("App.jsx landingBoot: only the prospect's landing waits", () => {
  async function bootFor({ path: at = "/", cookie = false, token = false, native = false, scheduler = false } = {}) {
    vi.resetModules();
    window.history.replaceState({}, "", at);
    if (cookie) document.cookie = "bonbox_csrf=abc; path=/";
    if (token) localStorage.setItem("token", "t");
    if (native) window.Capacitor = { isNativePlatform: () => true };
    if (scheduler) vi.stubEnv("VITE_APP_MODE", "scheduler");
    const { landingBoot } = await import("../App.jsx");
    return { boot: landingBoot }; // wrapped: an async function would unwrap the promise
  }

  it("a prospect on / and /v2: a promise that settles", async () => {
    for (const at of ["/", "/v2"]) {
      const { boot } = await bootFor({ path: at });
      expect(boot, at).toBeInstanceOf(Promise);
      await expect(boot).resolves.toBeUndefined();
    }
  });

  it.each([
    ["the session cookie", { cookie: true }],
    ["a stored token", { token: true }],
    ["the native shell", { native: true }],
    ["another route", { path: "/login" }],
    ["a booking page", { path: "/r/cafe" }],
    ["the Vagtplan build", { scheduler: true }],
  ])("%s: null (React mounts synchronously, as before)", async (_name, opts) => {
    expect((await bootFor(opts)).boot).toBeNull();
  });

  it("App.jsx: the resolved page is chosen once per route; the lazy one otherwise", () => {
    const app = read("App.jsx");
    expect(app).toMatch(/export const landingBoot = import\.meta\.env\.VITE_APP_MODE !== "scheduler" && landingFirstPaint\(\)\s*\? loadLanding\(\)\.then\(\(m\) => \{ LandingNow = m\.default; \}, \(\) => \{\}\)\s*: null;/);
    expect(app).toContain("const [Now] = useState(() => LandingNow);");
    expect(app).toMatch(/<Suspense fallback=\{<KeepFirstScreen \/>\}>\s*\{Now \? <Now \/> : <LandingFrontPage \/>\}\s*<FirstScreenHandover \/>\s*<\/Suspense>/);
  });
});

describe("LandingRoute in the first render", () => {
  async function loadApp({ landing } = {}) {
    vi.resetModules();
    window.history.replaceState({}, "", "/");
    localStorage.setItem("lang", "da");
    if (landing) vi.doMock("../pages/LandingV7Page", landing);
    vi.doMock("../hooks/useAuth", async (orig) => ({ ...(await orig()), useAuth: () => ({ user: null, loading: true }) }));
    const app = await import("../App.jsx");
    const { LanguageProvider } = await import("../hooks/useLanguage");
    // the same module instance App.jsx reads (vi.resetModules gives every import a fresh registry)
    const { holdFirstScreen: hold } = await import("../lib/landingBoot");
    return { ...app, LanguageProvider, hold };
  }
  const ui = ({ PublicOrDashboard, LanguageProvider }) => (
    <MemoryRouter initialEntries={["/"]}>
      <LanguageProvider><PublicOrDashboard /></LanguageProvider>
    </MemoryRouter>
  );
  afterEach(() => {
    vi.doUnmock("../pages/LandingV7Page");
    vi.doUnmock("../hooks/useAuth");
  });

  it("once landingBoot has settled, the first commit already holds the landing (no fallback commit)", async () => {
    const app = await loadApp();
    await app.landingBoot;
    const { container } = render(ui(app));
    // synchronously after the first render: no Suspense fallback in between
    expect(container.querySelector('.lp7[data-page="landing"]')).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("a late chunk: the HTML's first screen stays on screen until the page arrives", async () => {
    let arrive;
    const late = new Promise((r) => { arrive = r; });
    // the real page, held back until `arrive`
    const app = await loadApp({ landing: async (orig) => { await late; return orig(); } });
    const first = document.createElement("div");
    first.id = "lp6-first";
    first.innerHTML = "<p>first screen</p>";
    const root = document.createElement("div");
    root.appendChild(first);
    document.body.appendChild(root);
    app.hold();
    root.textContent = ""; // what React's first commit does to #root
    const { container } = render(ui(app));
    expect(container.contains(first)).toBe(true);
    expect(container.textContent).toContain("first screen");
    arrive();
    expect(await screen.findByRole("heading", { level: 1 }, { timeout: 5000 })).toBeTruthy();
    expect(container.contains(first)).toBe(false);
    expect(container.querySelector('.lp7[data-page="landing"]')).not.toBeNull();
    root.remove();
  });

  it("a failed chunk: mounts, keeps the first screen while lazyRetry retries", async () => {
    const app = await loadApp({ landing: () => { throw new Error("chunk failed"); } });
    await app.landingBoot; // settled (rejected inside, swallowed)
    const first = document.createElement("div");
    first.id = "lp6-first";
    first.textContent = "first screen";
    document.body.appendChild(first);
    app.hold();
    first.remove();
    const { container } = render(ui(app));
    await act(async () => { await flush(); });
    expect(container.contains(first)).toBe(true);
  });

  it("no first screen from the HTML (any other visit): the fallback is an empty, layout-neutral box", async () => {
    const app = await loadApp({ landing: () => new Promise(() => {}) });
    app.hold();
    const { container } = render(ui(app));
    const box = container.firstElementChild;
    expect(box.tagName).toBe("DIV");
    expect(box.style.display).toBe("contents");
    expect(box.childNodes).toHaveLength(0);
  });
});

describe("the cookie banner keeps its time", () => {
  async function banner(at, { guest = false } = {}) {
    vi.resetModules();
    window.history.replaceState({}, "", at);
    localStorage.setItem("lang", "da");
    const { default: CookieConsent } = await import("../components/CookieConsent");
    const { LanguageProvider } = await import("../hooks/useLanguage");
    const { markGuestSurface } = await import("../lib/guestSurface");
    vi.useFakeTimers();
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={[at]}><CookieConsent /></MemoryRouter>
      </LanguageProvider>,
    );
    const open = () => !!document.querySelector('[data-cookie-consent="banner"]');
    return { open, markGuestSurface, guest };
  }

  it("on the landing for a prospect: at once (no 600 ms beat)", async () => {
    const { open } = await banner("/");
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(open()).toBe(true);
  });

  it("on any other page: after the 600 ms beat", async () => {
    const { open } = await banner("/login");
    await act(async () => { vi.advanceTimersByTime(599); });
    expect(open()).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(open()).toBe(true);
  });

  it("on a booking page: the beat stays, so the page marks itself first and no banner opens", async () => {
    const { open, markGuestSurface } = await banner("/r/cafe");
    let unmark = () => {};
    await act(async () => { vi.advanceTimersByTime(300); unmark = markGuestSurface(); });
    await act(async () => { vi.advanceTimersByTime(700); });
    expect(open()).toBe(false);
    unmark();
  });

  it("the landing with a session cookie keeps the beat too", async () => {
    document.cookie = "bonbox_csrf=abc; path=/";
    const { open } = await banner("/");
    await act(async () => { vi.advanceTimersByTime(599); });
    expect(open()).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(open()).toBe(true);
  });
});
