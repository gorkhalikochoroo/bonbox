/**
 * The native app shells (Capacitor iOS / Android) serve the app from the
 * phone itself and use neither a service worker nor Cache Storage: index.html
 * no longer registers /sw.js there (618875fa). A phone that ran an earlier
 * build can still hold that old registration and its "bonbox-*" caches (the
 * Android WebView kept an empty "bonbox-v10"). Once per start, inside a native
 * shell only, unregister them and drop those caches. Browsers are untouched:
 * there the worker carries push and the installed app.
 *
 * Never throws and never blocks the start. Resolves the number of jobs tried.
 *
 * Called from main.jsx, so it reads the shell the way the entry already does
 * (window.Capacitor, set by the native bridge before the page's scripts run)
 * rather than importing utils/platform: that would pull @capacitor/core into
 * the first chunk every landing and booking page loads.
 */
function inNativeShell() {
  try {
    return typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

export function dropNativeShellLeftovers({
  isNative = inNativeShell(),
  nav = typeof navigator !== "undefined" ? navigator : undefined,
  store = typeof caches !== "undefined" ? caches : undefined,
} = {}) {
  if (!isNative) return Promise.resolve(0);
  const jobs = [];
  try {
    if (nav?.serviceWorker?.getRegistrations) {
      jobs.push(Promise.resolve()
        .then(() => nav.serviceWorker.getRegistrations())
        .then((regs) => Promise.all((regs || []).map((r) => r.unregister())))
        .catch(() => {}));
    }
    if (store?.keys) {
      jobs.push(Promise.resolve()
        .then(() => store.keys())
        .then((keys) => Promise.all((keys || []).filter((k) => String(k).startsWith("bonbox-")).map((k) => store.delete(k))))
        .catch(() => {}));
    }
  } catch { /* never block the start */ }
  return Promise.all(jobs).then(() => jobs.length);
}
