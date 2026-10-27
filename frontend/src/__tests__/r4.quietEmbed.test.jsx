/**
 * Booking R4 — a quiet embed (comparison.md #4a, rubric E5 / G14).
 *
 * Inside a restaurant's own website the booking frame (/r/<slug>?embed=1)
 * made three calls it never needed: GET /api/health (keep-alive),
 * GET /api/config/features, and GET /auth/me — which answered 401, a red
 * error in the restaurant's own console. Now:
 *
 *   • lib/embedMode.isQuietEmbed: /r/<slug> with embed=1, nothing else;
 *   • AuthProvider: no /auth/me there (and no "had session" hint touched);
 *   • FeaturesProvider: no /config/features there (fail-closed defaults);
 *   • App.jsx's keep-alive: no /api/health there.
 * Everywhere else every call is made exactly as before.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isQuietEmbed } from "../lib/embedMode";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(SRC, rel), "utf8");

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
const { FeaturesProvider, useFeatures } = await import("../hooks/useFeatures");

const at = (path) => window.history.replaceState({}, "", path);

describe("isQuietEmbed — the booking frame, and nothing else", () => {
  it.each([
    ["/r/cafe?embed=1", true],
    ["/r/cafe/?embed=1", true],
    ["/r/cafe?d=2030-01-08&embed=1&compact=1", true],
    ["/r/cafe?embed=1&flat=1", true],
    ["/r/cafe", false],
    ["/r/cafe?embed=0", false],
    ["/r/cafe?embed=10", false],
    ["/cafe-nordlys?embed=1", false], // the vanity route is never framed (frame-ancestors 'none')
    ["/dashboard?embed=1", false], // the owner app is never affected
    ["/r/cafe/extra?embed=1", false],
    ["/reservations?embed=1", false],
  ])("%s → %s", (path, quiet) => {
    const u = new URL(path, "https://www.bonbox.dk");
    expect(isQuietEmbed({ pathname: u.pathname, search: u.search })).toBe(quiet);
  });

  it("never throws: no location, or a hostile one, is not quiet", () => {
    expect(isQuietEmbed(null)).toBe(false);
    expect(isQuietEmbed({})).toBe(false);
    const hostile = { get pathname() { throw new Error("x"); } };
    expect(isQuietEmbed(hostile)).toBe(false);
  });

  it("reads the live address by default", () => {
    at("/r/cafe?embed=1");
    expect(isQuietEmbed()).toBe(true);
    at("/r/cafe");
    expect(isQuietEmbed()).toBe(false);
  });
});

function AuthProbe({ out }) {
  const a = useAuth();
  out.user = a.user;
  out.loading = a.loading;
  return null;
}
function FlagsProbe({ out }) {
  out.flags = useFeatures();
  return null;
}

describe("AuthProvider — no session check inside the booking frame", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(() => Promise.reject(Object.assign(new Error("401"), { response: { status: 401 } })));
    localStorage.clear();
    delete window.Capacitor;
    delete window.__bbBootMe;
  });
  afterEach(() => at("/"));

  it("embedded: no /auth/me, not loading, no user — and the owner's start-up hint is left alone", async () => {
    at("/r/cafe?embed=1&compact=1");
    localStorage.setItem("bb_had_session", "1");
    const out = {};
    render(<AuthProvider><AuthProbe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(out.user).toBeNull();
    expect(get).not.toHaveBeenCalledWith("/auth/me", expect.anything());
    expect(get).not.toHaveBeenCalled();
    expect(localStorage.getItem("bb_had_session")).toBe("1");
  });

  it("the same page without ?embed=1 (a guest on the link) checks as before", async () => {
    at("/r/cafe");
    const out = {};
    render(<AuthProvider><AuthProbe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(get).toHaveBeenCalledWith("/auth/me", { _noRetry: true });
  });

  it("the owner app with a stray ?embed=1 checks as before", async () => {
    at("/dashboard?embed=1");
    const out = {};
    render(<AuthProvider><AuthProbe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(get).toHaveBeenCalledWith("/auth/me", { _noRetry: true });
  });
});

describe("FeaturesProvider — no flags call inside the booking frame", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(() => Promise.resolve({ data: { bank_connect_enabled: true } }));
  });
  afterEach(() => at("/"));

  it("embedded: no /config/features; the fail-closed defaults, marked loaded", async () => {
    at("/r/cafe?embed=1");
    const out = {};
    render(<FeaturesProvider><FlagsProbe out={out} /></FeaturesProvider>);
    await waitFor(() => expect(out.flags._loaded).toBe(true));
    expect(get).not.toHaveBeenCalled();
    expect(out.flags.bank_connect_enabled).toBe(false);
    expect(out.flags.mobilepay_enabled).toBe(false);
  });

  it("anywhere else: one call, as before", async () => {
    at("/r/cafe");
    const out = {};
    render(<FeaturesProvider><FlagsProbe out={out} /></FeaturesProvider>);
    await waitFor(() => expect(out.flags._loaded).toBe(true));
    expect(get).toHaveBeenCalledWith("/config/features", { _noRetry: true });
    expect(out.flags.bank_connect_enabled).toBe(true);
  });
});

describe("App.jsx — the keep-alive ping stays home inside the booking frame", () => {
  const app = read("App.jsx");
  it("useKeepAlive returns before its first ping when isQuietEmbed()", () => {
    const fn = app.slice(app.indexOf("function useKeepAlive()"), app.indexOf("const GOOGLE_CLIENT_ID"));
    expect(fn).toMatch(/useEffect\(\(\) => \{[\s\S]*?if \(isQuietEmbed\(\)\) return undefined;[\s\S]*?const ping = /);
    expect(fn.indexOf("isQuietEmbed()")).toBeLessThan(fn.indexOf("ping();"));
    expect(app).toContain('import { isQuietEmbed } from "./lib/embedMode";');
  });

  it("index.html's parse-time session check never runs on /r/ (unchanged: / and /dashboard only)", () => {
    const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
    expect(html).toContain('if (p !== "/" && p !== "/dashboard") return;');
  });
});
