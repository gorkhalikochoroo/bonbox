/**
 * Egenkontrol R1a — the kitchen screen stays out of the door screen, and the
 * paired iPad behaves like a paired device (plan E9, spec §4.8 / §4.13):
 *   • nothing the door screen's build can reach (src/stand) is egenkontrol
 *     code, and the kitchen code imports nothing from src/stand;
 *   • App.jsx registers EgenkontrolPage and KitchenPage as lazyRetry chunks,
 *     /kitchen outside ProtectedRoute, /egenkontrol inside the Layout group;
 *   • on401: /kitchen and /kitchen/<token> never go to /login and never wipe
 *     a token; the stand's rules are unchanged;
 *   • index.html's manifest choice: iOS none (Add to Home bookmarks
 *     /kitchen/<token>), Android /kitchen-device.webmanifest;
 *   • StandPairPage sends a kitchen code's iPad to /kitchen/<token> with a full
 *     page load — and only for a /kitchen/<token>-shaped path.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.isolation
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../services/api", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, default: { ...real.default, post: (...a) => h.post(...a) } };
});
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: "da", setLang: () => {}, t: (k, fb) => (typeof fb === "string" ? fb : k) }),
  LanguageProvider: ({ children }) => children,
}));

const { on401 } = await import("../services/api");
const { standFiles, importsOf } = await import("../../scripts/standBuild.mjs");
const { kitchenTokenFromPath } = await import("../services/kitchenApi");
const StandPairPage = (await import("../pages/StandPairPage")).default;

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const FRONTEND = join(SRC, "..");
const read = (p) => readFileSync(p, "utf8");
const TOKEN = "Kt9xQ_sample-kitchen-token-0123";

describe("the door screen's bundle cannot reach egenkontrol", () => {
  it("no file the stand build reaches is egenkontrol / kitchen code", () => {
    const files = [...standFiles()].map((f) => f.split(`${join("frontend", "src")}`).pop());
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => /egenkontrol|Kitchen|kitchenApi|CheckStatusPill/i.test(f))).toEqual([]);
  });

  it("the kitchen code imports nothing from src/stand", () => {
    const files = [
      ...readdirSync(join(SRC, "components", "egenkontrol")).map((f) => join(SRC, "components", "egenkontrol", f)),
      join(SRC, "pages", "KitchenPage.jsx"),
      join(SRC, "pages", "EgenkontrolPage.jsx"),
      join(SRC, "services", "kitchenApi.js"),
    ];
    for (const f of files) {
      for (const spec of importsOf(read(f))) expect(spec, f).not.toMatch(/(^|\/)stand\//);
    }
  });
});

describe("App.jsx — two lazy routes, the kitchen outside the owner's gates", () => {
  const app = read(join(SRC, "App.jsx"));
  // The protected Layout group (comments elsewhere also say "<Layout />").
  const layoutAt = () => app.search(/<ProtectedRoute>\s*<Layout \/>\s*<\/ProtectedRoute>/);

  it("registers EgenkontrolPage and KitchenPage through lazyRetry", () => {
    expect(app).toMatch(/const EgenkontrolPage = lazyRetry\(\(\) => import\("\.\/pages\/EgenkontrolPage"\)\);/);
    expect(app).toMatch(/const KitchenPage = lazyRetry\(\(\) => import\("\.\/pages\/KitchenPage"\)\);/);
    expect(app).not.toMatch(/import\s+(EgenkontrolPage|KitchenPage)\s+from/);
  });

  it("/kitchen and /kitchen/:kitchenToken sit beside /stand, not in ProtectedRoute", () => {
    const lines = app.split("\n");
    for (const path of ['path="/kitchen"', 'path="/kitchen/:kitchenToken"']) {
      const line = lines.find((l) => l.includes(path));
      expect(line, path).toBeTruthy();
      expect(line).toContain("<KitchenPage />");
      expect(line).not.toMatch(/ProtectedRoute|PillarGate|Layout/);
    }
    const stand = app.indexOf('<Route path="/stand/:standToken"');
    const kitchen = app.indexOf('<Route path="/kitchen"');
    const layout = layoutAt();
    expect(layout).toBeGreaterThan(0);
    expect(stand).toBeGreaterThan(0);
    expect(kitchen).toBeGreaterThan(stand);
    expect(kitchen).toBeLessThan(layout);
  });

  it("/egenkontrol is inside the protected Layout group", () => {
    const layout = layoutAt();
    const route = app.indexOf('<Route path="/egenkontrol" element={<EgenkontrolPage />} />');
    expect(layout).toBeGreaterThan(0);
    expect(route).toBeGreaterThan(layout);
  });
});

describe("on401 — a paired kitchen iPad never goes to /login", () => {
  it("/kitchen and /kitchen/<token>: no redirect, no token wiped", () => {
    for (const p of ["/kitchen", `/kitchen/${TOKEN}`, "/kitchen/abc"]) {
      expect(on401(p, "/billing/entitlements"), p).toEqual({ redirect: false, wipeToken: false });
      expect(on401(p, "/features"), p).toEqual({ redirect: false, wipeToken: false });
    }
  });
  it("the stand's rules are unchanged, and look-alikes are not devices", () => {
    expect(on401("/stand", "/x")).toEqual({ redirect: false, wipeToken: false });
    expect(on401("/stand/abc", "/x")).toEqual({ redirect: false, wipeToken: false });
    expect(on401("/reservations/stand", "/reservations/book").redirect).toBe(true);
    expect(on401("/kitchenette", "/sales")).toEqual({ redirect: true, wipeToken: true });
    expect(on401("/egenkontrol", "/egenkontrol/today")).toEqual({ redirect: true, wipeToken: true });
  });
  it("reads the kitchen token only from /kitchen/<token>", () => {
    expect(kitchenTokenFromPath(`/kitchen/${TOKEN}`)).toBe(TOKEN);
    expect(kitchenTokenFromPath("/kitchen")).toBeNull();
    expect(kitchenTokenFromPath("/kitchen/a b")).toBeNull();
    expect(kitchenTokenFromPath("/stand/abcdefgh12")).toBeNull();
  });
});

/** Runs index.html's manifest selector against a pretend browser (harness from r10.doorStaysOn.units). */
function manifestFor(pathname, { ios }) {
  const html = read(join(FRONTEND, "index.html"));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts.find((s) => s.includes("PWA manifest selection"));
  expect(code, "the manifest selector script").toBeTruthy();
  const links = [];
  const mkEl = () => {
    const attrs = {};
    return {
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      get parentNode() {
        return { removeChild: (el) => links.splice(links.indexOf(el), 1) };
      },
    };
  };
  const doc = {
    querySelector: (sel) => (sel === 'link[rel="manifest"]' ? links[0] || null : null),
    querySelectorAll: () => [],
    createElement: () => mkEl(),
    head: { appendChild: (el) => links.push(el) },
  };
  const nav = ios
    ? { userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", maxTouchPoints: 5 }
    : { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120", maxTouchPoints: 5 };
  new Function("window", "location", "navigator", "document", code)({}, { pathname }, nav, doc);
  return links[0] ? links[0].getAttribute("href") : null;
}

describe("the kitchen iPad's home-screen icon", () => {
  it("iOS: no manifest on /kitchen/<token> or /kitchen (Add to Home bookmarks the address)", () => {
    expect(manifestFor(`/kitchen/${TOKEN}`, { ios: true })).toBeNull();
    expect(manifestFor("/kitchen", { ios: true })).toBeNull();
  });
  it("Android/desktop: the kitchen's own manifest", () => {
    expect(manifestFor(`/kitchen/${TOKEN}`, { ios: false })).toBe("/kitchen-device.webmanifest");
    expect(manifestFor("/kitchen", { ios: false })).toBe("/kitchen-device.webmanifest");
  });
  it("the stand and the owner app are unchanged", () => {
    expect(manifestFor(`/stand/${TOKEN}`, { ios: false })).toBe("/stand-device.webmanifest");
    expect(manifestFor("/stand", { ios: true })).toBeNull();
    expect(manifestFor("/egenkontrol", { ios: false })).toBe("/manifest.json");
    expect(manifestFor("/dashboard", { ios: true })).toBe("/manifest.json");
  });
  it("the manifest starts at /kitchen, carries no token, and is served with the short cache", () => {
    const m = JSON.parse(read(join(FRONTEND, "public", "kitchen-device.webmanifest")));
    expect(m).toMatchObject({ id: "/kitchen", start_url: "/kitchen", scope: "/kitchen", name: "BonBox Egenkontrol", short_name: "Egenkontrol", display: "standalone", orientation: "any", lang: "da" });
    const stand = JSON.parse(read(join(FRONTEND, "public", "stand-device.webmanifest")));
    expect(m.icons).toEqual(stand.icons);
    const vercel = JSON.parse(read(join(FRONTEND, "vercel.json")));
    const rule = vercel.headers.find((x) => x.source.includes("stand\\.webmanifest"));
    expect(rule.source).toContain("kitchen-device\\.webmanifest");
    // No rewrite: /kitchen falls to index.html (only /stand goes to stand.html).
    expect(vercel.rewrites.some((r) => r.source.startsWith("/kitchen"))).toBe(false);
  });
});

describe("StandPairPage — a kitchen code goes to the kitchen screen", () => {
  let realLocation;
  beforeEach(() => {
    h.post.mockReset();
    realLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign: vi.fn() } });
  });
  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  });

  const typeCode = async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/stand", state: { fresh: true } }]}>
        <Routes>
          <Route path="/stand" element={<StandPairPage />} />
          <Route path="/stand/:standToken" element={<p>stand book</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "ABC234" } });
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };

  it("surface 'kitchen' + a /kitchen/<token> path → a full page load there", async () => {
    h.post.mockResolvedValue({ data: { path: `/kitchen/${TOKEN}`, venue: "Café Sol", surface: "kitchen" } });
    await typeCode();
    expect(h.post).toHaveBeenCalledWith("/stand/join", { code: "ABC234" });
    expect(window.location.assign).toHaveBeenCalledWith(`/kitchen/${TOKEN}`);
    expect(screen.queryByText("stand book")).toBeNull();
  });

  it("never follows a path that is not /kitchen/<token>-shaped", async () => {
    h.post.mockResolvedValue({ data: { path: "https://evil.example/kitchen/abcdefgh12", surface: "kitchen" } });
    await typeCode();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("a stand code still opens the book in the app (no page load)", async () => {
    h.post.mockResolvedValue({ data: { path: `/stand/${TOKEN}`, venue: "Café Sol", surface: "stand" } });
    await typeCode();
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(screen.getByText("stand book")).toBeInTheDocument();
  });
});
