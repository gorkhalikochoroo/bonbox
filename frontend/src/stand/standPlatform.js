// The door screen's platform (R11, rubric B11) — what utils/platform.js is,
// in the door screen's own build only (scripts/standBuild.mjs swaps it in).
//
// stand.html is served to browsers only: the Capacitor app loads index.html,
// and a /stand/<token> opened inside it stays in the app's own routes. So the
// door screen is always "web", and the Capacitor runtime (~5 kB gzip) has
// nothing to answer here. Same exports, the web answers.
export const platform = {
  isNative: false,
  isIOS: false,
  isAndroid: false,
  isWeb: true,
};

export function isNativeApp() {
  return false;
}

export function canPurchaseInApp() {
  return true;
}

/** Detect iPad (the web answer of utils/platform.js). */
export const isIPad = () => /iPad|Macintosh/.test(navigator.userAgent) && "ontouchend" in document;
