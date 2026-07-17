/**
 * Sheet — THE modal container primitive. One per app; never build a parallel.
 *
 * Phone (< sm): a bottom sheet — rises from the bottom edge, rounded top, grab
 * bar, max 92dvh so the backdrop stays visible above it (tap-out always works
 * one-handed; no more hunting a 36px X in the top corner).
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
 *   • role="dialog" + aria-modal.
 * Visual identity (bg, borders, highlight rings) rides on panelClassName so
 * adopters keep their exact look — this primitive is structure, not skin.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";

export default function Sheet({
  onClose,
  desktop = "center", // "center" | "right"
  panelClassName = "",
  ariaLabel,
  zClassName = "z-[60]",
  children,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

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
      ? "relative w-full max-h-[92dvh] rounded-t-2xl flex flex-col overflow-hidden overscroll-contain sheet-enter-right " +
        "sm:max-w-md sm:h-full sm:max-h-full sm:rounded-none"
      : "relative w-full max-h-[92dvh] rounded-t-2xl flex flex-col overflow-hidden overscroll-contain sheet-enter-center " +
        "sm:max-w-md sm:h-auto sm:max-h-[92vh] sm:rounded-2xl";

  return createPortal(
    <div
      className={`fixed inset-0 ${zClassName} ${container}`}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="absolute inset-0 bg-black/40 animate-backdropFade" onClick={onClose} />
      <div
        className={`${structure} ${panelClassName}`}
        style={{ paddingLeft: "env(safe-area-inset-left, 0px)", paddingRight: "env(safe-area-inset-right, 0px)" }}
      >
        {/* Grab bar — phone-only affordance that this is a sheet (dismiss via
            tap-out / the close button / Esc; no gesture engine by doctrine). */}
        <div className="sm:hidden pt-2.5 pb-1 flex justify-center shrink-0" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-gray-300 dark:bg-gray-600" />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
