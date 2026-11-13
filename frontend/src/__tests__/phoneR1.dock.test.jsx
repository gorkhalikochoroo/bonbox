/**
 * Phone R1 (PHONE-OWNER-PLAN v3 §4–§5, approved 12 Nov 2026) — the owner
 * shell's feel base and the floating dock.
 *
 *   • The dock shows the same five slots as getTabsForType (café, salon,
 *     shop), with one sliding indicator and the same amber dots.
 *   • Tapping the tab you are on scrolls to the top and does not navigate.
 *   • Tabs are silent: no haptic on any tab.
 *   • Personal mode keeps its own bar (centre "+").
 *   • The press controller is installed ONCE, by the owner Layout (I dag no
 *     longer installs a second copy); html carries data-owner-shell while
 *     the Layout is mounted, and the :active mute + token scope hang on it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

const feelSpy = vi.hoisted(() => ({ done: vi.fn(), soft: vi.fn(), warn: vi.fn(), fail: vi.fn(), tick: vi.fn(), warm: vi.fn() }));
vi.mock("../components/staff/feel", () => ({ feel: feelSpy, resetFeelForTests: () => {}, OUTCOME_GAP_MS: 1500, WARM_MS: 2000 }));
const oldHaptic = vi.hoisted(() => ({ light: vi.fn(), medium: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("../utils/haptics", () => ({ haptic: oldHaptic }));

const auth = vi.hoisted(() => ({ user: { id: "u1", business_type: "cafe", role: "owner", currency: "DKK" } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: auth.user, logout: vi.fn(), loading: false }) }));
vi.mock("../components/BranchSelector", () => ({
  default: () => null,
  useBranch: () => ({ branchType: auth.user.business_type, businessTypes: [auth.user.business_type] }),
}));
const pill = vi.hoisted(() => ({ hidden: new Set() }));
vi.mock("../hooks/usePillars", () => ({ usePillars: () => ({ hiddenPillars: pill.hidden, isReady: true, setPillarHidden: vi.fn() }) }));
const act8n = vi.hoisted(() => ({ known: new Set(["reservations", "staff", "inventory"]) }));
vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({
    knownActivatedPillars: act8n.known,
    usedSurfaces: new Set(),
    activatedPillars: new Set(["inventory", "reservations", "events", "staff"]),
    isActivated: () => true,
    usageDormantPillars: new Set(),
    usageKnownDormant: new Set(),
    isInScope: false,
    activationEnabled: false,
    isReady: true,
    refresh: vi.fn(),
  }),
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da } = await import("../i18n/da");
  return { useLanguage: () => ({ t: (k, fb) => da[k] ?? (typeof fb === "string" ? fb : k), lang: "da" }) };
});

const { default: MobileBottomNav } = await import("../components/MobileBottomNav");
const { getTabsForType } = await import("../config/bottomNavTabs");
const { da } = await import("../i18n/da");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

/* The current place, read from the DOM (never a closure variable — the
   React Compiler lint rules refuse a component that writes outside itself). */
function Where() {
  const loc = useLocation();
  return <span data-testid="where" data-path={loc.pathname} data-search={loc.search} data-key={loc.key} hidden />;
}
const whereEl = () => document.querySelector('[data-testid="where"]');
const where = {
  get pathname() { return whereEl().getAttribute("data-path"); },
  get search() { return whereEl().getAttribute("data-search"); },
  get key() { return whereEl().getAttribute("data-key"); },
};
function renderDock(at = "/dashboard", props = {}) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes><Route path="*" element={<><MobileBottomNav {...props} /><Where /></>} /></Routes>
    </MemoryRouter>,
  );
}
const dock = () => document.querySelector("nav[data-owner-dock]");
const hrefs = () => [...dock().querySelectorAll("[data-dock-tab]")].map((a) => a.getAttribute("href"));
const ind = () => dock().querySelector("[data-dock-indicator]");

beforeEach(() => {
  auth.user = { id: "u1", business_type: "cafe", role: "owner", currency: "DKK" };
  pill.hidden = new Set();
  act8n.known = new Set(["reservations", "staff", "inventory"]);
  vi.clearAllMocks();
  window.scrollTo = () => {};   // jsdom has none
});
afterEach(() => cleanup());

