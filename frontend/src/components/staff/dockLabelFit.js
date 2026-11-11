/**
 * The dock's five tab names at large text.
 *
 * The names are 11 px on one line in columns ~57 px wide at 320 px. When the
 * phone's text is larger (Chrome on Android follows the system text size;
 * the Android app allows one step up), "Beskeder" ellipsized to "Besked…".
 * Instead, all five shrink TOGETHER to the size the longest one needs —
 * one shared size, so the dock never shows mixed sizes. Proportional, so it
 * works whatever scaled the text (text zoom or page zoom). Ellipsis stays as
 * the last resort below 8 px. At normal size nothing overflows and the
 * variable is never set: the dock looks exactly as before.
 */
export const DOCK_LABEL_PX = 11;
export const DOCK_LABEL_MIN_PX = 8;
const LABEL_PAD = 4; // .vp-dock-label padding: 0 2px

/** Measures the labels inside `nav` at their normal size and sets
    --vp-dock-fs on it when one overflows. Returns the px set, or null. */
export function fitDockLabels(nav) {
  if (!nav) return null;
  nav.style.removeProperty("--vp-dock-fs");          // measure at the normal 11 px
  let ratio = 1;
  for (const el of nav.querySelectorAll(".vp-dock-label")) {
    const have = el.clientWidth - LABEL_PAD;
    const need = el.scrollWidth - LABEL_PAD;
    if (have > 0 && need > have) ratio = Math.min(ratio, have / need);
  }
  if (ratio >= 1) return null;
  // 0.97: room for sub-pixel rounding, so a shrunk name never ends in "…".
  const px = Math.max(DOCK_LABEL_MIN_PX, Math.floor(DOCK_LABEL_PX * ratio * 0.97 * 10) / 10);
  nav.style.setProperty("--vp-dock-fs", `${px}px`);
  return px;
}
