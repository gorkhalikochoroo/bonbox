/* The pictures a language switch waits for (switch-preload round, 23 Oct 2026; the independent check's should-fix).
 *
 * A DK / EN tap re-keys the page (LandingV6Page), and since 23 Oct the new language's pictures are other files (images.js).
 * Measured before this round: the cards on screen stood empty after the switch until the new files came in (1.2 s on a line
 * that delivers a picture in 1.2 s). So, on a tap (keyboard or pointer: both are the button's click), before the switch:
 *   - onScreen() finds the pictures on screen now, on this layout: in the pinned day only the figures the engine shows (.fx.on);
 *     on the stacked page every figure in view. Of each figure, the file this layout renders: the phone / wide / desktop
 *     variants the layout does not use are display:none (no box, so never counted), and the 16.40 phone <picture> takes its
 *     <source> where that source's media matches, as the browser does. A cramped stage (.cramp) hides every screen.
 *   - preloadOnScreen() starts loading only those pictures' twins in the target language (new Image, src, decode()): never the
 *     whole other set. Each file is fetched at most once: the re-keyed page's <img> asks for the same address and the browser
 *     serves it from the document's image cache (or joins the request still on its way).
 *   - LandingV6Page switches when every one has decoded (or failed), or after WAIT_MS, whichever comes first; a second tap
 *     during the wait is the same switch. No picture on screen (the 19.45 room drawing, the 10.00 roster on a phone, the hero,
 *     the morning sheet): null, and the page switches at once.
 * Until the switch the old page stays as it is, its pictures included, so a card is never blank before it. */
import { imagesFor } from "./images";

/** The longest a switch waits for the pictures on screen (ms). */
export const WAIT_MS = 600;

const matches = (q) => {
  try { return !!q && window.matchMedia(q).matches; } catch { return false; }
};

/** The images.js keys of the pictures on screen now, on this layout, on the page in language `from` (document order, each once). */
export function onScreen(root, from) {
  if (!root || root.classList.contains("cramp")) return [];
  const set = imagesFor(from), keyOf = new Map(Object.entries(set).map(([k, v]) => [v.src, k]));
  const story = root.classList.contains("story"), vw = window.innerWidth, vh = window.innerHeight, keys = [];
  for (const img of root.querySelectorAll("#frame .fx img")) {
    if (story && !img.closest(".fx").classList.contains("on")) continue; // the pinned day: only what the engine shows
    const r = img.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue; // another layout's variant, or out of view
    const pic = img.closest("picture"), source = pic && [...pic.querySelectorAll("source")].find((s) => matches(s.getAttribute("media")));
    const k = keyOf.get(source ? source.getAttribute("srcset") : img.getAttribute("src"));
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/* one file of images.js, loaded and decoded off the page; settles either way (a failed file must not hold the switch) */
function load(src) {
  const img = new Image();
  img.src = src;
  if (typeof img.decode === "function") return img.decode().catch(() => {});
  return new Promise((done) => { img.onload = done; img.onerror = done; });
}

/** Start loading the twins in language `to` of the pictures on screen. A promise that settles when every one has decoded or
 *  failed, or null when no picture is on screen (switch at once). */
export function preloadOnScreen(root, from, to) {
  const keys = onScreen(root, from);
  if (!keys.length) return null;
  const set = imagesFor(to);
  return Promise.all(keys.map((k) => load(set[k].src)));
}
