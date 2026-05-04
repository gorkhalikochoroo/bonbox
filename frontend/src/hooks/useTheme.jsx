import { useState, useEffect } from "react";

/**
 * Theme manager — sits alongside useDarkMode (which controls light/dark only).
 *
 * useDarkMode → controls light vs dark MODE
 * useTheme    → controls accent THEME (calm / modern / focus / tech)
 *
 * Why two? Because users want to mix: "Calm theme but in dark mode" or
 * "Focus theme in light mode" — every theme works in both modes.
 *
 * Default is "calm" (soft blue) — chosen because the previous default
 * (green/emerald with glow) read as "developer tool" to small-business
 * users, per direct user feedback. "Calm" feels like the accounting
 * software they're used to (Dinero, Billy, e-conomic).
 *
 * Implementation: writes a `data-theme` attribute to <html>; CSS in
 * index.css uses `[data-theme="..."]` selectors to override the most
 * visible green accent classes without rewriting components.
 */

export const THEMES = [
  {
    id: "calm",
    name: "Calm",
    description: "Soft blue. Business-friendly. Default.",
    swatch: "#3b82f6", // blue-500
  },
  {
    id: "modern",
    name: "Modern",
    description: "Lavender. Polished. Linear-style.",
    swatch: "#8b5cf6", // violet-500
  },
  {
    id: "focus",
    name: "Focus",
    description: "Pure monochrome. Zero distraction.",
    swatch: "#475569", // slate-600
  },
  {
    id: "tech",
    name: "Tech",
    description: "Original green. Founder mode.",
    swatch: "#10b981", // emerald-500
  },
];

const DEFAULT_THEME = "calm";
const STORAGE_KEY = "bonbox_theme";

export function useTheme() {
  const [theme, setThemeState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return THEMES.find((t) => t.id === stored) ? stored : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* private mode etc — non-fatal */
    }
  }, [theme]);

  return [theme, setThemeState];
}

/**
 * Apply theme synchronously on script load, BEFORE React hydrates.
 * Prevents the brief "green flash" while React boots.
 *
 * Call this once at the top of main.jsx (before ReactDOM.render).
 */
export function applyThemeImmediately() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const theme = THEMES.find((t) => t.id === stored) ? stored : DEFAULT_THEME;
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    document.documentElement.setAttribute("data-theme", DEFAULT_THEME);
  }
}
