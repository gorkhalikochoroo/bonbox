import { useCallback, useMemo, useSyncExternalStore } from "react";

// Does a CSS media query match right now? Subscribes to the query's own
// change event, so the answer follows a window or an iPad split view that
// crosses the breakpoint. No state set in an effect, and never derived from
// innerWidth (zoom and scrollbars make that disagree with CSS).
//
// Without matchMedia (jsdom, a very old browser) the answer is false, as it
// is on the server.
//
// One MediaQueryList per query (useMemo): getSnapshot runs on every render
// of the page — every keystroke in the guest form — and reads its .matches
// instead of building and evaluating a new list each time.
export function useMediaQuery(query) {
  const mql = useMemo(
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null),
    [query],
  );
  const subscribe = useCallback(
    (onChange) => {
      if (!mql) return () => {};
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      // Safari before 14 only has the older listener API.
      mql.addListener?.(onChange);
      return () => mql.removeListener?.(onChange);
    },
    [mql],
  );
  const getSnapshot = () => !!mql && !!mql.matches;
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
