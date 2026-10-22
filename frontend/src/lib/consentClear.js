/**
 * Where the cookie banner may sit, and what may move it (components/CookieConsent.jsx).
 *
 * CLEAR: a bar the banner must sit on, never over (the app's bottom tab bar, the "+" button, the staff portal's
 * bar, the landing's bottom bar with "Prøv gratis").
 *
 * SKIP (landing v6, port step 7; PORT_PLAN 1.5): a page that writes classes and styles on every scroll frame (the
 * landing's scroll engine, components/landing/v6/engine.js) marks its root data-bb-consent-skip. Its own churn never
 * moves a bar the banner sits on, and while the banner is open (a first visit) re-measuring on it would force a
 * layout per frame. So a DOM change inside a marked subtree is ignored, unless it lands on a marked bar itself (the
 * landing's bottom bar showing, hiding or lifting). Changes outside it count as before, and the page mounting,
 * re-keying or leaving is a change on its parent: it counts.
 *
 * Its own module (not CookieConsent.jsx) so the component file exports components and the banner's helpers only.
 */
export const CONSENT_CLEAR_SELECTOR = "[data-bb-consent-clear]";
export const CONSENT_SKIP_SELECTOR = "[data-bb-consent-skip]";

/** Whether a MutationRecord may have moved a bar the banner must sit above. Fails open (an odd record counts). */
export function consentChangeMatters(record) {
  const el = record && record.target;
  if (!el || el.nodeType !== 1 || typeof el.closest !== "function") return true;
  try {
    if (el.matches(CONSENT_CLEAR_SELECTOR)) return true;
    return !el.closest(CONSENT_SKIP_SELECTOR);
  } catch {
    return true;
  }
}
