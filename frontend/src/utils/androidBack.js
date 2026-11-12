/**
 * Android BACK (the key, the edge-swipe gesture and the 3-button bar's
 * triangle) for the staff app.
 *
 * Why the app has to answer it itself: @capacitor/app swallows BACK when no
 * `backButton` listener exists and the WebView has no history — and the
 * portal has none to speak of: tabs, sheets, inline forms and the chat thread
 * are React state, and every route change uses `replace`. So BACK did nothing
 * at all, anywhere (Android walk, 11 Nov 2026). iOS has no BACK; nothing here
 * runs there.
 *
 * One BACK = one step out, the order Android users expect:
 *   1. the top-most open layer closes — a confirm, then a sheet, then an
 *      inline form or the chat thread — exactly as if the staffer had tapped
 *      outside it / its close button (the same click, the same handler);
 *   2. on another tab: back to the home tab (Vagtplan);
 *   3. on the home tab: the app goes to the background (Android's rule for
 *      BACK at the root).
 *
 * What counts as a layer's way out, without wiring every sheet by hand:
 *   • `.vp-scrim` — every portal sheet's tap-outside scrim;
 *   • the shared confirm's scrim (useConfirm: tapping it = Cancel);
 *   • `[data-back-close]` — marked on the close control of the layers that
 *     have no scrim (inline forms, the chat thread, the photo viewer).
 * The top-most one wins: the highest z-index of its fixed overlay (an inline
 * control, outside any fixed overlay, ranks below every overlay); a tie goes
 * to the one later in the document (opened later). Anything closing, inert,
 * hidden or disabled is skipped.
 */
export const BACK_TARGETS = ".vp-scrim, [data-back-close], [data-bb-confirm] > [data-bb-confirm-scrim]";

/** z-index of the fixed overlay `el` sits in; -1 when it is in the page flow.
    The portal's shell is itself position: fixed (the page's one scroller,
    Release A device pass) but it IS the page: reaching it first means the
    control is inline ([data-page-shell], StaffPortalPage.jsx). */
function layerOf(el, win) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hasAttribute("data-page-shell")) return -1;
    const cs = win.getComputedStyle(n);
    if (cs.position === "fixed") {
      const z = parseInt(cs.zIndex, 10);
      return Number.isFinite(z) ? z : 0;
    }
  }
  return -1;
}

const onScreen = (el) => el.getClientRects().length > 0;

/** The control BACK should click, or null when no layer is open. */
export function findBackTarget(doc = document, isVisible = onScreen) {
  const win = doc.defaultView || window;
  let best = null;
  let bestZ = -Infinity;
  doc.querySelectorAll(BACK_TARGETS).forEach((el) => {
    if (el.closest("[data-closing],[inert],[hidden]")) return;
    if (el.disabled) return;
    if (!isVisible(el)) return;
    const z = layerOf(el, win);
    if (z >= bestZ) {
      best = el;
      bestZ = z;
    }
  });
  return best;
}

/**
 * One BACK press. Returns what it did ("closed" | "home" | "background") so
 * the tests can pin the order.
 */
export function runAndroidBack({ doc = document, tab, homeTab, setTab, minimize, isVisible } = {}) {
  const target = findBackTarget(doc, isVisible);
  if (target) {
    target.click();
    return "closed";
  }
  if (homeTab && tab && tab !== homeTab && typeof setTab === "function") {
    setTab(homeTab);
    return "home";
  }
  try {
    Promise.resolve(minimize?.()).catch(() => {});
  } catch {
    /* plugin missing — nothing else to do */
  }
  return "background";
}
