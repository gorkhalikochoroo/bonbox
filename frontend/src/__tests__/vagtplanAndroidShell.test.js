/**
 * The Vagtplan Android shell (Android walk, 11 Nov 2026):
 *
 *   • capacitor.config.ts — the scheduler target (only) sets Capacitor 8's
 *     SystemBars: style LIGHT (dark icons; its DEFAULT went white in system
 *     dark mode, after StatusBar's LIGHT), viewport-fit cover up front, and
 *     insetsHandling "native" (no --safe-area-inset-* injection, which threw
 *     "Error injecting safe area CSS" before the page had a document). The
 *     owner app is untouched.
 *   • styles.xml — the activity theme is Light (the portal has no dark mode)
 *     with pine as the accent, so native date/select pickers are not teal; the
 *     light-mode splash is unchanged, and a values-night copy keeps the splash
 *     in light mode's colour with dark bar icons in system dark mode.
 *   • MainActivity — the WebView's text zoom follows the system size up to
 *     one step (115 %), so large text cannot break the dock and the ring.
 *   • The dock label's size is the fit variable, 11 px by default.
 */
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8");
const RES = "android-scheduler/app/src/main/res";
const style = (xml, name) => {
  const m = xml.match(new RegExp(`<style name="${name.replace(/\./g, "\\.")}"[^>]*>[\\s\\S]*?</style>`));
  return m ? m[0] : null;
};

const savedTarget = process.env.BONBOX_TARGET;
afterEach(() => {
  if (savedTarget === undefined) delete process.env.BONBOX_TARGET;
  else process.env.BONBOX_TARGET = savedTarget;
  vi.resetModules();
});
async function loadConfig(target) {
  if (target) process.env.BONBOX_TARGET = target;
  else delete process.env.BONBOX_TARGET;
  vi.resetModules();
  return (await import("../../capacitor.config.ts")).default;
}

describe("capacitor.config.ts", () => {
  it("the scheduler sets SystemBars LIGHT / cover / native, beside StatusBar LIGHT", async () => {
    const cfg = await loadConfig("scheduler");
    expect(cfg.appId).toBe("dk.bonbox.scheduler");
    expect(cfg.plugins.SystemBars).toEqual({ style: "LIGHT", initialViewportFitValueHint: "cover", insetsHandling: "native" });
    expect(cfg.plugins.StatusBar.style).toBe("LIGHT");
  });

  it("the owner app has no SystemBars block (Capacitor's defaults, as before)", async () => {
    const cfg = await loadConfig(undefined);
    expect(cfg.appId).toBe("dk.bonbox.app");
    expect(cfg.plugins.SystemBars).toBeUndefined();
    expect(cfg.plugins.StatusBar.style).toBe("LIGHT");
  });

  it("nothing reads the --safe-area-inset-* variables 'native' stops injecting", () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" ? [] : walk(p);
      return /\.(jsx?|tsx?|css|html)$/.test(e.name) ? [p] : [];
    });
    const users = [...walk(path.join(FRONTEND, "src")), path.join(FRONTEND, "index.html")]
      .filter((f) => fs.readFileSync(f, "utf8").includes("--safe-area-inset-"));
    expect(users).toEqual([]);
  });
});

describe("the bars on Android match the cream page; the iPhone is unchanged (12 Nov 2026)", () => {
  // The CLI reads capacitor.config.ts once per command; `npx cap copy android`
  // has "android" in its arguments.
  const savedArgv = process.argv;
  afterEach(() => { process.argv = savedArgv; });
  async function configFor(target, platformArg) {
    process.argv = ["node", "cap", "copy", ...(platformArg ? [platformArg] : [])];
    return loadConfig(target);
  }
  // StaffPortalPage's page colour.
  const IVORY = read("src/pages/StaffPortalPage.jsx").match(/const IVORY = "(#[0-9A-Fa-f]{6})";/)[1];

  it("the scheduler's Android project: WebView, status bar and theme all take the canvas", async () => {
    expect(IVORY).toBe("#F6F4EE");
    const cfg = await configFor("scheduler", "android");
    expect(cfg.android.backgroundColor).toBe(IVORY);
    expect(cfg.plugins.StatusBar.backgroundColor).toBe(IVORY);
    expect(read(`${RES}/values/colors.xml`)).toContain(`<color name="shellBackground">${IVORY}</color>`);
  });

  it("the scheduler's iOS project: exactly what the committed iOS config already says", async () => {
    const cfg = await configFor("scheduler", "ios");
    const committed = JSON.parse(read("ios-scheduler/App/App/capacitor.config.json"));
    expect(cfg.ios.backgroundColor).toBe("#f9fafb");
    expect(cfg.ios.backgroundColor).toBe(committed.ios.backgroundColor);
    expect(cfg.plugins.StatusBar).toEqual(committed.plugins.StatusBar);
    expect(cfg.plugins.StatusBar.backgroundColor).toBe("#f9fafb");
  });

  it("a bare `cap sync` (no platform): the iOS value for both, never the canvas on the iPhone", async () => {
    const cfg = await configFor("scheduler", undefined);
    expect(cfg.plugins.StatusBar.backgroundColor).toBe("#f9fafb");
    expect(cfg.ios.backgroundColor).toBe("#f9fafb");
  });

  it("the owner app is untouched on both platforms", async () => {
    for (const p of ["android", "ios", undefined]) {
      const cfg = await configFor(undefined, p);
      expect(cfg.android.backgroundColor).toBe("#f8fafc");
      expect(cfg.ios.backgroundColor).toBe("#f8fafc");
      expect(cfg.plugins.StatusBar.backgroundColor).toBe("#f8fafc");
    }
  });
});

