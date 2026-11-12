/**
 * Vagtplan 1.6 (23), on main for 1.7 — the staff app's safe areas have ONE
 * owner: CSS.
 *
 * Until 1.6 build 22 the scheduler ran ios.contentInset "automatic" with
 * StatusBar.overlaysWebView false. WKWebView then inset its scroll view by the
 * safe areas (8 pt top, 34 pt bottom on an iPhone 18 Pro) while still
 * reporting env(safe-area-inset-bottom) = 34, so the tab bar padded for the
 * home indicator AND the scroll view added a second band under it; the outer
 * scroll view could be dragged 34 pt and stayed there — "it gets stuck and
 * creates gaps". Measured with a lab probe in bonbox-lab-state/vagtplan-inset.
 *
 * The fix is a PAIR, and both halves must ship together:
 *   native — contentInset "never" + overlaysWebView true on iOS (the
 *   scheduler's Android project keeps false: the Android 14 walk's bar), the
 *   bridge controller that keeps iPad windows edge to edge;
 *   web — the portal header pads by env(safe-area-inset-top), the dock by
 *   env(safe-area-inset-bottom), and the body inset is dropped while the
 *   portal or Join is mounted (portal-shell), so nothing stacks.
 * These pins keep the native config, its generated copy, the source and the
 * COMMITTED bundle (what the app actually ships) in step.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), "utf8");
const PUBLIC = "ios-scheduler/App/App/public";
const assets = (ext) => {
  const dir = path.join(FRONTEND, PUBLIC, "assets");
  return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
};

describe("native shell config: the iOS webview runs edge to edge in BOTH apps", () => {
  const ts = read("capacitor.config.ts");

  it("capacitor.config.ts: contentInset never for both; overlaysWebView true except the scheduler's Android project", () => {
    expect(ts).toContain('contentInset: "never",');
    expect(ts).not.toMatch(/contentInset:\s*isScheduler/);
    expect(ts).not.toMatch(/contentInset:\s*"automatic"/);
    expect(ts).toContain("overlaysWebView: !(isScheduler && forAndroid),");
    // The keyboard model the portal's keyboard handling is written against.
    expect(ts).toMatch(/Keyboard:\s*{\s*resize: "body",/);
  });

  it("the committed (generated) staff capacitor.config.json says the same — it is what the app reads", () => {
    const cfg = JSON.parse(read("ios-scheduler/App/App/capacitor.config.json"));
    expect(cfg.appId).toBe("dk.bonbox.scheduler");
    expect(cfg.ios.contentInset).toBe("never");
    expect(cfg.plugins.StatusBar.overlaysWebView).toBe(true);
    expect(cfg.ios.scrollEnabled).toBe(true);
    expect(cfg.plugins.StatusBar.style).toBe("LIGHT");
    expect(cfg.plugins.Keyboard.resize).toBe("body");
  });

  it("the staff build that carries this is 1.7 (25) or later, the same in Debug and Release (ci_pre_xcodebuild.sh floors on it), iPhone + iPad", () => {
    const pbx = read("ios-scheduler/App/App.xcodeproj/project.pbxproj");
    const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]));
    expect(builds.length).toBe(2);
    expect(builds[0]).toBe(builds[1]);
    expect(builds[0]).toBeGreaterThanOrEqual(25);   // live: 1.6 (24)
    const versions = [...pbx.matchAll(/MARKETING_VERSION = ([\d.]+);/g)].map((m) => m[1]);
    expect(versions).toEqual(["1.7", "1.7"]);
    // Universal since 1.6 — the App Store refuses an update that drops iPad.
    expect([...pbx.matchAll(/TARGETED_DEVICE_FAMILY = "([\d,]+)";/g)].map((m) => m[1])).toEqual(["1,2", "1,2"]);
  });

  it("the owner app's committed config is untouched (it already ran never + overlay)", () => {
    const cfg = JSON.parse(read("ios/App/App/capacitor.config.json"));
    expect(cfg.appId).toBe("dk.bonbox.app");
    expect(cfg.ios.contentInset).toBe("never");
    expect(cfg.plugins.StatusBar.overlaysWebView).toBe(true);
  });
});

describe("the staff portal and Join own their insets in CSS (the web half)", () => {
  const SRC = read("src/pages/StaffPortalPage.jsx");

  it("header pads by the top inset; the dock by the bottom inset; the body inset is off while mounted", () => {
    expect(SRC).toContain('className="sticky top-0 z-10 glass-static pt-[env(safe-area-inset-top)]"');
    expect(read("src/components/staff/vagtplan.css")).toMatch(/\.vp-dock \{[^}]*bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ 8px\);/);
    expect(SRC).toContain('document.body.classList.add("portal-shell")');
    expect(read("src/pages/JoinPage.jsx")).toContain('document.body.classList.add("portal-shell")');
    expect(read("src/index.css")).toMatch(/body\.portal-shell\s*{\s*padding-top: 0;\s*padding-bottom: 0;\s*}/);
  });

  it("the chat stream no longer assumes the iOS shell has no top inset", () => {
    expect(SRC).not.toContain("iOS's shell has no top inset here (env is 0 there)");
    expect(SRC).toContain(": `calc(${VP_IH} - 20rem - env(safe-area-inset-top, 0px) - ${kb}px)`)");
  });

  it("index.html keeps viewport-fit=cover (without it env() is 0 and the header would sit under the clock)", () => {
    expect(read("index.html")).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });
});

describe("sheets that ride the keyboard stop at the status bar (1.6 (23) round 2)", () => {
  const SRC = read("src/pages/StaffPortalPage.jsx");

  it("the profile and new-group overlays pad their top by the inset; the home-indicator pad only while the keyboard is down", () => {
    expect(SRC).toContain('const SHEET_KB_TOP = "pt-[env(safe-area-inset-top)]";');
    const lifted = SRC.split("\n").filter((l) => l.includes("style={KB_LIFT_STYLE}"));
    expect(lifted.length).toBe(2);
    for (const l of lifted) expect(l).toContain("${SHEET_KB_TOP}");
    expect(SRC).toContain("pb-[max(1rem,calc(env(safe-area-inset-bottom)_-_var(--kb-h,0px)))]");
    expect(SRC).toContain('paddingBottom: "max(16px, calc(16px + env(safe-area-inset-bottom) - var(--kb-h, 0px)))"');
  });
});

describe("iPad windows: the staff app's own bridge controller (1.6 (23) round 2)", () => {
  const APP = "ios-scheduler/App/App";
  const swift = read(`${APP}/VagtplanBridgeViewController.swift`);

  it("SceneDelegate roots the window in VagtplanBridgeViewController, and the target compiles both", () => {
    expect(read(`${APP}/SceneDelegate.swift`)).toContain("window?.rootViewController = VagtplanBridgeViewController()");
    const pbx = read("ios-scheduler/App/App.xcodeproj/project.pbxproj");
    expect(pbx).toContain("/* VagtplanBridgeViewController.swift in Sources */,");
    expect(pbx).toContain("/* SceneDelegate.swift in Sources */,");
    expect(read(`${APP}/Info.plist`)).toContain("<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>");
  });

  it("keeps the webview at y = 0 (the StatusBar plugin pushed it 22 pt down in a floating window)", () => {
    expect(swift).toContain("override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView");
    expect(swift).toMatch(/if pinned\.origin\.y > 0 {\s*pinned\.size\.height \+= pinned\.origin\.y\s*pinned\.origin\.y = 0/);
  });

  it("grows the top safe area to clear the window controls, measured on the window so it cannot feed back", () => {
    expect(swift).toContain("guard #available(iOS 26.0, *), let window = view.window else { return }");
    expect(swift).toContain("window.edgeInsets(for: .safeArea(cornerAdaptation: .vertical)).top");
    expect(swift).toContain("additionalSafeAreaInsets.top = extra");
  });
});

