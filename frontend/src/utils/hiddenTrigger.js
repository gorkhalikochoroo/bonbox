/**
 * Clicking a hidden [data-*-toggle] trigger, without the silence.
 *
 * Two surfaces open a sheet they do not own: the phone tab bar's centre "+"
 * clicks QuickAdd's hidden trigger, and the mobile header's ✨ clicks
 * BonBoxAgent's. Both did it as
 *
 *     document.querySelector("[data-quickadd-toggle]")?.click();
 *
 * and the `?.` is the whole defect: an unmounted target and a successful open
 * are the same expression, so a button that resolved to nothing looked exactly
 * like a button that worked. That is the repo's top trust defect — a CTA that
 * does nothing — expressed as one character of syntax.
 *
 * This returns whether it actually clicked something, so the caller HAS to say
 * what happens otherwise. It deliberately does not take a fallback callback:
 * the useful destination differs per caller, and burying it here is how the
 * next caller ends up passing nothing again.
 *
 * @param {string} selector — e.g. "[data-quickadd-toggle]"
 * @returns {boolean} true if a trigger was found and clicked
 */
export function clickHiddenTrigger(selector) {
  if (typeof document === "undefined") return false;
  let el = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return false; // malformed selector — treated as "nothing there"
  }
  if (!el || typeof el.click !== "function") return false;
  el.click();
  return true;
}