describe("the floating dock: the same five slots as getTabsForType", () => {
  it.each([
    ["cafe", "a café"],
    ["salon", "a salon"],
    ["clothing", "a shop"],
  ])("%s (%s)", (type) => {
    auth.user = { ...auth.user, business_type: type };
    renderDock();
    const want = getTabsForType(type, pill.hidden, {
      usedPillars: act8n.known, usedSurfaces: new Set(), enabledModules: null,
    }).map((tb) => tb.to);
    expect(want).toHaveLength(5);
    expect(hrefs()).toEqual(want);
    // The grid has one column per slot, and the indicator knows how many.
    expect(dock().style.getPropertyValue("--n")).toBe("5");
  });

  it("with the staff pillar off, the dock follows the same fallback (no Vagtplan)", () => {
    pill.hidden = new Set(["staff"]);
    renderDock();
    expect(hrefs()).toEqual(getTabsForType("cafe", pill.hidden, { usedPillars: act8n.known, usedSurfaces: new Set(), enabledModules: null }).map((tb) => tb.to));
    expect(hrefs()).not.toContain("/staff/schedule");
  });

  it("a salon's tab reads Tidsbestilling, and the names are the locked nouns", () => {
    auth.user = { ...auth.user, business_type: "salon" };
    renderDock();
    const labels = [...dock().querySelectorAll(".ow-dock-label")].map((s) => s.textContent);
    expect(labels).toContain(da.navAppointments);
    expect(labels).toContain(da.navToday);   // Kasserapport
    expect(labels[0]).toBe(da.navTodayHome); // I dag
  });
});

