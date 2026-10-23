/* The reader's place across a language switch (LandingV6Page re-keys the whole page on DK ⇄ EN; fix round, 22 Oct).
 *
 * Taken just before setLang, put back right after the new language's engine has laid the page out:
 *   - the switch that was used (top bar or footer) gets the focus back, so a keyboard reader is not sent to the top of
 *     the page (WCAG 2.4.3). Only when that switch had the focus as it was used (Simulator round, 23 Oct): a keyboard,
 *     assistive tech, or a browser that focuses a clicked button. A tap in iOS Safari never focuses a button, so there the
 *     re-keyed page keeps no focus, as a page that was never switched. (In the Simulator the first tap on the bottom bar's
 *     "Prøv gratis" after a switch did nothing. Headless Chromium does not reproduce it, and there the re-keyed page equals
 *     a page loaded in that language except for this focus (and which of the clock's two digit layers shows), so this is the
 *     likely cause, not a measured one: to be re-checked in the Simulator.)
 *   - the FAQ answers that were open are open again;
 *   - in the morning sheet, the first section still on screen sits where it sat (the two languages' texts differ in
 *     height). In the day itself the engine's layout keeps the place (same track in both languages), so nothing moves. */
/* the morning sheet's sections, top to bottom: the first one still on screen is the reader's place there */
const SHEET_PLACES = ["mere", "pricing", "tryghed", "faq", "foot"];
/* the switch that was used: the top bar's or the footer's DK · EN */
const switchSel = (from) => (from === "foot" ? ".foot" : ".top") + " .lang";

/** Where the reader is, taken just before a language switch: which switch (top bar or footer) and whether it had the
 *  focus, which FAQ answers are open, and, once the sheet is on screen, its first section still in view and that section's top. */
export function placeOf(root, from, to) {
  const sw = root.querySelector(switchSel(from)), a = document.activeElement;
  const place = { from, to, focus: !!(sw && a && sw.contains(a)), open: [...root.querySelectorAll("details")].map((d) => d.open), anchor: null, top: 0 };
  for (const id of SHEET_PLACES) {
    const el = root.querySelector("#" + id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > 0) {
      if (r.top < window.innerHeight) { place.anchor = id; place.top = r.top; }
      break;
    }
  }
  return place;
}

/** …and put back on the new language's page, after its engine has laid it out. */
export function putPlaceBack(root, place) {
  root.querySelectorAll("details").forEach((d, i) => { if (place.open[i]) d.open = true; });
  const el = place.anchor && root.querySelector("#" + place.anchor);
  if (el) {
    const dy = Math.round(el.getBoundingClientRect().top - place.top);
    if (dy) { try { window.scrollTo({ top: window.scrollY + dy, behavior: "instant" }); } catch { window.scrollTo(0, window.scrollY + dy); } }
  }
  const b = place.focus && root.querySelector(switchSel(place.from) + " .lg-alt button");
  if (b) { try { b.focus({ preventScroll: true }); } catch { /* an old browser: focus stays where it is */ } }
}
