import { Capacitor } from "@capacitor/core";

export const platform = {
  isNative: Capacitor.isNativePlatform(),
  isIOS: Capacitor.getPlatform() === "ios",
  isAndroid: Capacitor.getPlatform() === "android",
  isWeb: Capacitor.getPlatform() === "web",
};

/** Detect iPad (useful for layout decisions on native) */
export const isIPad = () => {
  if (platform.isIOS) return window.screen.width >= 768;
  return /iPad|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;
};
