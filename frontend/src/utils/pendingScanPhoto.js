/**
 * The photo Smart skan just read, handed to the page it routes to.
 *
 * Smart skan (the + button's top tile, "Tag ét billede — vi finder ud af
 * resten") classified the receipt and navigated to /expenses with the READ
 * fields only. The photo itself was dropped, so the expense was saved without
 * its bilag and the page then asked the owner to snap the very receipt they
 * had just photographed (and the fradrag needs the bilag).
 *
 * A module-level hand-off, not router state: a File in history state is
 * serialised into the session history on some browsers, and it must never
 * outlive the one page that consumes it. take() empties the slot, so a photo
 * is attached at most once, only by the route it was held for, and only for
 * a few minutes.
 */
const MAX_AGE_MS = 10 * 60 * 1000;
let slot = null;

export function holdScanPhoto(file, route) {
  slot = file && route ? { file, route, at: Date.now() } : null;
}

export function takeScanPhoto(route) {
  const s = slot;
  slot = null;
  if (!s || s.route !== route || Date.now() - s.at > MAX_AGE_MS) return null;
  return s.file;
}
