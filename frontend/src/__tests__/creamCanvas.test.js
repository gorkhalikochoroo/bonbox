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
 *   3. the browser bar: paper in light ONLY on a known paper route (the owner
 *      app, the paper auth screens, and the v6 landing "/" + "/v2" since
 *      22 Oct 2026) and white everywhere else — guest
 *      pages incl. the vanity /<slug>, the staff portal, the full-screen pages
 *      that paint their own ground (host stand, /stand, onboarding) — with the
 *      pre-paint deciding the same before the bundle arrives; every static
 *      route in App.jsx declares its side; dark answers exactly as it shipped;
 *   4. the muted text that sits directly on the paper clears AA (gray-500 does
 *      not: 4.39:1), and the primitives that put it there say gray-600.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createElement as h } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { SURFACE_LADDER_HEX, NAV_MUTED_HEX, NAV_SURFACE_HEX, BRAND_ACCENT_HEX } from "../config/navChrome";
import {
  THEME_COLOR,
  LIGHT_ONLY_PATHS,
  PAPER_PATHS,
  PAPER_PREFIXES,
  WHITE_PAGE_CLASS,
  themeColorFor,
  isPaperPath,
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

  // Landing v6 (22 Oct 2026, PORT_PLAN 1.7): the old landing was a white page and index.css painted html + body
  // white under [data-page="landing"]. The v6 landing is paper: those rules (and the old bar's 74 px scroll
  // padding) are gone, and the page's own stylesheet paints html + body paper while it is mounted, in every theme.
  it("the landing page is paper: no white landing rule is left, the v6 stylesheet paints html and body paper", () => {
    expect(CSS).not.toMatch(/\[data-page="landing"\]/);
    const lp6 = read("components/landing/v6/landingV6.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(lp6).toMatch(/:root:has\(\.lp6\)\{[^}]*background:#F6F4EC/);
    expect(lp6).toMatch(/:root:has\(\.lp6\) body\{[^}]*background:#F6F4EC/);
    expect(read("pages/LandingV6Page.jsx")).toMatch(/className="lp6 lp6-boot" data-page="landing"/);
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
    // R13 fix round 3: a mounted restaurant booking page (the guest flag) is its own ground in dark,
    // gray-950 — Safari painted its bars #1f2937 / #111827 next to a #030712 page.
    expect(themeColorFor(true, path, { guest: true })).toBe("#030712");
  });
});

describe("3. the browser bar in light", () => {
  it("is paper on app pages and on the paper auth pages", () => {
    expect(THEME_COLOR.light).toBe(PAPER);
    for (const p of ["/dashboard", "/sales", "/staff/schedule", "/reservations", "/profile", "/profile/", "/login", "/register",
      "/forgot-password", "/verify-email", "/contact", "/staff/schedule/stand", "/workshop/job/42", "/admin/support",
      // the v6 landing and its /v2 alias (22 Oct 2026)
      "/", "/v2", "/v2/"]) {
      expect(themeColorFor(false, p), p).toBe(PAPER);
    }
  });

  it("is white everywhere else — the guest pages, the staff portal and the own-ground full-screen pages", () => {
    for (const p of ["/join", "/join/", "/login/magic", "/login/claim", "/onboarding", "/getting-started",
      "/privacy", "/terms", "/cookies", "/s/tok", "/r/cafe", "/e/jazz", "/e/jazz/checkout", "/t/123", "/g/buy/cafe",
      "/g/tok", "/accept-invite/tok",
      // the host stand (own gray-50 page) through both doors, and the pairing screen (own gradient)
      "/reservations/stand", "/stand", "/stand/abc",
      // the vanity booking page: white from the path alone, before it mounts
      "/cafe-nordlys", "/settings"]) {
      expect(themeColorFor(false, p), p).toBe("#ffffff");
      expect(isPaperPath(p), p).toBe(false);
    }
    // the guest mark still forces white wherever it is raised
    expect(themeColorFor(false, "/dashboard", { guest: true })).toBe("#ffffff");
    // prefixes are prefixes, not substrings or bare stems
    expect(isPaperPath("/workshop/job")).toBe(false);
    expect(isPaperPath("/dashboardx")).toBe(false);
    expect(PAPER_PREFIXES).toEqual(["/workshop/job/"]);
  });

  it("every light-only page keeps the white bar in light too — except the landing, which is paper", () => {
    for (const p of LIGHT_ONLY_PATHS) expect(isWhitePagePath(p), p).toBe(p !== "/" && p !== "/v2");
    expect(LIGHT_ONLY_PATHS).toEqual(expect.arrayContaining(["/", "/v2"])); // still no dark styling
  });

  // The list is the APP side, so a route nobody classified would fall to white
  // — right for a new guest page, a cream-less shell for a new app page. Every
  // static route in App.jsx must therefore declare its side here: inside
  // <Layout /> means paper; everything else is named below.
  it("every static route in App.jsx is classified: Layout routes paper, the rest as declared", () => {
    const app = read("App.jsx");
    // \s+ spans the line break of the multi-line <Route\n path=…> entries too
    const all = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => ({ path: m[1], at: m.index }));
    const layoutSpans = [...app.matchAll(/<(?:ProtectedRoute|SuperAdminRoute)>\s*<Layout \/>/g)].map((m) => [m.index, app.indexOf("\n        </Route>", m.index)]);
    expect(layoutSpans.length).toBe(2); // owner + /admin
    const inLayout = (at) => layoutSpans.some(([a, b]) => at > a && at < b);
    const sample = (path) => path.replace(/:[A-Za-z_]+/g, "x");
    const OUTSIDE = {
      "/": "paper", "/v2": "paper", "/login": "paper", "/login/magic": "white", "/login/claim": "white",
      "/register": "paper", "/forgot-password": "paper", "/verify-email": "paper", "/onboarding": "white",
      "/getting-started": "white", "/contact": "paper", "/privacy": "white", "/terms": "white", "/cookies": "white",
      "/join": "white", "/s/:token": "white", "/s/:slug/:token": "white", "/s/:slug/:name/:token": "white",
      "/accept-invite/:token": "white", "/accept-invite/team/:token": "white", "/e/:slug": "white",
      "/e/:slug/checkout": "white", "/e/:slug/success": "white", "/t/:ticket_id": "white", "/r/:slug": "white",
      "/g/buy/:slug": "white", "/g/:token": "white", "/reservations/stand": "white", "/stand": "white",
      "/stand/:standToken": "white", "/staff/schedule/stand": "paper", "/staff": "paper", "/:slug": "white", "*": "white",
    };
    const outside = all.filter((r) => !inLayout(r.at)).map((r) => r.path);
    expect(outside.sort()).toEqual(Object.keys(OUTSIDE).sort());
    for (const p of outside) {
      if (p === "*") continue;
      expect(isPaperPath(sample(p)) ? "paper" : "white", p).toBe(OUTSIDE[p]);
    }
    const layout = all.filter((r) => inLayout(r.at)).map((r) => r.path);
    expect(layout.length).toBeGreaterThan(60);
    for (const p of layout) expect(isPaperPath(sample(p)), p).toBe(true);
    // and nothing on the list that the router no longer has
    const known = new Set(all.map((r) => r.path));
    for (const p of PAPER_PATHS) expect(known.has(p), p).toBe(true);
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

    it("the vanity booking page is white before it marks itself, and stays white", () => {
      mount("/cafe-nordlys");
      expect(meta.getAttribute("content")).toBe("#ffffff");
      let unmark;
      act(() => { unmark = markGuestSurface(); });
      expect(meta.getAttribute("content")).toBe("#ffffff");
      act(() => unmark());
      expect(meta.getAttribute("content")).toBe("#ffffff");
    });

    it("a guest mark still re-syncs live: white while raised, paper again when it drops", () => {
      mount("/dashboard");
      expect(meta.getAttribute("content")).toBe(PAPER);
      let unmark;
      act(() => { unmark = markGuestSurface(); });
      expect(meta.getAttribute("content")).toBe("#ffffff");
      act(() => unmark());
      expect(meta.getAttribute("content")).toBe(PAPER);
    });

    it("dark: the guest mark gives the booking page's own ground (R13 fix round 3), the app's card rung again when it drops", () => {
      document.documentElement.classList.add("dark");
      mount("/cafe-nordlys");
      expect(meta.getAttribute("content")).toBe("#1f2937");
      let unmark;
      act(() => { unmark = markGuestSurface(); });
      expect(meta.getAttribute("content")).toBe("#030712");
      act(() => unmark());
      expect(meta.getAttribute("content")).toBe("#1f2937");
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

  it("syncThemeColor marks every non-paper route (and a mounted guest page)", () => {
    for (const p of ["/r/cafe", "/privacy", "/s/tok", "/join", "/cafe-nordlys", "/stand", "/stand/abc", "/reservations/stand", "/getting-started"]) {
      syncThemeColor(false, p);
      expect(html().classList.contains(WHITE_PAGE_CLASS), p).toBe(true);
    }
    for (const p of ["/dashboard", "/login", "/staff/schedule/stand", "/", "/v2"]) {
      syncThemeColor(false, p);
      expect(html().classList.contains(WHITE_PAGE_CLASS), p).toBe(false);
    }
    const unmark = markGuestSurface();
    syncThemeColor(false, "/dashboard");
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
    "/", "/v2", "/join", "/join/", "/login/magic", "/login/claim", "/onboarding", "/getting-started", "/privacy", "/terms", "/cookies",
    "/s/tok", "/r/cafe", "/e/jazz", "/t/1", "/g/buy/cafe", "/accept-invite/team/tok",
    "/stand", "/stand/abc", "/reservations/stand", "/cafe-nordlys", "/settings", "/dashboardx", "/workshop/job",
    ...PAPER_PATHS, "/dashboard/", "/workshop/job/42",
  ])("the pre-paint script agrees with themeColor.js on %s (ground + light bar)", (path) => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#ffffff"); // the static value a cold load starts from
    document.head.appendChild(meta);
    try {
      window.history.pushState({}, "", path);
      html().classList.remove(WHITE_PAGE_CLASS);
      runPrePaint();
      expect(html().classList.contains(WHITE_PAGE_CLASS)).toBe(isWhitePagePath(path));
      expect(meta.getAttribute("content")).toBe(themeColorFor(false, path));
    } finally {
      meta.remove();
    }
  });

  it("the pre-paint carries exactly PAPER_PATHS / PAPER_PREFIXES — no extra, no missing", () => {
    const page = readFileSync(join(SRC, "..", "index.html"), "utf8");
    const m = page.match(/var paper = \/\^(.*?)\/\.test\(wp\) \|\| \[([\s\S]*?)\]\.indexOf\(wp\)/);
    expect(m, "pre-paint paper list not found").not.toBeNull();
    expect(JSON.parse(`[${m[2]}]`)).toEqual([...PAPER_PATHS]);
    expect(m[1].replace(/\\\//g, "/")).toBe(PAPER_PREFIXES[0]);
  });

  it("the pre-paint still writes the paper bar when storage is blocked", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#ffffff");
    document.head.appendChild(meta);
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      window.history.pushState({}, "", "/dashboard");
      runPrePaint();
      expect(meta.getAttribute("content")).toBe(PAPER);
      expect(html().classList.contains(WHITE_PAGE_CLASS)).toBe(false);
    } finally {
      if (orig) Object.defineProperty(window, "localStorage", orig);
      meta.remove();
    }
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
    // the empty-state primitive's body sits on the paper on several pages (/staff/hours Tid…)
    ["components/ui/Empty.jsx", '"text-sm text-gray-600 dark:text-gray-400 max-w-sm mx-auto leading-relaxed"'],
    // QA 12 Oct: the rail's "Tilføj funktioner → Indsigt" (Slå til) row, every owner page
    ["components/PillarDiscovery.jsx", "text-[13px] font-medium transition\n              text-gray-600 dark:text-gray-400\n"],
    // QA 12 Oct: /staff/schedule — the SKABELONER label and the "+ Ny" chip sit on the page
    ["pages/StaffSchedulePage.jsx", '"text-[11px] font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mr-0.5"'],
    ["pages/StaffSchedulePage.jsx", "px-2.5 py-1 text-[12px] text-gray-600 dark:text-gray-500 hover:text-gray-700"],
    // the rest of the paper shell: the phone bottom nav's idle tabs and the drawer's ×
    ["components/MobileBottomNav.jsx", ': "text-gray-600 dark:text-gray-400"}`}'],
    ["components/Layout.jsx", '"md:hidden text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-600 text-xl'],
    // page-level states drawn straight on the paper (the sweep's sample)
    ["pages/WeeklyReportPage.jsx", '<div className="p-8 text-center text-gray-600 dark:text-gray-400">{t("noSalesData")}'],
    ["pages/ProfilePage.jsx", '<span className="text-xs text-gray-600 dark:text-gray-400">\n                      {t("smartStaffingFineTune")'],
    ["components/GodkendKo.jsx", '<p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">'],
    ["pages/InsightsPage.jsx", '<p className="text-sm text-gray-600 dark:text-gray-400 mt-1 max-w-xl">'],
  ])("%s keeps its on-paper class: %s", (rel, cls) => {
    expect(read(rel)).toContain(cls);
  });

  // The commonest way muted text lands on the paper: a page's own loading /
  // empty / not-found guard line returned bare, with no card around it. Every owner
  // page inside <Layout /> draws on the paper, so none of those may be a bare
  // gray-400/500 in light (the dark half is free: `dark:text-…` is untouched).
  it("no owner page returns a bare gray-400/500 state line straight onto the paper", () => {
    const pages = readdirSync(join(SRC, "pages")).filter((f) => f.endsWith(".jsx"));
    const app = read("App.jsx");
    // owner pages only: the ones the router mounts inside <Layout /> (paper paths)
    const owner = pages.filter((f) => {
      const name = f.replace(/\.jsx$/, "");
      const route = [...app.matchAll(new RegExp(`<Route\\s+path="([^"]+)"[^>]*element=\\{[^}]*<${name}\\b`, "g"))].map((m) => m[1]);
      return route.some((p) => isPaperPath(p.replace(/:[A-Za-z_]+/g, "x")));
    });
    expect(owner.length).toBeGreaterThan(30);
    // `if (loading) return <div …>` / `if (!x) {\n return <p …>`: the page's own guard lines
    const bare = /\bif \([^\n]*\)\s*\{?\s*return <(?:div|p)\s+className="([^"]*)"/g;
    const offenders = [];
    for (const f of owner) {
      for (const m of read(`pages/${f}`).matchAll(bare)) {
        const toks = m[1].split(/\s+/);
        if (toks.some((t) => t === "text-gray-400" || t === "text-gray-500")) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
