/**
 * D (speed push, 15 Oct) — phone start-up.
 *
 *   • index.html starts GET /auth/me while the page is still parsing (before
 *     the app bundle has downloaded), web only, Home only, cookie sessions
 *     only — never in the native app shell (its bearer is not on this
 *     request; taking its 401 would sign the phone out).
 *   • AuthProvider takes that request over only when it is exactly the one it
 *     would send (same URL, web, no stored bearer), else probes as before.
 *   • "bb_had_session" (a hint, not a credential) is set by a good check and
 *     cleared by sign-out and a failed check; App.jsx uses it to fetch the
 *     shell + Home code alongside the check.
 *   • The dictionary preload is written right after <meta charset>, ahead of
 *     the stylesheet (vite.config.js).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(join(SRC, "..", "index.html"), "utf8");
const bootScript = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((x) => x.includes("__bbBootMe"));

function runBoot({ path = "/dashboard", capacitor = false, token = null, apiUrl = "https://api.bonbox.dk/api" } = {}) {
  const fetched = [];
  const fakeFetch = (url, opts) => {
    fetched.push({ url, opts });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "u1" }) });
  };
  const fakeWindow = { Capacitor: capacitor ? {} : undefined };
  const fakeLocation = { pathname: path, protocol: "https:", hostname: "www.bonbox.dk" };
  const store = { getItem: (k) => (k === "token" ? token : null) };
  const src = bootScript.replace("%VITE_API_URL%", apiUrl);
  new Function("window", "location", "localStorage", "fetch", src)(fakeWindow, fakeLocation, store, fakeFetch);
  return { fetched, boot: fakeWindow.__bbBootMe };
}

describe("index.html — the session check starts at parse time", () => {
  it("sits in <head> before the entry script", () => {
    expect(bootScript).toBeTruthy();
    expect(page.indexOf("__bbBootMe")).toBeLessThan(page.indexOf('src="/src/main.jsx"'));
  });

  it.each(["/", "/dashboard", "/dashboard/"])("on %s it sends one credentialed GET /auth/me", async (path) => {
    const { fetched, boot } = runBoot({ path });
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe("https://api.bonbox.dk/api/auth/me");
    expect(fetched[0].opts).toEqual({ credentials: "include" }); // no custom header → no preflight
    expect(boot.url).toBe("https://api.bonbox.dk/api/auth/me");
    await expect(boot.promise).resolves.toEqual({ data: { id: "u1" } });
  });

  it("never in the native app shell", () => {
    expect(runBoot({ capacitor: true }).fetched).toHaveLength(0);
  });

  it("never when an old bearer token is stored (the app sends that one)", () => {
    expect(runBoot({ token: "abc" }).fetched).toHaveLength(0);
  });

  it.each(["/sales", "/login", "/r/cafe", "/s/tok", "/stand/x"])("not on %s", (path) => {
    expect(runBoot({ path }).fetched).toHaveLength(0);
  });

  it("a failed check rejects (401 → the app shows the landing, as before)", async () => {
    const fakeWindow = {};
    const src = bootScript.replace("%VITE_API_URL%", "https://api.bonbox.dk/api");
    new Function("window", "location", "localStorage", "fetch", src)(
      fakeWindow, { pathname: "/", protocol: "https:", hostname: "www.bonbox.dk" },
      { getItem: () => null }, () => Promise.resolve({ ok: false, status: 401 }),
    );
    await expect(fakeWindow.__bbBootMe.promise).rejects.toMatchObject({ response: { status: 401 } });
  });
});

describe("vite.config.js — the dictionary preload goes ahead of the stylesheet", () => {
  it("is inserted right after <meta charset>", () => {
    const cfg = readFileSync(join(SRC, "..", "vite.config.js"), "utf8");
    expect(cfg).toContain("html.replace(charset, charset + script)");
  });
});

// ── AuthProvider ────────────────────────────────────────────────────────
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

function Probe({ out }) {
  const a = useAuth();
  out.user = a.user;
  out.loading = a.loading;
  out.logout = a.logout;
  return null;
}

describe("AuthProvider takes the boot probe over only when it is the same request", () => {
  beforeEach(() => {
    get.mockReset();
    localStorage.clear();
    delete window.Capacitor;
    delete window.__bbBootMe;
  });
  afterEach(() => {
    delete window.Capacitor;
    delete window.__bbBootMe;
  });

  it("same URL, web, no bearer → no second /auth/me; the hint is set", async () => {
    window.__bbBootMe = { url: "https://api.bonbox.dk/api/auth/me", promise: Promise.resolve({ data: { id: "u1", role: "owner" } }) };
    const out = {};
    render(<AuthProvider><Probe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(out.user).toEqual({ id: "u1", role: "owner" });
    expect(get).not.toHaveBeenCalledWith("/auth/me", expect.anything());
    expect(localStorage.getItem("bb_had_session")).toBe("1");
    expect(window.__bbBootMe).toBeNull(); // used once
  });

  it("a different URL → probes itself", async () => {
    window.__bbBootMe = { url: "https://elsewhere.example/api/auth/me", promise: Promise.resolve({ data: { id: "evil" } }) };
    get.mockResolvedValue({ data: { id: "u2" } });
    const out = {};
    render(<AuthProvider><Probe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(out.user).toEqual({ id: "u2" });
    expect(get).toHaveBeenCalledWith("/auth/me", { _noRetry: true });
  });

  it("native shell → never the boot probe (its 401 would sign the phone out)", async () => {
    window.Capacitor = { isNativePlatform: () => true };
    localStorage.setItem("token", "bearer-tok");
    window.__bbBootMe = { url: "https://api.bonbox.dk/api/auth/me", promise: Promise.reject(Object.assign(new Error("401"), { response: { status: 401 } })) };
    window.__bbBootMe.promise.catch(() => {});
    get.mockResolvedValue({ data: { id: "native-owner" } });
    const out = {};
    render(<AuthProvider><Probe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(out.user).toEqual({ id: "native-owner" });
    expect(localStorage.getItem("token")).toBe("bearer-tok");
  });

  it("a failed check clears the hint; sign-out clears it", async () => {
    localStorage.setItem("bb_had_session", "1");
    window.__bbBootMe = { url: "https://api.bonbox.dk/api/auth/me", promise: Promise.reject(new Error("401")) };
    window.__bbBootMe.promise.catch(() => {});
    const out = {};
    const view = render(<AuthProvider><Probe out={out} /></AuthProvider>);
    await waitFor(() => expect(out.loading).toBe(false));
    expect(localStorage.getItem("bb_had_session")).toBeNull();
    view.unmount();

    get.mockResolvedValue({ data: { id: "u3", role: "owner" } });
    const out2 = {};
    render(<AuthProvider><Probe out={out2} /></AuthProvider>);
    await waitFor(() => expect(out2.user).toEqual({ id: "u3", role: "owner" }));
    expect(localStorage.getItem("bb_had_session")).toBe("1");
    await act(async () => { await out2.logout(); });
    expect(localStorage.getItem("bb_had_session")).toBeNull();
  });
});

describe("App.jsx — a returning owner's Home code starts with the check", () => {
  it("preloads the shell and Home only with the hint, only on / or /dashboard, never in the Vagtplan app", () => {
    const app = readFileSync(join(SRC, "App.jsx"), "utf8");
    const block = app.slice(app.indexOf('if (import.meta.env.VITE_APP_MODE !== "scheduler") {'));
    expect(block).toContain('window.localStorage.getItem("bb_had_session") === "1"');
    expect(block).toContain("/^\\/(dashboard\\/?)?$/.test(window.location.pathname)");
    expect(block).toContain('import("./components/Layout").catch(() => {});');
    expect(block).toContain('import("./pages/DashboardPage").catch(() => {});');
  });
});
