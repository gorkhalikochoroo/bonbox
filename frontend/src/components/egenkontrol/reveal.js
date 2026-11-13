/**
 * Bring one step of the "Registrér" panel into view — inside the panel's own
 * scroll area (marked data-ek-scroll), never by scrolling the page behind the
 * sheet — and put the focus on it.
 *
 * Why: on the kitchen iPad the save button read "Vælg hvem der målte" while
 * "Hvem målte?" sat below the fold, and "Andet navn" opened a name field that
 * was half hidden and not focused, so the letters typed went nowhere.
 *
 * Focus first with preventScroll (we scroll ourselves, inside the panel), and
 * from the tap's own handler: iOS only raises the keyboard for a focus() made
 * while handling the tap.
 */

const SCROLL_SEL = "[data-ek-scroll]";

function reducedMotion() {
  try {
    return !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The part of the screen the person can actually see: the visual viewport
 * (it shrinks for the on-screen keyboard and moves with pinch-zoom), else
 * 0 … innerHeight.
 */
export function visibleBand() {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (vv && Number.isFinite(vv.height) && vv.height > 0) {
    const top = Number(vv.offsetTop) || 0;
    return { top, bottom: top + vv.height };
  }
  const h = typeof window !== "undefined" ? Number(window.innerHeight) : NaN;
  return { top: 0, bottom: Number.isFinite(h) && h > 0 ? h : Infinity };
}

/**
 * Scroll `scroller` so `el` is in view (centred). No-op when it already is.
 *
 * "In view" is measured against the scroller's box CLAMPED to what is on
 * screen: in landscape the "Registrér" column once ran below the bottom of
 * the iPad, its own box said "the action row is inside me", and nothing
 * scrolled while the row sat under the fold (R1a review). When the scroller
 * itself is entirely off screen it is brought into view first.
 */
export function scrollWithin(scroller, el) {
  if (!scroller || !el) return;
  let raw;
  let r;
  try {
    raw = scroller.getBoundingClientRect();
    r = el.getBoundingClientRect();
  } catch {
    return;
  }
  const band = visibleBand();
  let s = { top: Math.max(raw.top, band.top), bottom: Math.min(raw.bottom, band.bottom) };
  if (!(s.bottom > s.top)) {
    // The panel is off screen as a whole: show it, then measure again.
    try { scroller.scrollIntoView({ block: "nearest" }); } catch { /* old engines */ }
    try {
      raw = scroller.getBoundingClientRect();
      r = el.getBoundingClientRect();
    } catch {
      return;
    }
    s = { top: Math.max(raw.top, band.top), bottom: Math.min(raw.bottom, band.bottom) };
    if (!(s.bottom > s.top)) s = { top: raw.top, bottom: raw.bottom };
  }
  s.height = s.bottom - s.top;
  if (r.top >= s.top && r.bottom <= s.bottom) return; // already fully visible
  const room = s.height - r.height;
  // Centred; a step taller than the view starts at its top, with a little air.
  const delta = room > 0 ? r.top - s.top - room / 2 : r.top - s.top - 12;
  const top = Math.max(0, Math.round((scroller.scrollTop || 0) + delta));
  try {
    if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
    else scroller.scrollTop = top;
  } catch {
    scroller.scrollTop = top;
  }
}

function focusOnly(el) {
  if (!el || typeof el.focus !== "function") return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    try { el.focus(); } catch { /* not focusable */ }
  }
}

/**
 * Focus `field` and scroll the step that holds it (`section`, default the
 * field itself) into view inside the panel. A text field is put back in view
 * once more after the on-screen keyboard has changed the visible area: the
 * Sheet shrinks to that area, and the field can end up under the keyboard.
 */
export function revealField(field, section = null) {
  const target = section || field;
  if (!target) return;
  if (field) focusOnly(field);
  const scroller = typeof target.closest === "function" ? target.closest(SCROLL_SEL) : null;
  if (scroller) scrollWithin(scroller, target);
  else if (typeof target.scrollIntoView === "function") {
    try { target.scrollIntoView({ block: "nearest" }); } catch { /* old engines */ }
  }

  const typing = field && field.tagName === "INPUT";
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!typing || !scroller || !vv || typeof vv.addEventListener !== "function") return;
  const again = () => {
    // After the Sheet has re-rendered at the new visible height.
    setTimeout(() => {
      if (document.activeElement === field) scrollWithin(scroller, field);
    }, 60);
  };
  vv.addEventListener("resize", again);
  setTimeout(() => {
    try { vv.removeEventListener("resize", again); } catch { /* noop */ }
  }, 1500);
}

/** The control to focus inside a step: an empty field, a key, else its first button. */
export function focusTargetIn(section) {
  if (!section) return null;
  const fields = 'input[type="text"]:not([disabled]), input[type="date"]:not([disabled]), input[type="time"]:not([disabled])';
  const empty = Array.from(section.querySelectorAll(fields)).find((i) => !String(i.value || "").trim());
  return empty || section.querySelector("[data-key]") || section.querySelector("button:not([disabled])") || section.querySelector(fields);
}
