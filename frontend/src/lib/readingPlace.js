/**
 * The staffer's READING place in the staff portal (BonBox Vagtplan) — what
 * they had scrolled to, for when the layout changes under them.
 *
 * StaffPortalPage already keeps the place a staffer TAPPED (portalPlace: the
 * form they opened, the day they picked) on screen across a rotation. A
 * staffer who only scrolled had no place at all. On an iPad in portrait,
 * scrolled down to the week list (MAN. 12 … SØN. 18), a rotation to
 * landscape clamped the scroll (two columns are shorter) and the way back
 * left the hero's "Stempl ud" at the top and the week they were reading below
 * the fold.
 *
 * So, on the staffer's own scrolls, this notes the element at the top of the
 * content column and how far it sat below the header; after a layout change
 * it puts that element back at the same distance. Scrolls that the layout
 * makes (the clamp after a rotation, this module's own restore) happen inside
 * a short quiet window and are not mistaken for the staffer moving: the
 * place read in portrait survives the round trip through landscape.
 *
 * A phone never changes layout mode, so for a phone this is bookkeeping only.
 * Without document.elementFromPoint (old WebViews, tests' DOM) it does nothing.
 */
const reading = { chain: [], offset: 0 };
let quietUntil = 0;

const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

/** The layout is about to move the page: ignore scrolls for a moment. */
export function quietReading(ms = 700) {
  quietUntil = now() + ms;
}

/** Forget the reading place (e.g. on leaving the page). */
export function clearReading() {
  reading.chain = [];
  reading.offset = 0;
}

/** For tests: what is held. */
export function readingSnapshot() {
  return { chain: reading.chain.slice(), offset: reading.offset };
}

function headerBottom(scroller, header) {
  if (header) return header.getBoundingClientRect().bottom;
  return Math.max(0, scroller.getBoundingClientRect().top);
}

/**
 * Note the element at the top of the content column — call it on the
 * staffer's own scroll. At the very top there is nothing to keep.
 */
export function recordReading(scroller, header) {
  if (!scroller || now() < quietUntil) return;
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return;
  const content = scroller.querySelector("[data-portal-content]");
  if (!content) return;
  if (scroller.scrollTop <= 0) {
    clearReading();
    return;
  }
  const top = headerBottom(scroller, header);
  const c = content.getBoundingClientRect();
  if (c.width <= 0) return;
  // Inside the first column, a little in from its edge (the card padding).
  const x = Math.min(c.left + 32, c.right - 1);
  const hit = document.elementFromPoint(x, top + 2);
  if (!hit || !content.contains(hit) || hit === content) return;
  const chain = [];
  for (let n = hit; n && n !== content && chain.length < 12; n = n.parentElement) chain.push(n);
  reading.chain = chain;
  reading.offset = hit.getBoundingClientRect().top - top;
}

/**
 * After a layout change: put the reading place back where it was under the
 * header. Returns true when it moved the page.
 */
export function restoreReading(scroller, header) {
  quietReading();
  if (!scroller) return false;
  const el = reading.chain.find((n) => n.isConnected && n.getBoundingClientRect().height > 0);
  if (!el) return false;
  const top = headerBottom(scroller, header);
  const at = el === reading.chain[0] ? reading.offset : 0;
  const delta = el.getBoundingClientRect().top - top - at;
  if (Math.abs(delta) < 1) return false;
  scroller.scrollTop += delta;
  return true;
}
