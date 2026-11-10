/**
 * Landing speed, step 4 (10 Nov 2026): no session question for a browser that cannot hold one.
 *
 * On a bonbox.dk page talking to api.bonbox.dk the page sees the bonbox_csrf cookie the backend sets beside the
 * HttpOnly session cookie (same Domain=.bonbox.dk, same lifetime, re-issued together). No such cookie, no stored
 * token and not the native shell: GET /auth/me could only answer 401 (a red console line on every logged-out visit)
 * — so AuthProvider does not ask, and is not "loading". Any other host or API base: exactly as before.
 * The local speed bench serves the build on localhost: a build-time flag (VITE_BENCH_COOKIE_HOST) lets it take the
 * production path; production never sets it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => get(...a),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    defaults: { baseURL: "https://api.bonbox.dk/api" },
  },
}));

const { AuthProvider, useAuth } = await import("../hooks/useAuth");
const { sessionCookieVisibleHere, cannotHoldASession: cannotHold } = await import("../lib/landingBoot");
const cannotHoldASession = () => cannotHold("https://api.bonbox.dk/api");

function Probe({ out }) {
  const a = useAuth();
  out.loadingSeen = out.loadingSeen || [];
  out.loadingSeen.push(a.loading);
  out.user = a.user;
  out.loading = a.loading;
  return null;
}

beforeEach(() => {
  get.mockReset();
  get.mockRejectedValue(Object.assign(new Error("401"), { response: { status: 401 } }));
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete window.Capacitor;
  delete window.__bbBootMe;
  document.cookie = "bonbox_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  localStorage.clear();
});

describe("sessionCookieVisibleHere: host x API base", () => {
  const API = "https://api.bonbox.dk/api";
  it.each([
    ["www.bonbox.dk", API, true],
    ["bonbox.dk", API, true],
    ["app.bonbox.dk", API, true],
    ["www.bonbox.dk", "https://bonbox-api.onrender.com/api", false],
    ["www.bonbox.dk", "/api", false],
    ["www.bonbox.dk", "", false],
    ["www.bonbox.dk", "https://api.bonbox.dk.evil.com/api", false],
    ["localhost", API, false],
    ["127.0.0.1", API, false],
    ["evilbonbox.dk", API, false],
    ["bonbox.dk.evil.com", API, false],
    ["preview-abc.vercel.app", API, false],
    ["", API, false],
  ])("%s with API %j → %s", (host, base, want) => {
    expect(sessionCookieVisibleHere(host, base)).toBe(want);
  });

  it("the bench flag adds exactly its one host, and still needs the production API", () => {
    vi.stubEnv("VITE_BENCH_COOKIE_HOST", "localhost");
    expect(sessionCookieVisibleHere("localhost", API)).toBe(true);
    expect(sessionCookieVisibleHere("localhost", "/api")).toBe(false);
    expect(sessionCookieVisibleHere("127.0.0.1", API)).toBe(false);
  });
});

describe("cannotHoldASession: cookie x token x native, on a host where the cookie is visible", () => {
  // jsdom's page is localhost: the bench flag makes it count as a bonbox.dk page for these cases
  const cases = [];
  for (const cookie of [false, true]) for (const token of [false, true]) for (const native of [false, true]) cases.push([cookie, token, native]);
  it.each(cases)("cookie %s, token %s, native %s", (cookie, token, native) => {
    vi.stubEnv("VITE_BENCH_COOKIE_HOST", "localhost");
    if (cookie) document.cookie = "bonbox_csrf=abc; path=/";
    if (token) localStorage.setItem("token", "t");
    if (native) window.Capacitor = { isNativePlatform: () => true };
    expect(cannotHoldASession()).toBe(!cookie && !token && !native);
    expect(cannotHold("/api")).toBe(false); // another API base: the cookie says nothing
  });

  it("on any other host (no flag: jsdom's localhost) never: the check stays", () => {
    expect(cannotHoldASession()).toBe(false);
  });
});

describe("AuthProvider", () => {
  it("a prospect on a bonbox.dk page: no GET /auth/me, never loading, the start-up hint cleared", async () => {
    vi.stubEnv("VITE_BENCH_COOKIE_HOST", "localhost");
    localStorage.setItem("bb_had_session", "1");
    const out = {};
    render(<AuthProvider><Probe out={out} /></AuthProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
    expect(out.loadingSeen.every((l) => l === false)).toBe(true);
    expect(out.user).toBeNull();
    expect(localStorage.getItem("bb_had_session")).toBeNull();
  });

  it("the session cookie: asks, as before (a stale session's 401 leaves the landing)", async () => {
    vi.stubEnv("VITE_BENCH_COOKIE_HOST", "localhost");
    document.cookie = "bonbox_csrf=abc; path=/";
    get.mockResolvedValueOnce({ data: { id: "u1", role: "owner" } });
    const out = {};
    render(<AuthProvider><Probe out={out} /></AuthProvider>);
    expect(out.loadingSeen[0]).toBe(true);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(get).toHaveBeenCalledWith("/auth/me", { _noRetry: true });
    expect(out.user).toEqual({ id: "u1", role: "owner" });
  });

  it("a stored token: asks, as before", async () => {
    vi.stubEnv("VITE_BENCH_COOKIE_HOST", "localhost");
    localStorage.setItem("token", "old-bearer");
    const out = {};
    render(<AuthProvider><Probe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(get).toHaveBeenCalledWith("/auth/me", { _noRetry: true });
  });

  it("the native shell with its token: asks, as before", async () => {
    vi.stubEnv("VITE_BENCH_COOKIE_HOST", "localhost");
    window.Capacitor = { isNativePlatform: () => true };
    localStorage.setItem("token", "bearer");
    get.mockResolvedValueOnce({ data: { id: "n1" } });
    const out = {};
    render(<AuthProvider><Probe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(get).toHaveBeenCalledWith("/auth/me", { _noRetry: true });
  });

  it("any other host (a preview, a dev machine): asks, as before", async () => {
    const out = {};
    render(<AuthProvider><Probe out={out} /></AuthProvider>);
    expect(out.loadingSeen[0]).toBe(true);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(get).toHaveBeenCalledWith("/auth/me", { _noRetry: true });
  });
});

describe("the bench flag never reaches production", () => {
  it(".env.production and every committed env file leave VITE_BENCH_COOKIE_HOST unset; vercel.json does not name it", () => {
    const prod = fs.readFileSync(path.join(FRONTEND, ".env.production"), "utf8");
    expect(prod).not.toMatch(/VITE_BENCH_COOKIE_HOST/);
    for (const f of fs.readdirSync(FRONTEND).filter((x) => /^\.env/.test(x))) {
      expect(fs.readFileSync(path.join(FRONTEND, f), "utf8"), f).not.toMatch(/VITE_BENCH_COOKIE_HOST/);
    }
    expect(fs.readFileSync(path.join(FRONTEND, "vercel.json"), "utf8")).not.toMatch(/VITE_BENCH_COOKIE_HOST/);
  });

  it("no host list names localhost (the prototype's shortcut); useAuth.jsx asks it with the API's own base", () => {
    const src = fs.readFileSync(path.join(FRONTEND, "src/lib/landingBoot.js"), "utf8");
    const fn = src.slice(src.indexOf("export function sessionCookieVisibleHere"), src.indexOf("export function cannotHoldASession"));
    expect(fs.readFileSync(path.join(FRONTEND, "src/hooks/useAuth.jsx"), "utf8")).toContain("const noSessionPossible = () => cannotHoldASession(api.defaults?.baseURL);");
    expect(fn).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(fn).toContain('h === "bonbox.dk" || h.endsWith(".bonbox.dk")');
    expect(fn).toContain('=== "api.bonbox.dk"');
  });
});
