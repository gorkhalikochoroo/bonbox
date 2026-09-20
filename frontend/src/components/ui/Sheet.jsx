/**
 * Sheet — THE modal container primitive. One per app; never build a parallel.
 *
 * Phone (< sm): a bottom sheet — rises from the bottom edge, rounded top,
 * max 92% of the VISIBLE height so the backdrop stays visible above it
 * (tap-out always works one-handed; no more hunting a 36px X in the corner).
 * Desktop (≥ sm): `desktop="center"` (default) — a centered card, or
 * `desktop="right"` — a full-height right panel (the drawer pattern),
 * pixel-matching the classic ml-auto slide-in.
 *
 * The Sheet OWNS the behaviors call sites kept hand-rolling with drift:
 *   • createPortal to <body> — escapes transformed/sticky ancestors (the iOS
 *     sticky-wobble doctrine: transforms + sticky don't mix).
 *   • Backdrop + tap-out, Escape-to-close.
 *   • Body scroll lock while open (save/restore overflow — the proven
 *     useConfirm approach; no position:fixed, so the page never scroll-jumps).
 *   • role="dialog" + aria-modal, and the focus trap that aria-modal PROMISES:
 *     without it "the rest of the page is inert" is a claim the DOM doesn't
 *     keep, and a keyboard owner tabs straight out of the dialog into the page
 *     behind it.
 *   • The software-keyboard inset (see VISIBLE HEIGHT below) — the difference
 *     between "the primary action is pinned to the bottom" and "the primary
 *     action is pinned underneath the keyboard".
 *
 * Radius is the doctrine's SURFACE tier (12px), not a private 16px: a sheet is
 * a surface, and a primitive's private radius becomes a tier on every screen
 * that composes it. The two tiers are 12px surfaces / 8px controls, full stop.
 *
 * Visual identity (bg, borders, highlight rings) rides on panelClassName so
 * adopters keep their exact look — this primitive is structure, not skin.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Is this element actually reachable by Tab?
 *
 * The selector above is a NAME test, not a reachability test, and the gap is
 * not theoretical: Snap-a-receipt ships `<input type="file" className="hidden">`
 * as the last match inside its panel, so an unfiltered list made an undrawable
 * element the LAST tab stop — the forward wrap never fired and Tab walked
 * straight out of the dialog, which is the leak the trap exists to close.
 *
 * getComputedStyle, not offsetParent / getClientRects: jsdom has no layout
 * engine, so both of those report "invisible" for every element and would make
 * this untestable. display:none does NOT inherit, so the ancestors have to be
 * walked; visibility does, but walking is cheap enough at Tab frequency.
 */
function isReachable(el) {
  if (el.tabIndex === -1) return false;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
  }
  return true;
}

