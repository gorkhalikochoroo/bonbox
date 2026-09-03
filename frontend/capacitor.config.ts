import type { CapacitorConfig } from "@capacitor/cli";

/**
 * TWO app targets share this repo:
 *
 *   • BonBox (owner app)        — default          → ios/          webDir dist/
 *   • BonBox Scheduler (staff)  — BONBOX_TARGET=scheduler → ios-scheduler/ webDir dist-scheduler/
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
  appName: isScheduler ? "BonBox Scheduler" : "BonBox",
  webDir: isScheduler ? "dist-scheduler" : "dist",

  ios: {
    path: isScheduler ? "ios-scheduler" : "ios",
    // Scheduler: the staff portal owns its safe areas in CSS (the header pads
    // by env(safe-area-inset-top) + draws an opaque cap over the notch). With
    // contentInset "automatic" WKWebView ALSO insets the scroll view for the
    // status bar, so the two stack → a fat empty gap under the notch. "never"
    // hands safe-area handling entirely to CSS (single, correct inset). The
    // owner app keeps "automatic" (its chrome doesn't do CSS insets).
    // 2026-09-03 — SCHEDULER REVERTS TO "automatic". iOS OWNS THE TOP INSET.
    //
    // The CSS-owns-it model below is correct in theory and stopped working in
    // practice: on iOS 26.4 / Capacitor 8, overlaysWebView:true no longer
    // propagates a top safe-area inset to web content. env(safe-area-inset-top)
    // resolves to 0 while the webview still covers the status bar, so the
    // portal header rendered UNDER the notch, on top of the clock. Measured:
    // the title row and the status-bar clock both land at y=80-110 in a device
    // screenshot; with this change the clock stays at 80-110 and the title
    // moves to 210-260 where it belongs.
    //
    // NOT a regression from the bar-material work — a build from the previous
    // source reproduced it exactly. The bottom inset was never affected
    // (nav height identical at 262px before and after), which is what makes
    // this specifically a top-inset propagation failure rather than a layout
    // bug of ours.
    //
    // The old comment warned that "automatic" double-insets into a fat gap.
    // It cannot now: the two mechanisms are mutually exclusive. iOS insets the
    // webview below the status bar, which makes env(safe-area-inset-top) 0, so
    // the CSS padding that would have stacked contributes nothing. Verified on
    // device — no gap, and the sticky header stays pinned to the pixel across
    // 18 mid-fling frames.
    //
    // CONSEQUENCE, stated rather than discovered later: the portal's notch cap
    // (.bb-lg-cap) is sized by env(safe-area-inset-top), so it is now zero-height
    // and inert in the iOS app. Nothing needs it there — the native view paints
    // the status-bar strip. It still applies on bonbox.dk/s/<token> in browsers
    // that report a top inset.
    //
    // The owner app keeps "never" — its chrome does its own CSS insets and it
    // is not affected by this.
    // BOTH targets now: "never" hands safe-area handling entirely to CSS.
    //
    // With "automatic" WKWebView is inset inside the safe areas, so the strips
    // above the status bar and below the home indicator are painted by the
    // NATIVE view using ios.backgroundColor — one static build-time colour for
    // a runtime theme toggle. Measured on device in dark mode: a 34pt band of
    // rgb(248,250,252) from 840-874pt under the tab bar, and 8pt at the top.
    // Flipping shellBg only moves which theme is wrong.
    //
    // With the webview covering the screen, index.css's html/html.dark
    // background paints those strips and they follow the live theme. body
    // already pads by env(safe-area-inset-*), and Layout's mobile header pads
    // by env(safe-area-inset-top) itself, so content stays clear.
    contentInset: isScheduler ? "automatic" : "never",
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
      // Scheduler: draw the webview UNDER the status bar so CSS owns the safe
      // area (the portal header pads by env(safe-area-inset-top) + caps the
      // notch). Without this, iOS ALSO offsets the webview below the status bar
      // and the two stack into a fat gap — contentInset:"never" alone doesn't
      // fix it because the offset is the frame, not the scroll inset. The owner
      // app keeps the default (its chrome doesn't do CSS safe-area insets).
      // Required alongside contentInset "never" — the config note below is
      // right that "never" alone is not enough, because iOS also offsets the
      // webview FRAME, not just the scroll inset.
      // false for the scheduler — see the contentInset note above.
      overlaysWebView: !isScheduler,
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
