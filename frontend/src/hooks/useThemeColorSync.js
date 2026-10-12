import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { syncThemeColor } from "../utils/themeColor";
import { GUEST_SURFACE_EVENT } from "../lib/guestSurface";

/**
 * The browser bar follows the ROUTE as well as the theme.
 *
 * useDarkMode writes theme-color when the theme flips, but it lives in the app
 * shell (Layout): on an in-app hop to a page that never renders dark — signing
 * out and tapping the logo to the landing page, say — nothing reset it, and the
 * white page got the dark bar. This re-reads the theme from <html class="dark">
 * (index.html and useDarkMode both keep it there) on every pathname change.
 * Light resolves to paper (#f6f4ec) since 12 Oct 2026, white on pages that
 * paint their own white page — including a mounted guest page, which is why
 * this also re-syncs on GUEST_SURFACE_EVENT (the vanity /<slug> booking page is
 * only recognisable once it has marked itself).
 */
export function useThemeColorSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const sync = () => syncThemeColor(document.documentElement.classList.contains("dark"), pathname);
    sync();
    window.addEventListener(GUEST_SURFACE_EVENT, sync);
    return () => window.removeEventListener(GUEST_SURFACE_EVENT, sync);
  }, [pathname]);
}
