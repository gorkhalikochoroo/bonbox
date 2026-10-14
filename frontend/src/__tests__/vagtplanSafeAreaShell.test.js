/**
 * Vagtplan 1.6 (23) — the staff app's safe areas have ONE owner: CSS.
 *
 * Until build 22 the scheduler ran ios.contentInset "automatic" with
 * StatusBar.overlaysWebView false. WKWebView then inset its scroll view by the
 * safe areas (8 pt top, 34 pt bottom on an iPhone 18 Pro) while still
 * reporting env(safe-area-inset-bottom) = 34, so the tab bar padded for the
 * home indicator AND the scroll view added a second band under it. The 100dvh
 * shell plus those insets overflowed the webview, the outer scroll view
 * (bouncing off) could be dragged 34 pt and stayed there: the tab bar rose and
 * a band opened under it — "it gets stuck and creates gaps". Measured with a
 * lab probe in bonbox-lab-state/vagtplan-inset.
 *
 * The fix: contentInset "never" + overlaysWebView true for the staff app (the
 * owner app already ran that way), the portal header pads by
 * env(safe-area-inset-top) and the tab bar by env(safe-area-inset-bottom).
 * These pins keep the native config, its generated copy, the source classes
 * and the COMMITTED bundle (what the app actually ships) in step.
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

describe("native shell config: the webview runs edge to edge in BOTH apps", () => {
  const ts = read("capacitor.config.ts");

  it("capacitor.config.ts: contentInset never and overlaysWebView true, with no per-app split left", () => {
    expect(ts).toContain('contentInset: "never",');
    expect(ts).toContain("overlaysWebView: true,");
    expect(ts).not.toMatch(/contentInset:\s*isScheduler/);
    expect(ts).not.toMatch(/overlaysWebView:\s*!?isScheduler/);
    expect(ts).not.toMatch(/contentInset:\s*"automatic"/);
    // The keyboard model the portal's keyboard handling is written against.
    expect(ts).toMatch(/Keyboard:\s*{\s*resize: "body",/);
  });

  it("the committed (generated) staff capacitor.config.json says the same — it is what the app reads", () => {
    const cfg = JSON.parse(read("ios-scheduler/App/App/capacitor.config.json"));
    expect(cfg.appId).toBe("dk.bonbox.scheduler");
    expect(cfg.ios.contentInset).toBe("never");
    expect(cfg.plugins.StatusBar.overlaysWebView).toBe(true);
    // Unchanged: the inner scrollers do the scrolling; nothing else moved.
    expect(cfg.ios.scrollEnabled).toBe(true);
    expect(cfg.ios.backgroundColor).toBe("#f9fafb");
    expect(cfg.plugins.StatusBar.style).toBe("LIGHT");
    expect(cfg.plugins.Keyboard.resize).toBe("body");
  });

  it("the staff build that carries this is 23 or later, the same in Debug and Release (ci_pre_xcodebuild.sh floors on it)", () => {
    const pbx = read("ios-scheduler/App/App.xcodeproj/project.pbxproj");
    const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]));
    expect(builds.length).toBe(2);
    expect(builds[0]).toBe(builds[1]);
    expect(builds[0]).toBeGreaterThanOrEqual(23);
  });

  it("the owner app's committed config is untouched (it already ran never + overlay)", () => {
    const cfg = JSON.parse(read("ios/App/App/capacitor.config.json"));
    expect(cfg.appId).toBe("dk.bonbox.app");
    expect(cfg.ios.contentInset).toBe("never");
    expect(cfg.plugins.StatusBar.overlaysWebView).toBe(true);
  });
});

describe("the staff portal owns its insets in CSS", () => {
  const SRC = read("src/pages/StaffPortalPage.jsx");

  it("header pads by the top inset; tab bar pads by the bottom inset; the shell has no other vertical inset", () => {
    expect(SRC).toContain('data-portal-header="" className={`sticky top-0 z-10 glass-static border-b border-gray-200/70 pt-[env(safe-area-inset-top)] ${BAR_V2 ? "bb-lg-header" : ""}`}');
    expect(SRC).toContain('flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]');
    // The body inset is dropped while the portal is mounted, so the header and
    // the tab bar are the single source (index.css body.portal-shell).
    expect(SRC).toContain('document.body.classList.add("portal-shell")');
    expect(read("src/index.css")).toMatch(/body\.portal-shell\s*{\s*padding-top: 0;\s*padding-bottom: 0;\s*}/);
  });

  it("index.html keeps viewport-fit=cover (without it env() is 0 and the header would sit under the clock)", () => {
    expect(read("index.html")).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });
});

describe("sheets that ride the keyboard stop at the status bar (build 23, round 2)", () => {
  const SRC = read("src/pages/StaffPortalPage.jsx");

  it("the profile and new-group overlays pad their top by the inset; the phone keeps the home-indicator pad only while the keyboard is down", () => {
    // With the keyboard up the overlay leaves 0..(screen − keyboard) for the
    // sheet; the profile panel (a scroller) shrank to fill it from y = 0 and its
    // title and close X sat under the clock, where the X could not be tapped.
    expect(SRC).toContain('const SHEET_KB_TOP = "pt-[env(safe-area-inset-top)]";');
    expect(SRC).toContain("flex flex-col justify-end ${SHEET_KB_TOP} ${PAD_SHEET_OVERLAY} ${PAD_SHEET_KB}");
    expect(SRC).toContain("tablet:items-end ${SHEET_KB_TOP} ${PAD_SHEET_OVERLAY} ${PAD_SHEET_KB}");
    // Every overlay that rides the keyboard (KB_LIFT_STYLE) carries the top stop.
    const lifted = SRC.split("\n").filter((l) => l.includes("style={KB_LIFT_STYLE}"));
    expect(lifted.length).toBe(2);
    for (const l of lifted) expect(l).toContain("${SHEET_KB_TOP}");
    expect(SRC).toContain("pb-[max(1rem,calc(env(safe-area-inset-bottom)_-_var(--kb-h,0px)))]");
    expect(SRC).toContain('paddingBottom: "max(16px, calc(16px + env(safe-area-inset-bottom) - var(--kb-h, 0px)))"');
  });
});

describe("iPad windows: the staff app's own bridge controller (build 23, round 2)", () => {
  const APP = "ios-scheduler/App/App";
  const swift = read(`${APP}/VagtplanBridgeViewController.swift`);

  it("SceneDelegate roots the window in VagtplanBridgeViewController, and the target compiles the file", () => {
    expect(read(`${APP}/SceneDelegate.swift`)).toContain("window?.rootViewController = VagtplanBridgeViewController()");
    const pbx = read("ios-scheduler/App/App.xcodeproj/project.pbxproj");
    expect(pbx).toContain("/* VagtplanBridgeViewController.swift in Sources */,");
    expect(pbx).toMatch(/path = VagtplanBridgeViewController\.swift;/);
  });

  it("keeps the webview at y = 0 (the StatusBar plugin pushed it 22 pt down in a floating window)", () => {
    expect(swift).toContain("override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView");
    expect(swift).toContain("FullBleedWebView(frame: frame, configuration: configuration)");
    expect(swift).toMatch(/if pinned\.origin\.y > 0 {\s*pinned\.size\.height \+= pinned\.origin\.y\s*pinned\.origin\.y = 0/);
  });

  it("grows the top safe area to clear the window controls, measured on the window so it cannot feed back", () => {
    expect(swift).toContain("guard #available(iOS 26.0, *), let window = view.window else { return }");
    expect(swift).toContain("window.edgeInsets(for: .safeArea(cornerAdaptation: .vertical)).top");
    expect(swift).toContain("additionalSafeAreaInsets.top = extra");
  });
});

