import type { CapacitorConfig } from "@capacitor/cli";

/**
 * TWO app targets share this repo:
 *
 *   • BonBox (owner app)        — default          → ios/          webDir dist/
 *   • BonBox Vagtplan (staff)   — BONBOX_TARGET=scheduler → ios-scheduler/ webDir dist-scheduler/
 *     (App Store name "BonBox Vagtplan", home-screen name "Vagtplan"; the
 *     bundle id stays dk.bonbox.scheduler — an App Store app id never changes)
 *
 * The scheduler shell is the same web bundle built with VITE_APP_MODE=scheduler
 * (npm run build:scheduler): it boots straight into the staff portal / join-code
 * screen (see PublicOrDashboard in src/App.jsx) and never shows owner auth or
 * marketing. Every cap CLI call for the scheduler must carry the env var, e.g.
 *   BONBOX_TARGET=scheduler npx cap sync ios
 */
const isScheduler = process.env.BONBOX_TARGET === "scheduler";

/* Native chrome follows each app's canvas. BOTH apps are light now: the owner
   app's pages are #f8fafc and the staff portal is bg-gray-50. The owner value
   was #0d1117 from when that app was dark, which left a measured 34pt band of
   rgb(13,17,23) under the white tab bar and a dark flash on every launch and
   overscroll.

   This pairs with StatusBar.style below and must stay paired: Capacitor's
   naming is inverted (DARK = light text), so a light shell with style "DARK"
   is white glyphs on a white bar — the unreadable case the old note warned
   about, just in the other direction.

   Runtime is already correct — utils/statusBar.js syncs the bar to the live
   theme from Layout.jsx. These two values only govern the launch window
   BEFORE that runs, which is exactly where the flash was. */
const shellBg = isScheduler ? "#f9fafb" : "#f8fafc";

const config: CapacitorConfig = {
  appId: isScheduler ? "dk.bonbox.scheduler" : "dk.bonbox.app",
  appName: isScheduler ? "Vagtplan" : "BonBox",
  webDir: isScheduler ? "dist-scheduler" : "dist",

  ios: {
    path: isScheduler ? "ios-scheduler" : "ios",
    // BOTH apps: "never". The webview covers the whole screen and CSS owns
    // every safe area through env(safe-area-inset-*) — one source, no stacking.
    //
    // Why not "automatic" (what the staff app shipped until 1.6 build 22),
    // measured in the iOS 27 simulator on an iPhone 18 Pro with a lab probe:
    //   • WKWebView insets its scroll view by the safe areas (8 pt top under
    //     the status bar, 34 pt bottom) AND still reports
    //     env(safe-area-inset-bottom) = 34, so the tab bar padded for the home
    //     indicator and the scroll view added a second 34 pt below it.
    //   • The 100dvh shell (812 pt) plus those insets (8 + 34) is taller than
    //     the webview (820 pt), so the OUTER scroll view could be dragged
    //     34 pt. Capacitor turns bouncing off, so it stayed there: the tab bar
    //     rose and a 34 pt band of ios.backgroundColor opened under it — the
    //     "it gets stuck and creates gaps" report. WebKit then shrank the
    //     layout viewport to 786 pt, so the gap outlived scrolling back.
    //     Same on iPad (20 pt).
    //   • The status-bar strip was a native view in ios.backgroundColor above
    //     the white header: a visible seam.
    // With "never" + StatusBar.overlaysWebView true there is no scroll inset to
    // stack and nothing to scroll: the portal header pads by
    // env(safe-area-inset-top) and runs white under the status bar, the tab bar
    // pads by env(safe-area-inset-bottom) and reaches the bottom edge.
    // Measurements and before/after shots: bonbox-lab-state/vagtplan-inset.
    //
    // iPad windows (floating / tiled): the StatusBar plugin re-frames the
    // webview after every resize and pushed it 22 pt down over a black strip,
    // and the window controls sat on the header title. The staff app's root
    // controller handles both natively — ios-scheduler/App/App/
    // VagtplanBridgeViewController.swift. The owner app (ios/) runs the same
    // plugin and has no such controller yet.
    //
    // (2026-09-03 the staff app moved to "automatic" after the header drew
    // under the clock on iOS 26.4. That commit (a5151072) put it down to
    // env(safe-area-inset-top) being 0, but the bundle it was seen on
    // (b8952a40) had no padding rule for the header at all: da18b84a, that
    // morning, had glued the class so Tailwind never emitted it. The missing
    // rule explains the symptom by itself; env() = 0 on iOS 26.4 was never
    // shown. With this setup the iOS 27 simulator reported 62 pt (iPhone 18
    // Pro) and 32 pt (iPad Air 11) on every cold launch — still a simulator,
    // so look at the header under the clock on a real phone before release.)
    contentInset: "never",
    allowsLinkPreview: false,
    backgroundColor: shellBg,
    // Do NOT set preferredContentMode: 'mobile' — breaks iPad responsive layout
    scrollEnabled: true,
  },

  android: {
    backgroundColor: shellBg,
  },

  plugins: {
    SplashScreen: {
      // ~One ceremonial beat, then stillness. This was 2000ms, which is 3-4x
      // the beat and reads as a screen you sit through rather than a launch.
      // launchAutoHide means this is the CEILING, not a floor — the splash
      // goes the moment the web view paints.
      launchShowDuration: 600,
      launchAutoHide: true,
      // Matches the splash art (BonBox mark on white) AND the surface the app
      // actually opens into, so launch has no colour flash. The old value was
      // #0d1117 under a comment claiming the art was "drawn for the dark
      // background" — the art was Capacitor's stock blue logo on white, so the
      // comment described an asset that never existed here.
      backgroundColor: "#FFFFFF",
      showSpinner: false,
    },
    StatusBar: {
      // Capacitor naming: DARK = light text on dark bg, LIGHT = dark text.
      // Both apps launch light, so both want dark glyphs. Keep in step with
      // shellBg above — changing one without the other is the unreadable case.
      style: "LIGHT",
      backgroundColor: shellBg,
      // Draw the webview UNDER the status bar (both apps). Required alongside
      // ios.contentInset "never": with false, the plugin moves the webview
      // FRAME below the status bar and paints that strip itself in
      // backgroundColor — the seam above the staff portal's white header.
      overlaysWebView: true,
    },
    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
