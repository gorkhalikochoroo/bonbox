import { Capacitor } from "@capacitor/core";

export const platform = {
  isNative: Capacitor.isNativePlatform(),
  isIOS: Capacitor.getPlatform() === "ios",
  isAndroid: Capacitor.getPlatform() === "android",
  isWeb: Capacitor.getPlatform() === "web",
};

/**
 * Running inside the native app shell (Capacitor iOS/Android)?
 *
 * App Store compliance (Apple Guideline 3.1.1): the native iOS app may NOT
 * sell, present a button/link/CTA to purchase, or link out to an external
 * (web/Stripe) checkout for a paid subscription. Every upgrade/purchase
 * surface is gated on this — a single missed CTA on iOS = another rejection.
 * The web app keeps full self-serve billing.
 */
export function isNativeApp() {
  return platform.isNative;
}

/**
 * True when in-app purchase/upgrade UI is allowed (web only, for now).
 * On native, callers render plans read-only and drop every "Upgrade /
 * See plans / Subscribe" button, link, and price.
 */
export function canPurchaseInApp() {
  return !platform.isNative;
}

/** Detect iPad (useful for layout decisions on native) */
export const isIPad = () => {
  if (platform.isIOS) return window.screen.width >= 768;
  return /iPad|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;
};
