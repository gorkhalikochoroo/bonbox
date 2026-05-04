import { useEffect, useState, useRef } from "react";

/**
 * Multi-layer defense — Layer 5 (frontend).
 *
 * Listens for `bonbox:soft-error` events dispatched by the api interceptor
 * when a backend endpoint returns a graceful error (HTTP 200 with `_error`
 * flag, or a 4xx with `_error` body). Shows a dismissable yellow banner so
 * the user knows something went wrong but the rest of the page still works.
 *
 * Design rules:
 *   - Non-blocking: never covers the whole page
 *   - Stacks: multiple errors visible briefly, auto-dismiss after 8s
 *   - Per-URL deduping so a polling page doesn't spam banners
 *   - Inert if no errors — zero render cost
 */
export default function SoftErrorBanner() {
  const [errors, setErrors] = useState([]);
  // Track recent URL+message combos so we don't spam duplicates
  const recentRef = useRef(new Map());

  useEffect(() => {
    function onSoftError(ev) {
      try {
        const { message, recoverable, url } = ev.detail || {};
        if (!message) return;

        const key = `${url || ""}|${message}`;
        const now = Date.now();
        const last = recentRef.current.get(key) || 0;
        // Suppress duplicate within 5s
        if (now - last < 5000) return;
        recentRef.current.set(key, now);

        const id = Math.random().toString(36).slice(2, 9);
        setErrors((prev) => [
          ...prev.slice(-2), // keep at most 3 stacked
          { id, message, recoverable: !!recoverable },
        ]);
        // Auto-dismiss after 8s
        setTimeout(() => {
          setErrors((prev) => prev.filter((e) => e.id !== id));
        }, 8000);
      } catch (_) {
        /* ignore */
      }
    }
    window.addEventListener("bonbox:soft-error", onSoftError);
    return () => window.removeEventListener("bonbox:soft-error", onSoftError);
  }, []);

  if (errors.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"
    >
      {errors.map((e) => (
        <div
          key={e.id}
          className="pointer-events-auto flex items-start gap-2 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 shadow-lg"
        >
          <span className="text-lg shrink-0">⚠️</span>
          <div className="flex-1 text-sm text-amber-900 dark:text-amber-200">
            {e.message}
          </div>
          <button
            type="button"
            onClick={() => setErrors((prev) => prev.filter((x) => x.id !== e.id))}
            aria-label="Dismiss"
            className="shrink-0 text-amber-600 hover:text-amber-800 dark:hover:text-amber-300 text-lg leading-none"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