describe("the COMMITTED staff bundle carries the web half", () => {
  const css = assets(".css");
  const js = assets(".js");

  it("Tailwind emitted the header's top-inset utility", () => {
    expect(css).toContain(".pt-\\[env\\(safe-area-inset-top\\)\\]{padding-top:env(safe-area-inset-top)}");
    expect(js).toContain("pt-[env(safe-area-inset-top)]");
  });

  it("and the keyboard-sheet rules: the keyboard-down-only bottom pad", () => {
    expect(css).toContain(".pb-\\[max\\(1rem\\,calc\\(env\\(safe-area-inset-bottom\\)_-_var\\(--kb-h\\,0px\\)\\)\\)\\]");
    expect(js).toContain("max(16px, calc(16px + env(safe-area-inset-bottom) - var(--kb-h, 0px)))");
  });

  it("and the iPad layout's stylesheet (the sidebar's room and the form sheets)", () => {
    expect(css).toMatch(/\(width>=744px\) and \(height>=600px\)|\(width >= 744px\) and \(height >= 600px\)/);
    expect(js).toContain("data-portal-rail");
  });

  it("index.html in the bundle keeps viewport-fit=cover", () => {
    expect(read(`${PUBLIC}/index.html`)).toMatch(/viewport-fit=cover/);
  });
});
