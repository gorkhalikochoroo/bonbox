/**
 * Fetch the dictionaries in `codes` that are not loaded yet, once the page is
 * idle (requestIdleCallback, or 1.5 s where there is none, as in Safari), so
 * a later switch to one of them shows at once. Nothing renders and nothing
 * else changes: the provider still loads a language when it is picked; it
 * just finds it in the cache (lib/localeStore.js). Returns a cancel function.
 *
 * Why (Android 14 walk, 12 Nov 2026): switching DA in the staff app's profile
 * took 2-3 s to repaint on a slow WebView, while the other dictionary's chunk
 * loaded. The staff portal asks for its two offered languages, DA and EN.
 *
 * Its own module, on localeStore's public API only: the door screen's build
 * swaps localeStore for stand/standLocales.js, which must export everything
 * localeStore does (r11.standBuild); the door screen never preloads.
 */
import { hasLocale, loadLocale, loadedLocales } from "./localeStore";

export function preloadLocalesWhenIdle(codes, { timeout = 4000 } = {}) {
  const want = (codes || []).filter((c) => hasLocale(c) && !loadedLocales()[c]);
  if (!want.length || typeof window === "undefined") return () => {};
  let off = false;
  const run = () => {
    if (off) return;
    off = true;
    want.forEach((c) => { loadLocale(c).catch(() => { /* offline: the switch loads it as before */ }); });
  };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(run, { timeout });
    return () => { off = true; window.cancelIdleCallback?.(id); };
  }
  const id = setTimeout(run, 1500);
  return () => { off = true; clearTimeout(id); };
}
