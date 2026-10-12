/**
 * CREAM CANVAS (12 Oct 2026) — the owner asked for the cream of /login and
 * /register "inside BonBox as well". In LIGHT the page ground and the shell
 * (sidebar rail, phone top bar, bottom nav) are BonBox paper #F6F4EC; cards,
 * sheets, inputs and modals stay white and lift off it. DARK is untouched —
 * proven by a pixel diff on the running app, pinned here at the token level.
 *
 * What this file pins:
 *   1. the light ground token IS bb-paper, with ONE writer (no venue-theme
 *      override can paint the old near-white back over it);
 *   2. dark is unchanged: ground #111827, shell = the card rung, and the paper
 *      bar repaint can never match in dark;
 *   3. the browser bar: paper in light on app pages, white on pages that paint
 *      their own white page (landing, guest pages, the staff portal…), and the
 *      dark answers exactly what shipped before;
 *   4. the muted text that sits directly on the paper clears AA (gray-500 does
 *      not: 4.39:1), and the primitives that put it there say gray-600.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createElement as h } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { SURFACE_LADDER_HEX, NAV_MUTED_HEX, NAV_SURFACE_HEX, BRAND_ACCENT_HEX } from "../config/navChrome";
import {
  THEME_COLOR,
  LIGHT_ONLY_PATHS,
  WHITE_PAGE_PATHS,
  WHITE_PAGE_CLASS,
  themeColorFor,
  isWhitePagePath,
  syncThemeColor,
} from "../utils/themeColor";
import { useThemeColorSync } from "../hooks/useThemeColorSync";
import { markGuestSurface } from "../lib/guestSurface";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(SRC, rel), "utf8");
const CSS = read("index.css").replace(/\/\*[\s\S]*?\*\//g, "");

const PAPER = "#f6f4ec";

function tokenIn(selector, name) {
  const blocks = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    (m) => m[1].trim().split("\n").pop().trim() === selector,
  );
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const hit = blocks[i][2].match(new RegExp(`${name}\\s*:\\s*([0-9]+)\\s+([0-9]+)\\s+([0-9]+)\\s*;`));
    if (hit) return "#" + [1, 2, 3].map((n) => Number(hit[n]).toString(16).padStart(2, "0")).join("");
  }
  return null;
}

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("1. the light ground is BonBox paper", () => {
  it("--surface-ground and --surface-shell are #f6f4ec in light — the login cream", () => {
    expect(tokenIn(":root", "--surface-ground")).toBe(PAPER);
    expect(tokenIn(":root", "--surface-shell")).toBe(PAPER);
    expect(SURFACE_LADDER_HEX.ground.light).toBe(PAPER);
    expect(SURFACE_LADDER_HEX.shell.light).toBe(PAPER);
    // the same colour AuthShell paints (--color-bb-paper in @theme)
    expect(read("index.css")).toMatch(/--color-bb-paper:\s*#F6F4EC;/);
  });

  it("has ONE light writer: no venue theme overrides the ground any more", () => {
    // `:root[data-theme="calm"] { --surface-ground: … }` is (0,2,0) and beat
    // `:root` — calm is the default theme, so it would have painted the old
    // #f9fbfd straight back over the paper for nearly every venue.
    expect(CSS).not.toMatch(/\[data-theme="[a-z]+"\]\s*\{[^}]*--surface-ground/);
  });

  it("cards stay white — the paper is the page, not the sheet", () => {
    expect(tokenIn(":root", "--surface-card")).toBe("#ffffff");
    expect(tokenIn(":root", "--surface-raised")).toBe("#ffffff");
    expect(contrast("#ffffff", PAPER)).toBeGreaterThan(contrast("#ffffff", "#f9fbfd")); // 1.10 > 1.04
  });

  it("the landing page keeps its white html as well as its white body", () => {
    expect(CSS).toMatch(/:root:not\(\.dark\) body:has\(\[data-page="landing"\]\)\s*\{\s*background-color:\s*#fff;/);
    expect(CSS).toMatch(/:root:not\(\.dark\):has\(\[data-page="landing"\]\)\s*\{\s*background-color:\s*#fff;/);
  });
});

describe("2. dark is unchanged", () => {
  it("ground #111827, shell = the card rung #1f2937", () => {
    expect(tokenIn(":root.dark", "--surface-ground")).toBe("#111827");
    expect(tokenIn(":root.dark", "--surface-card")).toBe("#1f2937");
    expect(tokenIn(":root.dark", "--surface-shell")).toBe("#1f2937");
    expect(SURFACE_LADDER_HEX.shell.dark).toBe(SURFACE_LADDER_HEX.card.dark);
  });

  it("the paper bar repaint is light-only by selector", () => {
    const rules = [...CSS.matchAll(/([^{}]*\.bar-paper[^{}]*)\{/g)].map((m) => m[1].trim());
    expect(rules.length).toBeGreaterThanOrEqual(2); // the rule + its no-blur fallback
    for (const sel of rules) expect(sel).toMatch(/^:root:not\(\.dark\) \.bar-paper$/);
  });

  it("the phone bars wear it and the rail reads the shell token", () => {
    const layout = read("components/Layout.jsx");
    expect(layout).toMatch(/fixed top-0 left-0 right-0 z-30 glass bar-paper /);
    expect(layout).toMatch(/w-56 bg-\[rgb\(var\(--surface-shell\)\)\] border-r/);
    expect(read("components/MobileBottomNav.jsx")).toMatch(/fixed bottom-0 left-0 right-0 glass bar-paper/);
    // the active row: white on the paper rail, the old gray-700/60 in dark
    expect(layout).toMatch(/const activeClass = `bg-white dark:bg-gray-700\/60 /);
  });

  // The theme-color answers for dark, frozen as they shipped before the cream.
  it.each([
    ["/dashboard", "#1f2937"], ["/sales", "#1f2937"], ["/login", "#1f2937"], ["/register", "#1f2937"],
    ["/r/cafe", "#1f2937"], ["/cafe-nordlys", "#1f2937"], ["/stand/abc", "#1f2937"],
    ["/", "#ffffff"], ["/v2", "#ffffff"], ["/join", "#ffffff"], ["/stand", "#ffffff"],
    ["/login/magic", "#ffffff"], ["/login/claim", "#ffffff"], ["/s/tok", "#ffffff"],
  ])("dark theme-color on %s is still %s", (path, want) => {
    expect(themeColorFor(true, path)).toBe(want);
    expect(themeColorFor(true, path, { guest: true })).toBe(want); // the guest flag is a light-only input
  });
});

describe("3. the browser bar in light", () => {
  it("is paper on app pages and on the paper auth pages", () => {
    expect(THEME_COLOR.light).toBe(PAPER);
    for (const p of ["/dashboard", "/sales", "/staff/schedule", "/reservations", "/profile", "/login", "/register", "/stand", "/stand/abc"]) {
      expect(themeColorFor(false, p), p).toBe(PAPER);
    }
  });

  it("stays white on pages that paint their own white page", () => {
    for (const p of ["/", "/v2", "/join", "/join/", "/login/magic", "/login/claim", "/onboarding", "/privacy", "/terms", "/cookies",
      "/s/tok", "/r/cafe", "/e/jazz", "/e/jazz/checkout", "/t/123", "/g/buy/cafe", "/g/tok", "/accept-invite/tok"]) {
      expect(themeColorFor(false, p), p).toBe("#ffffff");
    }
    // the vanity booking page /<slug> is only known once it has mounted
    expect(themeColorFor(false, "/cafe-nordlys")).toBe(PAPER);
    expect(themeColorFor(false, "/cafe-nordlys", { guest: true })).toBe("#ffffff");
  });

  it("every light-only page except the paper /stand pairing screen keeps the white bar", () => {
    for (const p of LIGHT_ONLY_PATHS) {
      expect(isWhitePagePath(p), p).toBe(p !== "/stand");
    }
    expect(WHITE_PAGE_PATHS).not.toContain("/stand");
  });

  describe("at runtime (jsdom)", () => {
    let meta;
    const mount = (path) => {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      meta.setAttribute("content", "#ffffff");
      document.head.appendChild(meta);
      const Probe = () => { useThemeColorSync(); return null; };
      const router = createMemoryRouter([{ path: "*", element: h(Probe) }], { initialEntries: [path] });
      render(h(RouterProvider, { router }));
      return router;
    };
    afterEach(() => {
      cleanup();
      meta?.remove();
      document.documentElement.classList.remove("dark");
    });

    it("a guest page that marks itself turns the bar white, and back to paper when it leaves", async () => {
      mount("/cafe-nordlys");
      expect(meta.getAttribute("content")).toBe(PAPER);
      let unmark;
      act(() => { unmark = markGuestSurface(); });
      expect(meta.getAttribute("content")).toBe("#ffffff");
      act(() => unmark());
      expect(meta.getAttribute("content")).toBe(PAPER);
    });

    it("dark ignores the guest mark, exactly as before", () => {
      document.documentElement.classList.add("dark");
      mount("/cafe-nordlys");
      expect(meta.getAttribute("content")).toBe("#1f2937");
      let unmark;
      act(() => { unmark = markGuestSurface(); });
      expect(meta.getAttribute("content")).toBe("#1f2937");
      act(() => unmark());
    });
  });
});

describe("3b. white pages keep a white html/body in light (safe-area + overscroll strips)", () => {
  const html = () => document.documentElement;
  afterEach(() => {
    html().classList.remove(WHITE_PAGE_CLASS, "dark");
    window.history.pushState({}, "", "/");
    try { localStorage.removeItem("theme"); } catch { /* jsdom storage */ }
  });

  it("the CSS paints html + body white only for the class, and only in light", () => {
    expect(CSS).toMatch(/:root\.bb-page-white:not\(\.dark\),\s*:root\.bb-page-white:not\(\.dark\) body\s*\{\s*background-color:\s*#fff;/);
    expect(WHITE_PAGE_CLASS).toBe("bb-page-white");
  });

  it("syncThemeColor marks exactly the white-bar routes (and a mounted guest page)", () => {
    for (const p of ["/r/cafe", "/privacy", "/s/tok", "/join", "/"]) {
      syncThemeColor(false, p);
      expect(html().classList.contains(WHITE_PAGE_CLASS), p).toBe(true);
    }
    for (const p of ["/dashboard", "/login", "/stand", "/cafe-nordlys"]) {
      syncThemeColor(false, p);
      expect(html().classList.contains(WHITE_PAGE_CLASS), p).toBe(false);
    }
    const unmark = markGuestSurface();
    syncThemeColor(false, "/cafe-nordlys");
    expect(html().classList.contains(WHITE_PAGE_CLASS)).toBe(true);
    unmark();
  });

  const runPrePaint = () => {
    const page = readFileSync(join(SRC, "..", "index.html"), "utf8");
    const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .find((x) => x.includes('localStorage.getItem("theme")'));
    new Function(script)();
  };

  it.each([
    "/", "/v2", "/join", "/join/", "/login/magic", "/login/claim", "/onboarding", "/privacy", "/terms", "/cookies",
    "/s/tok", "/r/cafe", "/e/jazz", "/t/1", "/g/buy/cafe", "/accept-invite/team/tok",
    "/dashboard", "/sales", "/login", "/register", "/stand", "/stand/abc", "/cafe-nordlys", "/settings",
  ])("the pre-paint script agrees with themeColor.js on %s", (path) => {
    window.history.pushState({}, "", path);
    html().classList.remove(WHITE_PAGE_CLASS);
    runPrePaint();
    expect(html().classList.contains(WHITE_PAGE_CLASS)).toBe(isWhitePagePath(path));
  });
});