describe("the COMMITTED staff bundle carries both inset rules", () => {
  const css = assets(".css");
  const js = assets(".js");

  it("Tailwind emitted the header's top-inset utility (it was missing from build 22's CSS)", () => {
    expect(css).toContain(".pt-\\[env\\(safe-area-inset-top\\)\\]{padding-top:env(safe-area-inset-top)}");
    expect(js).toContain("pt-[env(safe-area-inset-top)]");
  });

  it("and the tab bar's home-indicator padding", () => {
    expect(css).toContain("pb-\\[max\\(0\\.5rem\\,env\\(safe-area-inset-bottom\\)\\)\\]{padding-bottom:max(.5rem, env(safe-area-inset-bottom))}");
  });

  it("and the round-2 sheet rules: the keyboard-down-only bottom pad", () => {
    expect(css).toContain(".pb-\\[max\\(1rem\\,calc\\(env\\(safe-area-inset-bottom\\)_-_var\\(--kb-h\\,0px\\)\\)\\)\\]{padding-bottom:max(1rem, calc(env(safe-area-inset-bottom) - var(--kb-h,0px)))}");
    expect(js).toContain("max(16px, calc(16px + env(safe-area-inset-bottom) - var(--kb-h, 0px)))");
  });

  it("index.html in the bundle keeps viewport-fit=cover", () => {
    expect(read(`${PUBLIC}/index.html`)).toMatch(/viewport-fit=cover/);
  });
});
