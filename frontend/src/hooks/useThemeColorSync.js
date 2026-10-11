import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { syncThemeColor } from "../utils/themeColor";

/**
 * The browser bar follows the ROUTE as well as the theme.
 *
 * useDarkMode writes theme-color when the theme flips, but it lives in the app
 * shell (Layout): on an in-app hop to a page that never renders dark — signing
 * out and tapping the logo to the landing page, say — nothing reset it, and the
 * white page got the dark bar. This re-reads the theme from <html class="dark">
 * (index.html and useDarkMode both keep it there) on every pathname change.
 * Light always resolves to #ffffff, the static value, so light is unchanged.
 */
export function useThemeColorSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (typeof document === "undefined") return;
    syncThemeColor(document.documentElement.classList.contains("dark"), pathname);
  }, [pathname]);
}
