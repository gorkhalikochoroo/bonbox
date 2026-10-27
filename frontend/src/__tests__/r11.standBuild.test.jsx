/**
 * R11 — the door screen's own build (rubric B11: stand JS ≤ 200 KB gzip).
 *
 *   • the build pieces (scripts/standBuild.mjs): which files the door screen
 *     reaches, which words it gets (and which owner words it never gets), the
 *     key scan that a stray quote cannot fool, the cut of owner-only
 *     functions, the swaps that stay in step with the modules they replace,
 *     the budget guard, the dev/preview rewrite;
 *   • the wiring: stand.html, vite.stand.config.js, the app config's define,
 *     package.json's build, vercel.json's rewrites before the catch-all;
 *   • the door screen's own language provider (same t() as the app's), its
 *     routes, and its crash screen.
 *
 * Run: cd frontend && npx vitest run src/__tests__/r11.standBuild.test.jsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  APP_DICTS_FILE, STAND_JS_BUDGET, STAND_JS_HARD_CEILING, STAND_SKIP_FILES, STAND_SKIP_FUNCTIONS, STAND_SWAPS,
  appDictionaries, appDictionariesIn, cutFunctions, importsOf, keysIn, standBudget, standFiles, standHtml,
  standJsBytes, standWordsFor,
} from "../../scripts/standBuild.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.resolve(SRC, "..");
const rel = (f) => path.relative(SRC, f).split(path.sep).join("/");
const read = (f) => fs.readFileSync(path.join(FRONTEND, f), "utf8");

describe("the key scan", () => {
  const dict = new Set(["rsvpA", "rsvpB", "rsvpC", "allergen_nuts", "allergen_fish", "save", "rsvpLongFamilyX"]);
  it("takes every quoted string that is a key, in any quote, and a table of keys", () => {
    const src = `t("rsvpA"); t('rsvpB'); t(\`rsvpC\`); const KEYS = { x: ["save", "nope"] };`;
    expect([...keysIn([src], dict)].sort()).toEqual(["rsvpA", "rsvpB", "rsvpC", "save"]);
  });
  it("a prefix the code builds takes its whole family; a short one does not", () => {
    expect([...keysIn(["t(`allergen_${k}`)"], dict)].sort()).toEqual(["allergen_fish", "allergen_nuts"]);
    expect([...keysIn(['t("allergen_" + k)'], dict)].sort()).toEqual(["allergen_fish", "allergen_nuts"]);
    expect([...keysIn(["t(`rs${k}`)"], dict)]).toEqual([]);
  });
  it("a stray apostrophe or backtick in a comment never hides a key", () => {
    const src = "// the host's `walk-in row\nt(\"rsvpA\")\n// it's done\nt(\"rsvpB\") // `x";
    expect([...keysIn([src], dict)].sort()).toEqual(["rsvpA", "rsvpB"]);
  });
  it("imports: static, re-exports and dynamic", () => {
    expect(importsOf(`import a from "./a"; import { b } from '../b'; export { c } from "./c"; const d = () => import("./d.jsx"); import "./e.css";`).sort())
      .toEqual(["../b", "./a", "./c", "./d.jsx", "./e.css"]);
  });
  it("cuts whole column-0 functions, nothing else", () => {
    const src = "function Keep() {\n  t(\"rsvpA\");\n}\n\nfunction Owner({ x }) {\n  if (x) {\n    t(\"rsvpB\");\n  }\n}\nexport default function Page() {\n  t(\"rsvpC\");\n}";
    const { kept, cut } = cutFunctions(src, ["Owner"]);
    expect(kept).toContain("rsvpA");
    expect(kept).toContain("rsvpC");
    expect(kept).not.toContain("rsvpB");
    expect(cut).toContain("rsvpB");
  });
});

describe("what the door screen reaches", () => {
  const files = [...standFiles()].map(rel);
  it("its entry, the book, the pairing page and its own stand-ins", () => {
    for (const f of ["stand/main.jsx", "stand/StandApp.jsx", "pages/ReservationsPage.jsx", "pages/StandPairPage.jsx",
      "hooks/useLiveAlerts.jsx", "components/reservations/WaitlistSection.jsx", "components/FloorPlan.jsx",
      "stand/standLanguage.jsx", "stand/standSession.jsx", "stand/standPlatform.js", "stand/standFloorPlan.jsx"]) {
      expect(files, f).toContain(f);
    }
  });
  it("never the app's shell modules it swaps out, a dictionary, or an owner-only card", () => {
    for (const f of Object.keys(STAND_SWAPS)) {
      if (f === "components/FloorPlan.jsx") continue; // the stand-in's own import reaches it
      expect(files, f).not.toContain(f);
    }
    expect(files.some((f) => f.startsWith("i18n/"))).toBe(false);
    for (const f of STAND_SKIP_FILES) expect(files, f).not.toContain(f);
    expect(files).not.toContain("App.jsx");
    expect(files).not.toContain("main.jsx");
  });
  it("every skipped file and function still exists — a rename must not skip nothing", () => {
    for (const f of STAND_SKIP_FILES) expect(fs.existsSync(path.join(SRC, f)), f).toBe(true);
    for (const [f, names] of Object.entries(STAND_SKIP_FUNCTIONS)) {
      const src = fs.readFileSync(path.join(SRC, f), "utf8");
      for (const n of names) expect(src, `${f} ${n}`).toMatch(new RegExp(`^function ${n}\\(`, "m"));
    }
  });
  it("only stylesheets are imported for their side effects (the build drops unused modules)", () => {
    for (const f of standFiles()) {
      if (!/\.(jsx?|mjs)$/.test(f)) continue;
      const bare = [...fs.readFileSync(f, "utf8").matchAll(/^\s*import\s+["']([^"']+)["'];?\s*$/gm)].map((m) => m[1]);
      for (const b of bare) expect(b, `${rel(f)} imports ${b} for its side effects`).toMatch(/\.css$/);
    }
  });
});

describe("the door screen's words", () => {
  let words;
  beforeEach(async () => {
    if (!words) words = await standWordsFor();
  });
  it("hold what the book, the stand, the alerts and R11 say — in Danish and English", () => {
    for (const k of ["rsvpStandMode", "rsvpWalkInFreeNow", "rsvpBookOffline", "rsvpStandUnpair", "rsvpNoFitTitle",
      "rsvpFreedTitle", "rsvpAllergyPossible", "rsvpSevSevere", "allergen_peanuts", "rsvpConfirmedTables",
      "rsvpWlTitle", "rsvpSeatWalkIn", "standPairReopening", "tryAgain", "rsvpErrNoNet"]) {
      expect(words.da[k], k).toBeTruthy();
      expect(words.en[k], k).toBeTruthy();
    }
  });
  it("never the owner's settings, tabs or setup cards", () => {
    // (A word the owner page's own tab bar says — e.g. rsvpTabInsights —
    // may ride along: that bar is in the page's kept code, dead only at
    // runtime. Harmless; these are the owner's own cards and files.)
    for (const k of ["rsvpClosuresTitle", "rsvpOwnerEmailToggle", "rsvpBookingNameLabel", "rsvpInsCollectingTitle",
      "rsvpSalonNoServiceWarn"]) {
      expect(words.da[k], k).toBeUndefined();
    }
  });
  it("the same keys in both languages, and small", () => {
    expect(Object.keys(words.da).sort()).toEqual(Object.keys(words.en).sort());
    const gz = (o) => zlib.gzipSync(JSON.stringify(o), { level: 9 }).length;
    expect(gz(words.da)).toBeLessThan(16000);
    expect(gz(words.en)).toBeLessThan(16000);
    expect(Object.keys(words.da).length).toBeGreaterThan(500);
  });
  it("a word only an owner-only function says is listed for the build's proof", () => {
    expect(words.cutOnly.has("rsvpClosuresTitle") || !words.da.rsvpClosuresTitle).toBe(true);
    for (const k of words.cutOnly) expect(words.da[k], k).toBeUndefined();
  });
});

describe("the swaps stay in step with what they replace", () => {
  const names = (src) => new Set([...src.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  it.each(Object.entries(STAND_SWAPS))("%s → %s exports everything the original does", (from, to) => {
    const original = names(fs.readFileSync(path.join(SRC, from), "utf8"));
    const standIn = names(fs.readFileSync(path.join(SRC, to), "utf8"));
    const defaults = (s) => /^export\s+default\b/m.test(s);
    if (defaults(fs.readFileSync(path.join(SRC, from), "utf8"))) {
      expect(defaults(fs.readFileSync(path.join(SRC, to), "utf8"))).toBe(true);
    }
    for (const n of original) {
      // LanguageProvider's internals and the app-only helpers are not the
      // door screen's business: only what its code imports must exist.
      if (["FloorPlan"].includes(n)) continue;
      expect(standIn.has(n) || n === "default", `${to} lacks ${n}`).toBe(true);
    }
  });
});

describe("the budget guard", () => {
  const chunk = (fileName, code, extra = {}) => ({ type: "chunk", fileName, code, imports: [], modules: {}, ...extra });
  const big = (n) => Array.from({ length: n }, (_, i) => `v${i}=${(i * 7919) % 100003};`).join("");
  const bundle = (n) => ({
    "assets/stand-a.js": chunk("assets/stand-a.js", big(n), { isEntry: true, facadeModuleId: "/x/frontend/stand.html", imports: ["assets/react-b.js"] }),
    "assets/react-b.js": chunk("assets/react-b.js", "export const r=1;"),
    "assets/lazy-c.js": chunk("assets/lazy-c.js", big(n), { isDynamicEntry: true }),
    "assets/da-d.js": chunk("assets/da-d.js", "export default {a:1}", { facadeModuleId: "\0virtual:bonbox-stand-words/da" }),
  });
  it("counts the entry, its static imports and one language — never a lazy chunk", () => {
    const m = standJsBytes(bundle(10));
    expect(m.files.sort()).toEqual(["assets/react-b.js", "assets/stand-a.js"]);
    expect(Object.keys(m.words)).toEqual(["da"]);
  });
  const run = (b) => {
    const ctx = { error: vi.fn((msg) => { throw new Error(msg); }), info: vi.fn() };
    try { standBudget().generateBundle.call(ctx, {}, b); return { ...ctx, threw: null }; } catch (e) { return { ...ctx, threw: e.message }; }
  };
  afterEach(() => { delete process.env.STAND_BUDGET_STRICT; });
  it("quiet under the budget, warns over it, stops over the hard ceiling (or at the budget when strict)", () => {
    expect(STAND_JS_BUDGET).toBe(200000);
    expect(STAND_JS_HARD_CEILING).toBeGreaterThan(STAND_JS_BUDGET);
    const small = run(bundle(10));
    expect(small.threw).toBeNull();
    // ~220 kB of random-ish code: over the budget, under the ceiling.
    let n = 10;
    while ((standJsBytes(bundle(n)).base) < 220000) n *= 2;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const over = run(bundle(n));
    if (standJsBytes(bundle(n)).base < STAND_JS_HARD_CEILING) {
      expect(over.threw).toBeNull();
      expect(warn).toHaveBeenCalled();
      process.env.STAND_BUDGET_STRICT = "1";
      expect(run(bundle(n)).threw).toMatch(/stand budget/);
    }
    warn.mockRestore();
  });
});

describe("one copy of each dictionary in dist/ (the app's)", () => {
  it("the app build lists its dictionary files", () => {
    const emitted = [];
    const bundle = {
      a: { type: "chunk", fileName: "assets/da-x1.js", facadeModuleId: "/r/frontend/src/i18n/da.js" },
      b: { type: "chunk", fileName: "assets/no-x2.js", facadeModuleId: "/r/frontend/src/i18n/no.js" },
      c: { type: "chunk", fileName: "assets/index-x3.js", facadeModuleId: "/r/frontend/src/main.jsx" },
      d: { type: "asset", fileName: "assets/x.css" },
    };
    appDictionaries().generateBundle.call({ emitFile: (f) => emitted.push(f) }, {}, bundle);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe(APP_DICTS_FILE);
    expect(JSON.parse(emitted[0].source)).toEqual({ da: "/assets/da-x1.js", no: "/assets/no-x2.js" });
  });
  it("the door screen's build bakes the list in (only safe entries) and removes the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r11-dicts-"));
    try {
      const out = dir; // an absolute outDir wins over the frontend folder
      fs.writeFileSync(path.join(dir, APP_DICTS_FILE), JSON.stringify({
        da: "/assets/da-x1.js", en: "/assets/en-x2.js", evil: "https://x.test/a.js", tr: "javascript:alert(1)",
      }));
      const plugin = appDictionariesIn(out);
      const id = plugin.resolveId("virtual:bonbox-app-dicts");
      const code = plugin.load.call({ warn: vi.fn() }, id);
      expect(code).toBe('export default {"da":"/assets/da-x1.js","en":"/assets/en-x2.js"};');
      plugin.closeBundle();
      expect(fs.existsSync(path.join(dir, APP_DICTS_FILE))).toBe(false);
      // Built without the app first: a warning and an empty list, never a guess.
      const warn = vi.fn();
      expect(plugin.load.call({ warn }, id)).toBe("export default {};");
      expect(warn).toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the door screen never reaches lib/localeStore.js (the dictionaries' loaders)", () => {
    expect([...standFiles()].map(rel)).not.toContain("lib/localeStore.js");
    expect([...standFiles()].map(rel)).toContain("stand/standLocales.js");
  });
});

describe("the wiring", () => {
  it("stand.html: its own entry, the manifest rule, no app boot probes", () => {
    const html = read("stand.html");
    expect(html).toContain('<script type="module" src="/src/stand/main.jsx"></script>');
    expect(html).not.toContain("/src/main.jsx");
    expect(html).toContain("/stand-device.webmanifest");
    expect(html).toMatch(/if \(!isIOS\)/);
    expect(html).not.toContain("/auth/me");
    expect(html).not.toContain("__bbBootMe");
    expect(html).toContain('navigator.serviceWorker.register("/sw.js")');
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain('<div id="root"></div>');
  });
  it("vercel.json: /stand and /stand/* get stand.html, before the catch-all", () => {
    const rw = JSON.parse(read("vercel.json")).rewrites;
    const i = rw.findIndex((r) => r.source === "/stand");
    const j = rw.findIndex((r) => r.source === "/stand/:path*");
    const all = rw.findIndex((r) => r.source === "/(.*)");
    expect(rw[i].destination).toBe("/stand.html");
    expect(rw[j].destination).toBe("/stand.html");
    expect(i).toBeLessThan(all);
    expect(j).toBeLessThan(all);
  });
  it("package.json builds the app, then the door screen", () => {
    expect(JSON.parse(read("package.json")).scripts.build).toBe("vite build && vite build --config vite.stand.config.js");
  });
  it("the app's config: __STAND_BUILD__ false; the door screen's: true, its own page, into the same dist", () => {
    const app = read("vite.config.js");
    expect(app).toMatch(/__STAND_BUILD__: 'false'/);
    expect(app).toMatch(/standHtml\(\), standWords\(\), appDictionaries\(\)/);
    const stand = read("vite.stand.config.js");
    expect(stand).toMatch(/__STAND_BUILD__: 'true'/);
    expect(stand).toMatch(/stand\.html/);
    expect(stand).toMatch(/emptyOutDir: false/);
    expect(stand).toMatch(/standModules\(\), standWords\(\), standBudget\(\), appDictionariesIn\('dist'\)/);
    expect(stand).toMatch(/moduleSideEffects: \(id\) => \/\\\.css/);
  });
  it("ReservationsPage leaves the owner's tabs and cards out of the door screen's build", () => {
    const rp = fs.readFileSync(path.join(SRC, "pages/ReservationsPage.jsx"), "utf8");
    for (const guard of [
      '!__STAND_BUILD__ && tab === "floor"', '!__STAND_BUILD__ && tab === "behandlinger"',
      '!__STAND_BUILD__ && tab === "insights"', '!__STAND_BUILD__ && tab === "settings"',
      "!__STAND_BUILD__ && salonFirstRun", "!__STAND_BUILD__ && railSlot",
    ]) expect(rp, guard).toContain(guard);
    // …and in vitest (the app's config) it is false: the owner page is whole.
    expect(__STAND_BUILD__).toBe(false);
  });
  it("the dev and preview servers send /stand addresses to stand.html, nothing else", () => {
    const mw = [];
    standHtml().configureServer({ middlewares: { use: (f) => mw.push(f) } });
    const go = (url, accept = "text/html") => {
      const req = { url, headers: { accept } };
      mw[0](req, {}, () => {});
      return req.url;
    };
    expect(go("/stand")).toBe("/stand.html");
    expect(go("/stand/tok-1")).toBe("/stand.html");
    expect(go("/stand/tok-1?x=1")).toBe("/stand.html");
    expect(go("/stand-device.webmanifest")).toBe("/stand-device.webmanifest");
    expect(go("/stand/tok-1", "application/json")).toBe("/stand/tok-1");
    expect(go("/reservations/stand")).toBe("/reservations/stand");
    expect(go("/standard")).toBe("/standard");
  });
});

describe("the door screen's language provider", () => {
  let LanguageProvider;
  let useLanguage;
  beforeEach(async () => {
    vi.resetModules();
    try { localStorage.clear(); } catch { /* none */ }
    ({ LanguageProvider, useLanguage } = await import("../stand/standLanguage.jsx"));
  });
  function Probe() {
    const { t, lang } = useLanguage();
    return (
      <div data-testid="p">
        {lang}|{t("rsvpStandMode", "Host screen")}|{t("rsvpPartyN", "{n} guests", { n: 4 })}|{t("noSuchKeyAtAll", "Fallback {x}", { x: 1 })}|{t("noSuchKeyAtAll")}|{t("rsvpPartyN", { n: 2 })}
      </div>
    );
  }
  it("Danish from the door screen's own words, the app's t() rules", async () => {
    localStorage.setItem("lang", "da");
    render(<LanguageProvider><Probe /></LanguageProvider>);
    const p = await screen.findByTestId("p");
    const [lang, mode, party, fb, raw, party2] = p.textContent.split("|");
    expect(lang).toBe("da");
    expect(mode).toBe("Vært-skærm");
    expect(party).toBe("4 gæster");
    expect(fb).toBe("Fallback 1");
    expect(raw).toBe("noSuchKeyAtAll");
    expect(party2).toBe("2 gæster");
  });
  it("English the same way", async () => {
    localStorage.setItem("lang", "en");
    render(<LanguageProvider><Probe /></LanguageProvider>);
    const p = await screen.findByTestId("p");
    expect(p.textContent.split("|").slice(0, 3)).toEqual(["en", "Host stand", "4 guests"]);
  });
  it("a word outside its words asks for the full dictionary once", async () => {
    vi.resetModules();
    const loadLocale = vi.fn(async () => ({ rsvpOnlyInFull: "Kun i den store ordbog" }));
    vi.doMock("../lib/localeStore", () => ({ loadLocale, localesFor: (c) => [c] }));
    const mod = await import("../stand/standLanguage.jsx");
    localStorage.setItem("lang", "da");
    function Miss() {
      const { t } = mod.useLanguage();
      return <span data-testid="m">{t("rsvpOnlyInFull", "fallback")}</span>;
    }
    render(<mod.LanguageProvider><Miss /><Miss /></mod.LanguageProvider>);
    await waitFor(() => expect(screen.getAllByTestId("m")[0].textContent).toBe("Kun i den store ordbog"));
    expect(loadLocale).toHaveBeenCalledTimes(1);
    vi.doUnmock("../lib/localeStore");
  });
});

