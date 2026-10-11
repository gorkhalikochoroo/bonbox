/**
 * /dashboard in dark mode — the owner opens it on a phone at night after close.
 *
 * A measured walk of the dark dashboard (local build, demo-seeded owner, 390
 * and 1440) found three kinds of defect that no build, lint or light-mode
 * screenshot can see:
 *
 *   1. EYEBROWS UNDER AA. The 11px uppercase labels carried
 *      `text-gray-400 dark:text-gray-500`: gray-500 on the dark card is 3.04:1.
 *      The fix is SUBTRACTION — drop the dark override and gray-400 (5.64 on
 *      the card) applies in both themes, so light is byte-identical.
 *   2. WHITE SLABS. The dashboard's own CTAs inverted to
 *      `dark:bg-gray-100` / `dark:bg-white` (luminance ~0.90): the brightest
 *      things on a night screen were the least important ones. Dark uses a
 *      dark SOLID control instead (gray-600, white ink). The same swap on the
 *      shared Button primitive and on the app chrome (bottom-nav "+", AI FAB,
 *      QuickAdd) waits for the owner's nod, so its guards live beside it, in
 *      darkButtonPrimary.test.js and darkChromeFabs.test.js — dropping either
 *      commit drops its own guard and nothing else.
 *   3. INVISIBLE SURFACES. Cards painted the ground, chips painted their own
 *      card, the chart tooltip was DARKER than the card it floats over. That
 *      half is guarded by surfaceLadderAdoption.test.js (LADDER_SWEPT).
 *
 * Source guards strip comments first (same reason as the ladder guard: several
 * files quote the literals they replaced in their WHY-comments).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SURFACE_LADDER_HEX } from "../config/navChrome";
import { createElement as h } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { THEME_COLOR, LIGHT_ONLY_PATHS, themeColorFor, syncThemeColor } from "../utils/themeColor";
import { useThemeColorSync } from "../hooks/useThemeColorSync";

// ── WCAG 2.1 contrast, written out (see chromeTokens.test.js for why) ──
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const h = hex.replace("#", "");
  return (
    0.2126 * channel(parseInt(h.slice(0, 2), 16)) +
    0.7152 * channel(parseInt(h.slice(2, 4), 16)) +
    0.0722 * channel(parseInt(h.slice(4, 6), 16))
  );
};
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

// Tailwind 4 palette stops as the browser resolves them (oklch → sRGB), the
// values the measured audit read back off the page.
const TW = {
  white: "#ffffff",
  gray100: "#f3f4f6",
  gray400: "#99a1af",
  gray500: "#6a7282",
  gray600: "#4a5565",
  gray900: "#101828",
  amber600: "#e17100",
  amber300: "#ffd236",
  amber500: "#fe9a00",
  amber700: "#bb4d00",
  red500: "#fb2c36",
  red600: "#e7000b",
};
const L = SURFACE_LADDER_HEX;

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const code = (rel) =>
  readFileSync(join(SRC, rel), "utf8")
    .replace(/(^|[\s{(])\/\*[\s\S]*?\*\//g, "$1")
    .replace(/^\s*\/\/.*$/gm, "");
/** Every string literal, with `"a " + "b"` concatenation resolved. */
const classStrings = (rel) => {
  const src = code(rel).replace(/"\s*\+\s*"/g, " ");
  return [...src.matchAll(/"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/g)].map((m) =>
    m[0].slice(1, -1).replace(/\s+/g, " ").trim(),
  );
};

/** Files only /dashboard renders (spec Phase A). */
const PHASE_A = [
  "pages/DashboardPage.jsx",
  "components/NeedsYouQueue.jsx",
  "components/AccountantHoursWidget.jsx",
  "components/dashboard/ProfitAnswerCard.jsx",
  "components/dashboard/RevenueTrendChart.jsx",
  "components/dashboard/ComplianceCountdownCard.jsx",
  "components/dashboard/ProfitLossCard.jsx",
  "components/dashboard/FirstRunCollapsedDashboard.jsx",
  "components/dashboard/TodayOnShiftCard.jsx",
  "components/dashboard/GrowthLeverCard.jsx",
  "components/DailyBriefCard.jsx",
  "components/ConnectionsProgressCard.jsx",
  "components/PushOptInPrompt.jsx",
  "components/FinancialCurtain.jsx",
  "components/AnomalyAlertsCard.jsx",
  "components/ExpiryAlertsCard.jsx",
  "components/CloserPromptCard.jsx",
  "components/TrialBanner.jsx",
  "components/SmartDriftBanner.jsx",
  "components/MonthEndBundleBanner.jsx",
  "components/DemoDataCard.jsx",
  "components/DemoActiveBanner.jsx",
  "components/BranchSummaryCard.jsx",
  "components/SmartStaffingCard.jsx",
];
/** The shared primitives that print the dashboard's eyebrows. */
const EYEBROW_PRIMITIVES = ["components/ui/StatCard.jsx", "components/ui/PageHeader.jsx"];
/**
 * Solid controls the dashboard draws itself in dark. The shared Button
 * primitive (B3) and the chrome FABs (B4) are guarded in their own files —
 * darkButtonPrimary.test.js / darkChromeFabs.test.js — so each owner-nod
 * commit carries its guard and can be dropped without touching this one.
 */
const SOLID_CONTROLS = [...PHASE_A];

describe("the dark inks the fix relies on clear their floors", () => {
  it("white on the dark solid control (gray-600) clears AA", () => {
    expect(contrast(TW.white, TW.gray600)).toBeGreaterThanOrEqual(4.5);
  });

  it("gray-400 — the eyebrow once the dark override is gone — clears AA on every rung up to raised", () => {
    for (const rung of ["ground", "subtle", "card", "raised"]) {
      expect(contrast(TW.gray400, L[rung].dark), rung).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the dark amber action is a tint, not a slab: amber-300 ink clears AA, the edge is visible", () => {
    // `bg-amber-500/15` composited over the subtle rung (DemoDataCard's well)
    const over = (fg, a, bg) => {
      const c = (h, i) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
      return "#" + [0, 1, 2].map((i) => Math.round(a * c(fg, i) + (1 - a) * c(bg, i)).toString(16).padStart(2, "0")).join("");
    };
    const tint = over(TW.amber500, 0.15, L.subtle.dark);
    expect(luminance(tint)).toBeLessThan(0.1); // amber-600 solid was 0.28
    expect(luminance(TW.amber600)).toBeGreaterThan(0.25);
    expect(contrast(TW.amber300, tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(TW.amber300, over(TW.amber500, 0.25, L.subtle.dark))).toBeGreaterThanOrEqual(4.5); // hover
    expect(contrast(TW.amber700, tint)).toBeGreaterThanOrEqual(1.3); // the inset edge
    // and white on the light amber-600 fill is the light-mode issue left to the owner
    expect(contrast(TW.white, TW.amber600)).toBeLessThan(4.5);
  });

  it("gray-500 — the value the eyebrows carried — fails AA on the card: the defect as a number", () => {
    expect(contrast(TW.gray500, L.card.dark)).toBeLessThan(4.5);
  });

  it("the dark solid control is no slab (luminance far below 0.4) and still separates from the card", () => {
    expect(luminance(TW.gray600)).toBeLessThan(0.2);
    expect(luminance(TW.gray100)).toBeGreaterThan(0.4);
    expect(contrast(TW.gray600, L.card.dark)).toBeGreaterThan(1.5);
  });

  it("the bell badge: white on red-600 clears AA in dark, red-500 did not", () => {
    expect(contrast(TW.white, TW.red600)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(TW.white, TW.red500)).toBeLessThan(4.5);
  });
});

describe("eyebrows and meta text are not dimmed below AA in dark", () => {
  const files = [...PHASE_A, ...EYEBROW_PRIMITIVES];

  it.each(files)("%s: no dark:text-gray-500 on 11px / 11.5px text", (rel) => {
    const bad = classStrings(rel).filter(
      (s) => /text-\[11(\.5)?px\]/.test(s) && /dark:text-gray-500(?![\w/-])/.test(s),
    );
    expect(bad).toEqual([]);
  });

  it.each(files)("%s: no dark:text-gray-600 / gray-700 anywhere", (rel) => {
    expect(code(rel)).not.toMatch(/dark:(group-hover:|hover:)?text-gray-(600|700)(?![\w/-])/);
  });

  it("the guard can see the shape it bans (positive control)", () => {
    const s = '"text-[11px] font-semibold uppercase " + "text-gray-400 dark:text-gray-500 mb-1"'
      .replace(/"\s*\+\s*"/g, " ");
    expect(/text-\[11(\.5)?px\]/.test(s) && /dark:text-gray-500(?![\w/-])/.test(s)).toBe(true);
  });
});

describe("no near-white slab is a dark-mode fill", () => {
  const SLAB = /dark:(hover:|active:|focus:|focus-visible:)?bg-(white|gray-50|gray-100)(?![\w/.-])/;

  it.each(SOLID_CONTROLS)("%s", (rel) => {
    expect(classStrings(rel).filter((s) => SLAB.test(s))).toEqual([]);
  });
});

describe("amber is never a solid action fill in dark", () => {
  // Amber means attention. In light the two amber CTAs keep their fill (an
  // open owner question); in dark they are a tint + amber edge, so the
  // brightest solid on a fresh night screen is not "try sample data".
  it.each(["components/DemoDataCard.jsx", "components/MonthEndBundleBanner.jsx"])("%s", (rel) => {
    const solid = classStrings(rel).filter((s) => /(^|\s)bg-amber-600(\s|$)/.test(s));
    expect(solid.length).toBeGreaterThan(0);
    for (const s of solid) {
      expect(s).toContain("dark:bg-amber-500/15");
      expect(s).toContain("dark:text-amber-300");
      expect(s).not.toMatch(/dark:(hover:|active:)?bg-amber-(4|5|6)00(?![\w/])/);
    }
  });
});

describe("the chart tooltip floats above its card in dark", () => {
  const src = code("components/dashboard/RevenueTrendChart.jsx");

  it("the label colour is a token, not the light-only literal", () => {
    const label = src.match(/labelStyle=\{\{([^}]*)\}\}/);
    expect(label).not.toBeNull();
    expect(label[1]).not.toContain("#6B7280");
    expect(label[1]).toContain("var(--tt-label)");
  });

  it("light keeps today's exact values; dark reads the raised rung", () => {
    expect(src).toContain("[--tt-label:#6B7280]");
    // Light's shadow is the inline FALLBACK, not a light-side utility: the CSS
    // minifier rewrites `rgba(0,0,0,0.04)` in a utility to `#0000000a`
    // (alpha .039), which is a different shadow. Only dark defines the var.
    expect(src).toContain('boxShadow: "var(--tt-shadow, 0 1px 2px rgba(0,0,0,0.04))"');
    expect(src).not.toMatch(/(^|\s)\[--tt-shadow:/);
    expect(src).toContain("dark:[--tt-shadow:0_4px_12px_rgb(0_0_0/0.4)]");
    expect(src).toContain("dark:[--tt-bg:rgb(var(--surface-raised))]");
    expect(src).not.toContain("dark:[--tt-bg:#111827]");
    expect(contrast(L.raised.dark, L.card.dark)).toBeGreaterThan(1.1);
    expect(luminance(L.raised.dark)).toBeGreaterThan(luminance(L.card.dark));
  });
});

describe("the bell badge", () => {
  it("NotificationCenter's badge deepens to red-600 in dark", () => {
    const badge = classStrings("components/NotificationCenter.jsx").find(
      (s) => /bg-red-500/.test(s) && /min-w-\[18px\]/.test(s),
    );
    expect(badge).toBeDefined();
    expect(badge).toContain("dark:bg-red-600");
  });
});

describe("the language notice never hides a real toast in dark", () => {
  // Both are fixed at the same top offset on a phone. Once the dark notice
  // went opaque it covered the dashboard's own error toast ("Hent PDF
  // failed") completely, because it renders later at the same z-50.
  const zOf = (cls, prefix) => {
    const m = cls.match(new RegExp(`(?:^|\\s)${prefix}z-(\\d+)(?=\\s|$)`));
    return m ? Number(m[1]) : null;
  };
  it("SmartLanguageToast drops below the ToastContainer layer in dark only", () => {
    const notice = classStrings("components/SmartLanguageToast.jsx").find((s) => /role|fixed left-1\/2/.test(s) && /\bfixed\b/.test(s));
    expect(notice).toBeDefined();
    const toasts = classStrings("components/BonBoxPolishKit.jsx").find((s) => /\bfixed right-4\b/.test(s));
    expect(toasts).toBeDefined();
    expect(zOf(notice, "")).toBe(50); // light: unchanged
    expect(zOf(notice, "dark:")).toBeLessThan(zOf(toasts, ""));
  });
});

describe("the browser bar follows the theme", () => {
  it("both the pre-paint script and the hook write theme-color", () => {
    const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const theme = scripts.find((s) => s.includes('localStorage.getItem("theme")'));
    expect(theme).toBeDefined();
    expect(theme).toContain('meta[name="theme-color"]');
    expect(theme).toContain(THEME_COLOR.dark);
    expect(code("hooks/useDarkMode.jsx")).toMatch(/syncThemeColor\(dark\)/);
  });

  it("the static meta stays white — light is untouched", () => {
    const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
    expect(html).toContain('<meta name="theme-color" content="#ffffff" />');
  });

  it("dark is the card rung; light and the staff portal stay white", () => {
    expect(THEME_COLOR.dark).toBe(L.card.dark);
    expect(themeColorFor(true, "/dashboard")).toBe("#1f2937");
    expect(themeColorFor(false, "/dashboard")).toBe("#ffffff");
    expect(themeColorFor(true, "/s/abc123")).toBe("#ffffff");
    expect(themeColorFor(true, "/sales")).toBe("#1f2937"); // "/s" prefix alone is not the portal
  });

  // Pages with no dark styling at all keep the white bar in dark: an owner who
  // signs out in dark mode must not get a #1f2937 bar on the white landing page.
  const LIGHT_ONLY_PAGE = {
    "/": "pages/LandingV2Page.jsx", // PublicOrDashboard renders LandingV2Page for a guest
    "/v2": "pages/LandingV2Page.jsx",
    "/join": "pages/JoinPage.jsx",
    "/stand": "pages/StandPairPage.jsx",
    "/login/magic": "pages/LoginMagicPage.jsx",
    "/login/claim": "pages/ClaimDecisionPage.jsx",
  };

  it("light-only routes keep the white bar in dark; their neighbours do not", () => {
    for (const p of ["/", "/v2", "/join", "/join/", "/stand", "/login/magic", "/login/claim", "/s/tok"]) {
      expect(themeColorFor(true, p), p).toBe("#ffffff");
    }
    // dark-aware neighbours: the paired reservation book, sign-in, guest booking
    for (const p of ["/stand/abc123", "/login", "/register", "/r/cafe", "/cafe-nordlys", "/reservations/stand"]) {
      expect(themeColorFor(true, p), p).toBe("#1f2937");
    }
  });

  it("every LIGHT_ONLY_PATHS page really has no dark styling (the list says what the files say)", () => {
    expect(Object.keys(LIGHT_ONLY_PAGE).sort()).toEqual([...LIGHT_ONLY_PATHS].sort());
    for (const [path, rel] of Object.entries(LIGHT_ONLY_PAGE)) {
      expect(code(rel).match(/\bdark:/g) ?? [], `${path} → ${rel}`).toEqual([]);
    }
  });

  describe("at runtime (jsdom)", () => {
    let meta;
    beforeEach(() => {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      meta.setAttribute("content", "#ffffff");
      document.head.appendChild(meta);
    });
    afterEach(() => {
      meta.remove();
      window.history.pushState({}, "", "/");
      try { localStorage.removeItem("theme"); } catch { /* jsdom storage */ }
      document.documentElement.classList.remove("dark");
    });

    it("syncThemeColor toggles the meta both ways", () => {
      syncThemeColor(true, "/dashboard");
      expect(meta.getAttribute("content")).toBe("#1f2937");
      syncThemeColor(false, "/dashboard");
      expect(meta.getAttribute("content")).toBe("#ffffff");
    });

    const runPrePaint = () => {
      const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .find((s) => s.includes('localStorage.getItem("theme")'));
      new Function(script)();
    };

    it("the pre-paint script sets the dark bar before React mounts", () => {
      localStorage.setItem("theme", "dark");
      window.history.pushState({}, "", "/dashboard");
      runPrePaint();
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(meta.getAttribute("content")).toBe("#1f2937");
    });

    it.each([
      "/", "/v2", "/join", "/stand", "/login/magic", "/login/claim", "/s/tok",
      "/dashboard", "/sales", "/stand/abc123", "/login", "/cafe-nordlys", "/join/",
    ])("the pre-paint script agrees with themeColor.js on %s (dark)", (path) => {
      localStorage.setItem("theme", "dark");
      window.history.pushState({}, "", path);
      runPrePaint();
      expect(meta.getAttribute("content")).toBe(themeColorFor(true, path));
    });

    it("a cold load of the landing page in dark keeps the white bar", () => {
      localStorage.setItem("theme", "dark");
      window.history.pushState({}, "", "/");
      runPrePaint();
      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(meta.getAttribute("content")).toBe("#ffffff");
    });

    it("an in-app hop follows the route: /dashboard dark, / white, back to dark", async () => {
      document.documentElement.classList.add("dark");
      const Probe = () => {
        useThemeColorSync();
        return null;
      };
      const router = createMemoryRouter([{ path: "*", element: h(Probe) }], { initialEntries: ["/dashboard"] });
      render(h(RouterProvider, { router }));
      expect(meta.getAttribute("content")).toBe("#1f2937");
      await act(() => router.navigate("/"));
      expect(meta.getAttribute("content")).toBe("#ffffff");
      await act(() => router.navigate("/sales"));
      expect(meta.getAttribute("content")).toBe("#1f2937");
      document.documentElement.classList.remove("dark");
      await act(() => router.navigate("/dashboard"));
      expect(meta.getAttribute("content")).toBe("#ffffff"); // light: always the static white
      cleanup();
    });

    it("…but not on the staff portal, and never in light", () => {
      localStorage.setItem("theme", "dark");
      window.history.pushState({}, "", "/s/tok");
      runPrePaint();
      expect(meta.getAttribute("content")).toBe("#ffffff");

      localStorage.setItem("theme", "light");
      window.history.pushState({}, "", "/dashboard");
      runPrePaint();
      expect(meta.getAttribute("content")).toBe("#ffffff");
    });
  });
});
