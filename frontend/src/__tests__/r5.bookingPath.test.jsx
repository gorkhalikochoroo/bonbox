/**
 * Booking R5 — which addresses are a restaurant's booking page, and the
 * guest's page on its own makes no owner-app call (rubric G14).
 *
 *  • lib/bookingPath.RESERVED_SLUGS is the backend's list, word for word
 *    (routers/reservations.py), and holds every top-level route of App.jsx —
 *    so "a single segment outside the list" is exactly the vanity booking page;
 *  • isQuietGuestPage: the frame (R4) AND the page on its own (/r/<slug>,
 *    /<slug>); never the owner app, never the native apps;
 *  • the session check and the flags call stay home there; the owner app
 *    asks as before.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), patch: vi.fn(), defaults: { baseURL: "http://localhost:8000/api" } },
}));

const { RESERVED_SLUGS, bookingSlugOf, isBookingPath, isBookingPathNow } = await import("../lib/bookingPath");
const { QUIET_GUEST_PAGE, isQuietEmbed, isQuietGuestPage } = await import("../lib/embedMode");
const { AuthProvider, useAuth } = await import("../hooks/useAuth");
const { FeaturesProvider, useFeatures } = await import("../hooks/useFeatures");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(SRC, "..", "..");
const at = (p) => window.history.replaceState({}, "", p);

afterEach(() => {
  at("/");
  delete window.Capacitor;
});

describe("RESERVED_SLUGS mirrors the backend and covers App.jsx", () => {
  it("is the backend's RESERVED_SLUGS, word for word", () => {
    const py = fs.readFileSync(path.join(ROOT, "backend/app/routers/reservations.py"), "utf8");
    const body = py.match(/RESERVED_SLUGS = frozenset\(\{([\s\S]*?)\}\)/)[1];
    const backend = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect([...RESERVED_SLUGS].sort()).toEqual(backend);
  });

  it("holds every top-level route of App.jsx (a vanity slug is never an app page)", () => {
    const app = fs.readFileSync(path.join(SRC, "App.jsx"), "utf8");
    const first = new Set([...app.matchAll(/path="(\/[^"]*)"/g)].map((m) => m[1].split("/")[1]).filter((s) => s && !s.startsWith(":")));
    expect(first.size).toBeGreaterThan(40);
    const missing = [...first].filter((s) => !RESERVED_SLUGS.includes(s));
    expect(missing).toEqual([]);
  });
});

describe("bookingSlugOf", () => {
  it.each([
    ["/r/cafe", "cafe"],
    ["/r/cafe/", "cafe"],
    ["/r/staff", "staff"], // a legacy reserved slug keeps its /r/ link
    ["/cafe-nordlys", "cafe-nordlys"],
    ["/cafe-nordlys/", "cafe-nordlys"],
    ["/smoerrebroed", "smoerrebroed"],
    ["/", null],
    ["", null],
    ["/dashboard", null],
    ["/Dashboard", null], // the router matches app routes case-blind
    ["/staff", null],
    ["/r", null],
    ["/r/", null],
    ["/r/cafe/extra", null],
    ["/reservations/stand", null],
    ["/s/tok", null],
    ["/%E0%A4%A", null], // malformed escape: not a page
  ])("%s → %s", (p, slug) => {
    expect(bookingSlugOf(p)).toBe(slug);
    expect(isBookingPath(p)).toBe(slug != null);
  });

  it("isBookingPathNow reads the live address and is never true in the native apps", () => {
    at("/cafe-nordlys");
    expect(isBookingPathNow()).toBe(true);
    window.Capacitor = { isNativePlatform: () => true };
    expect(isBookingPathNow()).toBe(false);
  });
});

describe("isQuietGuestPage", () => {
  const loc = (p) => {
    const u = new URL(p, "https://www.bonbox.dk");
    return { pathname: u.pathname, search: u.search };
  };
  it("is on by one switch", () => {
    expect(QUIET_GUEST_PAGE).toBe(true);
  });

  it.each([
    ["/r/cafe?embed=1", true],
    ["/r/cafe", true],
    ["/cafe-nordlys", true],
    ["/cafe-nordlys?lang=en", true],
    ["/r/cafe?booking=1&token=x", true],
    ["/", false],
    ["/dashboard", false],
    ["/dashboard?embed=1", false],
    ["/login", false],
    ["/reservations", false],
    ["/reservations/stand", false],
    ["/s/tok", false],
    ["/staff", false],
  ])("%s → %s", (p, quiet) => {
    expect(isQuietGuestPage(loc(p))).toBe(quiet);
  });

  it("the R4 frame rule is unchanged (isQuietEmbed: the frame only)", () => {
    expect(isQuietEmbed(loc("/r/cafe"))).toBe(false);
    expect(isQuietEmbed(loc("/r/cafe?embed=1"))).toBe(true);
  });

  it("never in the native apps, never without a location", () => {
    window.Capacitor = { isNativePlatform: () => true };
    expect(isQuietGuestPage(loc("/cafe-nordlys"))).toBe(false);
    expect(isQuietGuestPage(loc("/r/cafe?embed=1"))).toBe(true); // the frame is quiet anywhere (R4)
    delete window.Capacitor;
    expect(isQuietGuestPage(undefined)).toBe(false);
  });
});

function AuthProbe({ out }) {
  const a = useAuth();
  out.loading = a.loading;
  out.user = a.user;
  return null;
}
function FlagsProbe({ out }) {
  out.flags = useFeatures();
  return null;
}

describe("the guest's page on its own makes no owner-app call", () => {
  beforeEach(() => {
    get.mockReset();
    localStorage.clear();
    delete window.__bbBootMe;
  });

  it.each(["/cafe-nordlys", "/r/cafe"])("%s: no /auth/me, not loading, no user", async (p) => {
    get.mockImplementation(() => Promise.reject(Object.assign(new Error("401"), { response: { status: 401 } })));
    at(p);
    const out = {};
    render(<AuthProvider><AuthProbe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(out.user).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("the owner app still checks the session", async () => {
    get.mockImplementation(() => Promise.reject(Object.assign(new Error("401"), { response: { status: 401 } })));
    at("/login");
    const out = {};
    render(<AuthProvider><AuthProbe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(get).toHaveBeenCalledWith("/auth/me", { _noRetry: true });
  });

  it("no flags call on the guest's page; the fail-closed defaults, marked loaded", async () => {
    get.mockImplementation(() => Promise.resolve({ data: { bank_connect_enabled: true } }));
    at("/cafe-nordlys");
    const out = {};
    render(<FeaturesProvider><FlagsProbe out={out} /></FeaturesProvider>);
    await waitFor(() => expect(out.flags._loaded).toBe(true));
    expect(get).not.toHaveBeenCalled();
    expect(out.flags.bank_connect_enabled).toBe(false);
  });

  it("the keep-alive ping (App.jsx) asks isQuietGuestPage before its first ping", () => {
    const app = fs.readFileSync(path.join(SRC, "App.jsx"), "utf8");
    const fn = app.slice(app.indexOf("function useKeepAlive()"), app.indexOf("const GOOGLE_CLIENT_ID"));
    expect(fn.indexOf("if (isQuietGuestPage()) return undefined;")).toBeGreaterThan(0);
    expect(fn.indexOf("isQuietGuestPage()")).toBeLessThan(fn.indexOf("ping();"));
  });
});
