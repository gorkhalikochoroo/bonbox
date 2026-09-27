import { useEffect, useState } from "react";

/**
 * How many px of the page the on-screen keyboard is covering right now.
 *
 * The layout viewport does not shrink for the iOS keyboard, so anything
 * `position: fixed; bottom: 0` ends up under it. The visual viewport is the
 * only API that reports the visible box. Under ~80px it is collapsing browser
 * chrome or rounding, not a keyboard — ignoring it stops a docked bar from
 * twitching on every scroll. Same measurement as ui/Sheet.jsx.
 */
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return undefined;
    const sync = () => {
      // Pinch-zoom shrinks the visual viewport too — that is not a keyboard,
      // and lifting the bar mid-screen while zoomed would be absurd.
      if (vv.scale && vv.scale > 1.01) {
        setInset(0);
        return;
      }
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      setInset(hidden > 80 ? Math.round(hidden) : 0);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);
  return inset;
}
