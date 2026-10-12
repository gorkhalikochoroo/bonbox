import { useState, useEffect } from "react";
import { syncThemeColor } from "../utils/themeColor";

export function useDarkMode() {
  // Default to LIGHT mode unless the user has explicitly chosen dark.
  // Was previously the reverse — but feedback was that new users found
  // a dark default unfriendly for an accounting tool. Now: light first,
  // dark is opt-in via the toggle in More page / Layout sidebar.
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");

  useEffect(() => {
    if (dark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
    // The browser bar follows the theme on a live toggle too (index.html sets
    // it before first paint). See utils/themeColor.js.
    syncThemeColor(dark);
  }, [dark]);

  return [dark, () => setDark(!dark)];
}