describe("android-scheduler resources", () => {
  const styles = read(`${RES}/values/styles.xml`);
  const night = read(`${RES}/values-night/styles.xml`);
  const colors = read(`${RES}/values/colors.xml`);

  it("the activity theme is Light (no DayNight anywhere) with pine as primary and accent", () => {
    const app = style(styles, "AppTheme.NoActionBar");
    expect(app).toMatch(/parent="Theme\.AppCompat\.Light\.NoActionBar"/);
    expect(styles).not.toMatch(/parent="[^"]*DayNight/);
    expect(app).toMatch(/<item name="colorAccent">@color\/pine<\/item>/);
    expect(app).toMatch(/<item name="colorPrimary">@color\/pine<\/item>/);
    expect(app).toMatch(/<item name="android:windowBackground">@color\/shellBackground<\/item>/);
    // What was there stays.
    expect(app).toMatch(/<item name="android:statusBarColor">@color\/shellBackground<\/item>/);
    expect(app).toMatch(/<item name="android:windowLightStatusBar">true<\/item>/);
  });

  it("colours: pine is the portal's #0E3B2E; the dark-mode splash is light mode's own splash colour", () => {
    expect(colors).toMatch(/<color name="pine">#0E3B2E<\/color>/);
    // Light mode = ?android:colorBackground of DeviceDefault.Light: #FAFAFA
    // before Android 12, system_neutral1_50 from 12 on (walk round 2, P4:
    // the dark splash was #FFFFFF, light mode's lavender-grey).
    expect(colors).toMatch(/<color name="splashBackground">#FAFAFA<\/color>/);
    const v31 = read(`${RES}/values-v31/colors.xml`);
    expect(v31).toMatch(/<color name="splashBackground">@android:color\/system_neutral1_50<\/color>/);
    // Newer frameworks (API 37 read on the emulator) moved it to the surface container.
    const v36 = read(`${RES}/values-v36/colors.xml`);
    expect(v36).toMatch(/<color name="splashBackground">@android:color\/system_surface_container_light<\/color>/);
    // Edited 12 Nov 2026 (Android 14 walk, P3): was #f9fafb (bg-gray-50), a
    // cooler band above the header and below the dock on Android 14. The
    // window, the status bar and the nav bar now take the portal's cream.
    expect(colors).toMatch(/<color name="shellBackground">#F6F4EE<\/color>/);
  });

  it("light mode's splash is unchanged; system dark mode keeps it light with dark bar icons", () => {
    const light = style(styles, "AppTheme.NoActionBarLaunch");
    expect(light).toMatch(/parent="Theme\.SplashScreen"/);
    expect(light).not.toMatch(/windowSplashScreenBackground/);
    const dark = style(night, "AppTheme.NoActionBarLaunch");
    expect(dark).toMatch(/parent="Theme\.SplashScreen"/);
    expect(dark).toMatch(/<item name="android:background">@drawable\/splash<\/item>/);
    expect(dark).toMatch(/<item name="windowSplashScreenBackground">@color\/splashBackground<\/item>/);
    expect(dark).toMatch(/<item name="android:windowLightStatusBar">true<\/item>/);
    // values-night overrides the launch style only.
    expect(style(night, "AppTheme.NoActionBar")).toBeNull();
  });

  it("the manifest's permissions are untouched by this work (the Play listing is in review)", () => {
    const manifest = read("android-scheduler/app/src/main/AndroidManifest.xml");
    expect(manifest.match(/<uses-permission [^>]+>/g)).toEqual([
      '<uses-permission android:name="android.permission.INTERNET" />',
      '<uses-permission android:name="android.permission.CAMERA" />',
      '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
      '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
      '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
      '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
    ]);
  });
});

describe("text size", () => {
  it("MainActivity caps the WebView's text zoom at one step up, guarded for a missing WebView", () => {
    const java = read("android-scheduler/app/src/main/java/dk/bonbox/scheduler/MainActivity.java");
    expect(java).toMatch(/static final int MAX_TEXT_ZOOM = 115;/);
    expect(java).toMatch(/setTextZoom\(Math\.min\(Math\.round\(fontScale \* 100f\), MAX_TEXT_ZOOM\)\)/);
    expect(java).toMatch(/if \(getBridge\(\) == null\) return;/);
    // After super.onCreate (the bridge exists), before the page paints.
    expect(java.indexOf("capTextZoom();")).toBeGreaterThan(java.indexOf("super.onCreate(savedInstanceState);"));
  });

  it("the dock label's size is the fit variable, 11 px by default", () => {
    const css = read("src/components/staff/vagtplan.css");
    expect(css).toMatch(/\.vp-dock-label \{[^}]*font: 600 var\(--vp-dock-fs, 11px\)\/1\.1 var\(--font-text\);/);
  });
});