export default function Sheet({
  onClose,
  desktop = "center", // "center" | "right"
  panelClassName = "",
  ariaLabel,
  zClassName = "z-[60]",
  children,
}) {
  const panelRef = useRef(null);

  /* VISIBLE HEIGHT — why this is not just `max-h-[92dvh]`.
     dvh tracks the LAYOUT viewport. On iOS the software keyboard does not
     resize it: index.html's viewport meta is plain `width=device-width,
     viewport-fit=cover`, and Safari has no interactive-widget hint to give it
     anyway. So a bottom-anchored sheet capped at 92dvh keeps its full height
     and parks the pinned footer — the Gem/Tilføj button — underneath the
     keyboard the owner just opened by tapping a field. visualViewport is the
     only API that reports the real visible box; the inset it yields both caps
     the panel and lifts it clear. Capacitor's native resize already shrinks
     the webview, which shows up here as an inset of 0 — no double count. */
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const sync = () => {
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      // Under ~80px this is collapsing URL-bar chrome or sub-pixel rounding,
      // not a keyboard. Ignoring it stops the sheet twitching on every scroll.
      setKbInset(hidden > 80 ? Math.round(hidden) : 0);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  // Escape gets its own effect because onClose is almost always an inline
  // arrow: this subscription is re-made every render, which costs nothing for
  // a listener but must NOT drag the focus work below along with it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Mount-only: scroll lock, focus capture/restore, Tab containment. Deps are
  // deliberately empty — re-running this on a parent re-render would yank
  // focus back to the panel mid-typing and re-capture the return target.
  useEffect(() => {
    const panel = panelRef.current;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const returnTo = document.activeElement;
    // Focus the PANEL, never the first field. On a phone, focusing a select or
    // an input on open throws the keyboard (or a picker wheel) over a sheet
    // the owner has not read yet.
    panel?.focus();

    const onTab = (e) => {
      if (e.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(isReachable);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      // The panel itself does not count as "inside": it is the mount-time
      // focus target, and Shift+Tab from it walks BACKWARDS out of the dialog
      // under native tab order — the leak the trap exists to close.
      const inside = document.activeElement !== panel && panel.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Bound to the PANEL, not to document. A document listener fires wherever
    // focus is, including inside a LATER overlay stacked on top of a Sheet
    // that is still mounted — ReservationsPage keeps its drawer open behind
    // the edit-booking form — and there it threw focus back into the sheet
    // behind on every Tab, making the form untraversable by keyboard. Scoping
    // the listener to the panel makes the trap topmost-only by construction:
    // focus that genuinely lives elsewhere never reaches this handler.
    panel?.addEventListener("keydown", onTab);
    return () => {
      panel?.removeEventListener("keydown", onTab);
      document.body.style.overflow = prevOverflow;
      // Put the caret back where the owner left it — the cell or the "+" they
      // tapped — so closing a sheet doesn't dump focus at the top of the page.
      returnTo?.focus?.();
    };
  }, []);

  const container =
    desktop === "right"
      ? "flex items-end sm:items-stretch sm:justify-end"
      : "flex items-end sm:items-center sm:justify-center";

  // Phone: bottom sheet (rounded top, capped height, slide-up). Desktop:
  // either the full-height right panel with the classic slideIn, or a
  // centered card with scaleIn. overscroll-contain stops the iOS rubber-band
  // from scrolling the page behind the sheet.
  // Entrance animation via the dedicated .sheet-enter-* classes (index.css):
  // they carry their own min-width media query because these keyframes are
  // plain CSS, not Tailwind utilities — a sm:animate-… variant would silently
  // generate nothing. The global prefers-reduced-motion rule collapses both.
  const structure =
    desktop === "right"
      ? "relative w-full max-h-[92dvh] rounded-t-xl flex flex-col overflow-hidden overscroll-contain sheet-enter-right " +
        "sm:max-w-md sm:h-full sm:max-h-full sm:rounded-none"
      : "relative w-full max-h-[92dvh] rounded-t-xl flex flex-col overflow-hidden overscroll-contain sheet-enter-center " +
        "sm:max-w-md sm:h-auto sm:max-h-[92vh] sm:rounded-xl";

  return createPortal(
    <div
      className={`fixed inset-0 ${zClassName} ${container}`}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      // Shrink the overlay box to the visible area so `items-end` lands the
      // sheet on top of the keyboard rather than behind it.
      style={kbInset ? { bottom: `${kbInset}px` } : undefined}
    >
      <div className="absolute inset-0 bg-black/40 animate-backdropFade" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        data-sheet-panel=""
        className={`${structure} ${panelClassName} outline-none`}
        style={{
          paddingLeft: "env(safe-area-inset-left, 0px)",
          paddingRight: "env(safe-area-inset-right, 0px)",
          // 92% of the SHRUNKEN overlay, which is the visible height. Only set
          // while a keyboard is actually up, so the dvh cap above still owns
          // every ordinary render (and the desktop drawer's sm:max-h-full).
          ...(kbInset ? { maxHeight: "92%" } : null),
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
