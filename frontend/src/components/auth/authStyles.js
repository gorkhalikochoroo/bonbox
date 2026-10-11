/**
 * Class strings for the auth pages' controls (push 6) — kept apart from the
 * components in AuthUI.jsx so that file exports components only.
 *
 * Contrast (measured): gray-600 on paper 6.86:1; the field edge bb-line
 * 3.26:1 on paper / 3.59:1 on white; paper on forest 11.6:1.
 */

/** Text link: underlined, and a 44 px tall hit area that does not move the text. */
export const linkClass =
  "text-gray-700 dark:text-gray-300 underline underline-offset-4 decoration-gray-400 hover:text-gray-900 dark:hover:text-white py-3 -my-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bb-forest dark:focus-visible:ring-gray-200";

/** A field's input classes; `invalid` paints the edge red-700. */
export function inputClass(invalid = false) {
  return (
    "block w-full h-12 px-3.5 rounded-lg bg-white dark:bg-gray-900 border text-base text-gray-900 dark:text-gray-100 " +
    "placeholder:text-gray-500 dark:placeholder:text-gray-400 " +
    "focus:outline-none focus:border-bb-forest focus:ring-[3px] focus:ring-bb-forest/20 " +
    "dark:focus:border-gray-200 dark:focus:ring-white/20 transition-colors duration-150 disabled:opacity-60 " +
    (invalid ? "border-red-700 dark:border-red-400" : "border-bb-line dark:border-gray-600")
  );
}

const PRIMARY_BASE =
  "h-12 w-full inline-flex items-center justify-center gap-2 rounded-lg text-[16px] font-semibold " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bb-paper " +
  "dark:focus-visible:ring-offset-gray-950 disabled:opacity-60 disabled:cursor-not-allowed transition-colors duration-150";

/**
 * forest — /register and /login (Manoj, B7): forest with paper text, 11.6:1.
 * ink    — every other auth surface keeps the app's gray-900 primary.
 */
export const PRIMARY = {
  forest:
    PRIMARY_BASE +
    " bg-bb-forest text-bb-paper hover:bg-bb-forest/90 focus-visible:ring-bb-forest" +
    " dark:bg-bb-paper dark:text-bb-forest dark:hover:bg-bb-paper/90 dark:focus-visible:ring-bb-paper",
  ink:
    PRIMARY_BASE +
    " bg-gray-900 text-white hover:bg-gray-800 focus-visible:ring-gray-900" +
    " dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white dark:focus-visible:ring-gray-100",
};

/** The quiet secondary button (Cancel, and the like). */
export const SECONDARY =
  "h-12 w-full inline-flex items-center justify-center rounded-lg border border-bb-line dark:border-gray-600 bg-white dark:bg-gray-900 " +
  "text-[16px] font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bb-forest dark:focus-visible:ring-gray-200 transition-colors duration-150";