describe("the door screen's crash screen and routes", () => {
  it("a crash: one calm screen in Danish, reported; a stale chunk reloads itself, at most twice", async () => {
    vi.resetModules();
    const report = vi.fn();
    vi.doMock("../utils/reportClientError", () => ({ reportClientError: report }));
    const { StandErrorBoundary } = await import("../stand/StandApp.jsx");
    localStorage.setItem("lang", "da");
    sessionStorage.clear();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, reload } });
    try {
      const Boom = () => { throw new Error("render bug"); };
      const r1 = render(<StandErrorBoundary><Boom /></StandErrorBoundary>);
      expect(document.querySelector("[data-stand-crash]").textContent).toContain("Noget gik galt");
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "render" }));
      expect(reload).not.toHaveBeenCalled();
      r1.unmount();
      const Stale = () => { throw new Error("Failed to fetch dynamically imported module: /assets/x.js"); };
      for (let i = 0; i < 3; i += 1) {
        const r = render(<StandErrorBoundary><Stale /></StandErrorBoundary>);
        r.unmount();
      }
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "chunk_load" }));
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: orig });
      spy.mockRestore();
      vi.doUnmock("../utils/reportClientError");
    }
  });

  it("any other address leaves for the owner app by a full load; /stand/ stays", async () => {
    vi.resetModules();
    vi.doMock("../pages/ReservationsPage", () => ({ default: () => <div>BOOK</div> }));
    vi.doMock("../pages/StandPairPage", () => ({ default: () => <div>PAIR</div> }));
    const { StandRoutes } = await import("../stand/StandApp.jsx");
    const replace = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, replace } });
    try {
      const { unmount } = render(<MemoryRouter initialEntries={["/stand/tok-1"]}><StandRoutes /></MemoryRouter>);
      expect(screen.getByText("BOOK")).toBeTruthy();
      unmount();
      const r2 = render(<MemoryRouter initialEntries={["/stand"]}><StandRoutes /></MemoryRouter>);
      expect(await screen.findByText("PAIR")).toBeTruthy();
      r2.unmount();
      await act(async () => {
        render(<MemoryRouter initialEntries={["/reservations?tab=settings"]}><StandRoutes /></MemoryRouter>);
      });
      expect(replace).toHaveBeenCalledWith("/reservations?tab=settings");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: orig });
      vi.doUnmock("../pages/ReservationsPage");
      vi.doUnmock("../pages/StandPairPage");
    }
  });

  it("the stand-ins answer as a door device: no user, no analytics, the web, no haptics", async () => {
    const { useAuth } = await import("../stand/standSession.jsx");
    expect(useAuth().user).toBeNull();
    expect(useAuth().loading).toBe(false);
    const ev = await import("../stand/standEventLog.js");
    expect(ev.analyticsAllowed()).toBe(false);
    expect(ev.trackEvent("x")).toBeUndefined();
    const pf = await import("../stand/standPlatform.js");
    expect(pf.platform).toEqual({ isNative: false, isIOS: false, isAndroid: false, isWeb: true });
    expect(pf.isNativeApp()).toBe(false);
    const hp = await import("../stand/standHaptics.js");
    expect(() => hp.haptic.success()).not.toThrow();
  });

  it("the plan on first use: its own Try again, never the crash screen", async () => {
    vi.resetModules();
    vi.doMock("../components/FloorPlan.jsx", () => { throw new Error("Failed to fetch dynamically imported module"); });
    const { default: StandFloorPlan } = await import("../stand/standFloorPlan.jsx");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Suspense } = await import("react");
    render(<Suspense fallback={<span>SKELETON</span>}><StandFloorPlan t={(_k, fb) => fb} /></Suspense>);
    await waitFor(() => expect(document.querySelector("[data-stand-plan-failed]")).not.toBeNull());
    expect(document.querySelector("[data-stand-plan-failed]").textContent).toContain("Try again");
    spy.mockRestore();
    vi.doUnmock("../components/FloorPlan.jsx");
  });
});