describe("4. text that sits directly on the paper", () => {
  it("gray-500 fails AA on paper; gray-600 passes — the reason for the swaps", () => {
    expect(contrast("#6a7282", PAPER)).toBeLessThan(4.5); // tailwind v4 gray-500, 4.39:1
    expect(contrast("#4a5565", PAPER)).toBeGreaterThanOrEqual(4.5); // gray-600, 6.86:1
  });

  it("the rail's muted tier and its accent clear their floors on the paper rail", () => {
    expect(NAV_SURFACE_HEX.light).toBe(PAPER);
    expect(contrast(NAV_MUTED_HEX.light, NAV_SURFACE_HEX.light)).toBeGreaterThanOrEqual(4.5);
    // the collapsed-group dot and the focus ring sit on the rail itself
    expect(contrast(BRAND_ACCENT_HEX.light, SURFACE_LADDER_HEX.shell.light)).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["components/ui/PageHeader.jsx", 'uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-1.5"'],
    ["components/ui/PageHeader.jsx", '"text-[14px] text-gray-600 dark:text-gray-400 mt-1 leading-relaxed"'],
    ["components/ui/FilterBar.jsx", '"text-[11px] font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400"'],
    ["components/ui/TabPills.jsx", 'off: "max-sm:text-gray-600 max-sm:dark:text-gray-400"'],
    ["components/ui/TabPills.jsx", '"bg-gray-900/[0.06] text-gray-700 hover:bg-gray-900/10 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"'],
    ["components/Layout.jsx", "text-xs text-red-700 dark:text-red-400 hover:bg-red-50"],
  ])("%s keeps its on-paper class: %s", (rel, cls) => {
    expect(read(rel)).toContain(cls);
  });
});
