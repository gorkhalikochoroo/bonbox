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

/* Native chrome follows each app's canvas: the owner app is dark (#0d1117),
   the staff portal lives on bg-gray-50 — a dark status bar / webview behind
   it flashes black on load and leaves unreadable light-on-light glyphs. */
const shellBg = isScheduler ? "#f9fafb" : "#0d1117";

const config: CapacitorConfig = {
  appId: isScheduler ? "dk.bonbox.scheduler" : "dk.bonbox.app",
  appName: isScheduler ? "BonBox Scheduler" : "BonBox",
  webDir: isScheduler ? "dist-scheduler" : "dist",

  ios: {
    path: isScheduler ? "ios-scheduler" : "ios",
    contentInset: "automatic",
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
      launchShowDuration: 2000,
      launchAutoHide: true,
      // Splash art was drawn for the dark background — both targets keep it.
      backgroundColor: "#0d1117",
      showSpinner: false,
    },
    StatusBar: {
      // Capacitor naming: DARK = light text on dark bg, LIGHT = dark text.
      style: isScheduler ? "LIGHT" : "DARK",
      backgroundColor: shellBg,
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
