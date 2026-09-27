/**
 * Value colours for StatCard and StatStrip — kept in their own module so both
 * component files export only components (React fast refresh needs that).
 */
// Accent palette — only the VALUE color changes. Background/border stay
// neutral so a row of mixed-accent tiles still reads as a single block.
export const ACCENT_VALUE_CLASS = {
  neutral: "text-gray-900 dark:text-gray-100",
  critical: "text-red-600 dark:text-red-400",
  warn: "text-amber-600 dark:text-amber-400",
  success: "text-emerald-600 dark:text-emerald-400",
};
