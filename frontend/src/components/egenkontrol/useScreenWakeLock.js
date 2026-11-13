/**
 * Keep the kitchen iPad's screen on while the page is visible (Screen Wake
 * Lock API). Released when the page hides — the browser drops it anyway — and
 * asked for again when it comes back. Where the API is missing (older iOS
 * Safari) `supported` is false and the page shows the Auto-Lock help line.
 * Every call is guarded: a refused lock is never an error on screen.
 */
import { useEffect, useState } from "react";

export default function useScreenWakeLock(enabled = true) {
  const [supported] = useState(
    () => typeof navigator !== "undefined" && !!navigator.wakeLock && typeof navigator.wakeLock.request === "function",
  );

  useEffect(() => {
    if (!enabled || !supported) return undefined;
    let lock = null;
    let alive = true;
    const request = async () => {
      if (!alive || lock || document.visibilityState !== "visible") return;
      try {
        const l = await navigator.wakeLock.request("screen");
        if (!alive) {
          try { await l.release(); } catch { /* already gone */ }
          return;
        }
        lock = l;
        l.addEventListener?.("release", () => {
          if (lock === l) lock = null;
        });
      } catch {
        /* refused (battery saver, not allowed) — the help line covers it */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") request();
    };
    request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      const l = lock;
      lock = null;
      if (l) l.release().catch(() => {});
    };
  }, [enabled, supported]);

  return { supported };
}
