/**
 * Owner app (dk.bonbox.app) — iOS 27 UIScene lifecycle guard.
 *
 * Built with the iOS 27 SDK, UIKit traps at launch (EXC_BREAKPOINT in
 * _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption) when the app
 * has no UIApplicationSceneManifest. App Review rejected 2.2 (1052) for exactly
 * that; the fix lived on a side branch only, so a build from main would have
 * brought the crash back. These checks fail if any piece of the fix is lost:
 * the manifest, the SceneDelegate file, its registration in the App target, the
 * AppDelegate scene configuration, and the build-number floor staying above the
 * hand-archived build in the pbxproj.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8");

describe("owner iOS app adopts the UIScene lifecycle (iOS 27 launch crash)", () => {
  const plist = read("ios/App/App/Info.plist");
  const pbx = read("ios/App/App.xcodeproj/project.pbxproj");

  it("Info.plist declares one window scene backed by SceneDelegate and the Main storyboard", () => {
    expect(plist).toContain("<key>UIApplicationSceneManifest</key>");
    expect(plist).toMatch(/<key>UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>UISceneDelegateClassName<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate<\/string>/);
    expect(plist).toMatch(/<key>UISceneStoryboardFile<\/key>\s*<string>Main<\/string>/);
  });

  it("SceneDelegate.swift exists, forwards to Capacitor, and is compiled into the App target", () => {
    const scene = read("ios/App/App/SceneDelegate.swift");
    expect(scene).toMatch(/class SceneDelegate: UIResponder, UIWindowSceneDelegate/);
    expect(scene).toContain("CAPBridgeViewController()");
    expect(scene).toContain("SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)");
    expect(scene).toContain("SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)");
    expect(scene).toContain("SceneDelegateProxy.shared.scene(scene, continue: userActivity)");
    expect(pbx).toMatch(/\/\* SceneDelegate\.swift \*\/ = \{isa = PBXFileReference;[^}]*path = SceneDelegate\.swift;/);
    expect(pbx).toMatch(/\/\* SceneDelegate\.swift in Sources \*\/,/);
  });

  it("AppDelegate hands every scene session to SceneDelegate", () => {
    const app = read("ios/App/App/AppDelegate.swift");
    expect(app).toMatch(/configurationForConnecting connectingSceneSession: UISceneSession/);
    expect(app).toContain("config.delegateClass = SceneDelegate.self");
  });

  it("Xcode Cloud's build floor stays above the build number in the pbxproj", () => {
    const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]));
    expect(builds.length).toBe(2);
    expect(new Set(builds).size).toBe(1);
    const floor = Number(read("ios/App/ci_scripts/ci_pre_xcodebuild.sh").match(/^MIN_BUILD=(\d+)$/m)[1]);
    expect(floor).toBeGreaterThan(builds[0]);
  });
});