describe("one sliding indicator", () => {
  it("is ONE element, a column wide, moved by --i to the active tab", () => {
    renderDock("/reservations");
    expect(dock().querySelectorAll("[data-dock-indicator]")).toHaveLength(1);
    expect(dock().querySelectorAll(".ow-dock-pill")).toHaveLength(1);
    expect(ind().style.getPropertyValue("--i")).toBe("1");
    const active = dock().querySelector('[aria-current="page"]');
    expect(active.getAttribute("href")).toBe("/reservations");
    // Exactly one tab is current.
    expect(dock().querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("slides when the page changes, without re-mounting", () => {
    renderDock("/dashboard");
    const before = ind();
    expect(before.style.getPropertyValue("--i")).toBe("0");
    fireEvent.click(dock().querySelector('[data-dock-tab="/daily-close"]'));
    expect(where.pathname).toBe("/daily-close");
    expect(ind()).toBe(before);
    expect(ind().style.getPropertyValue("--i")).toBe("3");
  });

  it("follows the TAP at once, also while the next page is still loading (a lazy page that has not arrived)", async () => {
    const { lazy, Suspense } = await import("react");
    const Never = lazy(() => new Promise(() => {}));
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <MobileBottomNav />
        <Suspense fallback={<span data-loading="" />}>
          <Routes>
            <Route path="/daily-close" element={<Never />} />
            <Route path="*" element={<span />} />
          </Routes>
        </Suspense>
      </MemoryRouter>,
    );
    expect(ind().style.getPropertyValue("--i")).toBe("0");
    fireEvent.click(dock().querySelector('[data-dock-tab="/daily-close"]'));
    expect(ind().style.getPropertyValue("--i")).toBe("3");
    expect(dock().querySelector('[aria-current="page"]').getAttribute("href")).toBe("/daily-close");
  });

  it("a page with no tab of its own lights Mere", () => {
    renderDock("/expenses");
    expect(ind().style.getPropertyValue("--i")).toBe("4");
    expect(dock().querySelector('[aria-current="page"]').getAttribute("href")).toBe("/more");
  });

  it("the amber dots stay: one per actionable route", () => {
    renderDock("/dashboard", { badges: { "/reservations": { count: 2, tone: "amber" } } });
    const dots = dock().querySelectorAll("[data-dock-dot]");
    expect(dots).toHaveLength(1);
    expect(dots[0].closest("[data-dock-tab]").getAttribute("data-dock-tab")).toBe("/reservations");
  });

  it("the CSS: Vagtplan's indicator (translateX by --i on the soft spring, will-change on the pill only), no blur, no loop", () => {
    const css = read("components/owner/ownerShell.css");
    expect(css).toMatch(/\.ow-dock-ind \{[^}]*transform: translateX\(calc\(var\(--i, 0\) \* 100%\)\);/);
    expect(css).toMatch(/\.ow-dock-ind \{[^}]*transition: transform var\(--td-dur-spring\) var\(--td-spring-soft\)/);
    expect(css.match(/will-change/g)).toHaveLength(1);
    expect(css).not.toMatch(/backdrop-filter|blur\(/);
    expect(css).not.toMatch(/\binfinite\b|@keyframes/);
    // Reduce Motion: no travel and no scale; the dim (opacity) stays.
    const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toMatch(/\.ow-dock-ind \{ transition: opacity/);
    expect(reduce).toMatch(/scale: none; opacity: \.72;/);
  });
});

describe("the dock is for phones only, and reads in both themes", () => {
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "");
  it("hidden from Tailwind's md (48rem) up in its own CSS: the class md:hidden alone loses to the unlayered display: grid", () => {
    const css = strip(read("components/owner/ownerShell.css"));
    expect(css).toMatch(/\.ow-dock \{[^}]*display: grid;/);
    expect(css).toMatch(/@media \(min-width: 48rem\) \{\s*\.ow-dock \{ display: none; \}\s*\}/);
    // The hide comes after the rule it overrides.
    expect(css.indexOf("@media (min-width: 48rem)")).toBeGreaterThan(css.search(/\.ow-dock \{[^}]*display: grid;/));
  });

  it("dark: the current tab is ink, not the inactive grey (the dark rule used to outrank [aria-current])", () => {
    const css = strip(read("components/owner/ownerShell.css"));
    expect(css).toMatch(/html\.dark \.ow-dock-item \{ color: var\(--td-muted\); \}/);
    expect(css).toMatch(/html\.dark \.ow-dock-item\[aria-current="page"\] \{ color: var\(--td-ink\); \}/);
    // It comes after the dark rule (same specificity would also need order).
    expect(css.indexOf('html.dark .ow-dock-item[aria-current="page"]')).toBeGreaterThan(css.indexOf("html.dark .ow-dock-item { color"));
  });

  it("solid, the rail's own colour in both themes: no page text ghosting through a 97 % dock with no blur (fix round, 13 Nov)", () => {
    const css = strip(read("components/owner/ownerShell.css"));
    expect(css).toMatch(/\.ow-dock \{[^}]*--ow-dock-bg: var\(--td-rail-bg, #EFECE5\);[^}]*background: var\(--ow-dock-bg\);/);
    // One definition: dark flips through the token (today.css), not a second see-through colour.
    expect(css.match(/--ow-dock-bg:/g)).toHaveLength(1);
    expect(css).not.toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.9\d*\)/);
    const today = strip(read("components/today/today.css"));
    expect(today).toMatch(/html\[data-owner-shell\], \.td-page, \.td-rail \{[^}]*--td-rail-bg: #EFECE5;/);
    expect(today).toMatch(/html\.dark\[data-owner-shell\], \.dark \.td-page, \.dark \.td-rail \{[^}]*--td-rail-bg: #1F2937;/);
  });

  it("the top bar's ☰: no focus ring left standing after a finger closes the menu; a keyboard keeps it", () => {
    const css = strip(read("components/owner/ownerShell.css"));
    expect(css).toContain('html[data-modality="touch"] .ow-menu-btn:focus-visible { box-shadow: none; }');
    const layout = read("components/Layout.jsx");
    expect(layout).toMatch(/ref=\{menuButtonRef\}[\s\S]{0,400}className="ow-menu-btn [^"]*focus-visible:ring-2/);
  });

  it("below 390 px the dock gives its names width (8 px edges, 3 px inside, no label padding), the indicator keeping its column", () => {
    const css = strip(read("components/owner/ownerShell.css"));
    const narrow = css.slice(css.indexOf("@media (max-width: 389.98px)"));
    expect(narrow).toMatch(/^@media \(max-width: 389\.98px\) \{\s*\.ow-dock \{\s*left: max\(8px, env\(safe-area-inset-left, 0px\)\);\s*right: max\(8px, env\(safe-area-inset-right, 0px\)\);\s*padding: 0 3px;\s*\}/);
    expect(narrow).toMatch(/\.ow-dock-ind \{ left: 3px; width: calc\(\(100% - 6px\) \/ var\(--n, 5\)\); \}/);
    expect(narrow).toMatch(/\.ow-dock-label \{ padding: 0; \}/);
  });
});

describe("re-tap and silence", () => {
  it("tapping the tab you are on scrolls to the top and stays", () => {
    const scrollTo = vi.fn();
    const was = window.scrollTo;
    window.scrollTo = scrollTo;
    try {
      renderDock("/dashboard");
      const key = where.key;
      fireEvent.click(dock().querySelector('[data-dock-tab="/dashboard"]'));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo.mock.calls[0][0]).toMatchObject({ top: 0 });
      expect(where.pathname).toBe("/dashboard");
      expect(where.key).toBe(key);
      // Another tab navigates, and does not scroll.
      fireEvent.click(dock().querySelector('[data-dock-tab="/reservations"]'));
      expect(where.pathname).toBe("/reservations");
      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      window.scrollTo = was;
    }
  });

  it.each([
    [true, "instant"],
    [false, "smooth"],
  ])("Reduce Motion %s: the re-tap scroll is %s (never \"auto\", which follows html's smooth scroll-behavior)", (reduce, behavior) => {
    const scrollTo = vi.fn();
    const was = window.scrollTo;
    const wasMM = window.matchMedia;
    window.scrollTo = scrollTo;
    window.matchMedia = (q) => ({ matches: reduce && /prefers-reduced-motion: reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    try {
      renderDock("/dashboard");
      fireEvent.click(dock().querySelector('[data-dock-tab="/dashboard"]'));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo.mock.calls[0][0]).toEqual({ top: 0, behavior });
    } finally {
      window.scrollTo = was;
      window.matchMedia = wasMM;
    }
  });

  it("an old WebView that refuses the options object still goes to the top", () => {
    const calls = [];
    const was = window.scrollTo;
    window.scrollTo = (...a) => { calls.push(a); if (typeof a[0] === "object") throw new TypeError("bad behavior"); };
    try {
      renderDock("/dashboard");
      fireEvent.click(dock().querySelector('[data-dock-tab="/dashboard"]'));
      expect(calls.at(-1)).toEqual([0, 0]);
      expect(where.pathname).toBe("/dashboard");
    } finally {
      window.scrollTo = was;
    }
  });

  it("on a page under the tab, the tab goes to its own page (not a scroll)", () => {
    const scrollTo = vi.fn();
    const was = window.scrollTo;
    window.scrollTo = scrollTo;
    try {
      renderDock("/staff/schedule/print");
      fireEvent.click(dock().querySelector('[data-dock-tab="/staff/schedule"]'));
      expect(where.pathname).toBe("/staff/schedule");
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      window.scrollTo = was;
    }
  });

  it("no haptic on any tab — a tap, a press, a re-tap", () => {
    renderDock("/dashboard");
    for (const a of dock().querySelectorAll("[data-dock-tab]")) {
      a.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { pointerType: "touch", isPrimary: true }));
      fireEvent.click(a);
    }
    fireEvent.click(dock().querySelector('[data-dock-tab="/more"]'));
    for (const f of Object.values(feelSpy)) expect(f).not.toHaveBeenCalled();
    for (const f of Object.values(oldHaptic)) expect(f).not.toHaveBeenCalled();
    expect(read("components/MobileBottomNav.jsx")).not.toMatch(/feel\.|haptic\./);
  });
});

describe("personal mode keeps its own bar", () => {
  it("no dock; the centre + is still there", () => {
    auth.user = { id: "p1", business_type: "personal", role: "owner", currency: "DKK" };
    renderDock("/personal");
    expect(dock()).toBeNull();
    const bar = document.querySelector('nav[aria-label="Primær"]');
    expect(bar).not.toBeNull();
    expect(bar.querySelector("button")).not.toBeNull();
  });
});

describe("the press: installed once, by the owner Layout (5.2)", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const callsIn = (rel) => (strip(read(rel)).match(/installPressFeel\(\)/g) || []).length;

  it("Layout installs it; I dag does not install a second copy; the staff portal keeps its own", () => {
    expect(callsIn("components/Layout.jsx")).toBe(1);
    expect(strip(read("components/Layout.jsx"))).toContain("useEffect(() => installPressFeel(), []);");
    expect(callsIn("components/today/TodayDashboard.jsx")).toBe(0);
    expect(read("components/today/TodayDashboard.jsx")).not.toContain('from "../staff/pressFeel"');
    expect(callsIn("pages/StaffPortalPage.jsx")).toBe(1);
    // Nowhere else in the app.
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return d.name === "__tests__" ? [] : walk(p);
      return /\.(jsx?|mjs)$/.test(d.name) ? [p] : [];
    });
    const callers = walk(SRC).filter((f) => !f.endsWith("pressFeel.js") && /installPressFeel\(\)/.test(strip(fs.readFileSync(f, "utf8"))));
    expect(callers.map((f) => path.relative(SRC, f)).sort()).toEqual(["components/Layout.jsx", "pages/StaffPortalPage.jsx"]);
  });

  it("the owner shell scope: Layout sets html[data-owner-shell] while mounted", () => {
    const layout = strip(read("components/Layout.jsx"));
    expect(layout).toContain('html.setAttribute("data-owner-shell", "");');
    expect(layout).toContain('return () => html.removeAttribute("data-owner-shell");');
    expect(layout).toContain('import "./owner/ownerShell.css";');
  });

  it("the :active mute is scoped to the owner shell, and the tokens are one scope, not a third copy (5.2, 5.3)", () => {
    const css = strip(read("components/owner/ownerShell.css"));
    expect(css).toContain('html[data-modality="touch"]:where([data-owner-shell]) :where(button, a, [role="button"]):active { scale: none; }');
    expect(css).toContain('html[data-modality="touch"]:where([data-owner-shell]) :where(:is(button, a, [role="button"]):not(.vp-tint))[data-pressed]:not(:disabled) { scale: .97; }');
    // index.css's global touch press is untouched: the guest page and the
    // staff portal keep theirs.
    expect(read("index.css")).toMatch(/button:active, a:active, \[role="button"\]:active \{\s*scale: 0\.97;/);
    // The tokens: the existing I dag rules gained the owner scope — no new
    // block of the same values.
    const today = strip(read("components/today/today.css"));
    expect(today).toMatch(/html\[data-owner-shell\], \.td-page, \.td-rail \{\s*--td-ink: #1A1917;/);
    expect(today).toMatch(/html\.dark\[data-owner-shell\], \.dark \.td-page, \.dark \.td-rail \{/);
    expect(today).toMatch(/html\[data-owner-shell\], \.td-page, \.td-rail, \.td-tab \{\s*--td-dur-press: 0\.11s;/);
    expect(today.match(/--td-ink: #1A1917;/g)).toHaveLength(1);
    expect(css).not.toMatch(/--td-ink:/);
    // The owner scope carries colours, never a font for the whole app.
    expect(today).not.toMatch(/html\[data-owner-shell\][^{]*\{[^}]*font-family/);
  });

  it("the staff kit files are not edited — wrapped, not copied", () => {
    for (const f of ["components/staff/pressFeel.js", "components/staff/feel.js", "components/staff/dockLabelFit.js", "components/staff/vagtplan.css"]) {
      expect(read(f)).not.toMatch(/owner-shell|ow-dock|phone R1/);
    }
  });
});

describe("the door screen stays the web", () => {
  it("feel.js has a silent stand-in in the door screen's build (no Capacitor in its budget)", async () => {
    const { STAND_SWAPS } = await import("../../scripts/standBuild.mjs");
    expect(STAND_SWAPS["components/staff/feel.js"]).toBe("stand/standFeel.js");
    const { feel } = await import("../stand/standFeel.js");
    for (const k of ["done", "warn", "fail", "soft", "warm", "tick"]) expect(() => feel[k]()).not.toThrow();
  });
});
